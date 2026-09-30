import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DEFAULT_LIMITS, probeMedia, extractPtsMap, extractSignatures, buildProxy, receiveUpload, readPlaybackClock} from '../studio/media.mjs';
import {computeScores, detectCutsFromScores} from '../studio/cuts.mjs';
import {frameStream} from '../studio/vision.mjs';


const execFileAsync = promisify(execFile);
const hasFfmpeg = await new Promise(resolve => {
  const child = execFileAsync('ffprobe', ['-version']).then(() => true).catch(() => false);
  resolve(child);
});

function tempDir(prefix) {return fs.mkdtempSync(path.join(os.tmpdir(), prefix));}

// 生成带两个硬切的测试视频：0–1s 黑→1–2s 白→2–3s 灰，320x240@12fps。
async function makeTestVideo(dir) {
  const file = path.join(dir, 'sample.mp4');
  await execFileAsync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=12:duration=1',
    '-f', 'lavfi', '-i', 'color=white:size=320x240:rate=12:duration=1',
    '-f', 'lavfi', '-i', 'color=0x808080:size=320x240:rate=12:duration=1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
    '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  return file;
}

test('frame stream awaits slow inference callbacks and completes only after every sampled frame',async t=>{
  if(!hasFfmpeg)return t.skip('需要 FFmpeg');
  const dir=tempDir('studio-frame-stream-');
  try {
    const file=await makeTestVideo(dir);
    let active=0,maxActive=0;
    const frames=[];
    const count=await frameStream(file,{width:32,height:32,stride:3,onFrame:async(rgb,index)=>{
      active++;maxActive=Math.max(active,maxActive);
      const before=Buffer.from(rgb);
      await new Promise(resolve=>setTimeout(resolve,5));
      assert.deepEqual(rgb,before);frames.push(index);active--;
    }});
    assert.equal(count,12);assert.equal(active,0);assert.equal(maxActive,1);
    assert.deepEqual(frames,Array.from({length:12},(_,i)=>i));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('upload receiver streams to disk, hashes content, and rejects non-MP4 containers', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-media-');
  try {
    const sample = await makeTestVideo(dir);
    const bytes = fs.readFileSync(sample);

    const good = new PassThrough();
    const goodResult = receiveUpload(good, path.join(dir, 'in'), DEFAULT_LIMITS);
    good.end(bytes);
    const received = await goodResult;
    assert.equal(received.sizeBytes, bytes.length);
    const expectedHash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    assert.equal(received.sha256, expectedHash);

    const bad = new PassThrough();
    const badResult = receiveUpload(bad, path.join(dir, 'in'), DEFAULT_LIMITS);
    bad.end(Buffer.from('this is not a video at all, just plain text padding'.repeat(8)));
    await assert.rejects(() => badResult, error => error.status === 422 && /ftyp/.test(error.message));

    const oversizeStream = new PassThrough();
    const oversize = receiveUpload(oversizeStream, path.join(dir, 'in'), {...DEFAULT_LIMITS, maxUploadBytes: 16});
    oversizeStream.end(Buffer.alloc(64, 7));
    await assert.rejects(() => oversize, error => error.status === 413);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('probe reports duration, size, codec and detects the 12fps CFR sample', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-probe-');
  try {
    const sample = await makeTestVideo(dir);
    const probe = await probeMedia(sample, DEFAULT_LIMITS);
    assert.ok(Math.abs(probe.durationUs - 3_000_000) < 200_000, `时长 ${probe.durationUs} 应接近 3s`);
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 240);
    assert.equal(probe.videoCodec, 'h264');
    assert.equal(probe.vfr, false);

    await assert.rejects(() => probeMedia(sample, {...DEFAULT_LIMITS, maxDurationS: 2}), error => error.status === 422 && /上限/.test(error.message));
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('PTS map counts every presented frame and signatures feed real cut detection', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-pts-');
  try {
    const sample = await makeTestVideo(dir);
    const {pts} = await extractPtsMap(sample, dir, 'm-x');
    assert.equal(pts.length, 36, '12fps × 3s = 36 个呈现帧');
    assert.ok(pts.every((value, index) => index === 0 || value > pts[index - 1]), 'PTS 单调递增');

    const signatures = await extractSignatures(sample, {scaleWidth: 32, scaleHeight: 24});
    assert.equal(signatures.length, pts.length, '帧签名数量与呈现帧一致');
    const cuts = detectCutsFromScores(computeScores(signatures));
    assert.ok(cuts.includes(12) || cuts.includes(11) || cuts.includes(13), `黑→白切点应在第 12 帧附近，实际 ${JSON.stringify(cuts)}`);
    assert.ok(cuts.includes(24) || cuts.includes(23) || cuts.includes(25), `白→灰切点应在第 24 帧附近`);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('proxy transcode produces a playable file close to the source duration', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-proxy-');
  try {
    const sample = await makeTestVideo(dir);
    const proxy = path.join(dir, 'out', 'preview.mp4');
    let progressCalls = 0;
    await buildProxy(sample, proxy, () => progressCalls++, 3_000_000);
    assert.ok(fs.statSync(proxy).size > 1000);
    const probe = await probeMedia(proxy, DEFAULT_LIMITS);
    assert.ok(Math.abs(probe.durationUs - 3_000_000) < 600_000);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('existing audio-leading proxies keep their video offset in the source clock', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-playback-offset-');
  try {
    const source = path.join(dir, 'audio-leading.mp4'), preview = path.join(dir, 'preview.mp4');
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-itsoffset', '0.5', '-f', 'lavfi', '-i', 'testsrc2=size=120x80:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-map', '0:v', '-map', '1:a', '-t', '2.5', '-c:v', 'libx264', '-c:a', 'aac', source]);
    const originalPts = (await extractPtsMap(source, dir, 'source')).pts;
    await buildProxy(source, preview);
    const before = fs.readFileSync(preview);
    const clock = await readPlaybackClock(preview, Math.round(originalPts[0] * 1e6));
    assert.deepEqual(clock, {sourceOriginUs: 500000, mediaOriginUs: 500000});
    const previewPts = (await extractPtsMap(preview, dir, 'preview')).pts;
    assert.deepEqual(previewPts, originalPts, 'the preview retained the leading half-second of audio');
    assert.equal(1000000 + clock.sourceOriginUs - clock.mediaOriginUs, 1000000, 'browser 1s must sample source 1s');
    assert.deepEqual(fs.readFileSync(preview), before, 'probing an existing proxy never rewrites it');
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

test('a rebased proxy and the original media have distinct clocks for nonzero source PTS', async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const dir = tempDir('studio-playback-rebased-');
  try {
    const source = path.join(dir, 'nonzero.mp4'), preview = path.join(dir, 'preview.mp4');
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=120x80:rate=12:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-output_ts_offset', '2.4', source]);
    const originalPts = (await extractPtsMap(source, dir, 'source')).pts;
    const sourceOriginUs = Math.round(originalPts[0] * 1e6);
    await buildProxy(source, preview);
    const previewPts = (await extractPtsMap(preview, dir, 'preview')).pts;
    const clock = await readPlaybackClock(preview, sourceOriginUs);
    assert.ok(sourceOriginUs > 2300000);
    assert.equal(clock.mediaOriginUs, 0);
    assert.equal(previewPts.length, originalPts.length);
    originalPts.forEach((pts, index) => assert.ok(Math.abs(Math.round(previewPts[index] * 1e6) + sourceOriginUs - Math.round(pts * 1e6)) <= 1));
    assert.deepEqual(await readPlaybackClock(source, sourceOriginUs), {sourceOriginUs, mediaOriginUs: sourceOriginUs}, 'original fallback keeps absolute browser PTS');
    await assert.rejects(() => readPlaybackClock(source, NaN), error => error.status === 409);
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});
