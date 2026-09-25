// 下载人物检测/姿态模型（YOLOv8n-pose ONNX, int8 量化）到 data/models/，
// 并记录来源、版本、许可证与 SHA-256（计划 §3：记录权重哈希、版本、许可）。
// 用法：node scripts/fetch-detector-model.mjs
// 许可提示：Ultralytics 权重遵循 AGPL-3.0 / Enterprise 双路径（见 docs/model-decisions.md）。
// 本仓库当前定位为本机原型，公开部署前必须复核许可证路径。
import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {fetchModel, recordLocalModel, modelDir} from '../studio/vision.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SPEC = {
  sourceUrl: 'https://huggingface.co/Xenova/yolov8n-pose/resolve/main/onnx/model_quantized.onnx',
  file: 'yolov8n-pose-int8.onnx',
  detectorName: 'yolov8n-pose',
  version: 'yolov8n-pose-int8 (Xenova ONNX conversion, 2024-04)',
  license: 'AGPL-3.0（Ultralytics 权重；企业闭源部署需 Ultralytics Enterprise 许可）',
  providers: ['cpu'],
};
let record;
if (!process.env.FORCE && fs.existsSync(path.join(modelDir(root), SPEC.file))) {
  record = recordLocalModel(root, SPEC);
  console.log('本地已有权重，直接登记（FORCE=1 强制重新下载）。');
}
if (!record) record = await fetchModel(root, SPEC);
console.log('模型已就绪：', JSON.stringify({file: record.file, sizeBytes: record.sizeBytes, sha256: record.sha256.slice(0, 16) + '…', license: record.license}, null, 2));
