import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createStudioStore} from '../studio/db.mjs';
import {createJobRunner} from '../studio/jobs.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {createShotAnalysisProvider} from '../studio/shot-analysis-provider.mjs';
import {createModelSettings} from '../studio/model-settings.mjs';
import {ANNOTATION_ENUMS} from '../studio/shot-analysis-schema.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';

const exec = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 60000) {const deadline = Date.now() + timeout;while (Date.now() < deadline) {const result = await predicate();if (result) return result;await wait(50);}throw new Error('Timed out waiting for fixture');}
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
async function harness(provider, {modelSettings} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-analysis-http-'));
  const store = createStudioStore(root), jobs = createJobRunner(store, root, DEFAULT_LIMITS, {provider, ...(modelSettings ? {modelSettings} : {})});
  const router = createStudioRouter(store, root, {limits: DEFAULT_LIMITS, jobs});
  const server = http.createServer((req, res) => router(req, res).then(handled => {if (!handled) {res.writeHead(404);res.end('{}');}}).catch(error => {res.writeHead(500);res.end(JSON.stringify({error: error.message}));}));
  const base = await listen(server);
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {method, ...(body === undefined ? {} : {headers: Buffer.isBuffer(body) ? {} : {'Content-Type': 'application/json'}, body: Buffer.isBuffer(body) ? body : JSON.stringify(body)})});
    return {status: response.status, data: await response.json()};
  };
  const project = (await api('POST', '/api/studio/projects', {name: 'Shot analysis HTTP fixture'})).data.project;
  const route = `/api/studio/projects/${project.id}`;
  const detail = async () => (await api('GET', route)).data;
  const idle = () => until(async () => {const d = await detail();return d.jobs.every(j => !['queued', 'running'].includes(j.state)) ? d : null;});
  return {root, store, jobs, api, base, project, route, detail, idle,
    upload: async () => {
      const sample = path.join(root, 'sample.mp4');
      await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:size=160x120:rate=12:duration=1', '-f', 'lavfi', '-i', 'color=white:size=160x120:rate=12:duration=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]', '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sample], {windowsHide: true});
      const result = await api('POST', `${route}/media?name=sample.mp4&baseRevision=${project.revision}`, fs.readFileSync(sample));
      assert.equal(result.status, 200, JSON.stringify(result.data));return result.data;
    },
    close: async () => {
      for (const job of store.listJobs(project.id).filter(j => ['queued', 'running'].includes(j.state))) store.requestCancel(project.id, job.id);
      if (store.getProjectRow(project.id)) await idle();server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('shot-analysis-http-'));
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});
    }};
}

async function fixtureProvider() {
  const state = {mode: 'normal', batchCalls: 0, started: false, payloads: []};
  const server = http.createServer(async (req, res) => {
    let data = '';for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);state.payloads.push(body);
    if (body.mode === 'overview') {res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({summary: 'Local test fixture: two solid-color shots.', subjects: [], issues: []}));return;}
    state.batchCalls++;state.started = true;
    if (state.mode === 'wait') return;
    if (state.mode === 'unauthorized') {res.writeHead(401);res.end('{}');return;}
    if (state.mode === 'fail') {res.writeHead(503);res.end('{}');return;}
    const annotations = body.input.shots.map(shot => ({shotId: shot.id, annotation: {
      size: ANNOTATION_ENUMS.size[0], category: ANNOTATION_ENUMS.category[0], camera: ANNOTATION_ENUMS.camera[0],
      frame: '测试合成画面中均匀的单色背景填满整个画面，没有可见的主体。', action: '合成静态画面无主体运动', composition: '均匀填满整个画面', scene: '测试单色背景', subjects: [],
      evidenceFrames: body.input.evidenceFrames.filter(f => f.shotId === shot.id && f.frameIndex >= shot.startFrame && f.frameIndex < shot.endFrameExclusive).map(f => f.frameIndex),
    }}));
    res.setHeader('Content-Type', 'application/json');res.end(JSON.stringify({annotations, subjects: [], issues: []}));
  });
  const endpoint = await listen(server);
  return {state, provider: createShotAnalysisProvider({provider: 'localhost-test-fixture', model: 'fixture-v1', endpoint, protocol: 'json-http', apiKey: '', maxAttempts: 1, timeoutMs: 15000}),
    close: async () => {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}};
}

test('blocked shot report stays honest while detection auto-continues (V2 R1: 拉片为可降级分支)', {timeout: 120000}, async () => {
  const h = await harness(createShotAnalysisProvider({provider: '', model: '', endpoint: '', protocol: ''}));
  try {
    const uploaded = await h.upload();assert.equal(uploaded.autoDraft.targetStage, 'shot_analysis');
    const d = await h.idle(), run = d.shotAnalysis;
    assert.equal(d.workflowTarget, 'shot_analysis');assert.equal(run.status, 'blocked');assert.equal(run.shots.length, 2);
    assert.equal(run.counts.analyzed, 0);assert.ok(run.shots.every(s => s.generated === null && s.evidenceFrames.length >= 3));
    // 语义模型未配置是可降级状态：shot_analyze 任务正常完成（底稿保留），不再记为失败。
    const analyzeJob = d.jobs.find(j => j.kind === 'shot_analyze');
    assert.equal(analyzeJob.state, 'done');assert.match(analyzeJob.output, /语义分析未执行/);
    assert.equal(d.jobs.find(j => j.kind === 'shot_report').state, 'done');
    // V2 R1/A02：拉片为可降级分支，失败后检测分支仍自动执行；测试环境无检测模型 → 如实失败
    const detectJob = d.jobs.find(j => j.kind === 'detect');
    assert.ok(detectJob, '拉片收尾后检测分支必须自动执行');
    assert.equal(detectJob.state, 'failed');
    assert.match(detectJob.error, /未配置人物检测模型/);
    const pts = (await h.api('GET', `${h.route}/media/pts`)).data;assert.equal(pts.ptsUs.length, 24);assert.equal(pts.ready, true);
    const image = await fetch(h.base + run.shots[0].evidenceFrames[0].url);assert.equal(image.status, 200);assert.match(image.headers.get('content-type'), /jpeg/);await image.arrayBuffer();
    const report = await h.api('GET', `${h.route}/shot-analysis/${run.id}/file?path=report.json`);assert.equal(report.status, 200);assert.equal(report.data.status, 'blocked');
    assert.equal((await h.api('GET', `${h.route}/shot-analysis/${run.id}/file?path=../../studio.sqlite`)).status, 400);
    assert.equal((await h.api('PATCH', `${h.route}/shot-analysis/${run.id}/shots/${run.shots[0].id}`, {baseRevision: 'old', overrides: {action: '过期写入'}})).status, 409);
    assert.equal((await h.api('POST', `${h.route}/shot-analysis/${run.id}/recut`, {baseRevision: run.revision, cutFrames: [6, 12]})).status, 200);
    let candidate = (await h.idle()).shotAnalysis;assert.equal(candidate.status, 'blocked');
    candidate = (await h.api('PATCH', `${h.route}/shot-analysis/${candidate.id}/shots/${candidate.shots[0].id}`, {baseRevision: candidate.revision, overrides: {action: '人工修正：新拆出的片段'}})).data.analysis;
    assert.equal((await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, sourceRunId: candidate.id, sourceRunRevision: candidate.revision})).status, 200);
    const retried = (await h.idle()).shotAnalysis;assert.equal(retried.candidate, true);assert.equal(retried.shots.length, 3);assert.equal(retried.shots[0].effective.action, '人工修正：新拆出的片段');
  } finally {await h.close();}
});

test('missing API key in model settings degrades to a blocked draft instead of a failed chain', {timeout: 120000}, async () => {
  const settingsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-analysis-settings-'));
  try {
    const modelSettings = createModelSettings(settingsRoot);
    const added = await modelSettings.addProfile({name: 'MM', provider: 'minimax', protocol: 'openai-chat-completions', endpoint: 'https://api.minimax.example/v1', models: ['MiniMax-M3'], baseRevision: modelSettings.publicState().revision});
    await modelSettings.select({profileId: added.profiles[0].id, modelId: 'MiniMax-M3', baseRevision: added.revision});
    const h = await harness(undefined, {modelSettings});
    try {
      await h.upload();
      const d = await h.idle(), run = d.shotAnalysis;
      // 供应商已选择但密钥未保存：任务正常完成并降级 blocked，链路继续产出底稿报告。
      assert.equal(run.status, 'blocked');assert.match(run.error, /语义分析未执行/);assert.match(run.error, /API 密钥/);
      assert.equal(d.jobs.find(j => j.kind === 'shot_analyze').state, 'done');
      assert.equal(d.jobs.find(j => j.kind === 'shot_report').state, 'done');
      const report = await h.api('GET', `${h.route}/shot-analysis/${run.id}/file?path=report.json`);
      assert.equal(report.status, 200);assert.equal(report.data.status, 'blocked');
    } finally {await h.close();}
  } finally {fs.rmSync(settingsRoot, {recursive: true, force: true, maxRetries: 5});}
});

test('local provider HTTP: semantic results, protected edits, candidate recut and adoption', {timeout: 120000}, async () => {
  const provider = await fixtureProvider(), h = await harness(provider.provider);
  try {
    await h.upload();let d = await h.idle(), run = d.shotAnalysis;
    assert.ok(['ready', 'ready_with_issues'].includes(run.status), JSON.stringify(run));assert.equal(run.counts.analyzed, 2);
    // 有系统字体与 ffmpeg 时发联系表（sheets），否则回退逐帧图文；两种模式都必须带 JPEG 图像。
    assert.ok(provider.state.payloads.some(p => (p.input.sheets?.length ? p.input.sheets : p.input.evidenceFrames).some(item => item.dataUrl?.startsWith('data:image/jpeg;base64,'))));
    const projectRevision = d.project.revision, originalIds = d.shots.map(s => s.id);
    const edited = await h.api('PATCH', `${h.route}/shot-analysis/${run.id}/shots/${run.shots[1].id}`, {baseRevision: run.revision, overrides: {action: '人工确认：保持静止'}});
    assert.equal(edited.status, 200);assert.equal((await h.detail()).project.revision, projectRevision);
    run = edited.data.analysis;
    const editedReport = (await h.api('GET', `${h.route}/shot-analysis/${run.id}/file?path=report.json`)).data;
    assert.equal(editedReport.shots[1].effective.action, '人工确认：保持静止', 'saved reports must refresh after edits');
    const cut = await h.api('POST', `${h.route}/shot-analysis/${run.id}/recut`, {baseRevision: run.revision, cutFrames: [6, 12]});
    assert.equal(cut.status, 200, JSON.stringify(cut.data));
    d = await h.idle();run = d.shotAnalysis;
    assert.equal(run.candidate, true);assert.equal(run.shots.length, 3);assert.deepEqual(d.shots.map(s => s.id), originalIds);
    assert.equal(run.shots[2].id, originalIds[1]);assert.equal(run.shots[2].effective.action, '人工确认：保持静止');
    assert.equal((await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, sourceRunId: run.id, sourceRunRevision: 'old'})).status, 409);
    assert.equal((await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, sourceRunId: run.id, sourceRunRevision: run.revision})).status, 200);
    d = await h.idle();run = d.shotAnalysis;
    assert.equal(run.candidate, true);assert.equal(run.shots.length, 3);assert.equal(run.shots[2].effective.action, '人工确认：保持静止');
    assert.equal((await h.api('POST', `${h.route}/shot-analysis/${run.id}/apply`, {baseRevision: 'old'})).status, 409);
    const adopted = await h.api('POST', `${h.route}/shot-analysis/${run.id}/apply`, {baseRevision: d.project.revision});assert.equal(adopted.status, 200, JSON.stringify(adopted.data));
    d = await h.detail();assert.equal(d.shots.length, 3);assert.equal(d.shotAnalysis.candidate, false);
    assert.equal((await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, force: true})).status, 200);
    d = await h.idle();assert.equal(d.shotAnalysis.shots[2].effective.action, '人工确认：保持静止');assert.equal(d.shotAnalysis.counts.analyzed, 3);
    const newestRunId = d.shotAnalysis.id;
    assert.equal((await h.api('PATCH', `${h.route}/shots`, {baseRevision: d.project.revision, cutFrames: [12]})).status, 200);
    assert.equal((await h.detail()).shotAnalysis.status, 'stale');
    assert.equal((await h.api('GET', `${h.route}/shot-analysis/${newestRunId}/file?path=report.json`)).status, 409);
    d = await h.detail();
    assert.equal((await h.api('DELETE', h.route, {baseRevision: d.project.revision, confirmName: h.project.name})).status, 200);
    assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM shot_analysis_runs WHERE project_id=?').get(h.project.id).n, 0);
    assert.equal(h.store.db.prepare('SELECT count(*) AS n FROM shot_annotations').get().n, 0);
  } finally {await h.close();await provider.close();}
});

test('cancel in-flight semantic request rejects late results; retry resumes once; historical retries rejected', {timeout: 120000}, async () => {
  const provider = await fixtureProvider();provider.state.mode = 'wait';
  const h = await harness(provider.provider);
  try {
    await h.upload();await until(() => provider.state.started);
    let d = await h.detail();const job = d.jobs.find(j => j.kind === 'shot_analyze');
    assert.equal((await h.api('POST', `/api/studio/jobs/${job.id}/cancel`, {})).status, 200);
    d = await h.idle();assert.equal(d.shotAnalysis.status, 'cancelled');assert.equal(d.shotAnalysis.counts.analyzed, 0);assert.equal(d.jobs.some(j => j.kind === 'shot_report'), false);
    const rejected = await h.api('POST', `/api/studio/jobs/${job.id}/retry`, {baseRevision: 'old'});assert.equal(rejected.status, 409);assert.equal((await h.detail()).shotAnalysis.status, 'cancelled');
    provider.state.mode = 'normal';
    assert.equal((await h.api('POST', `/api/studio/jobs/${job.id}/retry`, {baseRevision: d.project.revision})).status, 200);
    d = await h.idle();assert.equal(d.shotAnalysis.counts.analyzed, 2);assert.ok(['ready', 'ready_with_issues'].includes(d.shotAnalysis.status));
    // Create a second failed run, then supersede it: an old task must not revive old annotations.
    provider.state.mode = 'fail';assert.equal((await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, force: true})).status, 200);
    d = await h.idle();const oldRunId = d.shotAnalysis.id, failedJob = d.jobs.find(j => j.kind === 'shot_analyze' && j.state === 'failed');
    assert.equal(d.shotAnalysis.status, 'failed');
    provider.state.mode = 'normal';await h.api('POST', `${h.route}/shot-analysis`, {baseRevision: d.project.revision, force: true});d = await h.idle();
    assert.notEqual(d.shotAnalysis.id, oldRunId);assert.equal((await h.api('POST', `/api/studio/jobs/${failedJob.id}/retry`, {baseRevision: d.project.revision})).status, 409);
  } finally {await h.close();await provider.close();}
});

test('failure of an import prerequisite never queues its downstream analysis stages', {timeout: 15000}, async () => {
  const h = await harness(createShotAnalysisProvider({provider: '', model: '', endpoint: '', protocol: ''}));
  try {
    h.store.insertMedia(h.project.id, {id: 'missing-input', sha256: 'a'.repeat(64), originalName: 'missing.mp4', originalRef: 'missing.mp4', proxyRef: 'missing-preview.mp4', durationUs: 1000000, width: 160, height: 120, rotation: 0, timebase: '1/12', fpsNum: 12, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: null, sizeBytes: 1, baseRevision: h.project.revision});
    const run = h.jobs.analysisStore.createRun(h.project.id);h.jobs.enqueue(h.project.id, 'proxy', {auto: true, targetStage: 'shot_analysis', analysisRunId: run.id});
    const d = await h.idle();assert.equal(d.jobs.length, 1);assert.equal(d.jobs[0].state, 'failed');assert.equal(d.shotAnalysis.status, 'failed');
  } finally {await h.close();}
});

test('authentication failure remains blocked and produces a diagnostic report', {timeout: 60000}, async () => {
  const provider = await fixtureProvider();provider.state.mode = 'unauthorized';const h = await harness(provider.provider);
  try {
    await h.upload();const d = await h.idle();assert.equal(d.shotAnalysis.status, 'blocked');assert.match(d.shotAnalysis.error, /401/);
    assert.equal(d.jobs.find(j => j.kind === 'shot_analyze').state, 'failed');assert.equal(d.jobs.find(j => j.kind === 'shot_report').state, 'done');
    assert.equal((await h.api('GET', `${h.route}/shot-analysis/${d.shotAnalysis.id}/file?path=report.json`)).data.status, 'blocked');
  } finally {await h.close();await provider.close();}
});
