import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalBones, liftFrame, buildMotion, refineSkeleton} from '../studio/pose3d.mjs';

const WIDTH = 1280, HEIGHT = 720, FOCAL = 1500, CX = 640, CY = 360;
const BODY_HEIGHT = 1.75;

test('single hidden wrist, missing head and non-finite y are skipped without crashing', () => {
  for (const kind of ['wrist','head','y']) {
    const {keypoints}=makePose();
    if(kind==='wrist')keypoints[9].v=0.1;
    if(kind==='head')keypoints[0]=null;
    if(kind==='y')keypoints[10].y=NaN;
    assert.equal(liftFrame(keypoints,{width:WIDTH,height:HEIGHT},canonicalBones(BODY_HEIGHT)),null);
    const motion=buildMotion([{frame:0,timeS:0,keypoints}],{width:WIDTH,height:HEIGHT});
    assert.equal(motion.report.skippedFrames,1);
  }
});

// 在相机坐标系构造一个与骨长完全一致的 3D 姿势（y 向下），投影为 2D 关键点。
function makePose({height: z = 4, lean = 0, swing = 0} = {}) {
  const bones = canonicalBones(BODY_HEIGHT);
  const length = name => bones.find(bone => bone.name === name).length;
  const joints = {
    pelvis: [lean * 0.2, -0.555 * BODY_HEIGHT, z],
    neck: [lean * 0.5, joints => 0, z], // placeholder replaced below
  };
  joints.neck = [lean * 0.5, joints.pelvis[1] - length('pelvis-neck'), z];
  joints.head = [lean * 0.7, joints.neck[1] - length('neck-head'), z];
  joints.shoulderL = [joints.neck[0] + length('neck-shoulderL'), joints.neck[1], z];
  joints.shoulderR = [joints.neck[0] - length('neck-shoulderR'), joints.neck[1], z];
  joints.elbowL = [joints.shoulderL[0] + length('shoulderL-elbowL') * Math.cos(swing), joints.shoulderL[1] + length('shoulderL-elbowL') * Math.sin(swing), z];
  joints.wristL = [joints.elbowL[0] + length('elbowL-wristL') * Math.cos(swing), joints.elbowL[1] + length('elbowL-wristL') * Math.sin(swing), z];
  joints.elbowR = [joints.shoulderR[0] - length('shoulderR-elbowR') * Math.cos(swing), joints.shoulderR[1] + length('shoulderR-elbowR') * Math.sin(swing), z];
  joints.wristR = [joints.elbowR[0] - length('elbowR-wristR') * Math.cos(swing), joints.elbowR[1] + length('elbowR-wristR') * Math.sin(swing), z];
  const hipSpread = Math.sqrt(Math.max(length('pelvis-hipL') ** 2 - 0.03 * BODY_HEIGHT ** 2, 0));
  joints.hipL = [joints.pelvis[0] + 0.03 * BODY_HEIGHT, joints.pelvis[1] + hipSpread, z];
  joints.hipR = [joints.pelvis[0] - 0.03 * BODY_HEIGHT, joints.pelvis[1] + hipSpread, z];
  joints.kneeL = [joints.hipL[0] + lean * 0.1, joints.hipL[1] + length('hipL-kneeL'), z];
  joints.kneeR = [joints.hipR[0] - lean * 0.1, joints.hipR[1] + length('hipR-kneeR'), z];
  joints.ankleL = [joints.kneeL[0], joints.kneeL[1] + length('kneeL-ankleL'), z];
  joints.ankleR = [joints.kneeR[0], joints.kneeR[1] + length('kneeR-ankleR'), z];
  // 投影（y 向下与图像一致）
  const project = p => ({x: (CX + FOCAL * p[0] / p[2]) / WIDTH, y: (CY + FOCAL * p[1] / p[2]) / HEIGHT, v: 0.9});
  const keypoints = new Array(17).fill(null);
  const indexBy = {head: 0, shoulderL: 5, shoulderR: 6, elbowL: 7, elbowR: 8, wristL: 9, wristR: 10, hipL: 11, hipR: 12, kneeL: 13, kneeR: 14, ankleL: 15, ankleR: 16};
  for (const [name, index] of Object.entries(indexBy)) keypoints[index] = project(joints[name]);
  keypoints[5] = project(joints.shoulderL);keypoints[6] = project(joints.shoulderR);
  return {joints, keypoints};
}

test('a projected consistent 3D pose lifts back with exact bone lengths', () => {
  const {keypoints, joints} = makePose({lean: 0.3, swing: 0.4});
  const bones = canonicalBones(BODY_HEIGHT);
  const lifted = liftFrame(keypoints, {width: WIDTH, height: HEIGHT}, bones, {focalPx: FOCAL});
  assert.ok(lifted, '应能提升');
  let maxDeviation = 0;
  for (const bone of bones) {
    const p = lifted.joints[bone.parent], c = lifted.joints[bone.child];
    const err = Math.abs(Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) - bone.length) / bone.length;
    maxDeviation = Math.max(maxDeviation, err);
  }
  assert.ok(maxDeviation <= 0.001, `A6 骨长偏差 ${(maxDeviation * 100).toFixed(4)}% 应 ≤0.1%`);
  // 整体 3D 误差（相对骨盆）
  const relative = (joints3d, truth) => Math.hypot(joints3d[0] - truth[0], joints3d[2] - truth[2]);
  assert.ok(relative(lifted.joints.neck, joints.neck) < 0.2, '颈部位置应接近真值（允许深度歧义的自由度）');
});

test('buildMotion produces fixed-bone frames, contacts and reports the A6 metric', () => {
  const series = [];
  for (let index = 0; index < 8; index++) {
    const {keypoints} = makePose({lean: index * 0.05, swing: index * 0.1, height: 4});
    series.push({frame: index * 2, timeS: index * 2 / 24, keypoints});
  }
  const motion = buildMotion(series, {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL, smoothingWindow: 3});
  assert.equal(motion.report.frameCount, 8);
  assert.ok(motion.report.maxBoneDeviationPct <= 0.1, `A6 指标 ${motion.report.maxBoneDeviationPct}% 应 ≤0.1%`);
  for (const frame of motion.frames) {
    assert.ok(frame.joints.pelvis[1] > 0, '骨盆应在地面之上（y 向上）');
    assert.ok(Math.min(frame.joints.ankleL[1], frame.joints.ankleR[1]) >= -1e-6, '最低脚踝应触地');
  }
  // 平滑不破坏骨长
  assert.equal(motion.frames.length, 8);
});

test('insufficient visible keypoints are skipped honestly', () => {
  const {keypoints} = makePose({});
  const poor = keypoints.map((point, index) => index < 11 ? null : point); // 只剩腿部
  const bones = canonicalBones(BODY_HEIGHT);
  assert.equal(liftFrame(poor, {width: WIDTH, height: HEIGHT}, bones, {focalPx: FOCAL}), null);
  const motion = buildMotion([{frame: 0, timeS: 0, keypoints: poor}], {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL});
  assert.equal(motion.report.frameCount, 0);
  assert.equal(motion.report.skippedFrames, 1);
});

test('refineSkeleton converges from a perturbed realistic start', () => {
  const bones = canonicalBones(BODY_HEIGHT);
  const {keypoints} = makePose({lean: 0.25, swing: 0.3});
  // 投影关键点加 ±4px 噪声 → 关节像素（与 liftFrame 相同的映射），加躯干比例初始化
  const jointPixels = {};
  const indexBy = {head: 0, neck: null, shoulderL: 5, shoulderR: 6, elbowL: 7, elbowR: 8, wristL: 9, wristR: 10, pelvis: null, hipL: 11, hipR: 12, kneeL: 13, kneeR: 14, ankleL: 15, ankleR: 16};
  for (const [name, index] of Object.entries(indexBy)) {
    if (index === null) continue;
    const point = keypoints[index];
    jointPixels[name] = {u: point.x * WIDTH + (Math.random() - 0.5) * 8, v: point.y * HEIGHT + (Math.random() - 0.5) * 8};
  }
  jointPixels.neck = {u: (jointPixels.shoulderL.u + jointPixels.shoulderR.u) / 2, v: (jointPixels.shoulderL.v + jointPixels.shoulderR.v) / 2};
  jointPixels.pelvis = {u: (jointPixels.hipL.u + jointPixels.hipR.u) / 2, v: (jointPixels.hipL.v + jointPixels.hipR.v) / 2};
  const torsoPx = Math.hypot(jointPixels.neck.u - jointPixels.pelvis.u, jointPixels.neck.v - jointPixels.pelvis.v);
  const z0 = FOCAL * 0.29 * BODY_HEIGHT / torsoPx;
  const joints = Object.fromEntries(Object.keys(jointPixels).map(name => [name, [jointPixels[name].u, jointPixels[name].v, z0]]));
  refineSkeleton(joints, jointPixels, bones, {focal: FOCAL, cx: CX, cy: CY, iterations: 3000, learningRate: 0.9});
  let worst = 0;
  for (const bone of bones) {
    const p = joints[bone.parent], c = joints[bone.child];
    worst = Math.max(worst, Math.abs(Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]) - bone.length) / bone.length);
  }
  // 噪声观测下问题可能无可行解：refineSkeleton 只需有界收敛；
  // A6 的 ≤0.1% 门槛由 buildMotion 剔除不可满足帧来保证（见上一测试）。
  assert.ok(worst <= 0.02, `噪声下骨长偏差应有界：${(worst * 100).toFixed(4)}%`);
});
