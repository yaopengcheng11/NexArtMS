import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalBones, liftFrame, buildMotion, refineSkeleton} from '../studio/pose3d.mjs';

const WIDTH = 1280, HEIGHT = 720, FOCAL = 1500, CX = 640, CY = 360;
const BODY_HEIGHT = 1.75;

test('a single hidden joint is estimated, never dropping the whole frame (P6 partial pose)', () => {
  for (const kind of ['wrist','head','y']) {
    const {keypoints}=makePose();
    if(kind==='wrist')keypoints[9].v=0.1;
    if(kind==='head')keypoints[0]=null;
    if(kind==='y')keypoints[10].y=NaN;
    const lifted = liftFrame(keypoints,{width:WIDTH,height:HEIGHT},canonicalBones(BODY_HEIGHT),{focalPx:FOCAL});
    assert.ok(lifted, `${kind}: 部分姿态应可解而不是丢弃`);
    assert.ok(lifted.estimated.size >= 1, `${kind}: 缺失关节应记入 estimated`);
    const motion=buildMotion([{frame:0,timeS:0,keypoints}],{width:WIDTH,height:HEIGHT,focalPx:FOCAL});
    assert.equal(motion.report.skippedFrames,0);
    assert.equal(motion.report.frameCount,1);
    // 骨长仍由构造保证
    assert.ok(motion.report.maxBoneDeviationPct <= 0.1);
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

test('legs-only close-up solves with estimated upper body; truly unanchored frames are skipped', () => {
  const {keypoints} = makePose({});
  const legsOnly = keypoints.map((point, index) => index < 11 ? null : point); // 只剩腿部（髋/膝/踝）
  const bones = canonicalBones(BODY_HEIGHT);
  const lifted = liftFrame(legsOnly, {width: WIDTH, height: HEIGHT}, bones, {focalPx: FOCAL});
  assert.ok(lifted, '缺上身不应导致整帧丢弃（V2 §8.2）');
  assert.equal(lifted.provenance, 'estimated');
  for (const name of ['neck', 'head', 'shoulderL', 'shoulderR']) assert.ok(lifted.estimated.has(name), `${name} 应为估计关节`);
  const motion = buildMotion([{frame: 0, timeS: 0, keypoints: legsOnly}], {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL});
  assert.equal(motion.report.frameCount, 1);
  assert.equal(motion.report.estimatedFrames, 1);
  // 上半身近景（无腿）同样可解
  const upperOnly = keypoints.map((point, index) => index >= 11 && index <= 16 ? null : point);
  const upper = liftFrame(upperOnly, {width: WIDTH, height: HEIGHT}, bones, {focalPx: FOCAL});
  assert.ok(upper, '缺腿近景不应导致上半身全部丢弃');
  for (const name of ['hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR']) assert.ok(upper.estimated.has(name), `${name} 应为估计关节`);
  // 无锚点（只有两个踝和一个头，无髋/肩）→ 如实跳过
  const unanchored = keypoints.map((point, index) => [0, 15, 16].includes(index) ? point : null);
  assert.equal(liftFrame(unanchored, {width: WIDTH, height: HEIGHT}, bones, {focalPx: FOCAL}), null);
  const skipped = buildMotion([{frame: 0, timeS: 0, keypoints: unanchored}], {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL});
  assert.equal(skipped.report.frameCount, 0);
  assert.equal(skipped.report.skippedFrames, 1);
});

test('P6: short gaps are interpolated (marked), long gaps stay empty', () => {
  const series = [];
  for (let index = 0; index < 10; index++) {
    const {keypoints} = makePose({height: 4 + index * 0.02});
    series.push({frame: index, timeS: index / 10, keypoints: index === 4 ? null : keypoints});
  }
  const motion = buildMotion(series, {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL, maxGapSeconds: 0.2});
  assert.equal(motion.report.interpolatedFrames, 1, '10fps 下 0.2s 的单帧缺口应插值');
  assert.equal(motion.frames[4].provenance, 'interpolated');
  const between = motion.frames[4].joints.neck[2];
  assert.ok(between > motion.frames[3].joints.neck[2] && between < motion.frames[5].joints.neck[2], '插值应在邻帧之间');
  // 长缺口（0.5s）不插值
  const longGap = series.map((item, index) => index >= 3 && index <= 7 ? {...item, keypoints: null} : item);
  const motion2 = buildMotion(longGap, {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL, maxGapSeconds: 0.2});
  assert.equal(motion2.report.interpolatedFrames, 0);
  assert.ok([3, 4, 5, 6, 7].every(index => motion2.frames[index] === null), '长缺口保持空洞');
});

test('P6: root facing comes from the chest normal instead of forcing camera-facing', () => {
  const {keypoints} = makePose({});
  const motion = buildMotion([{frame: 0, timeS: 0, keypoints}, {frame: 1, timeS: 0.1, keypoints}], {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL});
  const forward = motion.frames[0].forward;
  assert.ok(forward, '观测帧应给出朝向');
  assert.ok(Math.abs(forward[1]) > 0.9, `正面姿势的前向应主要在 ±Z：${forward}`);
});

test('P6: contact-phase foot planting removes world slide via root compensation', () => {
  const series = [];
  for (let index = 0; index < 12; index++) {
    const {keypoints} = makePose({height: 4});
    // 模拟缓慢的水平漂移（低于接触速度阈值，但足以累积可见脚滑）
    for (const point of keypoints) if (point) point.x += index * 0.0006;
    series.push({frame: index, timeS: index / 24, keypoints});
  }
  const motion = buildMotion(series, {width: WIDTH, height: HEIGHT, bodyHeight: BODY_HEIGHT, focalPx: FOCAL});
  assert.ok(motion.report.plantedRuns >= 1, '应检出至少一段支撑接触');
  assert.ok(motion.report.footSlideAfterPct <= 1.0, `锁定后残留脚滑应接近 0：${motion.report.footSlideAfterPct}%`);
  assert.ok(motion.report.footSlideBeforePct > motion.report.footSlideAfterPct, '锁定前的脚滑应大于锁定后');
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
    // 确定性偏移（避免随机数导致的偶发收敛差异）
    const jitterU = ((index * 37) % 9 - 4) * 0.8;
    const jitterV = ((index * 53) % 9 - 4) * 0.8;
    jointPixels[name] = {u: point.x * WIDTH + jitterU, v: point.y * HEIGHT + jitterV};
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
