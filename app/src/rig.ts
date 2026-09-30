import * as THREE from 'three';

export type CharacterLevel = 'CL0' | 'CL1' | 'CL2';
export type Vec3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];
export interface CharacterPose {
  rootPosition?: Vec3Tuple;
  rotations?: Record<string, QuaternionTuple>;
}
export interface CharacterOptions {
  id?: string;
  color?: number;
  height?: number;
  level?: CharacterLevel;
}
export interface RigidCharacter {
  group: THREE.Group;
  bones: Record<string, THREE.Bone>;
  looks: Record<CharacterLevel, THREE.Mesh[]>;
  readonly level: CharacterLevel;
  readonly height: number;
  setLevel(level: CharacterLevel): void;
  resetPose(): void;
  applyPose(pose: CharacterPose): void;
  /** Selected look compiled to a real skin; each vertex belongs 100% to one joint. */
  toSkinnedMesh(): THREE.SkinnedMesh;
  dispose(): void;
}

/** Y up, +Z forward, +X character left. Offsets are fractions of standing height. */
export const RIG_JOINTS = [
  { id: 'root', parent: null, offset: [0, 0, 0] },
  { id: 'pelvis', parent: 'root', offset: [0, .53, 0] },
  { id: 'spine', parent: 'pelvis', offset: [0, .11, 0] },
  { id: 'chest', parent: 'spine', offset: [0, .12, 0] },
  { id: 'neck', parent: 'chest', offset: [0, .08, 0] },
  { id: 'head', parent: 'neck', offset: [0, .075, 0] },
  { id: 'shoulder_L', parent: 'chest', offset: [.095, .015, 0] },
  { id: 'upperArm_L', parent: 'shoulder_L', offset: [.055, 0, 0] },
  { id: 'forearm_L', parent: 'upperArm_L', offset: [.17, 0, 0] },
  { id: 'hand_L', parent: 'forearm_L', offset: [.15, 0, 0] },
  { id: 'shoulder_R', parent: 'chest', offset: [-.095, .015, 0] },
  { id: 'upperArm_R', parent: 'shoulder_R', offset: [-.055, 0, 0] },
  { id: 'forearm_R', parent: 'upperArm_R', offset: [-.17, 0, 0] },
  { id: 'hand_R', parent: 'forearm_R', offset: [-.15, 0, 0] },
  { id: 'thigh_L', parent: 'pelvis', offset: [.07, -.035, 0] },
  { id: 'shin_L', parent: 'thigh_L', offset: [0, -.225, 0] },
  { id: 'foot_L', parent: 'shin_L', offset: [0, -.23, 0] },
  { id: 'toe_L', parent: 'foot_L', offset: [0, -.005, .10] },
  { id: 'thigh_R', parent: 'pelvis', offset: [-.07, -.035, 0] },
  { id: 'shin_R', parent: 'thigh_R', offset: [0, -.225, 0] },
  { id: 'foot_R', parent: 'shin_R', offset: [0, -.23, 0] },
  { id: 'toe_R', parent: 'foot_R', offset: [0, -.005, .10] },
] as const;

const LEVELS: CharacterLevel[] = ['CL0', 'CL1', 'CL2'];
function validLevel(value: string): asserts value is CharacterLevel {
  if (!LEVELS.includes(value as CharacterLevel)) throw new Error(`Unknown character level: ${value}`);
}

export function createRigidCharacter(options: CharacterOptions = {}): RigidCharacter {
  const { id = 'character', color = 0xef873b, height = 1.75 } = options;
  let level = options.level ?? 'CL2';
  validLevel(level);
  if (!Number.isFinite(height) || height <= 0) throw new Error('Character height must be positive and finite');
  const group = new THREE.Group();
  group.name = id;
  group.userData = { characterId: id, rigVersion: 'rigid-human-22-v1', units: 'meters', upAxis: 'Y', forwardAxis: '+Z' };
  const bones: Record<string, THREE.Bone> = {};
  const restWorld: Record<string, THREE.Matrix4> = {};
  for (const joint of RIG_JOINTS) {
    const bone = new THREE.Bone();
    bone.name = `${id}__${joint.id}`;
    bone.userData.jointId = joint.id;
    bone.position.fromArray(joint.offset).multiplyScalar(height);
    bones[joint.id] = bone;
    if (joint.parent) bones[joint.parent].add(bone);
    else group.add(bone);
  }
  group.updateMatrixWorld(true);
  for (const joint of RIG_JOINTS) restWorld[joint.id] = bones[joint.id].matrixWorld.clone();
  const material = new THREE.MeshStandardMaterial({ color, roughness: .78, metalness: 0 });
  const looks: Record<CharacterLevel, THREE.Mesh[]> = { CL0: [], CL1: [], CL2: [] };
  function add(look: CharacterLevel, joint: string, part: string, geometry: THREE.BufferGeometry, position: Vec3Tuple = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${id}__${look}__${part}`;
    mesh.position.fromArray(position).multiplyScalar(height);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { characterId: id, level: look, jointId: joint, binding: 'rigid' };
    bones[joint].add(mesh);
    looks[look].push(mesh);
    return mesh;
  }
  function ellipsoid(look: CharacterLevel, joint: string, part: string, radii: Vec3Tuple, position: Vec3Tuple = [0, 0, 0]) {
    const geo = new THREE.SphereGeometry(1, 16, 12);
    geo.scale(...radii.map(n => n * height) as Vec3Tuple);
    return add(look, joint, part, geo, position);
  }
  function segment(look: CharacterLevel, joint: string, part: string, delta: Vec3Tuple, radius: number) {
    const vector = new THREE.Vector3(...delta).multiplyScalar(height);
    const length = vector.length();
    const geo = new THREE.CylinderGeometry(radius * height, radius * height, length, 12);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.clone().normalize()));
    geo.translate(vector.x / 2, vector.y / 2, vector.z / 2);
    return add(look, joint, part, geo);
  }
  function addHead(look: CharacterLevel) {
    ellipsoid(look, 'head', 'head', [.068, .085, .065]);
  }

  // CL0 has the same head and root motion. Hidden limb joints remain present.
  addHead('CL0');
  add('CL0', 'pelvis', 'body', new THREE.CapsuleGeometry(.13 * height, .44 * height, 6, 16), [0, -.085, 0]);
  addHead('CL1');
  ellipsoid('CL1', 'pelvis', 'body', [.13, .17, .085], [0, .105, 0]);
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    // Fixed shoulder/hip directions; elbow/knee rotation is deliberately not folded into stretch.
    segment('CL1', `upperArm_${side}`, `arm_${side}`, [sign * .355, 0, 0], .035);
    segment('CL1', `thigh_${side}`, `leg_${side}`, [0, -.455, 0], .042);
  }
  addHead('CL2');
  segment('CL2', 'neck', 'neck', [0, .065, 0], .028);
  ellipsoid('CL2', 'chest', 'chest', [.13, .10, .078], [0, -.025, 0]);
  ellipsoid('CL2', 'spine', 'abdomen', [.08, .075, .065]);
  ellipsoid('CL2', 'pelvis', 'pelvis', [.105, .07, .07]);
  for (const side of ['L', 'R']) {
    const sign = side === 'L' ? 1 : -1;
    ellipsoid('CL2', `upperArm_${side}`, `shoulder_${side}`, [.042, .042, .042]);
    segment('CL2', `upperArm_${side}`, `upperArm_${side}`, [sign * .17, 0, 0], .034);
    ellipsoid('CL2', `forearm_${side}`, `elbow_${side}`, [.035, .035, .035]);
    segment('CL2', `forearm_${side}`, `forearm_${side}`, [sign * .15, 0, 0], .029);
    ellipsoid('CL2', `hand_${side}`, `wrist_${side}`, [.027, .027, .027]);
    ellipsoid('CL2', `hand_${side}`, `hand_${side}`, [.040, .033, .022], [sign * .028, 0, 0]);
    segment('CL2', `thigh_${side}`, `thigh_${side}`, [0, -.225, 0], .045);
    ellipsoid('CL2', `shin_${side}`, `knee_${side}`, [.040, .040, .040]);
    segment('CL2', `shin_${side}`, `shin_${side}`, [0, -.23, 0], .034);
    ellipsoid('CL2', `foot_${side}`, `ankle_${side}`, [.03, .03, .03]);
    add('CL2', `foot_${side}`, `foot_${side}`, new THREE.BoxGeometry(.065 * height, .08 * height, .18 * height), [0, 0, .045]);
  }

  function setLevel(next: CharacterLevel) {
    validLevel(next);
    level = next;
    group.userData.lookLevel = next;
    for (const key of LEVELS) for (const mesh of looks[key]) mesh.visible = key === next;
  }
  function resetPose() {
    for (const joint of RIG_JOINTS) {
      const bone = bones[joint.id];
      bone.position.fromArray(joint.offset).multiplyScalar(height);
      bone.quaternion.identity();
      bone.scale.set(1, 1, 1);
    }
    group.updateMatrixWorld(true);
  }
  function applyPose(pose: CharacterPose) {
    // Validate the complete patch before changing anything; typos cannot silently lose channels.
    if (pose.rootPosition && (pose.rootPosition.length !== 3 || !pose.rootPosition.every(Number.isFinite))) throw new Error('Invalid root position');
    const rotations = Object.entries(pose.rotations ?? {}).map(([joint, rotation]) => {
      if (!bones[joint]) throw new Error(`Unknown joint: ${joint}`);
      if (rotation.length !== 4 || !rotation.every(Number.isFinite)) throw new Error(`Invalid rotation: ${joint}`);
      const q = new THREE.Quaternion(...rotation);
      if (q.lengthSq() < 1e-16) throw new Error(`Zero quaternion: ${joint}`);
      return [joint, q.normalize()] as const;
    });
    if (pose.rootPosition) bones.root.position.fromArray(pose.rootPosition);
    for (const [joint, quaternion] of rotations) bones[joint].quaternion.copy(quaternion);
    group.updateMatrixWorld(true);
  }

  function toSkinnedMesh(): THREE.SkinnedMesh {
    const positions: number[] = [], normals: number[] = [], indices: number[] = [], weights: number[] = [];
    const jointIds = RIG_JOINTS.map(j => j.id as string);
    for (const part of looks[level]) {
      part.updateMatrix();
      const bindTransform = restWorld[part.userData.jointId].clone().multiply(part.matrix);
      const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
      geometry.applyMatrix4(bindTransform);
      const pos = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      const jointIndex = jointIds.indexOf(part.userData.jointId);
      for (let i = 0; i < pos.count; i++) {
        positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        indices.push(jointIndex, 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
      geometry.dispose();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, material.clone());
    mesh.name = `${id}__skin_${level}`;
    mesh.position.copy(group.position);
    mesh.quaternion.copy(group.quaternion);
    mesh.scale.copy(group.scale);
    mesh.userData = { ...group.userData, binding: 'single-bone-100-percent', jointIds };
    const exportBones: Record<string, THREE.Bone> = {};
    for (const joint of RIG_JOINTS) {
      const bone = new THREE.Bone();
      bone.name = bones[joint.id].name;
      bone.userData = { jointId: joint.id };
      bone.position.fromArray(joint.offset).multiplyScalar(height);
      exportBones[joint.id] = bone;
      if (joint.parent) exportBones[joint.parent].add(bone);
      else mesh.add(bone);
    }
    mesh.updateMatrixWorld(true);
    mesh.bind(new THREE.Skeleton(RIG_JOINTS.map(j => exportBones[j.id])));
    // Bind in T Pose first, then copy the current pose. Exporting never resets the live character.
    for (const joint of RIG_JOINTS) {
      exportBones[joint.id].position.copy(bones[joint.id].position);
      exportBones[joint.id].quaternion.copy(bones[joint.id].quaternion);
    }
    mesh.updateMatrixWorld(true);
    mesh.skeleton.update();
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    return mesh;
  }
  setLevel(level);
  return {
    group, bones, looks, height,
    get level() { return level; },
    setLevel, resetPose, applyPose, toSkinnedMesh,
    dispose() {
      for (const meshes of Object.values(looks)) for (const mesh of meshes) mesh.geometry.dispose();
      material.dispose();
    },
  };
}
