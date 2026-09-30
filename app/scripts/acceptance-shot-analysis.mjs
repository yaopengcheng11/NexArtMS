import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(root); // 仓库根：报告写 docs/reports/，模型权重与临时检查在仓库根
// 素材来源：JWM 样片已移除；用 SOURCE 环境变量指定任意本地视频（MP4/MOV，≤120s）。
const base = process.argv[2] || 'http://127.0.0.1:8199';
const source = process.env.SOURCE;
const reportDir = path.join(repoRoot, 'docs', 'reports', 'shot-analysis-acceptance');
fs.mkdirSync(reportDir, {recursive: true});
if (!source || !fs.existsSync(source)) {console.error('缺少测试素材：请设置 SOURCE 环境变量指向本地视频文件，例如 SOURCE=path/to/video.mp4 node scripts/acceptance-shot-analysis.mjs');process.exit(2);}
const bytes = fs.readFileSync(source), sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const api = async (method, route, body) => {
  const response = await fetch(base + route, {method, ...(body === undefined ? {} : {headers: Buffer.isBuffer(body) ? {} : {'Content-Type': 'application/json'}, body: Buffer.isBuffer(body) ? body : JSON.stringify(body)})});
  const result = await response.json();if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);return result;
};
const capability = await api('GET', '/api/studio/capabilities');
assert.equal(capability.shotAnalysisProvider.configured, false, 'This run measures the unconfigured-provider path; real remote analysis requires separately selected configuration.');
const startedAt = new Date().toISOString();
const project = (await api('POST', '/api/studio/projects', {name: '拉片验收 · 真实50秒样片', sceneMode: 'proxy', note: '真实全片抽帧和报告验收；未配置视觉模型，语义应明确受阻。'})).project;
const route = `/api/studio/projects/${project.id}`;
const uploaded = await api('POST', `${route}/media?name=reference.mp4&baseRevision=${project.revision}`, bytes);
fs.writeFileSync(path.join(reportDir, 'context.json'), JSON.stringify({base, projectId: project.id, projectUrl: `${base}/?project=${project.id}`, runId: uploaded.autoDraft.analysisRunId}, null, 2));
console.log(JSON.stringify({projectId: project.id, status: 'uploaded'}));
const deadline = Date.now() + 180000;let detail, previous = '';
while (Date.now() < deadline) {
  detail = await api('GET', route);
  const pending = detail.jobs.filter(j => ['queued', 'running'].includes(j.state));
  if (!pending.length) break;
  const label = pending.map(j => `${j.kind}:${Math.round(j.progress * 100)}%`).join(',');
  if (label !== previous) {console.log(label);previous = label;}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(detail.jobs.every(j => !['queued', 'running'].includes(j.state)), 'Analysis must reach terminal state');
const run = detail.shotAnalysis, pts = (await api('GET', `${route}/media/pts`)).ptsUs;
assert.equal(detail.media.sha256, sha256);assert.equal(detail.media.ptsCount, 1203);assert.equal(detail.media.durationUs, 50125000);
assert.equal(run.status, 'blocked');assert.equal(run.counts.analyzed, 0);assert.ok(run.shots.every(s => s.generated === null));
assert.equal(detail.jobs.some(j => ['detect', 'people', 'motion'].includes(j.kind)), false);
let end = 0, keyframes = 0;
for (const shot of run.shots) {
  assert.equal(shot.startFrame, end);end = shot.endFrameExclusive;
  assert.equal(shot.startUs, pts[shot.startFrame]);assert.equal(shot.endUs, shot.endFrameExclusive === pts.length ? detail.media.durationUs : pts[shot.endFrameExclusive]);
  assert.ok(shot.evidenceFrames.length >= Math.min(3, shot.endFrameExclusive - shot.startFrame));
  for (const evidence of shot.evidenceFrames) {
    assert.ok(evidence.frameIndex >= shot.startFrame && evidence.frameIndex < shot.endFrameExclusive);assert.equal(evidence.ptsUs, pts[evidence.frameIndex]);
    const image = await fetch(base + evidence.url);assert.equal(image.status, 200);const imageBytes = Buffer.from(await image.arrayBuffer());assert.equal(imageBytes[0], 255);assert.equal(imageBytes[1], 216);keyframes++;
  }
}
assert.equal(end, pts.length);
const fileRoute = `${route}/shot-analysis/${run.id}/file?path=`;
for (const filename of ['report.json', 'report.html', 'report.md', 'reelbench-shots.json']) {
  const response = await fetch(base + fileRoute + filename);assert.equal(response.status, 200, filename);
  fs.writeFileSync(path.join(reportDir, filename), Buffer.from(await response.arrayBuffer()));
}
const reference = JSON.parse(fs.readFileSync(path.join(root, 'public', 'project', 'shots.json'), 'utf8'));
const referenceShots = Array.isArray(reference) ? reference : reference.shots;
const referenceCuts = referenceShots.slice(1).map(s => s.startFrame ?? s.start_frame), detectedCuts = run.shots.slice(1).map(s => s.startFrame);
const remaining = new Set(detectedCuts), matched = [];
for (const frame of referenceCuts) {
  const found = [...remaining].filter(d => Math.abs(d - frame) <= 1).sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame))[0];
  if (found !== undefined) {matched.push({reference: frame, detected: found});remaining.delete(found);}
}
const comparison = referenceCuts.every(Number.isInteger) ? {referenceCuts: referenceCuts.length, detectedCuts: detectedCuts.length, matchedWithinOneFrame: matched.length, matches: matched, missed: referenceCuts.filter(f => !matched.some(m => m.reference === f)), extra: [...remaining]} : {status: 'reference schema not recognized'};
const result = {startedAt, finishedAt: new Date().toISOString(), status: 'passed_source_evidence_and_blocked_state', base, projectId: project.id, runId: run.id, source: {sha256, durationUs: detail.media.durationUs, presentedFrames: pts.length}, shots: run.shots.length, keyframes, comparison, analysisStatus: run.status, semanticShots: run.counts.analyzed, provider: capability.shotAnalysisProvider, jobs: detail.jobs.map(({kind, state, error}) => ({kind, state, error})), limitation: '真实素材完成全片切镜、源帧证据与报告；尚未配置视觉模型，真实逐镜语义、人物/动物一致性和运镜判断未验收。localhost fixture只验证软件行为。'};
fs.writeFileSync(path.join(reportDir, 'initial-detail.json'), JSON.stringify(detail, null, 2));
fs.writeFileSync(path.join(reportDir, 'acceptance.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
