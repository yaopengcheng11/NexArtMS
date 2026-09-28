import {poseFromMotion, standingPose, cameraViewFromTrack, groundPointFromBox, usableCamera, type CameraView, type StagedPose, type MotionData} from './studio-stage-math';
import {currentMotion} from './studio-motion-cache';
import {isValidMotionFrame} from '../studio/motion-validation.mjs';
import type {CameraTrackInfo, ProjectDetail, ShotInfo, TrackInfo} from './studio';

// 统一时间采样器（V2 §8.3）：给定项目状态、动作产物与 ptsUs，
// 返回该时刻的镜头、相机与逐实例状态。播放、seek 与导出共用同一实现。
// 半开区间 [startUs, endUs)；末镜末帧用闭区间收尾。

export interface CharacterConfig {
  id: string;
  name: string;
  color: string;
  scale: number;
  proxyLevel: 'CL0' | 'CL1' | 'CL2';
  rigFamily: string;
}

export interface SampledInstance {
  trackId: string;
  character: CharacterConfig;
  visible: boolean;
  pose: StagedPose | null;
  quality: 'solved' | 'placeholder';
  /** V2 §6.2 逐帧来源：observed/estimated/interpolated；占位实例为 null */
  provenance: 'observed' | 'estimated' | 'interpolated' | null;
  nearestFrameDeltaMs: number;
}

export interface SampledFrame {
  shot: ShotInfo | null;
  index: number;
  camera: {position: [number, number, number]; target: [number, number, number]; up: [number, number, number]; fov: number} | null;
  cameraNote: string;
  cameraIsEstimate: boolean;
  instances: SampledInstance[];
}

/** A fixed fallback is part of the timeline, independent of the previously viewed shot. */
export function defaultCameraView(): CameraView {
  return {position: [0, 1.8, 6], target: [0, 0.9, 0], up: [0, 1, 0], fov: 40};
}

/** A deterministic per-appearance anchor; motion.rootOffset only carries local displacement. */
export function initialGroundPoint(detail: ProjectDetail, track: TrackInfo, height: number, camera?: CameraTrackInfo): [number, number] {
  const width = detail.media?.width || 1280, imageHeight = detail.media?.height || 720;
  const solved = groundPointFromBox(camera, track.box, width, imageHeight);
  if (solved) return [solved[0], solved[2]];
  const view = defaultCameraView();
  const halfFov = Math.tan(view.fov * Math.PI / 360);
  const distance = Math.max(2, Math.min(50, height / (2 * halfFov * Math.max(0.03, track.box.h))));
  return [(track.box.x + track.box.w / 2 - 0.5) * 2 * distance * halfFov * width / imageHeight, view.position[2] - distance];
}

export function motionFrameAt(motion: MotionData, timeS: number) {
  let index = -1, delta = Infinity;
  for (let i = 0; i < motion.frames.length; i++) {
    const sampleTime = motion.sampleTimesS?.[i] ?? motion.frames[i]?.timeS;
    if (sampleTime === undefined || !Number.isFinite(sampleTime)) continue;
    const distance = Math.abs(sampleTime - timeS);
    if (distance < delta) {index = i;delta = distance;}
  }
  const frame = index >= 0 && delta <= 0.25 ? motion.frames[index] : null;
  return {frame: isValidMotionFrame(frame) ? frame : null, deltaMs: delta * 1000};
}

export function shotAt(shots: ShotInfo[], ptsUs: number): {shot: ShotInfo | null; index: number} {
  for (let index = 0; index < shots.length; index++) {
    const shot = shots[index];
    const last = index === shots.length - 1;
    if (ptsUs >= shot.startUs && (ptsUs < shot.endUs || (last && ptsUs <= shot.endUs))) return {shot, index};
  }
  return {shot: null, index: -1};
}

function characterOf(detail: ProjectDetail, track: TrackInfo): CharacterConfig | null {
  const binding = detail.bindings.find(row => row.trackId === track.id);
  if (binding?.disposition !== 'bound' || !binding.characterId) return null;
  const character = detail.characters.find(row => row.id === binding.characterId);
  if (!character) return null;
  return {id: character.id, name: character.name, color: character.color, scale: character.scale,
    proxyLevel: character.proxyLevel || 'CL1', rigFamily: character.rigFamily || 'humanoid'};
}

/** 采样一个时刻。无动作产物的已绑定出场以站立占位表达（quality=placeholder，不计为已求解）。 */
function dollyViewAt(samples: Array<{timeS: number; position: [number, number, number]; target: [number, number, number]}>, timeS: number, fov: number) {
  let best = samples[0], bestDelta = Infinity, next: (typeof best) | undefined;
  for (let index = 0; index < samples.length; index++) {
    const delta = Math.abs(samples[index].timeS - timeS);
    if (delta < bestDelta) {bestDelta = delta;best = samples[index];next = samples[index + 1];}
  }
  const ratio = next ? Math.max(0, Math.min(1, (timeS - best.timeS) / Math.max(1e-6, next.timeS - best.timeS))) : 0;
  const lerp3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [0, 1, 2].map(dim => a[dim] + (b[dim] - a[dim]) * ratio) as [number, number, number];
  return {position: lerp3(best.position, next?.position ?? best.position), target: lerp3(best.target, next?.target ?? best.target), up: [0, 1, 0] as [number, number, number], fov};
}

export function sampleAt(detail: ProjectDetail, motions: Record<string, MotionData>, ptsUs: number): SampledFrame {
  const {shot, index} = shotAt(detail.shots, ptsUs);
  if (!shot) return {shot: null, index: -1, camera: defaultCameraView(), cameraNote: '时间超出镜头范围', cameraIsEstimate: true, instances: []};
  const timeS = ptsUs / 1e6;
  const camera = detail.cameraTracks.filter(item => item.shotId === shot.id).sort((a, b) => b.confidence - a.confidence)[0];
  const cameraUsable = usableCamera(camera ?? null);
  const cameraView = (cameraUsable ? cameraViewFromTrack(camera!) : null) || defaultCameraView();
  // P6-e：无外参解时回退到人物尺度运镜样本（推拉）
  const dollySamples = (camera?.extrinsics as {samples?: Array<{timeS: number; position: [number, number, number]; target: [number, number, number]}>} | undefined)?.samples;
  const dollyView = !cameraUsable && Array.isArray(dollySamples) && dollySamples.length >= 1
    ? dollyViewAt(dollySamples, timeS, (camera?.intrinsics as {fovDegrees?: number})?.fovDegrees ?? 55)
    : null;
  const activeView = dollyView ?? cameraView;
  const instances: SampledInstance[] = [];
  for (const track of detail.tracks) {
    if (track.status !== 'active' || track.shotId !== shot.id || track.subject === 'animal') continue;
    const character = characterOf(detail, track);
    if (!character) continue;
    const visible = ptsUs >= track.startUs && ptsUs < track.endUs;
    const motion = currentMotion(detail, track.id, motions[track.id]);
    const anchor = initialGroundPoint(detail, track, character.scale, camera);
    let pose: StagedPose | null = null;
    let quality: 'solved' | 'placeholder' = 'placeholder';
    let provenance: 'observed' | 'estimated' | 'interpolated' | null = null;
    let nearestFrameDeltaMs = Number.NaN;
    if (motion?.frames?.length) {
      const {frame: best, deltaMs} = motionFrameAt(motion, timeS);
      nearestFrameDeltaMs = Math.round(deltaMs);
      if (best) {
        pose = poseFromMotion(motion, best.frame, character.scale, {
          groundXZ: [anchor[0] + best.rootOffset[0], anchor[1] + best.rootOffset[2]],
          faceXZ: [(dollyView ?? cameraView).position[0], (dollyView ?? cameraView).position[2]],
        });
        if (pose) {
          quality = 'solved';
          provenance = (best as {provenance?: 'observed' | 'estimated' | 'interpolated'}).provenance || 'observed';
        }
      }
    }
    if (!pose) {
      const standing = standingPose(character.scale, anchor, [cameraView.position[0], cameraView.position[2]]);
      pose = {...standing, frame: -1, timeS, contacts: {ankleL: false, ankleR: false}};
    }
    instances.push({trackId: track.id, character, visible, pose, quality, provenance, nearestFrameDeltaMs});
  }
  return {
    shot,
    index,
    camera: activeView,
    cameraIsEstimate: !cameraUsable,
    cameraNote: camera
      ? cameraUsable
        ? `${camera.source === 'landmark-pnp' ? '地标 PnP' : '估计解'}${camera.needsManualReview ? ' · 待人工确认' : ''}`
        : dollyView ? '运镜估计（人物尺度推拉 · 待人工确认）' : '默认相机占位（只有距离估计）'
      : '默认相机占位（未求解）',
    instances,
  };
}
