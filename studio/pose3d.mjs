// 三维动作求解（M4 关键姿态 / M5 连续动作）。
// 单目视频无法唯一确定深度：本模块按“固定骨长 + 地面接触 + 时间平滑”生成
// 可审查的近似还原（计划 §5）；骨长偏差由骨架精化收敛保证（A6 的 ≤0.1% 门槛）。
// 输入为归一化 2D 关键点（COCO 17）序列；输出为角色局部坐标系（米，y 向上，地面 y=0）。
// 深度未知度：每个关节一个 z（重投影决定 x,y）；骨盆是自由根（x,y,z 全自由），
// 因此 15 个自由度 ≥ 14 条骨长约束，骨长可精确满足。

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

/**
 * 把关节集合精化到全部骨长精确满足：
 * 非骨盆关节的 3D 位置被像素射线唯一参数化：p = z·k（k = ((u−cx)/f,(v−cy)/f,1)），
 * 唯一自由度是 z；骨盆是自由根（3 自由）。梯度按此精确计算。
 * @returns joints（原地修改）
 */
export function refineSkeleton(joints, jointPixels, bones, {focal, cx, cy, iterations = 1200, learningRate = 0.9} = {}) {
  const rayK = {};
  for (const name of Object.keys(jointPixels)) {
    if (name === 'pelvis') continue;
    const pixel = jointPixels[name];
    rayK[name] = [(pixel.u - cx) / focal, (pixel.v - cy) / focal, 1];
  }
  const project = name => {
    const factor = rayK[name];
    if (!factor) return; // pelvis 自由
    const z = joints[name][2];
    joints[name] = [factor[0] * z, factor[1] * z, z];
  };
  for (const name of Object.keys(joints)) project(name);
  for (let iteration = 0; iteration < iterations; iteration++) {
    let totalError = 0;
    for (const bone of bones) {
      const p = joints[bone.parent], c = joints[bone.child];
      const d = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      const length = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
      if (!(length > 1e-9)) continue;
      const error = length - bone.length;
      totalError += Math.abs(error);
      const lr = learningRate;
      const kp = rayK[bone.parent], kc = rayK[bone.child];
      if (kp) {
        const gradient = -(d[0] * kp[0] + d[1] * kp[1] + d[2] * kp[2]) / length; // ∂l/∂z_p
        joints[bone.parent][2] = Math.max(1e-3, joints[bone.parent][2] - lr * error * gradient);
        project(bone.parent);
      } else {
        for (let dim = 0; dim < 3; dim++) joints[bone.parent][dim] += lr * error * d[dim] / length;
      }
      if (kc) {
        const gradient = (d[0] * kc[0] + d[1] * kc[1] + d[2] * kc[2]) / length; // ∂l/∂z_c
        joints[bone.child][2] = Math.max(1e-3, joints[bone.child][2] - lr * error * gradient);
        project(bone.child);
      }
    }
    if (totalError < 1e-9) break;
  }
  return joints;
}

/**
 * 单帧 2D 关键点 → 固定骨长 3D 关节（相机坐标系，z 为深度）。
 */
export function liftFrame(keypoints2D, {width, height}, bones, {focalPx} = {}) {
  const focal = focalPx || 1.2 * Math.max(width, height);
  const cx = width / 2, cy = height / 2;
  const pixels = {};
  let visibleCount = 0;
  for (let index = 0; index < 17; index++) {
    const point = keypoints2D?.[index];
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.v >= VISIBLE) {
      pixels[index] = {u: point.x * width, v: point.y * height};
      visibleCount++;
    }
  }
  if (Array.from({length: 12}, (_, i) => i + 5).some(index => !pixels[index]) || (!pixels[0] && (!pixels[1] || !pixels[2]))) return null;
  const mid = (a, b) => ({u: (pixels[a].u + pixels[b].u) / 2, v: (pixels[a].v + pixels[b].v) / 2});
  const jointPixels = {
    head: pixels[0] || mid(1, 2), neck: mid(5, 6),
    shoulderL: pixels[5], shoulderR: pixels[6], elbowL: pixels[7], elbowR: pixels[8],
    wristL: pixels[9], wristR: pixels[10],
    pelvis: mid(11, 12), hipL: pixels[11], hipR: pixels[12],
    kneeL: pixels[13], kneeR: pixels[14], ankleL: pixels[15], ankleR: pixels[16],
  };
  const torsoBone = bones.find(bone => bone.name === 'pelvis-neck');
  const torsoPx = Math.hypot(jointPixels.neck.u - jointPixels.pelvis.u, jointPixels.neck.v - jointPixels.pelvis.v);
  if (!(torsoPx > 2)) return null;
  const z0 = focal * torsoBone.length / torsoPx;
  const joints = {};
  for (const name of Object.keys(jointPixels)) {
    const pixel = jointPixels[name];
    joints[name] = [(pixel.u - cx) * z0 / focal, (pixel.v - cy) * z0 / focal, z0];
  }
  refineSkeleton(joints, jointPixels, bones, {focal, cx, cy, iterations: 2000, learningRate: 0.9});
  return {joints, jointPixels, focal, cx, cy};
}

/**
 * 连续动作：逐帧提升 → 深度时间平滑（平滑后重投影+精化）→ 落地接触锁定。
 * @param series [{frame, timeS, keypoints:[{x,y,v}×17]}]
 */
export function buildMotion(series, {width, height, bodyHeight = 1.75, focalPx, smoothingWindow = 5, contactThreshold = 0.05, speedThreshold = 0.08, refineIterations = 3000, learningRate = 0.9} = {}) {
  const bones = canonicalBones(bodyHeight);
  const lifted = [];
  for (const item of series) {
    const frame = liftFrame(item.keypoints, {width, height}, bones, {focalPx});
    lifted.push(frame ? {...item, ...frame} : null);
  }
  // 深度滑动平均（只平滑非骨盆 z；随后重投影并精化骨长）
  if (smoothingWindow > 1) {
    const half = Math.floor(smoothingWindow / 2);
    const zHistory = lifted.map(item => item ? Object.fromEntries(Object.keys(item.joints).map(name => [name, item.joints[name][2]])) : null);
    for (let index = 0; index < lifted.length; index++) {
      const item = lifted[index];
      if (!item) continue;
      for (const name of Object.keys(item.joints)) {
        let sum = 0, count = 0;
        for (let offset = -half; offset <= half; offset++) {
          const value = zHistory[index + offset];
          if (value?.[name] !== undefined) {sum += value[name];count++;}
        }
        item.joints[name][2] = sum / count;
      }
      for (const name of Object.keys(item.joints)) {
        if (name === 'pelvis') continue;
        const pixel = item.jointPixels[name];
        item.joints[name][0] = (pixel.u - item.cx) * item.joints[name][2] / item.focal;
        item.joints[name][1] = (pixel.v - item.cy) * item.joints[name][2] / item.focal;
      }
      refineSkeleton(item.joints, item.jointPixels, bones, {focal: item.focal, cx: item.cx, cy: item.cy, iterations: refineIterations, learningRate});
    }
  }
  // 世界系归一：相机系 y 向下 → 输出 y 向上、地面 y=0、骨盆为水平原点；根位移保留。
  // 无法满足固定骨长（≤0.1%）的帧如实剔除并计入报告，不以坏帧冒充结果。
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
      // 接触只作为标注输出，不直接改几何（改 y 会破坏骨长；接触确认留给人工，见 A6）
      contacts[foot] = nearGround && slow;
    }
    frames.push({frame: item.frame, timeS: Number(item.timeS.toFixed(3)), contacts, rootOffset, joints});
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
  return {
    bones,
    frames: frames.map(frame => frame && {
      frame: frame.frame, timeS: frame.timeS, contacts: frame.contacts,
      rootOffset: frame.rootOffset.map(number => Number(number.toFixed(4))),
      joints: Object.fromEntries(Object.entries(frame.joints).map(([name, value]) => [name, value.map(number => Number(number.toFixed(5)))])),
    }),
    report: {
      frameCount: frames.filter(Boolean).length,
      skippedFrames: frames.filter(frame => !frame).length,
      droppedFrames,
      maxBoneDeviationPct: Number((maxDeviation * 100).toFixed(6)),
      contactFramesLeft: frames.filter(frame => frame?.contacts.ankleL).length,
      contactFramesRight: frames.filter(frame => frame?.contacts.ankleR).length,
      smoothingWindow,
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
