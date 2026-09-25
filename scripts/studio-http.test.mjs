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
import {DEFAULT_LIMITS} from '../studio/media.mjs';

const execFileAsync = promisify(execFile);
const hasFfmpeg = await execFileAsync('ffprobe', ['-version']).then(() => true).catch(() => false);

async function makeSample(dir) {
  const file = path.join(dir, 'sample.mp4');
  await execFileAsync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', 'color=black:size=320x240:rate=12:duration=1',
    '-f', 'lavfi', '-i', 'color=white:size=320x240:rate=12:duration=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[out]',
    '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  return fs.readFileSync(file);
}

function harness(root, {limits = DEFAULT_LIMITS} = {}) {
  const store = createStudioStore(root);
  const jobs = createJobRunner(store, root, limits);
  const router = createStudioRouter(store, root, {limits, jobs});
  const server = http.createServer((req, res) => {router(req, res).then(handled => {if (!handled) {res.writeHead(404, {'Content-Type': 'application/json'});res.end(JSON.stringify({error: '接口不存在'}));}}).catch(error => {res.writeHead(500, {'Content-Type': 'application/json'});res.end(JSON.stringify({error: String(error)}));});});
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      base: `http://127.0.0.1:${server.address().port}`,
      store, close: () => {server.close();try {store.close();} catch {}},
    }));
  });
}

const api = async (base, method, url, body, headers = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: body && !(body instanceof Buffer) ? {'Content-Type': 'application/json'} : headers,
    body: body === undefined ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)),
  });
  const json = await response.json().catch(() => ({}));
  return {status: response.status, json, response};
};

const waitUntil = async (predicate, timeoutMs = 90000, intervalMs = 300) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error('等待超时');
};

test('full closed loop: create → upload → auto cuts → manual track → cast → approve → invalidation', {timeout: 180000}, async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-http-'));
  const {base, close} = await harness(root);
  try {
    // 1. 创建项目
    const created = await api(base, 'POST', '/api/studio/projects', {name: '端到端样例', sceneMode: 'proxy'});
    assert.equal(created.status, 201);
    const projectId = created.json.project.id;
    assert.equal(created.json.project.phase, 'draft');
    assert.equal(created.json.project.sceneStatus, 'not_requested');

    // 2. 流式上传 → 自动任务链 proxy → pts → cuts
    const bytes = await makeSample(root);
    const revision1 = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json.project.revision;
    const uploaded = await api(base, 'POST', `/api/studio/projects/${projectId}/media?name=sample.mp4&baseRevision=${revision1}`, bytes);
    assert.equal(uploaded.status, 200, `上传应成功：${JSON.stringify(uploaded.json)}`);
    assert.match(uploaded.json.media.sha256, /^[0-9a-f]{64}$/);
    assert.equal(uploaded.json.media.ptsCount, 0, '上传时 PTS 尚未生成');

    let detail = await waitUntil(async () => {
      const current = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json;
      const pending = current.jobs.filter(job => job.state === 'queued' || job.state === 'running');
      return pending.length === 0 ? current : null;
    });
    const cutsJob = detail.jobs.find(job => job.kind === 'cuts');
    assert.equal(cutsJob.state, 'done', `切镜任务应完成：${JSON.stringify(cutsJob)}`);
    assert.ok(detail.media.ptsCount === 24, `PTS 应有 24 帧（12fps×2s），实际 ${detail.media.ptsCount}`);
    assert.equal(detail.shots.length, 2, '黑→白应有 2 个镜头');
    assert.equal(detail.project.phase, 'analyzed');
    assert.ok(detail.shots[0].endUs > detail.shots[0].startUs, '镜头起止对应源时间戳');

    // 3. 代理视频 Range 读取
    const range = await fetch(`${base}/api/studio/projects/${projectId}/media/preview`, {headers: {Range: 'bytes=0-99'}});
    assert.equal(range.status, 206);
    assert.ok(range.headers.get('content-range').endsWith('/' + range.headers.get('content-range').split('/')[1]));

    // 4. 人工改切点（含 409 冲突）
    const patched = await api(base, 'PATCH', `/api/studio/projects/${projectId}/shots`, {cutFrames: [12], baseRevision: detail.project.revision});
    assert.equal(patched.status, 200);
    assert.equal(patched.json.shots.length, 2);
    const stale = await api(base, 'PATCH', `/api/studio/projects/${projectId}/shots`, {cutFrames: [6], baseRevision: detail.project.revision});
    assert.equal(stale.status, 409);

    // 5. 人工补标 + 角色归并（每次正式变更推进版本，需先取最新版本再写入）
    const currentRevision = async () => (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json.project.revision;
    detail = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json;
    const track1 = await api(base, 'POST', `/api/studio/projects/${projectId}/shots/${detail.shots[0].id}/tracks`,
      {startFrame: 0, endFrame: 8, box: {x: 0.1, y: 0.1, w: 0.3, h: 0.6}, baseRevision: await currentRevision()});
    assert.equal(track1.status, 200, JSON.stringify(track1.json));
    const track2 = await api(base, 'POST', `/api/studio/projects/${projectId}/shots/${detail.shots[1].id}/tracks`,
      {startFrame: 14, endFrame: 23, box: {x: 0.4, y: 0.1, w: 0.3, h: 0.6}, baseRevision: await currentRevision()});
    const character = await api(base, 'POST', `/api/studio/projects/${projectId}/characters`,
      {name: '成片角色 A', color: '#28543F', scale: 1.75, baseRevision: await currentRevision()});
    assert.equal(character.status, 200);
    const characterId = character.json.character.id;

    // 未处理候选阻止正式确认（422）
    const blocked = await api(base, 'POST', `/api/studio/projects/${projectId}/approve-cast`, {baseRevision: await currentRevision()});
    assert.equal(blocked.status, 422, `未归并候选必须阻止确认：${JSON.stringify(blocked.json)}`);

    const merged = await api(base, 'PATCH', `/api/studio/projects/${projectId}/cast`, {
      baseRevision: await currentRevision(),
      assignments: [
        {trackId: track1.json.track.id, characterId, disposition: 'bound'},
        {trackId: track2.json.track.id, characterId, disposition: 'bound'},
      ],
    });
    assert.equal(merged.status, 200);
    assert.equal(merged.json.cast.pendingTrackIds.length, 0);
    assert.equal(merged.json.cast.conflicts.length, 0, '不同镜头的绑定不构成同框冲突');

    // 6. 正式确认并冻结版本
    const approved = await api(base, 'POST', `/api/studio/projects/${projectId}/approve-cast`, {baseRevision: await currentRevision()});
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.cast.approval.status, 'approved');
    assert.equal(approved.json.cast.approval.frozen.media.sha256, uploaded.json.media.sha256);
    detail = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json;
    assert.equal(detail.project.phase, 'cast_confirmed');

    // 7. 确认后修改候选 → 确认失效、阶段回退（下游批准自动失效）
    const extra = await api(base, 'POST', `/api/studio/projects/${projectId}/shots/${detail.shots[0].id}/tracks`,
      {startFrame: 9, endFrame: 11, box: {x: 0.6, y: 0.2, w: 0.2, h: 0.5}, baseRevision: await currentRevision()});
    assert.equal(extra.status, 200);
    detail = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json;
    assert.equal(detail.approval.status, 'invalidated');
    assert.equal(detail.project.phase, 'analyzed');

    // 8. 自动人物检测：未配置模型时如实失败
    const detect = await api(base, 'POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'detect'});
    assert.equal(detect.status, 200);
    const failed = await waitUntil(async () => {
      const job = (await api(base, 'GET', `/api/studio/jobs/${detect.json.job.id}`)).json.job;
      return job.state === 'failed' ? job : null;
    });
    assert.match(failed.error, /未配置人物检测模型/);
    const retried=await api(base,'POST',`/api/studio/jobs/${failed.id}/retry`,{baseRevision:await currentRevision()});
    assert.equal(retried.status,200);
    const failedAgain=await waitUntil(async()=>{const j=(await api(base,'GET',`/api/studio/jobs/${failed.id}`)).json.job;return j.state==='failed'?j:null;},5000);
    assert.match(failedAgain.error,/未配置人物检测模型/);

    // 8b. 动作任务：已绑定候选没有姿态观测时如实失败（不冒充结果）
    const motion = await api(base, 'POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'motion'});
    const motionFailed = await waitUntil(async () => {
      const job = (await api(base, 'GET', `/api/studio/jobs/${motion.json.job.id}`)).json.job;
      return job.state === 'failed' ? job : null;
    });
    assert.match(motionFailed.error, /姿态观测/);

    // 8c. 导出任务：无动作也生成包，manifest 如实记录；下载端点拒绝路径穿越
    const exportJob = await api(base, 'POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'export'});
    await waitUntil(async () => {
      const job = (await api(base, 'GET', `/api/studio/jobs/${exportJob.json.job.id}`)).json.job;
      return job.state === 'done' || job.state === 'failed' ? job : null;
    });
    const exportDone = (await api(base, 'GET', `/api/studio/jobs/${exportJob.json.job.id}`)).json.job;
    assert.equal(exportDone.state, 'done', `导出应成功：${exportDone.error}`);
    const exportList = await api(base, 'GET', `/api/studio/projects/${projectId}/exports`);
    assert.equal(exportList.json.exports.length, 1);
    const exportId = exportList.json.exports[0].exportId;
    const manifest = await api(base, 'GET', `/api/studio/projects/${projectId}/exports/${exportId}/file?path=manifest.json`);
    assert.equal(manifest.json.instanceCount, 0, '无动作产物时实例数为 0');
    assert.ok(manifest.json.notIncluded, 'manifest 应如实标注未包含内容');
    const traversal = await fetch(`${base}/api/studio/projects/${projectId}/exports/${exportId}/file?path=../../server.mjs`);
    assert.equal(traversal.status, 400, '路径穿越必须被拒绝');
    const badExport = await fetch(`${base}/api/studio/projects/${projectId}/exports/..%2F..%2Fmedia/file`);
    assert.ok([400, 404].includes(badExport.status), '非法导出 ID 必须被拒绝');

    // 9. 轨迹截图按需生成
    const crop = await fetch(`${base}/api/studio/projects/${projectId}/tracks/${track1.json.track.id}/preview`);
    assert.equal(crop.status, 200);
    assert.match(crop.headers.get('content-type'), /jpeg/);

    // 10. 项目列表与镜头预览
    const list = await api(base, 'GET', '/api/studio/projects');
    assert.ok(list.json.projects.some(project => project.id === projectId));
    const shotPreview = await fetch(`${base}/api/studio/projects/${projectId}/shots/${detail.shots[0].id}/preview`);
    assert.equal(shotPreview.status, 200);

    // 11. 版本历史可追溯
    detail = (await api(base, 'GET', `/api/studio/projects/${projectId}`)).json;
    assert.ok(detail.history.length >= 6, '创建/导入/切点/补标/归并/确认都应留痕');
    assert.ok(detail.history.some(entry => /正式确认角色映射/.test(entry.reason)));
  } finally {close();fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}
});

test('out-of-range uploads are rejected with a clear reason and leave no media behind', {timeout: 120000}, async t => {
  if (!hasFfmpeg) return t.skip('需要 FFmpeg');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-http-limit-'));
  const {base, close} = await harness(root, {limits: {...DEFAULT_LIMITS, maxDurationS: 1}});
  try {
    const created = (await api(base, 'POST', '/api/studio/projects', {name: '限长样例', sceneMode: 'reconstruct'})).json.project;
    assert.equal(created.sceneStatus, 'pending');
    const bytes = await makeSample(root); // 2 秒 > 1 秒上限
    const rejected = await api(base, 'POST', `/api/studio/projects/${created.id}/media?name=sample.mp4&baseRevision=${created.revision}`, bytes);
    assert.equal(rejected.status, 422);
    assert.match(rejected.json.error, /上限/);
    const detail = (await api(base, 'GET', `/api/studio/projects/${created.id}`)).json;
    assert.equal(detail.media, null, '被拒文件不应进入媒体库');
    const incoming = path.join(root, 'data', 'projects', created.id, 'media', 'incoming');
    assert.equal(fs.existsSync(incoming) ? fs.readdirSync(incoming).length : 0, 0, '临时文件应被清理');
  } finally {close();fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}
});

test('unknown studio routes fall through to 404 JSON', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-http-404-'));
  const {base, close} = await harness(root);
  try {
    const missing = await api(base, 'GET', '/api/studio/definitely-not-a-route');
    assert.equal(missing.status, 404);
  } finally {close();fs.rmSync(root, {recursive: true, force: true, maxRetries: 5});}
});

test('settings and deletion API enforce current revision and block an in-flight upload',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-http-delete-'));
  const {base,store,close}=await harness(root);
  let upload;
  try {
    const p=(await api(base,'POST','/api/studio/projects',{name:'Disposable',sceneMode:'proxy'})).json.project;
    const url=`/api/studio/projects/${p.id}`;
    assert.equal((await api(base,'PATCH',url,{baseRevision:'stale',name:'No'})).status,409);
    assert.equal((await api(base,'PATCH',url,{baseRevision:p.revision,name:'Renamed',note:'Description',sceneMode:'reconstruct'})).status,200);
    const detail=(await api(base,'GET',url)).json;
    assert.equal(detail.project.name,'Renamed');assert.equal(detail.project.note,'Description');assert.equal(detail.project.sceneStatus,'pending');
    upload=http.request(`${base}${url}/media?name=sample.mp4&baseRevision=${detail.project.revision}`,{method:'POST',headers:{'Content-Length':1024}});
    upload.on('error',()=>{});upload.write(Buffer.alloc(16));
    await waitUntil(()=>fs.existsSync(path.join(store.mediaDir(p.id),'incoming'))&&fs.readdirSync(path.join(store.mediaDir(p.id),'incoming')).length,5000,25);
    const blocked=await api(base,'DELETE',url,{baseRevision:detail.project.revision,confirmName:'Renamed'});
    assert.equal(blocked.status,409);assert.match(blocked.json.error,/上传/);assert.ok(store.getProjectRow(p.id));
    upload.destroy();
    await waitUntil(()=>fs.readdirSync(path.join(store.mediaDir(p.id),'incoming')).length===0,5000,25);
    assert.equal((await api(base,'DELETE',url,{baseRevision:detail.project.revision,confirmName:'Wrong'})).status,400);
    const deleted=await api(base,'DELETE',url,{baseRevision:detail.project.revision,confirmName:'Renamed'});
    assert.equal(deleted.status,200);assert.equal(deleted.json.deleted,true);
    assert.equal((await api(base,'GET',url)).status,404);assert.equal(fs.existsSync(store.projectDir(p.id)),false);
  }finally{upload?.destroy();close();fs.rmSync(root,{recursive:true,force:true,maxRetries:5});}
});
