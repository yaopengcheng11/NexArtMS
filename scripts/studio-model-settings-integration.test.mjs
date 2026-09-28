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
import {createModelSettings} from '../studio/model-settings.mjs';
import {ANNOTATION_ENUMS} from '../studio/shot-analysis-schema.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 60000) {const deadline = Date.now() + timeout;while (Date.now() < deadline) {const value = await predicate();if (value) return value;await sleep(25);}throw new Error('模型设置整合 fixture 超时');}
function fixtureModels() {
  let release;
  const firstOverview = new Promise(resolve => release = resolve);
  const state = {calls: [], providers: [], started: false, release};
  const factory = options => {
    state.providers.push(options);
    return {
      status: () => ({configured: true, provider: options.provider, model: options.model}),
      settings: options,
      overview: async payload => {
        state.calls.push({mode: 'overview', endpoint: options.endpoint, model: options.model, frames: payload.evidenceFrames.length});
        if (!state.started) {state.started = true;await firstOverview;}
        return {output: {summary: '本机合成单色画面的测试概览', subjects: [], issues: []}, usage: {attempts: 1}};
      },
      analyzeBatch: async payload => {
        state.calls.push({mode: 'batch', endpoint: options.endpoint, model: options.model, shots: payload.shots.length});
        return {output: {annotations: payload.shots.map(shot => ({shotId: shot.id, annotation: {
          size: ANNOTATION_ENUMS.size[0], category: ANNOTATION_ENUMS.category[0], camera: ANNOTATION_ENUMS.camera[0],
          frame: '测试合成画面中单色背景填满整个画框，画面中没有任何可见人物或动物。',
          action: `本机协议测试生成：${options.endpoint}`, composition: '单色背景铺满整个画面', scene: '合成测试画面', subjects: [],
          evidenceFrames: payload.evidenceFrames.filter(frame => frame.shotId === shot.id && frame.frameIndex >= shot.startFrame && frame.frameIndex < shot.endFrameExclusive).map(frame => frame.frameIndex),
        }})), subjects: [], issues: []}, usage: {attempts: 1}};
      },
    };
  };
  return {state, factory};
}

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-settings-integration-'));
  const models = fixtureModels();
  const manager = createModelSettings(root, {providerFactory: models.factory, secretCodec: {kind: 'fixture', persistent: false, encrypt: async () => {throw new Error('No secret in this fixture');}, decrypt: async () => {throw new Error('No secret in this fixture');}}});
  await manager.select({baseRevision: manager.publicState().revision, profileId: null});
  const store = createStudioStore(root), jobs = createJobRunner(store, root, DEFAULT_LIMITS, {modelSettings: manager});
  const router = createStudioRouter(store, root, {limits: DEFAULT_LIMITS, jobs});
  const server = http.createServer((req, res) => router(req, res).then(handled => {if (!handled) {res.writeHead(404);res.end('{}');}}).catch(() => {res.writeHead(500);res.end('{}');}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, route, body) => {
    const response = await fetch(base + route, {method, ...(body === undefined ? {} : {headers: Buffer.isBuffer(body) ? {} : {'Content-Type': 'application/json'}, body: Buffer.isBuffer(body) ? body : JSON.stringify(body)})});
    return {status: response.status, data: await response.json()};
  };
  const project = (await api('POST', '/api/studio/projects', {name: '模型配置整合测试'})).data.project;
  const route = `/api/studio/projects/${project.id}`, settingsRoute = '/api/studio/model-settings';
  const detail = async () => (await api('GET', route)).data;
  const idle = () => until(async () => {const d = await detail();return d.jobs.every(job => !['queued', 'running'].includes(job.state)) ? d : null;});
  const settings = async () => (await api('GET', settingsRoute)).data;
  const add = async endpoint => {
    const result = await api('POST', settingsRoute + '/profiles', {baseRevision: (await settings()).revision, name: '本机视觉 Fixture', provider: 'local-model-fixture', protocol: 'json-http', endpoint, models: ['fixture-vision-v1'], apiKey: ''});
    assert.equal(result.status, 200);return result.data.profiles.at(-1);
  };
  const select = async id => {const result = await api('POST', settingsRoute + '/select', {baseRevision: (await settings()).revision, profileId: id, modelId: 'fixture-vision-v1'});assert.equal(result.status, 200);return result.data;};
  return {root, store, jobs, manager, models, api, project, route, settingsRoute, detail, idle, settings, add, select,
    async upload() {
      const sample = path.join(root, 'fixture.mp4');
      await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:size=160x120:rate=12:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sample], {windowsHide: true});
      const result = await api('POST', `${route}/media?name=fixture.mp4&baseRevision=${project.revision}`, fs.readFileSync(sample));
      assert.equal(result.status, 200, JSON.stringify(result.data));return result.data;
    },
    async close() {
      models.state.release();
      for (const job of store.listJobs(project.id).filter(job => ['queued', 'running'].includes(job.state))) store.requestCancel(project.id, job.id);
      await idle();server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('model-settings-integration-'));
      fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});
    },
  };
}

test('HTTP model settings update new run snapshots immediately, protect in-use profiles, and isolate default switches', {timeout: 120000}, async () => {
  const h = await harness();
  try {
    assert.equal((await h.detail()).shotAnalysisProvider.configured, false);
    const first = await h.add('http://127.0.0.1:1/fixture-first');
    await h.select(first.id);
    const configured = await h.detail();assert.equal(configured.shotAnalysisProvider.configured, true);assert.equal(configured.shotAnalysisProvider.model, 'fixture-vision-v1');
    await h.upload();await until(() => h.models.state.started);
    let d = await h.detail();const originalRun = d.shotAnalysis, locked = originalRun.parameters.modelSnapshot;
    assert.equal(locked.profileId, first.id);assert.equal(locked.endpoint, first.endpoint);assert.equal(locked.model, 'fixture-vision-v1');assert.equal(h.models.state.providers[0].apiKey, '');
    for (const method of ['PATCH', 'DELETE']) {
      const result = await h.api(method, `${h.settingsRoute}/profiles/${first.id}`, {baseRevision: (await h.settings()).revision, name: 'cannot-change-in-use'});
      assert.equal(result.status, 409, JSON.stringify(result.data));assert.match(result.data.error, /正在执行拉片/);
    }
    const second = await h.add('http://127.0.0.1:1/fixture-second');
    await h.select(second.id);
    assert.deepEqual((await h.detail()).shotAnalysis.parameters.modelSnapshot, locked);
    h.models.state.release();d = await h.idle();
    assert.ok(['ready', 'ready_with_issues'].includes(d.shotAnalysis.status));assert.equal(d.shotAnalysis.shots.length, 1);
    assert.equal(d.shotAnalysis.shots[0].generated.action, `本机协议测试生成：${first.endpoint}`);
    assert.ok(h.models.state.calls.filter(call => call.mode === 'batch').every(call => call.endpoint === first.endpoint));
    const next = await h.api('POST', h.route + '/shot-analysis', {baseRevision: d.project.revision});assert.equal(next.status, 200);
    assert.equal(next.data.analysis.parameters.modelSnapshot.profileId, second.id);assert.equal(next.data.analysis.counts.analyzed, 0);
    d = await h.idle();assert.equal(d.shotAnalysis.shots[0].generated.action, `本机协议测试生成：${second.endpoint}`);
    assert.deepEqual(h.jobs.analysisStore.getRun(h.project.id, originalRun.id).parameters.modelSnapshot, locked);
  } finally {await h.close();}
});

test('same provider/model with a changed endpoint starts fresh machine annotations and retains manual overrides', {timeout: 120000}, async () => {
  const h = await harness();h.models.state.release();
  try {
    const profile = await h.add('http://127.0.0.1:1/original');await h.select(profile.id);await h.upload();let d = await h.idle();
    const oldRun = d.shotAnalysis;assert.equal(oldRun.counts.analyzed, 1);
    const edit = await h.api('PATCH', `${h.route}/shot-analysis/${oldRun.id}/shots/${oldRun.shots[0].id}`, {baseRevision: oldRun.revision, overrides: {action: '人工确认：本合成镜头静止'}});assert.equal(edit.status, 200);
    const editProfile = await h.api('PATCH', `${h.settingsRoute}/profiles/${profile.id}`, {baseRevision: (await h.settings()).revision, endpoint: 'http://127.0.0.1:1/updated'});assert.equal(editProfile.status, 200);
    const next = await h.api('POST', h.route + '/shot-analysis', {baseRevision: d.project.revision});assert.equal(next.status, 200);
    assert.equal(next.data.analysis.provider, oldRun.provider);assert.equal(next.data.analysis.model, oldRun.model);
    assert.notEqual(next.data.analysis.parameters.modelSnapshot.fingerprint, oldRun.parameters.modelSnapshot.fingerprint);
    assert.equal(next.data.analysis.counts.analyzed, 0);assert.equal(next.data.analysis.shots[0].generated, null);
    assert.equal(next.data.analysis.shots[0].overrides.action, '人工确认：本合成镜头静止');
    d = await h.idle();assert.equal(d.shotAnalysis.counts.analyzed, 1);
    assert.equal(d.shotAnalysis.shots[0].generated.action, '本机协议测试生成：http://127.0.0.1:1/updated');
    assert.equal(d.shotAnalysis.shots[0].effective.action, '人工确认：本合成镜头静止');
    assert.ok(h.models.state.calls.some(call => call.mode === 'batch' && call.endpoint === 'http://127.0.0.1:1/updated'));
  } finally {await h.close();}
});
