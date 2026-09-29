import fs from 'node:fs';
import path from 'node:path';
import {fail, newId, ALGORITHM_VERSIONS, SCHEMA_VERSION} from './db.mjs';
import {DEFAULT_LIMITS, receiveUpload, probeMedia, hasFfmpeg, extractStill} from './media.mjs';
import {hasDetector, listDetectors} from './person.mjs';
import {loadModelRecord, loadDetRecord} from './vision.mjs';
import {solveCamera, estimateCameraFromPersonBox} from './camera.mjs';
import {draftQuality, readMotionArtifact} from './draft-quality.mjs';
import {matchesMotionContext} from './motion-validation.mjs';
import {createShotAnalysisStore} from './shot-analysis-store.mjs';
import {createModelSettings} from './model-settings.mjs';
import {createModelSettingsRouter, guardLocalStudioRequest} from './model-settings-router.mjs';

export function createStudioRouter(store, root, {limits = DEFAULT_LIMITS, jobs} = {}) {
  const analysisStore = jobs?.analysisStore || createShotAnalysisStore(store, root);
  const modelSettings = jobs?.modelSettings || createModelSettings(root);
  const modelSettingsRouter = createModelSettingsRouter(modelSettings, {beforeMutation: ({operation, profileId}) => {
    if (!['update', 'delete', 'updateProfile', 'deleteProfile'].includes(operation) || !profileId) return;
    const activeJobs = store.db.prepare("SELECT project_id,options FROM jobs WHERE state IN ('queued','running')").all();
    for (const job of activeJobs) {
      const runId = JSON.parse(job.options || '{}').analysisRunId;
      const run = runId ? analysisStore.getRun(job.project_id, runId) : null;
      if (run?.parameters?.modelSnapshot?.profileId === profileId) throw fail('此供应商正在执行拉片，请任务结束后再修改或删除；可以选择其他供应商用于新任务', 409);
    }
  }});
  const analysisModelOptions = () => {const status = modelSettings.status();return {provider: status.provider, model: status.model, parameters: {modelSnapshot: modelSettings.snapshot()}};};
  const activeRequests = new Map();
  const activeWrites = new Map();
  const deletingProjects = new Set();
  const fileStreams = new Map();
  const motionCache = new Map();
  const currentAlgorithms = () => {
    const detector = listDetectors()[0]; // runDetection 也选择第一个已注册检测器
    return {...ALGORITHM_VERSIONS, detector: detector ? `${detector.name}@${detector.version}` : 'none'};
  };
  const readJsonBody = req => new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {data += chunk;if (data.length > 2e6) {reject(fail('请求过大', 413));req.destroy();}});
    req.on('end', () => {try {const value=JSON.parse(data || '{}');if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();resolve(value);} catch {reject(fail('请求体不是有效 JSON 对象', 400));}});
    req.on('error', () => reject(fail('读取请求失败', 400)));
  });

  const sendJson = (res, status, value) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(value));
  };

  const serveFile = (req, res, file, contentType) => {
    let stat;
    try {stat = fs.statSync(file);} catch {return sendJson(res, 404, {error: '文件不存在（可能尚未生成，请先运行相应分析）'});}
    if (!stat.isFile()) return sendJson(res, 404, {error: '文件不存在'});
    const headers = {'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache'};
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const pipe = extra => new Promise(resolve => {
      const stream = fs.createReadStream(file, extra);
      const projectId = req.studioProjectId;
      const readers = fileStreams.get(projectId) || new Set();
      const reader = {stream, res};
      readers.add(reader);fileStreams.set(projectId, readers);
      stream.on('error', () => res.destroy());
      // 客户端中断（暂停/关闭视频）时销毁读取流，否则服务进程一直占用文件句柄，
      // Windows 上会导致项目目录无法改名/删除（EPERM）。
      const destroy = () => stream.destroy();
      res.on('close', destroy);
      stream.once('close', () => {
        res.off('close', destroy);readers.delete(reader);
        if (!readers.size) fileStreams.delete(projectId);
        resolve();
      });
      if (res.destroyed) stream.destroy();
      stream.pipe(res);
    });
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {res.writeHead(416, {'Content-Range': `bytes */${stat.size}`});return res.end();}
      res.writeHead(206, {...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`});
      return pipe({start, end});
    } else {
      res.writeHead(200, {...headers, 'Content-Length': stat.size});
      return pipe({});
    }
  };

  const requireMedia = projectId => {
    const media = store.getMedia(projectId);
    if (!media) throw fail('项目还没有导入媒体', 404);
    return media;
  };

  const projectRow = id => {
    const row = store.getProjectRow(id);
    if (!row) throw fail('项目不存在', 404);
    return row;
  };

  const mediaSummary = row => ({
    id: row.id, sha256: row.sha256, originalName: row.original_name, durationUs: row.duration_us,
    width: row.width, height: row.height, rotation: row.rotation, timebase: row.timebase,
    fps: row.fps_num / row.fps_den, vfr: !!row.vfr, videoCodec: row.video_codec, audioCodec: row.audio_codec,
    ptsCount: row.pts_count, sizeBytes: row.size_bytes,
  });

  const analysisFileUrl = (projectId, runId, relative) => `/api/studio/projects/${encodeURIComponent(projectId)}/shot-analysis/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(relative)}`;
  const publicAnalysis = value => value ? ({...value, shots: value.shots.map(shot => ({...shot, evidenceFrames: shot.evidenceFrames.map(frame => ({...frame, url: analysisFileUrl(value.projectId, value.id, frame.imageRef)}))}))}) : null;
  const analysisTaskKinds = new Set(['proxy', 'pts', 'cuts', 'shot_frames', 'shot_analyze', 'shot_validate', 'shot_report']);
  const requireAnalysisIdle = projectId => {
    if (store.listJobs(projectId).some(job => analysisTaskKinds.has(job.kind) && ['queued', 'running'].includes(job.state))) throw fail('拉片任务正在执行，请完成或取消后再发起新运行', 409);
  };
  const queueAnalysis = (projectId, runId, firstKind = 'shot_frames') => jobs.enqueue(projectId, firstKind, {auto: true, targetStage: 'shot_analysis', analysisRunId: runId});
  const requireRunRevision = (projectId, runId, revision) => {
    const run = analysisStore.getRun(projectId, runId);
    if (!run) throw fail('拉片记录不存在', 404);
    if (!revision || run.revision !== revision) throw fail('拉片版本已变化，请刷新后重试', 409);
    analysisStore.assertCurrent(projectId, runId);
    return run;
  };

  const getProjectDetail = projectId => {
    const project = projectRow(projectId);
    const media = store.getMedia(projectId);
    const cast = store.getCast(projectId);
    const tracks = store.getTracks(projectId), shots = store.getShots(projectId), cameraTracks = store.getCameraTracks(projectId), jobs = store.listJobs(projectId);
    const characters = store.getCharacters(projectId), people = store.getPeople(projectId);
    const ignoredTrackIds = people.filter(person => person.assignment === 'ignored').flatMap(person => person.trackIds);
    const motionRefs = {}, motionVersions = {}, motions = {}, artifactErrors = {};
    const bound = new Set(cast.bindings.filter(row => row.disposition === 'bound').map(row => row.track_id));
    for (const track of tracks.filter(row => row.status === 'active' && row.motion_ref && bound.has(row.id))) {
      try {
        const artifact = readMotionArtifact(root, track.motion_ref, motionCache);
        motions[track.id] = artifact.motion;
        const binding = cast.bindings.find(row => row.track_id === track.id);
        const character = characters.find(row => row.id === binding?.character_id);
        if (character && matchesMotionContext(artifact.motion, {trackId: track.id, shotId: track.shot_id, characterId: character.id, bodyHeight: character.scale})) {
          motionRefs[track.id] = track.motion_ref;
          motionVersions[track.id] = artifact.version;
        }
      } catch (cause) {artifactErrors[track.id] = cause.message;}
    }
    return {
      shotAnalysis: publicAnalysis(analysisStore.getRun(projectId)),
      workflowTarget: analysisStore.getRun(projectId) || jobs.some(job => {try {return JSON.parse(job.options || '{}').targetStage === 'shot_analysis';} catch {return false;}}) ? 'shot_analysis' : 'legacy',
      shotAnalysisProvider: modelSettings.status(),
      project: {id: project.id, schemaVersion: project.schema_version, revision: project.revision, name: project.name, sceneMode: project.scene_mode, phase: project.phase, sceneStatus: project.scene_status, note: project.note, sourcePeopleCount: project.source_people_count, createdAt: project.created_at, updatedAt: project.updated_at},
      media: media ? mediaSummary(media) : null,
      shots: store.getShots(projectId).map(row => ({id: row.id, idx: row.idx, startFrame: row.start_frame, endFrameExclusive: row.end_frame_exclusive, startUs: row.start_us, endUs: row.end_us, source: row.source, revision: row.revision})),
      tracks: store.getTracks(projectId).map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame, startUs: row.start_us, endUs: row.end_us, box: JSON.parse(row.box), confidence: row.confidence, provenance: row.provenance, status: row.status, subject: row.subject || 'person', species: row.species || null})),
      characters: store.getCharacters(projectId).map(row => ({id: row.id, revision: row.revision, name: row.name, color: row.color, scale: row.scale, rigRef: row.rig_ref, allowSimultaneous: !!row.allow_simultaneous, proxyLevel: row.proxy_level || 'CL1', rigFamily: row.rig_family || 'humanoid', provisional: !!row.provisional})),
      bindings: cast.bindings.map(row => ({trackId: row.track_id, characterId: row.character_id, disposition: row.disposition, note: row.note, updatedBy: row.updated_by, updatedAt: row.updated_at})),
      pendingTrackIds: cast.pendingTrackIds,
      invalidTrackIds: cast.invalidTrackIds,
      people,
      identitySuggestions: store.getEntitySuggestions(projectId),
      conflicts: cast.conflicts,
      approval: cast.approval,
      jobs: store.listJobs(projectId).map(row => ({id: row.id, kind: row.kind, state: row.state, progress: row.progress, error: row.error, output: row.output, algorithmVersion: row.algorithm_version, options: row.options, createdAt: row.created_at, updatedAt: row.updated_at})),
      draft: draftQuality({tracks, bindings: cast.bindings, characters, ignoredTrackIds, shots, cameraTracks, jobs, motions, artifactErrors}),
      cameraTracks: store.getCameraTracks(projectId).map(row => ({id: row.id, shotId: row.shot_id, source: row.source, intrinsics: JSON.parse(row.intrinsics), extrinsics: JSON.parse(row.extrinsics), confidence: row.confidence, medianErrorPx: row.median_error_px >= 0 ? row.median_error_px : null, needsManualReview: row.median_error_px < 0 || row.median_error_px > 8 || ['person-estimate', 'person-track-dolly'].includes(row.source)})),
      motionRefs,
      motionVersions,
      history: store.getHistory(projectId),
      algorithms: currentAlgorithms(),
      detectors: listDetectors(),
      detectorAvailable: hasDetector(),
    };
  };

  const ensureTrackCrops = (projectId, track) => {
    const file = path.join(store.previewsDir(projectId), 'tracks', `${track.id}-v3.jpg`);
    if (fs.existsSync(file)) return file;
    const media = requireMedia(projectId);
    const pts = store.loadPtsFor(media);
    const box = JSON.parse(track.box);
    const middle = track.representative_frame ?? track.end_frame;
    const timeS = pts[middle] ?? track.start_us / 1e6;
    const margin = 0.08;
    const padded = {x: Math.max(0, box.x - margin), y: Math.max(0, box.y - margin * 2), w: Math.min(1, box.w + margin * 2), h: Math.min(1, box.h + margin * 4)};
    return extractStill(path.join(root, media.original_ref), file, {timeS, cropBox: padded, width: 240});
  };

  const projectSummary = row => ({
    id: row.id, revision: row.revision, name: row.name, sceneMode: row.scene_mode, phase: row.phase,
    sceneStatus: row.scene_status, createdAt: row.created_at, updatedAt: row.updated_at,
    trackCount: row.track_count, shotCount: row.shot_count, personCount: store.getPeople(row.id).length,
  });

  const handlers = {
    'GET /api/studio/capabilities': async () => ({
      shotAnalysisProvider: modelSettings.status(),
      ffmpeg: await hasFfmpeg(),
      detectors: listDetectors(),
      detectorAvailable: hasDetector(),
      visionModel: (() => {
        const record = loadModelRecord(root);
        return record ? {name: record.detectorName, version: record.version, license: record.license, file: record.file, sha256: record.sha256} : null;
      })(),
      animalModel: (() => {
        const record = loadDetRecord(root);
        return record ? {name: record.detectorName, version: record.version, license: record.license, file: record.file, sizeBytes: record.sizeBytes, sha256: record.sha256} : null;
      })(),
      limits,
      algorithms: currentAlgorithms(),
      schemaVersion: SCHEMA_VERSION,
    }),
    'GET /api/studio/projects': async () => ({projects: store.listProjects().map(projectSummary)}),
    'POST /api/studio/projects': async (req, res, _params, body) => sendJson(res, 201, {project: projectSummary(store.createProject(body))}),
    'GET /api/studio/projects/:id': async (_req, res, {id}) => sendJson(res, 200, getProjectDetail(id)),
    'PATCH /api/studio/projects/:id': async (_req, _res, {id}, body) => ({project: projectSummary(store.updateProject(id, body, body?.baseRevision))}),
    'DELETE /api/studio/projects/:id': async (_req, _res, {id}, body) => {
      const project = store.assertRevision(id, body?.baseRevision);
      if (body?.confirmName !== project.name) throw fail('请输入完整项目名称确认删除', 400);
      if (deletingProjects.has(id)) throw fail('项目正在删除，请等待当前操作完成', 409);
      if (activeWrites.get(id)) throw fail('项目正在上传或修改，请完成后再删除', 409);
      if (store.listJobs(id).some(job => ['queued', 'running'].includes(job.state))) throw fail('项目有排队或运行中的任务，请等待任务结束或取消完成后再删除', 409);
      deletingProjects.add(id);
      try {
        const deadline = Date.now() + 5000;
        while (true) {
          // Stop only readers of this project. Existing thumbnail generation may finish,
          // but the request guard prevents new readers/writers while deletion is pending.
          for (const reader of fileStreams.get(id) || []) {reader.res.destroy();reader.stream.destroy();}
          if (!activeRequests.get(id)) {
            try {return store.deleteProject(id, body?.baseRevision, body?.confirmName);}
            catch (cause) {if (cause.code !== 'project_files_busy' || Date.now() >= deadline) throw cause;}
          } else if (Date.now() >= deadline) throw fail('项目预览仍在释放中，尚未删除任何数据，请稍后重试', 409);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      } finally {deletingProjects.delete(id);}
    },
    'PATCH /api/studio/projects/:id/people': async (_req, _res, {id}, body) => ({people: store.editPeople(id, body?.baseRevision, body)}),

    // 流式上传：不读入内存，绕过普通 JSON 通道的 2MB 限制；探测失败时清理临时文件。
    'POST /api/studio/projects/:id/media': async (req, res, {id}, _body, query) => {
      projectRow(id);
      store.assertRevision(id, query.get('baseRevision'));
      if (store.getMedia(id)) throw fail('项目已包含媒体，请新建项目上传', 409);
      const name = (query.get('name') || 'video.mp4').replaceAll('\\', '_').replaceAll('/', '_').slice(0, 160);
      if (!/\.(mp4|mov)$/i.test(name)) throw fail('文件名必须是 .mp4 或 .mov', 400);
      const received = await receiveUpload(req, path.join(store.mediaDir(id), 'incoming'), limits);
      let movedPath = null;
      let committed = false;
      try {
        const probe = await probeMedia(received.temporary, limits);
        const mediaId = newId('m');
        const finalName = `original-${mediaId}${path.extname(name).toLowerCase()}`;
        const finalPath = path.join(store.mediaDir(id), finalName);
        fs.renameSync(received.temporary, finalPath);
        movedPath = finalPath;
        const media = store.insertMedia(id, {
          id: mediaId, sha256: received.sha256, originalName: name,
          originalRef: `data/projects/${id}/media/${finalName}`.replaceAll('\\', '/'),
          proxyRef: `data/projects/${id}/proxies/${mediaId}-preview.mp4`.replaceAll('\\', '/'),
          durationUs: probe.durationUs, width: probe.width, height: probe.height, rotation: probe.rotation,
          timebase: probe.timebase, fpsNum: probe.fpsNum, fpsDen: probe.fpsDen, vfr: probe.vfr,
          videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, sizeBytes: received.sizeBytes,
          baseRevision: query.get('baseRevision') || '',
        });
        committed = true;
        const analysis = analysisStore.createRun(id, analysisModelOptions());
        queueAnalysis(id, analysis.id, 'proxy');
        return {media: mediaSummary(media), autoDraft: {started: true, targetStage: 'shot_analysis', analysisRunId: analysis.id, chain: ['proxy', 'pts', 'cuts', 'shot_frames', 'shot_analyze', 'shot_validate', 'shot_report']}};
      } catch (cause) {
        fs.rm(received.temporary, {force: true}, () => {});
        if (movedPath && !committed) fs.rmSync(movedPath, {force: true});
        throw cause;
      }
    },
    'GET /api/studio/projects/:id/media/original': async (req, res, {id}) => {
      const media = requireMedia(id);
      await serveFile(req, res, path.join(root, media.original_ref), 'video/mp4');
    },
    'GET /api/studio/projects/:id/media/pts': async (_req, _res, {id}) => {
      const media = requireMedia(id);
      const pts = store.loadPtsFor(media);
      return {ptsUs: pts.map(value => Math.round(value * 1e6)), ready: pts.length > 0};
    },
    'GET /api/studio/projects/:id/shot-analysis': async (_req, _res, {id}) => {
      projectRow(id);
      return {analysis: publicAnalysis(analysisStore.getRun(id)), provider: modelSettings.status()};
    },
    'POST /api/studio/projects/:id/shot-analysis': async (_req, _res, {id}, body) => {
      projectRow(id);
      store.assertRevision(id, body?.baseRevision);
      const media = requireMedia(id);
      requireAnalysisIdle(id);
      const current = analysisStore.getRun(id);
      // sourceRunId 缺省或指向当前运行时保持原行为；显式给历史运行 id 时允许从它续种已生成的语义。
      const source = body?.sourceRunId && body.sourceRunId !== current?.id ? analysisStore.getRun(id, body.sourceRunId) : current;
      if (body?.sourceRunId && !source) throw fail('来源拉片运行不存在', 404);
      if (body?.sourceRunId && (source?.id !== body.sourceRunId || source?.revision !== body.sourceRunRevision)) throw fail('拉片版本已变化，请刷新后再重试', 409);
      const candidate = source?.candidate && source.status !== 'stale' ? {shots: source.shots, candidate: true, sourceRunId: source.id} : {};
      const run = analysisStore.createRun(id, {...candidate, ...(body?.sourceRunId && source ? {sourceRunId: source.id} : {}), reuse: !body?.force, ...analysisModelOptions()});
      const firstKind = media.pts_count && store.getShots(id).length ? 'shot_frames' : 'proxy';
      const job = queueAnalysis(id, run.id, firstKind);
      return {analysis: publicAnalysis(run), job: {id: job.id, kind: job.kind, state: job.state}};
    },
    'PATCH /api/studio/projects/:id/shot-analysis/:runId/shots/:shotId': async (_req, _res, {id, runId, shotId}, body) => {
      projectRow(id);
      requireRunRevision(id, runId, body?.baseRevision);
      analysisStore.editShot(id, runId, shotId, {baseRevision: body.baseRevision, overrides: body?.overrides});
      await jobs?.refreshAnalysisReport?.(id, runId);
      return {analysis: publicAnalysis(analysisStore.getRun(id, runId))};
    },
    'POST /api/studio/projects/:id/shot-analysis/:runId/recut': async (_req, _res, {id, runId}, body) => {
      projectRow(id);
      requireAnalysisIdle(id);
      requireRunRevision(id, runId, body?.baseRevision);
      const media = requireMedia(id), pts = store.loadPtsFor(media);
      if (!pts.length) throw fail('原片 PTS 尚未生成', 422);
      const bounds = cutToBounds(body?.cutFrames, pts.length);
      const shots = bounds.map((bound, idx) => ({id: `S${String(idx + 1).padStart(2, '0')}`, ...bound, startUs: Math.round(pts[bound.startFrame] * 1e6), endUs: bound.endFrameExclusive < pts.length ? Math.round(pts[bound.endFrameExclusive] * 1e6) : media.duration_us}));
      const run = analysisStore.createRun(id, {shots, candidate: true, sourceRunId: runId, reuse: true, ...analysisModelOptions()});
      const job = queueAnalysis(id, run.id);
      return {analysis: publicAnalysis(run), job: {id: job.id, kind: job.kind, state: job.state}};
    },
    'POST /api/studio/projects/:id/shot-analysis/:runId/apply': async (_req, _res, {id, runId}, body) => {
      projectRow(id);
      requireAnalysisIdle(id);
      analysisStore.adoptRun(id, runId, body?.baseRevision);
      await jobs?.refreshAnalysisReport?.(id, runId);
      return {analysis: publicAnalysis(analysisStore.getRun(id, runId)), projectRevision: store.getProjectRow(id).revision};
    },
    'GET /api/studio/projects/:id/shot-analysis/:runId/file': async (req, res, {id, runId}, _body, query) => {
      projectRow(id);
      const run = analysisStore.getRun(id, runId);
      if (!run) throw fail('拉片记录不存在', 404);
      const relative = query.get('path') || 'report.json';
      if (!/^[a-z0-9][a-z0-9/._-]*$/i.test(relative) || relative.includes('..')) throw fail('文件路径无效', 400);
      if (run.status === 'stale' && !/\.(jpe?g|png)$/i.test(relative)) throw fail('历史拉片报告已过期，请重新运行后查看当前报告；旧证据仍保留', 409);
      const base = path.resolve(analysisStore.runDirectory(id, runId));
      const full = path.resolve(base, relative);
      if (!full.startsWith(base + path.sep)) throw fail('文件路径无效', 400);
      if (fs.existsSync(full) && !fs.realpathSync(full).startsWith(fs.realpathSync(base) + path.sep)) throw fail('文件路径无效', 400);
      const type = {'.jpg': 'image/jpeg', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8'}[path.extname(full).toLowerCase()];
      if (!type) throw fail('不支持的拉片产物类型', 400);
      await serveFile(req, res, full, type);
    },
    'GET /api/studio/projects/:id/media/preview': async (req, res, {id}) => {
      const media = requireMedia(id);
      const file = path.join(root, media.proxy_ref);
      if (!fs.existsSync(file)) return sendJson(res, 409, {error: '代理视频尚未生成，请等待代理任务完成'});
      await serveFile(req, res, file, 'video/mp4');
    },
    // 相机求解（M4）：地标 PnP（有足够证据）或人物框粗估（明确标为估计）。
    'POST /api/studio/projects/:id/shots/:shotId/camera': async (req, res, {id, shotId}, body) => {
      projectRow(id);
      const media = requireMedia(id);
      const shot = store.getShots(id).find(item => item.id === shotId);
      if (!shot) throw fail('镜头不存在', 404);
      const mode = body?.mode || 'landmarks';
      if (mode === 'landmarks') {
        const points = body?.points;
        if (!Array.isArray(points) || points.length < 6) throw fail('至少需要 6 个 3D–2D 地标对应（证据不足时请使用 person 模式或人工确认）', 422);
        const correspondences = points.map(point => ({X: point.X, x: point.x}));
        for (const c of correspondences) {
          if (!Array.isArray(c.X) || c.X.length !== 3 || !Array.isArray(c.x) || c.x.length !== 2 || [...c.X, ...c.x].some(value => !Number.isFinite(value))) throw fail('地标格式：{X:[x,y,z] 三维米制, x:[u,v] 画面像素}', 400);
        }
        const solution = solveCamera({correspondences});
        const track = store.saveCameraTrack(id, shotId, {
          source: 'landmark-pnp',
          intrinsics: {...solution.intrinsics, width: media.width, height: media.height},
          extrinsics: solution.extrinsics,
          confidence: solution.confidence,
          medianErrorPx: solution.medianErrorPx,
          evidence: {baseRevision: body?.baseRevision, pointCount: points.length, perPointErrors: solution.perPointErrors, algorithm: ALGORITHM_VERSIONS.camera},
        });
        return {camera: {id: track.id, shotId, source: track.source, intrinsics: JSON.parse(track.intrinsics), extrinsics: JSON.parse(track.extrinsics), medianErrorPx: track.median_error_px, confidence: track.confidence, needsManualReview: track.median_error_px > 8}};
      }
      if (mode === 'person') {
        const track = store.getTracks(id).find(item => item.id === body?.trackId && item.status === 'active');
        if (!track) throw fail('用于估计的出场候选不存在', 404);
        if (track.shot_id !== shotId) throw fail(`出场候选 ${track.id} 属于镜头 ${track.shot_id}，不能用于 ${shotId} 的相机估计`, 422);
        const estimate = estimateCameraFromPersonBox({box: JSON.parse(track.box), imageWidth: media.width, imageHeight: media.height, assumedHeight: body?.assumedHeight});
        const saved = store.saveCameraTrack(id, shotId, {
          source: 'person-estimate',
          intrinsics: estimate.intrinsics,
          extrinsics: {rotation: null, translation: null, note: `仅距离估计 ≈${estimate.distanceMeters}m（相机坐标系假设不同，不得与 PnP 外参混用）`},
          confidence: estimate.confidence,
          medianErrorPx: null, // 无地标，重投影误差不适用
          evidence: {baseRevision: body?.baseRevision, assumptions: estimate.assumptions, note: '单目人物框尺度耦合，仅为粗略距离估计，必须人工确认'},
        });
        return {camera: {id: saved.id, shotId, source: saved.source, distanceMeters: estimate.distanceMeters, assumptions: estimate.assumptions, confidence: estimate.confidence, needsManualReview: true, note: '证据不足的估计：无外参解，中位重投影误差不适用'}};
      }
      throw fail('mode 必须是 landmarks 或 person', 400);
    },

    // 视频原文说明
    'GET /api/studio/projects/:id/shots/:shotId/preview': async (req, res, {id, shotId}) => {
      projectRow(id);
      const shot = store.getShots(id).find(item => item.id === shotId);
      if (!shot) throw fail('镜头不存在', 404);
      const file = path.join(store.previewsDir(id), 'shots', `${shot.id}.jpg`);
      if (!fs.existsSync(file)) {
        const media = requireMedia(id);
        const pts = store.loadPtsFor(media);
        const middle = Math.floor((shot.start_frame + shot.end_frame_exclusive - 1) / 2);
        await extractStill(path.join(root, media.original_ref), file, {timeS: pts[middle] ?? shot.start_us / 1e6});
      }
      await serveFile(req, res, file, 'image/jpeg');
    },
    'GET /api/studio/projects/:id/tracks/:trackId/preview': async (req, res, {id, trackId}) => {
      projectRow(id);
      const track = store.getTracks(id).find(item => item.id === trackId);
      if (!track) throw fail('出场候选不存在', 404);
      let file;
      try {file = await ensureTrackCrops(id, track);}
      catch (cause) {return sendJson(res, 409, {error: `轨迹截图生成失败：${cause.message}`});}
      await serveFile(req, res, file, 'image/jpeg');
    },
    // 动作产物（三维确认视图用）：读取该出场的固定骨长动作 JSON。
    'GET /api/studio/projects/:id/tracks/:trackId/motion': async (_req, _res, {id, trackId}) => {
      projectRow(id);
      const track = store.getTracks(id).find(item => item.id === trackId && item.status === 'active');
      if (!track) throw fail('出场候选不存在', 404);
      if (!track.motion_ref) throw fail('该出场还没有动作产物；请先生成连续动作', 404);
      try {
        const artifact = readMotionArtifact(root, track.motion_ref, motionCache);
        const binding = store.getCast(id).bindings.find(row => row.track_id === track.id && row.disposition === 'bound');
        const character = store.getCharacters(id).find(row => row.id === binding?.character_id);
        if (!character || !matchesMotionContext(artifact.motion, {trackId: track.id, shotId: track.shot_id, characterId: character.id, bodyHeight: character.scale})) throw new Error('动作产物与当前出场配置不一致');
        return {motion: artifact.motion, motionVersion: artifact.version};
      } catch {throw fail('动作产物文件缺失、损坏或与当前出场配置不一致；请重新生成连续动作', 410);}
    },

    'POST /api/studio/projects/:id/analysis': async (req, res, {id}, body) => {
      projectRow(id);
      const kind = body?.kind;
      if (!['cuts', 'detect', 'people', 'camera', 'motion', 'export'].includes(kind)) throw fail('未知分析任务类型', 400);
      let subjects;
      if (kind === 'detect') {
        subjects = body?.subjects || 'person';
        if (!['person', 'animal', 'both'].includes(subjects)) throw fail('subjects 必须是 person、animal 或 both', 400);
      }
      requireMedia(id);
      const job = jobs.enqueue(id, kind, subjects ? {subjects} : {});
      return {job: {id: job.id, kind: job.kind, state: job.state}};
    },
    'GET /api/studio/jobs/:id': async (_req, res, {id}) => {
      const job = store.getJob(id);
      if (!job) throw fail('任务不存在', 404);
      return {job: {id: job.id, projectId: job.project_id, kind: job.kind, state: job.state, progress: job.progress, error: job.error, output: job.output, algorithmVersion: job.algorithm_version}};
    },
    'POST /api/studio/jobs/:id/cancel': async (_req, res, {id}) => {
      const job = store.getJob(id);
      if (!job) throw fail('任务不存在', 404);
      const result = store.requestCancel(job.project_id, id);
      const options = job.options ? JSON.parse(job.options) : {};
      if (options.analysisRunId) analysisStore.updateRun(job.project_id, options.analysisRunId, {status: 'cancelled', error: '任务已被取消'});
      return {job: result};
    },
    'POST /api/studio/jobs/:id/retry': async (req, res, {id}, body) => {
      const job = store.getJob(id);
      if (!job) throw fail('任务不存在', 404);
      return {job: jobs.retry(job.project_id, id, body?.baseRevision)};
    },

    // 人工改切点：以完整切点列表替换（呈现帧序号，0 与总帧数不需要给出）。
    'PATCH /api/studio/projects/:id/shots': async (req, res, {id}, body) => {
      projectRow(id);
      const media = requireMedia(id);
      const pts = store.loadPtsFor(media);
      if (pts.length === 0) throw fail('PTS 映射尚未生成，无法按源呈现帧定义切点', 422);
      const cutFrames = body?.cutFrames;
      if (!Array.isArray(cutFrames) || cutFrames.some(frame => !Number.isInteger(frame))) throw fail('cutFrames 必须是整数帧序号数组', 400);
      const bounds = cutToBounds(cutFrames, pts.length);
      const shots = bounds.map((bound, idx) => ({
        id: `S${String(idx + 1).padStart(2, '0')}`,
        startFrame: bound.startFrame, endFrameExclusive: bound.endFrameExclusive,
        startUs: Math.round(pts[bound.startFrame] * 1e6),
        endUs: bound.endFrameExclusive < pts.length ? Math.round(pts[bound.endFrameExclusive] * 1e6) : media.duration_us,
      }));
      const saved = store.replaceShots(id, shots, 'user', body?.baseRevision);
      return {shots: saved.map(row => ({id: row.id, idx: row.idx, startFrame: row.start_frame, endFrameExclusive: row.end_frame_exclusive, startUs: row.start_us, endUs: row.end_us, source: row.source}))};
    },

    // 人工补标出场候选。
    'POST /api/studio/projects/:id/shots/:shotId/tracks': async (req, res, {id, shotId}, body) => {
      const subject = body?.subject ?? 'person';
      if (!['person', 'animal'].includes(subject)) throw fail('subject 必须为 person 或 animal', 400);
      if (body?.species !== undefined && body.species !== null && (typeof body.species !== 'string' || body.species.trim().length === 0 || body.species.length > 40)) throw fail('species 必须为 1–40 字的文本', 400);
      return {track: store.insertTrack(id, shotId, {startFrame: body?.startFrame, endFrame: body?.endFrame, box: body?.box, confidence: body?.confidence ?? 1, provenance: 'user', subject, species: body?.species}, body?.baseRevision)};
    },
    'POST /api/studio/projects/:id/tracks/:trackId/split': async (req, res, {id, trackId}, body) =>
      ({track: store.splitTrack(id, trackId, body?.splitFrame, body?.baseRevision)}),
    'POST /api/studio/projects/:id/tracks/:trackId/merge': async (req, res, {id, trackId}, body) =>
      ({track: store.mergeTracks(id, trackId, body?.otherTrackId, body?.baseRevision)}),
    'POST /api/studio/projects/:id/tracks/:trackId/delete': async (req, res, {id, trackId}, body) =>
      ({track: store.deleteTrack(id, trackId, body?.baseRevision)}),

    // 角色归并。
    'GET /api/studio/projects/:id/cast': async (_req, res, {id}) => {
      projectRow(id);
      return store.getCast(id);
    },
    'POST /api/studio/projects/:id/characters': async (req, res, {id}, body) =>
      ({character: store.createCharacter(id, body, body?.baseRevision)}),
    'PATCH /api/studio/projects/:id/characters/:cid': async (req, res, {id, cid}, body) =>
      ({character: store.updateCharacter(id, cid, body, body?.baseRevision)}),
    'PATCH /api/studio/projects/:id/cast': async (req, res, {id}, body) =>
      ({cast: store.patchCast(id, body?.baseRevision, body?.assignments, body?.updatedBy)}),
    'POST /api/studio/projects/:id/approve-cast': async (req, res, {id}, body) => {
      projectRow(id);
      return {cast: store.approveCast(id, body?.baseRevision, body?.approvedBy)};
    },

    // 导出包（M6）：列表与受控下载。
    'GET /api/studio/projects/:id/exports': async (_req, res, {id}) => {
      projectRow(id);
      const dir = store.exportsDir(id);
      const list = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => fs.statSync(path.join(dir, name)).isDirectory()).flatMap(name => {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(dir, name, 'manifest.json'), 'utf8'));
          return [{exportId: name, generatedAt: manifest.generatedAt, instanceCount: manifest.instanceCount, characterGlbs: (manifest.characterGlbs || []).filter(entry => entry.file), included: manifest.included, notIncluded: manifest.notIncluded}];
        } catch {return [{exportId: name, broken: true}];}
      }) : [];
      return {exports: list};
    },
    'GET /api/studio/projects/:id/exports/:exportId/file': async (req, res, {id, exportId}, _body, query) => {
      projectRow(id);
      if (!/^[a-z0-9-]+$/.test(exportId)) throw fail('导出包 ID 无效', 400);
      const relative = query.get('path') || 'manifest.json';
      if (!/^[a-z0-9][a-z0-9/._-]*$/i.test(relative) || relative.includes('..')) throw fail('文件路径无效', 400);
      const base = path.join(store.exportsDir(id), exportId);
      const full = path.join(base, relative);
      if (!full.startsWith(base)) throw fail('文件路径无效', 400);
      const contentType = relative.endsWith('.json') ? 'application/json' : relative.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream';
      await serveFile(req, res, full, contentType);
    },
  };

  const cutToBounds = (cutFrames, frameCount) => {
    if (!Array.isArray(cutFrames)) throw fail('cutFrames 必须是数组', 400);
    const unique = [...new Set(cutFrames)];
    // 越界/非法切点如实拒绝，不静默丢弃
    for (const frame of unique) {
      if (!Number.isInteger(frame) || frame <= 0 || frame >= frameCount) throw fail(`切点必须是 1 到 ${frameCount - 1} 之间的整数帧，收到 ${JSON.stringify(frame)}`, 400);
    }
    const sorted = unique.sort((a, b) => a - b);
    const bounds = [];
    let start = 0;
    for (const cut of sorted) {bounds.push({startFrame: start, endFrameExclusive: cut});start = cut;}
    if (start < frameCount) bounds.push({startFrame: start, endFrameExclusive: frameCount});
    return bounds;
  };

  return async function handle(req, res) {
    if (await modelSettingsRouter(req, res)) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || url.pathname;
    const method = req.method || 'GET';
    for (const [route, handler] of Object.entries(handlers)) {
      const [routeMethod, routePath] = route.split(' ');
      if (routeMethod !== method) continue;
      const pattern = routePath.split('/').filter(Boolean);
      const actual = pathname.split('/').filter(Boolean);
      if (pattern.length !== actual.length) continue;
      const params = {};
      let matched = true;
      for (let index = 0; index < pattern.length; index++) {
        if (pattern[index].startsWith(':')) params[pattern[index].slice(1)] = decodeURIComponent(actual[index]);
        else if (pattern[index] !== actual[index]) {matched = false;break;}
      }
      if (!matched) continue;
      const requestProject = routePath.startsWith('/api/studio/projects/:id') ? params.id : routePath.startsWith('/api/studio/jobs/:id') ? store.getJob(params.id)?.project_id : null;
      req.studioProjectId = requestProject;
      const lease = requestProject && method !== 'DELETE';
      const writeLease = lease && !['GET', 'HEAD'].includes(method);
      if (lease) activeRequests.set(requestProject, (activeRequests.get(requestProject) || 0) + 1);
      if (writeLease) activeWrites.set(requestProject, (activeWrites.get(requestProject) || 0) + 1);
      let released = false;
      const release = () => {if (lease && !released) {released = true;const count = (activeRequests.get(requestProject) || 1) - 1;if (count) activeRequests.set(requestProject, count);else activeRequests.delete(requestProject);if (writeLease) {const writes = (activeWrites.get(requestProject) || 1) - 1;if (writes) activeWrites.set(requestProject, writes);else activeWrites.delete(requestProject);}}};
      try {
        // Upload and job/retry endpoints can dispatch paid visual requests too.
        // Apply the same local-origin boundary before reading their request body.
        if (!['GET', 'HEAD'].includes(method)) guardLocalStudioRequest(req);
        if (requestProject && deletingProjects.has(requestProject)) throw fail('项目正在删除，暂时无法读取或修改', 409);
        const streamsBody = route === 'POST /api/studio/projects/:id/media'; // 上传路由需要原始字节流
        const body = method === 'GET' || streamsBody ? undefined : await readJsonBody(req); // JSON 解析失败如实返回 400，不吞成空对象
        if (requestProject && method !== 'GET' && store.listJobs(requestProject).some(job => job.kind === 'export' && ['queued', 'running'].includes(job.state))) throw fail('正在导出项目，请等待导出完成后再修改', 409);
        const result = await handler(req, res, params, body, url.searchParams);
        if (result !== undefined) sendJson(res, 200, result);
      } catch (cause) {
        if (!res.writableEnded) sendJson(res, cause?.status || 500, {error: cause?.message || String(cause)});
      } finally {
        if (res.writableEnded || res.destroyed) release();
        else {res.once('finish', release);res.once('close', release);}
      }
      return true;
    }
    return false;
  };
}
