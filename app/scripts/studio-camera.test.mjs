import test from 'node:test';
import assert from 'node:assert/strict';
import {solveCamera, estimateCameraFromPersonBox, projectPoints, rotationMatrix, matrixFromRotationVector, rotationVectorFromMatrix, dlt} from '../studio/camera.mjs';

function syntheticScene({pointCount = 12, noise = 0, seed = 7}) {
  // 简单可复现伪随机
  let state = seed;
  const rand = () => {state = (state * 16807) % 2147483647;return (state - 1) / 2147483646;};
  const intrinsics = {fx: 1100 + rand() * 200, fy: 1100 + rand() * 200, cx: 640, cy: 360};
  const R = matrixFromRotationVector([0.2 * rand(), 0.4 * rand() - 0.2, 0.1 * rand()]);
  const t = [0.5 * rand(), -0.3 * rand(), 6 + 2 * rand()];
  const points = [];
  const correspondences = [];
  for (let index = 0; index < pointCount; index++) {
    const X = [rand() * 6 - 3, rand() * 2 - 1, rand() * 3];
    points.push(X);
    const [u, v] = projectPoints(intrinsics, R, t, [X])[0];
    assert.ok(Number.isFinite(u) && Number.isFinite(v), '投影应有效');
    correspondences.push({X, x: [u + (rand() - 0.5) * 2 * noise, v + (rand() - 0.5) * 2 * noise]});
  }
  return {intrinsics, R, t, points, correspondences};
}

test('rotation helpers round-trip', () => {
  const omega = [0.3, -0.8, 0.15];
  const R = matrixFromRotationVector(omega);
  assert.deepEqual(rotationVectorFromMatrix(R).map(value => Number(value.toFixed(6))), omega.map(value => Number(value.toFixed(6))));
  const identity = rotationMatrix([0, 1, 0], 0);
  assert.deepEqual(identity, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
});

test('DLT recovers the projection up to scale on noise-free data', () => {
  const scene = syntheticScene({});
  const P = dlt(scene.correspondences);
  // 用 P 重投影
  let maxError = 0;
  for (const {X, x} of scene.correspondences) {
    const w = P[2][0] * X[0] + P[2][1] * X[1] + P[2][2] * X[2] + P[2][3];
    const u = (P[0][0] * X[0] + P[0][1] * X[1] + P[0][2] * X[2] + P[0][3]) / w;
    const v = (P[1][0] * X[0] + P[1][1] * X[1] + P[1][2] * X[2] + P[1][3]) / w;
    maxError = Math.max(maxError, Math.hypot(u - x[0], v - x[1]));
  }
  assert.ok(maxError < 1e-3, `DLT 重投影误差应接近 0，实际 ${maxError}`);
});

test('solveCamera meets the A5 gate: median reprojection ≤8px with landmark evidence', () => {
  const scene = syntheticScene({pointCount: 14});
  const solution = solveCamera({correspondences: scene.correspondences});
  assert.equal(solution.needsManualReview, false, `无噪数据应高置信：${JSON.stringify(solution)}`);
  assert.ok(solution.medianErrorPx <= 8, `中位误差 ${solution.medianErrorPx} 应 ≤8px`);
  assert.ok(solution.medianErrorPx < 1, `无噪数据应接近 0：${solution.medianErrorPx}`);
  assert.equal(solution.confidence, 0.8);
  // 焦距恢复合理（DLT 尺度对焦距与平移耦合，这里只验证数量级）
  assert.ok(solution.intrinsics.fx > 100 && solution.intrinsics.fx < 100000);
});

test('solveCamera tolerates pixel noise and still stays under the gate', () => {
  const scene = syntheticScene({pointCount: 16, noise: 0.8, seed: 21});
  const solution = solveCamera({correspondences: scene.correspondences});
  assert.ok(solution.medianErrorPx <= 8, `0.8px 噪声下中位误差 ${solution.medianErrorPx} 应 ≤8px`);
});

test('fewer than 6 landmarks is rejected as insufficient evidence', () => {
  const scene = syntheticScene({pointCount: 5, seed: 3});
  assert.throws(() => solveCamera({correspondences: scene.correspondences}), error => error.status === 422 && /6 个/.test(error.message));
});

test('person-box estimate is honest: low confidence, manual review required', () => {
  const estimate = estimateCameraFromPersonBox({box: {x: 0.3, y: 0.2, w: 0.2, h: 0.5}, imageWidth: 1280, imageHeight: 720});
  assert.equal(estimate.source, 'person-estimate');
  assert.equal(estimate.needsManualReview, true);
  assert.equal(estimate.confidence, 0.2);
  // 距离 = f·H/h：f = (1280/2)/tan(27.5°) ≈ 1229；h=0.5*720=360px → ≈ 5.97m
  assert.ok(estimate.distanceMeters > 4 && estimate.distanceMeters < 8, `距离 ${estimate.distanceMeters}`);
});
