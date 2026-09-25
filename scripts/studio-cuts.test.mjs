import test from 'node:test';
import assert from 'node:assert/strict';
import {signatureDistance, computeScores, detectCutsFromScores, cutsToShotBounds, cutsWithConfidence} from '../studio/cuts.mjs';

const makeSignature = (level = 128) => ({mean: level, histogram: new Array(16).fill(0).map((_, bin) => bin === (level >> 4) ? 1296 : 0)});

test('identical frames have zero distance and stable frames stay far below the threshold', () => {
  const signature = makeSignature(60);
  assert.equal(signatureDistance(signature, signature), 0);
  const signatures = Array.from({length: 40}, () => makeSignature(60));
  const scores = computeScores(signatures);
  assert.deepEqual(detectCutsFromScores(scores), []);
});

test('a single hard cut is detected exactly at the first presented frame of the new shot', () => {
  const signatures = [...Array.from({length: 30}, () => makeSignature(40)), ...Array.from({length: 30}, () => makeSignature(180))];
  const cuts = detectCutsFromScores(computeScores(signatures));
  assert.deepEqual(cuts, [30]);
  const bounds = cutsToShotBounds(cuts, signatures.length);
  assert.deepEqual(bounds, [{startFrame: 0, endFrameExclusive: 30}, {startFrame: 30, endFrameExclusive: 60}]);
});

test('multiple cuts are found in order and bounds cover every frame without gaps', () => {
  const signatures = [
    ...Array.from({length: 25}, () => makeSignature(30)),
    ...Array.from({length: 25}, () => makeSignature(90)),
    ...Array.from({length: 25}, () => makeSignature(150)),
    ...Array.from({length: 25}, () => makeSignature(210)),
  ];
  const cuts = detectCutsFromScores(computeScores(signatures));
  assert.deepEqual(cuts, [25, 50, 75]);
  const bounds = cutsToShotBounds(cuts, 100);
  assert.equal(bounds.length, 4);
  let end = 0;
  for (const bound of bounds) {assert.equal(bound.startFrame, end);end = bound.endFrameExclusive;}
  assert.equal(end, 100);
});

test('a single-frame flash is suppressed by the minimum shot length rule', () => {
  const signatures = Array.from({length: 40}, () => makeSignature(60));
  signatures[20] = makeSignature(255); // 闪白一帧
  signatures[21] = makeSignature(60);
  const cuts = detectCutsFromScores(computeScores(signatures));
  assert.deepEqual(cuts, [], '单帧闪白不应产生切点');
});

test('slow fades without a hard discontinuity do not create cuts, but manual cut lists still build valid bounds', () => {
  // 淡入淡出：直方图质量逐帧缓慢迁移，单帧距离始终远低于阈值。
  const fadeSignature = fraction => {
    const histogram = new Array(16).fill(0);
    const position = fraction * 15;
    const low = Math.floor(position), high = Math.min(15, low + 1);
    histogram[low] += Math.max(0, 1 - (position - low));
    histogram[high] += Math.max(0, position - low);
    return {mean: fraction * 255, histogram: histogram.map(value => value * 1296)};
  };
  const signatures = Array.from({length: 60}, (_, index) => fadeSignature(index / 59));
  const cuts = detectCutsFromScores(computeScores(signatures));
  assert.equal(cuts.length, 0);
  const bounds = cutsToShotBounds([30], 60);
  assert.deepEqual(bounds, [{startFrame: 0, endFrameExclusive: 30}, {startFrame: 30, endFrameExclusive: 60}]);
  // 人工切点允许与自动规则不同；覆盖校验仍然无缝。
  assert.deepEqual(cutsToShotBounds([1, 59], 60), [{startFrame: 0, endFrameExclusive: 1}, {startFrame: 1, endFrameExclusive: 59}, {startFrame: 59, endFrameExclusive: 60}]);
  assert.deepEqual(cutsWithConfidence([30], computeScores([...Array.from({length: 30}, () => makeSignature(10)), ...Array.from({length: 30}, () => makeSignature(200))]))[0].confidence, 1);
});

test('duplicate and out-of-range cut frames are normalized safely', () => {
  assert.deepEqual(cutsToShotBounds([30, 30, -5, 60], 60), [{startFrame: 0, endFrameExclusive: 30}, {startFrame: 30, endFrameExclusive: 60}]);
  assert.deepEqual(cutsToShotBounds([], 10), [{startFrame: 0, endFrameExclusive: 10}]);
});
