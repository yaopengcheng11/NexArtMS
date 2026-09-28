import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createStudioStore} from '../studio/db.mjs';
import {createShotAnalysisStore} from '../studio/shot-analysis-store.mjs';
import {createShotAnalysisEngine, evidenceIndices} from '../studio/shot-analysis.mjs';
import {SHOT_ANALYSIS_SCHEMA_VERSION, SHOT_ANALYSIS_PROMPT_VERSION} from '../studio/shot-analysis-schema.mjs';
import {probeMedia, extractPtsMap, DEFAULT_LIMITS} from '../studio/media.mjs';

const exec = (bin, args) => new Promise((resolve, reject) => {const p = spawn(bin, args, {windowsHide: true});let error = '';p.stderr.on('data', c => error += c);p.on('error', reject);p.on('close', code => code ? reject(new Error(error)) : resolve());});
async function fixture({vfr = false, realFrames = false, shotCount = 3} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analysis-engine-'));
  const store = createStudioStore(root), analysis = createShotAnalysisStore(store, root), project = store.createProject({name: 'engine-local-fixture'}), id = project.id;
  const original = path.join(root, 'source.mp4');let pts, info;
  if (realFrames) {
    await exec(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=120x80:rate=12:duration=2', ...(vfr ? ['-vf', 'settb=1/120,setpts=N*10+floor(N/6)*5', '-fps_mode', 'vfr', '-enc_time_base', '1:120'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', original]);
    info = await probeMedia(original, DEFAULT_LIMITS);pts = (await extractPtsMap(original, root, 'fixture')).pts;
  } else {pts = Array.from({length: 24}, (_, i) => i / 12);info = {durationUs: 2000000, width: 120, height: 80, rotation: 0, timebase: '1/12000', fpsNum: 12, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: null};}
  fs.writeFileSync(path.join(root, 'pts.json'), JSON.stringify({pts}));
  store.insertMedia(id, {...info, id: 'm-engine', sha256: 'b'.repeat(64), originalName: 'source.mp4', originalRef: 'source.mp4', proxyRef: 'source.mp4', ptsMapRef: 'pts.json', ptsCount: pts.length, sizeBytes: 100, baseRevision: project.revision});
  const cuts = Array.from({length: shotCount + 1}, (_, i) => Math.round(i * pts.length / shotCount));
  store.replaceShots(id, cuts.slice(0, -1).map((f, i) => ({id: `S${String(i + 1).padStart(2, '0')}`, startFrame: f, endFrameExclusive: cuts[i + 1], startUs: Math.round(pts[f] * 1e6), endUs: cuts[i + 1] === pts.length ? info.durationUs : Math.round(pts[cuts[i + 1]] * 1e6)})), 'auto', store.getProjectRow(id).revision);
  const run = analysis.createRun(id);
  if (!realFrames) {
    const dir = analysis.runDirectory(id, run.id);fs.mkdirSync(path.join(dir, 'frames'), {recursive: true});
    for (const shot of run.shots) {
      const frames = evidenceIndices(shot).map(frameIndex => ({frameIndex, ptsUs: Math.round(pts[frameIndex] * 1e6), imageRef: `frames/f${String(frameIndex).padStart(9, '0')}.jpg`}));
      for (const frame of frames) fs.writeFileSync(path.join(dir, frame.imageRef), Buffer.from([255, 216, 255, 217]));
      analysis.updateShot(id, run.id, shot.id, {evidenceFrames: frames});
    }
  }
  return {root, original, store, analysis, id, runId: run.id, pts,
    engine: provider => createShotAnalysisEngine({store, analysisStore: analysis, root, provider}),
    current: () => analysis.getRun(id, run.id),
    cleanup: () => {store.close();assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('studio-analysis-engine-'));fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}};
}
function provider(overrides = {}) {
  return {status: () => ({configured: true, provider: 'fixture', model: 'fixture-only'}), settings: {batchSize: 1, maxCalls: 30},
    overview: async input => ({output: {summary: '仅用于验证协议的本机 fixture 概览', subjects: [{id: 'A', kind: 'person', name: '候选甲', description: '穿红衣的人物候选', referenceFrames: [input.evidenceFrames[0].frameIndex], uncertain: true}], issues: []}}),
    analyzeBatch: async input => ({output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: annotation(s, input)})), subjects: [], issues: []}}), ...overrides};
}
const annotation = (shot, input) => ({size: 'medium', category: 'subject', camera: 'static', frame: `${shot.id}中男子位于画框左侧，右侧窗边有一张木桌`, action: '站立', composition: '主体在左，背景窗户在右', scene: '室内', subjects: ['A'], evidenceFrames: input.evidenceFrames.filter(f => f.shotId === shot.id).map(f => f.frameIndex)});

test('source extraction preserves exact source indices and VFR PTS, independently decodable JPEG output', async () => {
  const f = await fixture({vfr: true, realFrames: true});
  try {
    const engine = f.engine(provider());await engine.frames(f.id, f.runId);
    const run = f.current();assert.ok(f.pts.some((p, i) => i > 1 && Math.abs((p - f.pts[i - 1]) - (f.pts[i - 1] - f.pts[i - 2])) > .01));
    for (const s of run.shots) for (const e of s.evidenceFrames) {assert.equal(e.ptsUs, Math.round(f.pts[e.frameIndex] * 1e6));assert.ok(e.frameIndex >= s.startFrame && e.frameIndex < s.endFrameExclusive);}
    const selected = run.shots[1].evidenceFrames[2], output = path.join(f.root, 'independent.jpg');
    await exec(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f.original, '-vf', `select=eq(n\\,${selected.frameIndex}),scale='min(768,iw)':-2`, '-frames:v', '1', '-q:v', '3', output]);
    assert.deepEqual(fs.readFileSync(path.join(f.analysis.runDirectory(f.id, f.runId), selected.imageRef)), fs.readFileSync(output));
    await engine.analyze(f.id, f.runId);await engine.validate(f.id, f.runId);assert.equal(f.current().quality.engineChecks.find(c => c.id === 'source-frame-timeline').status, 'passed');
  } finally {f.cleanup();}
});

test('whole-film overview and batches retain common subject IDs, manual edits, exact reports and skipped checks', async () => {
  const f = await fixture();
  try {
    const seen = [];
    const engine = f.engine(provider({analyzeBatch: async input => {seen.push(input);return {output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: annotation(s, input)})), subjects: [], issues: []}};}}));
    f.analysis.editShot(f.id, f.runId, 'S01', {baseRevision: f.current().revision, overrides: {action: '人工已确认：转身'}});
    await engine.analyze(f.id, f.runId);await engine.validate(f.id, f.runId);await engine.report(f.id, f.runId);
    const run = f.current();assert.equal(run.counts.analyzed, 3);assert.equal(run.shots[0].effective.action, '人工已确认：转身');assert.ok(seen.every(s => s.subjectCatalog[0].id === 'A'));assert.equal(run.status, 'ready_with_issues');
    assert.ok(run.quality.engineChecks.some(c => c.id === 'reelbench-motion' && c.status === 'skipped'));
    const dir = f.analysis.runDirectory(f.id, f.runId), report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json')));
    assert.equal(report.shots[1].startUs, Math.round(f.pts[8] * 1e6));
    const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');assert.match(html, /file\?path=frames%2F/);assert.match(html, /人工已确认：转身/);assert.ok(fs.existsSync(path.join(dir, 'reelbench-shots.json')));
  } finally {f.cleanup();}
});

test('one failed batch keeps successful analysis and retry requests only missing shots', async () => {
  const f = await fixture();
  try {
    let fail = true;const calls = [];
    const p = provider({analyzeBatch: async input => {calls.push(input.shots[0].id);if (fail && input.shots[0].id === 'S02') throw new Error('fixture batch unavailable');return {output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: annotation(s, input)})), subjects: [], issues: []}};}}), engine = f.engine(p);
    await engine.analyze(f.id, f.runId);assert.equal(f.current().counts.analyzed, 2);assert.equal(f.current().counts.failed, 1);
    await engine.validate(f.id, f.runId);await engine.report(f.id, f.runId);assert.equal(f.current().status, 'ready_with_issues');
    fail = false;calls.length = 0;await engine.analyze(f.id, f.runId);assert.deepEqual(calls, ['S02']);assert.equal(f.current().counts.analyzed, 3);
  } finally {f.cleanup();}
});

test('all failed and unconfigured runs produce honest error drafts, never ready', async () => {
  for (const configured of [true, false]) {
    const f = await fixture();
    try {
      const engine = f.engine(provider({status: () => ({configured, provider: null, model: null, reason: 'fixture not configured'}), analyzeBatch: async () => {throw new Error('fixture all failed');}}));
      await assert.rejects(engine.analyze(f.id, f.runId), e => e.code === (configured ? 'analysis_all_failed' : 'provider_unconfigured'));
      await engine.validate(f.id, f.runId);await engine.report(f.id, f.runId);assert.equal(f.current().status, configured ? 'failed' : 'blocked');assert.equal(f.current().counts.analyzed, 0);assert.ok(f.current().error);
      if (!configured) {
        const current = f.current(), checks = current.quality.engineChecks;
        assert.equal(current.issues.length, 1);assert.equal(current.issues[0].code, 'provider_unconfigured');assert.equal(current.quality.checksSummary.failed, 0);
        for (const id of ['annotation-schema', 'reelbench-size', 'reelbench-category', 'reelbench-camera', 'reelbench-frame-text', 'reelbench-category-evidence']) {assert.equal(checks.find(c => c.id === id).status, 'skipped');assert.deepEqual(checks.find(c => c.id === id).issues, []);}
        for (const id of ['source-frame-timeline', 'source-frame-evidence', 'reelbench-timeline', 'reelbench-boundary']) assert.equal(checks.find(c => c.id === id).status, 'passed');
        const markdown = fs.readFileSync(path.join(f.analysis.runDirectory(f.id, f.runId), 'report.md'), 'utf8');assert.match(markdown, /全片语义尚未分析/);assert.doesNotMatch(markdown, /annotation 必须为对象/);
      }
    } finally {f.cleanup();}
  }
});

test('blocked semantic analysis still fails real source evidence validation', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(provider({status: () => ({configured: false, provider: null, model: null, reason: 'fixture not configured'})}));
    await assert.rejects(engine.analyze(f.id, f.runId), e => e.code === 'provider_unconfigured');
    const evidence = f.current().shots[0].evidenceFrames[0];fs.writeFileSync(path.join(f.analysis.runDirectory(f.id, f.runId), evidence.imageRef), 'invalid JPEG');
    await assert.rejects(engine.validate(f.id, f.runId), /源帧时间或证据校验失败/);
    assert.equal(f.current().status, 'failed');assert.equal(f.current().quality.engineChecks.find(c => c.id === 'source-frame-evidence').status, 'failed');
  } finally {f.cleanup();}
});

test('cancelled or stale async model responses cannot commit results', async () => {
  for (const mode of ['cancelled', 'stale']) {
    const f = await fixture();
    try {
      let cancelled = false;
      const engine = f.engine(provider({analyzeBatch: async input => {
        if (mode === 'cancelled') cancelled = true;else f.store.db.prepare('UPDATE media SET sha256=? WHERE project_id=?').run('c'.repeat(64), f.id);
        return {output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: annotation(s, input)})), subjects: [], issues: []}};
      }}));
      await assert.rejects(engine.analyze(f.id, f.runId, {isCancelled: () => cancelled}), e => e.status === 409);assert.equal(f.current().counts.analyzed, 0);
    } finally {f.cleanup();}
  }
});

test('strict response validation rejects fabricated source timing and undeclared visual evidence', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(provider({analyzeBatch: async input => ({output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: {...annotation(s, input), evidenceFrames: [999999]}})), subjects: [], issues: []}})}));
    await assert.rejects(engine.analyze(f.id, f.runId), e => e.code === 'analysis_all_failed');assert.equal(f.current().counts.analyzed, 0);assert.equal(f.current().counts.failed, 3);
  } finally {f.cleanup();}
});

test('uncertain action gets one dense pass and retains evidence and candidate IDs across a reused run', async () => {
  const f = await fixture({realFrames: true, shotCount: 1});
  try {
    const calls = [];
    const p = provider({analyzeBatch: async input => {calls.push(input);return {output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: {...annotation(s, input), camera: 'unknown', uncertainties: ['动作和背景运动需人工复核']}})), subjects: [], issues: []}};}});
    const engine = f.engine(p);await engine.frames(f.id, f.runId);await engine.analyze(f.id, f.runId);
    assert.equal(calls.length, 2);assert.ok(calls[1].evidenceFrames.length > calls[0].evidenceFrames.length);assert.equal(f.current().counts.needsReview, 1);
    const evidence = f.current().shots[0].generated.evidenceFrames;
    const next = f.analysis.createRun(f.id, {reuse: true, provider: 'fixture', model: 'fixture-only', schemaVersion: SHOT_ANALYSIS_SCHEMA_VERSION, promptVersion: SHOT_ANALYSIS_PROMPT_VERSION});
    const reuseEngine = f.engine(provider({overview: async () => ({output: {summary: '复用目录，不新增主体', subjects: [], issues: []}}), analyzeBatch: async () => {throw new Error('已成功的镜头不得重复请求');}}));
    await reuseEngine.frames(f.id, next.id);await reuseEngine.analyze(f.id, next.id);
    const current = f.analysis.getRun(f.id, next.id);assert.equal(current.counts.analyzed, 1);assert.equal(current.subjects[0].id, 'A');assert.deepEqual(current.shots[0].generated.evidenceFrames, evidence);
  } finally {f.cleanup();}
});

test('bounded request budget leaves missing shots failed and records failed request usage', async () => {
  const f = await fixture();
  try {
    const engine = f.engine(provider({settings: {batchSize: 1, maxCalls: 2}, analyzeBatch: async () => {throw Object.assign(new Error('fixture request failed'), {attempts: 2});}}));
    await assert.rejects(engine.analyze(f.id, f.runId), e => e.code === 'analysis_all_failed');
    assert.equal(f.current().quality.usage.calls, 2);assert.equal(f.current().quality.usage.attempts, 3);assert.equal(f.current().quality.usage.failedCalls, 1);
    assert.equal(f.current().shots.filter(s => s.issues.some(i => i.code === 'analysis_budget')).length, 2);
  } finally {f.cleanup();}
});

test('resume under a changed model archives old provenance, reanalyzes generated text and preserves manual overrides', async () => {
  const f = await fixture();
  try {
    const first = f.engine(provider());await first.analyze(f.id, f.runId);await first.validate(f.id, f.runId);await first.report(f.id, f.runId);
    f.analysis.editShot(f.id, f.runId, 'S01', {baseRevision: f.current().revision, overrides: {action: '人工动作保持'}});
    const called = [];
    const next = f.engine(provider({status: () => ({configured: true, provider: 'different-fixture', model: 'vision-v2'}), analyzeBatch: async input => {called.push(input.shots[0].id);return {output: {annotations: input.shots.map(s => ({shotId: s.id, annotation: {...annotation(s, input), action: '新模型动作'}})), subjects: [], issues: []}};}}));
    await next.analyze(f.id, f.runId);
    const run = f.current();assert.deepEqual(called, ['S01', 'S02', 'S03']);assert.equal(run.model, 'vision-v2');assert.equal(run.schemaVersion, SHOT_ANALYSIS_SCHEMA_VERSION);assert.equal(run.promptVersion, SHOT_ANALYSIS_PROMPT_VERSION);
    assert.equal(run.shots[0].generated.action, '新模型动作');assert.equal(run.shots[0].effective.action, '人工动作保持');assert.equal(run.artifactRef, null);
    const previous = JSON.parse(fs.readFileSync(path.join(f.analysis.runDirectory(f.id, f.runId), run.quality.previousProvenance.artifactRef)));
    assert.equal(previous.model, 'fixture-only');assert.equal(previous.shots[0].generated.action, '站立');
  } finally {f.cleanup();}
});
