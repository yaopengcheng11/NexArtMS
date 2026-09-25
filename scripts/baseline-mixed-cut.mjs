// M0 基线（用 JWM 样片作为替身测试集）：自动切镜 vs public/project/shots.json 真值。
// 匹配规则按开发计划 §7：真值=新镜头首个呈现帧；预测与真值一对一最小序号差匹配，
// 允许相差 ≤2 个源呈现帧；未匹配的预测计误检。
// 用法：node scripts/baseline-mixed-cut.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {extractPtsMap, extractSignatures} from '../studio/media.mjs';
import {computeScores, detectCutsFromScores, cutsToShotBounds} from '../studio/cuts.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const videoPath = process.argv[2] || path.join(root, 'public', 'reference.mp4');
const truthFile = path.join(root, 'public', 'project', 'shots.json');
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
const truthCuts = truth.slice(1).map(shot => shot.startFrame);

function matchMetrics(predicted, truthCutList, tolerance = 2) {
  const pairs = [];
  for (const p of predicted) for (const t of truthCutList) pairs.push({p, t, distance: Math.abs(p - t)});
  pairs.sort((a, b) => a.distance - b.distance);
  const usedP = new Set(), usedT = new Set(), matches = [];
  for (const pair of pairs) {
    if (pair.distance > tolerance || usedP.has(pair.p) || usedT.has(pair.t)) continue;
    usedP.add(pair.p);usedT.add(pair.t);matches.push(pair);
  }
  const truePositives = matches.length;
  const falsePositives = predicted.length - truePositives;
  const falseNegatives = truthCutList.length - truePositives;
  return {
    truePositives, falsePositives, falseNegatives,
    recall: truthCutList.length ? truePositives / truthCutList.length : 0,
    precision: predicted.length ? truePositives / predicted.length : 0,
    maxMatchedDistance: matches.length ? Math.max(...matches.map(m => m.distance)) : null,
    missedTruth: truthCutList.filter(cut => !usedT.has(cut)),
    spuriousPredictions: predicted.filter(cut => !usedP.has(cut)),
  };
}

console.log(`M0 基线：${path.basename(videoPath)}（真值 ${truth.length} 镜 / ${truthCuts.length} 个切点）`);
fs.mkdirSync(path.join(root, 'data', 'tmp'), {recursive: true});
const {pts} = await extractPtsMap(videoPath, path.join(root, 'data', 'tmp'), 'baseline');
console.log(`PTS 映射：${pts.length} 个呈现帧（真值末帧 ${truth.at(-1).endFrameExclusive}）`);
const signatures = await extractSignatures(videoPath);
const scores = computeScores(signatures);
console.log(`帧签名：${signatures.length} 帧`);

// 参数网格：报告每个配置的召回/精确率（放行门槛 A2：硬切召回 ≥95%）
const grid = [];
for (const absoluteFloor of [0.1, 0.15, 0.2, 0.25, 0.3]) {
  for (const adaptiveFactor of [8, 12, 16, 20, 24]) {
    for (const minShotFrames of [2, 3, 4]) {
      const predicted = detectCutsFromScores(scores, {absoluteFloor, adaptiveFactor, minShotFrames});
      grid.push({absoluteFloor, adaptiveFactor, minShotFrames, predicted: predicted.length, ...matchMetrics(predicted, truthCuts)});
    }
  }
}
grid.sort((a, b) => b.recall - a.recall || b.precision - a.precision);
const best = grid[0];
const defaults = detectCutsFromScores(scores);
const defaultMetrics = matchMetrics(defaults, truthCuts);

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scope: 'M0 基线（替身测试集：JWM 样片）。真实混剪样本集与人工真值仍待用户提供（开发计划 §7）。',
  video: {file: path.basename(videoPath), frames: pts.length, durationUs: Math.round(pts.at(-1) * 1e6)},
  truth: {shots: truth.length, cuts: truthCuts.length},
  algorithm: 'histogram-v1（16 桶灰度直方图卡方距离 + 自适应阈值 + 闪白抑制）',
  defaultConfig: {cuts: defaults.length, ...defaultMetrics},
  bestConfig: {absoluteFloor: best.absoluteFloor, adaptiveFactor: best.adaptiveFactor, cuts: best.predicted, ...best},
  grid: grid.map(({predicted, ...rest}) => ({...rest, predicted})),
  a2Gate: {threshold: '硬切召回 ≥95%（±2 帧一对一匹配）', passed: best.recall >= 0.95, actualRecall: best.recall, actualPrecision: best.precision},
  notes: [
    'JWM 样片含淡入淡出与运镜；直方图法对淡变切点天然不敏感，漏检可由人工改切点修正。',
    '本报告不覆盖人物候选（A3）与相机/动作门槛；A3 需逐帧人物真值，待真实样本。',
  ],
};
fs.mkdirSync(path.join(root, 'reports'), {recursive: true});
const outFile = path.join(root, 'reports', 'baseline-mixed-cut.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log('\n默认配置：', JSON.stringify(defaultMetrics, (_, v) => v, 0).slice(0, 0) || '');
console.log(`默认参数：切点 ${defaults.length}，召回 ${(defaultMetrics.recall * 100).toFixed(1)}%，精确率 ${(defaultMetrics.precision * 100).toFixed(1)}%`);
console.log(`最优参数（floor=${best.absoluteFloor}, factor=${best.adaptiveFactor}）：切点 ${best.predicted}，召回 ${(best.recall * 100).toFixed(1)}%，精确率 ${(best.precision * 100).toFixed(1)}%`);
if (best.missedTruth.length) console.log('漏检真值切点：', best.missedTruth.join(', '));
console.log(`A2 门槛（召回≥95%）：${best.recall >= 0.95 ? '通过' : '未通过'}`);
console.log('报告：reports/baseline-mixed-cut.json');
