import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import childProcess, {execFile} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {createStudioStore} from '../studio/db.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {buildProxy, extractPtsMap} from '../studio/media.mjs';

const exec = promisify(execFile);
const hasFfmpeg = await exec('ffprobe', ['-version']).then(() => true).catch(() => false);

test('PTS API preserves source evidence while preview clocks are cached, refreshed, or unavailable', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-playback-http-'));
  const source = path.join(root, 'source.mp4'), preview = path.join(root, 'preview.mp4'), replacement = path.join(root, 'replacement.mp4');
  const store = createStudioStore(root), project = store.createProject({name: 'Disposable playback fixture'});
  let server;
  const originalSpawn = childProcess.spawn;
  try {
    await exec('ffmpeg', ['-v', 'error', '-y', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'testsrc2=size=120x80:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-t', '2.5', '-c:v', 'libx264', '-c:a', 'aac', source]);
    await buildProxy(source, preview);
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', source, '-an', '-vf', 'setpts=PTS-STARTPTS', '-fps_mode', 'passthrough', '-c:v', 'libx264', replacement]);
    const {pts} = await extractPtsMap(source, root, 'm-clock');
    const ptsUs = pts.map(value => Math.round(value * 1e6));
    store.insertMedia(project.id, {id: 'm-clock', sha256: 'a'.repeat(64), originalName: 'source.mp4', originalRef: 'source.mp4', proxyRef: 'preview.mp4',
      durationUs: 2500000, width: 120, height: 80, rotation: 0, timebase: '1/10240', fpsNum: 10, fpsDen: 1, vfr: false, videoCodec: 'h264', audioCodec: 'aac',
      ptsCount: pts.length, ptsMapRef: 'm-clock-pts-map.json', sizeBytes: fs.statSync(source).size, baseRevision: project.revision});
    const router = createStudioRouter(store, root);
    server = http.createServer((req, res) => {void router(req, res).then(handled => {if (!handled) res.writeHead(404).end('{}');});});
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/studio/projects/${project.id}/media/pts`;
    const read = async (suffix = '') => {const response = await fetch(url + suffix);assert.equal(response.status, 200);return response.json();};
    let probes = 0;
    childProcess.spawn = (...args) => {if (args[0] === (process.env.FFPROBE || 'ffprobe')) probes++;return originalSpawn(...args);};
    syncBuiltinESMExports();

    const concurrent = await Promise.all([read(), read(), read()]);
    for (const result of concurrent) {
      assert.deepEqual(result.ptsUs, ptsUs);
      assert.equal(result.ready, true);
      assert.deepEqual(result.playback, {sourceOriginUs: 500000, mediaOriginUs: 500000, mediaKind: 'preview'});
    }
    await read();assert.equal(probes, 1, 'concurrent reads and later workspace visits share one probe');
    fs.copyFileSync(replacement, preview);
    fs.utimesSync(preview, new Date(), new Date(Date.now() + 1000));
    assert.deepEqual((await read()).playback, {sourceOriginUs: 500000, mediaOriginUs: 0, mediaKind: 'preview'});
    assert.equal(probes, 2, 'replaced preview invalidates the cached clock');

    fs.writeFileSync(preview, 'not a playable preview');
    const broken = await read();assert.equal(broken.playback, null);assert.match(broken.playbackError, /时间信息/);
    assert.deepEqual(broken.ptsUs, ptsUs);assert.equal(broken.ready, true);
    await read();assert.equal(probes, 4, 'failed probes can be retried');
    fs.rmSync(preview);
    const missing = await read();assert.equal(missing.playback, null);assert.deepEqual(missing.ptsUs, ptsUs);
    assert.equal(probes, 4, 'missing media does not spawn a probe');

    const original = await read('?playback=original');
    assert.deepEqual(original.playback, {sourceOriginUs: 500000, mediaOriginUs: 500000, mediaKind: 'original'});
    await read('?playback=original');assert.equal(probes, 5, 'original playback uses its own cached media clock');
  } finally {
    childProcess.spawn = originalSpawn;syncBuiltinESMExports();
    if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}
    store.close();fs.rmSync(root, {recursive: true, force: true});
  }
});
