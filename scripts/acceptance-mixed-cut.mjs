// 混剪闭环端到端验收（用 JWM 样片作为替身样本，经 BASE_URL 驱动真实服务器）。
// 前置：服务器已启动（默认 http://127.0.0.1:8199），且已运行 scripts/fetch-detector-model.mjs。
// 用法：BASE_URL=http://127.0.0.1:8199 node scripts/acceptance-mixed-cut.mjs
// 产物：reports/acceptance-mixed-cut.json。项目与数据留在服务器 data/ 下，可删除。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const base = process.env.BASE_URL || 'http://127.0.0.1:8199';
const videoPath = path.join(root, 'public', 'reference.mp4');
const truth = JSON.parse(fs.readFileSync(path.join(root, 'public', 'project', 'shots.json'), 'utf8'));

const api = async (method, url, body, raw = false, attempt = 0) => {
  try {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : body instanceof Buffer ? {'Content-Type': 'application/octet-stream'} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) throw Object.assign(new Error(json.error || `HTTP ${response.status}`), {status: response.status});
    return json;
  } catch (error) {
    // 网络层瞬时错误（ECONNRESET 等）重试；业务错误直接抛出
    if (attempt < 3 && !error.status) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      return api(method, url, body, raw, attempt + 1);
    }
    throw error;
  }
};
const waitJobs = async projectId => {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const detail = await api('GET', `/api/studio/projects/${projectId}`);
    const pending = detail.jobs.filter(job => job.state === 'queued' || job.state === 'running');
    if (pending.length === 0) return detail;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('等待任务超时');
};
const revision = async projectId => (await api('GET', `/api/studio/projects/${projectId}`)).project.revision;

const evidence = {base, startedAt: new Date().toISOString(), steps: []};
const step = (name, data) => {evidence.steps.push({name, ...data});console.log(`✔ ${name}`, typeof data === 'object' ? JSON.stringify(data).slice(0, 220) : '');};

// 1. 创建项目并上传 JWM 原片
const created = await api('POST', '/api/studio/projects', {name: 'jwm-acceptance', sceneMode: 'proxy'});
const projectId = created.project.id;
step('创建项目', {projectId, sceneStatus: created.project.sceneStatus});
const bytes = fs.readFileSync(videoPath);
const uploaded = await api('POST', `/api/studio/projects/${projectId}/media?name=reference.mp4&baseRevision=${created.project.revision}`, bytes);
step('上传原片', {sha256: uploaded.media.sha256.slice(0, 12) + '…', bytes: bytes.length});

// 2. 自动切镜 → 与 shots.json 真值对照（±2 帧一对一）
let detail = await waitJobs(projectId);
const cutsJob = detail.jobs.find(job => job.kind === 'cuts');
if (cutsJob.state !== 'done') throw new Error(`切镜任务未完成：${cutsJob.error}`);
{
  const truthCuts = truth.slice(1).map(shot => shot.startFrame);
  const predictedCuts = detail.shots.slice(1).map(shot => shot.startFrame);
  const pairs = [];
  for (const p of predictedCuts) for (const t of truthCuts) pairs.push({p, t, d: Math.abs(p - t)});
  pairs.sort((a, b) => a.d - b.d);
  const usedP = new Set(), usedT = new Set();
  let matches = 0;
  for (const pair of pairs) {if (pair.d > 2 || usedP.has(pair.p) || usedT.has(pair.t)) continue;usedP.add(pair.p);usedT.add(pair.t);matches++;}
  const recall = matches / truthCuts.length, precision = matches / predictedCuts.length;
  step('切镜验收（A2 规则）', {shots: detail.shots.length, truthShots: truth.length, recall: +(recall * 100).toFixed(1) + '%', precision: +(precision * 100).toFixed(1) + '%', gate: recall >= 0.95 ? '通过' : '未通过'});
  evidence.cutAcceptance = {recall, precision};
}

// 3. 真实人物检测 + 二维姿态
const detectStarted = Date.now();
const detectJob = await api('POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'detect'});
detail = await waitJobs(projectId);
const detectFinal = detail.jobs.find(job => job.id === detectJob.job.id);
if (detectFinal.state !== 'done') throw new Error(`检测任务失败：${detectFinal.error}`);
const poseTracks = detail.tracks.filter(track => track.status === 'active' && detail.motionRefs !== undefined);
step('人物检测与镜内跟踪', {durationS: +((Date.now() - detectStarted) / 1000).toFixed(1), output: detectFinal.output, activeTracks: detail.tracks.filter(track => track.status === 'active').length});

// 4. 归并：一个成片角色（允许同框），绑定全部候选并正式确认
const character = await api('POST', `/api/studio/projects/${projectId}/characters`, {name: '主角', color: '#28543F', scale: 1.75, allowSimultaneous: true, baseRevision: await revision(projectId)});
const assignments = detail.tracks.filter(track => track.status === 'active').map(track => ({trackId: track.id, characterId: character.character.id, disposition: 'bound'}));
await api('PATCH', `/api/studio/projects/${projectId}/cast`, {baseRevision: await revision(projectId), assignments});
const approved = await api('POST', `/api/studio/projects/${projectId}/approve-cast`, {baseRevision: await revision(projectId)});
step('归并与正式确认', {boundTracks: assignments.length, approval: approved.cast.approval.status, frozenShots: approved.cast.approval.frozen.shots.count});

// 5. 连续动作（固定骨长）
const motionJob = await api('POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'motion'});
detail = await waitJobs(projectId);
const motionFinal = detail.jobs.find(job => job.id === motionJob.job.id);
if (motionFinal.state !== 'done') throw new Error(`动作任务失败：${motionFinal.error}`);
const motionDir = path.join(root, 'data', 'projects', projectId, 'observations', 'motion');
const motionFiles = fs.existsSync(motionDir) ? fs.readdirSync(motionDir).filter(name => name.endsWith('.json')) : [];
let worstDeviation = 0;
for (const file of motionFiles) {
  const motion = JSON.parse(fs.readFileSync(path.join(motionDir, file), 'utf8'));
  worstDeviation = Math.max(worstDeviation, motion.report?.maxBoneDeviationPct || 0);
}
step('连续动作（A6 骨长指标）', {motionClips: motionFiles.length, worstBoneDeviationPct: worstDeviation, gate: worstDeviation <= 0.1 ? '通过' : '未通过'});
evidence.motion = {clips: motionFiles.length, worstBoneDeviationPct: worstDeviation};

// 6. 相机估计（人物框粗估，必须标记待人工确认）
if (detail.shots.length > 0 && detail.tracks.filter(track => track.status === 'active').length > 0) {
  const shot = detail.shots[0];
  const track = detail.tracks.find(item => item.status === 'active' && item.shotId === shot.id);
  const camera = await api('POST', `/api/studio/projects/${projectId}/shots/${shot.id}/camera`, {mode: 'person', trackId: track.id, baseRevision: await revision(projectId)});
  step('相机粗估（A5 语义）', {shotId: shot.id, distanceMeters: camera.camera.distanceMeters, needsManualReview: camera.camera.needsManualReview});
  evidence.camera = camera.camera;
}

// 7. 导出交付包
const exportJob = await api('POST', `/api/studio/projects/${projectId}/analysis`, {kind: 'export'});
detail = await waitJobs(projectId);
const exportFinal = detail.jobs.find(job => job.id === exportJob.job.id);
if (exportFinal.state !== 'done') throw new Error(`导出任务失败：${exportFinal.error}`);
const exportsRoot = path.join(root, 'data', 'projects', projectId, 'exports');
const exportId = fs.readdirSync(exportsRoot)[0];
const exportDir = path.join(exportsRoot, exportId);
const manifest = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
const packageFiles = [];
(function walk(dir, prefix = '') {for (const entry of fs.readdirSync(dir)) {const full = path.join(dir, entry);if (fs.statSync(full).isDirectory()) walk(full, prefix + entry + '/');else packageFiles.push({file: prefix + entry, bytes: fs.statSync(full).size});}})(exportDir);
step('交付包（M6）', {exportId, instances: manifest.instanceCount, glbs: manifest.characterGlbs.filter(entry => entry.file).length, files: packageFiles.length, totalKB: Math.round(packageFiles.reduce((sum, file) => sum + file.bytes, 0) / 1024)});
evidence.export = {exportId, manifestInstances: manifest.instanceCount, characterGlbs: manifest.characterGlbs, files: packageFiles};

evidence.finishedAt = new Date().toISOString();
evidence.projectId = projectId;
fs.mkdirSync(path.join(root, 'reports'), {recursive: true});
fs.writeFileSync(path.join(root, 'reports', 'acceptance-mixed-cut.json'), JSON.stringify(evidence, null, 2));
console.log('\n验收完成：reports/acceptance-mixed-cut.json（项目 ' + projectId + ' 保留在 data/projects/）');
