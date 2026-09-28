// 三维动作求解（M4 关键姿态 / M5 连续动作；P6 部分姿态/朝向/接触精化）。
// 单目视频无法唯一确定深度：本模块按“固定骨长 + 地面接触 + 时间平滑”生成
// 可审查的近似还原（计划 §5/§8.2）。A6 骨长门槛 ≤0.1% 由构造保证。
// 输入为归一化 2D 关键点（COCO 17）序列；输出为角色局部坐标系（米，y 向上，地面 y=0）。
//
// P6 契约：
// - 部分可见即可求解：上半身近景（无腿）与下半身（无上身）分别可解，缺失肢体以
//   规范骨长直链估计，逐帧 provenance 标注 观测/估计，绝不把估计冒充观测。
// - 短缺口（≤ maxGapSeconds，默认 200ms）线性插值并标记 interpolated；长缺口保持空洞。
// - 根朝向由胸腔法线估计（记录 forward），不强制角色面朝相机。
// - 接触期用根位移补偿做足端锁定（只移动整身根，不改几何、不破坏骨长）。

export const COCO_JOINTS = ['nose', 'eyeL', 'eyeR', 'earL', 'earR', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR'];
const VISIBLE = 0.3; // 关键点置信度阈值，低于视为不可见

// 骨架定义：比例相对身高 H。
export function canonicalBones(bodyHeight = 1.75) {
  const H = bodyHeight;
  return [
    {name: 'pelvis-hipL', parent: 'pelvis', child: 'hipL', length: 0.090 * H},
    {name: 'pelvis-hipR', parent: 'pelvis', child: 'hipR', length: 0.090 * H},
    {name: 'hipL-kneeL', parent: 'hipL', child: 'kneeL', length: 0.245 * H},
    {name: 'hipR-kneeR', parent: 'hipR', child: 'kneeR', length: 0.245 * H},
    {name: 'kneeL-ankleL', parent: 'kneeL', child: 'ankleL', length: 0.220 * H},
    {name: 'kneeR-ankleR', parent: 'kneeR', child: 'ankleR', length: 0.220 * H},
    {name: 'pelvis-neck', parent: 'pelvis', child: 'neck', length: 0.290 * H},
    {name: 'neck-shoulderL', parent: 'neck', child: 'shoulderL', length: 0.095 * H},
    {name: 'neck-shoulderR', parent: 'neck', child: 'shoulderR', length: 0.095 * H},
    {name: 'shoulderL-elbowL', parent: 'shoulderL', child: 'elbowL', length: 0.175 * H},
    {name: 'shoulderR-elbowR', parent: 'shoulderR', child: 'elbowR', length: 0.175 * H},
    {name: 'elbowL-wristL', parent: 'elbowL', child: 'wristL', length: 0.160 * H},
    {name: 'elbowR-wristR', parent: 'elbowR', child: 'wristR', length: 0.160 * H},
    {name: 'neck-head', parent: 'neck', child: 'head', length: 0.130 * H},
  ];
}

// 缺失关节的规范直链方向（相机坐标系，y 向下；角色左侧取 +x）。
const REST_DIR_CAMERA = {
  'pelvis-hipL': [0.33, 0.94, 0], 'pelvis-hipR': [-0.33, 0.94, 0],
  'hipL-kneeL': [0, 1, 0], 'hipR-kneeR': [0, 1, 0],
  'kneeL-ankleL': [0, 1, 0], 'kneeR-ankleR': [0, 1, 0],
  'pelvis-neck': [0, -1, 0], 'neck-head': [0, -1, 0],
  'neck-shoulderL': [1, 0, 0], 'neck-shoulderR': [-1, 0, 0],
  'shoulderL-elbowL': [1, 0, 0], 'shoulderR-elbowR': [-1, 0, 0],
  'elbowL-wristL': [1, 0, 0], 'elbowR-wristR': [-1, 0, 0],
};

/**
 * 把关节集合精化到骨长约束：只有“子关节有像素观测”的骨参与；
 * 观测关节唯一自由度为 z（像素射线参数化），无像素关节为自由根（3 自由）。
 * @returns joints（原地修改）
 */
export function refineSkeleton(joints, jointPixels, bones, {focal, cx, cy, iterations = 1200, learningRate = 0.9} = {}) {
  const rayK = {};
  for (const name of Object.keys(jointPixels)) {
    if (name === 'pelvis') continue; // 骨盆是自由根
    const pixel = jointPixels[name];
    rayK[name] = [(pixel.u - cx) / focal, (pixel.v - cy) / focal, 1];
  }
  const project = name => {
    const factor = rayK[name];
    if (!factor) return; // 自由关节（骨盆或估计关节）
    const z = joints[name][2];
    joints[name] = [factor[0] * z, factor[1] * z, z];
  };
  for (const name of Object.keys(joints)) project(name);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let totalError = 0;
    for (const bone of bones) {
      const kc = rayK[bone.child];
      if (!kc) continue; // 子关节为估计关节：不参与精化（随后按规范直链放置）
      const p = joints[bone.parent], c = joints[bone.child];
      const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (!(length > 1e-9)) continue;
      const error = length - bone.length;
      totalError += Math.abs(error);
      const lr = learningRate;
      const kp = rayK[bone.parent];
      if (kp) {
        const gradient = -(d[0] * kp[0] + d[1] * kp[1] + d[2] * kp[2]) / length;
        joints[bone.parent][2] = Math.max(1e-3, joints[bone.parent][2] - lr * error * gradient);
        project(bone.parent);
      } else {
        for (let dim = 0; dim < 3; dim++) joints[bone.parent][dim] += lr * error * d[dim] / length;
      }
      const gradient = (d[0] * kc[0] + d[1] * kc[1] + d[2] * kc[2]) / length;
      joints[bone.child][2] = Math.max(1e-3, joints[bone.child][2] - lr * error * gradient);
      project(bone.child);
    }
    if (totalError < 1e-9) break;
  }
  return joints;
}

// 按规范直链放置估计关节（父关节已定位；缺父则跳过待后续就近处理）。
function placeEstimatedJoints(joints, estimated, bones) {
  for (const bone of bones) {
    if (!estimated.has(bone.child) || !joints[bone.parent]) continue;
    const direction = REST_DIR_CAMERA[bone.name];
    if (!direction) continue;
    const norm = Math.hypot(...direction) || 1;
    const parent = joints[bone.parent];
    joints[bone.child] = [parent[0] + direction[0] / norm * bone.length, parent[1] + direction[1] / norm * bone.length, parent[2] + direction[2] / norm * bone.length];
  }
}

/**
 * 单帧 2D 关键点 → 固定骨长 3D 关节（相机坐标系，z 为深度）。
 * 部分可见即可求解（P6）：核心锚点（肩→颈 或 髋→骨盆）之一存在即可；
 * 缺失关节按规范直链估计并记入 estimated 集合。
 */
export function liftFrame(keypoints2D, {width, height}, bones, {focalPx} = {}) {
  const focal = focalPx || 1.2 * Math.max(width, height);
  const cx = width / 2, cy = height / 2;
  const pixels = {};
  for (let index = 0; index < 17; index++) {
    const point = keypoints2D?.[index];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.v >= VISIBLE) pixels[index] = {u: point.x * width, v: point.y * height};
  }
  const mid = (a, b) => ({u: (pixels[a].u + pixels[b].u) / 2, v: (pixels[a].v + pixels[b].v) / 2});
  const jointPixels = {};
  const hasShoulders = pixels[5] && pixels[6];
  const hasHips = pixels[11] && pixels[12];
  if (hasShoulders) {jointPixels.neck = mid(5, 6);jointPixels.shoulderL = pixels[5];jointPixels.shoulderR = pixels[6];}
  if (hasHips) {jointPixels.pelvis = mid(11, 12);jointPixels.hipL = pixels[11];jointPixels.hipR = pixels[12];}
  for (const [name, index] of [['head', 0], ['elbowL', 7], ['elbowR', 8], ['wristL', 9], ['wristR', 10], ['kneeL', 13], ['kneeR', 14], ['ankleL', 15], ['ankleR', 16]]) {
    if (pixels[index]) jointPixels[name] = pixels[index];
  }
  if (!jointPixels.neck && !jointPixels.head && pixels[1] && pixels[2]) jointPixels.head = mid(1, 2);
  // 锚定尺度：优先 躯干像素 → 肩宽 → 髋宽 → 单腿链
  const boneLength = name => bones.find(bone => bone.name === name).length;
  const torsoPx = hasShoulders && hasHips ? Math.hypot(jointPixels.neck.u - jointPixels.pelvis.u, jointPixels.neck.v - jointPixels.pelvis.v) : 0;
  const shoulderPx = hasShoulders ? Math.hypot(pixels[5].u - pixels[6].u, pixels[5].v - pixels[6].v) : 0;
  const hipPx = hasHips ? Math.hypot(pixels[11].u - pixels[12].u, pixels[11].v - pixels[12].v) : 0;
  const legPxLeft = pixels[15] && pixels[11] ? Math.hypot(pixels[15].u - pixels[11].u, pixels[15].v - pixels[11].v) : 0;
  const legPxRight = pixels[16] && pixels[12] ? Math.hypot(pixels[16].u - pixels[12].u, pixels[16].v - pixels[12].v) : 0;
  const hipToAnkle = boneLength('pelvis-hipL') + boneLength('hipL-kneeL') + boneLength('kneeL-ankleL');
  const anchors = [
    [torsoPx, boneLength('pelvis-neck')],                 // 躯干像素 → 真实长度
    [shoulderPx, 2 * boneLength('neck-shoulderL')],        // 肩间距 ≈ 2×neck-shoulder
    [hipPx, 0.06 * (boneLength('pelvis-hipL') / (0.090 * (boneLength('pelvis-hipL') / boneLength('pelvis-hipL'))))], // 髋间距 ≈ 2×0.03H
    [legPxLeft, hipToAnkle],
    [legPxRight, hipToAnkle],
  ];
  // 髋间距的规范值 = 2 × 0.03H；用骨盆-髋骨长换算 H
  anchors[2][1] = 2 * 0.03 * (boneLength('pelvis-neck') / 0.29);
  const anchor = anchors.find(([px, meters]) => px > 2 && meters > 0);
  if (!anchor) return null;
  const z0 = focal * anchor[1] / anchor[0];
  const joints = {};
  for (const name of Object.keys(jointPixels)) {
    const pixel = jointPixels[name];
    joints[name] = [(pixel.u - cx) * z0 / focal, (pixel.v - cy) * z0 / focal, z0];
  }
  // 估计算法：先给根种子（无髋时由颈沿躯干反推骨盆），再为其余缺失关节占位（随后按直链放置）
  const estimated = new Set();
  if (!joints.pelvis) {
    if (!joints.neck) return null; // 肩与髋都不可见：无锚点，如实跳过
    const torsoLength = boneLength('pelvis-neck');
    joints.pelvis = [joints.neck[0], joints.neck[1] + torsoLength, joints.neck[2]]; // y 向下：骨盆在颈下方
    estimated.add('pelvis');
  }
  for (const bone of bones) {
    for (const name of [bone.parent, bone.child]) {
      if (joints[name]) continue;
      joints[name] = joints[bone.parent] ? [...joints[bone.parent]] : null;
      estimated.add(name);
    }
  }
  for (const name of Object.keys(joints)) if (!joints[name]) return null; // 无法锚定（例如缺少全部肢体连接）
  refineSkeleton(joints, jointPixels, bones, {focal, cx, cy, iterations: 2000, learningRate: 0.9});
  placeEstimatedJoints(joints, estimated, bones);
  const observedCore = jointPixels.pelvis && jointPixels.neck;
  const provenance = observedCore && Object.keys(jointPixels).length >= 12 ? 'observed' : 'estimated';
  return {joints, jointPixels, estimated, provenance, focal, cx, cy};
}

/**
 * 连续动作：逐帧提升（部分姿态可解）→ 短缺口插值 → 深度平滑 → 骨长精化 →
 * 接触期根位移足端锁定 → 输出带 provenance 的帧与质量报告。
 * @param series [{frame, timeS, keypoints:[{x,y,v}×17]}]
 */
export function buildMotion(series, {width, height, bodyHeight = 1.75, focalPx, smoothingWindow = 5, contactThreshold = 0.05, speedThreshold = 0.08, refineIterations = 3000, learningRate = 0.9, maxGapSeconds = 0.2} = {}) {
  const bones = canonicalBones(bodyHeight);
  const lifted = [];
  for (const item of series) {
    const frame = liftFrame(item.keypoints, {width, height}, bones, {focalPx});
    lifted.push(frame ? {...item, ...frame} : null);
  }
  // 深度滑动平均（只平滑 z；随后重投影并精化骨长）。估计关节不参与平滑。
  if (smoothingWindow > 1) {
    const half = Math.floor(smoothingWindow / 2);
    const zHistory = lifted.map(item => item ? Object.fromEntries(Object.keys(item.jointPixels).map(name => [name, item.joints[name][2]])) : null);
    for (let index = 0; index < lifted.length; index++) {
      const item = lifted[index];
      if (!item) continue;
      for (const name of Object.keys(item.jointPixels)) {
        let sum = 0, count = 0;
        for (let offset = -half; offset <= half; offset++) {
          const value = zHistory[index + offset];
          if (value?.[name] !== undefined) {sum += value[name];count++;}
        }
        item.joints[name][2] = sum / count;
      }
      for (const name of Object.keys(item.jointPixels)) {
        if (name === 'pelvis') continue;
        const pixel = item.jointPixels[name];
        item.joints[name][0] = (pixel.u - item.cx) * item.joints[name][2] / item.focal;
        item.joints[name][1] = (pixel.v - item.cy) * item.joints[name][2] / item.focal;
      }
      refineSkeleton(item.joints, item.jointPixels, bones, {focal: item.focal, cx: item.cx, cy: item.cy, iterations: refineIterations, learningRate});
      placeEstimatedJoints(item.joints, item.estimated, bones);
    }
  }
  // 世界系归一：相机系 y 向下 → 输出 y 向上、地面 y=0、骨盆为水平原点；根位移保留。
  const firstLifted = lifted.find(Boolean);
  const rootOrigin = firstLifted ? firstLifted.joints.pelvis.slice(0, 3) : [0, 0, 0];
  const frames = [];
  let droppedFrames = 0;
  for (let index = 0; index < lifted.length; index++) {
    const item = lifted[index];
    if (!item) {frames.push(null);continue;}
    let worstDeviation = 0;
    for (const bone of bones) {
      const p = item.joints[bone.parent], c = item.joints[bone.child];
      const length = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      worstDeviation = Math.max(worstDeviation, Math.abs(length - bone.length) / bone.length);
    }
    if (worstDeviation > 0.001) {droppedFrames++;frames.push(null);continue;}
    const joints = structuredClone(item.joints);
    const pelvis = joints.pelvis;
    const rootOffset = [pelvis[0] - rootOrigin[0], 0, pelvis[2] - rootOrigin[2]];
    const groundY = Math.max(joints.ankleL[1], joints.ankleR[1]);
    for (const name of Object.keys(joints)) {
      joints[name] = [joints[name][0] - pelvis[0], groundY - joints[name][1], joints[name][2] - pelvis[2]];
    }
    rootOffset[1] = joints.pelvis[1]; // 骨盆离地高度
    const contacts = {};
    for (const foot of ['ankleL', 'ankleR']) {
      const nearGround = Math.abs(joints[foot][1]) < contactThreshold * bodyHeight;
      const slow = footSpeed(lifted, index, foot) < speedThreshold * bodyHeight;
      contacts[foot] = nearGround && slow;
    }
    frames.push({frame: item.frame, timeS: Number(item.timeS.toFixed(3)), contacts, rootOffset, joints,
      provenance: item.provenance, forward: null});
  }
  // 短缺口线性插值（≤ maxGapSeconds）；长缺口保持空洞（V2 §8.2：不无限复制最近姿态）
  let interpolatedFrames = 0;
  for (let index = 0; index < frames.length; index++) {
    if (frames[index]) continue;
    let before = index - 1;
    while (before >= 0 && !frames[before]) before--;
    let after = index + 1;
    while (after < frames.length && !frames[after]) after++;
    if (before < 0 || after >= frames.length) continue;
    const gapSeconds = frames[after].timeS - frames[before].timeS;
    if (gapSeconds > maxGapSeconds) continue;
    const ratio = (series[index].timeS - frames[before].timeS) / Math.max(1e-6, gapSeconds);
    const blend = (a, b) => a + (b - a) * ratio;
    const joints = {};
    for (const name of Object.keys(frames[before].joints)) {
      joints[name] = [0, 1, 2].map(dim => blend(frames[before].joints[name][dim], frames[after].joints[name][dim]));
    }
    frames[index] = {frame: series[index].frame, timeS: Number(series[index].timeS.toFixed(3)),
      contacts: {ankleL: false, ankleR: false}, rootOffset: [0, 1, 2].map(dim => blend(frames[before].rootOffset[dim], frames[after].rootOffset[dim])),
      joints, provenance: 'interpolated', forward: null};
    interpolatedFrames++;
  }
  // 根朝向：胸腔法线（仅观测帧；插值帧取邻帧插值）——不强制面朝相机（V2 §8.2）
  for (const frame of frames) {
    if (!frame || frame.provenance !== 'observed') continue;
    const right = [frame.joints.shoulderR[0] - frame.joints.shoulderL[0], frame.joints.shoulderR[1] - frame.joints.shoulderL[1], frame.joints.shoulderR[2] - frame.joints.shoulderL[2]];
    // 前向 = 上 × 右（角色左侧为 +X 时得到 +Z）
    const cross = [-right[2], 0, right[0]];
    const horizontal = [cross[0], cross[2]];
    const norm = Math.hypot(...horizontal);
    if (norm > 0.3) frame.forward = [Number((horizontal[0] / norm).toFixed(4)), Number((horizontal[1] / norm).toFixed(4))];
  }
  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    if (!frame || frame.provenance !== 'interpolated' || frame.forward) continue;
    let before = index - 1;
    while (before >= 0 && !(frames[before]?.forward)) before--;
    let after = index + 1;
    while (after < frames.length && !(frames[after]?.forward)) after++;
    const a = frames[before]?.forward, b = frames[after]?.forward;
    if (a && b) frame.forward = a;
    else if (a || b) frame.forward = a || b;
  }
  // 接触期足端锁定：根位移补偿（只移动整身，不改几何、不破坏骨长）
  let plantedRuns = 0;
  let footSlideBefore = 0, footSlideAfter = 0;
  for (const foot of ['ankleL', 'ankleR']) {
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        plantedRuns++;
        const world = index => [frames[index].rootOffset[0] + frames[index].joints[foot][0], frames[index].rootOffset[2] + frames[index].joints[foot][2]];
        const anchor = world(run[0]);
        let worstBefore = 0;
        for (const index of run) {
          const [x, z] = world(index);
          worstBefore = Math.max(worstBefore, Math.hypot(x - anchor[0], z - anchor[1]));
        }
        for (const index of run.slice(1)) {
          const [x, z] = world(index);
          frames[index].rootOffset[0] += anchor[0] - x;
          frames[index].rootOffset[2] += anchor[1] - z;
        }
        let worstAfter = 0;
        for (const index of run) {
          const [x, z] = world(index);
          worstAfter = Math.max(worstAfter, Math.hypot(x - anchor[0], z - anchor[1]));
        }
        footSlideBefore = Math.max(footSlideBefore, worstBefore);
        footSlideAfter = Math.max(footSlideAfter, worstAfter);
      }
      run = [];
    };
    for (let index = 0; index < frames.length; index++) {
      if (frames[index]?.contacts[foot]) run.push(index);
      else flush();
    }
    flush();
  }
  let maxDeviation = 0;
  for (const frame of frames) {
    if (!frame) continue;
    for (const bone of bones) {
      const p = frame.joints[bone.parent], c = frame.joints[bone.child];
      const length = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
      maxDeviation = Math.max(maxDeviation, Math.abs(length - bone.length) / bone.length);
    }
  }
  const solvedFrames = frames.filter(Boolean);
  return {
    bones,
    frames: frames.map(frame => frame && {
      frame: frame.frame, timeS: frame.timeS, contacts: frame.contacts, provenance: frame.provenance,
      ...(frame.forward ? {forward: frame.forward} : {}),
      rootOffset: frame.rootOffset.map(number => Number(number.toFixed(4))),
      joints: Object.fromEntries(Object.entries(frame.joints).map(([name, value]) => [name, value.map(number => Number(number.toFixed(5)))])),
    }),
    report: {
      frameCount: solvedFrames.length,
      spanFrames: frames.length,
      skippedFrames: frames.filter(frame => !frame).length,
      droppedFrames,
      observedFrames: solvedFrames.filter(frame => frame.provenance === 'observed').length,
      estimatedFrames: solvedFrames.filter(frame => frame.provenance === 'estimated').length,
      interpolatedFrames,
      coveragePct: frames.length ? Number((solvedFrames.length / frames.length * 100).toFixed(1)) : 0,
      maxBoneDeviationPct: Number((maxDeviation * 100).toFixed(6)),
      contactFramesLeft: solvedFrames.filter(frame => frame.contacts.ankleL).length,
      contactFramesRight: solvedFrames.filter(frame => frame.contacts.ankleR).length,
      plantedRuns,
      footSlideBeforePct: Number((footSlideBefore / bodyHeight * 100).toFixed(2)),
      footSlideAfterPct: Number((footSlideAfter / bodyHeight * 100).toFixed(2)),
      smoothingWindow,
      maxGapSeconds,
    },
  };
}

function footSpeed(lifted, index, foot) {
  const current = lifted[index], previous = lifted[index - 1];
  if (!current || !previous) return 0;
  const distance = Math.hypot(current.joints[foot][0] - previous.joints[foot][0], current.joints[foot][1] - previous.joints[foot][1]);
  const time = Math.max(1e-3, current.timeS - previous.timeS);
  return distance / time;
}