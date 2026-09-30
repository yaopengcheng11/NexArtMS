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
    clean: () => {for (const instance of opened) {try {instance.close();} catch {}}assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('studio-store-test-'));fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5});},
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


test('animal tracks are excluded from cast gating and people grouping', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    const created = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 0, endFrame: 10, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
      {shotId: 'S01', startFrame: 1, endFrame: 12, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal'},
    ], revision());
    const person = created.find(row => (row.subject || 'person') === 'person');
    const animal = created.find(row => row.subject === 'animal');
    assert.ok(person && animal, '应创建 person + animal 两条候选');
    // 人物归组层不包含动物
    assert.equal(f.store.getPeople(project.id).length, 1, 'getPeople 应只有人物');
    // 确认门槛只看人物：仅绑定人物即可正式确认
    const character = f.store.createCharacter(project.id, {name: '主角', color: '#28543F', scale: 1.75}, revision());
    f.store.patchCast(project.id, revision(), [{trackId: person.id, characterId: character.id, disposition: 'bound'}]);
    const cast = f.store.getCast(project.id);
    assert.deepEqual(cast.pendingTrackIds, [], '动物候选不应出现在未处理清单');
    assert.equal(cast.conflicts.length, 0);
    const approved = f.store.approveCast(project.id, revision());
    assert.equal(approved.approval.status, 'approved', '动物候选不应阻止正式确认');
    // 动物与人物候选不能连接
    assert.throws(() => f.store.mergeTracks(project.id, person.id, animal.id, revision()), error => error.status === 422);
  } finally {f.clean();}
});


test('T01/T03: rerunning one subject never touches the other subject tracks', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    const first = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 0, endFrame: 10, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
      {shotId: 'S01', startFrame: 2, endFrame: 14, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], revision());
    assert.equal(first.length, 2);
    f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 40, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.85, provenance: 'auto', subject: 'animal', species: '猫'},
    ], revision());
    const afterAnimal = f.store.getTracks(project.id).filter(row => row.status === 'active');
    assert.ok(afterAnimal.some(row => row.subject === 'person' && row.id === first[0].id), '人物轨迹必须保留');
    assert.ok(!afterAnimal.some(row => row.id === first[1].id), '旧动物轨迹应被替换');
    assert.ok(afterAnimal.some(row => row.subject === 'animal' && row.species === '猫'), '新动物轨迹带物种');
    f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 42, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
    ], revision());
    const afterPerson = f.store.getTracks(project.id).filter(row => row.status === 'active');
    assert.ok(afterPerson.some(row => row.subject === 'animal' && row.species === '猫'), '动物轨迹必须保留');
    assert.ok(!afterPerson.some(row => row.id === first[0].id), '旧人物轨迹应被替换');
  } finally {f.clean();}
});

test('T02: protected person bindings do not block animal rerun, and vice versa', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    let revision = f.store.getProjectRow(project.id).revision;
    const [person, animal] = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 0, endFrame: 10, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
      {shotId: 'S01', startFrame: 2, endFrame: 12, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], revision);
    const character = f.store.createCharacter(project.id, {name: '主角', color: '#28543F', scale: 1.75}, f.store.getProjectRow(project.id).revision);
    f.store.patchCast(project.id, f.store.getProjectRow(project.id).revision, [{trackId: person.id, characterId: character.id, disposition: 'bound'}]);
    revision = f.store.getProjectRow(project.id).revision;
    const rerunAnimal = f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 40, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], revision);
    assert.equal(rerunAnimal.length, 1, '人工绑定的人物不应阻止动物重跑');
    revision = f.store.getProjectRow(project.id).revision;
    const currentAnimal = f.store.getTracks(project.id).filter(row => row.status === 'active' && row.subject === 'animal').at(-1);
    f.store.patchCast(project.id, revision, [{trackId: currentAnimal.id, disposition: 'ignored'}]);
    // 人物已被人工绑定（受保护）：重跑人物必须 409 且明确提到"人物"，动物不受影响仍保留
    revision = f.store.getProjectRow(project.id).revision;
    assert.throws(() => f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 44, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
    ], revision), error => error.status === 409 && /人物/.test(error.message), '受保护的人物阻止人物重跑');
    assert.ok(f.store.getTracks(project.id).filter(row => row.status === 'active' && row.subject === 'animal').length >= 1, '人物重跑被拒不影响动物');
    // 忽略动物之后重跑动物：受保护动物只阻止动物自身重跑吗？——ignored 属于人工决定，动物重跑同样被保护
    revision = f.store.getProjectRow(project.id).revision;
    assert.throws(() => f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 41, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], revision), error => error.status === 409 && /动物/.test(error.message), '被忽略（人工决定）的动物阻止动物重跑');
  } finally {f.clean();}
});

test('T04: animal split keeps subject and species without creating a person card', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = f.store.getProjectRow(project.id).revision;
    const [animal] = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 0, endFrame: 20, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], revision);
    const before = f.store.getPeople(project.id).length;
    const split = f.store.splitTrack(project.id, animal.id, 10, f.store.getProjectRow(project.id).revision);
    assert.equal(split.subject, 'animal', '拆分出的新轨迹保留 subject');
    assert.equal(split.species, '狗', '拆分出的新轨迹保留物种');
    assert.equal(f.store.getPeople(project.id).length, before, '动物拆分不新建人物卡');
    const [person] = f.store.insertTracks(project.id, [
      {shotId: 'S02', startFrame: 30, endFrame: 40, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
    ], f.store.getProjectRow(project.id).revision);
    const peopleBefore = f.store.getPeople(project.id).length;
    const personSplit = f.store.splitTrack(project.id, person.id, 35, f.store.getProjectRow(project.id).revision);
    assert.equal(personSplit.subject, 'person');
    assert.equal(f.store.getPeople(project.id).length, peopleBefore + 1, '人物拆分新建人物卡');
  } finally {f.clean();}
});

test('T05: animal tracks cannot be assigned into a person identity', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = f.store.getProjectRow(project.id).revision;
    const [person] = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 0, endFrame: 10, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person'},
    ], revision);
    const [animal] = f.store.insertTracks(project.id, [
      {shotId: 'S01', startFrame: 2, endFrame: 12, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.8, provenance: 'auto', subject: 'animal', species: '狗'},
    ], f.store.getProjectRow(project.id).revision);
    const people = f.store.getPeople(project.id);
    assert.equal(people.length, 1, '只有人物身份卡');
    await assert.rejects(async () => f.store.editPeople(project.id, f.store.getProjectRow(project.id).revision,
      {action: 'assign-appearances', personIds: [people[0].id], trackIds: [animal.id]}),
      error => error.status === 422 && /动物/.test(error.message), '动物出场归入人物身份必须 422');
  } finally {f.clean();}
});

test('V2 P2: groups persist proxyLevel and get auto-assigned distinct colors', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    const revision = () => f.store.getProjectRow(project.id).revision;
    const a = f.store.createCharacter(project.id, {name: 'A', scale: 1.75}, revision());
    const b = f.store.createCharacter(project.id, {name: 'B', scale: 1.6}, revision());
    assert.notEqual(a.color, b.color, '自动配色不重复');
    assert.equal(a.proxy_level, 'CL1', '默认 CL1');
    const updated = f.store.updateCharacter(project.id, a.id, {proxyLevel: 'CL0'}, revision());
    assert.equal(updated.proxy_level, 'CL0');
    assert.throws(() => f.store.createCharacter(project.id, {name: 'C', scale: 1.7, rigFamily: 'quadruped'}, revision()),
      error => error.status === 422 && /暂不支持/.test(error.message), '不兼容骨架家族明确拒绝');
    const reopened = f.reopen();
    assert.equal(reopened.getCharacters(project.id).find(row => row.id === a.id).proxy_level, 'CL0', 'CL 持久化（重启后保持）');
  } finally {f.clean();}
});


// ---- V2 P4：多帧外观聚合、稳定身份映射、动物身份层、疑似关联 ----

// 外观描述子：两个 64 桶区域各归一化。base 指定两区域的主色桶。
const look = (bucketA, bucketB) => {
  const descriptor = Array(128).fill(0.001);
  descriptor[bucketA] = 0.9;descriptor[bucketB] = 0.9;
  for (const [start, end] of [[0, 64], [64, 128]]) {
    const sum = descriptor.slice(start, end).reduce((a, b) => a + b, 0);
    for (let index = start; index < end; index++) descriptor[index] /= sum;
  }
  return descriptor;
};
const personSpec = (shotId, from, to, appearance) => ({shotId, startFrame: from, endFrame: to, box: {x: 0.1, y: 0.1, w: 0.2, h: 0.5}, confidence: 0.9, provenance: 'auto', subject: 'person', appearance});
const animalSpec = (shotId, from, to, species, appearance) => ({shotId, startFrame: from, endFrame: to, box: {x: 0.6, y: 0.3, w: 0.3, h: 0.3}, confidence: 0.85, provenance: 'auto', subject: 'animal', species, appearance});

function identityFixture() {
  const f=fixture(), project=f.store.createProject({name:'身份修复回归',sceneMode:'proxy'});
  const rev=()=>f.store.getProjectRow(project.id).revision;
  f.store.insertMedia(project.id,mediaRecord(rev()));
  f.store.replaceShots(project.id,shotsFor(project.id),'auto',rev());
  return {...f,project,rev};
}

test('semantic identities belong to their project even when both projects use P01',()=>{
  const f=fixture();
  try {
    const snapshots=[];
    for(const name of ['第一项目','第二项目']) {
      const project=f.store.createProject({name,sceneMode:'proxy'}),id=project.id;
      const rev=()=>f.store.getProjectRow(id).revision;
      f.store.insertMedia(id,mediaRecord(rev(),{id:`m-${id}`}));
      f.store.replaceShots(id,shotsFor(id),'auto',rev());
      const [track]=f.store.insertTracks(id,[personSpec('S01',0,10,null)],rev(),'person');
      f.store.summarizePeople(id,rev(),new Map(),{groups:[{subjectId:'P01',name:'主角',trackIds:[track.id]}]});
      f.store.ensureProvisionalGroups(id,rev());
      const people=f.store.getPeople(id),cast=f.store.getCast(id);
      assert.equal(people.length,1);assert.deepEqual(people[0].trackIds,[track.id]);
      assert.equal(cast.characters.length,1);assert.deepEqual(cast.pendingTrackIds,[]);
      assert.equal(f.store.db.prepare('SELECT project_id FROM source_people WHERE id=?').get(people[0].id).project_id,id);
      snapshots.push({id,people,cast});
    }
    assert.notEqual(snapshots[0].people[0].id,snapshots[1].people[0].id);
    const reopened=f.reopen();
    for(const snapshot of snapshots)assert.deepEqual(reopened.getPeople(snapshot.id),snapshot.people);
  } finally {f.clean();}
});

test('same-name semantic subjects remain distinct with stable groups on reordered reruns',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    const tracks=f.store.insertTracks(id,[personSpec('S01',0,10,null),personSpec('S01',0,10,null)],f.rev(),'person');
    const groups=tracks.map((track,index)=>({subjectId:`P0${index+1}`,name:'黑衣男子',trackIds:[track.id]}));
    f.store.summarizePeople(id,f.rev(),new Map(),{groups});
    f.store.ensureProvisionalGroups(id,f.rev());
    const before=f.store.getPeople(id),characters=f.store.getCharacters(id);
    assert.equal(before.length,2);assert.equal(characters.length,2);
    assert.equal(f.store.getCast(id).conflicts.length,0);
    f.store.summarizePeople(id,f.rev(),new Map(),{groups:[...groups].reverse()});
    f.store.ensureProvisionalGroups(id,f.rev());
    assert.deepEqual(f.store.getPeople(id),before,'名称和遍历顺序不应决定素材身份或代理组');
    assert.deepEqual(f.store.getCharacters(id),characters);
    assert.equal(f.store.getCast(id).conflicts.length,0);
    // Updating an automatic display name also leaves the subject's identity and group intact.
    f.store.summarizePeople(id,f.rev(),new Map(),{groups:groups.map(group=>({...group,name:'新的显示名'}))});
    f.store.ensureProvisionalGroups(id,f.rev());
    assert.deepEqual(f.store.getPeople(id).map(person=>({id:person.id,assignment:person.assignment,trackIds:person.trackIds})),
      before.map(person=>({id:person.id,assignment:person.assignment,trackIds:person.trackIds})));
    const replacements=f.store.insertTracks(id,[personSpec('S01',1,9,null),personSpec('S01',1,9,null)],f.rev(),'person');
    f.store.summarizePeople(id,f.rev(),new Map(),{groups:groups.map((group,index)=>({...group,trackIds:[replacements[index].id]}))});
    f.store.ensureProvisionalGroups(id,f.rev());
    assert.deepEqual(f.store.getPeople(id).map(person=>({id:person.id,assignment:person.assignment})),
      before.map(person=>({id:person.id,assignment:person.assignment})),'重新检测替换轨迹后仍复用各自身份和自动分组');
    assert.equal(f.store.getCharacters(id).length,2);assert.equal(f.store.getCast(id).conflicts.length,0);
  } finally {f.clean();}
});

test('semantic subject IDs that share a legacy slug do not share an identity',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    const tracks=f.store.insertTracks(id,[personSpec('S01',0,10,null),personSpec('S01',0,10,null)],f.rev(),'person');
    const groups=[{subjectId:'P-A',name:'甲',trackIds:[tracks[0].id]},{subjectId:'P_A',name:'乙',trackIds:[tracks[1].id]}];
    f.store.summarizePeople(id,f.rev(),new Map(),{groups});
    f.store.ensureProvisionalGroups(id,f.rev());
    const before=f.store.getPeople(id);
    assert.equal(before.length,2);assert.notEqual(before[0].id,before[1].id);
    f.store.summarizePeople(id,f.rev(),new Map(),{groups});
    f.store.ensureProvisionalGroups(id,f.rev());
    assert.deepEqual(f.store.getPeople(id),before);
    assert.equal(f.store.getCharacters(id).length,2);
    assert.equal(f.store.getCast(id).conflicts.length,0);
  } finally {f.clean();}
});

test('old semantic-v1 subject keys retain their automatic groups without matching display names',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    const [track]=f.store.insertTracks(id,[personSpec('S01',0,10,null)],f.rev(),'person');
    const groups=[{subjectId:'P01',name:'旧的名称',trackIds:[track.id]}];
    f.store.summarizePeople(id,f.rev(),new Map(),{groups});
    f.store.ensureProvisionalGroups(id,f.rev());
    const person=f.store.getPeople(id)[0],group=f.store.getCharacters(id)[0];
    // Represent a database written by the old implementation, entirely inside this disposable fixture.
    f.store.db.prepare('UPDATE source_people SET id=? WHERE id=?').run('person-p01',person.id);
    f.store.db.prepare('UPDATE tracks SET person_id=? WHERE id=?').run('person-p01',track.id);
    assert.equal(f.store.getPeople(id)[0].id,'person-p01');
    f.store.summarizePeople(id,f.rev(),new Map(),{groups:groups.map(group=>({...group,name:'新的名称'}))});
    f.store.ensureProvisionalGroups(id,f.rev());
    const migrated=f.store.getPeople(id)[0];
    assert.equal(migrated.id,person.id);assert.equal(migrated.assignment,group.id);
    assert.equal(migrated.name,'新的名称');assert.deepEqual(migrated.trackIds,[track.id]);
    assert.deepEqual(f.store.getCharacters(id),[group]);
    f.store.editPeople(id,f.rev(),{action:'review',personIds:[migrated.id]});
    const reviewed=f.store.getPeople(id);
    assert.throws(()=>f.store.summarizePeople(id,f.rev(),new Map(),{groups}),error=>error.status===409);
    assert.deepEqual(f.store.getPeople(id),reviewed,'已核对身份不应被兼容路径迁移或覆盖');
  } finally {f.clean();}
});

test('releasing the last appearance retains the reviewed profile and its provisional group on automatic rerun',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69))],f.rev(),'person');
    f.store.ensureProvisionalGroups(id,f.rev());
    const person=f.store.getPeople(id)[0],group=f.store.getCharacters(id)[0];
    f.store.editPeople(id,f.rev(),{action:'release-appearances',personIds:[person.id],trackIds:person.trackIds});
    const released=f.store.getPeople(id);
    assert.equal(released[0].reviewed,true);assert.equal(released[0].assignment,group.id);
    assert.deepEqual(released[0].trackIds,[]);
    f.store.summarizePeople(id,f.rev());
    assert.deepEqual(f.store.ensureProvisionalGroups(id,f.rev()),[]);
    assert.deepEqual(f.store.getPeople(id),released);
    assert.deepEqual(f.store.getCharacters(id),[group]);
    assert.equal(f.store.getCast(id).bindings[0].disposition,'unassigned');
    const reopened=f.reopen();
    assert.deepEqual(reopened.getPeople(id),released);assert.deepEqual(reopened.getCharacters(id),[group]);
  } finally {f.clean();}
});

test('unreferenced stale automatic groups are removed after their last active appearance is replaced',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    f.store.insertTracks(id,[personSpec('S01',0,10,null)],f.rev(),'person');
    f.store.ensureProvisionalGroups(id,f.rev());
    const person=f.store.getPeople(id)[0],oldGroup=f.store.getCharacters(id)[0];
    f.store.insertTracks(id,[personSpec('S02',24,34,null)],f.rev(),'person');
    f.store.ensureProvisionalGroups(id,f.rev());
    assert.ok(!f.store.getCharacters(id).some(group=>group.id===oldGroup.id));
    assert.ok(!f.store.getCast(id).bindings.some(binding=>binding.character_id===oldGroup.id));
    assert.equal(f.store.db.prepare('SELECT assignment FROM source_people WHERE id=?').get(person.id).assignment,'unassigned');
    assert.equal(f.store.getCharacters(id).length,1,'新身份仍得到一个有效自动组');
  } finally {f.clean();}
});

test('R05: automatic drafts can rerun with stable groups, while user edits and confirmations stay protected',()=>{
  for(const decision of ['none','review','binding','group']) {
    const f=identityFixture(), id=f.project.id;
    try {
      f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69)),personSpec('S02',24,34,look(5,69))],f.rev(),'person');
      f.store.summarizePeople(id,f.rev());
      f.store.ensureProvisionalGroups(id,f.rev());
      const person=f.store.getPeople(id)[0], group=f.store.getCharacters(id)[0];
      if(decision==='review')f.store.editPeople(id,f.rev(),{action:'review',personIds:[person.id]});
      if(decision==='binding')f.store.patchCast(id,f.rev(),[{trackId:person.trackIds[0],characterId:group.id,disposition:'bound'}]);
      if(decision==='group')f.store.updateCharacter(id,group.id,{color:'#123456'},f.rev());
      const rerun=()=>f.store.insertTracks(id,[personSpec('S01',1,9,look(5,69)),personSpec('S02',25,33,look(5,69))],f.rev(),'person');
      if(decision!=='none') {assert.throws(rerun,error=>error.status===409,decision);continue;}
      rerun();f.store.summarizePeople(id,f.rev());f.store.ensureProvisionalGroups(id,f.rev());
      assert.equal(f.store.getPeople(id)[0].id,person.id);
      assert.equal(f.store.getPeople(id)[0].assignment,group.id);
      assert.equal(f.store.getCharacters(id).length,1,'重跑不应重复生成临时组');
      assert.ok(f.store.getCast(id).bindings.filter(binding=>f.store.getTracks(id).some(track=>track.id===binding.track_id&&track.status==='active')).every(binding=>binding.updated_by==='auto'));
    } finally {f.clean();}
  }
});

test('R06: stable identity reuse never adds a new appearance to a reviewed identity or merges co-occurring people',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    const [first]=f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69))],f.rev(),'person');
    f.store.summarizePeople(id,f.rev());
    const reviewed=f.store.getPeople(id)[0];
    f.store.editPeople(id,f.rev(),{action:'review',personIds:[reviewed.id]});
    const second=f.store.insertTrack(id,'S01',{...personSpec('S01',2,12,look(5,69)),provenance:'user'},f.rev());
    f.store.summarizePeople(id,f.rev(),new Map([[second.id,look(5,69)]]));
    const people=f.store.getPeople(id);
    assert.equal(people.length,2);
    assert.deepEqual(people.find(person=>person.id===reviewed.id).trackIds,[first.id]);
    assert.notEqual(f.store.getTracks(id).find(track=>track.id===second.id).person_id,reviewed.id);
  } finally {f.clean();}
});

test('R08: explicit successful scopes replace zero detections and reject out-of-scope writes atomically',()=>{
  for(const scope of ['person','animal','both']) {
    const f=identityFixture(),id=f.project.id;
    try {
      const initial=f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69)),animalSpec('S01',0,10,'狗',look(40,70))],f.rev(),'both');
      f.store.insertTracks(id,[],f.rev(),scope);
      const active=f.store.getTracks(id).filter(track=>track.status==='active');
      assert.deepEqual(active.map(track=>track.subject),scope==='both'?[]:[scope==='person'?'animal':'person']);
      assert.ok(initial.every(track=>f.store.getTracks(id).some(row=>row.id===track.id)),'替换保留审计历史');
    } finally {f.clean();}
  }
  const f=identityFixture(),id=f.project.id;
  try {
    const initial=f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69)),animalSpec('S01',0,10,'狗',look(40,70))],f.rev(),'both');
    assert.throws(()=>f.store.insertTracks(id,[personSpec('S02',24,34,look(5,69))],f.rev(),['animal']),error=>error.status===422);
    assert.ok(f.store.getTracks(id).every(track=>track.status==='active'));
    f.store.insertTracks(id,[personSpec('S02',24,34,look(5,69))],f.rev(),['person','animal']);
    assert.equal(f.store.getTracks(id).filter(track=>track.status==='active'&&track.subject==='animal').length,0);
    const current=f.store.getPeople(id)[0];
    f.store.editPeople(id,f.rev(),{action:'review',personIds:[current.id]});
    assert.throws(()=>f.store.insertTracks(id,[],f.rev(),'person'),error=>error.status===409);
    assert.equal(f.store.getTracks(id).filter(track=>track.status==='active').length,1);
    assert.equal(initial.length,2);
  } finally {f.clean();}
});

test('R09: count-guided human summaries preserve reviewed and unreviewed animal identities exactly',()=>{
  for(const reviewed of [false,true]) {
    const f=identityFixture(),id=f.project.id;
    try {
      f.store.insertTracks(id,[personSpec('S01',0,10,look(5,69)),animalSpec('S01',0,10,'狗',look(40,70)),animalSpec('S02',24,34,'狗',look(40,70))],f.rev(),'both');
      f.store.summarizeAnimalEntities(id,f.rev());
      const animal=f.store.getPeople(id).find(person=>person.subject==='animal');
      if(reviewed)f.store.editPeople(id,f.rev(),{action:'rename',personIds:[animal.id],name:'用户确认的小狗'});
      const before=f.store.getPeople(id).find(person=>person.id===animal.id);
      f.store.updateProject(id,{sourcePeopleCount:1},f.rev());
      f.store.summarizePeople(id,f.rev());
      assert.deepEqual(f.store.getPeople(id).find(person=>person.id===animal.id),before);
      assert.equal(f.store.getPeople(id).filter(person=>person.subject==='person').length,1);
    } finally {f.clean();}
  }
});

test('R12: animal identities support split, release and same-species reassignment without losing subject or manual decisions',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    f.store.insertTracks(id,[animalSpec('S01',0,10,'狗',look(5,69)),animalSpec('S02',24,34,'狗',look(5,69)),animalSpec('S02',36,44,'马',look(5,69))],f.rev(),'animal');
    f.store.summarizeAnimalEntities(id,f.rev());
    const dog=f.store.getPeople(id).find(person=>person.species==='狗'), horse=f.store.getPeople(id).find(person=>person.species==='马');
    const splitTrackId=dog.trackIds[1];
    f.store.editPeople(id,f.rev(),{action:'split',personIds:[dog.id],trackIds:[splitTrackId],name:'第二只狗'});
    const split=f.store.getPeople(id).find(person=>person.name==='第二只狗');
    assert.equal(split.subject,'animal');assert.equal(split.species,'狗');assert.ok(split.reviewed);
    f.store.editPeople(id,f.rev(),{action:'release-appearances',personIds:[split.id],trackIds:[splitTrackId]});
    assert.equal(f.store.getTracks(id).find(track=>track.id===splitTrackId).person_id,null);
    f.store.summarizeAnimalEntities(id,f.rev());
    assert.equal(f.store.getTracks(id).find(track=>track.id===splitTrackId).person_id,null,'自动整理不得撤销手工释放');
    assert.ok(f.store.getPeople(id).some(person=>person.id===split.id&&person.trackIds.length===0),'空的人工身份仍可接收后续出场');
    assert.throws(()=>f.store.editPeople(id,f.rev(),{action:'assign-appearances',personIds:[horse.id],trackIds:[splitTrackId]}),error=>error.status===422);
    assert.throws(()=>f.store.editPeople(id,f.rev(),{action:'assign-appearances',personIds:[dog.id]}),error=>error.status===400);
    f.store.editPeople(id,f.rev(),{action:'assign-appearances',personIds:[dog.id],trackIds:[splitTrackId]});
    assert.equal(f.store.getPeople(id).find(person=>person.id===dog.id).trackIds.length,2);
    const snapshot=f.store.getPeople(id);
    f.store.summarizeAnimalEntities(id,f.rev());
    assert.deepEqual(f.store.getPeople(id),snapshot,'自动整理不改已确认动物');
    f.store.editPeople(id,f.rev(),{action:'merge',personIds:[dog.id,split.id]});
    assert.ok(!f.store.getPeople(id).some(person=>person.id===split.id),'显式合并应移除被合并的空身份卡');
  } finally {f.clean();}
});

test('animal manual annotations persist species and expose an animal identity for correction',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    const track=f.store.insertTrack(id,'S01',{...animalSpec('S01',0,10,'狗',null),provenance:'user'},f.rev());
    assert.equal(track.subject,'animal');assert.equal(track.species,'狗');
    const animal=f.store.getPeople(id)[0];
    assert.equal(animal.subject,'animal');assert.equal(animal.species,'狗');assert.deepEqual(animal.trackIds,[track.id]);
    assert.throws(()=>f.store.insertTrack(id,'S01',{...animalSpec('S01',0,10,' ',null),provenance:'user'},f.rev()),error=>error.status===400);
    assert.throws(()=>f.store.insertTrack(id,'S01',{...animalSpec('S01',0,10,'狗',null),subject:'invalid',provenance:'user'},f.rev()),error=>error.status===400);
    f.store.editPeople(id,f.rev(),{action:'rename',personIds:[animal.id],name:'补标小狗'});
    const reopened=f.reopen();
    assert.equal(reopened.getPeople(id)[0].name,'补标小狗');
  } finally {f.clean();}
});

test('R12: co-occurring animal individuals cannot be merged or assigned into one source identity',()=>{
  const f=identityFixture(),id=f.project.id;
  try {
    f.store.insertTracks(id,[animalSpec('S01',0,10,'狗',look(5,69)),animalSpec('S01',5,15,'狗',look(5,69))],f.rev(),'animal');
    f.store.summarizeAnimalEntities(id,f.rev());
    const [a,b]=f.store.getPeople(id);
    assert.throws(()=>f.store.editPeople(id,f.rev(),{action:'merge',personIds:[a.id,b.id]}),error=>error.status===422);
    assert.throws(()=>f.store.editPeople(id,f.rev(),{action:'assign-appearances',personIds:[a.id],trackIds:b.trackIds}),error=>error.status===422);
    assert.equal(f.store.getPeople(id).length,2);
  } finally {f.clean();}
});

test('P4: aggregateAppearance takes the per-bin median and renormalizes', async () => {
  const {aggregateAppearance} = await import('../studio/people.mjs');
  const frames = [
    [...look(10, 70)],          // 帧间有噪声桶
    [...look(10, 70)],
    [...look(12, 70)],          // 一帧漂移
  ].map(appearance => ({appearance}));
  const aggregated = aggregateAppearance(frames);
  assert.equal(aggregated.length, 128);
  assert.ok(aggregated[10] > 0.4 && aggregated[10] >= aggregated[12], '中位数应抵抗单帧漂移');
  const sumA = aggregated.slice(0, 64).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sumA - 1) < 1e-6, '区域应重新归一化');
  assert.equal(aggregateAppearance([{appearance: null}, {appearance: undefined}]), null);
});

test('P4: summarize reuses stable identity ids when appearance is consistent across reruns', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    // 首次：红衣人（S01）与蓝衣人（S02）
    f.store.insertTracks(project.id, [
      personSpec('S01', 0, 10, look(5, 69)),
      personSpec('S02', 24, 34, look(5, 69)),
      personSpec('S01', 12, 20, look(40, 70)),
      personSpec('S02', 36, 44, look(40, 70)),
    ], revision());
    const first = f.store.summarizePeople(project.id, revision());
    const redFirst = first.find(person => person.trackIds.length === 2 && person.method !== 'legacy');
    assert.ok(redFirst, '应聚出两个身份');
    const beforeIds = first.map(person => person.id).sort();
    // 第二次重跑：模拟完整重检测（替换全部自动出场后重新汇总），同外观 → 同 ID 复用
    f.store.insertTracks(project.id, [
      personSpec('S01', 1, 9, look(5, 69)),
      personSpec('S02', 25, 33, look(5, 69)),
      personSpec('S01', 13, 19, look(40, 70)),
      personSpec('S02', 37, 45, look(40, 70)),
    ], revision());
    const second = f.store.summarizePeople(project.id, revision());
    const afterIds = second.filter(person => person.trackIds.length >= 2).map(person => person.id).sort();
    assert.deepEqual(afterIds, beforeIds, '重跑后身份 ID 应保持稳定');
    const names = second.map(person => person.name);
    assert.ok(names.every((name, index) => names.indexOf(name) === index), '身份名称不应重复漂移');
  } finally {f.clean();}
});

test('P4: animal entities are per-species, stable, and cannot merge across species', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    f.store.insertTracks(project.id, [
      animalSpec('S01', 0, 10, '狗', look(5, 69)),
      animalSpec('S02', 24, 34, '狗', look(5, 69)),
      animalSpec('S01', 12, 20, '马', look(5, 69)),
    ], revision());
    const entities = f.store.summarizeAnimalEntities(project.id, revision());
    const dogs = entities.filter(person => person.subject === 'animal' && person.species === '狗');
    const horses = entities.filter(person => person.subject === 'animal' && person.species === '马');
    assert.equal(dogs.length, 1, '同物种相似出场应聚为一个个体');
    assert.equal(horses.length, 1, '马单独成身份');
    assert.equal(dogs[0].trackIds.length, 2);
    const dogId = dogs[0].id;
    // 重跑稳定映射（重检测会替换全部自动动物出场，需同时重插马，模拟真实重跑）
    f.store.insertTracks(project.id, [
      animalSpec('S02', 36, 44, '狗', look(5, 69)),
      animalSpec('S01', 12, 20, '马', look(5, 69)),
    ], revision());
    const rerun = f.store.summarizeAnimalEntities(project.id, f.store.getProjectRow(project.id).revision);
    assert.ok(rerun.some(person => person.id === dogId && person.species === '狗'), '重跑后动物个体 ID 稳定');
    // 跨物种合并拒绝；与人物合并拒绝
    f.store.insertTracks(project.id, [personSpec('S02', 30, 40, look(30, 70))], f.store.getProjectRow(project.id).revision);
    f.store.summarizePeople(project.id, f.store.getProjectRow(project.id).revision);
    const horse = rerun.find(person => person.species === '马');
    const dog = rerun.find(person => person.id === dogId);
    const personEntity = f.store.getPeople(project.id).find(person => (person.subject || 'person') === 'person');
    assert.ok(personEntity, '需要一个人物身份用于跨类合并拒绝测试');
    await assert.rejects(async () => f.store.editPeople(project.id, f.store.getProjectRow(project.id).revision, {action: 'merge', personIds: [dog.id, horse.id]}),
      error => error.status === 422 && /物种/.test(error.message));
    await assert.rejects(async () => f.store.editPeople(project.id, f.store.getProjectRow(project.id).revision, {action: 'merge', personIds: [dog.id, personEntity.id]}),
      error => error.status === 422 && /人物与动物/.test(error.message));
    // 动物实体不能指派到叙事角色组（P7 前不开放）
    const character = f.store.createCharacter(project.id, {name: 'X', scale: 1.0}, f.store.getProjectRow(project.id).revision);
    await assert.rejects(async () => f.store.editPeople(project.id, f.store.getProjectRow(project.id).revision, {action: 'assign', personIds: [dog.id], assignment: character.id}),
      error => error.status === 422 && /动物叙事组/.test(error.message));
    // 忽略动物身份可用
    f.store.editPeople(project.id, f.store.getProjectRow(project.id).revision, {action: 'assign', personIds: [horse.id], assignment: 'ignored'});
    assert.ok(true, '忽略动物身份可用');
  } finally {f.clean();}
});

test('P4: entity suggestions expose over-split pairs for manual merging', async () => {
  const f = fixture();
  try {
    const project = f.store.createProject({name: 'p', sceneMode: 'proxy'});
    f.store.insertMedia(project.id, mediaRecord(f.store.getProjectRow(project.id).revision));
    f.store.replaceShots(project.id, shotsFor(project.id), 'auto', f.store.getProjectRow(project.id).revision);
    const revision = () => f.store.getProjectRow(project.id).revision;
    // 同镜同装且时间重叠：不能自动合并（同镜冲突），但应出现疑似关联
    f.store.insertTracks(project.id, [
      personSpec('S01', 0, 10, look(5, 69)),
      personSpec('S01', 5, 15, look(5, 69)),
    ], revision());
    f.store.summarizePeople(project.id, revision());
    const suggestions = f.store.getEntitySuggestions(project.id);
    assert.ok(suggestions.length >= 1, '同镜同装对应给出疑似关联');
    assert.ok(suggestions[0].score >= 0.84);
    assert.notEqual(suggestions[0].a, suggestions[0].b);
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
