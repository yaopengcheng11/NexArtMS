import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import {chromium} from 'playwright';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reports = path.join(root, 'reports', 'v2-fix-acceptance');
const acceptance = JSON.parse(fs.readFileSync(path.join(reports, 'acceptance.json'), 'utf8'));
assert.equal(acceptance.status, 'passed', 'render only the verified acceptance project');
const dataRoot = path.resolve(acceptance.storeRoot);
const detail = JSON.parse(fs.readFileSync(path.join(reports, 'final-detail.json'), 'utf8'));
const timeline = JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', 'projects', acceptance.projectId, 'exports', acceptance.export.exportId, 'timeline.json'), 'utf8'));
const output = path.join(reports, 'full-preview-720p.mp4');
const framesDir = fs.mkdtempSync(path.join(dataRoot, 'render-frames-'));
const fps = detail.media.vfr ? 30 : detail.media.fps;
const frameCount = Math.ceil(timeline.durationUs / 1e6 * fps);
const bundle = await build({entryPoints: [path.join(root, 'scripts', 'studio-preview-renderer.ts')], bundle: true, write: false, format: 'iife', globalName: 'StudioPreview', platform: 'browser', target: 'es2022'});
const browser = await chromium.launch({headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
const page = await browser.newPage({viewport: {width: 1280, height: 720}, deviceScaleFactor: 1});
const pageErrors = [];page.on('pageerror', error => pageErrors.push(String(error)));
const startedAt = new Date().toISOString();
try {
  await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  await page.addScriptTag({content: bundle.outputFiles[0].text});
  await page.evaluate(() => {window.renderAcceptanceFrame = StudioPreview.createPreviewRenderer(1280, 720);});
  let sampleIndex = 0;
  for (let index = 0; index < frameCount; index++) {
    const ptsUs = Math.round(index / fps * 1e6);
    while (sampleIndex + 1 < timeline.frames.length && timeline.frames[sampleIndex + 1].ptsUs <= ptsUs) sampleIndex++;
    await page.evaluate(frame => window.renderAcceptanceFrame(frame), timeline.frames[sampleIndex]);
    await page.screenshot({path: path.join(framesDir, `frame-${String(index).padStart(6, '0')}.png`)});
    if (index % 120 === 0) console.log(JSON.stringify({rendered: index, total: frameCount, shotId: timeline.frames[sampleIndex].shotId}));
  }
  assert.deepEqual(pageErrors, []);
} finally {await browser.close();}
// Preserve the reference soundtrack. Rendering is deliberately an acceptance
// artifact; it is not advertised as a finished in-product video export feature.
await exec(process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(framesDir, 'frame-%06d.png'), '-i', path.join(root, 'public', 'reference.mp4'), '-map', '0:v:0', '-map', '1:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-t', String(timeline.durationUs / 1e6), output], {maxBuffer: 4e6});
const probe = JSON.parse((await exec(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
const video = probe.streams.find(stream => stream.codec_type === 'video');
assert.equal(video.width, 1280);assert.equal(video.height, 720);assert.equal(Number(video.nb_frames), frameCount);
assert(Math.abs(Number(probe.format.duration) - timeline.durationUs / 1e6) < 1 / fps + .05);
await exec(process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', output, '-vf', `fps=${9 / (timeline.durationUs / 1e6)},scale=426:240,tile=3x3`, '-frames:v', '1', path.join(reports, 'contact-sheet.jpg')]);
const evidence = {startedAt, finishedAt: new Date().toISOString(), status: 'passed', projectId: acceptance.projectId, exportId: acceptance.export.exportId, output, frameCount, fps, width: 1280, height: 720, durationS: Number(probe.format.duration), bytes: fs.statSync(output).size, audio: probe.streams.some(stream => stream.codec_type === 'audio'), pageErrors,
  limitation: 'This is a complete-duration acceptance preview of the current draft. Missing motion remains standing placeholders; animals and unsolved original camera motion are not reconstructed.'};
fs.writeFileSync(path.join(reports, 'render.json'), JSON.stringify(evidence, null, 2));
const resolved = path.resolve(framesDir);
if (path.dirname(resolved) !== dataRoot || !path.basename(resolved).startsWith('render-frames-')) throw new Error('unsafe cleanup path');
fs.rmSync(resolved, {recursive: true, force: true, maxRetries: 5});
console.log(JSON.stringify(evidence));
