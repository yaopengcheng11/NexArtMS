import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudioStore} from '../studio/db.mjs';
import {createShotAnalysisStore} from '../studio/shot-analysis-store.mjs';
import {importSessionAnalysis} from '../studio/shot-analysis-session.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-session-review-'));
  const store = createStudioStore(root), analysisStore = createShotAnalysisStore(store, root), project = store.createProject({name: 'session fixture'}), projectId = project.id;
  const pts = Array.from({length: 12}, (_, i) => i / 12);
  fs.writeFileSync(path.join(root, 'pts.json'), JSON.stringify({pts}));
  store.insertMedia(projectId, {id: 'm-session', sha256: 'b'.repeat(64), originalName: 'source.mp4', originalRef: 'source.mp4', proxyRef: 'source.mp4', durationUs: 1000000, width: 120, height: 80, rotation: 0, timebase: '1/12000', fpsNum: 12, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: null, ptsCount: 12, ptsMapRef: 'pts.json', sizeBytes: 100, baseRevision: project.revision});
  store.replaceShots(projectId, [{id: 'S01', startFrame: 0, endFrameExclusive: 6, startUs: 0, endUs: 500000}, {id: 'S02', startFrame: 6, endFrameExclusive: 12, startUs: 500000, endUs: 1000000}], 'auto', store.getProjectRow(projectId).revision);
  let source = analysisStore.createRun(projectId);
  const directory = analysisStore.runDirectory(projectId, source.id);
  fs.mkdirSync(path.join(directory, 'frames'), {recursive: true});
  for (const shot of source.shots) {
    const frameIndex = shot.startFrame, imageRef = `frames/${frameIndex}.jpg`;
    fs.writeFileSync(path.join(directory, imageRef), Buffer.from([255, 216, 255, 217]));
    source = analysisStore.updateShot(projectId, source.id, shot.id, {evidenceFrames: [{frameIndex, ptsUs: shot.startUs, imageRef}]});
  }
  source = analysisStore.editShot(projectId, source.id, 'S01', {baseRevision: source.revision, overrides: {action: '用户保留的动作修正'}});
  const input = {projectId, sourceRunId: source.id, sourceRunRevision: source.revision, mediaHash: source.mediaHash, shotSetHash: source.shotSetHash,
    provenance: {kind: 'assistant-session', label: '本次会话视觉分析'}, summary: 'fixture，仅验证会话结果导入、版本和证据，不声称真实视觉能力。',
    subjects: [{id: 'P1', kind: 'person', name: '人物一', description: '测试主体', referenceFrames: [0, 6], uncertain: true}], issues: [],
    annotations: source.shots.map(shot => ({shotId: shot.id, annotation: {size: 'medium', category: 'subject', camera: 'static', frame: '测试画面中主体处于画面中央，地面与背景清楚可见。', action: '站立', composition: '主体居中', scene: '测试场地', subjects: ['P1'], evidenceFrames: [shot.startFrame], uncertainties: ['这是测试夹具，无法确认真实动作']}}))};
  const run = value => importSessionAnalysis({store, analysisStore, root, input: value ?? input});
  return {root, directory, store, analysisStore, source, projectId, input, run, cleanup: () => {store.close();assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('studio-session-review-'));fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}};
}

test('session review creates a complete independent report and preserves source and manual edits', async () => {
  const f = fixture();try {
    const before = f.analysisStore.getRun(f.projectId, f.source.id);
    const result = await f.run();
    assert.notEqual(result.id, before.id);assert.equal(result.provider, 'codex-session');assert.equal(result.model, 'session-visual-review');
    assert.equal(result.parameters.analysisSource, 'assistant-session');assert.equal(result.counts.analyzed, 2);assert.equal(result.status, 'ready_with_issues');
    assert.equal(result.shots[0].effective.action, '用户保留的动作修正');assert.equal(result.shots[0].generated.action, '站立');
    assert.deepEqual(f.analysisStore.getRun(f.projectId, before.id), before);
    const dir = f.analysisStore.runDirectory(f.projectId, result.id);
    assert.ok(fs.existsSync(path.join(dir, 'report.html')));assert.ok(fs.existsSync(path.join(dir, 'session-input.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'))).counts.analyzed, 2);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'frames/0.jpg')), fs.readFileSync(path.join(f.directory, 'frames/0.jpg')));
  } finally {f.cleanup();}
});

test('invalid, incomplete, stale or nonexistent evidence is rejected before new run creation', async () => {
  for (const mutate of [
    input => input.annotations.pop(),
    input => input.annotations[1] = input.annotations[0],
    input => input.annotations[0].annotation.evidenceFrames = [99],
    input => input.annotations[0].annotation.subjects = ['missing'],
    input => input.sourceRunRevision = 'stale',
    input => input.provenance.kind = 'pretend-api',
  ]) {
    const f = fixture();try {mutate(f.input);await assert.rejects(f.run());assert.equal(f.analysisStore.getRun(f.projectId).id, f.source.id);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM shot_analysis_runs').get().n, 1);} finally {f.cleanup();}
  }
  const f = fixture();try {fs.writeFileSync(path.join(f.directory, 'frames/6.jpg'), 'not an image');await assert.rejects(f.run(), /图片损坏/);assert.equal(f.analysisStore.getRun(f.projectId).id, f.source.id);} finally {f.cleanup();}
});

test('supported unknown observations stay reviewable instead of failing an incompatible upstream vocabulary', async () => {
  const f = fixture();try {
    f.input.annotations[0].annotation.camera = 'unknown';
    f.store.db.prepare('UPDATE media SET audio_codec=? WHERE project_id=?').run('aac', f.projectId);
    const result = await f.run();
    const camera = result.quality.engineChecks.find(c => c.id === 'reelbench-camera');
    assert.equal(camera.status, 'skipped');assert.match(camera.reason, /1 个镜头保留 unknown/);
    assert.equal(result.quality.engineChecks.find(c => c.id === 'annotation-schema').status, 'passed');
    assert.equal(result.shots[0].generated.camera, 'unknown');assert.ok(result.shots[0].issues.length);
    const markdown = fs.readFileSync(path.join(f.analysisStore.runDirectory(f.projectId, result.id), 'report.md'), 'utf8');
    assert.match(markdown, /3:2/);assert.doesNotMatch(markdown, /undefined|无声/);
  } finally {f.cleanup();}
});

test('opening the import store never recovers or cancels active jobs and import refuses the active project', async () => {
  const f = fixture();try {
    const job = f.store.createJob(f.projectId, 'shot_analyze', {analysisRunId: f.source.id});
    const parallel = createStudioStore(f.root, {recoverInterrupted: false});
    try {assert.equal(parallel.listJobs(f.projectId).find(j => j.id === job.id).state, 'queued');} finally {parallel.close();}
    await assert.rejects(f.run(), /任务正在执行/);assert.equal(f.analysisStore.getRun(f.projectId).id, f.source.id);
    assert.equal(f.store.listJobs(f.projectId).find(j => j.id === job.id).state, 'queued');
  } finally {f.cleanup();}
});
