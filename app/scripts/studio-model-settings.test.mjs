import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {inflateSync} from 'node:zlib';
import {createModelSettings, createVisionChallenge} from '../studio/model-settings.mjs';
import {createModelSettingsRouter} from '../studio/model-settings-router.mjs';

const fixtureCodec = () => ({kind: 'fixture', persistent: true, encrypt: async value => Buffer.from(value).toString('base64'), decrypt: async value => Buffer.from(value, 'base64').toString()});
const fixture = options => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexart-model-settings-'));
  return {root, settings: createModelSettings(root, {secretCodec: fixtureCodec(), ...options}), cleanup() {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'nexart-model-settings-'));fs.rmSync(root, {recursive: true, force: true});}};
};
const profileBody = (settings, extra = {}) => ({baseRevision: settings.publicState().revision, name: '本地视觉 Fixture', provider: 'fixture', protocol: 'json-http', endpoint: 'http://127.0.0.1:1/analyze', models: ['fixture-vision'], ...extra});
const first = settings => settings.publicState().profiles[0];
const selectFirst = settings => settings.select({baseRevision: settings.publicState().revision, profileId: first(settings).id, modelId: 'fixture-vision'});
async function server(handler) {const service = http.createServer(handler);await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));return {url: `http://127.0.0.1:${service.address().port}`, service, close: async () => {service.closeAllConnections();await new Promise(resolve => service.close(resolve));}};}
function colorsFromPng(dataUrl) {
  const png = Buffer.from(dataUrl.split(',')[1], 'base64'), chunks = [];let width;
  for (let pos = 8; pos < png.length;) {const size = png.readUInt32BE(pos), name = png.subarray(pos + 4, pos + 8).toString();if (name === 'IHDR') width = png.readUInt32BE(pos + 8);if (name === 'IDAT') chunks.push(png.subarray(pos + 8, pos + 8 + size));pos += size + 12;}
  const raw = inflateSync(Buffer.concat(chunks));
  const names = {'255,0,0': 'red', '0,255,0': 'green', '0,0,255': 'blue', '255,255,0': 'yellow', '255,0,255': 'magenta', '0,255,255': 'cyan'};
  return [0, 1, 2].map(i => names[Array.from(raw.subarray(1 + i * width, 1 + i * width + 3)).join(',')]);
}

test('model settings CRUD stores only encoded secret, returns hasApiKey, preserves omitted key and clears it on endpoint change', async () => {
  const f = fixture();
  try {
    const initial = f.settings.publicState();
    assert.equal(initial.active, null);assert.ok(initial.protocols.some(p => p.id === 'anthropic-messages'));
    const added = await f.settings.addProfile(profileBody(f.settings, {apiKey: 'fixture-only-token'}));
    const p = added.profiles[0];assert.equal(p.hasApiKey, true);assert.equal(JSON.stringify(added).includes('fixture-only-token'), false);assert.equal(JSON.stringify(added).includes('encryptedSecret'), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'data/private/model-settings.json'), 'utf8').includes('fixture-only-token'), false);
    await f.settings.updateProfile(p.id, {baseRevision: added.revision, name: '改名'});assert.equal(first(f.settings).hasApiKey, true);
    await f.settings.updateProfile(p.id, {baseRevision: f.settings.publicState().revision, endpoint: 'http://localhost:1/new'});assert.equal(first(f.settings).hasApiKey, false);
    await f.settings.updateProfile(p.id, {baseRevision: f.settings.publicState().revision, apiKey: 'another-fixture'});
    await f.settings.updateProfile(p.id, {baseRevision: f.settings.publicState().revision, clearApiKey: true});assert.equal(first(f.settings).hasApiKey, false);
    await selectFirst(f.settings);assert.equal(f.settings.status().configured, true);
    await f.settings.deleteProfile(p.id, {baseRevision: f.settings.publicState().revision});assert.equal(f.settings.status().configured, false);assert.equal(f.settings.publicState().active, null);
  } finally {f.cleanup();}
});

test('model settings optimistic revision rejects conflicting writes including concurrent async credential saves', async () => {
  const f = fixture();
  try {
    const body = profileBody(f.settings);
    const results = await Promise.allSettled([f.settings.addProfile(body), f.settings.addProfile(body)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
    await assert.rejects(f.settings.select({baseRevision: body.baseRevision, profileId: null}), e => e.status === 409);
  } finally {f.cleanup();}
});

test('equivalent Base URL edits retain the saved key while a different destination still clears it', async () => {
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings, {provider: 'minimax', protocol: 'openai-chat-completions', endpoint: 'https://api.minimax.cn/v1', apiKey: 'fixture-retained-secret'}));
    const id = first(f.settings).id;
    for (const endpoint of ['https://api.minimax.cn/v1/', 'https://api.minimax.cn/v1/chat/completions', 'https://api.minimax.cn/v1']) {
      await f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, endpoint});
      assert.equal(first(f.settings).hasApiKey, true);
      assert.equal(first(f.settings).endpoint, endpoint);
    }
    await f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, endpoint: 'https://api.minimax.cn/v1/', clearApiKey: true});
    assert.equal(first(f.settings).hasApiKey, false, 'explicit key clearing takes priority');
    await f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, apiKey: 'fixture-retained-secret'});
    await f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, endpoint: 'https://api.minimax.cn/custom'});
    assert.equal(first(f.settings).hasApiKey, false, 'a genuinely different route still clears the old key');
    assert.equal(JSON.stringify(f.settings.publicState()).includes('fixture-retained-secret'), false);
  } finally {f.cleanup();}
});

test('known remote providers without a saved key fail before DNS or provider requests', async () => {
  let calls = 0;
  const f = fixture({providerFactory: () => {calls++;throw new Error('must not reach provider');}});
  try {
    await f.settings.addProfile(profileBody(f.settings, {provider: 'minimax', protocol: 'openai-chat-completions', endpoint: 'https://must-not-resolve.invalid/v1'}));
    await selectFirst(f.settings);
    assert.equal(f.settings.status().configured, false);
    assert.match(f.settings.status().reason, /尚未保存 API 密钥/);
    const state = await f.settings.testProfile(first(f.settings).id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});
    assert.equal(state.profiles[0].lastTest.code, 'missing_api_key');
    assert.match(state.profiles[0].lastTest.message, /重新填写/);
    assert.equal(state.capabilities.modelConnectionTestVersion, 2);
    assert.equal(calls, 0);
  } finally {f.cleanup();}
});

test('selected snapshots remain bound to profile after default selection changes and fail after profile edits', async () => {
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings));await selectFirst(f.settings);
    const selected = f.settings.snapshot();assert.ok(selected.fingerprint);assert.equal(JSON.stringify(selected).includes('apiKey'), false);
    await f.settings.select({baseRevision: f.settings.publicState().revision, profileId: null});assert.equal(f.settings.status().configured, false);
    assert.equal((await f.settings.providerFor(selected)).status().model, 'fixture-vision');
    await f.settings.updateProfile(first(f.settings).id, {baseRevision: f.settings.publicState().revision, name: '新版本'});
    await assert.rejects(f.settings.providerFor(selected), e => e.code === 'model_configuration_changed');
    await assert.rejects(f.settings.providerFor({...selected, endpoint: 'https://untrusted.invalid'}), e => e.status === 409);
  } finally {f.cleanup();}
});

test('model settings validates protocols, complete endpoint, private networks and model list', async () => {
  const f = fixture();
  try {
    for (const extra of [{endpoint: 'https://api.example.com/v1?k=secret'}, {endpoint: 'http://remote.invalid/v1'}, {endpoint: 'https://169.254.169.254/latest'}, {endpoint: 'https://10.1.2.3/v1'}, {endpoint: 'https://[fc00::1]/'}, {endpoint: 'https://x.internal/v1'}, {protocol: 'made-up'}, {models: []}]) await assert.rejects(f.settings.addProfile(profileBody(f.settings, extra)), e => e.status === 400);
    await f.settings.addProfile(profileBody(f.settings, {models: ['a', 'a', 'b']}));assert.deepEqual(first(f.settings).models, ['a', 'b']);
  } finally {f.cleanup();}
});

test('PNG vision challenge contains independent random pixel evidence with expected stripe colors', () => {
  for (let i = 0; i < 10; i++) {const c = createVisionChallenge();assert.deepEqual(colorsFromPng(c.payload.evidenceFrames[0].dataUrl), c.expected);assert.equal(new Set(c.expected).size, 3);assert.deepEqual(Object.keys(c.payload), ['evidenceFrames']);}
});

test('vision test passes only correct image interpretation, not HTTP 200 or valid JSON alone', async () => {
  let mode = 'correct', calls = 0;
  const remote = await server(async (req, res) => {calls++;let text = '';for await (const chunk of req) text += chunk;const input = JSON.parse(text);assert.equal(input.mode, 'vision_test');assert.equal(req.headers.authorization, undefined);const output = mode === 'correct' ? {colorsLeftToRight: colorsFromPng(input.input.evidenceFrames[0].dataUrl), pattern: 'vertical-stripes', count: 3} : {colorsLeftToRight: ['red'], pattern: 'vertical-stripes', count: 1};res.end(JSON.stringify(output));});
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings, {endpoint: remote.url + '/analyze', apiKey: ''}));
    const id = first(f.settings).id;
    let state = await f.settings.testProfile(id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});assert.equal(state.profiles[0].lastTest.visionPassed, true);assert.equal(state.profiles[0].lastTest.status, 'success');
    await selectFirst(f.settings);assert.equal(f.settings.status().visionVerified, true);
    mode = 'wrong';state = await f.settings.testProfile(id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});assert.equal(state.profiles[0].lastTest.visionPassed, false);assert.equal(f.settings.status().visionVerified, false);assert.equal(calls, 2);
  } finally {await remote.close();f.cleanup();}
});

test('late vision test cannot overwrite a newly edited profile', async () => {
  let enter, release;
  const entered = new Promise(resolve => enter = resolve), wait = new Promise(resolve => release = resolve);
  const f = fixture({providerFactory: () => ({visionTest: async () => {enter();await wait;return {output: {}};}})});
  try {
    await f.settings.addProfile(profileBody(f.settings));const id = first(f.settings).id;
    const running = f.settings.testProfile(id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});
    await entered;await f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, name: 'changed'});release();
    await assert.rejects(running, e => e.status === 409);assert.equal(first(f.settings).lastTest, undefined);
  } finally {release?.();f.cleanup();}
});

test('existing MiniMax Base URL and stored secret remain intact after a real protocol vision test', async () => {
  let calls = 0;
  const remote = await server(async (req, res) => {
    calls++;assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-base-url-secret');
    let text = '';for await (const chunk of req) text += chunk;
    const input = JSON.parse(text);
    assert.equal(input.reasoning_split, true);assert.equal(input.model, 'MiniMax-M3');
    const image = input.messages[0].content.find(item => item.type === 'image_url');
    const content = JSON.stringify({colorsLeftToRight: colorsFromPng(image.image_url.url), pattern: 'vertical-stripes', count: 3});
    res.end(JSON.stringify({choices: [{message: {content}}]}));
  });
  const f = fixture();
  try {
    const endpoint = remote.url + '/v1';
    await f.settings.addProfile(profileBody(f.settings, {provider: 'minimax', models: ['MiniMax-M3'], protocol: 'openai-chat-completions', endpoint, apiKey: 'fixture-base-url-secret'}));
    const before = first(f.settings);
    const state = await f.settings.testProfile(before.id, {baseRevision: f.settings.publicState().revision, modelId: 'MiniMax-M3'});
    assert.equal(state.profiles[0].lastTest.visionPassed, true);assert.equal(calls, 1);
    assert.equal(state.profiles[0].endpoint, endpoint);assert.equal(state.profiles[0].hasApiKey, true);
    assert.equal(state.profiles[0].revision, before.revision);
    assert.equal(JSON.stringify(state).includes('fixture-base-url-secret'), false);
  } finally {await remote.close();f.cleanup();}
});

test('connection test persists safe diagnostic codes without echoing arbitrary error messages', async () => {
  let code = 'tls_error';
  const f = fixture({providerFactory: () => ({visionTest: async () => {throw Object.assign(new Error('fixture-private-diagnostic'), {code});}})});
  try {
    await f.settings.addProfile(profileBody(f.settings));
    for (code of ['tls_error', 'dns_error', 'redirect_response', 'http_401', 'unknown-untrusted-code']) {
      const state = await f.settings.testProfile(first(f.settings).id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});
      assert.equal(state.profiles[0].lastTest.code, code === 'unknown-untrusted-code' ? 'vision_test_failed' : code);
      assert.equal(state.profiles[0].lastTest.status, 'failed');
      assert.equal(JSON.stringify(state).includes('fixture-private-diagnostic'), false);
    }
  } finally {f.cleanup();}
});

test('settings reload retains profile selection without exposing stored credentials', async () => {
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings, {apiKey: 'fixture-reload'}));await selectFirst(f.settings);
    const fresh = createModelSettings(f.root, {secretCodec: fixtureCodec()});assert.deepEqual(fresh.publicState(), f.settings.publicState());assert.equal((await fresh.providerFor(f.settings.snapshot())).status().configured, true);
  } finally {f.cleanup();}
});

test('explicit environment fallback is pinned while GUI profiles never inherit environment credentials', async () => {
  const names = ['PROVIDER', 'MODEL', 'ENDPOINT', 'PROTOCOL', 'API_KEY'].map(name => 'STUDIO_SHOT_ANALYSIS_' + name);
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let usedOptions;
  const f = fixture({providerFactory: options => {usedOptions = options;return {status: () => ({configured: true})};}});
  try {
    Object.assign(process.env, {STUDIO_SHOT_ANALYSIS_PROVIDER: 'fixture-env', STUDIO_SHOT_ANALYSIS_MODEL: 'fixture-env-model', STUDIO_SHOT_ANALYSIS_ENDPOINT: 'http://127.0.0.1:1/env', STUDIO_SHOT_ANALYSIS_PROTOCOL: 'json-http', STUDIO_SHOT_ANALYSIS_API_KEY: 'fixture-env-secret'});
    const environment = f.settings.snapshot();assert.equal(environment.source, 'environment');assert.equal(f.settings.status().configured, true);
    await f.settings.providerFor(environment);assert.equal(usedOptions.apiKey, 'fixture-env-secret');
    process.env.STUDIO_SHOT_ANALYSIS_API_KEY = 'changed-fixture-env-secret';await assert.rejects(f.settings.providerFor(environment), e => e.status === 409);
    await f.settings.addProfile(profileBody(f.settings));await selectFirst(f.settings);await f.settings.providerFor(f.settings.snapshot());assert.equal(usedOptions.apiKey, '');
    await f.settings.select({baseRevision: f.settings.publicState().revision, profileId: null});assert.equal(f.settings.status().configured, false);
    assert.equal(JSON.stringify(f.settings.publicState()).includes('changed-fixture-env-secret'), false);
  } finally {for (const name of names) {if (previous[name] === undefined) delete process.env[name];else process.env[name] = previous[name];}f.cleanup();}
});

test('corrupt persisted settings fail visibly without overwriting original file', () => {
  const f = fixture();
  try {const file = path.join(f.root, 'data/private/model-settings.json');fs.mkdirSync(path.dirname(file), {recursive: true});fs.writeFileSync(file, 'broken fixture');assert.throws(() => createModelSettings(f.root), /配置文件损坏/);assert.equal(fs.readFileSync(file, 'utf8'), 'broken fixture');} finally {f.cleanup();}
});

test('environment snapshots never expose credentials embedded in rejected legacy endpoint URLs', () => {
  const names = ['PROVIDER', 'MODEL', 'ENDPOINT', 'PROTOCOL'].map(name => 'STUDIO_SHOT_ANALYSIS_' + name), previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const f = fixture();
  try {
    Object.assign(process.env, {STUDIO_SHOT_ANALYSIS_PROVIDER: 'fixture-only', STUDIO_SHOT_ANALYSIS_MODEL: 'fixture-vision', STUDIO_SHOT_ANALYSIS_PROTOCOL: 'json-http'});
    for (const endpoint of ['https://fixture-user:fake-userinfo-token@example.invalid/api', 'https://example.invalid/api?api_key=fake-query-token', 'https://example.invalid/api#fake-fragment-token', 'not-a-url-fake-token']) {
      process.env.STUDIO_SHOT_ANALYSIS_ENDPOINT = endpoint;
      const selected = f.settings.snapshot();assert.equal(selected.endpoint, '');assert.equal(JSON.stringify(selected).includes('fake-'), false);assert.equal(f.settings.status().configured, false);assert.equal(JSON.stringify(f.settings.publicState()).includes('fake-'), false);
    }
  } finally {for (const name of names) {if (previous[name] === undefined) delete process.env[name];else process.env[name] = previous[name];}f.cleanup();}
});

test('failed provider tests never expose upstream diagnostics or credentials', async () => {
  const remote = await server((_req, res) => {res.statusCode = 401;res.end('test-only-upstream-secret-in-error');});
  const f = fixture();
  try {await f.settings.addProfile(profileBody(f.settings, {endpoint: remote.url, apiKey: 'test-only-api-key'}));const state = await f.settings.testProfile(first(f.settings).id, {baseRevision: f.settings.publicState().revision, modelId: 'fixture-vision'});assert.equal(state.profiles[0].lastTest.visionPassed, false);assert.match(state.profiles[0].lastTest.message, /^模型服务 HTTP 401：/);assert.equal(state.profiles[0].lastTest.code, 'http_401');assert.equal(JSON.stringify(state).includes('test-only-'), false);} finally {await remote.close();f.cleanup();}
});

test('Windows default DPAPI roundtrip persists fake fixture secret without cleartext', {skip: process.platform !== 'win32'}, async () => {
  const f = fixture();
  try {
    const manager = createModelSettings(f.root);await manager.addProfile(profileBody(manager, {apiKey: 'dpapi-fixture-only-not-a-real-key'}));await selectFirst(manager);
    const fresh = createModelSettings(f.root);assert.equal(fresh.publicState().secretStorage.kind, 'windows-dpapi');assert.equal(fresh.publicState().profiles[0].hasApiKey, true);assert.equal((await fresh.providerFor(manager.snapshot())).status().configured, true);
    assert.equal(fs.readFileSync(path.join(f.root, 'data/private/model-settings.json'), 'utf8').includes('dpapi-fixture-only-not-a-real-key'), false);
  } finally {f.cleanup();}
});

test('model settings router enforces local Host, same origin and JSON before mutations', async () => {
  const f = fixture();let mutations = 0;
  const router = createModelSettingsRouter(f.settings, {beforeMutation: ({operation}) => {assert.ok(['add', 'select', 'delete'].includes(operation));mutations++;}});
  const service = await server(async (req, res) => {if (!await router(req, res)) {res.statusCode = 404;res.end();}});
  try {
    const url = service.url + '/api/studio/model-settings';
    const get = await fetch(url);assert.equal(get.status, 200);const state = await get.json();assert.equal(state.profiles.length, 0);
    const body = JSON.stringify(profileBody(f.settings));
    assert.equal((await fetch(url + '/profiles', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'https://evil.example'}, body})).status, 403);
    assert.equal((await fetch(url + '/profiles', {method: 'POST', headers: {'Content-Type': 'text/plain'}, body})).status, 415);
    const badHost = await new Promise((resolve, reject) => {const req = http.get(url, {headers: {Host: 'evil.example'}}, res => {res.resume();resolve(res.statusCode);});req.on('error', reject);});assert.equal(badHost, 403);
    const proxiedHost = await new Promise((resolve, reject) => {const req = http.get(url, {headers: {Host: '127.0.0.1:8198', Origin: 'http://127.0.0.1:8198'}}, res => {res.resume();resolve(res.statusCode);});req.on('error', reject);});assert.equal(proxiedHost, 200, 'same-origin loopback Vite proxy may preserve a different frontend port');
    assert.equal((await fetch(url + '/profiles', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: service.url}, body})).status, 200);
    assert.equal(mutations, 2, 'mutation guard runs before asynchronous work and again immediately before commit');
    const selected = await fetch(url + '/select', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({baseRevision: f.settings.publicState().revision, profileId: null})});assert.equal(selected.status, 200);
    assert.equal((await fetch(url + '/profiles/none', {method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({baseRevision: f.settings.publicState().revision})})).status, 404);
  } finally {await service.close();f.cleanup();}
});

test('two manager instances refresh disk revisions and reject stale writes instead of losing profiles', async () => {
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings));await selectFirst(f.settings);
    const oldSnapshot = f.settings.snapshot(), other = createModelSettings(f.root, {secretCodec: fixtureCodec()});
    const staleRevision = other.publicState().revision;
    await f.settings.addProfile(profileBody(f.settings, {name: 'added by first process'}));
    await assert.rejects(other.select({baseRevision: staleRevision, profileId: oldSnapshot.profileId, modelId: oldSnapshot.model}), e => e.status === 409);
    assert.equal(other.publicState().profiles.length, 2);
    await f.settings.updateProfile(oldSnapshot.profileId, {baseRevision: f.settings.publicState().revision, endpoint: 'http://127.0.0.1:1/new-version'});
    await assert.rejects(other.providerFor(oldSnapshot), e => e.code === 'model_configuration_changed');
    assert.equal(other.snapshot().endpoint, 'http://127.0.0.1:1/new-version');
    await f.settings.deleteProfile(oldSnapshot.profileId, {baseRevision: f.settings.publicState().revision});
    assert.equal(other.status().configured, false);assert.equal(other.publicState().profiles.length, 1);
  } finally {f.cleanup();}
});

test('disk CAS rejects a write when another manager changes configuration during async credential encryption', async () => {
  let entered, release;
  const started = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve);
  const codec = {...fixtureCodec(), encrypt: async value => {entered();await wait;return Buffer.from(value).toString('base64');}};
  const f = fixture({secretCodec: codec});
  try {
    await f.settings.addProfile(profileBody(f.settings));const id = first(f.settings).id;
    const other = createModelSettings(f.root, {secretCodec: fixtureCodec()});
    const update = f.settings.updateProfile(id, {baseRevision: f.settings.publicState().revision, apiKey: 'fixture-awaiting-key'});
    await started;
    await other.addProfile(profileBody(other, {name: 'concurrent profile'}));release();
    await assert.rejects(update, e => e.status === 409);
    assert.equal(f.settings.publicState().profiles.length, 2);assert.equal(first(f.settings).hasApiKey, false);
    assert.equal(fs.existsSync(path.join(f.root, 'data/private/model-settings.json.lock')), false);
  } finally {release?.();f.cleanup();}
});

test('commit guard rechecks newly active jobs after slow credential encryption and preserves original profile', async () => {
  let entered, release, active = false;
  const started = new Promise(resolve => entered = resolve), wait = new Promise(resolve => release = resolve);
  const f = fixture({secretCodec: {...fixtureCodec(), encrypt: async value => {entered();await wait;return Buffer.from(value).toString('base64');}}});
  try {
    await f.settings.addProfile(profileBody(f.settings));const initial = f.settings.publicState();
    const updating = f.settings.updateProfile(initial.profiles[0].id, {baseRevision: initial.revision, apiKey: 'fixture-only-delayed'}, () => {if (active) throw Object.assign(new Error('active run'), {status: 409});});
    await started;active = true;release();await assert.rejects(updating, e => e.status === 409);
    assert.equal(f.settings.publicState().revision, initial.revision);assert.equal(first(f.settings).hasApiKey, false);
  } finally {release?.();f.cleanup();}
});

test('existing write lock fails visibly without deleting an unknown lock or overwriting configuration', async () => {
  const f = fixture();
  try {
    await f.settings.addProfile(profileBody(f.settings));const initial = f.settings.publicState();
    const lock = path.join(f.root, 'data/private/model-settings.json.lock');fs.writeFileSync(lock, 'fixture-owner');
    await assert.rejects(f.settings.select({baseRevision: initial.revision, profileId: null}), e => e.status === 503);
    assert.equal(fs.readFileSync(lock, 'utf8'), 'fixture-owner');assert.equal(f.settings.publicState().revision, initial.revision);fs.unlinkSync(lock);
  } finally {f.cleanup();}
});
