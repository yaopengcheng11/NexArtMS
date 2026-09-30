// 下载人物检测/姿态模型（YOLOv8n-pose ONNX, int8 量化）到 data/models/，
// 并记录来源、版本、许可证与 SHA-256（计划 §3：记录权重哈希、版本、许可）。
// 用法：node scripts/fetch-detector-model.mjs
// 许可提示：Ultralytics 权重遵循 AGPL-3.0 / Enterprise 双路径（见 docs/model-decisions.md）。
// 本仓库当前定位为本机原型，公开部署前必须复核许可证路径。
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {fetchModel, recordLocalModel, modelDir, DET_RECORD_FILE} from '../studio/vision.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(root); // 仓库根：报告写 docs/reports/，模型权重与临时检查在仓库根
const SPEC = {
  sourceUrl: 'https://huggingface.co/Xenova/yolov8n-pose/resolve/main/onnx/model_quantized.onnx',
  file: 'yolov8n-pose-int8.onnx',
  detectorName: 'yolov8n-pose',
  version: 'yolov8n-pose-int8 (Xenova ONNX conversion, 2024-04)',
  license: 'AGPL-3.0（Ultralytics 权重；企业闭源部署需 Ultralytics Enterprise 许可）',
  providers: ['cpu'],
};
// 动物检测：YOLOS-tiny（DETR 家族，COCO-91 类含 10 种动物）。YOLOv8 检测权重在 HF 上不可得，
// YOLOS 输出 logits[1,100,92]+pred_boxes，由 vision.mjs 的 decodeDetrOutput 解码。
const DET_SPEC = {
  sourceUrl: 'https://hf-mirror.com/Xenova/yolos-tiny/resolve/main/onnx/model_quantized.onnx',
  file: 'yolos-tiny-det-int8.onnx',
  detectorName: 'yolos-tiny-det',
  version: 'yolos-tiny-int8 (Xenova ONNX conversion, COCO-91, DETR head)',
  license: 'Apache-2.0（YOLOS/DETR 权重，Hugging Face Xenova 转换）',
  providers: ['cpu'],
  recordFile: DET_RECORD_FILE,
};
const DET_FILES = [ // 溯源与类别映射依据（运行时不加载）
  ['https://hf-mirror.com/Xenova/yolos-tiny/resolve/main/config.json', 'yolos-tiny-config.json'],
  ['https://hf-mirror.com/Xenova/yolos-tiny/resolve/main/preprocessor_config.json', 'yolos-tiny-preprocessor.json'],
];
async function ensure(spec) {
  if (!process.env.FORCE && fs.existsSync(path.join(modelDir(repoRoot), spec.file))) {
    const record = recordLocalModel(repoRoot, spec);
    if (record) {console.log(`本地已有权重 ${spec.file}，直接登记（FORCE=1 强制重新下载）。`);return record;}
  }
  return fetchModel(repoRoot, spec);
}
const poseRecord = await ensure(SPEC).catch(cause => {console.error('姿态模型获取失败：', cause.message);return null;});
const detRecord = await ensure(DET_SPEC).catch(cause => {console.error('动物检测模型获取失败（动物检测将不可用，人物检测不受影响）：', cause.message);return null;});
if (poseRecord) console.log('姿态模型就绪：', JSON.stringify({file: poseRecord.file, sizeBytes: poseRecord.sizeBytes, sha256: poseRecord.sha256.slice(0, 16) + '…'}, null, 2));
if (detRecord) {
  for (const [url, file] of DET_FILES) {
    try {const response = await fetch(url);if (response.ok) fs.writeFileSync(path.join(modelDir(repoRoot), file), Buffer.from(await response.arrayBuffer()));} catch {}
  }
  console.log('动物检测模型就绪：', JSON.stringify({file: detRecord.file, sizeBytes: detRecord.sizeBytes, sha256: detRecord.sha256.slice(0, 16) + '…'}, null, 2));
}
if (!poseRecord) process.exitCode = 1;
