import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {migratePeople, projectOperations} from './project-operations.mjs';

export const fail = (message, status = 409) => Object.assign(new Error(message), {status});
export const newId = prefix => prefix + '-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
export const nowIso = () => new Date().toISOString();
export const stableHash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export const SCHEMA_VERSION = 5;
export const PHASES = ['draft', 'analyzed', 'cast_confirmed', 'keyframes_confirmed', 'motion_confirmed', 'delivered'];
export const PHASE_LABELS = {draft: '草稿', analyzed: '素材已分析', cast_confirmed: '角色已确认', keyframes_confirmed: '关键姿态已确认（未实现）', motion_confirmed: '动作已确认（未实现）', delivered: '已交付（未实现）'};
export const SCENE_MODES = ['proxy', 'reconstruct'];
export const SCENE_STATUSES = ['not_requested', 'pending', 'approved'];
export const ALGORITHM_VERSIONS = {cuts: 'histogram-v1', tracker: 'iou-observations-v2', detector: 'none', motion: 'fixed-bone-lift-v1', camera: 'dlt-gn-pnp-v1', export: 'proxy-segments-package-v2'};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, revision TEXT NOT NULL,
  name TEXT NOT NULL, scene_mode TEXT NOT NULL, phase TEXT NOT NULL,
  scene_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, revision TEXT NOT NULL,
  time TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_history_project ON project_history(project_id);
CREATE TABLE IF NOT EXISTS media(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL,
  original_name TEXT NOT NULL, original_ref TEXT NOT NULL, proxy_ref TEXT NOT NULL,
  duration_us INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  rotation INTEGER NOT NULL DEFAULT 0, timebase TEXT NOT NULL, fps_num INTEGER NOT NULL, fps_den INTEGER NOT NULL,
  vfr INTEGER NOT NULL DEFAULT 0, video_codec TEXT NOT NULL, audio_codec TEXT,
  pts_map_ref TEXT, pts_count INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shots(
  id TEXT NOT NULL, project_id TEXT NOT NULL, idx INTEGER NOT NULL,
  start_frame INTEGER NOT NULL, end_frame_exclusive INTEGER NOT NULL,
  start_us INTEGER NOT NULL, end_us INTEGER NOT NULL, source TEXT NOT NULL,
  revision TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, id)
);
CREATE INDEX IF NOT EXISTS shots_project ON shots(project_id, idx);
CREATE TABLE IF NOT EXISTS tracks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT NOT NULL,
  start_frame INTEGER NOT NULL, end_frame INTEGER NOT NULL,
  start_us INTEGER NOT NULL, end_us INTEGER NOT NULL,
  box TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, provenance TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', observations_ref TEXT, motion_ref TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_project ON tracks(project_id, shot_id, status);
CREATE TABLE IF NOT EXISTS characters(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision TEXT NOT NULL,
  name TEXT NOT NULL, color TEXT NOT NULL, scale REAL NOT NULL,
  rig_ref TEXT NOT NULL DEFAULT '', allow_simultaneous INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS characters_project ON characters(project_id);
CREATE TABLE IF NOT EXISTS bindings(
  track_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  character_id TEXT, disposition TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bindings_project ON bindings(project_id);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL, progress REAL NOT NULL DEFAULT 0,
  input_hash TEXT NOT NULL DEFAULT '', algorithm_version TEXT NOT NULL DEFAULT '',
  error TEXT, output TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
CREATE TABLE IF NOT EXISTS cast_approval(
  project_id TEXT PRIMARY KEY, revision TEXT NOT NULL, status TEXT NOT NULL,
  approved_at TEXT NOT NULL, approved_by TEXT NOT NULL DEFAULT '', frozen TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS camera_tracks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT NOT NULL,
  source TEXT NOT NULL, intrinsics TEXT NOT NULL, extrinsics TEXT NOT NULL,
  confidence REAL NOT NULL, median_error_px REAL NOT NULL,
  evidence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS camera_tracks_project ON camera_tracks(project_id, shot_id);
`;

export function createStudioStore(root, options = {}) {
  const recoverInterrupted = options.recoverInterrupted !== false;
  const dataDirectory = path.join(root, 'data');
  const projectsDirectory = path.join(dataDirectory, 'projects');
  fs.mkdirSync(projectsDirectory, {recursive: true});
  const db = new DatabaseSync(path.join(dataDirectory, 'studio.sqlite3'));
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  const version = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION) throw fail(`元数据库版本 ${version} 高于当前程序 ${SCHEMA_VERSION}，请升级程序`, 500);
  if (version < SCHEMA_VERSION) {
    if (version > 0) db.prepare('VACUUM INTO ?').run(path.join(dataDirectory, `studio-before-v${SCHEMA_VERSION}-${Date.now()}.sqlite3`));
    db.exec('BEGIN');
    try {
      db.exec(SCHEMA);
      const columns = db.prepare('PRAGMA table_info(tracks)').all().map(row => row.name);
      if (!columns.includes('motion_ref')) db.exec('ALTER TABLE tracks ADD COLUMN motion_ref TEXT');
      if (version < 3) migratePeople(db);
      const projectColumns = db.prepare('PRAGMA table_info(projects)').all().map(row => row.name);
      if (!projectColumns.includes('source_people_count')) db.exec('ALTER TABLE projects ADD COLUMN source_people_count INTEGER');
      const peopleColumns = db.prepare('PRAGMA table_info(source_people)').all().map(row => row.name);
      if (!peopleColumns.includes('assignment')) db.exec("ALTER TABLE source_people ADD COLUMN assignment TEXT NOT NULL DEFAULT 'unassigned'");
      db.prepare('UPDATE projects SET schema_version=?').run(SCHEMA_VERSION);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (cause) {db.exec('ROLLBACK');db.close();throw cause;}
  }
  // 进程重启恢复：遗留的 queued/running 任务如实标记为失败（计划 §8）。
  // 导出子进程等只读场景可关闭（options.recoverInterrupted=false）。
  if (recoverInterrupted) {
    const interrupted = db.prepare("UPDATE jobs SET state='failed', error='服务进程重启，任务中断；可重试。', updated_at=? WHERE state IN ('queued','running')").run(nowIso());
    if (interrupted.changes > 0) console.log(`[studio] 恢复：${interrupted.changes} 个中断任务已标记为失败`);
  }

  const tx = fn => {db.exec('BEGIN');try {const result = fn();db.exec('COMMIT');return result;} catch (cause) {try {db.exec('ROLLBACK');} catch {}throw cause;}};
  const projectDir = id => path.join(projectsDirectory, id);
  const mediaDir = id => path.join(projectDir(id), 'media');
  const proxiesDir = id => path.join(projectDir(id), 'proxies');
  const observationsDir = id => path.join(projectDir(id), 'observations');
  const previewsDir = id => path.join(projectDir(id), 'previews');
  const exportsDir = id => path.join(projectDir(id), 'exports');

  const query = {
    project: db.prepare('SELECT * FROM projects WHERE id=?'),
    projects: db.prepare('SELECT p.*, (SELECT COUNT(*) FROM tracks WHERE project_id=p.id AND status=\'active\') AS track_count, (SELECT COUNT(*) FROM shots WHERE project_id=p.id) AS shot_count FROM projects p ORDER BY p.created_at DESC'),
    media: db.prepare('SELECT * FROM media WHERE project_id=?'),
    shots: db.prepare('SELECT * FROM shots WHERE project_id=? ORDER BY idx'),
    tracks: db.prepare('SELECT * FROM tracks WHERE project_id=? ORDER BY shot_id, start_frame'),
    track: db.prepare('SELECT * FROM tracks WHERE id=? AND project_id=?'),
    characters: db.prepare('SELECT * FROM characters WHERE project_id=? ORDER BY created_at'),
    character: db.prepare('SELECT * FROM characters WHERE id=? AND project_id=?'),
    bindings: db.prepare('SELECT * FROM bindings WHERE project_id=?'),
    jobs: db.prepare('SELECT * FROM jobs WHERE project_id=? ORDER BY created_at DESC'),
    job: db.prepare('SELECT * FROM jobs WHERE id=?'),
    approval: db.prepare('SELECT * FROM cast_approval WHERE project_id=?'),
    history: db.prepare('SELECT revision, time, reason FROM project_history WHERE project_id=? ORDER BY id'),
    cameraTracks: db.prepare('SELECT * FROM camera_tracks WHERE project_id=? ORDER BY shot_id, created_at'),
  };
  query.cameraTrack = id => db.prepare('SELECT * FROM camera_tracks WHERE id=?').get(id);

  const appendHistory = (projectId, revision, reason) => db.prepare('INSERT INTO project_history(project_id, revision, time, reason) VALUES(?,?,?,?)').run(projectId, revision, nowIso(), reason);

  const assertRevision = (projectId, baseRevision, message) => {
    const project = query.project.get(projectId);
    if (!project) throw fail('项目不存在', 404);
    if (typeof baseRevision !== 'string' || baseRevision !== project.revision) throw fail(message || '项目版本已变化，请刷新后重试');
    return project;
  };

  const bumpRevision = (projectId, reason) => {
    const revision = 'r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
    db.prepare('UPDATE projects SET revision=?, updated_at=? WHERE id=?').run(revision, nowIso(), projectId);
    appendHistory(projectId, revision, reason);
    return revision;
  };

  const setPhase = (projectId, phase) => db.prepare('UPDATE projects SET phase=?, updated_at=? WHERE id=?').run(phase, nowIso(), projectId);

  // ---- 项目 ----
  const createProject = input => {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80) throw fail('项目名称必须是 1–80 个字符', 400);
    const sceneMode = input?.sceneMode;
    if (!SCENE_MODES.includes(sceneMode)) throw fail('场景模式必须是 proxy 或 reconstruct', 400);
    const id = newId('p');
    const time = nowIso();
    tx(() => {
      db.prepare('INSERT INTO projects(id, schema_version, revision, name, scene_mode, phase, scene_status, note, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, SCHEMA_VERSION, 'r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), name, sceneMode, 'draft', sceneMode === 'proxy' ? 'not_requested' : 'pending', String(input?.note || '').slice(0, 400), time, time);
      appendHistory(id, query.project.get(id).revision, '创建项目');
    });
    for (const dir of [mediaDir(id), proxiesDir(id), observationsDir(id), previewsDir(id), exportsDir(id)]) fs.mkdirSync(dir, {recursive: true});
    return query.project.get(id);
  };

  const listProjects = () => query.projects.all();
  const getProjectRow = id => query.project.get(id) || null;

  // ---- 媒体 ----
  const insertMedia = (projectId, record) => {
    assertRevision(projectId, record.baseRevision, '项目版本已变化，请刷新后重新上传');
    if (query.media.get(projectId)) throw fail('项目已包含媒体。首版每个项目只支持一个视频；请新建项目导入其他素材。', 409);
    tx(() => {
      db.prepare(`INSERT INTO media(id, project_id, sha256, original_name, original_ref, proxy_ref, duration_us, width, height, rotation, timebase, fps_num, fps_den, vfr, video_codec, audio_codec, pts_map_ref, pts_count, size_bytes, created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        record.id, projectId, record.sha256, record.originalName, record.originalRef, record.proxyRef,
        record.durationUs, record.width, record.height, record.rotation, record.timebase, record.fpsNum, record.fpsDen,
        record.vfr ? 1 : 0, record.videoCodec, record.audioCodec, record.ptsMapRef || null, record.ptsCount || 0, record.sizeBytes, nowIso());
      bumpRevision(projectId, `导入媒体 ${record.originalName}（sha256 前 12 位 ${record.sha256.slice(0, 12)}）`);
    });
    return query.media.get(projectId);
  };
  const getMedia = projectId => query.media.get(projectId) || null;

  // ---- 镜头 ----
  const replaceShots = (projectId, shots, source, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const media = query.media.get(projectId);
    if (!media) throw fail('项目还没有导入媒体', 422);
    validateShotCoverage(shots, media.pts_count);
    tx(() => {
      db.prepare('DELETE FROM shots WHERE project_id=?').run(projectId);
      const insert = db.prepare('INSERT INTO shots(id, project_id, idx, start_frame, end_frame_exclusive, start_us, end_us, source, revision, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
      const time = nowIso();
      shots.forEach((shot, idx) => insert.run(shot.id, projectId, idx, shot.startFrame, shot.endFrameExclusive, shot.startUs, shot.endUs, source, 'r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), time));
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, '切点被修改');
      db.prepare('UPDATE tracks SET motion_ref=NULL WHERE project_id=?').run(projectId);
      db.prepare('DELETE FROM camera_tracks WHERE project_id=?').run(projectId);
      if (query.project.get(projectId).phase === 'draft') setPhase(projectId, 'analyzed');
      bumpRevision(projectId, source === 'user' ? '人工修改切点' : '写入自动切镜结果');
    });
    // 镜头缩略图按旧边界生成，切点变化后必须作废（由预览接口按需重新生成）
    try {fs.rmSync(path.join(previewsDir(projectId), 'shots'), {recursive: true, force: true});} catch {}
    return query.shots.all(projectId);
  };

  const getShots = projectId => query.shots.all(projectId);

  function validateShotCoverage(shots, frameCount) {
    if (!Array.isArray(shots) || shots.length === 0) throw fail('镜头列表不能为空', 400);
    if (!Number.isInteger(frameCount) || frameCount < 1) throw fail('媒体帧数信息缺失，无法写入镜头', 422);
    let expected = 0;
    for (const shot of shots) {
      if (!Number.isInteger(shot.startFrame) || !Number.isInteger(shot.endFrameExclusive)) throw fail('镜头边界必须是整数帧', 400);
      if (shot.startFrame !== expected || shot.endFrameExclusive <= shot.startFrame || shot.endFrameExclusive > frameCount) throw fail('镜头边界必须按呈现帧顺序无缝覆盖全部帧', 400);
      expected = shot.endFrameExclusive;
    }
    if (expected !== frameCount) throw fail(`镜头必须覆盖全部 ${frameCount} 帧，当前止于第 ${expected} 帧`, 400);
  }

  // ---- 轨迹（素材人物出场候选）----
  const frameTimeUs = (media, pts, frame) => {
    if (Array.isArray(pts) && pts.length > 0) return Math.round(pts[Math.min(frame, pts.length - 1)] * 1e6);
    const fps = media && media.fps_den ? media.fps_num / media.fps_den : 24;
    return Math.round(frame / fps * 1e6);
  };

  const assertTrackRange = (projectId, shotId, startFrame, endFrame) => {
    const shot = db.prepare('SELECT * FROM shots WHERE project_id=? AND id=?').get(projectId, shotId);
    if (!shot) throw fail('镜头不存在', 404);
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < shot.start_frame || endFrame > shot.end_frame_exclusive - 1 || startFrame > endFrame) {
      throw fail(`出场区间必须是 ${shot.id} 内的有效帧范围（${shot.start_frame}–${shot.end_frame_exclusive - 1}）`, 400);
    }
    return shot;
  };
  const assertBox = box => {
    const keys = ['x', 'y', 'w', 'h'];
    if (!box || keys.some(key => typeof box[key] !== 'number' || !Number.isFinite(box[key]))) throw fail('人物框必须是 {x,y,w,h} 数字', 400);
    if (keys.some(key => box[key] < 0 || box[key] > 1)) throw fail('人物框使用 0–1 的归一化坐标', 400);
    if (box.w <= 0 || box.h <= 0) throw fail('人物框宽高必须大于 0', 400);
    if (box.x + box.w > 1 || box.y + box.h > 1) throw fail('人物框超出画面', 400);
  };

  const insertTrack = (projectId, shotId, {startFrame, endFrame, box, confidence, provenance}, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const shot = assertTrackRange(projectId, shotId, startFrame, endFrame);
    assertBox(box);
    const media = query.media.get(projectId);
    const pts = loadPtsFor(media);
    const id = newId('t');
    const time = nowIso();
    tx(() => {
      db.prepare(`INSERT INTO tracks(id, project_id, shot_id, start_frame, end_frame, start_us, end_us, box, confidence, provenance, status, observations_ref, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, shotId, startFrame, endFrame,
        frameTimeUs(media, pts, startFrame), endFrame + 1 < media.pts_count ? frameTimeUs(media, pts, endFrame + 1) : media.duration_us, JSON.stringify(box),
        Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1, provenance, 'active',
        `observations/tracks/${id}.json`, time, time);
      operations.ensurePerson(id, projectId);
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, '人物候选被修改');
      bumpRevision(projectId, `新增${provenance === 'user' ? '人工补标' : '自动'}出场候选 ${id}`);
    });
    return query.track.get(id, projectId);
  };

  const loadPtsFor = media => {
    if (!media?.pts_map_ref) return [];
    try {return JSON.parse(fs.readFileSync(path.join(root, media.pts_map_ref), 'utf8')).pts || [];} catch {return [];}
  };

  const mutateTrack = (projectId, trackId, baseRevision, reason, mutate) => {
    assertRevision(projectId, baseRevision);
    const track = query.track.get(trackId, projectId);
    if (!track) throw fail('出场候选不存在', 404);
    if (track.status !== 'active') throw fail('该出场候选已被删除', 422);
    tx(() => {
      mutate(track);
      db.prepare('UPDATE tracks SET motion_ref=NULL WHERE id=?').run(trackId);
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, reason);
      bumpRevision(projectId, reason);
    });
    return query.track.get(trackId, projectId);
  };

  // 批量写入（自动分析任务用）：整个候选集算一次正式变更，只校验/推进一次版本。
  const insertTracks = (projectId, specs, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const media = query.media.get(projectId);
    if (!media) throw fail('项目还没有导入媒体', 422);
    const pts = loadPtsFor(media);
    const prepared = specs.map(spec => {
      assertTrackRange(projectId, spec.shotId, spec.startFrame, spec.endFrame);
      assertBox(spec.box);
      return spec;
    });
    const created = [];
    tx(() => {
      const protectedAuto = db.prepare(`SELECT t.id FROM tracks t LEFT JOIN bindings b ON b.track_id=t.id LEFT JOIN source_people p ON p.id=t.person_id
        WHERE t.project_id=? AND t.status='active' AND t.provenance='auto' AND (p.reviewed=1 OR b.disposition IN ('bound','ignored'))`).get(projectId);
      if (protectedAuto) throw fail('已有人工核对或归组的自动候选，重新检测会替换它们。请新建项目重新检测，或继续修正现有候选。', 409);
      db.prepare("UPDATE tracks SET status='superseded',motion_ref=NULL WHERE project_id=? AND provenance='auto' AND status='active'").run(projectId);
      const time = nowIso();
      for (const spec of prepared) {
        const id = newId('t');
        db.prepare(`INSERT INTO tracks(id, project_id, shot_id, start_frame, end_frame, start_us, end_us, box, confidence, provenance, status, observations_ref, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, spec.shotId, spec.startFrame, spec.endFrame,
          frameTimeUs(media, pts, spec.startFrame), spec.endFrame + 1 < media.pts_count ? frameTimeUs(media, pts, spec.endFrame + 1) : media.duration_us, JSON.stringify(spec.box),
          Number.isFinite(spec.confidence) ? Math.min(1, Math.max(0, spec.confidence)) : 1, spec.provenance, 'active',
          `observations/tracks/${id}.json`, time, time);
        operations.ensurePerson(id, projectId, spec);
        created.push(query.track.get(id, projectId));
      }
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, '人物候选被重新分析');
      bumpRevision(projectId, `写入 ${prepared.length} 条自动出场候选`);
    });
    return created;
  };

  const deleteTrack = (projectId, trackId, baseRevision) =>
    mutateTrack(projectId, trackId, baseRevision, `删除误检出场候选 ${trackId}`, track => {
      db.prepare('DELETE FROM bindings WHERE track_id=?').run(trackId);
      db.prepare("UPDATE tracks SET status='deleted', updated_at=? WHERE id=?").run(nowIso(), trackId);
    });

  const splitTrack = (projectId, trackId, splitFrame, baseRevision) => {
    const track = query.track.get(trackId, projectId);
    if (!track) throw fail('出场候选不存在', 404);
    if (!Number.isInteger(splitFrame) || splitFrame <= track.start_frame || splitFrame > track.end_frame) throw fail(`拆分帧必须是 ${track.start_frame + 1}–${track.end_frame} 之间的整数`, 400);
    let created = null;
    const result = mutateTrack(projectId, trackId, baseRevision, `在帧 ${splitFrame} 拆分出场候选 ${trackId}`, () => {
      db.prepare('UPDATE tracks SET end_frame=?, end_us=?, updated_at=? WHERE id=?').run(splitFrame - 1, frameTimeUs(query.media.get(projectId), loadPtsFor(query.media.get(projectId)), splitFrame), nowIso(), trackId);
      created = insertTrackLocked(projectId, track.shot_id, {startFrame: splitFrame, endFrame: track.end_frame, box: JSON.parse(track.box), confidence: track.confidence, provenance: 'user'});
      const poseFile = path.join(observationsDir(projectId), 'poses', `${track.id}.json`);
      if (fs.existsSync(poseFile)) {
        const pose = JSON.parse(fs.readFileSync(poseFile, 'utf8'));
        fs.writeFileSync(path.join(observationsDir(projectId), 'poses', `${created.id}.json`), JSON.stringify({...pose, trackId: created.id, frames: pose.frames.filter(frame => frame.frame >= splitFrame && frame.frame <= track.end_frame)}));
        const representative = pose.frames.filter(frame => frame.frame >= track.start_frame && frame.frame < splitFrame && frame.box).at(-1);
        if (representative) db.prepare('UPDATE tracks SET box=?,representative_frame=?,appearance=NULL WHERE id=?').run(JSON.stringify(representative.box), representative.frame, trackId);
      }
      fs.rmSync(path.join(previewsDir(projectId), 'tracks', `${trackId}-v3.jpg`), {force: true});
      db.prepare("UPDATE tracks SET provenance='user' WHERE id=?").run(trackId);
    });
    return {...result, created};
  };

  const insertTrackLocked = (projectId, shotId, spec) => {
    const media = query.media.get(projectId);
    const pts = loadPtsFor(media);
    const id = newId('t');
    const time = nowIso();
    db.prepare(`INSERT INTO tracks(id, project_id, shot_id, start_frame, end_frame, start_us, end_us, box, confidence, provenance, status, observations_ref, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, projectId, shotId, spec.startFrame, spec.endFrame,
      frameTimeUs(media, pts, spec.startFrame), (spec.endFrame + 1 < media.pts_count ? frameTimeUs(media, pts, spec.endFrame + 1) : media.duration_us), JSON.stringify(spec.box),
      spec.confidence ?? 1, spec.provenance, 'active', `observations/tracks/${id}.json`, time, time);
    operations.ensurePerson(id, projectId);
    return query.track.get(id, projectId);
  };

  const mergeTracks = (projectId, trackId, otherId, baseRevision) => {
    const track = query.track.get(trackId, projectId);
    const other = query.track.get(otherId, projectId);
    if (!track || !other) throw fail('出场候选不存在', 404);
    if (track.shot_id !== other.shot_id) throw fail('跨切镜的出场不能自动连接为同一条轨迹', 422);
    if (track.status !== 'active' || other.status !== 'active') throw fail('已删除的候选不能连接', 422);
    const bindingState = id => {const binding = query.bindings.all(projectId).find(row => row.track_id === id);return [binding?.disposition || 'unassigned', binding?.character_id || ''].join(':');};
    if (bindingState(track.id) !== bindingState(other.id)) throw fail('两段出场的代理分组不同，请先统一分组后再连接', 422);
    const [first, second] = track.start_frame <= other.start_frame ? [track, other] : [other, track];
    if (first.end_frame >= second.start_frame) throw fail('两条出场在时间上重叠，不能直接连接；请先拆分或删除', 422);
    mutateTrack(projectId, first.id, baseRevision, `连接出场候选 ${first.id} 与 ${second.id}`, () => {
      db.prepare('UPDATE tracks SET end_frame=?, end_us=?, updated_at=? WHERE id=?').run(second.end_frame, second.end_us, nowIso(), first.id);
      db.prepare('DELETE FROM bindings WHERE track_id=?').run(second.id);
      db.prepare("UPDATE tracks SET status='deleted', updated_at=? WHERE id=?").run(nowIso(), second.id);
      db.prepare("UPDATE tracks SET provenance='user',motion_ref=NULL WHERE id=?").run(first.id);
      const poseFile = id => path.join(observationsDir(projectId), 'poses', `${id}.json`);
      const frames = [first, second].flatMap(row => {
        if (!fs.existsSync(poseFile(row.id))) return [];
        return JSON.parse(fs.readFileSync(poseFile(row.id), 'utf8')).frames.filter(frame => frame.frame >= row.start_frame && frame.frame <= row.end_frame);
      }).sort((a, b) => a.frame - b.frame);
      if (frames.length) fs.writeFileSync(poseFile(first.id), JSON.stringify({trackId: first.id, shotId: first.shot_id, frames}));
    });
    return query.track.get(first.id, projectId);
  };

  const getTracks = projectId => query.tracks.all(projectId);

  // ---- 角色资产与归并 ----
  const assertCharacterInput = input => {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 40) throw fail('角色名称必须是 1–40 个字符', 400);
    const color = typeof input?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(input.color) ? input.color.toUpperCase() : null;
    if (!color) throw fail('角色颜色必须是 #RRGGBB', 400);
    const scale = input?.scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.2 || scale > 3) throw fail('角色身高比例必须是 0.2–3 之间的数字（米）', 400);
    return {name, color, scale, rigRef: String(input?.rigRef || '').slice(0, 200), allowSimultaneous: input?.allowSimultaneous === true};
  };

  const createCharacter = (projectId, input, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const fields = assertCharacterInput(input);
    const id = newId('c');
    tx(() => {
      const time = nowIso();
      db.prepare('INSERT INTO characters(id, project_id, revision, name, color, scale, rig_ref, allow_simultaneous, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, 'r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), fields.name, fields.color, fields.scale, fields.rigRef, fields.allowSimultaneous ? 1 : 0, time, time);
      bumpRevision(projectId, `创建角色资产「${fields.name}」`);
    });
    return query.character.get(id, projectId);
  };

  const updateCharacter = (projectId, characterId, input, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const character = query.character.get(characterId, projectId);
    if (!character) throw fail('角色不存在', 404);
    const merged = assertCharacterInput({
      name: input?.name ?? character.name, color: input?.color ?? character.color, scale: input?.scale ?? character.scale,
      rigRef: input?.rigRef ?? character.rig_ref, allowSimultaneous: input?.allowSimultaneous ?? !!character.allow_simultaneous,
    });
    tx(() => {
      db.prepare('UPDATE characters SET revision=?, name=?, color=?, scale=?, rig_ref=?, allow_simultaneous=?, updated_at=? WHERE id=?')
        .run('r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), merged.name, merged.color, merged.scale, merged.rigRef, merged.allowSimultaneous ? 1 : 0, nowIso(), characterId);
      if (Math.abs(merged.scale - character.scale) > 1e-9) db.prepare('UPDATE tracks SET motion_ref=NULL WHERE id IN (SELECT track_id FROM bindings WHERE character_id=?)').run(characterId);
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, '角色设置被修改');
      bumpRevision(projectId, `修改角色资产「${merged.name}」`);
    });
    return query.character.get(characterId, projectId);
  };

  const getCharacters = projectId => query.characters.all(projectId);

  // 归并绑定：disposition 'bound'（character_id 必填）或 'ignored'（character_id 为空）。
  const patchCast = (projectId, baseRevision, assignments, updatedBy) => {
    assertRevision(projectId, baseRevision);
    if (!Array.isArray(assignments) || assignments.length === 0) throw fail('assignments 必须是非空数组', 400);
    const characters = new Map(query.characters.all(projectId).map(row => [row.id, row]));
    const trackIds = new Set(query.tracks.all(projectId).filter(row => row.status === 'active').map(row => row.id));
    const updates = assignments.map(item => {
      if (!trackIds.has(item.trackId)) throw fail(`出场候选 ${item?.trackId} 不存在或已删除`, 404);
      const disposition = item.disposition;
      if (disposition === 'ignored') return {trackId: item.trackId, characterId: null, disposition, note: String(item?.note || '').slice(0, 200)};
      if (disposition === 'bound') {
        if (!characters.has(item.characterId)) throw fail('目标角色不存在', 404);
        return {trackId: item.trackId, characterId: item.characterId, disposition, note: String(item?.note || '').slice(0, 200)};
      }
      if (disposition === 'unassigned') return {trackId: item.trackId, characterId: null, disposition: 'unassigned', note: ''};
      throw fail('disposition 必须是 bound、ignored 或 unassigned', 400);
    });
    tx(() => {
      const statement = db.prepare(`INSERT INTO bindings(track_id, project_id, character_id, disposition, note, updated_by, updated_at) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(track_id) DO UPDATE SET character_id=excluded.character_id, disposition=excluded.disposition, note=excluded.note, updated_by=excluded.updated_by, updated_at=excluded.updated_at`);
      for (const item of updates) {
        const prior = query.bindings.all(projectId).find(binding => binding.track_id === item.trackId);
        if (prior?.character_id !== item.characterId || prior?.disposition !== item.disposition) db.prepare('UPDATE tracks SET motion_ref=NULL WHERE id=?').run(item.trackId);
        statement.run(item.trackId, projectId, item.characterId, item.disposition, item.note, String(updatedBy || 'user').slice(0, 60), nowIso());
        if (item.disposition !== 'unassigned') db.prepare('UPDATE source_people SET reviewed=1 WHERE id=(SELECT person_id FROM tracks WHERE id=?)').run(item.trackId);
      }
      if (query.approval.get(projectId)) invalidateApprovalLocked(projectId, '角色归并被修改');
      bumpRevision(projectId, `更新 ${updates.length} 条角色归并`);
    });
    return getCast(projectId);
  };

  // 冲突检查：同一镜头内时间重叠且绑定到同一角色的两条轨迹。
  const computeConflicts = (projectId, tracks = query.tracks.all(projectId), bindings = query.bindings.all(projectId), characters = query.characters.all(projectId)) => {
    const bindingByTrack = new Map(bindings.map(row => [row.track_id, row]));
    const allowSimultaneous = new Set(characters.filter(row => row.allow_simultaneous).map(row => row.id));
    const byShot = new Map();
    for (const track of tracks) {
      if (track.status !== 'active') continue;
      const binding = bindingByTrack.get(track.id);
      if (binding?.disposition !== 'bound' || !binding.character_id) continue;
      if (!byShot.has(track.shot_id)) byShot.set(track.shot_id, []);
      byShot.get(track.shot_id).push(track);
    }
    const conflicts = [];
    for (const [shotId, list] of byShot) {
      list.sort((a, b) => a.start_frame - b.start_frame);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.end_frame < b.start_frame) break;
        const bindingA = bindingByTrack.get(a.id), bindingB = bindingByTrack.get(b.id);
        if (bindingA.character_id !== bindingB.character_id) continue;
        if (allowSimultaneous.has(bindingA.character_id)) continue;
        conflicts.push({shotId, characterId: bindingA.character_id, trackA: a.id, trackB: b.id, overlapFrames: [b.start_frame, Math.min(a.end_frame, b.end_frame)]});
      }
    }
    return conflicts;
  };

  const getCast = projectId => {
    const tracks = query.tracks.all(projectId).filter(row => row.status === 'active');
    const bindings = query.bindings.all(projectId);
    const bindingByTrack = new Map(bindings.map(row => [row.track_id, row]));
    // 未处理候选：没有任何绑定，或被明确标为 unassigned —— 都会阻止正式确认。
    const pending = tracks.filter(track => {
      const binding = bindingByTrack.get(track.id);
      return !binding || binding.disposition === 'unassigned';
    }).map(track => track.id);
    return {
      characters: query.characters.all(projectId),
      bindings,
      pendingTrackIds: pending,
      conflicts: computeConflicts(projectId, tracks, bindings),
      invalidTrackIds: tracks.filter(track => {
        const shot = query.shots.all(projectId).find(row => row.id === track.shot_id);
        return !shot || track.start_frame < shot.start_frame || track.end_frame >= shot.end_frame_exclusive;
      }).map(track => track.id),
      approval: getApproval(projectId),
    };
  };

  // ---- 正式角色确认（冻结媒体、切镜、检测与映射版本）----
  const approveCast = (projectId, baseRevision, approvedBy) => {
    const project = assertRevision(projectId, baseRevision);
    if (!query.media.get(projectId)) throw fail('项目还没有导入媒体', 422);
    if (project.phase === 'draft') throw fail('素材尚未分析完成，不能确认角色映射', 422);
    const cast = getCast(projectId);
    if (cast.invalidTrackIds.length) throw fail(`有 ${cast.invalidTrackIds.length} 条出场越过当前镜头边界，请修正后再确认`, 422);
    if (cast.pendingTrackIds.length > 0) throw fail(`还有 ${cast.pendingTrackIds.length} 条有效出场候选未绑定或明确忽略，不能正式确认`, 422);
    if (cast.conflicts.length > 0) throw fail(`同一镜头存在 ${cast.conflicts.length} 处同一角色同框冲突；确有分身/镜像时请在角色上明确允许同框`, 422);
    const media = query.media.get(projectId);
    const shots = query.shots.all(projectId);
    const tracks = query.tracks.all(projectId);
    const detectorJobs = query.jobs.all(projectId).filter(row => row.kind === 'detect' && row.state === 'done');
    const detectorVersion = detectorJobs.length > 0
      ? (detectorJobs.find(row => row.algorithm_version)?.algorithm_version || 'unrecorded-legacy-detection')
      : (tracks.some(row => row.status === 'active' && row.provenance === 'auto') ? 'unrecorded-auto-tracks' : 'none');
    const frozen = {
      schemaVersion: SCHEMA_VERSION,
      media: {sha256: media.sha256, durationUs: media.duration_us, width: media.width, height: media.height, ptsCount: media.pts_count},
      shots: {count: shots.length, revision: stableHash(shots.map(shot => [shot.id, shot.start_frame, shot.end_frame_exclusive, shot.source]))},
      tracks: {activeCount: tracks.filter(row => row.status === 'active').length, revision: stableHash(tracks.map(row => [row.id, row.status, row.start_frame, row.end_frame, row.box, row.provenance]))},
      characters: {revision: stableHash(query.characters.all(projectId).map(row => [row.id, row.revision]))},
      bindings: {revision: stableHash(query.bindings.all(projectId).map(row => [row.track_id, row.character_id, row.disposition]))},
      sourcePeople: {revision: stableHash(operations.getPeople(projectId))},
      algorithmVersions: {...ALGORITHM_VERSIONS, detector: detectorVersion},
    };
    tx(() => {
      const revision = 'r-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      db.prepare(`INSERT INTO cast_approval(project_id, revision, status, approved_at, approved_by, frozen) VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision, status='approved', approved_at=excluded.approved_at, approved_by=excluded.approved_by, frozen=excluded.frozen`)
        .run(projectId, revision, 'approved', nowIso(), String(approvedBy || 'user').slice(0, 60), JSON.stringify(frozen));
      setPhase(projectId, 'cast_confirmed');
      bumpRevision(projectId, '正式确认角色映射；媒体、切镜、候选与归并版本已冻结');
    });
    return getCast(projectId);
  };

  const getApproval = projectId => {
    const row = query.approval.get(projectId);
    if (!row) return null;
    return {...row, frozen: JSON.parse(row.frozen)};
  };

  // 下游批准自动失效（计划 §7：上游改变时相关批准失效）。
  const invalidateApprovalLocked = (projectId, reason) => {
    const approval = query.approval.get(projectId);
    if (!approval || approval.status !== 'approved') return;
    db.prepare("UPDATE cast_approval SET status='invalidated' WHERE project_id=?").run(projectId);
    if (query.project.get(projectId).phase === 'cast_confirmed') setPhase(projectId, 'analyzed');
    appendHistory(projectId, query.project.get(projectId).revision, `角色确认已失效：${reason}，需重新确认`);
  };

  // ---- 任务 ----
  const createJob = (projectId, kind, {inputHash = '', algorithmVersion = ''} = {}) => {
    if (!query.project.get(projectId)) throw fail('项目不存在', 404);
    const id = newId('j');
    const time = nowIso();
    db.prepare('INSERT INTO jobs(id, project_id, kind, state, progress, input_hash, algorithm_version, error, output, cancel_requested, created_at, updated_at, heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, kind, 'queued', 0, inputHash, algorithmVersion, null, null, 0, time, time, time);
    return query.job.get(id);
  };
  const updateJob = (id, fields) => {
    const allowed = ['state', 'progress', 'error', 'output', 'cancel_requested', 'input_hash', 'algorithm_version'];
    const sets = [], values = [];
    for (const key of allowed) if (key in fields) {sets.push(`${key === 'cancel_requested' ? 'cancel_requested' : key}=?`);values.push(fields[key]);}
    if (sets.length === 0) return query.job.get(id);
    sets.push('updated_at=?', 'heartbeat_at=?');values.push(nowIso(), nowIso(), id);
    db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id=?`).run(...values);
    return query.job.get(id);
  };
  const getJob = id => query.job.get(id) || null;
  const listJobs = projectId => query.jobs.all(projectId);
  const requestCancel = (projectId, jobId) => {
    const job = query.job.get(jobId);
    if (!job || job.project_id !== projectId) throw fail('任务不存在', 404);
    if (job.state === 'queued') return updateJob(jobId, {state: 'cancelled'});
    if (job.state === 'running') return updateJob(jobId, {cancel_requested: 1});
    throw fail(`任务处于 ${job.state} 状态，不能取消`, 422);
  };
  const retryJob = (projectId, jobId, baseRevision) => {
    assertRevision(projectId, baseRevision, '项目版本已变化，请刷新后重试');
    const job = query.job.get(jobId);
    if (!job || job.project_id !== projectId) throw fail('任务不存在', 404);
    if (job.state !== 'failed' && job.state !== 'cancelled') throw fail(`任务处于 ${job.state} 状态，不能重试`, 422);
    return updateJob(jobId, {state: 'queued', progress: 0, error: null, cancel_requested: 0});
  };

  // ---- 相机轨迹（独立于可见场景；可静态或随时间变化）----
  const saveCameraTrack = (projectId, shotId, {source, intrinsics, extrinsics, confidence, medianErrorPx, evidence}) => {
    assertRevision(projectId, evidence?.baseRevision);
    const shot = db.prepare('SELECT * FROM shots WHERE project_id=? AND id=?').get(projectId, shotId);
    if (!shot) throw fail('镜头不存在', 404);
    if (!['landmark-pnp', 'person-estimate', 'manual'].includes(source)) throw fail('相机来源必须是 landmark-pnp、person-estimate 或 manual', 400);
    const storedError = Number.isFinite(medianErrorPx) ? medianErrorPx : -1; // person-estimate 无重投影误差，记 -1
    if (storedError < 0 && source !== 'person-estimate') throw fail('重投影误差无效', 400);
    const id = newId('cam');
    tx(() => {
      db.prepare('DELETE FROM camera_tracks WHERE project_id=? AND shot_id=? AND source=?').run(projectId, shotId, source);
      db.prepare('INSERT INTO camera_tracks(id, project_id, shot_id, source, intrinsics, extrinsics, confidence, median_error_px, evidence, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, projectId, shotId, source, JSON.stringify(intrinsics), JSON.stringify(extrinsics), Math.max(0, Math.min(1, confidence)), storedError, JSON.stringify(evidence || {}), nowIso());
      bumpRevision(projectId, `写入 ${shotId} 的相机估计（${source}，中位误差 ${storedError >= 0 ? storedError.toFixed(2) + ' px' : '不适用'}）`);
    });
    return query.cameraTrack(id);
  };
  const getCameraTracks = projectId => query.cameraTracks.all(projectId);
  const setMotionRef = (projectId, trackId, motionRef) => {
    db.prepare('UPDATE tracks SET motion_ref=? WHERE id=? AND project_id=?').run(motionRef, trackId, projectId);
  };

  const getHistory = projectId => query.history.all(projectId);
  const operations = projectOperations({db, root, tx, query, fail, newId, nowIso, assertRevision, bumpRevision, invalidateApprovalLocked, patchCast});

  return {
    db, fail, close: () => db.close(), projectDir, mediaDir, proxiesDir, observationsDir, previewsDir, exportsDir,
    createProject, listProjects, getProjectRow, assertRevision, ...operations,
    insertMedia, getMedia,
    replaceShots, getShots,
    insertTrack, insertTracks, deleteTrack, splitTrack, mergeTracks, getTracks,
    createCharacter, updateCharacter, getCharacters,
    patchCast, getCast, computeConflicts, approveCast, getApproval,
    createJob, updateJob, getJob, listJobs, requestCancel, retryJob,
    getHistory, loadPtsFor,
    saveCameraTrack, getCameraTracks, setMotionRef,
  };
}
