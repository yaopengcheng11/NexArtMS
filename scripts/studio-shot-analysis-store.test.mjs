import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudioStore, SCHEMA_VERSION} from '../studio/db.mjs';
import {createShotAnalysisStore} from '../studio/shot-analysis-store.mjs';
import {ANNOTATION_ENUMS} from '../studio/shot-analysis-schema.mjs';

function fixture({empty = false, vfr = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analysis-store-'));
  const store = createStudioStore(root), analysis = createShotAnalysisStore(store, root);
  const p = store.createProject({name: 'fixture'}), id = p.id;
  const pts = Array.from({length: 12}, (_, i) => vfr ? [0, .03, .07, .10, .16, .19, .23, .27, .31, .35, .39, .43][i] : i / 24);
  const duration = vfr ? 470000 : 500000;
  fs.writeFileSync(path.join(store.projectDir(id), 'pts.json'), JSON.stringify({pts}));
  store.insertMedia(id, {id: 'm-fixture', sha256: 'a'.repeat(64), originalName: 'source.mp4', originalRef: 'media/source.mp4', proxyRef: 'proxies/preview.mp4',
    durationUs: duration, width: 640, height: 360, rotation: 0, timebase: '1/1000000', fpsNum: 24, fpsDen: 1, vfr, videoCodec: 'h264', audioCodec: null,
    ptsCount: pts.length, ptsMapRef: `data/projects/${id}/pts.json`, sizeBytes: 100, baseRevision: p.revision});
  const cuts = (frames = [0, 4, 8, 12]) => frames.slice(0, -1).map((frame, i) => ({id: `S${String(i + 1).padStart(2, '0')}`, startFrame: frame, endFrameExclusive: frames[i + 1],
    startUs: Math.round(pts[frame] * 1e6), endUs: frames[i + 1] === pts.length ? duration : Math.round(pts[frames[i + 1]] * 1e6)}));
  const revision = () => store.getProjectRow(id).revision;
  if (!empty) store.replaceShots(id, cuts(), 'auto', revision());
  const frames = shot => [{frameIndex: shot.startFrame, ptsUs: shot.startUs, imageRef: `frames/${shot.startFrame}.jpg`}];
  const annotation = shot => ({size: ANNOTATION_ENUMS.size[0], category: ANNOTATION_ENUMS.category[0], camera: ANNOTATION_ENUMS.camera[0],
    frame: '画面描述', action: '主体走动', composition: '主体位于中心', scene: '室内', subjects: [], evidenceFrames: [shot.startFrame]});
  return {root, store, analysis, id, pts, cuts, revision, frames, annotation,
    clean: () => {try {store.close();} catch {}assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('studio-analysis-store-'));fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}};
}

test('new model runs do not relabel old generated semantics, while keeping manual overrides', () => {
  const f = fixture();try {
    let run = f.analysis.createRun(f.id, {provider: 'fixture', model: 'model-A'});
    const shot = run.shots[0];
    run = f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: f.annotation(shot), status: 'analyzed'});
    f.analysis.editShot(f.id, run.id, shot.id, {baseRevision: run.revision, overrides: {action: '人工确认：挥手'}});
    const same = f.analysis.createRun(f.id, {provider: 'fixture', model: 'model-A'});
    assert.ok(same.shots[0].generated);
    const changed = f.analysis.createRun(f.id, {provider: 'fixture', model: 'model-B'});
    assert.equal(changed.shots[0].generated, null);assert.equal(changed.shots[0].effective.action, '人工确认：挥手');
    assert.equal(f.analysis.getRun(f.id, run.id).model, 'model-A');assert.ok(f.analysis.getRun(f.id, run.id).shots[0].generated);
  } finally {f.clean();}
});

test('empty upload run initializes after first cuts, leaves project progress revision alone', () => {
  const f = fixture({empty: true});try {
    assert.equal(f.analysis.getRun(f.id), null);
    assert.equal(f.analysis.getRun(f.id, 'missing'), null);
    const run = f.analysis.createRun(f.id);
    assert.equal(run.shots.length, 0);
    assert.equal(run.stage, 'proxy');
    f.store.replaceShots(f.id, f.cuts(), 'auto', f.revision());
    f.analysis.setShots(f.id, run.id, f.cuts());
    assert.equal(f.analysis.assertCurrent(f.id, run.id), true);
    assert.equal(f.analysis.getRun(f.id).shots.length, 3);
    const revision = f.revision();
    f.analysis.updateRun(f.id, run.id, {stage: 'analyze', progress: .5});
    assert.equal(f.revision(), revision);
    assert.throws(() => f.analysis.setShots(f.id, run.id, f.cuts()), e => e.status === 409);
  } finally {f.clean();}
});

test('run signatures use boundaries and source, not sequential IDs or unrelated project revisions', () => {
  const f = fixture();try {
    const run = f.analysis.createRun(f.id);
    f.store.db.prepare("UPDATE shots SET id='new-' || id WHERE project_id=?").run(f.id);
    f.store.createCharacter(f.id, {name: '甲', color: '#112233', scale: 1.7}, f.revision());
    assert.equal(f.analysis.assertCurrent(f.id, run.id), true);
    f.store.db.prepare('UPDATE media SET sha256=? WHERE project_id=?').run('b'.repeat(64), f.id);
    assert.throws(() => f.analysis.updateRun(f.id, run.id, {progress: .8}), e => e.status === 409);
    assert.equal(f.analysis.getRun(f.id, run.id).status, 'stale', 'source mismatch is persisted, not left processing');
  } finally {f.clean();}
});

test('machine updates preserve manual fields and optimistic edits reject stale run revisions', () => {
  const f = fixture();try {
    let run = f.analysis.createRun(f.id), shot = run.shots[0];
    run = f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: f.annotation(shot), status: 'analyzed'});
    const previous = run.revision;
    run = f.analysis.editShot(f.id, run.id, shot.id, {overrides: {action: '人工确认：挥手'}, baseRevision: previous});
    assert.throws(() => f.analysis.editShot(f.id, run.id, shot.id, {overrides: {action: '迟到修改'}, baseRevision: previous}), e => e.status === 409);
    run = f.analysis.updateShot(f.id, run.id, shot.id, {generated: {...f.annotation(shot), action: '模型新结果'}, status: 'analyzed'}, {shotRevision: shot.shotRevision});
    assert.equal(run.shots[0].generated.action, '模型新结果');
    assert.equal(run.shots[0].effective.action, '人工确认：挥手');
    assert.equal(run.shots[0].status, 'user_edited');
    assert.equal(run.counts.userEdited, 1);
    assert.throws(() => f.analysis.updateShot(f.id, run.id, shot.id, {status: 'pending'}, {shotRevision: 'wrong'}), e => e.status === 409);
    assert.throws(() => f.analysis.editShot(f.id, run.id, shot.id, {overrides: {startFrame: 99}, baseRevision: run.revision}), e => e.status === 400);
  } finally {f.clean();}
});

test('evidence and candidate times respect VFR PTS, bounds, subject references and safe relative paths', () => {
  const f = fixture({vfr: true});try {
    let run = f.analysis.createRun(f.id), shot = run.shots[0];
    for (const evidence of [{...f.frames(shot)[0], ptsUs: 1}, {...f.frames(shot)[0], imageRef: '../private.jpg'}, {...f.frames(shot)[0], imageRef: 'C:\\private.jpg'}, {...f.frames(shot)[0], frameIndex: shot.endFrameExclusive}]) {
      assert.throws(() => f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: [evidence]}), e => e.status === 400);
    }
    assert.throws(() => f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: {...f.annotation(shot), subjects: ['undeclared']}}), e => e.status === 400);
    run = f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: f.annotation(shot)});
    const bad = f.cuts([0, 2, 8, 12]);bad[0].endUs += 1;bad[1].startUs += 1;
    assert.throws(() => f.analysis.createRun(f.id, {candidate: true, shots: bad}), e => e.status === 400);
    assert.throws(() => f.analysis.createRun(f.id, {candidate: true, shots: f.cuts([0, 2, 8])}), e => e.status === 400);
    assert.equal(f.analysis.createRun(f.id, {candidate: true, shots: f.cuts([0, 2, 8, 12])}).shots[0].endUs, 70000);
  } finally {f.clean();}
});

test('new run preserves exact-boundary manual overrides and never transfers them to a reused S01', () => {
  const f = fixture();try {
    let old = f.analysis.createRun(f.id);
    old = f.analysis.editShot(f.id, old.id, 'S01', {overrides: {action: '第一镜人工'}, baseRevision: old.revision});
    old = f.analysis.editShot(f.id, old.id, 'S03', {overrides: {action: '第三镜人工'}, baseRevision: old.revision});
    const fresh = f.analysis.createRun(f.id, {reuse: false, sourceRunId: old.id});
    assert.equal(fresh.shots[0].overrides.action, '第一镜人工');
    assert.equal(fresh.shots[0].generated, null);
    const candidate = f.analysis.createRun(f.id, {candidate: true, sourceRunId: old.id, shots: f.cuts([0, 2, 8, 12])});
    assert.deepEqual(candidate.shots[0].overrides, {});
    assert.notEqual(candidate.shots[0].id, 'S01');
    assert.equal(candidate.shots[2].id, 'S03');
    assert.equal(candidate.shots[2].overrides.action, '第三镜人工');
    assert.equal(f.store.getShots(f.id)[0].end_frame_exclusive, 4);
  } finally {f.clean();}
});

test('adoption preserves unchanged motions and manual groups while archiving affected downstream data', () => {
  const f = fixture();try {
    const a = f.store.insertTrack(f.id, 'S01', {startFrame: 0, endFrame: 3, box: {x: .1, y: .1, w: .2, h: .3}, provenance: 'user'}, f.revision());
    const b = f.store.insertTrack(f.id, 'S03', {startFrame: 8, endFrame: 11, box: {x: .1, y: .1, w: .2, h: .3}, provenance: 'user'}, f.revision());
    const character = f.store.createCharacter(f.id, {name: '叙事主角', color: '#112233', scale: 1.7}, f.revision());
    f.store.patchCast(f.id, f.revision(), [a, b].map(t => ({trackId: t.id, characterId: character.id, disposition: 'bound'})));
    f.store.setMotionRef(f.id, a.id, 'motions/old.json');f.store.setMotionRef(f.id, b.id, 'motions/unchanged.json');
    for (const shotId of ['S01', 'S03']) f.store.saveCameraTrack(f.id, shotId, {source: 'manual', intrinsics: {}, extrinsics: {}, confidence: 1, medianErrorPx: 0, evidence: {baseRevision: f.revision()}});
    const history = f.analysis.createRun(f.id);
    let run = f.analysis.createRun(f.id, {candidate: true, shots: f.cuts([0, 2, 8, 12])});
    run = f.analysis.updateRun(f.id, run.id, {status: 'blocked', error: 'fixture has no provider'});
    assert.throws(() => f.analysis.adoptRun(f.id, run.id, 'old-revision'), e => e.status === 409);
    run = f.analysis.adoptRun(f.id, run.id, f.revision());
    assert.equal(run.candidate, false);
    assert.equal(f.analysis.assertCurrent(f.id, run.id), true);
    const tracks = f.store.getTracks(f.id);
    assert.equal(tracks.find(t => t.id === a.id).status, 'stale');
    assert.equal(tracks.find(t => t.id === a.id).motion_ref, 'motions/old.json');
    assert.equal(tracks.find(t => t.id === b.id).status, 'active');
    assert.equal(tracks.find(t => t.id === b.id).motion_ref, 'motions/unchanged.json');
    assert.equal(f.store.getCharacters(f.id)[0].name, '叙事主角');
    assert.equal(f.store.getCast(f.id).bindings.length, 2);
    assert.equal(f.store.getCameraTracks(f.id).length, 1);
    assert.equal(f.store.getCameraTracks(f.id)[0].shot_id, 'S03');
    assert.equal(run.adoption.archivedCameras.length, 1);
    assert.deepEqual(run.adoption.staleTrackIds, [a.id]);
    assert.equal(f.analysis.getRun(f.id, history.id).status, 'stale');
    assert.throws(() => f.analysis.updateShot(f.id, history.id, 'S01', {status: 'analyzed'}), e => e.status === 409);
  } finally {f.clean();}
});

test('candidate split IDs never consume unchanged IDs, even when incoming labels are duplicated', () => {
  const f = fixture();try {
    const shots = f.cuts([0, 2, 4, 8, 12]);
    // Labels are display input only. The altered intervals must get their own IDs.
    shots[0].id = 'S03';shots[1].id = 'S03';shots[2].id = 'S02';shots[3].id = 'S03';
    const run = f.analysis.createRun(f.id, {candidate: true, shots});
    assert.equal(new Set(run.shots.map(s => s.id)).size, 4);
    assert.ok(run.shots[0].id.startsWith('S-'));
    assert.ok(run.shots[1].id.startsWith('S-'));
    assert.equal(run.shots[2].id, 'S02');
    assert.equal(run.shots[3].id, 'S03');
  } finally {f.clean();}
});

test('external cut changes reject late generated annotations and stale candidate adoption', () => {
  const f = fixture();try {
    const run = f.analysis.createRun(f.id, {candidate: true, shots: f.cuts([0, 2, 8, 12])});
    f.store.replaceShots(f.id, f.cuts([0, 6, 12]), 'user', f.revision());
    assert.throws(() => f.analysis.updateShot(f.id, run.id, run.shots[0].id, {status: 'failed'}), e => e.status === 409);
    assert.equal(f.analysis.getRun(f.id, run.id).status, 'stale');
    assert.match(f.analysis.getRun(f.id, run.id).error, /活动切点已变化/);
    assert.throws(() => f.analysis.adoptRun(f.id, run.id, f.revision()), e => e.status === 409);
    f.analysis.invalidateRuns(f.id, '用户改切点');
    assert.equal(f.analysis.getRun(f.id).status, 'stale');
    assert.ok(fs.existsSync(f.analysis.runDirectory(f.id, run.id)));
  } finally {f.clean();}
});

test('cancelled run blocks late work, explicit resume preserves artifacts only on latest valid version', () => {
  const f = fixture();try {
    let run = f.analysis.createRun(f.id), shot = run.shots[0];
    run = f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: f.annotation(shot), status: 'analyzed'});
    f.analysis.updateRun(f.id, run.id, {status: 'cancelled'});
    assert.throws(() => f.analysis.updateShot(f.id, run.id, shot.id, {generated: f.annotation(shot)}), e => e.status === 409);
    assert.throws(() => f.analysis.updateRun(f.id, run.id, {status: 'processing'}), e => e.status === 409);
    run = f.analysis.resumeRun(f.id, run.id);
    assert.equal(run.shots[0].generated.action, '主体走动');
    assert.equal(run.shots[0].evidenceFrames.length, 1);
    f.analysis.updateRun(f.id, run.id, {status: 'cancelled'});
    f.analysis.createRun(f.id);
    assert.throws(() => f.analysis.resumeRun(f.id, run.id), e => e.status === 409);
  } finally {f.clean();}
});

test('v8 migration preserves projects, source identities and groups, adds analysis tables and backup', () => {
  const f = fixture();let migrated;try {
    f.store.createCharacter(f.id, {name: '保留的组', color: '#123456', scale: 1.8}, f.revision());
    f.store.db.exec('DROP TABLE shot_annotations; DROP TABLE shot_analysis_runs; PRAGMA user_version=8');
    f.store.close();
    migrated = createStudioStore(f.root);
    assert.equal(migrated.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.equal(migrated.getCharacters(f.id)[0].name, '保留的组');
    assert.equal(migrated.getShots(f.id).length, 3);
    assert.ok(fs.readdirSync(path.join(f.root, 'data')).some(name => name.startsWith('studio-before-v9-')));
    assert.equal(createShotAnalysisStore(migrated, f.root).createRun(f.id).shots.length, 3);
  } finally {migrated?.close();f.clean();}
});

test('restart marks interrupted analysis failed; read-only store opening preserves status and completed rows', () => {
  const f = fixture();let reopened;try {
    let run = f.analysis.createRun(f.id), shot = run.shots[0];
    run = f.analysis.updateShot(f.id, run.id, shot.id, {evidenceFrames: f.frames(shot), generated: f.annotation(shot), status: 'analyzed'});
    f.store.close();
    reopened = createStudioStore(f.root, {recoverInterrupted: false});
    assert.equal(createShotAnalysisStore(reopened, f.root).getRun(f.id).status, 'processing');
    reopened.close();reopened = createStudioStore(f.root);
    const restored = createShotAnalysisStore(reopened, f.root).getRun(f.id);
    assert.equal(restored.status, 'failed');
    assert.match(restored.error, /重启/);
    assert.equal(restored.shots[0].generated.action, '主体走动');
  } finally {reopened?.close();f.clean();}
});
