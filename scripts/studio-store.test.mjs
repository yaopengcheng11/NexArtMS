import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudioStore, PHASES, SCHEMA_VERSION} from '../studio/db.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-test-'));
  const store = createStudioStore(dir);
  const opened = [store];
  return {
    dir, store,
    reopen: () => {const next = createStudioStore(dir);opened.push(next);return next;},
    clean: () => {for (const instance of opened) {try {instance.close();} catch {}}fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5});},
  };
}

const mediaRecord = (baseRevision, overrides = {}) => ({
  id: 'm-test0001', sha256: 'a'.repeat(64), originalName: 'clip.mp4',
  originalRef: 'media/original.mp4', proxyRef: 'proxies/preview.mp4',
  durationUs: 2_000_000, width: 640, height: 360, rotation: 0, timebase: '1/12288',
  fpsNum: 24, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: 'aac', sizeBytes: 1024,
  ptsCount: 48,
  baseRevision, ...overrides,
});

const shotsFor = (project, frameCount = 48, cutAt = 24) => [
  {id: 'S01', startFrame: 0, endFrameExclusive: cutAt, startUs: 0, endUs: 1_000_000},
  {id: 'S02', startFrame: cutAt, endFrameExclusive: frameCount, startUs: 1_000_000, endUs: 2_000_000},
];

async function approvedProject(store) {
  const project = store.createProject({name: '混剪样例', sceneMode: 'proxy'});
  store.insertMedia(project.id, mediaRecord(project.revision));
  store.replaceShots(project.id, shotsFor(project.id), 'auto', store.getProjectRow(project.id).revision);
  const trackA = store.insertTrack(project.id, 'S01', {startFrame: 0, endFrame: 10, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, provenance: 'auto'}, store.getProjectRow(project.id).revision);
  const trackB = store.insertTrack(project.id, 'S02', {startFrame: 30, endFrame: 40, box: {x: 0.3, y: 0.2, w: 0.2, h: 0.5}, provenance: 'user'}, store.getProjectRow(project.id).revision);
  const character = store.createCharacter(project.id, {name: '主角', color: '#28543F', scale: 1.75}, store.getProjectRow(project.id).revision);
  store.patchCast(project.id, store.getProjectRow(project.id).revision, [
    {trackId: trackA.id, characterId: character.id, disposition: 'bound'},
    {trackId: trackB.id, characterId: character.id, disposition: 'bound'},
  ]);
  return {project, trackA, trackB, character};
}

test('project creation fixes scene status by mode and revisions change on every formal write', () => {
  const f = fixture();
  try {
    const proxy = f.store.createProject({name: '代理项目', sceneMode: 'proxy'});
    assert.equal(proxy.scene_status, 'not_requested');
    assert.equal(proxy.phase, 'draft');
    const reconstruct = f.store.createProject({name: '重建项目', sceneMode: 'reconstruct'});
    assert.equal(reconstruct.scene_status, 'pending', 'reconstruct 场景是待做，不是已批准');
    assert.notEqual(f.store.getProjectRow(proxy.id).revision, proxy.revision === f.store.getProjectRow(proxy.id).revision);
    assert.throws(() => f.store.createProject({name: '', sceneMode: 'proxy'}), error => error.status === 400);
    assert.throws(() => f.store.createProject({name: 'x', sceneMode: 'visible'}), error => error.status === 400);
  } finally {f.clean();}
});

test('media insert enforces revision conflicts and single media per project', () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    assert.throws(() => f.store.insertMedia(project.id, mediaRecord('r-stale')), error => error.status === 409);
    const media = f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    assert.equal(media.id, 'm-test0001');
    assert.throws(() => f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision)), error => error.status === 409);
  } finally {f.clean();}
});

test('shot writes must cover every frame seamlessly and move draft to analyzed', () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    const revision = f.store.getProjectRow(project.id).revision;
    assert.throws(() => f.store.replaceShots(project.id, [{id: 'S01', startFrame: 0, endFrameExclusive: 30, startUs: 0, endUs: 1}], 'auto', revision), error => error.status === 400);
    assert.throws(() => f.store.replaceShots(project.id, [
      {id: 'S01', startFrame: 0, endFrameExclusive: 20, startUs: 0, endUs: 0},
      {id: 'S02', startFrame: 30, endFrameExclusive: 48, startUs: 0, endUs: 0},
    ], 'auto', revision), error => error.status === 400, '帧 20–30 漏掉必须拒绝');
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', revision);
    assert.equal(f.store.getProjectRow(project.id).phase, 'analyzed');
    assert.throws(() => f.store.replaceShots(project.id, shotsFor(project.id), 'user', revision), error => error.status === 409, '过期 baseRevision 写入必须 409');
  } finally {f.clean();}
});

test('track operations: range within shot, split, merge, cross-shot merge refused, delete removes binding', () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    assert.throws(() => f.store.insertTrack(project.id, 'S01', {startFrame: 20, endFrame: 30, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.4}, provenance: 'user'}, revision()), error => error.status === 400, '轨迹不能跨过切点');
    const track = f.store.insertTrack(project.id, 'S01', {startFrame: 0, endFrame: 20, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.4}, provenance: 'user'}, revision());
    assert.throws(() => f.store.insertTrack(project.id, 'S01', {startFrame: 0, endFrame: 5, box: {x: 1.2, y: 0.1, w: 0.2, h: 0.4}, provenance: 'user'}, revision()), error => error.status === 400, '越界框必须拒绝');
    const split = f.store.splitTrack(project.id, track.id, 10, revision());
    assert.equal(split.end_frame, 9);
    assert.equal(split.created.start_frame, 10);
    assert.equal(split.created.end_frame, 20);
    const merged = f.store.mergeTracks(project.id, split.id, split.created.id, revision());
    assert.equal(merged.end_frame, 20);
    const otherShot = f.store.insertTrack(project.id, 'S02', {startFrame: 30, endFrame: 40, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.4}, provenance: 'user'}, revision());
    assert.throws(() => f.store.mergeTracks(project.id, merged.id, otherShot.id, revision()), error => error.status === 422, '跨切镜不能自动连接');
    const character = f.store.createCharacter(project.id, {name: '甲', color: '#112233', scale: 1.7}, revision());
    f.store.patchCast(project.id, revision(), [{trackId: merged.id, characterId: character.id, disposition: 'bound'}]);
    f.store.deleteTrack(project.id, otherShot.id, revision());
    assert.equal(f.store.getCast(project.id).bindings.length, 1, '被删除轨迹的绑定同时移除');
  } finally {f.clean();}
});

test('approve-cast is blocked by pending candidates and conflicts, allowed explicitly, and freezes versions', async () => {
  const f = fixture();
  try {
    const {project, trackA, trackB, character} = await approvedProject(f.store);
    const revision = () => f.store.getProjectRow(project.id).revision;
    // 待审候选阻止确认
    const extra = f.store.insertTrack(project.id, 'S01', {startFrame: 12, endFrame: 16, box: {x: 0.5, y: 0.2, w: 0.2, h: 0.4}, provenance: 'auto'}, revision());
    assert.throws(() => f.store.approveCast(project.id, revision()), error => error.status === 422);
    f.store.patchCast(project.id, revision(), [{trackId: extra.id, disposition: 'ignored'}]);
    // 同镜同角色冲突阻止确认
    const twin = f.store.insertTrack(project.id, 'S01', {startFrame: 2, endFrame: 8, box: {x: 0.4, y: 0.2, w: 0.2, h: 0.4}, provenance: 'user'}, revision());
    f.store.patchCast(project.id, revision(), [{trackId: twin.id, characterId: character.id, disposition: 'bound'}]);
    let cast = f.store.getCast(project.id);
    assert.equal(cast.conflicts.length, 1, '同镜重叠绑定同角色必须报冲突');
    assert.throws(() => f.store.approveCast(project.id, revision()), error => error.status === 422);
    // 明确允许同框（分身/镜像）后可确认
    f.store.updateCharacter(project.id, character.id, {allowSimultaneous: true}, revision());
    cast = f.store.getCast(project.id);
    assert.equal(cast.conflicts.length, 0);
    const approved = f.store.approveCast(project.id, revision());
    assert.equal(approved.approval.status, 'approved');
    assert.equal(f.store.getProjectRow(project.id).phase, 'cast_confirmed');
    assert.equal(approved.approval.frozen.media.sha256, 'a'.repeat(64));
    assert.equal(approved.approval.frozen.tracks.activeCount, 4);
    assert.ok(approved.approval.frozen.shots.revision.length > 0);
  } finally {f.clean();}
});

test('upstream changes invalidate a confirmed mapping and revert the phase', async () => {
  const f = fixture();
  try {
    const {project} = await approvedProject(f.store);
    let revision = f.store.getProjectRow(project.id).revision;
    f.store.approveCast(project.id, revision);
    assert.equal(f.store.getProjectRow(project.id).phase, 'cast_confirmed');
    // 上游切点变化 → 确认失效
    revision = f.store.getProjectRow(project.id).revision;
    f.store.replaceShots(project.id, [
      {id: 'S01', startFrame: 0, endFrameExclusive: 16, startUs: 0, endUs: 0},
      {id: 'S02', startFrame: 16, endFrameExclusive: 48, startUs: 0, endUs: 0},
    ], 'user', revision);
    assert.equal(f.store.getApproval(project.id).status, 'invalidated');
    assert.equal(f.store.getProjectRow(project.id).phase, 'analyzed');
    // 重新确认后再改角色比例 → 也失效
    revision = f.store.getProjectRow(project.id).revision;
    const cast = f.store.getCast(project.id);
    for (const track of f.store.getTracks(project.id).filter(item => item.status === 'active')) {
      f.store.patchCast(project.id, f.store.getProjectRow(project.id).revision, [{trackId: track.id, characterId: cast.characters[0].id, disposition: 'bound'}]);
    }
    f.store.approveCast(project.id, f.store.getProjectRow(project.id).revision);
    f.store.updateCharacter(project.id, cast.characters[0].id, {scale: 1.8}, f.store.getProjectRow(project.id).revision);
    assert.equal(f.store.getApproval(project.id).status, 'invalidated');
    assert.equal(f.store.getProjectRow(project.id).phase, 'analyzed');
  } finally {f.clean();}
});

test('state persists across store reopen (refresh/restart consistency)', async () => {
  const f = fixture();
  try {
    const {project} = await approvedProject(f.store);
    const revision = f.store.getProjectRow(project.id).revision;
    const approved = f.store.approveCast(project.id, revision);
    const reopened = f.reopen();
    const detail = reopened.getCast(project.id);
    assert.equal(detail.approval.status, 'approved');
    assert.deepEqual(detail.approval.frozen, approved.approval.frozen);
    assert.equal(reopened.getTracks(project.id).length, 2);
    assert.equal(reopened.getProjectRow(project.id).phase, 'cast_confirmed');
  } finally {f.clean();}
});

test('a fresh database has the motion_ref column (new clones must not rely on v1 migration)', () => {
  const f = fixture();
  try {
    const columns = f.store.db.prepare('PRAGMA table_info(tracks)').all().map(row => row.name);
    assert.ok(columns.includes('motion_ref'), `tracks 缺少 motion_ref 列：${columns.join(', ')}`);
    assert.equal(Number(f.store.db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  } finally {f.clean();}
});

test('cast approval freezes the detector version used by the completed analysis job', async () => {
  const f = fixture();
  try {
    const {project} = await approvedProject(f.store);
    const job = f.store.createJob(project.id, 'detect');
    f.store.updateJob(job.id, {state: 'done', algorithm_version: 'person-model@weights-v2'});
    const approved = f.store.approveCast(project.id, f.store.getProjectRow(project.id).revision);
    assert.equal(approved.approval.frozen.algorithmVersions.detector, 'person-model@weights-v2');
  } finally {f.clean();}
});

test('character input validation and job state transitions', () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    const revision = () => f.store.getProjectRow(project.id).revision;
    assert.throws(() => f.store.createCharacter(project.id, {name: 'x', color: 'red', scale: 1.7}, revision()), error => error.status === 400);
    assert.throws(() => f.store.createCharacter(project.id, {name: 'x', color: '#112233', scale: 9}, revision()), error => error.status === 400);
    const job = f.store.createJob(project.id, 'cuts', {inputHash: 'abc'});
    assert.equal(job.state, 'queued');
    f.store.updateJob(job.id, {state: 'running', progress: 0.2});
    assert.equal(f.store.requestCancel(project.id, job.id).cancel_requested, 1);
    f.store.updateJob(job.id, {state: 'failed', error: 'x'});
    const retried = f.store.retryJob(project.id, job.id, revision());
    assert.equal(retried.state, 'queued');
    assert.throws(() => f.store.retryJob(project.id, job.id, revision()), error => error.status === 422, '排队中的任务不能再次重试');
    assert.ok(PHASES.length === 6);
  } finally {f.clean();}
});
