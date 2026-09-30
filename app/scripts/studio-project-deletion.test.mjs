import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStudioStore} from '../studio/db.mjs';
import {createStudioRouter} from '../studio/router.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {for (let i = 0; i < 200; i++) {if (predicate()) return;await delay(10);}throw Error('fixture condition timed out');}
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-delete-regression-'));
  const store = createStudioStore(root), project = store.createProject({name: 'Disposable delete fixture'}), other = store.createProject({name: 'Keep other project'});
  const file = path.join(store.mediaDir(project.id), 'preview.mp4');
  const fd = fs.openSync(file, 'w');fs.ftruncateSync(fd, 32 * 1024 * 1024);fs.closeSync(fd);
  store.insertMedia(project.id, {id: 'm-fixture', sha256: 'a'.repeat(64), originalName: 'preview.mp4', originalRef: path.relative(root, file), proxyRef: path.relative(root, file),
    durationUs: 1000000, width: 120, height: 80, rotation: 0, timebase: '1/24', fpsNum: 24, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: null, ptsCount: 24, sizeBytes: 32 * 1024 * 1024, baseRevision: project.revision});
  const router = createStudioRouter(store, root);
  const server = http.createServer((req, res) => router(req, res).then(handled => {if (!handled) res.writeHead(404).end('{}');}).catch(() => res.writeHead(500).end('{}')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, route = `/api/studio/projects/${project.id}`;
  const body = () => ({baseRevision: store.getProjectRow(project.id).revision, confirmName: project.name});
  const api = async (method, url, input) => {const res = await fetch(base + url, {method, ...(input ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)} : {})});return {status: res.status, data: await res.json()};};
  return {root, store, project, other, file, base, route, body, api, cleanup: async () => {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('studio-delete-regression-'));
    fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});
  }};
}

test('deletion aborts its video reader, waits for actual fd close, and leaves other projects responsive', async () => {
  const f = await fixture(), originalRead = fs.createReadStream, originalRename = fs.renameSync;
  let response, request, stream, closeRequested = false, fileClosed = false, renameAttempted = false;
  fs.createReadStream = function(file, opts) {
    const result = originalRead.call(fs, file, opts);
    if (path.resolve(file) === f.file) {
      stream = result;
      const destroy = result.destroy.bind(result);
      result.destroy = error => {if (!closeRequested) {closeRequested = true;setTimeout(() => destroy(error), 180);}return result;};
      result.once('close', () => {fileClosed = true;});
    }
    return result;
  };
  fs.renameSync = function(source, target) {if (source === f.store.projectDir(f.project.id)) {renameAttempted = true;assert.equal(fileClosed, true, 'directory move must wait for stream.close, not response.close');}return originalRename.call(fs, source, target);};
  try {
    response = await new Promise((resolve, reject) => {request = http.get(f.base + f.route + '/media/preview', res => {res.on('error', () => {});res.pause();resolve(res);});request.on('error', reject);});
    assert.equal(response.statusCode, 200);assert.ok(stream);
    assert.equal((await f.api('DELETE', f.route, {...f.body(), confirmName: 'wrong'})).status, 400);
    assert.equal(closeRequested, false, 'invalid deletion must leave playback running');
    const removal = f.api('DELETE', f.route, f.body());
    await until(() => closeRequested);
    const health = await f.api('GET', `/api/studio/projects/${f.other.id}`);
    assert.equal(health.status, 200);assert.equal(renameAttempted, false);
    assert.equal((await f.api('GET', f.route + '/media/preview')).status, 409);
    const deleted = await removal;
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));assert.equal(deleted.data.deleted, true);
    assert.ok(renameAttempted);assert.ok(fileClosed);assert.equal(fs.existsSync(f.store.projectDir(f.project.id)), false);
    assert.ok(f.store.getProjectRow(f.other.id));
  } finally {fs.createReadStream = originalRead;fs.renameSync = originalRename;response?.destroy();request?.destroy();await f.cleanup();}
});

test('transient Windows rename lock releases on the event loop while new writes stay excluded', async () => {
  const f = await fixture(), rename = fs.renameSync;
  let waiting = false, timerReleased = false, attempts = 0;
  fs.renameSync = function(source, target) {
    if (source === f.store.projectDir(f.project.id)) {
      attempts++;
      if (!timerReleased) {if (!waiting) {waiting = true;setTimeout(() => {timerReleased = true;}, 180);}throw Object.assign(new Error('fixture held file'), {code: 'EPERM'});}
    }
    return rename.call(fs, source, target);
  };
  try {
    const saved = f.body(), removal = f.api('DELETE', f.route, saved);
    await until(() => waiting);
    assert.equal((await f.api('PATCH', f.route, {...saved, name: 'must not change'})).status, 409);
    assert.equal((await f.api('POST', f.route + '/analysis', {kind: 'cuts'})).status, 409);
    assert.equal((await f.api('DELETE', f.route, saved)).status, 409);
    assert.equal((await f.api('GET', `/api/studio/projects/${f.other.id}`)).status, 200);
    assert.equal((await removal).status, 200);assert.ok(timerReleased);assert.ok(attempts > 1);
  } finally {fs.renameSync = rename;await f.cleanup();}
});

test('persistent external file lock times out without deleting data and a later retry succeeds', async () => {
  const f = await fixture(), rename = fs.renameSync;
  fs.renameSync = function(source, target) {if (source === f.store.projectDir(f.project.id)) throw Object.assign(new Error('fixture external lock'), {code: 'EPERM'});return rename.call(fs, source, target);};
  try {
    const deleted = await f.api('DELETE', f.route, f.body());
    assert.equal(deleted.status, 409);assert.match(deleted.data.error, /数据保持原样/);
    assert.ok(fs.existsSync(f.file));assert.ok(f.store.getProjectRow(f.project.id));
    assert.equal((await f.api('GET', f.route)).status, 200, 'deletion guard must clear after failure');
    fs.renameSync = rename;
    assert.equal((await f.api('DELETE', f.route, f.body())).status, 200);
  } finally {fs.renameSync = rename;await f.cleanup();}
});
