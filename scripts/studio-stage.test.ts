import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {poseFromMotion, standingPose, cameraViewFromTrack, groundPointFromBox, usableCamera, type MotionData} from '../src/studio-stage-math';
import {createRigidCharacter} from '../src/rig';
import {sampleAt, defaultCameraView, motionFrameAt} from '../src/studio-timeline';
import {MotionArtifactCache, motionCacheKey, motionTracksForShot, tagMotion} from '../src/studio-motion-cache';
import type {ProjectDetail} from '../src/studio';
import {isValidMotionFrame, matchesMotionContext} from '../studio/motion-validation.mjs';

const HEIGHT = 1.75;
const H = (fraction: number) => fraction * HEIGHT;

// 构造一个站立动作帧（关节相对骨盆，y 向上，地面 0，与 studio/pose3d.mjs 输出同构）。
function standingMotion(): MotionData {
  const j: Record<string, [number, number, number]> = {
    pelvis: [0, 0, 0],
    neck: [0, H(0.29), 0],
    head: [0, H(0.42), 0],
    shoulderL: [H(0.095), H(0.29), 0],
    shoulderR: [-H(0.095), H(0.29), 0],
    elbowL: [H(0.095), H(0.29 - 0.175), 0],
    wristL: [H(0.095), H(0.29 - 0.175 - 0.16), 0],
    elbowR: [-H(0.095), H(0.29 - 0.175), 0],
    wristR: [-H(0.095), H(0.29 - 0.175 - 0.16), 0],
    hipL: [H(0.03), H(-0.081), 0],
    hipR: [-H(0.03), H(-0.081), 0],
    kneeL: [H(0.03), H(-0.081 - 0.245), 0],
    kneeR: [-H(0.03), H(-0.081 - 0.245), 0],
    ankleL: [H(0.03), H(-0.081 - 0.245 - 0.22), 0],
    ankleR: [-H(0.03), H(-0.081 - 0.245 - 0.22), 0],
  };
  return {
    trackId: 't-1', shotId: 'S01', characterId: 'c-1', bodyHeight: HEIGHT,
    frames: [{frame: 10, timeS: 0.5, contacts: {ankleL: true, ankleR: true}, rootOffset: [0.4, H(0.53 + 0.02), -1.2], joints: j}],
  };
}

test('poseFromMotion maps a standing frame onto the rig with a raised root', () => {
  const motion = standingMotion();
  const pose = poseFromMotion(motion, 12, HEIGHT, {groundXZ: [2, -1], faceXZ: [2, 10]});
  assert.ok(pose, '应产出姿态');
  assert.equal(pose.frame, 10);
  // 根高度 = 骨盆目标高度 − 0.53×身高；骨盆目标 = rootOffset[1]
  assert.ok(Math.abs(pose.rootPosition![1] - (H(0.55) - H(0.53))) < 1e-9, `root y=${pose.rootPosition![1]}`);
  assert.equal(pose.rootPosition![0], 2);
  assert.equal(pose.rootPosition![2], -1);
  // 全部 RIG_JOINTS 都有四元数且归一化
  for (const rotation of Object.values(pose.rotations!)) {
    const length = Math.hypot(...rotation);
    assert.ok(Math.abs(length - 1) < 1e-6, `四元数应归一化：${length}`);
  }
});

test('poseFromMotion picks the nearest non-null frame and returns null without frames', () => {
  const motion = standingMotion();
  motion.frames.push(null, JSON.parse(JSON.stringify(motion.frames[0])));
  (motion.frames[2] as {frame: number}).frame = 20;
  const pose = poseFromMotion(motion, 18, HEIGHT);
  assert.equal(pose?.frame, 20, '帧 18 最近的非空帧是 20');
  assert.equal(poseFromMotion({...motion, frames: [null]}, 0, HEIGHT), null);
});

test('standingPose faces the requested direction via root yaw', () => {
  const pose = standingPose(HEIGHT, [0, 0], [0, -5]); // 朝 -Z
  const [x, y, z, w] = pose.rotations!.root;
  const quaternion = new THREE.Quaternion(x, y, z, w);
  const applied = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
  assert.ok(applied.z < -0.9, `+Z 旋转后应指向 -Z，实际 (${applied.x.toFixed(3)}, ${applied.z.toFixed(3)})`);
});

test('cameraViewFromTrack converts world-to-camera extrinsics to a Three.js view', () => {
  // 相机在 (0, 2, -6)，朝 +Z 看（世界系），y 翻转的相机坐标系。
  // R=diag(1,-1,1)（world→camera），C=-Rᵀ·t → t=(0,2,6) 给出 C=(0,2,-6)。
  const R = [1, 0, 0, 0, -1, 0, 0, 0, 1];
  const t = [0, 2, 6];
  const view = cameraViewFromTrack({source: 'landmark-pnp', intrinsics: {fx: 1000, fy: 1000, cx: 320, cy: 240, height: 480}, extrinsics: {rotation: R, translation: t}});
  assert.ok(view);
  assert.ok(Math.abs(view.position[0]) < 1e-9 && Math.abs(view.position[1] - 2) < 1e-9 && Math.abs(view.position[2] + 6) < 1e-9, `C=${JSON.stringify(view.position)}`);
  assert.ok(Math.abs(view.target[2] - (-6 + 10)) < 1e-9, 'target 沿 +Z 前方');
  assert.ok(Math.abs(view.fov - 2 * Math.atan(480 / 2 / 1000) * 180 / Math.PI) < 1e-9);
  // 无外参解（person-estimate）→ null
  assert.equal(cameraViewFromTrack({source: 'person-estimate', intrinsics: {fx: 1000}, extrinsics: {rotation: null, translation: null}}), null);
  assert.ok(usableCamera({source: 'landmark-pnp', intrinsics: {}, extrinsics: {rotation: R, translation: t}}));
});

test('groundPointFromBox intersects the box bottom ray with the ground plane', () => {
  // 相机在 (0, 2, 0) 朝 +Z，y 翻转；焦距 1000，640×480。
  const R = [1, 0, 0, 0, -1, 0, 0, 0, 1];
  const t = [0, 2, 0];
  const cam = {source: 'landmark-pnp', intrinsics: {fx: 1000, fy: 1000, cx: 320, cy: 240}, extrinsics: {rotation: R, translation: t}};
  // 框底边在 v=440（中心下方 200px）→ 相机系 y=+0.2 → 世界 y=-0.2（向下）→ 命中 z=10
  const point = groundPointFromBox(cam, {x: 0.45, y: 0.7, w: 0.1, h: 0.2167}, 640, 480);
  assert.ok(point, '应命中地面');
  assert.ok(Math.abs(point![2] - 10) < 0.01, `落点应在 z=10，实际 z=${point![2]}`);
  assert.equal(point![1], 0);
  // 框底边正好在画面中心 → 水平射线永不落地 → null
  assert.equal(groundPointFromBox(cam, {x: 0.45, y: 0.3, w: 0.1, h: 0.2}, 640, 480), null, '水平射线不应命中');
});

test('retargeted outgoing limb directions match down, T-pose and bent-arm observations after root yaw', () => {
  const pairs = [
    ['upperArm_L', 'forearm_L', 'shoulderL', 'elbowL'], ['forearm_L', 'hand_L', 'elbowL', 'wristL'],
    ['upperArm_R', 'forearm_R', 'shoulderR', 'elbowR'], ['forearm_R', 'hand_R', 'elbowR', 'wristR'],
    ['thigh_L', 'shin_L', 'hipL', 'kneeL'], ['shin_L', 'foot_L', 'kneeL', 'ankleL'],
    ['thigh_R', 'shin_R', 'hipR', 'kneeR'], ['shin_R', 'foot_R', 'kneeR', 'ankleR'],
  ];
  for (const shape of ['down', 'T', 'bent']) for (const face of [[0, 10], [10, 0], [0, -10]] as [number, number][]) {
    const motion = standingMotion();
    const joints = motion.frames[0]!.joints;
    if (shape !== 'down') {
      joints.elbowL = [H(0.27), H(0.29), 0];
      joints.wristL = shape === 'T' ? [H(0.43), H(0.29), 0] : [H(0.27), H(0.45), 0];
      joints.elbowR = [H(-0.27), H(0.29), 0];
      joints.wristR = shape === 'T' ? [H(-0.43), H(0.29), 0] : [H(-0.27), H(0.29), H(0.16)];
    }
    const rig = createRigidCharacter({height: HEIGHT, level: 'CL2'});
    try {
      const pose = poseFromMotion(motion, 10, HEIGHT, {groundXZ: [0, 0], faceXZ: face})!;
      rig.applyPose(pose);
      const yaw = new THREE.Quaternion(...pose.rotations!.root);
      for (const [bone, child, from, to] of pairs) {
        const actual = rig.bones[child].getWorldPosition(new THREE.Vector3()).sub(rig.bones[bone].getWorldPosition(new THREE.Vector3())).normalize();
        const expected = new THREE.Vector3(...joints[to]).sub(new THREE.Vector3(...joints[from])).normalize().applyQuaternion(yaw);
        const error = actual.angleTo(expected) * 180 / Math.PI;
        assert.ok(error < 0.00001, `${shape}, face=${face}, ${bone}: ${error}°`);
      }
    } finally {rig.dispose();}
  }
});

function timelineFixture() {
  const shots = [0, 1, 2].map(i => ({id: `S0${i + 1}`, startUs: i * 1e6, endUs: (i + 1) * 1e6, startFrame: i * 24, endFrameExclusive: (i + 1) * 24}));
  const tracks = shots.map((shot, i) => ({id: `t-${i + 1}`, shotId: shot.id, startUs: shot.startUs, endUs: shot.endUs, startFrame: shot.startFrame, endFrame: shot.endFrameExclusive - 1, box: {x: .1, y: .2, w: .2, h: .6}, status: 'active', subject: 'person', confidence: 1, provenance: 'auto'}));
  const characters = tracks.map((track, i) => ({id: `c-${i + 1}`, name: track.id, color: '#884411', scale: HEIGHT, proxyLevel: ['CL0', 'CL1', 'CL2'][i], rigFamily: 'humanoid'}));
  const detail = {
    project: {id: 'p-1', revision: 'r-1'}, media: {width: 1280, height: 720, durationUs: 3e6}, shots, tracks, characters,
    bindings: tracks.map((track, i) => ({trackId: track.id, characterId: characters[i].id, disposition: 'bound'})),
    motionRefs: Object.fromEntries(tracks.map(track => [track.id, `${track.id}.json`])),
    motionVersions: Object.fromEntries(tracks.map(track => [track.id, 'version-1'])), cameraTracks: [],
  } as unknown as ProjectDetail;
  const motions = Object.fromEntries(tracks.map((track, i) => {
    const motion = standingMotion();
    motion.trackId = track.id;motion.shotId = track.shotId;motion.characterId = characters[i].id;
    motion.frames[0]!.timeS = i + .1;motion.frames[0]!.frame = i * 24 + 2;motion.frames[0]!.rootOffset = [0, H(.53), 0];
    return [track.id, tagMotion(detail, track.id, motion)];
  }));
  return {detail, motions};
}

test('three-shot loading and sampling follows sequential, direct and backward seeks with persisted CL levels', () => {
  const {detail, motions} = timelineFixture();
  for (const i of [0, 1, 2, 0, 2, 1]) {
    assert.deepEqual(motionTracksForShot(detail, `S0${i + 1}`), [`t-${i + 1}`]);
    const sampled = sampleAt(detail, motions, (i + .1) * 1e6);
    assert.equal(sampled.shot!.id, `S0${i + 1}`);
    assert.equal(sampled.instances[0].quality, 'solved');
    assert.equal(sampled.instances[0].character.proxyLevel, `CL${i}`);
  }
  assert.deepEqual(motionTracksForShot(detail, 'missing'), []);
});

test('per-appearance anchors retain left-right composition for solved and placeholder actors, including local movement', () => {
  const {detail, motions} = timelineFixture();
  detail.tracks[1] = {...detail.tracks[1], shotId: 'S01', startUs: 0, endUs: 1e6, box: {x: .7, y: .2, w: .2, h: .6}};
  delete detail.motionRefs['t-2'];
  const frame = sampleAt(detail, motions, 100000);
  const [left, right] = frame.instances;
  assert.equal(left.quality, 'solved');assert.equal(right.quality, 'placeholder');
  assert.ok(left.pose!.rootPosition![0] < 0 && right.pose!.rootPosition![0] > 0);
  assert.ok(right.pose!.rootPosition![0] - left.pose!.rootPosition![0] > 1);
  const first = motions['t-1'].frames[0]!;
  motions['t-1'].frames.push({...first, frame: 6, timeS: .2, rootOffset: [.25, H(.53), .1]});
  const later = sampleAt(detail, motions, 200000).instances[0];
  assert.ok(Math.abs(later.pose!.rootPosition![0] - left.pose!.rootPosition![0] - .25) < 1e-8);
  assert.deepEqual(sampleAt(detail, motions, 100000), frame, 'seek must not depend on earlier samples');
});

test('sampler rejects removed refs, missing or changed versions, changed bindings and height', () => {
  for (const change of ['ref', 'version', 'missing-version', 'binding', 'height']) {
    const {detail, motions} = timelineFixture();
    if (change === 'ref') delete detail.motionRefs['t-1'];
    if (change === 'version') detail.motionVersions!['t-1'] = 'version-2';
    if (change === 'missing-version') delete detail.motionVersions!['t-1'];
    if (change === 'binding') detail.bindings[0].characterId = 'c-2';
    if (change === 'height') detail.characters[0].scale = 2;
    assert.equal(sampleAt(detail, motions, 100000).instances[0].quality, 'placeholder', change);
  }
});

test('shared artifact context contract rejects incorrect track, shot, character and body height in playback', () => {
  const patches: Partial<MotionData>[] = [
    {trackId: 'other'}, {shotId: 'S02'}, {characterId: 'other'},
    {bodyHeight: 0}, {bodyHeight: -1}, {bodyHeight: Infinity}, {bodyHeight: Number.NaN}, {bodyHeight: HEIGHT + 1e-6},
  ];
  for (const patch of patches) {
    const {detail, motions} = timelineFixture();
    Object.assign(motions['t-1'], patch);
    assert.equal(matchesMotionContext(motions['t-1'], {trackId: 't-1', shotId: 'S01', characterId: 'c-1', bodyHeight: HEIGHT}), false);
    assert.equal(sampleAt(detail, motions, 100000).instances[0].quality, 'placeholder', JSON.stringify(patch));
  }
  const {detail, motions} = timelineFixture();
  motions['t-1'].bodyHeight = HEIGHT + 5e-10;
  assert.equal(sampleAt(detail, motions, 100000).instances[0].quality, 'solved', 'allow harmless numerical precision difference');
});

test('shared frame contract rejects invalid frame index, time, root or required joints in playback', () => {
  const invalid = [
    {frame: -1}, {frame: 1.5}, {frame: Number.NaN}, {frame: Infinity},
    {timeS: -1}, {timeS: Infinity}, {rootOffset: [0, 1]}, {rootOffset: [0, Number.NaN, 0]}, {joints: {}},
  ];
  for (const patch of invalid) {
    const {detail, motions} = timelineFixture();
    Object.assign(motions['t-1'].frames[0]!, patch);
    assert.equal(isValidMotionFrame(motions['t-1'].frames[0]), false);
    assert.equal(sampleAt(detail, motions, 100000).instances[0].quality, 'placeholder', JSON.stringify(patch));
  }
});

test('null pose samples and long gaps remain placeholders instead of holding a solved pose', () => {
  const {detail, motions} = timelineFixture();
  const motion = motions['t-1'];
  const first = motion.frames[0]!;
  motion.frames = [first, null, {...first, frame: 6, timeS: .3}];
  motion.sampleTimesS = [.1, .2, .3];
  assert.equal(sampleAt(detail, motions, 200000).instances[0].quality, 'placeholder');
  assert.equal(motionFrameAt(motion, .2).frame, null);
  assert.equal(sampleAt(detail, motions, 900000).instances[0].pose!.frame, -1);
  first.joints.ankleL[1] = Number.NaN;
  assert.equal(sampleAt(detail, motions, 100000).instances[0].quality, 'placeholder');
});

test('unsolved shot camera is deterministic across playback and seek history', () => {
  const {detail, motions} = timelineFixture();
  detail.cameraTracks = [{id: 'cam', shotId: 'S01', source: 'landmark-pnp', confidence: 1, medianErrorPx: 0, needsManualReview: false,
    intrinsics: {fy: 900, height: 720}, extrinsics: {rotation: [1, 0, 0, 0, -1, 0, 0, 0, 1], translation: [0, 2, 6]}}];
  const direct = sampleAt(detail, motions, 1100000).camera;
  assert.notDeepEqual(sampleAt(detail, motions, 100000).camera, direct);
  for (const pts of [100000, 2100000, 0, 2900000]) {
    sampleAt(detail, motions, pts);
    assert.deepEqual(sampleAt(detail, motions, 1100000).camera, direct);
  }
  assert.deepEqual(direct, defaultCameraView());
});

test('motion cache retries transient errors, drops obsolete responses and evicts invalidated artifacts', async () => {
  const {detail, motions} = timelineFixture();
  const cache = new MotionArtifactCache();
  const key = motionCacheKey(detail, 't-1')!;
  cache.reconcile({'t-1': key});
  assert.equal(await cache.load('t-1', async () => {throw Error('transient');}, 0), false);
  assert.equal(await cache.load('t-1', async () => motions['t-1'], 1999), false);
  assert.equal(await cache.load('t-1', async () => motions['t-1'], 2000), true);
  assert.equal(cache.snapshot()['t-1'].artifactKey, key);
  cache.reconcile({});assert.deepEqual(cache.snapshot(), {});
  cache.reconcile({'t-1': key});
  let finish!: (motion: MotionData) => void;
  const pending = cache.load('t-1', () => new Promise(resolve => {finish = resolve;}), 3000);
  cache.reconcile({'t-1': 'new-key'});
  assert.equal(await cache.load('t-1', async () => ({...motions['t-1'], characterName: 'new artifact'}), 3000), true);
  finish(motions['t-1']);assert.equal(await pending, false);
  assert.equal(cache.snapshot()['t-1'].artifactKey, 'new-key');
  assert.equal(cache.snapshot()['t-1'].characterName, 'new artifact');
});
