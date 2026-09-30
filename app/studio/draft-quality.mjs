import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isValidMotionFrame, matchesMotionContext} from './motion-validation.mjs';

// Hash exactly the bytes returned to the caller. A stable reference is not an artifact version.
export function readMotionArtifact(root, ref, cache = new Map()) {
  const dataRoot = path.resolve(root, 'data');
  const file = path.resolve(root, ref);
  const relative = path.relative(dataRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('动作产物路径无效');
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('动作产物不是文件');
  const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  const cached = cache.get(file);
  if (cached?.stamp === stamp) return cached;
  const bytes = fs.readFileSync(file);
  const result = {stamp, motion: JSON.parse(bytes.toString('utf8')), version: createHash('sha256').update(bytes).digest('hex')};
  cache.set(file, result);
  return result;
}

// Nearest-frame sampling is valid for at most 250 ms on either side. Null samples
// retain their source time in new artifacts and cut the support at the midpoint.
export function motionIntervals(motion, startUs, endUs) {
  const frames = Array.isArray(motion?.frames) ? motion.frames : [];
  // Match the player's nearest sample, including null/invalid samples and repeated times.
  const samples = frames.map((frame, index) => ({frame, timeS: motion.sampleTimesS?.[index] ?? frame?.timeS}))
    .filter(sample => Number.isFinite(sample.timeS)).sort((a, b) => a.timeS - b.timeS)
    .filter((sample, index, values) => index === 0 || sample.timeS !== values[index - 1].timeS);
  const intervals = [];
  samples.forEach((sample, index) => {
    if (!isValidMotionFrame(sample.frame)) return;
    const t = sample.timeS * 1e6;
    let start = Math.max(startUs, t - 250000), end = Math.min(endUs, t + 250000);
    if (index > 0) start = Math.max(start, (samples[index - 1].timeS * 1e6 + t) / 2);
    if (index + 1 < samples.length) end = Math.min(end, (samples[index + 1].timeS * 1e6 + t) / 2);
    if (end > start) intervals.push([Math.round(start), Math.round(end)]);
  });
  const merged = [];
  for (const interval of intervals.sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  return merged;
}

export function draftQuality({tracks, bindings, characters = [], ignoredTrackIds = [], shots, cameraTracks, jobs, motions = {}, artifactErrors = {}}) {
  const issues = [];
  const subjectCoverage = Object.fromEntries(['person', 'animal'].map(subject => [subject, {visibleDurationUs: 0, solvedDurationUs: 0, coveragePct: null}]));
  const bindingByTrack = new Map(bindings.map(row => [row.track_id, row]));
  const characterById = new Map(characters.map(row => [row.id, row]));
  const ignored = new Set(ignoredTrackIds);
  let boundCount = 0, solvedCount = 0;
  for (const track of tracks.filter(row => row.status === 'active')) {
    const binding = bindingByTrack.get(track.id);
    if (binding?.disposition === 'ignored' || (!binding && ignored.has(track.id))) continue;
    const shot = shots.find(row => row.id === track.shot_id);
    const startUs = Math.max(track.start_us, shot?.start_us ?? track.start_us);
    const endUs = Math.min(track.end_us, shot?.end_us ?? track.end_us);
    const visible = Math.max(0, endUs - startUs);
    const subject = track.subject === 'animal' ? 'animal' : 'person';
    const totals = subjectCoverage[subject];
    totals.visibleDurationUs += visible;
    const base = {severity: 'warning', trackId: track.id, shotId: track.shot_id, startUs, endUs};
    const character = characterById.get(binding?.character_id);
    const bound = binding?.disposition === 'bound' && !!character;
    if (bound) boundCount++;
    else issues.push({...base, code: 'unbound_subject', message: '出场尚未绑定叙事组，保留为待修正项'});
    if (subject === 'animal') issues.push({...base, code: 'animal_motion_unsupported', message: '动物代理与动作求解尚未实现，尚未在三维中还原'});
    if (artifactErrors[track.id]) issues.push({...base, code: 'motion_artifact_invalid', message: `动作产物不可读：${artifactErrors[track.id]}`});
    const motion = motions[track.id];
    const current = bound && matchesMotionContext(motion, {trackId: track.id, shotId: track.shot_id, characterId: character.id, bodyHeight: character.scale});
    if (motion && !current) issues.push({...base, code: 'motion_artifact_mismatch', message: '动作产物与当前出场、镜头、角色或身高不一致，需要重新求解'});
    const intervals = current && subject === 'person' ? motionIntervals(motion, startUs, endUs) : [];
    const solved = intervals.reduce((sum, [start, end]) => sum + end - start, 0);
    totals.solvedDurationUs += solved;
    if (solved > 0) solvedCount++;
    let cursor = startUs;
    for (const [start, end] of [...intervals, [endUs, endUs]]) {
      if (start > cursor) issues.push({...base, code: 'motion_gap', startUs: cursor, endUs: start, message: subject === 'animal' ? '该区间动物尚未在三维中还原' : bound ? '该区间没有有效动作，播放时使用占位代理' : '该区间人物未绑定代理组，尚未在三维中还原'});
      cursor = Math.max(cursor, end);
    }
  }
  for (const shot of shots) {
    const cameras = cameraTracks.filter(row => row.shot_id === shot.id);
    const valid = cameras.some(row => {
      try {const e = typeof row.extrinsics === 'string' ? JSON.parse(row.extrinsics) : row.extrinsics; return Array.isArray(e?.rotation) && e.rotation.length === 9 && e.rotation.every(Number.isFinite) && Array.isArray(e?.translation) && e.translation.length === 3 && e.translation.every(Number.isFinite);}
      catch {return false;}
    });
    if (!valid) issues.push({code: 'camera_missing', severity: 'warning', shotId: shot.id, startUs: shot.start_us, endUs: shot.end_us, message: '镜头没有可用相机解，使用默认场景相机'});
    else if (cameras.every(row => row.source === 'person-estimate' || row.median_error_px < 0 || row.median_error_px > 8)) issues.push({code: 'camera_review', severity: 'warning', shotId: shot.id, message: '相机仅有估计或误差偏高，需集中核对'});
  }
  const latest = new Map();
  for (const job of jobs) if (!latest.has(job.kind)) latest.set(job.kind, job);
  const analysisKinds = ['proxy', 'pts', 'cuts', 'detect', 'people', 'motion'];
  const building = jobs.some(job => analysisKinds.includes(job.kind) && ['queued', 'running'].includes(job.state));
  const failed = analysisKinds.map(kind => latest.get(kind)).filter(job => ['failed', 'cancelled'].includes(job?.state));
  for (const job of failed) issues.push({code: 'job_failed', severity: 'error', message: `${job.kind} 任务${job.state === 'cancelled' ? '已取消' : '失败'}：${job.error || '未完成'}`});
  const detectJob = latest.get('detect');
  if (detectJob?.state === 'done' && /降级/.test(detectJob.output || '')) issues.push({code: 'detection_degraded', severity: 'warning', message: detectJob.output});
  let visibleDurationUs = 0, solvedDurationUs = 0;
  for (const totals of Object.values(subjectCoverage)) {
    totals.coveragePct = totals.visibleDurationUs ? Math.round(totals.solvedDurationUs / totals.visibleDurationUs * 1000) / 10 : null;
    visibleDurationUs += totals.visibleDurationUs;
    solvedDurationUs += totals.solvedDurationUs;
  }
  const coveragePct = visibleDurationUs ? Math.round(solvedDurationUs / visibleDurationUs * 1000) / 10 : null;
  const completed = latest.get('motion')?.state === 'done' && shots.length > 0;
  const state = building ? 'building' : failed.length ? 'blocked' : completed ? issues.length ? 'ready_with_issues' : 'ready' : 'not_ready';
  return {state, coveragePct, solvedCount, boundCount, visibleDurationUs, solvedDurationUs, subjectCoverage, issues,
    note: state === 'ready_with_issues' ? '全片初稿可播放；动作缺口、动物能力和相机问题集中列出待修正' : state === 'blocked' ? '分析任务未完成；已有产物仍可查看，需处理任务错误后重试' : undefined};
}
