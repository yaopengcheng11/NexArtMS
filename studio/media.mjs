import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fail, newId, nowIso} from './db.mjs';

// 计划 §1 输入范围：MP4/MOV、H.264/H.265、≤2 分钟、≤1080p；超界给明确原因与预处理选项。
export const DEFAULT_LIMITS = {
  maxUploadBytes: Number(process.env.STUDIO_MAX_UPLOAD_MB || 2048) * 1024 * 1024,
  maxDurationS: Number(process.env.STUDIO_MAX_DURATION_S || 120),
  maxWidthPx: Number(process.env.STUDIO_MAX_WIDTH_PX || 1920),
  maxHeightPx: Number(process.env.STUDIO_MAX_HEIGHT_PX || 1080),
  allowedContainers: ['mp4', 'mov', 'mp4,mov', 'mov,mp4', 'ismv'],
  allowedCodecs: ['h264', 'hevc'],
};

const ffmpegBin = () => process.env.FFMPEG || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE || 'ffprobe';

export function hasFfmpeg() {
  return new Promise(resolve => {
    const child = spawn(ffprobeBin(), ['-version'], {stdio: 'ignore'});
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
  });
}

function run(bin, args, {timeoutMs = 10 * 60 * 1000, onStderr, onStdout} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {windowsHide: true});
    let stdout = [], stderr = [];
    const timer = setTimeout(() => {child.kill('SIGKILL');reject(fail(`${bin} 执行超时`, 500));}, timeoutMs);
    child.stdout.on('data', chunk => {stdout.push(chunk);onStdout?.(chunk);});
    child.stderr.on('data', chunk => {stderr.push(chunk);onStderr?.(chunk);});
    child.on('error', cause => {clearTimeout(timer);reject(fail(`无法启动 ${bin}：${cause.message}。请确认 FFmpeg 已安装并在 PATH 中，或设置 FFMPEG/FFPROBE 环境变量。`, 500));});
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout);
      if (code === 0) resolve(output);
      else reject(fail(`${bin} 退出码 ${code}${signal ? `（${signal}）` : ''}：${Buffer.concat(stderr).toString('utf8').slice(-600).trim() || '无错误输出'}`, 500));
    });
  });
}

// ---- 上传：流式写入 + 大小上限 + ISO BMFF 容器魔数校验 + SHA-256 ----
export function receiveUpload(req, directory, limits) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(directory, {recursive: true});
    const temporary = path.join(directory, `upload-${crypto.randomUUID()}.tmp`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    const stream = fs.createWriteStream(temporary);
    // done() 首次调用生效；此后的流错误（如清理后的延迟 open 失败）就地吞掉。
    stream.on('error', cause => done(fail(`上传写入失败：${cause.message}`, 500)));
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) {stream.destroy();fs.rm(temporary, {force: true}, () => {});reject(error);} else resolve(value);
    };
    stream.on('drain', () => req.resume());
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limits.maxUploadBytes) {req.destroy();done(fail(`文件超过大小上限 ${(limits.maxUploadBytes / 1024 / 1024).toFixed(0)} MB`, 413));return;}
      hash.update(chunk);
      if (!stream.write(chunk)) req.pause();
    });
    req.on('error', cause => done(fail(`上传读取失败：${cause.message}`, 400)));
    req.on('end', () => stream.end(() => {
      const fd = fs.openSync(temporary, 'r');
      try {
        const header = Buffer.alloc(12);
        fs.readSync(fd, header, 0, 12, 0);
        if (header.readUInt32BE(4) !== 0x66747970 || !header.subarray(8).toString('latin1').match(/^(qt|mp4|isom|iso2|m4v|MSNV|avc1|dash|heic)/)) {
          done(fail('不是 MP4/MOV 容器：文件头缺少 ftyp 框。请上传 MP4 或 MOV 文件。', 422));
          return;
        }
      } finally {fs.closeSync(fd);}
      done(null, {temporary, sha256: hash.digest('hex'), sizeBytes: size});
    }));
  });
}

// ---- ffprobe 探测 ----
export async function probeMedia(file, limits) {
  const output = await run(ffprobeBin(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(output.toString('utf8'));
  const video = (info.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (info.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video) throw fail('容器中没有视频流', 422);
  const codec = String(video.codec_name || '').toLowerCase();
  if (!limits.allowedCodecs.includes(codec)) throw fail(`视频编码 ${codec || '未知'} 不在支持范围（${limits.allowedCodecs.join('/')}）。请转码为 H.264 后重试。`, 422);
  const container = String(info.format?.format_name || '').toLowerCase();
  if (!limits.allowedContainers.some(name => container.includes(name))) throw fail(`容器格式 ${container || '未知'} 不在支持范围（MP4/MOV）`, 422);
  const durationUs = Math.round(Number(info.format?.duration || video.duration || 0) * 1e6);
  if (!(durationUs > 0)) throw fail('无法从容器读出有效时长', 422);
  if (durationUs > limits.maxDurationS * 1e6) throw fail(`视频时长 ${(durationUs / 1e6).toFixed(1)} 秒超出首版上限 ${limits.maxDurationS} 秒。请先剪辑或申请放宽限制（STUDIO_MAX_DURATION_S）。`, 422);
  const width = video.width, height = video.height;
  if (!width || !height) throw fail('无法读出画面尺寸', 422);
  if (Math.max(width, height) > limits.maxWidthPx || Math.min(width, height) > limits.maxHeightPx) throw fail(`画面 ${width}×${height} 超出首版上限（最长边 ${limits.maxWidthPx}px、最短边 ${limits.maxHeightPx}px）。请缩小分辨率后重试。`, 422);
  const rotation = parseRotation(video);
  const [fpsNum, fpsDen] = parseRate(video.r_frame_rate) || parseRate(video.avg_frame_rate) || [0, 1];
  const [avgNum, avgDen] = parseRate(video.avg_frame_rate) || [fpsNum, fpsDen];
  if (!fpsNum || !fpsDen) throw fail('无法读出帧率', 422);
  const vfr = Math.abs(fpsNum / fpsDen - avgNum / avgDen) > 0.01;
  return {
    durationUs, width, height, rotation,
    timebase: String(video.time_base || '1/90000'),
    fpsNum, fpsDen, vfr,
    videoCodec: codec,
    audioCodec: audio ? String(audio.codec_name) : null,
    formatName: container,
  };
}

const parseRate = value => {
  if (typeof value !== 'string') return null;
  const [num, den] = value.split('/').map(Number);
  return Number.isFinite(num) && Number.isFinite(den) && den > 0 ? [num, den] : null;
};
const parseRotation = stream => {
  const sideData = (stream.side_data_list || []).find(entry => entry.rotation !== undefined);
  if (sideData) return ((Number(sideData.rotation) % 360) + 360) % 360;
  if (stream.tags?.rotate) return ((Number(stream.tags.rotate) % 360) + 360) % 360;
  return 0;
};

// ---- 代理（可播放预览，仅代理不覆盖原片）----
export async function buildProxy(originalPath, proxyPath, onProgress, totalDurationUs = 0) {
  fs.mkdirSync(path.dirname(proxyPath), {recursive: true});
  const output = await run(ffmpegBin(), ['-y', '-i', originalPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats', proxyPath], {
    onStdout: chunk => {
      const match = chunk.toString('utf8').match(/out_time_us=(\d+)/);
      if (match && onProgress && totalDurationUs > 0) onProgress(Math.min(0.99, Number(match[1]) / totalDurationUs));
    },
  });
  void output;
  if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size === 0) throw fail('代理生成失败：输出文件为空', 500);
  return proxyPath;
}

// ---- PTS 映射：逐呈现帧记录源时间戳（VFR 以实际时间戳为准，不按固定 fps 推算）----
export async function extractPtsMap(originalPath, outputDir, mediaId) {
  fs.mkdirSync(outputDir, {recursive: true});
  const output = await run(ffprobeBin(), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'json', originalPath], {timeoutMs: 20 * 60 * 1000});
  const frames = JSON.parse(output.toString('utf8')).frames || [];
  const pts = frames.map(frame => Number(frame.pts_time)).filter(value => Number.isFinite(value));
  if (pts.length === 0) throw fail('未能从视频读取任何帧时间戳', 500);
  const payload = {mediaId, generatedAt: nowIso(), count: pts.length, pts};
  const file = path.join(outputDir, `${mediaId}-pts-map.json`);
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(payload));
  fs.renameSync(temporary, file);
  return {file, pts};
}

// ---- 帧签名：灰度直方图序列，供切镜检测（测试可用合成签名，无需 FFmpeg）----
export async function extractSignatures(proxyPath, {scaleWidth = 48, scaleHeight = 27} = {}) {
  const output = await run(ffmpegBin(), ['-i', proxyPath, '-vf', `scale=${scaleWidth}:${scaleHeight}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {timeoutMs: 20 * 60 * 1000});
  const frameSize = scaleWidth * scaleHeight;
  const count = Math.floor(output.length / frameSize);
  const signatures = [];
  for (let index = 0; index < count; index++) {
    const frame = output.subarray(index * frameSize, (index + 1) * frameSize);
    const histogram = new Array(16).fill(0);
    let sum = 0;
    for (let pixel = 0; pixel < frameSize; pixel++) {const value = frame[pixel];histogram[value >> 4]++;sum += value;}
    signatures.push({mean: sum / frameSize, histogram});
  }
  return signatures;
}

// ---- 缩略图与轨迹裁剪 ----
export async function extractStill(originalPath, outputPath, {timeS, cropBox, width = 320} = {}) {
  fs.mkdirSync(path.dirname(outputPath), {recursive: true});
  const filters = [`scale=${width}:-2`];
  if (cropBox) filters.push(`crop=iw*${cropBox.w.toFixed(4)}:ih*${cropBox.h.toFixed(4)}:iw*${cropBox.x.toFixed(4)}:ih*${cropBox.y.toFixed(4)}`);
  // 唯一临时名：并发生成同一目标时不互相踩踏
  const temporary = `${outputPath}.${crypto.randomUUID()}.tmp.jpg`;
  try {
    await run(ffmpegBin(), ['-y', '-ss', timeS.toFixed(3), '-i', originalPath, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '3', temporary], {timeoutMs: 120000});
    fs.renameSync(temporary, outputPath);
  } finally {if (fs.existsSync(temporary)) fs.unlinkSync(temporary);}
  return outputPath;
}
