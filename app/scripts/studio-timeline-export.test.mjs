import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {prepareTimeline, buildTimelineRig} from '../studio/timeline-export.mjs';
import {sampleAt} from '../src/studio-timeline.ts';
import {canonicalBones} from '../studio/pose3d.mjs';

function fixture(level = 'CL2') {
  const character = {id: 'c-export', scale: 1.75, color: '#cc5533', proxyLevel: level, rigFamily: 'humanoid'};
  const detail = {project: {id: 'p-export', revision: 'r1'}, media: {durationUs: 1e6, width: 640, height: 360, fps: 24},
    shots: [{id: 'S01', startUs: 0, endUs: 1e6}], tracks: [{id: 't-export', shotId: 'S01', startUs: 0, endUs: 1e6, status: 'active', subject: 'person', box: {x: .2, y: .1, w: .2, h: .7}}],
    bindings: [{trackId: 't-export', characterId: character.id, disposition: 'bound'}], characters: [character], cameraTracks: [], motionRefs: {'t-export': 'motion.json'}};
  const frame = (index, timeS) => {
    const joints = {pelvis: [0, .95, 0]};
    for (const bone of canonicalBones(1.75)) {
      const direction = /hip|knee|ankle/.test(bone.child) ? [0, -1, 0] : bone.child.endsWith('L') ? [1, 0, 0] : bone.child.endsWith('R') ? [-1, 0, 0] : [0, 1, 0];
      joints[bone.child] = joints[bone.parent].map((n, i) => n + direction[i] * bone.length);
    }
    return {frame: index, timeS, joints, rootOffset: [index * .1, .95, 0], contacts: {ankleL: false, ankleR: false}};
  };
  const raw = {'t-export': {trackId: 't-export', shotId: 'S01', characterId: character.id, bodyHeight: 1.75, frames: [frame(0, 0), null, frame(5, .2)], sampleTimesS: [0, .1, .2]}};
  return {detail, character, raw};
}

test('export STEP tracks match the preview at null intervals and transition times instead of filling motion gaps', () => {
  const {detail, character, raw} = fixture();
  const timeline = prepareTimeline(detail, raw);
  assert(timeline.frames.some(frame => frame.ptsUs === 50_001), 'include valid-to-null boundary');
  assert(timeline.frames.some(frame => frame.ptsUs === 150_001), 'include null-to-valid boundary');
  const {group, clips} = buildTimelineRig(character, ['t-export'], timeline.frames);
  const mixer = new THREE.AnimationMixer(group);
  const action = mixer.clipAction(clips[0]);action.setLoop(THREE.LoopOnce, 1);action.clampWhenFinished = true;action.play();
  const root = group.getObjectByName('c-export__root');
  for (const timeS of [0, .04, .06, .1, .14, .16, .2, .44, .46, .9]) {
    mixer.setTime(timeS);group.updateMatrixWorld(true);
    const expected = sampleAt(detail, timeline.motions, Math.round(timeS * 1e6)).instances[0];
    assert(root.position.distanceTo(new THREE.Vector3(...expected.pose.rootPosition)) < 1e-5, `pose parity at ${timeS}`);
    if ([.1, .46, .9].includes(timeS)) assert.equal(expected.quality, 'placeholder');
  }
  group.traverse(object => {if (object.isMesh) {object.geometry.dispose();object.material.dispose();}});
});

test('each saved CL produces its distinct shared preview geometry in exported assets', () => {
  const counts = [];
  for (const level of ['CL0', 'CL1', 'CL2']) {
    const {detail, character, raw} = fixture(level);
    const timeline = prepareTimeline(detail, raw);
    const {group} = buildTimelineRig(character, ['t-export'], timeline.frames);
    assert.equal(group.userData.proxyLevel, level);
    const mesh = group.children.find(child => child.isSkinnedMesh);
    assert.equal(mesh.skeleton.bones.length, 22);
    counts.push(mesh.geometry.attributes.position.count);
    assert.equal(mesh.geometry.attributes.skinWeight.count, mesh.geometry.attributes.position.count);
    mesh.geometry.dispose();mesh.material.dispose();
  }
  assert.equal(new Set(counts).size, 3);
});
