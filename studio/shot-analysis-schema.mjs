import {SHOT_SIZES, SHOT_CATEGORIES, CAMERA_MOVES, RHYTHM_ROLES} from '../vendor/reelbench/video-shots/scripts/video-shots.mjs';

export const SHOT_ANALYSIS_SCHEMA_VERSION = 'shot-analysis-v1';
export const SHOT_ANALYSIS_PROMPT_VERSION = 'shot-analysis-prompt-v1';
// Unknown is a documented local extension. It is never coerced into a confident upstream label.
export const ANNOTATION_ENUMS = Object.freeze(Object.fromEntries(Object.entries({size: SHOT_SIZES, category: SHOT_CATEGORIES, camera: CAMERA_MOVES, rhythm: RHYTHM_ROLES}).map(([key, values]) => [key, [...Object.keys(values), 'unknown']])));
const required = ['size', 'category', 'camera', 'frame', 'action', 'composition', 'scene', 'subjects', 'evidenceFrames'];
const textFields = ['frame', 'action', 'composition', 'scene', 'rhythmNote', 'onscreenText', 'audio', 'note'];
const allowed = new Set([...required, ...textFields, 'rhythm', 'uncertainties', 'cutSuggestions']);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanText = (v, max = 4000) => typeof v === 'string' && v.length <= max && v.trim().length > 0;
const frameList = (v, allowedFrames) => Array.isArray(v) && v.length > 0 && v.length <= 256 && v.every(f => Number.isSafeInteger(f) && f >= 0 && (!allowedFrames || allowedFrames.has(f))) && new Set(v).size === v.length;

export function validateAnnotation(value, {partial = false, allowedFrames, subjectIds, shot} = {}) {
  const errors = [];
  if (!object(value)) return {valid: false, errors: ['annotation 必须为对象'], value: null};
  const frames = allowedFrames ? new Set(allowedFrames) : null;
  const ids = subjectIds ? new Set(subjectIds) : null;
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`不允许写入 annotation.${key}`);
  if (!partial) for (const key of required) if (!(key in value)) errors.push(`缺少 annotation.${key}`);
  for (const [key, enums] of Object.entries(ANNOTATION_ENUMS)) if (key in value && !enums.includes(value[key])) errors.push(`${key} 不在词表中`);
  for (const key of textFields) if (key in value && !(typeof value[key] === 'string' && value[key].length <= 4000 && (!required.includes(key) || value[key].trim()))) errors.push(`${key} 必须是有效文本`);
  if ('subjects' in value && (!Array.isArray(value.subjects) || value.subjects.length > 128 || value.subjects.some(id => !cleanText(id, 80) || (ids && !ids.has(id))) || new Set(value.subjects).size !== value.subjects.length)) errors.push('subjects 含无效或未声明的主体 ID');
  if ('evidenceFrames' in value && !frameList(value.evidenceFrames, frames)) errors.push('evidenceFrames 必须引用实际提供的证据帧');
  if ('uncertainties' in value && (!Array.isArray(value.uncertainties) || value.uncertainties.length > 64 || value.uncertainties.some(x => !cleanText(x, 1000)))) errors.push('uncertainties 格式无效');
  if (!partial && ['size', 'category', 'camera', 'rhythm'].some(k => value[k] === 'unknown') && !value.uncertainties?.length) errors.push('unknown 必须附 uncertainties 原因');
  if ('cutSuggestions' in value && (!Array.isArray(value.cutSuggestions) || value.cutSuggestions.length > 16 || value.cutSuggestions.some(s => !object(s) || Object.keys(s).some(k => !['frameIndex', 'action', 'reason'].includes(k)) || !Number.isSafeInteger(s.frameIndex) || s.frameIndex < 0 || !['split', 'merge'].includes(s.action) || !cleanText(s.reason, 1000) || (shot && (s.action === 'split' ? s.frameIndex <= shot.startFrame || s.frameIndex >= shot.endFrameExclusive : ![shot.startFrame, shot.endFrameExclusive].includes(s.frameIndex)))))) errors.push('cutSuggestions 必须是镜内切分或镜边界合并建议');
  return {valid: errors.length === 0, errors, value: errors.length ? null : structuredClone(value)};
}

export function validateSubjects(value, {allowedFrames} = {}) {
  const errors = [], frames = allowedFrames ? new Set(allowedFrames) : null;
  if (!Array.isArray(value) || value.length > 256) return {valid: false, errors: ['subjects 必须为数组且不超过 256 个候选'], value: null};
  const seen = new Set();
  for (const subject of value) {
    if (!object(subject)) {errors.push('subject 必须为对象');continue;}
    if (Object.keys(subject).some(k => !['id', 'kind', 'name', 'description', 'species', 'referenceFrames', 'uncertain'].includes(k))) errors.push('subject 包含未允许字段');
    if (!cleanText(subject.id, 80) || !/^[A-Za-z0-9_-]+$/.test(subject.id) || seen.has(subject.id)) errors.push('subject ID 无效或重复');
    seen.add(subject.id);
    if (!['person', 'animal', 'unknown'].includes(subject.kind)) errors.push('subject.kind 无效');
    if (!cleanText(subject.name, 160) || !cleanText(subject.description, 2000)) errors.push('subject 缺少名称或可核对描述');
    if (!frameList(subject.referenceFrames, frames)) errors.push('subject.referenceFrames 必须引用实际提供的证据帧');
    if ('species' in subject && !cleanText(subject.species, 160)) errors.push('subject.species 无效');
    if ('uncertain' in subject && typeof subject.uncertain !== 'boolean') errors.push('subject.uncertain 必须为布尔值');
  }
  return {valid: errors.length === 0, errors, value: errors.length ? null : structuredClone(value)};
}

export function validateIssues(value = []) {
  if (!Array.isArray(value) || value.length > 256) return {valid: false, errors: ['issues 格式无效'], value: null};
  const errors = [];
  for (const issue of value) if (!object(issue) || Object.keys(issue).some(k => !['code', 'severity', 'message', 'shotId', 'field'].includes(k)) || !cleanText(issue.code, 100) || !cleanText(issue.message, 2000) || !['info', 'warning', 'error'].includes(issue.severity) || ('shotId' in issue && !cleanText(issue.shotId, 80)) || ('field' in issue && !cleanText(issue.field, 80))) errors.push('issue 格式无效');
  return {valid: errors.length === 0, errors, value: errors.length ? null : structuredClone(value)};
}
