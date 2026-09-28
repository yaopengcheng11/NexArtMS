import fs from 'node:fs';
import path from 'node:path';
import {fail, newId, nowIso, stableHash} from './db.mjs';
import {validateAnnotation, validateSubjects, SHOT_ANALYSIS_SCHEMA_VERSION, SHOT_ANALYSIS_PROMPT_VERSION} from './shot-analysis-schema.mjs';

const RUN_STATUSES = new Set(['processing', 'ready', 'ready_with_issues', 'blocked', 'failed', 'cancelled', 'stale']);
const STAGES = new Set(['proxy', 'pts', 'cuts', 'frames', 'analyze', 'validate', 'report', 'done']);
const SHOT_STATUSES = new Set(['pending', 'analyzed', 'needs_review', 'failed', 'user_edited']);
const boundaryKey = s => `${s.startFrame}:${s.endFrameExclusive}`;
const clone = value => JSON.parse(JSON.stringify(value));
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const signature = (mediaHash, shots) => stableHash([mediaHash, shots.map(s => [s.startFrame, s.endFrameExclusive, s.startUs, s.endUs])]);
const plainShot = row => ({id: row.id, startFrame: row.startFrame ?? row.start_frame, endFrameExclusive: row.endFrameExclusive ?? row.end_frame_exclusive, startUs: row.startUs ?? row.start_us, endUs: row.endUs ?? row.end_us});

function issues(value) {
  if (!Array.isArray(value) || value.some(x => !object(x) || typeof x.code !== 'string' || !['info', 'warning', 'error'].includes(x.severity) || typeof x.message !== 'string')) throw fail('拉片问题列表格式不正确', 400);
  return clone(value);
}

/** Run and annotation writes are isolated from project revisions until candidate adoption. */
export function createShotAnalysisStore(store, root) {
  const {db} = store;
  const tx = fn => {db.exec('BEGIN IMMEDIATE');try {const result = fn();db.exec('COMMIT');return result;} catch (cause) {db.exec('ROLLBACK');throw cause;}};
  const requireProject = id => {const project = store.getProjectRow(id);if (!project) throw fail('项目不存在', 404);return project;};
  const requireRow = (projectId, runId) => {requireProject(projectId);const row = db.prepare('SELECT * FROM shot_analysis_runs WHERE project_id=? AND id=?').get(projectId, runId);if (!row) throw fail('拉片运行不存在', 404);return row;};
  const mediaFor = projectId => {requireProject(projectId);const media = store.getMedia(projectId);if (!media) throw fail('项目还没有导入媒体', 422);return media;};
  const activeShots = projectId => store.getShots(projectId).map(plainShot);
  const nextRevision = () => newId('ar');
  const touch = (id, fields = {}) => {
    const pairs = Object.entries({...fields, revision: nextRevision(), updated_at: nowIso()});
    db.prepare(`UPDATE shot_analysis_runs SET ${pairs.map(([k]) => `${k}=?`).join(',')} WHERE id=?`).run(...pairs.map(([, v]) => v), id);
  };
  const runDirectory = (projectId, runId) => {
    requireRow(projectId, runId);
    const parent = path.resolve(root, 'data', 'projects', projectId, 'analysis');
    const target = path.resolve(parent, runId);
    if (path.dirname(target) !== parent || !/^sa-[a-f0-9]{12}$/.test(runId)) throw fail('拉片产物路径无效', 400);
    return target;
  };
  function getRun(projectId, runId) {
    requireProject(projectId);
    const row = runId ? db.prepare('SELECT * FROM shot_analysis_runs WHERE project_id=? AND id=?').get(projectId, runId)
      : db.prepare('SELECT * FROM shot_analysis_runs WHERE project_id=? ORDER BY rowid DESC LIMIT 1').get(projectId);
    if (!row) return null;
    const metadata = JSON.parse(row.metadata);
    const media = store.getMedia(projectId);
    const obsolete = !media || media.sha256 !== row.media_hash || signature(media.sha256, activeShots(projectId)) !== row.base_shot_set_hash;
    const shots = db.prepare('SELECT * FROM shot_annotations WHERE run_id=? ORDER BY idx').all(row.id).map(s => {
      const generated = s.generated ? JSON.parse(s.generated) : null, overrides = JSON.parse(s.overrides);
      return {...JSON.parse(s.snapshot), id: s.shot_id, shotRevision: s.shot_revision, status: s.status, generated, overrides,
        effective: generated || Object.keys(overrides).length ? {...generated, ...overrides} : null,
        evidenceFrames: JSON.parse(s.evidence_frames), issues: JSON.parse(s.issues)};
    });
    return {...metadata, id: row.id, projectId: row.project_id, revision: row.revision, mediaHash: row.media_hash,
      shotSetHash: row.shot_set_hash, baseShotSetHash: row.base_shot_set_hash, candidate: !!row.candidate,
      status: obsolete ? 'stale' : row.status, ...(obsolete ? {error: '原片或活动切点已变化，此拉片版本仅供历史追溯'} : {}), stage: row.stage, createdAt: row.created_at, updatedAt: row.updated_at, shots,
      counts: {total: shots.length, analyzed: shots.filter(s => !!s.generated).length, failed: shots.filter(s => s.status === 'failed').length,
        needsReview: shots.filter(s => s.status === 'needs_review' || s.issues.some(i => i.severity !== 'info')).length,
        userEdited: shots.filter(s => Object.keys(s.overrides).length > 0).length}};
  }
  const listRuns = projectId => {requireProject(projectId);return db.prepare('SELECT id FROM shot_analysis_runs WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(r => getRun(projectId, r.id));};
  function assertCurrent(projectId, runId) {
    const row = requireRow(projectId, runId), media = mediaFor(projectId);
    if (row.status === 'stale' || row.status === 'cancelled') throw fail(row.status === 'cancelled' ? '拉片已取消，不能写入迟到结果' : '拉片版本已过期，请重新运行', 409);
    if (media.sha256 !== row.media_hash || signature(media.sha256, activeShots(projectId)) !== row.base_shot_set_hash) {
      const metadata = JSON.parse(row.metadata);metadata.error = '原片或活动切点已变化，拒绝写入旧拉片结果';
      touch(runId, {status: 'stale', metadata: JSON.stringify(metadata)});
      throw fail(metadata.error, 409);
    }
    return true;
  }
  function normalizeShots(projectId, supplied, candidate = false) {
    if (!Array.isArray(supplied)) throw fail('镜头列表格式不正确', 400);
    if (!supplied.length) return [];
    const media = mediaFor(projectId), pts = store.loadPtsFor(media);
    if (!Number.isSafeInteger(media.pts_count) || media.pts_count < 1) throw fail('媒体帧数信息缺失', 422);
    const current = activeShots(projectId), byBoundary = new Map(current.map(s => [boundaryKey(s), s]));
    let end = 0, endUs = null;
    const ids = new Set();
    const normalized = supplied.map(input => {
      const s = plainShot(input);
      if (!Number.isSafeInteger(s.startFrame) || !Number.isSafeInteger(s.endFrameExclusive) || s.startFrame !== end || s.endFrameExclusive <= end || s.endFrameExclusive > media.pts_count) throw fail('镜头边界必须按呈现帧顺序无缝覆盖全部帧', 400);
      if (!Number.isSafeInteger(s.startUs) || !Number.isSafeInteger(s.endUs) || s.startUs < 0 || s.endUs <= s.startUs || (endUs !== null && s.startUs !== endUs)) throw fail('镜头时间必须是连续的原片整数微秒', 400);
      if (pts.length === media.pts_count) {
        const expectedStart = Math.round(pts[s.startFrame] * 1e6), expectedEnd = s.endFrameExclusive === media.pts_count ? media.duration_us : Math.round(pts[s.endFrameExclusive] * 1e6);
        if (s.startUs !== expectedStart || s.endUs !== expectedEnd) throw fail('镜头时间必须与原片 PTS 对齐', 400);
      }
      if (typeof s.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(s.id)) throw fail('镜头 ID 无效', 400);
      if (candidate) {const same = byBoundary.get(boundaryKey(s));s.id = same ? same.id : newId('S');}
      if (ids.has(s.id)) throw fail('镜头 ID 不能重复', 400);
      ids.add(s.id);end = s.endFrameExclusive;endUs = s.endUs;
      return s;
    });
    if (end !== media.pts_count || endUs !== media.duration_us) throw fail('镜头必须覆盖全部原片帧与时长', 400);
    return normalized;
  }
  const insertSnapshots = (runId, mediaHash, shots, previous, reuse) => {
    const old = new Map((previous?.shots || []).map(s => [boundaryKey(s), s]));
    const insert = db.prepare('INSERT INTO shot_annotations(run_id,shot_id,idx,shot_revision,snapshot,status,generated,overrides,evidence_frames,issues,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
    shots.forEach((s, index) => {
      const prior = old.get(boundaryKey(s)), generated = reuse ? prior?.generated : null, overrides = prior?.overrides || {};
      const edited = Object.keys(overrides).length > 0;
      insert.run(runId, s.id, index, stableHash([mediaHash, s.startFrame, s.endFrameExclusive, s.startUs, s.endUs]), JSON.stringify(s), edited ? 'user_edited' : generated ? prior.status : 'pending',
        generated ? JSON.stringify(generated) : null, JSON.stringify(overrides), '[]', JSON.stringify(reuse ? (prior?.issues || []).map(i => ({...i, ...(i.shotId ? {shotId: s.id} : {})})) : []), nowIso());
    });
  };
  function createRun(projectId, options = {}) {
    const media = mediaFor(projectId), current = activeShots(projectId), candidate = options.candidate === true;
    const shots = normalizeShots(projectId, options.shots ?? current, candidate), baseHash = signature(media.sha256, current);
    if (!candidate && shots.length && signature(media.sha256, shots) !== baseHash) throw fail('新边界必须保存为候选拉片运行', 409);
    let previous = options.sourceRunId ? getRun(projectId, options.sourceRunId) : getRun(projectId);
    if (options.sourceRunId && !previous) throw fail('来源拉片运行不存在', 404);
    if (previous?.mediaHash !== media.sha256) previous = null;
    const id = newId('sa'), time = nowIso();
    const metadata = {provider: options.provider ?? null, model: options.model ?? null, schemaVersion: SHOT_ANALYSIS_SCHEMA_VERSION, promptVersion: SHOT_ANALYSIS_PROMPT_VERSION, error: null, progress: 0,
      subjects: clone(previous?.subjects || []), issues: [], sourceRunId: previous?.id ?? null, parameters: clone(options.parameters || {})};
    const reuseGenerated = options.reuse !== false && previous && ['provider', 'model', 'schemaVersion', 'promptVersion'].every(key => previous[key] === metadata[key])
      && previous.parameters?.modelSnapshot?.fingerprint === metadata.parameters?.modelSnapshot?.fingerprint;
    tx(() => {
      db.prepare('INSERT INTO shot_analysis_runs(id,project_id,revision,media_hash,shot_set_hash,base_shot_set_hash,candidate,status,stage,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, nextRevision(), media.sha256, signature(media.sha256, shots), baseHash, candidate ? 1 : 0, 'processing', shots.length ? 'frames' : 'proxy', JSON.stringify(metadata), time, time);
      insertSnapshots(id, media.sha256, shots, previous, reuseGenerated);
    });
    fs.mkdirSync(runDirectory(projectId, id), {recursive: true});
    return getRun(projectId, id);
  }
  function setShots(projectId, runId, supplied) {
    const row = requireRow(projectId, runId), media = mediaFor(projectId);
    if (row.status === 'stale' || row.status === 'cancelled' || media.sha256 !== row.media_hash) throw fail('拉片已失效，不能初始化镜头', 409);
    if (db.prepare('SELECT 1 FROM shot_annotations WHERE run_id=? LIMIT 1').get(runId)) throw fail('拉片镜头快照已经初始化', 409);
    const shots = normalizeShots(projectId, supplied), hash = signature(media.sha256, shots);
    if (!shots.length || signature(media.sha256, activeShots(projectId)) !== hash) throw fail('初始快照必须匹配当前活动镜头', 409);
    tx(() => {insertSnapshots(runId, media.sha256, shots, null, false);touch(runId, {shot_set_hash: hash, base_shot_set_hash: hash, stage: 'frames'});});
    return getRun(projectId, runId);
  }
  function updateRun(projectId, runId, patch) {
    if (!object(patch)) throw fail('拉片更新格式不正确', 400);
    const row = requireRow(projectId, runId), metadata = JSON.parse(row.metadata), fields = {};
    const allowed = new Set(['status', 'stage', 'provider', 'model', 'error', 'progress', 'subjects', 'issues', 'quality', 'artifactRef', 'usage', 'parameters', 'schemaVersion', 'promptVersion', 'overview']);
    if (Object.keys(patch).some(key => !allowed.has(key))) throw fail('包含不可修改的拉片字段', 400);
    if (patch.status && !RUN_STATUSES.has(patch.status)) throw fail('拉片状态无效', 400);
    if (patch.stage && !STAGES.has(patch.stage)) throw fail('拉片阶段无效', 400);
    if (patch.status !== 'stale' && patch.status !== 'cancelled') assertCurrent(projectId, runId);
    if (row.status === 'stale' && patch.status !== 'stale') throw fail('旧拉片已过期，不能恢复写入', 409);
    if (row.status === 'cancelled' && patch.status !== 'cancelled') throw fail('拉片已取消，请创建新的运行重试', 409);
    if (hasOwn(patch, 'progress') && (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 1)) throw fail('拉片进度必须为 0–1', 400);
    for (const key of ['provider', 'model', 'error', 'artifactRef', 'schemaVersion', 'promptVersion']) if (hasOwn(patch, key) && patch[key] !== null && typeof patch[key] !== 'string') throw fail(`${key} 必须为文本`, 400);
    if (hasOwn(patch, 'subjects')) {const check = validateSubjects(patch.subjects);if (!check.valid) throw fail(check.errors.join('；'), 400);patch = {...patch, subjects: check.value};}
    if (hasOwn(patch, 'issues')) issues(patch.issues);
    for (const [key, value] of Object.entries(patch)) {if (key === 'status' || key === 'stage') fields[key] = value;else metadata[key] = clone(value);}
    touch(runId, {...fields, metadata: JSON.stringify(metadata)});
    return getRun(projectId, runId);
  }
  function annotationContext(run, shot, partial) {
    return {partial, allowedFrames: shot.evidenceFrames.map(e => e.frameIndex), subjectIds: run.subjects.map(s => s.id), shot};
  }
  function updateShot(projectId, runId, shotId, patch, {shotRevision} = {}) {
    assertCurrent(projectId, runId);
    const run = getRun(projectId, runId), shot = run.shots.find(s => s.id === shotId);
    if (!shot) throw fail('拉片镜头不存在', 404);
    if (shotRevision !== undefined && shotRevision !== shot.shotRevision) throw fail('镜头边界版本已变化', 409);
    if (!object(patch) || Object.keys(patch).some(k => !['generated', 'evidenceFrames', 'status', 'issues'].includes(k))) throw fail('包含不可修改的镜头字段', 400);
    if (patch.status && !SHOT_STATUSES.has(patch.status)) throw fail('镜头分析状态无效', 400);
    let evidence = shot.evidenceFrames;
    if (hasOwn(patch, 'evidenceFrames')) {
      evidence = patch.evidenceFrames;
      if (!Array.isArray(evidence) || evidence.some(e => !object(e) || !Number.isSafeInteger(e.frameIndex) || e.frameIndex < shot.startFrame || e.frameIndex >= shot.endFrameExclusive || !Number.isSafeInteger(e.ptsUs) || e.ptsUs < shot.startUs || e.ptsUs >= shot.endUs || typeof e.imageRef !== 'string' || !e.imageRef || path.isAbsolute(e.imageRef) || e.imageRef.split(/[\\/]/).some(s => s === '..' || s === '.') || /^[a-z]:/i.test(e.imageRef))) throw fail('关键帧必须位于当前镜头，图片路径必须在当前运行内', 400);
      if (new Set(evidence.map(e => e.frameIndex)).size !== evidence.length) throw fail('关键帧编号不能重复', 400);
      const media = mediaFor(projectId), pts = store.loadPtsFor(media);
      if (pts.length === media.pts_count && evidence.some(e => Math.round(pts[e.frameIndex] * 1e6) !== e.ptsUs)) throw fail('关键帧时间必须与原片 PTS 一致', 400);
    }
    let generated = shot.generated;
    if (hasOwn(patch, 'generated')) {
      if (patch.generated === null) generated = null;
      else {const check = validateAnnotation(patch.generated, annotationContext(run, {...shot, evidenceFrames: evidence}, false));if (!check.valid) throw fail(check.errors.join('；'), 400);generated = check.value;}
    }
    const nextIssues = hasOwn(patch, 'issues') ? issues(patch.issues) : shot.issues;
    tx(() => {
      db.prepare('UPDATE shot_annotations SET generated=?,evidence_frames=?,status=?,issues=?,updated_at=? WHERE run_id=? AND shot_id=?')
        .run(generated ? JSON.stringify(generated) : null, JSON.stringify(evidence), Object.keys(shot.overrides).length ? 'user_edited' : patch.status ?? shot.status, JSON.stringify(nextIssues), nowIso(), runId, shotId);
      touch(runId);
    });
    return getRun(projectId, runId);
  }
  function editShot(projectId, runId, shotId, {overrides, baseRevision} = {}) {
    assertCurrent(projectId, runId);
    const run = getRun(projectId, runId), shot = run.shots.find(s => s.id === shotId);
    if (!shot) throw fail('拉片镜头不存在', 404);
    if (typeof baseRevision !== 'string' || run.revision !== baseRevision) throw fail('拉片版本已变化，请刷新后再修改', 409);
    const check = validateAnnotation(overrides, annotationContext(run, shot, true));
    if (!check.valid) throw fail(check.errors.join('；'), 400);
    const merged = {...shot.overrides, ...check.value};
    tx(() => {
      db.prepare("UPDATE shot_annotations SET overrides=?,status='user_edited',updated_at=? WHERE run_id=? AND shot_id=?").run(JSON.stringify(merged), nowIso(), runId, shotId);
      touch(runId);
    });
    return getRun(projectId, runId);
  }
  function invalidateRuns(projectId, reason) {
    requireProject(projectId);
    tx(() => {for (const row of db.prepare("SELECT * FROM shot_analysis_runs WHERE project_id=? AND status<>'stale'").all(projectId)) {
      const metadata = JSON.parse(row.metadata);metadata.error = String(reason || '原片或切点已变化');touch(row.id, {status: 'stale', metadata: JSON.stringify(metadata)});
    }});
    return listRuns(projectId);
  }
  function resumeRun(projectId, runId) {
    const row = requireRow(projectId, runId), media = mediaFor(projectId);
    if (getRun(projectId)?.id !== runId) throw fail('已有更新的拉片运行，不能恢复历史任务', 409);
    if (!['failed', 'cancelled', 'blocked'].includes(row.status)) throw fail('只能恢复失败、取消或阻塞的拉片运行', 409);
    if (media.sha256 !== row.media_hash || signature(media.sha256, activeShots(projectId)) !== row.base_shot_set_hash) throw fail('原片或活动切点已变化，请创建新的拉片运行', 409);
    const metadata = JSON.parse(row.metadata);metadata.error = null;
    touch(runId, {status: 'processing', metadata: JSON.stringify(metadata)});
    return getRun(projectId, runId);
  }
  function adoptRun(projectId, runId, baseRevision) {
    store.assertRevision(projectId, baseRevision);
    assertCurrent(projectId, runId);
    const run = getRun(projectId, runId);
    if (!run.candidate) throw fail('该运行不是待采用的候选版本', 409);
    if (!['ready', 'ready_with_issues', 'blocked'].includes(run.status)) throw fail('候选切点仍在处理中，请完成或明确阻塞后再采用', 409);
    const media = mediaFor(projectId), shots = normalizeShots(projectId, run.shots), old = activeShots(projectId);
    const unchanged = new Set(shots.filter(s => old.some(o => boundaryKey(o) === boundaryKey(s) && o.id === s.id)).map(s => s.id));
    const changed = new Set(old.filter(s => !unchanged.has(s.id)).map(s => s.id));
    const archivedCameras = store.getCameraTracks(projectId).filter(c => changed.has(c.shot_id));
    const affectedTracks = store.getTracks(projectId).filter(t => t.status === 'active' && changed.has(t.shot_id));
    const time = nowIso(), projectRevision = newId('r');
    tx(() => {
      // Keep manual identities and bindings as history; stale tracks cannot be reused by S01 renumbering.
      for (const track of affectedTracks) db.prepare("UPDATE tracks SET status='stale',updated_at=? WHERE id=? AND project_id=?").run(time, track.id, projectId);
      for (const id of changed) db.prepare('DELETE FROM camera_tracks WHERE project_id=? AND shot_id=?').run(projectId, id);
      db.prepare('DELETE FROM shots WHERE project_id=?').run(projectId);
      const insert = db.prepare('INSERT INTO shots(id,project_id,idx,start_frame,end_frame_exclusive,start_us,end_us,source,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      shots.forEach((s, index) => insert.run(s.id, projectId, index, s.startFrame, s.endFrameExclusive, s.startUs, s.endUs, 'shot-analysis', stableHash([media.sha256, boundaryKey(s)]), time));
      db.prepare("UPDATE cast_approval SET status='invalidated' WHERE project_id=? AND status='approved'").run(projectId);
      db.prepare("UPDATE projects SET revision=?,updated_at=?,phase=CASE WHEN phase IN ('cast_confirmed','keyframes_confirmed','motion_confirmed','delivered') THEN 'analyzed' ELSE phase END WHERE id=?").run(projectRevision, time, projectId);
      db.prepare('INSERT INTO project_history(project_id,revision,time,reason) VALUES(?,?,?,?)').run(projectId, projectRevision, time, `采用拉片切点版本 ${runId}；保留 ${unchanged.size} 个未变镜头，${affectedTracks.length} 条旧轨迹已过期`);
      for (const row of db.prepare('SELECT * FROM shot_analysis_runs WHERE project_id=? AND id<>?').all(projectId, runId)) {
        const metadata = JSON.parse(row.metadata);metadata.error = `活动切点已采用 ${runId}，此历史版本只读`;touch(row.id, {status: 'stale', metadata: JSON.stringify(metadata)});
      }
      const metadata = JSON.parse(requireRow(projectId, runId).metadata);
      metadata.adoption = {at: time, projectRevision, changedShotIds: [...changed], unchangedShotIds: [...unchanged], staleTrackIds: affectedTracks.map(t => t.id), archivedCameras,
        previousShots: old, exportsInvalidated: changed.size > 0};
      touch(runId, {candidate: 0, base_shot_set_hash: signature(media.sha256, shots), metadata: JSON.stringify(metadata)});
    });
    return getRun(projectId, runId);
  }
  return {createRun, getRun, listRuns, setShots, updateRun, updateShot, editShot, assertCurrent, runDirectory, invalidateRuns, resumeRun, adoptRun};
}
