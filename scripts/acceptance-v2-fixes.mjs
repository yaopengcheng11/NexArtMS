// Full real-model regression in a separately configured STUDIO_DATA_ROOT server.
// Leaves the newly created project and evidence for the user to inspect.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = process.env.BASE_URL || 'http://127.0.0.1:8210';
const storeRoot = path.resolve(process.env.STUDIO_DATA_ROOT || path.join(root, '.checks', 'v2-fix-acceptance'));
const reports = path.join(root, 'reports', 'v2-fix-acceptance');
fs.mkdirSync(reports, {recursive: true});
const saved = process.env.ACCEPTANCE_PROJECT_ID && fs.existsSync(path.join(reports, 'acceptance.json')) ? JSON.parse(fs.readFileSync(path.join(reports, 'acceptance.json'), 'utf8')) : null;
const evidence = saved || {startedAt: new Date().toISOString(), base, storeRoot, source: 'public/reference.mp4', steps: [], errors: []};
if (saved) {evidence.previousAttempts = [...(evidence.previousAttempts || []), {status: evidence.status, errors: evidence.errors, finishedAt: evidence.finishedAt}];evidence.errors = [];}
const save = () => fs.writeFileSync(path.join(reports, 'acceptance.json'), JSON.stringify(evidence, null, 2));
const step = (name, data = {}) => {evidence.steps.push({name, at: new Date().toISOString(), ...data});save();console.log(JSON.stringify({step: name, ...data}));};
const api = async (method, url, body) => {
  const response = await fetch(base + url, {method, headers: body instanceof Buffer ? {'Content-Type': 'application/octet-stream'} : {'Content-Type': 'application/json'}, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body)});
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${data.error || ''}`);
  return data;
};
const summary = d => ({shots: d.shots.length, people: d.people.filter(p => p.subject === 'person').length, animals: d.people.filter(p => p.subject === 'animal').length,
  humanTracks: d.tracks.filter(t => t.status === 'active' && t.subject === 'person').length, animalTracks: d.tracks.filter(t => t.status === 'active' && t.subject === 'animal').length,
  motions: Object.keys(d.motionRefs).length, draft: d.draft});
let projectId = process.env.ACCEPTANCE_PROJECT_ID;
if (projectId) {evidence.base = base;evidence.projectUrl = `${base}/?project=${projectId}`;}
const detail = () => api('GET', `/api/studio/projects/${projectId}`);
const waitJobs = async () => {
  const deadline = Date.now() + 30 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const value = await detail();
    const pending = value.jobs.filter(j => ['queued', 'running'].includes(j.state));
    const status = pending.map(j => `${j.kind}:${Math.round(j.progress * 100)}`).join(' ');
    if (status !== last) {last = status;console.log(`jobs ${status || 'idle'}`);}
    if (!pending.length) {
      assert.deepEqual(value.jobs.filter(j => j.state === 'failed').map(j => ({kind: j.kind, error: j.error})), [], 'no failed jobs');
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('jobs exceeded 30 minutes');
};
const run = async (kind, options = {}) => {
  await api('POST', `/api/studio/projects/${projectId}/analysis`, {kind, ...options});
  return waitJobs();
};

try {
  const capabilities = await api('GET', '/api/studio/capabilities');
  assert(capabilities.ffmpeg && capabilities.detectorAvailable, 'real detector and ffmpeg required');
  let current;
  if (!projectId) {
  const created = await api('POST', '/api/studio/projects', {name: 'V2 修复全量验收 · 2026-09-27', sceneMode: 'proxy'});
  projectId = created.project.id;evidence.projectId = projectId;evidence.projectUrl = `${base}/?project=${projectId}`;
  const source = path.join(root, 'public', 'reference.mp4');
  await api('POST', `/api/studio/projects/${projectId}/media?name=reference.mp4&baseRevision=${created.project.revision}`, fs.readFileSync(source));
  step('新建隔离测试项目并上传完整原片', {projectId, projectUrl: evidence.projectUrl});
  current = await waitJobs();
  for (const kind of ['proxy', 'pts', 'cuts', 'detect', 'people', 'motion']) assert(current.jobs.some(j => j.kind === kind && j.state === 'done'), `${kind} must finish automatically`);
  assert(['ready', 'ready_with_issues'].includes(current.draft.state));
  assert(current.shots.length > 2 && current.media.durationUs > 45e6, 'use full montage, not a short substitute');
  evidence.automaticDraft = summary(current);
  fs.writeFileSync(path.join(reports, 'automatic-detail.json'), JSON.stringify(current, null, 2));
  step('零人工确认完成自动初稿', {shots: current.shots.length, motions: Object.keys(current.motionRefs).length, state: current.draft.state, coveragePct: current.draft.coveragePct});

  current = await run('detect', {subjects: 'both'});
  step('自动临时组之后可直接重跑双类检测', {activeTracks: current.tracks.filter(t => t.status === 'active').length});
  current = await run('people');
  const groups = [];
  for (const [index, level] of ['CL0', 'CL1', 'CL2'].entries()) {
    const saved = await api('POST', `/api/studio/projects/${projectId}/characters`, {baseRevision: current.project.revision, name: `验收代理 ${level}`, color: ['#b34639', '#3179a8', '#668a3b'][index], scale: 1.75, allowSimultaneous: true, proxyLevel: level});
    groups.push(saved.character);current = await detail();
  }
  const humans = current.people.filter(p => p.subject === 'person');
  for (let index = 0; index < groups.length; index++) {
    const ids = humans.filter((_, i) => i % groups.length === index).map(p => p.id);
    if (!ids.length) continue;
    await api('PATCH', `/api/studio/projects/${projectId}/people`, {baseRevision: current.project.revision, action: 'assign', personIds: ids, assignment: groups[index].id});
    current = await detail();
  }
  current = await run('motion');
  assert(Object.keys(current.motionRefs).length > 0, 'real model must produce motion data');
  step('人工分为三组并使用独立CL和颜色后重算', {groups: groups.map(g => ({id: g.id, proxyLevel: g.proxy_level || g.proxyLevel})), motions: Object.keys(current.motionRefs).length});
  } else {
    assert.equal(evidence.projectId, projectId, 'resume only the recorded acceptance project');
    current = await waitJobs();
    assert.equal(current.project.name, 'V2 修复全量验收 · 2026-09-27', 'never mutate an unrelated project');
    assert(current.characters.filter(c => c.name.startsWith('验收代理 CL')).length === 3, 'resume expects the completed grouping stage');
    step('继续同一测试项目的浏览器与导出验收');
  }

  const browser = await chromium.launch({headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const pageErrors = [];
  const motionRequests = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('request', request => {if (/\/tracks\/[^/]+\/motion/.test(request.url())) motionRequests.push(request.url());});
  try {
    await page.goto(evidence.projectUrl, {waitUntil: 'domcontentloaded'});
    await page.locator('#studio-playback canvas').waitFor();
    const animal = current.people.find(p => p.subject === 'animal');
    if (animal) {
      await page.getByRole('button', {name: `查看${animal.name}的镜头`, exact: true}).click();
      const animalDetails = page.locator('.studio-role-detail').filter({hasText: `${animal.name}的镜头`});
      await animalDetails.waitFor();await animalDetails.scrollIntoViewIfNeeded();
      await animalDetails.locator('img').first().evaluate(image => image.complete && image.naturalWidth > 0 ? undefined : new Promise((resolve, reject) => {image.addEventListener('load', resolve, {once: true});image.addEventListener('error', () => reject(new Error('animal shot thumbnail failed')), {once: true});}));
      await animalDetails.screenshot({path: path.join(reports, 'animal-details.png')});
      step('浏览器动物卡展开详情成功', {animalId: animal.id});
    }
    await page.locator('#studio-playback').scrollIntoViewIfNeeded();
    const seek = async us => {
      await page.locator('#studio-playback video').evaluate((video, time) => {video.pause();video.currentTime = time;}, us / 1e6);
      await page.waitForFunction(target => {
        const host = document.querySelector('#studio-playback .studio-stage-canvas');
        return host?.dataset.ptsUs && Math.abs(Number(host.dataset.ptsUs) - target) < 500;
      }, us, {timeout: 20_000});
    };
    const motions = {};
    for (const id of Object.keys(current.motionRefs)) motions[id] = (await api('GET', `/api/studio/projects/${projectId}/tracks/${id}/motion`)).motion;
    const byShot = new Map();
    for (const track of current.tracks.filter(t => t.status === 'active' && motions[t.id])) {
      const frame = motions[track.id].frames.find(f => f && f.timeS * 1e6 >= track.startUs && f.timeS * 1e6 < track.endUs);
      if (frame && !byShot.has(track.shotId)) byShot.set(track.shotId, {track, frame});
    }
    const checks = [...byShot.values()].sort((a, b) => a.frame.timeS - b.frame.timeS);
    assert(checks.some(item => item.track.shotId !== current.shots[0].id), 'need actual solved later shot');
    for (const {track, frame} of checks.slice(0, 5)) {
      await seek(Math.round(frame.timeS * 1e6));
      await page.waitForFunction(() => Number(document.querySelector('#studio-playback .studio-stage-canvas')?.dataset.solvedCount) > 0, null, {timeout: 20_000});
      assert(motionRequests.some(url => url.includes(`/tracks/${track.id}/motion`)), `${track.shotId} requested its own motion`);
    }
    await page.locator('#studio-playback').screenshot({path: path.join(reports, 'playback-later-shot.png')});
    step('浏览器后续镜头加载自身动作与随机seek通过', {shots: checks.slice(0, 5).map(item => item.track.shotId), requestCount: motionRequests.length});

    // Change a visible actor while the page remains mounted, then regenerate.
    const target = checks[0];
    const binding = current.bindings.find(b => b.trackId === target.track.id);
    const config = current.characters.find(c => c.id === binding.characterId);
    const oldVersion = current.motionVersions[target.track.id];
    await seek(Math.round(target.frame.timeS * 1e6));
    await page.waitForFunction(() => Number(document.querySelector('#studio-playback .studio-stage-canvas')?.dataset.solvedCount) > 0);
    const card = page.locator('.studio-character-row').filter({hasText: config.name});
    const heightInput = card.locator('input[type="number"]');
    if (await heightInput.count()) {
      await heightInput.fill(config.scale === 1.85 ? '1.75' : '1.85');await heightInput.blur();
    } else {
      throw new Error('character scale UI selector missing; do not substitute API-only cache test');
    }
    await page.waitForFunction(trackId => JSON.parse(document.querySelector('#studio-playback .studio-stage-canvas')?.dataset.renderSignature || '[]').find(row => row[0] === trackId)?.[2] === 'placeholder', target.track.id, {timeout: 20_000});
    await page.getByRole('button', {name: '生成连续动作（已归并候选）', exact: true}).click();
    current = await waitJobs();
    assert.notEqual(current.motionVersions[target.track.id], oldVersion);
    await page.waitForFunction(trackId => JSON.parse(document.querySelector('#studio-playback .studio-stage-canvas')?.dataset.renderSignature || '[]').find(row => row[0] === trackId)?.[2] === 'solved', target.track.id, {timeout: 25_000});
    step('不刷新页面修改尺度、动作失效、重算和新缓存生效', {trackId: target.track.id, previousVersion: oldVersion, currentVersion: current.motionVersions[target.track.id]});
    assert.deepEqual(pageErrors, [], 'browser JS exceptions');
    evidence.browser = {pageErrors, motionRequestCount: motionRequests.length};
    await page.waitForTimeout(350); // allow the 4 Hz status label to catch up with the verified render
    await page.locator('#studio-playback').screenshot({path: path.join(reports, 'playback-after-edit.png')});
  } finally {await browser.close();}

  current = await run('export');
  const exports = (await api('GET', `/api/studio/projects/${projectId}/exports`)).exports;
  assert(exports.length > 0);
  const exported = exports[0];
  const manifest = await api('GET', `/api/studio/projects/${projectId}/exports/${exported.exportId}/file?path=manifest.json`);
  assert.equal(manifest.sampling, 'source-pts-and-transitions-step');
  assert.deepEqual(new Set(manifest.characterGlbs.map(g => g.proxyLevel)), new Set(['CL0', 'CL1', 'CL2']));
  const timeline = await api('GET', `/api/studio/projects/${projectId}/exports/${exported.exportId}/file?path=timeline.json`);
  assert.equal(timeline.durationUs, current.media.durationUs);
  assert.deepEqual(new Set(timeline.frames.map(f => f.shotId).filter(Boolean)), new Set(current.shots.map(s => s.id)));
  evidence.export = {exportId: exported.exportId, instanceCount: manifest.instanceCount, glbs: manifest.characterGlbs, timelineSamples: timeline.frames.length};
  evidence.finalDraft = summary(current);
  fs.writeFileSync(path.join(reports, 'final-detail.json'), JSON.stringify(current, null, 2));
  step('交付包包含全部镜头、逐组CL与统一采样时间线', {exportId: exported.exportId, glbs: manifest.characterGlbs.length, timelineSamples: timeline.frames.length});
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';evidence.errors.push(String(error.stack || error));process.exitCode = 1;
  console.error(error);
} finally {
  evidence.finishedAt = new Date().toISOString();save();console.log(`Evidence: ${path.join(reports, 'acceptance.json')}`);
}
