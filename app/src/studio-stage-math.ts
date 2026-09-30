import * as THREE from 'three';
import {RIG_JOINTS, type CharacterPose, type QuaternionTuple, type Vec3Tuple} from './rig';

// 三维确认视图的数学：动作 JSON → 刚性角色姿态；相机轨迹 → Three.js 相机；
// 人物框 + 相机 → 地面落点。单目尺度耦合无法消除，输出仅用于审查（界面必须标注）。

export interface MotionFrame {
  frame: number;
  timeS: number;
  contacts: {ankleL: boolean; ankleR: boolean};
  provenance?: 'observed' | 'estimated' | 'interpolated';
  forward?: [number, number];
  rootOffset: [number, number, number];
  joints: Record<string, [number, number, number]>;
}
export interface MotionData {
  /** Client cache identity; never inferred from trackId alone. */
  artifactKey?: string;
  sampleTimesS?: number[];
  trackId: string;
  shotId: string;
  characterId: string;
  characterName?: string;
  bodyHeight: number;
  frames: (MotionFrame | null)[];
}

// 骨架骨骼 → 动作关节方向（from→to）。未列出的骨骼保持相对父级不动。
const BONE_TO_JOINTS: Record<string, [string, string]> = {
  pelvis: ['pelvis', 'neck'],
  spine: ['pelvis', 'neck'],
  chest: ['pelvis', 'neck'],
  neck: ['neck', 'head'],
  shoulder_L: ['neck', 'shoulderL'],
  upperArm_L: ['shoulderL', 'elbowL'],
  forearm_L: ['elbowL', 'wristL'],
  shoulder_R: ['neck', 'shoulderR'],
  upperArm_R: ['shoulderR', 'elbowR'],
  forearm_R: ['elbowR', 'wristR'],
  thigh_L: ['hipL', 'kneeL'],
  shin_L: ['kneeL', 'ankleL'],
  thigh_R: ['hipR', 'kneeR'],
  shin_R: ['kneeR', 'ankleR'],
};

const AIM_CHILD: Record<string, string> = {
  pelvis: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
  shoulder_L: 'upperArm_L', upperArm_L: 'forearm_L', forearm_L: 'hand_L',
  shoulder_R: 'upperArm_R', upperArm_R: 'forearm_R', forearm_R: 'hand_R',
  thigh_L: 'shin_L', shin_L: 'foot_L', thigh_R: 'shin_R', shin_R: 'foot_R',
};
const REST_DIRS: Record<string, Vec3Tuple> = Object.fromEntries(
  Object.entries(AIM_CHILD).map(([id, child]) => {
    // A bone rotates its outgoing segment, not its offset from the parent.
    const [x, y, z] = RIG_JOINTS.find(joint => joint.id === child)!.offset;
    const length = Math.hypot(x, y, z) || 1;
    return [id, [x / length, y / length, z / length] as Vec3Tuple];
  }),
);

export interface StagedPose extends CharacterPose {
  frame: number;
  timeS: number;
  contacts: {ankleL: boolean; ankleR: boolean};
}

/**
 * 由动作帧构造角色姿态。joints 以骨盆为原点、y 向上、地面 y=0（见 studio/pose3d.mjs）。
 * @param faceXZ 期望朝向的世界点（角色绕 Y 旋转面向它）；缺省面向 +Z
 * @param groundXZ 角色的地面落点；缺省用动作自身的 rootOffset 水平漂移
 */
export function poseFromMotion(
  motion: MotionData,
  targetFrame: number,
  height: number,
  {faceXZ, groundXZ}: {faceXZ?: [number, number]; groundXZ?: [number, number]} = {},
): StagedPose | null {
  let best: MotionFrame | null = null;
  let bestDistance = Infinity;
  for (const frame of motion.frames) {
    if (!frame) continue;
    const distance = Math.abs(frame.frame - targetFrame);
    if (distance < bestDistance) {bestDistance = distance;best = frame;}
  }
  if (!best) return null;
  // P6：动作帧带胸腔法线朝向时直接使用（保留转身/背身）；否则回退为面向给定点
  const forward = (best as {forward?: [number, number]}).forward;
  const yaw = forward ? Math.atan2(forward[0], forward[1])
    : faceXZ ? Math.atan2(faceXZ[0] - (groundXZ?.[0] ?? best.rootOffset[0]), faceXZ[1] - (groundXZ?.[1] ?? best.rootOffset[2])) : 0;
  // 自顶向下求各骨骼父空间四元数：世界方向（已绕 Y 偏转 yaw）← rest 方向。
  const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const worldQuats = new Map<string, THREE.Quaternion>([['root', yawQuat]]);
  const rotations: Record<string, QuaternionTuple> = {root: yawQuat.toArray() as QuaternionTuple};
  for (const joint of RIG_JOINTS) {
    if (!joint.parent) continue;
    const mapping = BONE_TO_JOINTS[joint.id];
    const rest = REST_DIRS[joint.id];
    let world = worldQuats.get(joint.parent)!.clone();
    if (mapping) {
      const from = best.joints[mapping[0]], to = best.joints[mapping[1]];
      if (from && to) {
        const direction: Vec3Tuple = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        if (Math.hypot(direction[0], direction[1], direction[2]) > 1e-6) {
          const worldDir = new THREE.Vector3(...direction).normalize();
          world = yawQuat.clone().multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...rest), worldDir));
        }
      }
    }
    worldQuats.set(joint.id, world);
    const parentWorld = worldQuats.get(joint.parent)!;
    const local = parentWorld.clone().invert().multiply(world);
    rotations[joint.id] = local.toArray() as QuaternionTuple;
  }
  const ground = groundXZ ?? [best.rootOffset[0], best.rootOffset[2]];
  // rig 的骨盆 rest 高度是 0.53×身高；把根放在骨盆目标高度之下。
  const rootPosition: Vec3Tuple = [ground[0], best.rootOffset[1] - 0.53 * height, ground[1]];
  return {rootPosition, rotations, frame: best.frame, timeS: best.timeS, contacts: best.contacts};
}

/** 无动作时的站立姿态（T Pose 站在落点上）。 */
export function standingPose(height: number, groundXZ: [number, number] = [0, 0], faceXZ?: [number, number]): CharacterPose {
  const yaw = faceXZ ? Math.atan2(faceXZ[0] - groundXZ[0], faceXZ[1] - groundXZ[1]) : 0;
  const rotations: Record<string, QuaternionTuple> = {};
  for (const joint of RIG_JOINTS) rotations[joint.id] = yaw && joint.id === 'root' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).toArray() as QuaternionTuple : [0, 0, 0, 1];
  return {rootPosition: [groundXZ[0], 0, groundXZ[1]], rotations};
}

// ---- 相机轨迹 → Three.js 相机 ----
// world→camera 的 R（行主序 3×3）与平移 t；相机系 x 右、y 向下、z 向前。

export interface TrackLike {
  source: string;
  intrinsics: {fx?: number; fy?: number; cx?: number; cy?: number; width?: number; height?: number};
  extrinsics: {rotation: number[] | null; translation: number[] | null};
}
export interface CameraView {
  position: Vec3Tuple;
  target: Vec3Tuple;
  up: Vec3Tuple;
  fov: number;
}

export function usableCamera(cam: TrackLike | null | undefined): cam is TrackLike & {extrinsics: {rotation: number[]; translation: number[]}} {
  return !!cam && Array.isArray(cam.extrinsics?.rotation) && cam.extrinsics.rotation.length === 9
    && Array.isArray(cam.extrinsics?.translation) && cam.extrinsics.translation.length === 3;
}

export function cameraViewFromTrack(cam: TrackLike | null | undefined, {fallbackFov = 55, distance = 10} = {}): CameraView | null {
  if (!usableCamera(cam)) return null;
  const R = cam.extrinsics.rotation, t = cam.extrinsics.translation;
  const applyRT = (v: [number, number, number]): Vec3Tuple => [
    R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
    R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
    R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
  ];
  const position = [-t[0] * R[0] - t[1] * R[3] - t[2] * R[6],
    -t[0] * R[1] - t[1] * R[4] - t[2] * R[7],
    -t[0] * R[2] - t[1] * R[5] - t[2] * R[8]] as Vec3Tuple;
  const forward = applyRT([0, 0, 1]);
  const up = applyRT([0, -1, 0]);
  const fy = cam.intrinsics.fy ?? 0;
  const frameHeight = cam.intrinsics.height ?? 0;
  const fov = fy > 0 && frameHeight > 0 ? 2 * Math.atan(frameHeight / 2 / fy) * 180 / Math.PI : fallbackFov;
  return {
    position,
    target: [position[0] + forward[0] * distance, position[1] + forward[1] * distance, position[2] + forward[2] * distance],
    up, fov: Math.max(5, Math.min(130, fov)),
  };
}

/** 人物框底边中心经相机射线投到地面 y=0（单目估计，仅供审查）。 */
export function groundPointFromBox(cam: TrackLike | null | undefined, box: {x: number; y: number; w: number; h: number}, imageWidth: number, imageHeight: number): Vec3Tuple | null {
  if (!usableCamera(cam)) return null;
  const {fx = 0, fy = 0, cx = 0, cy = 0} = cam.intrinsics;
  if (!(fx > 0 && fy > 0)) return null;
  const R = cam.extrinsics.rotation, t = cam.extrinsics.translation;
  const dCam: [number, number, number] = [((box.x + box.w / 2) * imageWidth - cx) / fx, ((box.y + box.h) * imageHeight - cy) / fy, 1];
  const dWorld: Vec3Tuple = [
    R[0] * dCam[0] + R[3] * dCam[1] + R[6] * dCam[2],
    R[1] * dCam[0] + R[4] * dCam[1] + R[7] * dCam[2],
    R[2] * dCam[0] + R[5] * dCam[1] + R[8] * dCam[2],
  ];
  if (dWorld[1] >= -1e-6) return null;
  // 相机中心 C = -Rᵀ·t；射线 C + s·dWorld 与地面 y=0 相交。
  const cy0 = -(R[1] * t[0] + R[4] * t[1] + R[7] * t[2]);
  const scale = -cy0 / dWorld[1];
  if (!(scale > 0)) return null;
  const px = -(R[0] * t[0] + R[3] * t[1] + R[6] * t[2]) + scale * dWorld[0];
  const py = cy0 + scale * dWorld[1];
  const pz = -(R[2] * t[0] + R[5] * t[1] + R[8] * t[2]) + scale * dWorld[2];
  if (!Number.isFinite(px) || !Number.isFinite(pz) || Math.abs(py) > 1e-3) return null;
  if (Math.hypot(px, pz) > 500) return null; // 数值发散保护
  return [px, 0, pz];
}
