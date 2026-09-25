import * as THREE from 'three';

// A proxy segment rig: one rigid skinned segment per measured bone. Local joint
// positions are not inferred through an unrelated humanoid rest hierarchy.
// All appearances of a character share this asset, with one clip per track.
export function buildProxyRig(character, samples) {
  const group = new THREE.Group();
  group.name = character.id;
  group.userData = {rig: 'proxy-segments-v2', characterId: character.id};
  const first = samples[0].motion.frames.find(Boolean);
  const segments = samples[0].motion.bones;
  const bones = segments.map(segment => {
    const bone = new THREE.Bone();
    bone.name = segment.name;
    bone.userData = {from: segment.parent, to: segment.child};
    group.add(bone);
    return bone;
  });
  const transform = (frame, segment) => {
    const start = new THREE.Vector3(...frame.joints[segment.parent]);
    start.x += frame.rootOffset[0];start.z += frame.rootOffset[2];
    const direction = new THREE.Vector3(...frame.joints[segment.child]).sub(new THREE.Vector3(...frame.joints[segment.parent]));
    const length = direction.length();
    if (!(length > 1e-6)) throw new Error('动作包含退化骨段');
    return {position: start, quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()), scale: new THREE.Vector3(1, length, 1)};
  };
  segments.forEach((segment, index) => {
    const value = transform(first, segment);
    bones[index].position.copy(value.position);bones[index].quaternion.copy(value.quaternion);bones[index].scale.copy(value.scale);
  });
  group.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  skeleton.calculateInverses();
  segments.forEach((segment, index) => {
    const geometry = new THREE.BoxGeometry(0.055 * character.scale, 1, 0.055 * character.scale);
    geometry.translate(0, 0.5, 0);
    geometry.applyMatrix4(bones[index].matrixWorld);
    const count = geometry.attributes.position.count;
    const indices = new Uint16Array(count * 4), weights = new Float32Array(count * 4);
    for (let vertex = 0; vertex < count; vertex++) {indices[vertex * 4] = index;weights[vertex * 4] = 1;}
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
    const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({color: character.color}));
    mesh.name = `segment-${segment.name}`;
    mesh.bind(skeleton, new THREE.Matrix4());
    group.add(mesh);
  });
  const clips = samples.map(({trackId, motion}) => {
    const frames = motion.frames.filter(Boolean);
    const times = frames.map(frame => frame.timeS - frames[0].timeS);
    const tracks = [];
    segments.forEach((segment, index) => {
      const transforms = frames.map(frame => transform(frame, segment));
      const name = bones[index].name;
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, transforms.flatMap(t => t.position.toArray())));
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, transforms.flatMap(t => t.quaternion.toArray())));
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, times, transforms.flatMap(t => t.scale.toArray())));
    });
    return new THREE.AnimationClip(`motion-${trackId}`, times.at(-1), tracks);
  });
  return {group, clips};
}
