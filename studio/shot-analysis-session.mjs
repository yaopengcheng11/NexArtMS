import fs from 'node:fs';
import path from 'node:path';
import {fail} from './db.mjs';
import {validateAnnotation, validateSubjects, validateIssues} from './shot-analysis-schema.mjs';
import {createShotAnalysisEngine} from './shot-analysis.mjs';

/** Import an explicitly requested, evidence-backed assistant review as a new run, never as an API connection. */
export async function importSessionAnalysis({store, analysisStore, root, input}) {
  if (!input || typeof input !== 'object' || input.provenance?.kind !== 'assistant-session') throw fail('需要明确的会话视觉分析来源', 400);
  const projectId = input.projectId, source = analysisStore.getRun(projectId, input.sourceRunId);
  if (!source) throw fail('来源拉片运行不存在', 404);
  if (analysisStore.getRun(projectId)?.id !== source.id || source.revision !== input.sourceRunRevision || source.mediaHash !== input.mediaHash || source.shotSetHash !== input.shotSetHash) throw fail('来源拉片或证据版本已变化，拒绝导入旧结果', 409);
  analysisStore.assertCurrent(projectId, source.id);
  if (store.listJobs(projectId).some(job => ['queued', 'running'].includes(job.state))) throw fail('项目任务正在执行，请结束后再导入会话分析', 409);
  if (typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 12000) throw fail('全片分析摘要无效', 400);
  const allowedFrames = source.shots.flatMap(s => s.evidenceFrames.map(f => f.frameIndex));
  const subjectCheck = validateSubjects(input.subjects, {allowedFrames}), issueCheck = validateIssues(input.issues);
  if (!subjectCheck.valid || !issueCheck.valid) throw fail([...subjectCheck.errors, ...issueCheck.errors].join('；'), 400);
  if (!Array.isArray(input.annotations) || input.annotations.length !== source.shots.length) throw fail('会话分析必须完整覆盖来源镜头，不能导入半片', 400);
  const annotations = new Map();
  for (const item of input.annotations) {
    const shot = source.shots.find(s => s.id === item.shotId);
    if (!shot || annotations.has(item.shotId)) throw fail('包含重复或不存在的镜头', 400);
    const check = validateAnnotation(item.annotation, {allowedFrames: shot.evidenceFrames.map(e => e.frameIndex), subjectIds: input.subjects.map(s => s.id), shot});
    if (!check.valid) throw fail(`${shot.id}：${check.errors.join('；')}`, 400);
    if (shot.overrides?.subjects?.some(id => !input.subjects.some(s => s.id === id))) throw fail('会话主体目录不能移除人工覆盖引用的主体', 409);
    annotations.set(item.shotId, check.value);
  }
  const sourceDir = fs.realpathSync(analysisStore.runDirectory(projectId, source.id));
  const evidenceFiles = new Map();
  for (const shot of source.shots) for (const evidence of shot.evidenceFrames) {
    const full = fs.realpathSync(path.resolve(sourceDir, evidence.imageRef));
    if (!full.startsWith(sourceDir + path.sep) || !fs.statSync(full).isFile()) throw fail('来源证据路径无效', 400);
    const data = fs.readFileSync(full);
    if (data[0] !== 255 || data[1] !== 216 || data[2] !== 255) throw fail('来源证据图片损坏，未导入', 422);
    evidenceFiles.set(evidence.imageRef, data);
  }
  // All schema, identity, version and source-file checks happen before a new run is created.
  const created = analysisStore.createRun(projectId, {shots: source.shots, candidate: source.candidate, sourceRunId: source.id, reuse: false,
    provider: 'codex-session', model: 'session-visual-review', parameters: {analysisSource: 'assistant-session', analysisLabel: '本次会话视觉分析', provenance: input.provenance}});
  const runId = created.id, directory = analysisStore.runDirectory(projectId, runId);
  try {
    for (const [ref, bytes] of evidenceFiles) {const target = path.resolve(directory, ref);if (!target.startsWith(path.resolve(directory) + path.sep)) throw fail('目标证据路径无效', 400);fs.mkdirSync(path.dirname(target), {recursive: true});fs.writeFileSync(target, bytes, {flag: 'wx'});}
    analysisStore.updateRun(projectId, runId, {stage: 'analyze', subjects: subjectCheck.value, issues: issueCheck.value, error: null,
      quality: {overview: {completed: true, summary: input.summary, evidenceFrames: allowedFrames}, sessionReview: {...input.provenance, importedAt: new Date().toISOString(), sourceRunId: source.id, checkedShots: source.shots.length}}, schemaVersion: 'shot-analysis-v1', promptVersion: 'session-visual-review-v1'});
    for (const original of source.shots) {
      const target = created.shots.find(s => s.startFrame === original.startFrame && s.endFrameExclusive === original.endFrameExclusive);
      const generated = annotations.get(original.id);
      const issues = [
        ...(generated.uncertainties || []).map(message => ({code: 'session_uncertainty', severity: 'warning', message, shotId: target.id})),
        ...(generated.cutSuggestions || []).map(c => ({code: 'cut_suggestion', severity: 'warning', message: `源帧 ${c.frameIndex}：${c.reason}`, shotId: target.id, field: 'cuts'})),
      ];
      analysisStore.updateShot(projectId, runId, target.id, {generated, evidenceFrames: original.evidenceFrames, status: issues.length ? 'needs_review' : 'analyzed', issues}, {shotRevision: target.shotRevision});
    }
    fs.writeFileSync(path.join(directory, 'session-input.json'), JSON.stringify(input, null, 2), {flag: 'wx'});
    const engine = createShotAnalysisEngine({store, analysisStore, root, provider: {provider: '', model: '', endpoint: '', protocol: '', apiKey: ''}});
    await engine.validate(projectId, runId);
    return await engine.report(projectId, runId);
  } catch (cause) {
    analysisStore.updateRun(projectId, runId, {status: 'failed', error: '会话分析导入或报告生成失败，来源版本仍保留'});
    throw cause;
  }
}
