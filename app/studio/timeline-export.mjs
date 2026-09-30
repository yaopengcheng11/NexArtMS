import * as THREE from 'three';
import {createRigidCharacter, RIG_JOINTS} from '../src/rig.ts';
import {sampleAt} from '../src/studio-timeline.ts';
import {tagMotion} from '../src/studio-motion-cache.ts';

// Export at source presentation times and all state transitions. STEP animation
// preserves the preview's missing-data/nearest-frame policy instead of inventing
// an interpolated action across an unsolved interval.
export function timelineSampleTimes(detail, motions, sourcePts = []) {
  const end = detail.media?.durationUs ?? detail.shots.at(-1)?.endUs ?? 0;
  const times = new Set([0]);
  const add = t => {if (Number.isFinite(t) && t >= 0 && t < end) times.add(Math.round(t));};
  if (sourcePts.length) sourcePts.forEach(t => add(t * 1e6));
  else {
    const fps = detail.media?.fps || 24;
    for (let frame = 0; frame / fps * 1e6 < end; frame++) add(frame / fps * 1e6);
  }
  for (const shot of detail.shots) {add(shot.startUs);add(shot.endUs);}
  for (const track of detail.tracks) {add(track.startUs);add(track.endUs - 1);add(track.endUs);}
  for (const motion of Object.values(motions)) {
    const sampleTimes = motion.frames.map((frame, index) => motion.sampleTimesS?.[index] ?? frame?.timeS).filter(Number.isFinite).sort((a, b) => a - b);
    sampleTimes.forEach((timeS, index) => {
      const us = Math.round(timeS * 1e6);
      add(us);add(us - 250_000);add(us + 250_001);
      if (index) add(Math.floor((timeS + sampleTimes[index - 1]) * 500_000) + 1);
    });
  }
  return [...times].sort((a, b) => a - b);
}

export function prepareTimeline(detail, rawMotions, sourcePts = []) {
  const motions = Object.fromEntries(Object.entries(rawMotions).map(([id, motion]) => [id, tagMotion(detail, id, motion)]));
  const times = timelineSampleTimes(detail, motions, sourcePts);
  return {motions, frames: times.map(ptsUs => ({ptsUs, ...sampleAt(detail, motions, ptsUs)}))};
}

export function buildTimelineRig(character, trackIds, frames) {
  const level = character.proxyLevel || character.proxy_level || 'CL1';
  const rig = createRigidCharacter({id: character.id, height: character.scale, color: Number.parseInt(character.color.slice(1), 16), level});
  const mesh = rig.toSkinnedMesh();
  const group = new THREE.Group();
  group.name = character.id;
  group.userData = {rig: 'timeline-rigid-proxy-v3', characterId: character.id, proxyLevel: level, rigFamily: 'humanoid', sampling: 'source-pts-and-transitions-step'};
  group.add(mesh);
  const clips = [];
  for (const trackId of trackIds) {
    const samples = frames.flatMap(frame => {
      const instance = frame.instances.find(item => item.trackId === trackId && item.visible && item.pose);
      return instance ? [{ptsUs: frame.ptsUs, instance}] : [];
    });
    if (!samples.length) continue;
    const startUs = samples[0].ptsUs;
    const times = samples.map(sample => (sample.ptsUs - startUs) / 1e6);
    const tracks = [new THREE.VectorKeyframeTrack(`${rig.bones.root.name}.position`, times,
      samples.flatMap(sample => sample.instance.pose.rootPosition || [0, 0, 0]), THREE.InterpolateDiscrete)];
    for (const joint of RIG_JOINTS) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${rig.bones[joint.id].name}.quaternion`, times,
        samples.flatMap(sample => sample.instance.pose.rotations?.[joint.id] || [0, 0, 0, 1]), THREE.InterpolateDiscrete));
    }
    const clip = new THREE.AnimationClip(`motion-${trackId}`, times.at(-1), tracks);
    // glTF animations do not encode clip placement in the edit; the manifest and
    // timeline retain the absolute start plus explicit quality/visibility states.
    clips.push(clip);
  }
  rig.dispose();
  return {group, clips};
}
