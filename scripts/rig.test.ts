import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRigidCharacter, RIG_JOINTS, type CharacterLevel, type QuaternionTuple } from '../src/rig.ts';

const quat = (axis: THREE.Vector3, angle: number) => new THREE.Quaternion().setFromAxisAngle(axis, angle).toArray() as QuaternionTuple;
const close = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);
const world = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());

test('22 semantic joints form the specified hierarchy, T Pose has a ground baseline and fixed rest offsets', () => {
  const rig = createRigidCharacter({ height: 1.8 });
  assert.equal(Object.keys(rig.bones).length, 22);
  for (const joint of RIG_JOINTS) {
    const bone = rig.bones[joint.id];
    assert.equal(bone.isBone, true);
    assert.equal(bone.parent, joint.parent ? rig.bones[joint.parent] : rig.group);
    close(bone.position.length(), new THREE.Vector3(...joint.offset).length() * 1.8);
  }
  const foot = rig.looks.CL2.find(part => part.name.endsWith('__foot_L'))!;
  const box = new THREE.Box3().setFromObject(foot);
  close(box.min.y, 0, 1e-7);
  const head = new THREE.Box3().setFromObject(rig.looks.CL2[0]);
  close(head.max.y, 1.8, 1e-7);
  rig.dispose();
});

test('poses preserve every constrained bone length over 120 distinct articulated frames', () => {
  const rig = createRigidCharacter();
  let maxError = 0;
  for (let frame = 0; frame < 120; frame++) {
    const rotations: Record<string, QuaternionTuple> = {};
    for (let index = 0; index < RIG_JOINTS.length; index++) {
      rotations[RIG_JOINTS[index].id] = quat(new THREE.Vector3(1, 2, 3).normalize(), Math.sin(frame * .03 + index) * 1.4);
    }
    rig.applyPose({ rootPosition: [frame * .01, Math.sin(frame * .04), -.2], rotations });
    for (const joint of RIG_JOINTS) {
      if (!joint.parent) continue;
      const length = world(rig.bones[joint.id]).distanceTo(world(rig.bones[joint.parent]));
      const rest = new THREE.Vector3(...joint.offset).length() * rig.height;
      maxError = Math.max(maxError, Math.abs(length - rest) / rig.height);
      assert.deepEqual(rig.bones[joint.id].scale.toArray(), [1, 1, 1]);
    }
  }
  assert.ok(maxError < 1e-12, `relative bone error ${maxError}`);
  rig.dispose();
});

test('shoulder moves the full arm, elbow moves only descendants and retains segment length', () => {
  const rig = createRigidCharacter();
  const elbow0 = world(rig.bones.forearm_L);
  const hand0 = world(rig.bones.hand_L);
  const opposite0 = world(rig.bones.hand_R);
  rig.applyPose({ rotations: { shoulder_L: quat(new THREE.Vector3(0, 0, 1), Math.PI / 4) } });
  assert.ok(world(rig.bones.forearm_L).distanceTo(elbow0) > .1);
  assert.ok(world(rig.bones.hand_L).distanceTo(hand0) > .1);
  close(world(rig.bones.hand_R).distanceTo(opposite0), 0);
  const elbow1 = world(rig.bones.forearm_L);
  const hand1 = world(rig.bones.hand_L);
  rig.applyPose({ rotations: { forearm_L: quat(new THREE.Vector3(0, 1, 0), Math.PI / 2) } });
  close(world(rig.bones.forearm_L).distanceTo(elbow1), 0);
  assert.ok(world(rig.bones.hand_L).distanceTo(hand1) > .1);
  close(world(rig.bones.hand_L).distanceTo(elbow1), .15 * rig.height);
  rig.dispose();
});

test('three looks have 2/6/27 parts; switching preserves roots, all joint poses and shared bone instances', () => {
  const rig = createRigidCharacter();
  rig.applyPose({ rootPosition: [2, .4, -3], rotations: { forearm_R: quat(new THREE.Vector3(0, 1, 0), .9) } });
  const root = rig.bones.root;
  const positions = Object.values(rig.bones).map(b => world(b).toArray());
  assert.deepEqual(Object.values(rig.looks).map(list => list.length), [2, 6, 27]);
  for (const level of ['CL0', 'CL1', 'CL2'] as CharacterLevel[]) {
    rig.setLevel(level);
    assert.equal(rig.level, level);
    assert.equal(rig.bones.root, root);
    assert.deepEqual(Object.values(rig.bones).map(b => world(b).toArray()), positions);
    for (const [look, parts] of Object.entries(rig.looks)) for (const part of parts) assert.equal(part.visible, look === level);
  }
  rig.dispose();
});

test('CL1 whole limbs keep fixed geometry and shoulder/hip directions when elbows and knees bend', () => {
  const rig = createRigidCharacter({ level: 'CL1' });
  const arm = rig.looks.CL1.find(p => p.name.endsWith('__arm_L'))!;
  const leg = rig.looks.CL1.find(p => p.name.endsWith('__leg_L'))!;
  rig.group.updateMatrixWorld(true);
  const armMatrix = arm.matrixWorld.toArray(), legMatrix = leg.matrixWorld.toArray();
  const armGeometry = Array.from(arm.geometry.getAttribute('position').array);
  rig.applyPose({ rotations: {
    forearm_L: quat(new THREE.Vector3(0, 1, 0), 1.5),
    shin_L: quat(new THREE.Vector3(1, 0, 0), 1.1),
  } });
  assert.deepEqual(arm.matrixWorld.toArray(), armMatrix);
  assert.deepEqual(leg.matrixWorld.toArray(), legMatrix);
  assert.deepEqual(Array.from(arm.geometry.getAttribute('position').array), armGeometry);
  assert.deepEqual(arm.scale.toArray(), [1, 1, 1]);
  rig.dispose();
});

test('export contains a true 22-joint skin with only single-bone unit weights for each selected look', () => {
  const rig = createRigidCharacter();
  for (const level of ['CL0', 'CL1', 'CL2'] as CharacterLevel[]) {
    rig.setLevel(level);
    const mesh = rig.toSkinnedMesh();
    assert.equal(mesh.isSkinnedMesh, true);
    assert.equal(mesh.skeleton.bones.length, 22);
    assert.equal(mesh.skeleton.boneInverses.length, 22);
    assert.equal(mesh.userData.lookLevel, level);
    const indices = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    assert.equal(indices.count, mesh.geometry.getAttribute('position').count);
    assert.ok(indices.count > 100);
    for (let v = 0; v < indices.count; v++) {
      assert.ok(indices.getX(v) >= 0 && indices.getX(v) < 22);
      assert.deepEqual([weights.getX(v), weights.getY(v), weights.getZ(v), weights.getW(v)], [1, 0, 0, 0]);
    }
    assert.equal(mesh.skeleton.bones[0].parent, mesh);
    assert.ok(mesh.skeleton.bones.every(b => b.isBone));
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    mesh.skeleton.dispose();
  }
  rig.dispose();
});

test('skin vertices match posed rigid geometry, including nonzero actor transform; export does not reset live pose', () => {
  const rig = createRigidCharacter();
  rig.group.position.set(3, .2, -2);
  rig.group.rotation.y = .4;
  rig.applyPose({ rootPosition: [.2, .3, .4], rotations: {
    shoulder_L: quat(new THREE.Vector3(0, 0, 1), .5),
    forearm_L: quat(new THREE.Vector3(0, 1, 0), .9),
    thigh_R: quat(new THREE.Vector3(1, 0, 0), -.6),
    shin_R: quat(new THREE.Vector3(1, 0, 0), 1.1),
  } });
  const liveHand = world(rig.bones.hand_L);
  const mesh = rig.toSkinnedMesh();
  let vertex = 0, maxError = 0;
  for (const part of rig.looks.CL2) {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    const attribute = geometry.getAttribute('position');
    for (let v = 0; v < attribute.count; v++, vertex++) {
      const expected = new THREE.Vector3().fromBufferAttribute(attribute, v).applyMatrix4(part.matrixWorld);
      const actual = mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
      maxError = Math.max(maxError, expected.distanceTo(actual));
    }
    geometry.dispose();
  }
  assert.ok(maxError < 1e-6, `rigid/skin max vertex discrepancy: ${maxError}`);
  close(world(rig.bones.hand_L).distanceTo(liveHand), 0);
  const exportedElbow = mesh.skeleton.bones.find(b => b.userData.jointId === 'forearm_L')!;
  close(exportedElbow.quaternion.angleTo(rig.bones.forearm_L.quaternion), 0, 1e-7);
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
  mesh.skeleton.dispose();
  rig.dispose();
});

test('pose errors fail atomically; reset restores T Pose without changing look', () => {
  const rig = createRigidCharacter({ level: 'CL1' });
  rig.applyPose({ rootPosition: [1, 2, 3] });
  assert.throws(() => rig.applyPose({ rootPosition: [0, 0, 0], rotations: { forearm_L: [0, 0, 0, 0] } }), /Zero quaternion/);
  assert.deepEqual(rig.bones.root.position.toArray(), [1, 2, 3]);
  assert.throws(() => rig.applyPose({ rotations: { missing: [0, 0, 0, 1] } }), /Unknown joint/);
  assert.throws(() => rig.applyPose({ rootPosition: [NaN, 0, 0] }), /Invalid root/);
  rig.resetPose();
  assert.equal(rig.level, 'CL1');
  for (const joint of RIG_JOINTS) {
    assert.deepEqual(rig.bones[joint.id].quaternion.toArray(), [0, 0, 0, 1]);
    assert.deepEqual(rig.bones[joint.id].position.toArray(), joint.offset.map(v => v * rig.height));
  }
  rig.dispose();
});
