// M6 导出包构建：由导出任务以 tsx 子进程运行。
// 产物：manifest.json、shots.json、cast.json、cameras.json、motion/*.json、characters/*.glb（骨骼动画样例）。
// 边界（如实写进 manifest）：预览视频未渲染；GLB 为每组共享代理资产与逐出场动画片段；
// reconstruct 项目的可见场景资产不在本包内（M4S 未实现）。
import fs from 'node:fs';
import path from 'node:path';
import {buildTimelineRig, prepareTimeline} from '../studio/timeline-export.mjs';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {fileURLToPath} from 'node:url';
import {createStudioStore, ALGORITHM_VERSIONS} from '../studio/db.mjs';

// GLTFExporter 在 Node 缺少 FileReader/DOM：提供基于 Blob 的最小实现（本包无纹理贴图，够用）。
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {blob.arrayBuffer().then(buffer => {this.result = buffer;this.onloadend?.();this.onload?.();});}
    readAsDataURL(blob) {blob.arrayBuffer().then(buffer => {this.result = `data:application/octet-stream;base64,${Buffer.from(buffer).toString('base64')}`;this.onloadend?.();this.onload?.();});}
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectId = arg('project');
const outputDir = arg('output');
// 数据根目录默认仓库根；测试可传 --store-root 指向临时目录
const storeRoot = arg('store-root', projectRoot);
if (!projectId || !outputDir) {console.error('用法：--project <id> --output <dir> [--store-root <dir>] [--export-id <id>]');process.exit(2);}
const exportId = arg('export-id', path.basename(outputDir));
// 子进程只读打开（不触发"重启恢复"，否则会把父进程正在运行的导出任务标为失败）
const store = createStudioStore(storeRoot, {recoverInterrupted: false});

const detail = (() => {
  const project = store.getProjectRow(projectId);
  if (!project) throw new Error('项目不存在');
  const media = store.getMedia(projectId);
  const cast = store.getCast(projectId);
  if (cast.invalidTrackIds.length) throw new Error('出场越过当前镜头边界，请先修正再导出');
  const tracks = store.getTracks(projectId);
  return {project, media, shots: store.getShots(projectId), tracks, characters: store.getCharacters(projectId), cast, cameras: store.getCameraTracks(projectId)};
})();

const characterById = new Map(detail.characters.map(row => [row.id, row.name]));
const bindingByTrack = new Map(detail.cast.bindings.map(row => [row.track_id, row]));
const sourcePeople = store.getPeople(projectId);
const ignoredTrackIds = new Set([
  ...detail.cast.bindings.filter(row => row.disposition === 'ignored').map(row => row.track_id),
  ...sourcePeople.filter(person => person.assignment === 'ignored').flatMap(person => person.trackIds).filter(id => !bindingByTrack.has(id)),
]);

// Keep bound appearances in the edit even without solved motion. Their standing
// placeholders and quality flags must agree with the interactive preview.
const instances = [];
const rawMotions = {};
for (const track of detail.tracks.filter(item => item.status === 'active')) {
  const binding = bindingByTrack.get(track.id);
  if (binding?.disposition !== 'bound' || track.subject === 'animal') continue;
  const character = detail.characters.find(row => row.id === binding.character_id);
  if (!character) throw new Error(`角色不存在：${binding.character_id}`);
  if (track.motion_ref) {
    const motionFile = path.join(storeRoot, track.motion_ref);
    if (!fs.existsSync(motionFile)) throw new Error(`动作文件缺失：${track.id}，请重新生成动作`);
    const motion = JSON.parse(fs.readFileSync(motionFile, 'utf8'));
    if (motion.characterId !== binding.character_id || Math.abs(motion.bodyHeight - character.scale) > 1e-9
        || motion.frames.some(frame => frame && (frame.frame < track.start_frame || frame.frame > track.end_frame))) {
      throw new Error(`动作版本已过期：${track.id}，请按当前分组重新生成动作`);
    }
    motion.trackId = track.id;motion.shotId = track.shot_id;motion.characterName = character.name;
    rawMotions[track.id] = motion;
    fs.mkdirSync(path.join(outputDir, 'motion'), {recursive: true});
    fs.writeFileSync(path.join(outputDir, 'motion', `${track.id}.json`), JSON.stringify(motion));
  }
  instances.push({
    id: 'inst-' + track.id, trackId: track.id, shotId: track.shot_id,
    characterId: binding.character_id, characterName: characterById.get(binding.character_id) || '',
    startFrame: track.start_frame, endFrame: track.end_frame, startUs: track.start_us, endUs: track.end_us,
    motionRef: track.motion_ref ? `motion/${track.id}.json` : null,
    proxyLevel: character.proxy_level || 'CL1', rigFamily: character.rig_family || 'humanoid',
  });
}

const playbackDetail = {
  project: {id: detail.project.id, revision: detail.project.revision},
  media: detail.media ? {width: detail.media.width, height: detail.media.height, durationUs: detail.media.duration_us, fps: detail.media.fps_num / detail.media.fps_den} : null,
  shots: detail.shots.map(row => ({id: row.id, startUs: row.start_us, endUs: row.end_us, startFrame: row.start_frame, endFrameExclusive: row.end_frame_exclusive})),
  tracks: detail.tracks.map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame, startUs: row.start_us, endUs: row.end_us, box: JSON.parse(row.box), status: row.status, subject: row.subject || 'person'})),
  characters: detail.characters.map(row => ({id: row.id, name: row.name, scale: row.scale, color: row.color, proxyLevel: row.proxy_level || 'CL1', rigFamily: row.rig_family || 'humanoid'})),
  bindings: detail.cast.bindings.map(row => ({trackId: row.track_id, characterId: row.character_id, disposition: row.disposition})),
  cameraTracks: detail.cameras.map(row => ({id: row.id, shotId: row.shot_id, source: row.source, intrinsics: JSON.parse(row.intrinsics), extrinsics: JSON.parse(row.extrinsics), confidence: row.confidence, needsManualReview: row.median_error_px > 8 || row.source === 'person-estimate'})),
  motionRefs: Object.fromEntries(detail.tracks.filter(row => row.motion_ref).map(row => [row.id, row.motion_ref])),
};
const sourcePts = detail.media ? store.loadPtsFor(detail.media) : [];
const timeline = prepareTimeline(playbackDetail, rawMotions, sourcePts);
fs.writeFileSync(path.join(outputDir, 'timeline.json'), JSON.stringify({schemaVersion: 1, sampling: 'source-pts-and-transitions-step', durationUs: detail.media?.duration_us || 0,
  frames: timeline.frames.map(({ptsUs, shot, camera, cameraNote, instances: sampled}) => ({ptsUs, shotId: shot?.id || null, camera, cameraNote, instances: sampled}))}));

fs.writeFileSync(path.join(outputDir, 'shots.json'), JSON.stringify(detail.shots.map(row => ({
  id: row.id, idx: row.idx, startFrame: row.start_frame, endFrameExclusive: row.end_frame_exclusive,
  startUs: row.start_us, endUs: row.end_us, source: row.source,
})), null, 2));
fs.writeFileSync(path.join(outputDir, 'cast.json'), JSON.stringify({
  sourcePeople,
  characters: detail.characters.map(row => ({id: row.id, name: row.name, color: row.color, scale: row.scale, revision: row.revision, proxyLevel: row.proxy_level || 'CL1', rigFamily: row.rig_family || 'humanoid'})),
  bindings: detail.cast.bindings.map(row => ({trackId: row.track_id, characterId: row.character_id, disposition: row.disposition})),
  approval: detail.cast.approval ? {status: detail.cast.approval.status, approvedAt: detail.cast.approval.approved_at, frozen: detail.cast.approval.frozen} : null,
}, null, 2));
fs.writeFileSync(path.join(outputDir, 'cameras.json'), JSON.stringify(detail.cameras.map(row => ({
  shotId: row.shot_id, source: row.source, intrinsics: JSON.parse(row.intrinsics), extrinsics: JSON.parse(row.extrinsics),
  confidence: row.confidence, medianErrorPx: row.median_error_px, needsManualReview: row.median_error_px > 8 || row.source === 'person-estimate',
})), null, 2));

// One shared proxy asset per group; preserve all independently timed appearances as clips.
async function exportCharacterGlb(characterRow) {
  const appearances = instances.filter(instance => instance.characterId === characterRow.id);
  if (!appearances.length) return null;
  const {group, clips} = buildTimelineRig(characterRow, appearances.map(instance => instance.trackId), timeline.frames);
  const buffer = await new GLTFExporter().parseAsync(group, {binary: true, animations: clips, onlyVisible: true});
  fs.mkdirSync(path.join(outputDir, 'characters'), {recursive: true});
  const file = path.join(outputDir, 'characters', `${characterRow.id}.glb`);
  fs.writeFileSync(file, Buffer.from(buffer));
  group.traverse(object => {if (object.isMesh) {object.geometry.dispose();object.material.dispose();}});
  return {file, rig: 'timeline-rigid-proxy-v3', proxyLevel: characterRow.proxy_level || 'CL1', rigFamily: characterRow.rig_family || 'humanoid', clips: clips.map(clip => clip.name),
    clipPlacements: appearances.map(instance => ({clip: `motion-${instance.trackId}`, trackId: instance.trackId, startUs: instance.startUs, endUs: instance.endUs})), frames: timeline.frames.length};
}

const glbs = [];
for (const characterRow of detail.characters) {
  const glb = await exportCharacterGlb(characterRow);
  if (glb) glbs.push({characterId: characterRow.id, ...glb});
}

const manifest = {
  schemaVersion: 2,
  exportId,
  generatedAt: new Date().toISOString(),
  project: {id: detail.project.id, name: detail.project.name, sceneMode: detail.project.scene_mode, phase: detail.project.phase, revision: detail.project.revision, sceneStatus: detail.project.scene_status},
  media: detail.media ? {sha256: detail.media.sha256, durationUs: detail.media.duration_us, width: detail.media.width, height: detail.media.height, ptsCount: detail.media.pts_count} : null,
  algorithmVersions: {
    ...ALGORITHM_VERSIONS,
    ...(detail.cast.approval?.status === 'approved' ? detail.cast.approval.frozen?.algorithmVersions : {}),
    export: ALGORITHM_VERSIONS.export,
    detector: (() => {
      const frozen = detail.cast.approval?.status === 'approved' ? detail.cast.approval.frozen?.algorithmVersions?.detector : null;
      if (frozen && frozen !== 'none') return frozen;
      const completed = store.listJobs(projectId).filter(job => job.kind === 'detect' && job.state === 'done');
      if (completed.length > 0) return completed.find(job => job.algorithm_version)?.algorithm_version || 'unrecorded-legacy-detection';
      return detail.tracks.some(track => track.status === 'active' && track.provenance === 'auto') ? 'unrecorded-auto-tracks' : 'none';
    })(),
  },
  instanceCount: instances.length,
  sampling: 'source-pts-and-transitions-step',
  timeline: 'timeline.json',
  excludedTrackIds: detail.tracks.filter(track => track.status === 'active' && ignoredTrackIds.has(track.id)).map(track => track.id),
  unsupportedTrackIds: detail.tracks.filter(track => track.status === 'active' && track.subject === 'animal' && !ignoredTrackIds.has(track.id)).map(track => track.id),
  missingMotionTrackIds: detail.tracks.filter(track => track.status === 'active' && bindingByTrack.get(track.id)?.disposition === 'bound' && !track.motion_ref).map(track => track.id),
  instances,
  characterGlbs: glbs.map(entry => ({...entry, file: entry.file ? path.basename(entry.file) : null})),
  included: ['shots.json 镜头时间表', 'cast.json 角色、CL 与归并清单', 'cameras.json 相机轨迹与不确定性', 'timeline.json 与网页共用采样的全片相机、实例和质量状态', 'motion/*.json 逐实例观测动作', 'characters/*.glb 与网页相同 CL 代理资产，包含组内各出场 STEP 动画片段'],
  notIncluded: {
    previewVideo: '预览视频渲染未实现（需三维渲染管线）',
    sceneAssets: detail.project.scene_mode === 'reconstruct' ? '可见场景资产未制作（M4S 未实现）；本包不含场景' : undefined,
    animalMotion: '动物骨架与姿态求解尚未接入，unsupportedTrackIds 中的动物未导出为人体。',
    dccReadback: '本代理使用网页同一刚性骨架、CL 和采样器；Blender/Maya/Houdini 尚未实测。',
  },
};
fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
store.close();
console.log(JSON.stringify({exportId, instances: instances.length, glbs: glbs.length}, null, 2));
