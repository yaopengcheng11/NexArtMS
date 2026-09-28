import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStudioStore} from '../studio/db.mjs';
import {createJobRunner} from '../studio/jobs.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {registerDetector} from '../studio/person.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';
import {draftQuality, motionIntervals} from '../studio/draft-quality.mjs';

const detectorByProject = new Map();
registerDetector('pipeline-test-fixture', async spec => detectorByProject.get(spec.projectId)?.(spec) ?? [], {version: 'test-only'});
const box = {x: 0.2, y: 0.1, w: 0.3, h: 0.7};
const joints = Object.fromEntries(['pelvis', 'neck', 'head', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR'].map(name => [name, [0, 1, 0]]));
const frame = timeS => ({timeS, frame: Math.round(timeS * 24), joints, rootOffset: [0, 1, 0], contacts: {ankleL: false, ankleR: false}});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-pipeline-'));
  const store = createStudioStore(root);
  const p = store.createProject({name: '隔离流水线回归', sceneMode: 'proxy'});
  const revision = () => store.getProjectRow(p.id).revision;
  store.insertMedia(p.id, {id: 'm-fixture', sha256: 'a'.repeat(64), originalName: 'fixture.mp4', originalRef: 'media/fixture.mp4', proxyRef: 'proxies/fixture.mp4', durationUs: 2e6, width: 640, height: 360, rotation: 0, timebase: '1/12288', fpsNum: 24, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: '', sizeBytes: 1, ptsCount: 48, baseRevision: revision()});
  store.replaceShots(p.id, [{id: 'S01', startFrame: 0, endFrameExclusive: 48, startUs: 0, endUs: 2e6}], 'auto', revision());
  const jobs = createJobRunner(store, root, DEFAULT_LIMITS);
  let server;
  return {
    root, store, projectId: p.id, revision, jobs,
    async http() {
      const router = createStudioRouter(store, root, {limits: DEFAULT_LIMITS, jobs});
      server = http.createServer((req, res) => {router(req, res).catch(error => {res.writeHead(500);res.end(JSON.stringify({error: error.message}));});});
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api/studio/projects/${p.id}`;
      return async (suffix = '', body) => {
        const response = await fetch(base + suffix, body ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)} : undefined);
        return {status: response.status, body: await response.json()};
      };
    },
    async clean() {
      if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
      detectorByProject.delete(p.id);
      store.close();
      const resolved = path.resolve(root);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('studio-pipeline-'));
      fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5});
    },
  };
}

async function idle(f) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const jobs = f.store.listJobs(f.projectId);
    if (jobs.every(job => !['queued', 'running'].includes(job.state))) return jobs;
  }
  throw new Error('fixture jobs did not settle');
}

const autoSpec = (subject, overrides = {}) => ({shotId: 'S01', startFrame: 0, endFrame: 47, box, subject, species: subject === 'animal' ? 'dog' : null, provenance: 'auto', ...overrides});

test('animal-only missing model fails without invoking or replacing person detection', async () => {
  const f = fixture();
  try {
    const [person] = f.store.insertTracks(f.projectId, [autoSpec('person')], f.revision(), ['person']);
    const calls = [];
    detectorByProject.set(f.projectId, async spec => {calls.push(spec.subjects);throw new Error('动物检测模型未安装');});
    f.jobs.enqueue(f.projectId, 'detect', {subjects: 'animal'});
    const jobs = await idle(f);
    assert.equal(jobs[0].state, 'failed');
    assert.deepEqual(calls, ['animal']);
    assert.equal(f.store.getTracks(f.projectId).find(row => row.id === person.id).status, 'active');
  } finally {await f.clean();}
});

test('both fallback only replaces successfully detected subjects, including empty result', async () => {
  const f = fixture();
  try {
    const [person, animal] = f.store.insertTracks(f.projectId, [autoSpec('person'), autoSpec('animal')], f.revision(), ['person', 'animal']);
    const calls = [];
    detectorByProject.set(f.projectId, async spec => {calls.push(spec.subjects);if (spec.subjects === 'both') throw new Error('动物检测模型未安装');return [];});
    f.jobs.enqueue(f.projectId, 'detect', {subjects: 'both'});
    const jobs = await idle(f);
    assert.equal(jobs[0].state, 'done', jobs[0].error);
    assert.deepEqual(calls, ['both', 'person']);
    const tracks = f.store.getTracks(f.projectId);
    assert.equal(tracks.find(row => row.id === person.id).status, 'superseded');
    assert.equal(tracks.find(row => row.id === animal.id).status, 'active');
    assert.match(jobs[0].output, /降级/);
  } finally {await f.clean();}
});

test('zero detections continues auto people and motion into playable empty draft', async () => {
  const f = fixture();
  try {
    f.jobs.enqueue(f.projectId, 'detect', {subjects: 'both', auto: true});
    const jobs = await idle(f);
    // V2 §6.1：运镜估计（人物尺度）属于自动初稿依赖图；零检测时无出场，camera 任务正常完成但不产出
    assert.deepEqual(jobs.map(job => job.kind).sort(), ['camera', 'detect', 'motion', 'people']);
    assert.ok(jobs.every(job => job.state === 'done'), JSON.stringify(jobs));
    const api = await f.http();
    const {body} = await api();
    assert.equal(body.draft.state, 'ready_with_issues');
    assert.equal(body.draft.coveragePct, null);
    assert.equal(body.draft.visibleDurationUs, 0);
    assert.ok(body.draft.issues.some(issue => issue.code === 'camera_missing'));
    assert.equal(body.shots.length, 1);
  } finally {await f.clean();}
});

test('animal-only footage completes auto draft with explicit unsupported motion issue', async () => {
  const f = fixture();
  try {
    detectorByProject.set(f.projectId, async () => [0, 2].map(frame => ({frame, box, subject: 'animal', className: 'dog', confidence: 0.9, appearance: Array(128).fill(1 / 128)})));
    f.jobs.enqueue(f.projectId, 'detect', {subjects: 'both', auto: true});
    const jobs = await idle(f);
    assert.ok(jobs.every(job => job.state === 'done'), JSON.stringify(jobs));
    assert.match(jobs.find(job => job.kind === 'people').output, /0 个人物候选、1 个动物候选/);
    const api = await f.http();
    const {body} = await api();
    assert.equal(body.draft.state, 'ready_with_issues');
    assert.equal(body.draft.coveragePct, 0);
    assert.ok(body.draft.subjectCoverage.animal.visibleDurationUs > 0);
    assert.ok(body.draft.issues.some(issue => issue.code === 'animal_motion_unsupported'));
  } finally {await f.clean();}
});

test('motion coverage measures supported time and keeps null samples as gaps', () => {
  assert.deepEqual(motionIntervals({frames: [frame(1), frame(9)]}, 0, 10e6), [[750000, 1250000], [8750000, 9250000]]);
  assert.deepEqual(motionIntervals({frames: [frame(0), null, frame(0.2)], sampleTimesS: [0, 0.1, 0.2]}, 0, 300000), [[0, 50000], [150000, 300000]]);
  const tracks = ['person', 'person', 'animal'].map((subject, index) => ({id: `t${index}`, status: 'active', shot_id: 'S01', subject, start_us: 0, end_us: 10e6}));
  const result = draftQuality({tracks, bindings: [{track_id: 't0', disposition: 'bound', character_id: 'c'}], characters: [{id: 'c', scale: 1.75}], shots: [{id: 'S01', start_us: 0, end_us: 10e6}], cameraTracks: [], jobs: [{kind: 'motion', state: 'done'}], motions: {t0: {trackId: 't0', shotId: 'S01', characterId: 'c', bodyHeight: 1.75, frames: [frame(1), frame(9)]}}});
  assert.equal(result.visibleDurationUs, 30e6, 'unbound people and animals remain in denominator');
  assert.equal(result.solvedDurationUs, 1e6);
  assert.equal(result.coveragePct, 3.3);
  assert.equal(result.state, 'ready_with_issues');
  assert.ok(result.issues.some(issue => issue.code === 'unbound_subject'));
  assert.ok(result.issues.some(issue => issue.code === 'animal_motion_unsupported'));
});

test('same-ref content replacement updates detail and motion response version; invalidation removes ref', async () => {
  const f = fixture();
  try {
    const [person] = f.store.insertTracks(f.projectId, [autoSpec('person')], f.revision(), ['person']);
    f.store.ensureProvisionalGroups(f.projectId, f.revision());
    const ref = `data/projects/${f.projectId}/observations/motion/${person.id}.json`;
    const file = path.join(f.root, ref);
    const metadata = {trackId: person.id, shotId: 'S01', characterId: f.store.getCast(f.projectId).bindings.find(row => row.track_id === person.id).character_id, bodyHeight: 1.75};
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({...metadata, frames: [frame(0), frame(1.9)]}));
    f.store.setMotionRef(f.projectId, person.id, ref);
    const done = f.store.createJob(f.projectId, 'motion');f.store.updateJob(done.id, {state: 'done'});
    const api = await f.http();
    const before = (await api()).body;
    assert.equal(before.draft.coveragePct, 30, 'two sparse valid frames do not count as 100%');
    const version = before.motionVersions[person.id];
    assert.match(version, /^[a-f0-9]{64}$/);
    await new Promise(resolve => setTimeout(resolve, 10));
    fs.writeFileSync(file, JSON.stringify({...metadata, frames: [frame(0.1), frame(1.8)]}));
    const after = (await api()).body;
    assert.notEqual(after.motionVersions[person.id], version);
    const content = (await api(`/tracks/${person.id}/motion`)).body;
    assert.equal(content.motionVersion, after.motionVersions[person.id]);
    assert.equal(content.motion.frames[0].timeS, 0.1);
    fs.unlinkSync(file);
    const missing = (await api()).body;
    assert.equal(missing.motionRefs[person.id], undefined);
    assert.equal(missing.draft.coveragePct, 0);
    assert.ok(missing.draft.issues.some(issue => issue.code === 'motion_artifact_invalid'));
    f.store.setMotionRef(f.projectId, person.id, null);
    const invalidated = (await api()).body;
    assert.equal(invalidated.motionRefs[person.id], undefined);
    assert.equal(invalidated.motionVersions[person.id], undefined);
    assert.equal(invalidated.draft.coveragePct, 0);
  } finally {await f.clean();}
});

test('invalid consumed motion fields and obsolete binding/height never count as solved', () => {
  const motion = {trackId: 't', shotId: 'S01', characterId: 'c', bodyHeight: 1.75, frames: [frame(0.25), frame(0.75)]};
  const input = {tracks: [{id: 't', shot_id: 'S01', status: 'active', subject: 'person', start_us: 0, end_us: 1e6}],
    bindings: [{track_id: 't', character_id: 'c', disposition: 'bound'}], characters: [{id: 'c', scale: 1.75}],
    shots: [{id: 'S01', start_us: 0, end_us: 1e6}], jobs: [{kind: 'motion', state: 'done'}],
    cameraTracks: [{shot_id: 'S01', source: 'landmark-pnp', median_error_px: 0, extrinsics: {rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 4]}}]};
  const valid = draftQuality({...input, motions: {t: motion}});
  assert.equal(valid.coveragePct, 100);
  assert.equal(valid.state, 'ready');
  const invalid = [
    {...motion, frames: motion.frames.map(item => ({...item, rootOffset: undefined}))},
    {...motion, frames: motion.frames.map(item => ({...item, rootOffset: [0, NaN, 0]}))},
    {...motion, frames: motion.frames.map(item => ({...item, frame: 0.5}))},
    {...motion, frames: motion.frames.map(item => ({...item, frame: -1}))},
    {...motion, frames: motion.frames.map(item => ({...item, joints: {...item.joints, hipL: [0, Infinity, 0]}}))},
    {...motion, trackId: 'other'}, {...motion, shotId: 'S02'}, {...motion, characterId: 'other'},
    {...motion, bodyHeight: 1.8}, {...motion, bodyHeight: undefined},
  ];
  for (const artifact of invalid) {
    const result = draftQuality({...input, motions: {t: artifact}});
    assert.equal(result.coveragePct, 0, JSON.stringify(artifact));
    assert.equal(result.state, 'ready_with_issues');
  }
});

test('historical ignored animal without binding is excluded; explicit binding takes precedence', async () => {
  const f = fixture();
  try {
    const track = f.store.insertTrack(f.projectId, 'S01', {...autoSpec('animal'), provenance: 'user'}, f.revision());
    f.store.db.prepare("UPDATE source_people SET assignment='ignored' WHERE id=?").run(track.person_id);
    f.store.db.prepare('DELETE FROM bindings WHERE track_id=?').run(track.id);
    const api = await f.http();
    const ignored = (await api()).body;
    assert.equal(ignored.people.find(person => person.id === track.person_id).assignment, 'ignored');
    assert.equal(ignored.draft.visibleDurationUs, 0);
    assert.ok(!ignored.draft.issues.some(issue => issue.trackId === track.id));
    f.store.patchCast(f.projectId, f.revision(), [{trackId: track.id, disposition: 'unassigned', characterId: null}]);
    const restored = (await api()).body;
    assert.equal(restored.draft.subjectCoverage.animal.visibleDurationUs, 2e6);
    const animalIssues = restored.draft.issues.filter(issue => issue.trackId === track.id);
    assert.ok(animalIssues.some(issue => issue.code === 'animal_motion_unsupported'));
    assert.ok(animalIssues.every(issue => !/占位/.test(issue.message)), 'unrendered animals must not be described as proxies');
  } finally {await f.clean();}
});

test('manual animal track HTTP preserves subject/species and rejects invalid values', async () => {
  const f = fixture();
  try {
    const api = await f.http();
    const body = {baseRevision: f.revision(), startFrame: 0, endFrame: 10, box, subject: 'animal', species: 'dog'};
    const created = await api('/shots/S01/tracks', body);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.track.subject, 'animal');
    assert.equal(created.body.track.species, 'dog');
    assert.equal((await api()).body.tracks[0].species, 'dog');
    assert.equal((await api('/shots/S01/tracks', {...body, baseRevision: f.revision(), subject: 'bird'})).status, 400);
    assert.equal((await api('/shots/S01/tracks', {...body, baseRevision: f.revision(), species: {name: 'dog'}})).status, 400);
  } finally {await f.clean();}
});

test('missing pose is a content gap but malformed pose remains a technical failure', async () => {
  const f = fixture();
  try {
    const [person] = f.store.insertTracks(f.projectId, [autoSpec('person')], f.revision(), ['person']);
    f.store.ensureProvisionalGroups(f.projectId, f.revision());
    f.jobs.enqueue(f.projectId, 'motion');
    assert.equal((await idle(f))[0].state, 'done');
    const pose = path.join(f.store.observationsDir(f.projectId), 'poses', `${person.id}.json`);
    fs.mkdirSync(path.dirname(pose), {recursive: true});fs.writeFileSync(pose, 'invalid json');
    f.jobs.enqueue(f.projectId, 'motion');
    assert.equal((await idle(f))[0].state, 'failed');
    const api = await f.http();
    assert.equal((await api()).body.draft.state, 'blocked');
  } finally {await f.clean();}
});
