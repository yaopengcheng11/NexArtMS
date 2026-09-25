import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fail} from './db.mjs';
import {registerDetector} from './person.mjs';
import {appearanceDescriptor} from './people.mjs';

// 视觉模型接入：YOLOv8n-pose（ONNX）。一人一次推理同时给出人物框与 17 个 COCO 关键点，
// 供 M2 检测/跟踪与 M4 二维姿态观测使用。
// 模型权重不入库：scripts/fetch-detector-model.mjs 下载到 data/models/ 并记录来源/许可/哈希。
export const MODEL_RECORD_FILE = 'model-record.json';

const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';

export function modelDir(root) {return path.join(root, 'data', 'models');}

export function loadModelRecord(root) {
  try {return JSON.parse(fs.readFileSync(path.join(modelDir(root), MODEL_RECORD_FILE), 'utf8'));} catch {return null;}
}

export async function loadVisionSession(root) {
  const record = loadModelRecord(root);
  if (!record) return null;
  const file = path.join(modelDir(root), record.file);
  if (!fs.existsSync(file)) return null;
  let ort;
  try {ort = await import('onnxruntime-node');} catch {return null;}
  const session = await ort.InferenceSession.create(file, {executionProviders: record.providers || ['cpu']});
  return {ort, session, record};
}

// 下载模型：来源与许可写入 model-record.json（计划 §3：记录权重哈希、版本、许可）。
// 已有本地权重时直接登记（不重新下载），记录来源/许可/哈希。
export function recordLocalModel(root, {file, detectorName, license, version, providers}) {
  const target = path.join(modelDir(root), file);
  if (!fs.existsSync(target)) return null;
  const bytes = fs.readFileSync(target);
  const record = {sourceUrl: null, file, detectorName: detectorName || 'detector', license, version, providers: providers || ['cpu'], sha256: crypto.createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, fetchedAt: new Date().toISOString(), note: '本地已有权重，未重新下载（来源见 docs/model-decisions.md）'};
  fs.writeFileSync(path.join(modelDir(root), MODEL_RECORD_FILE), JSON.stringify(record, null, 2));
  return record;
}

export async function fetchModel(root, {sourceUrl, file, license, version, sha256, providers, detectorName} = {}) {
  const record = {sourceUrl, file, detectorName: detectorName || 'detector', license, version, sha256, providers: providers || ['cpu'], fetchedAt: new Date().toISOString()};
  const response = await fetch(sourceUrl);
  if (!response.ok) throw fail(`模型下载失败：HTTP ${response.status}（${sourceUrl}）`, 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (record.sha256 && hash !== record.sha256) throw fail(`模型哈希不匹配：期望 ${record.sha256}，实际 ${hash}`, 502);
  record.sha256 = hash;
  record.sizeBytes = bytes.length;
  fs.mkdirSync(modelDir(root), {recursive: true});
  const target = path.join(modelDir(root), file);
  fs.writeFileSync(target, bytes);
  fs.writeFileSync(path.join(modelDir(root), MODEL_RECORD_FILE), JSON.stringify(record, null, 2));
  return record;
}

// ---- 帧流：ffmpeg 解码 + 640 letterbox + rgb24，逐帧回调（含抽帧步长）----
export function frameStream(videoPath, {width = 640, height = 640, stride = 1, onFrame} = {}) {
  return new Promise((resolve, reject) => {
    const filter = `select='not(mod(n\\,${stride}))',scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`;
    const child = spawn(ffmpegBin(), ['-i', videoPath, '-vf', filter, '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {windowsHide: true});
    const frameBytes = width * height * 3;
    let buffer = Buffer.alloc(0);
    let frameIndex = 0;
    let failed = false;
    const timer = setTimeout(() => {child.kill('SIGKILL');reject(fail('帧流读取超时', 500));}, 60 * 60 * 1000);
    child.stderr.on('data', () => {});
    child.on('error', cause => {clearTimeout(timer);reject(fail(`无法启动 ffmpeg：${cause.message}`, 500));});
    const closed = new Promise(done => child.on('close', code => done(code)));
    // Await each inference before reusing its tensor; async 'data' listeners overlap.
    (async () => {
      try {
        for await (const chunk of child.stdout) {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= frameBytes) {
            const frame = buffer.subarray(0, frameBytes);
            buffer = buffer.subarray(frameBytes);
            await onFrame(frame, frameIndex++);
          }
        }
        const code = await closed;
        if (code !== 0 || buffer.length) throw fail(`ffmpeg 帧流不完整（退出码 ${code}）`, 500);
        resolve(frameIndex);
      } catch (cause) {failed = true;child.kill('SIGKILL');reject(cause);}
      finally {clearTimeout(timer);}
    })();
  });
}

// letterbox 映射：模型坐标（640 空间）→ 源画面归一化坐标。
export function letterboxMapper(sourceWidth, sourceHeight, modelSize = 640) {
  const scale = Math.min(modelSize / sourceWidth, modelSize / sourceHeight);
  const offsetX = (modelSize - sourceWidth * scale) / 2;
  const offsetY = (modelSize - sourceHeight * scale) / 2;
  return {toSourcePx: (x, y) => ({x: (x - offsetX) / scale, y: (y - offsetY) / scale})};
}

// 解码 ultralytics 姿态输出 [1, 56, 8400]：4 框 + 1 置信 + 17×3 关键点。
// 关键点坐标形式由 decodeKeypoints 决定：标准导出已在输入像素空间（0–640）。
export function decodePoseOutput(tensor, {scoreThreshold = 0.25, iouThreshold = 0.45, mapper, sourceWidth, sourceHeight, decodeKeypoints = 'pixel'} = {}) {
  const data = tensor.data;
  const anchors = tensor.dims[2];
  const candidates = [];
  for (let anchor = 0; anchor < anchors; anchor++) {
    // Standard exported YOLOv8 output already contains probabilities.
    const score = data[4 * anchors + anchor];
    if (score < scoreThreshold) continue;
    const cx = data[0 * anchors + anchor], cy = data[1 * anchors + anchor];
    const w = data[2 * anchors + anchor], h = data[3 * anchors + anchor];
    const keypoints = [];
    for (let joint = 0; joint < 17; joint++) {
      const rawX = data[(5 + joint * 3) * anchors + anchor];
      const rawY = data[(6 + joint * 3) * anchors + anchor];
      const rawV = data[(7 + joint * 3) * anchors + anchor];
      const kptX = decodeKeypoints === 'pixel' ? rawX : rawX * 2 + cx;
      const kptY = decodeKeypoints === 'pixel' ? rawY : rawY * 2 + cy;
      keypoints.push({kptX, kptY, kptV: rawV});
    }
    candidates.push({score, box: [cx, cy, w, h], keypoints});
  }
  candidates.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.every(other => iouXYWH(candidate.box, other.box) < iouThreshold)) kept.push(candidate);
    if (kept.length >= 8) break; // 首版最多 4 人同框，留余量
  }
  return kept.map(candidate => {
    const [cx, cy, w, h] = candidate.box;
    const x0 = mapper.toSourcePx(cx - w / 2, cy - h / 2);
    const x1 = mapper.toSourcePx(cx + w / 2, cy + h / 2);
    const box = normalizeBox({x: x0.x, y: x0.y, w: x1.x - x0.x, h: x1.y - x0.y}, sourceWidth, sourceHeight);
    if (box.w < 0.02 || box.h < 0.02) return null; // 贴边退化框（不是可信人物）
    const keypoints = candidate.keypoints.map(({kptX, kptY, kptV}) => {
      const source = mapper.toSourcePx(kptX, kptY);
      return {x: clamp01(source.x / sourceWidth), y: clamp01(source.y / sourceHeight), v: Number(kptV.toFixed(3))};
    });
    return {box, score: Number(candidate.score.toFixed(3)), keypoints};
  }).filter(Boolean);
}

const clamp01 = value => Math.max(0, Math.min(1, value));
const normalizeBox = (box, width, height) => {
  const x = clamp01(box.x / width), y = clamp01(box.y / height);
  // 模型框可能略微越界：收紧到画面内
  return {x, y, w: Math.max(0.001, Math.min(1 - x, box.w / width)), h: Math.max(0.001, Math.min(1 - y, box.h / height))};
};

export function iouXYWH(a, b) {
  const ax0 = a[0] - a[2] / 2, ay0 = a[1] - a[3] / 2, ax1 = a[0] + a[2] / 2, ay1 = a[1] + a[3] / 2;
  const bx0 = b[0] - b[2] / 2, by0 = b[1] - b[3] / 2, bx1 = b[0] + b[2] / 2, by1 = b[1] + b[3] / 2;
  const ix = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const iy = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

// 把模型注册进检测器表；未安装 onnxruntime 或权重缺失时保持未注册（任务如实失败）。
export async function registerVisionDetector(root, {modelSize = 640, scoreThreshold = 0.25, iouThreshold = 0.45} = {}) {
  const session = await loadVisionSession(root);
  if (!session) return null;
  const {ort, record} = session;
  const runner = {
    // detections: 按抽帧步长返回 [{frame, box, confidence, keypoints}]；frame 为源呈现帧序号。
    async detect({videoPath, sourceWidth, sourceHeight, frameCount, onProgress, isCancelled, stride}) {
      const mapper = letterboxMapper(sourceWidth, sourceHeight, modelSize);
      const inputTensor = new ort.Tensor('float32', new Float32Array(3 * modelSize * modelSize), [1, 3, modelSize, modelSize]);
      const detections = [];
      let total = Math.ceil((frameCount || 0) / stride);
      await frameStream(videoPath, {
        width: modelSize, height: modelSize, stride,
        onFrame: async (rgb, index) => {
          if (isCancelled?.()) throw fail('任务已被取消', 409);
          const frame = toPlanar(rgb, inputTensor.data, modelSize);
          const result = await session.session.run({images: inputTensor});
          const output = result[session.session.outputNames[0]];
          for (const detection of decodePoseOutput(output, {scoreThreshold, iouThreshold, mapper, sourceWidth, sourceHeight})) {
            const scale = Math.min(modelSize / sourceWidth, modelSize / sourceHeight);
            const pixelBox = {x: ((modelSize - sourceWidth * scale) / 2 + detection.box.x * sourceWidth * scale) / modelSize,
              y: ((modelSize - sourceHeight * scale) / 2 + detection.box.y * sourceHeight * scale) / modelSize,
              w: detection.box.w * sourceWidth * scale / modelSize, h: detection.box.h * sourceHeight * scale / modelSize};
            detections.push({frame: index * stride, box: detection.box, confidence: detection.score, keypoints: detection.keypoints,
              appearance: appearanceDescriptor(rgb, modelSize, modelSize, pixelBox)});
          }
          onProgress?.(total ? Math.min(0.99, (index + 1) / total) : undefined);
        },
      });
      return detections;
    },
  };
  registerDetector(record.detectorName || 'yolov8n-pose', spec => runner.detect({...spec, ...spec.options}), {version: `${record.version};decode-probabilities-v2`, licenseNote: record.license});
  return runner;
}

// rgb24 (HWC) → planar CHW float32，归一化 0–1。
export function toPlanar(rgb, out, size) {
  const plane = size * size;
  for (let pixel = 0; pixel < plane; pixel++) {
    out[pixel] = rgb[pixel * 3] / 255;
    out[plane + pixel] = rgb[pixel * 3 + 1] / 255;
    out[2 * plane + pixel] = rgb[pixel * 3 + 2] / 255;
  }
  return out;
}
