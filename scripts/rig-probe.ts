import * as THREE from 'three';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRigidCharacter, RIG_JOINTS, type CharacterLevel, type QuaternionTuple } from '../src/rig.ts';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'scripts/rig.test.ts'], { cwd: projectRoot, encoding: 'utf8' });
const rig = createRigidCharacter({ id: 'M0-fixture', height: 1.75 });
let maxRelativeBoneLengthError = 0;
const pos = (joint: string) => rig.bones[joint].getWorldPosition(new THREE.Vector3());
for (let frame = 0; frame < 120; frame++) {
  const rotations: Record<string, QuaternionTuple> = {};
  for (let i = 0; i < RIG_JOINTS.length; i++) {
    rotations[RIG_JOINTS[i].id] = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), Math.sin(frame * .03 + i) * 1.4).toArray() as QuaternionTuple;
  }
  rig.applyPose({ rootPosition: [frame * .01, Math.sin(frame * .04), -.2], rotations });
  for (const joint of RIG_JOINTS) {
    if (!joint.parent) continue;
    const restLength = new THREE.Vector3(...joint.offset).length() * rig.height;
    maxRelativeBoneLengthError = Math.max(maxRelativeBoneLengthError, Math.abs(pos(joint.id).distanceTo(pos(joint.parent)) - restLength) / rig.height);
  }
}
const lookResults = [];
for (const level of ['CL0', 'CL1', 'CL2'] as CharacterLevel[]) {
  rig.setLevel(level);
  const skin = rig.toSkinnedMesh();
  let maxWorldVertexError = 0, vertex = 0, invalidWeights = 0;
  const weights = skin.geometry.getAttribute('skinWeight');
  for (let v = 0; v < weights.count; v++) if (weights.getX(v) !== 1 || weights.getY(v) !== 0 || weights.getZ(v) !== 0 || weights.getW(v) !== 0) invalidWeights++;
  for (const part of rig.looks[level]) {
    const geometry = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    const attribute = geometry.getAttribute('position');
    for (let v = 0; v < attribute.count; v++, vertex++) {
      const expected = new THREE.Vector3().fromBufferAttribute(attribute, v).applyMatrix4(part.matrixWorld);
      const actual = skin.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(skin.matrixWorld);
      maxWorldVertexError = Math.max(maxWorldVertexError, expected.distanceTo(actual));
    }
    geometry.dispose();
  }
  lookResults.push({ level, parts: rig.looks[level].length, vertices: vertex, exportedBones: skin.skeleton.bones.length, invalidWeights, maxWorldVertexErrorMeters: maxWorldVertexError });
  skin.geometry.dispose(); (skin.material as THREE.Material).dispose(); skin.skeleton.dispose();
}
const report = {
  schemaVersion: 1,
  probe: 'M0 / rigid-human-22 / fixed bones and rigid skin compiler',
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, architecture: process.arch, threeRevision: THREE.REVISION },
  scope: 'Synthetic technical fixture only; not a confirmed source-video character asset.',
  status: tests.status === 0 && maxRelativeBoneLengthError < 1e-4 && lookResults.every(r => r.invalidWeights === 0 && r.maxWorldVertexErrorMeters < 1e-6) ? 'passed-local-probe' : 'failed',
  coordinates: { units: 'meters', upAxis: 'Y', forward: '+Z', characterLeft: '+X', height: rig.height },
  joints: RIG_JOINTS.map(j => ({ id: j.id, parent: j.parent, restOffsetMeters: j.offset.map(v => v * rig.height) })),
  checks: { testsExitCode: tests.status, tests: 8, passed: tests.status === 0 ? 8 : null, sampledFrames: 120, constrainedSegments: 21, maxRelativeBoneLengthError, boneLengthThreshold: 0.0001, looks: lookResults },
  rules: ['CL changes visibility only, retaining all 22 joints and pose', 'CL1 whole limbs use shoulder/hip direction and fixed length; no elbow/knee stretch', 'GLB export representation is a SkinnedMesh with real Skeleton and inverse bind matrices', 'Each vertex has weight [1,0,0,0] and one valid joint index', 'toSkinnedMesh binds in T Pose before copying current pose; live character is unchanged'],
  notVerifiedHere: ['Actual GLB binary serialization and reimport', 'Blender / Maya / Houdini import', 'Source-video retargeting or jitter reduction', 'Browser appearance approval', 'G2 formal character/T Pose confirmation'],
  testOutput: tests.stdout,
};
mkdirSync(new URL('../reports/', import.meta.url), { recursive: true });
const output = new URL('../reports/rig-m0.json', import.meta.url);
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: fileURLToPath(output), status: report.status, checks: report.checks }, null, 2));
rig.dispose();
if (report.status !== 'passed-local-probe') process.exitCode = 1;
