import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDetrOutput, COCO_ANIMAL_CLASSES, letterboxMapper, iouXYWH} from '../studio/vision.mjs';

const mapper = letterboxMapper(640, 640, 640);
const ANIMAL_IDS = new Set(COCO_ANIMAL_CLASSES.map(entry => entry.id));

// 构造 logits [1, queries, classes] 与 boxes [1, queries, 4]。
function makeTensors(entries, queryCount = 100, classCount = 92) {
  const logits = new Float32Array(queryCount * classCount).fill(-10);
  const boxes = new Float32Array(queryCount * 4);
  entries.forEach((entry, index) => {
    for (let classIndex = 0; classIndex < classCount; classIndex++) logits[index * classCount + classIndex] = -10;
    logits[index * classCount + entry.classId] = entry.logit ?? 10;
    if (entry.noObjectLogit !== undefined) logits[index * classCount + classCount - 1] = entry.noObjectLogit;
    boxes[index * 4] = entry.cx;
    boxes[index * 4 + 1] = entry.cy;
    boxes[index * 4 + 2] = entry.w;
    boxes[index * 4 + 3] = entry.h;
  });
  return {
    logits: {data: logits, dims: [1, queryCount, classCount]},
    boxes: {data: boxes, dims: [1, queryCount, 4]},
  };
}

test('DETR decode keeps animal classes and drops person/no-object rows', () => {
  // 狗（18）高置信 + 人（1）高分 + no-object 主导行
  const {logits, boxes} = makeTensors([
    {classId: 18, cx: 0.5, cy: 0.5, w: 0.4, h: 0.4, logit: 12, noObjectLogit: -2},
    {classId: 1, cx: 0.2, cy: 0.5, w: 0.3, h: 0.6, logit: 12, noObjectLogit: -2},
    {classId: 20, cx: 0.8, cy: 0.5, w: 0.2, h: 0.2, logit: -5, noObjectLogit: 12},
  ]);
  const detections = decodeDetrOutput(logits, boxes, {mapper, modelSize: 640, sourceWidth: 640, sourceHeight: 640, classFilter: ANIMAL_IDS, scoreThreshold: 0.5});
  assert.equal(detections.length, 1, `应只保留狗：${JSON.stringify(detections)}`);
  assert.equal(detections[0].className, '狗');
  assert.equal(detections[0].keypoints, null, '动物没有关键点');
  assert.ok(detections[0].score > 0.99, 'logit 差距大时应接近 1');
  // 框：中心 (0.5,0.5)、尺寸 0.4 → 归一化 x≈0.3..0.7
  assert.ok(Math.abs(detections[0].box.x - 0.3) < 0.01 && Math.abs(detections[0].box.w - 0.4) < 0.01, `框应换算正确：${JSON.stringify(detections[0].box)}`);
});

test('DETR decode filters degenerate boxes and limits duplicates via NMS', () => {
  const entries = [];
  for (let index = 0; index < 6; index++) entries.push({classId: 21, cx: 0.5, cy: 0.5, w: 0.5, h: 0.5, logit: 10}); // 同一动物 6 个重叠框
  entries.push({classId: 19, cx: 0.5, cy: 0.5, w: 0.01, h: 0.005, logit: 10}); // 贴边退化
  const {logits, boxes} = makeTensors(entries);
  const detections = decodeDetrOutput(logits, boxes, {mapper, modelSize: 640, sourceWidth: 640, sourceHeight: 640, classFilter: ANIMAL_IDS, scoreThreshold: 0.5});
  assert.equal(detections.length, 1, `NMS 应合并重叠框并丢弃退化框：${JSON.stringify(detections)}`);
  assert.equal(detections[0].className, '牛');
});

test('score is the softmax probability against the no-object column', () => {
  // no-object logit 与目标类接近 → 概率应明显低于 1
  const {logits, boxes} = makeTensors([{classId: 16, cx: 0.5, cy: 0.5, w: 0.2, h: 0.2, logit: 6, noObjectLogit: 5.5}]);
  const detections = decodeDetrOutput(logits, boxes, {mapper, modelSize: 640, sourceWidth: 640, sourceHeight: 640, classFilter: ANIMAL_IDS, scoreThreshold: 0.2});
  assert.equal(detections.length, 1);
  assert.ok(detections[0].score > 0.3 && detections[0].score < 0.75, `分数应为软化的 softmax 概率：${detections[0].score}`);
  // 阈值以下被丢弃
  assert.equal(decodeDetrOutput(logits, boxes, {mapper, modelSize: 640, sourceWidth: 640, sourceHeight: 640, classFilter: ANIMAL_IDS, scoreThreshold: 0.9}).length, 0);
});

test('iouXYWH stays consistent with the tracker definition', () => {
  assert.ok(Math.abs(iouXYWH([0.5, 0.5, 0.4, 0.4], [0.5, 0.5, 0.4, 0.4]) - 1) < 1e-9);
});
