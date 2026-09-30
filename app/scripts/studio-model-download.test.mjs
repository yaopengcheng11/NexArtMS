import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadModelRecord, loadDetRecord} from '../studio/vision.mjs';

const scriptFile = fileURLToPath(new URL('./fetch-detector-model.mjs', import.meta.url));
const visionUrl = new URL('../studio/vision.mjs', import.meta.url).href;
const modelFiles = ['yolov8n-pose-int8.onnx', 'yolos-tiny-det-int8.onnx'];

function runDownload(t, existing = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-model-download-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const scripts = path.join(root, 'app', 'scripts');
  fs.mkdirSync(scripts, {recursive: true});
  const script = path.join(scripts, 'fetch-detector-model.mjs');
  const source = fs.readFileSync(scriptFile, 'utf8');
  assert.ok(source.includes("'../studio/vision.mjs'"));
  // Keep the real CLI under app/scripts in an isolated repository. Only its
  // module import changes so the test exercises the production download code.
  fs.writeFileSync(script, source.replace("'../studio/vision.mjs'", JSON.stringify(visionUrl)));
  const models = path.join(root, 'data', 'models');
  if (existing) {
    fs.mkdirSync(models, {recursive: true});
    for (const file of modelFiles) fs.writeFileSync(path.join(models, file), `existing fixture ${file}`);
  }
  const requests = path.join(root, 'requests.jsonl');
  const preload = path.join(root, 'mock-fetch.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
globalThis.fetch = async url => {
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(String(url)) + '\\n');
  return new Response(String(url).endsWith('.onnx') ? 'downloaded fixture weights' : '{}', {status: 200});
};
`);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
    cwd: root, env: {...process.env, FORCE: ''}, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /姿态模型就绪/);
  assert.match(child.stdout, /动物检测模型就绪/);
  assert.equal(fs.existsSync(path.join(root, 'app', 'data')), false, 'must not create a second model directory under app');
  const records = [loadModelRecord(root), loadDetRecord(root)];
  for (const [index, record] of records.entries()) {
    assert.ok(record, 'the service must find the record at the repository data root');
    assert.equal(record.file, modelFiles[index]);
    const bytes = fs.readFileSync(path.join(models, record.file));
    assert.equal(record.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(record.sizeBytes, bytes.length);
    assert.equal(record.sourceUrl === null, existing);
  }
  for (const file of ['yolos-tiny-config.json', 'yolos-tiny-preprocessor.json']) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(models, file), 'utf8')), {});
  }
  const calls = fs.readFileSync(requests, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(url => url.endsWith('.onnx')).length, existing ? 0 : 2);
}

test('model download CLI stores both weights and service records at the repository data root', t => runDownload(t));

test('model download CLI registers existing repository weights without downloading them again', t => runDownload(t, true));
