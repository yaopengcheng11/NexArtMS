import fs from 'node:fs';
import path from 'node:path';
import {fail, newId, ALGORITHM_VERSIONS, SCHEMA_VERSION} from './db.mjs';
import {DEFAULT_LIMITS, receiveUpload, probeMedia, hasFfmpeg, extractStill} from './media.mjs';
import {hasDetector, listDetectors} from './person.mjs';
import {loadModelRecord} from './vision.mjs';
import {solveCamera, estimateCameraFromPersonBox} from './camera.mjs';

export function createStudioRouter(store, root, {limits = DEFAULT_LIMITS, jobs} = {}) {
  const activeRequests = new Map();
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
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {res.writeHead(416, {'Content-Range': `bytes */${stat.size}`});return res.end();}
      res.writeHead(206, {...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`});
      fs.createReadStream(file, {start, end}).on('error', () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, {...headers, 'Content-Length': stat.size});
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
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

  const getProjectDetail = projectId => {
    const project = projectRow(projectId);
    const media = store.getMedia(projectId);
    const cast = store.getCast(projectId);
    return {
      project: {id: project.id, schemaVersion: project.schema_version, revision: project.revision, name: project.name, sceneMode: project.scene_mode, phase: project.phase, sceneStatus: project.scene_status, note: project.note, sourcePeopleCount: project.source_people_count, createdAt: project.created_at, updatedAt: project.updated_at},
      media: media ? mediaSummary(media) : null,
      shots: store.getShots(projectId).map(row => ({id: row.id, idx: row.idx, startFrame: row.start_frame, endFrameExclusive: row.end_frame_exclusive, startUs: row.start_us, endUs: row.end_us, source: row.source, revision: row.revision})),
      tracks: store.getTracks(projectId).map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame, startUs: row.start_us, endUs: row.end_us, box: JSON.parse(row.box), confidence: row.confidence, provenance: row.provenance, status: row.status})),
      characters: store.getCharacters(projectId).map(row => ({id: row.id, revision: row.revision, name: row.name, color: row.color, scale: row.scale, rigRef: row.rig_ref, allowSimultaneous: !!row.allow_simultaneous})),
      bindings: cast.bindings.map(row => ({trackId: row.track_id, characterId: row.character_id, disposition: row.disposition, note: row.note, updatedBy: row.updated_by, updatedAt: row.updated_at})),
      pendingTrackIds: cast.pendingTrackIds,
      invalidTrackIds: cast.invalidTrackIds,
      people: store.getPeople(projectId),
      conflicts: cast.conflicts,
      approval: cast.approval,
      jobs: store.listJobs(projectId).map(row => ({id: row.id, kind: row.kind, state: row.state, progress: row.progress, error: row.error, output: row.output, algorithmVersion: row.algorithm_version, createdAt: row.created_at, updatedAt: row.updated_at})),
      cameraTracks: store.getCameraTracks(projectId).map(row => ({id: row.id, shotId: row.shot_id, source: row.source, intrinsics: JSON.parse(row.intrinsics), extrinsics: JSON.parse(row.extrinsics), confidence: row.confidence, medianErrorPx: row.median_error_px >= 0 ? row.median_error_px : null, needsManualReview: row.median_error_px < 0 || row.median_error_px > 8 || row.source === 'person-estimate'})),
      motionRefs: Object.fromEntries(store.getTracks(projectId).filter(row => row.motion_ref).map(row => [row.id, row.motion_ref])),
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
      ffmpeg: await hasFfmpeg(),
      detectors: listDetectors(),
      detectorAvailable: hasDetector(),
      visionModel: (() => {
        const record = loadModelRecord(root);
        return record ? {name: record.detectorName, version: record.version, license: record.license, file: record.file, sha256: record.sha256} : null;
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
      if (activeRequests.get(id)) throw fail('项目正在上传、生成预览或读取文件，请稍后再删除', 409);
      return store.deleteProject(id, body?.baseRevision, body?.confirmName);
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
        jobs.enqueue(id, 'proxy');
        jobs.enqueue(id, 'pts');
        jobs.enqueue(id, 'cuts');
        return {media: mediaSummary(media)};
      } catch (cause) {
        fs.rm(received.temporary, {force: true}, () => {});
        if (movedPath && !committed) fs.rmSync(movedPath, {force: true});
        throw cause;
      }
    },
    'GET /api/studio/projects/:id/media/original': async (req, res, {id}) => {
      const media = requireMedia(id);
      serveFile(req, res, path.join(root, media.original_ref), 'video/mp4');
    },
    'GET /api/studio/projects/:id/media/preview': async (req, res, {id}) => {
      const media = requireMedia(id);
      const file = path.join(root, media.proxy_ref);
      if (!fs.existsSync(file)) return sendJson(res, 409, {error: '代理视频尚未生成，请等待代理任务完成'});
      serveFile(req, res, file, 'video/mp4');
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
      serveFile(req, res, file, 'image/jpeg');
    },
    'GET /api/studio/projects/:id/tracks/:trackId/preview': async (req, res, {id, trackId}) => {
      projectRow(id);
      const track = store.getTracks(id).find(item => item.id === trackId);
      if (!track) throw fail('出场候选不存在', 404);
      let file;
      try {file = await ensureTrackCrops(id, track);}
      catch (cause) {return sendJson(res, 409, {error: `轨迹截图生成失败：${cause.message}`});}
      serveFile(req, res, file, 'image/jpeg');
    },

    'POST /api/studio/projects/:id/analysis': async (req, res, {id}, body) => {
      projectRow(id);
      const kind = body?.kind;
      if (!['cuts', 'detect', 'people', 'motion', 'export'].includes(kind)) throw fail('未知分析任务类型', 400);
      requireMedia(id);
      const job = jobs.enqueue(id, kind);
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
      return {job: store.requestCancel(job.project_id, id)};
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
    'POST /api/studio/projects/:id/shots/:shotId/tracks': async (req, res, {id, shotId}, body) =>
      ({track: store.insertTrack(id, shotId, {startFrame: body?.startFrame, endFrame: body?.endFrame, box: body?.box, confidence: body?.confidence ?? 1, provenance: 'user'}, body?.baseRevision)}),
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
      serveFile(req, res, full, contentType);
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
      const requestProject = routePath.startsWith('/api/studio/projects/:id') ? params.id : null;
      const lease = requestProject && method !== 'DELETE';
      if (lease) activeRequests.set(requestProject, (activeRequests.get(requestProject) || 0) + 1);
      let released = false;
      const release = () => {if (lease && !released) {released = true;const count = (activeRequests.get(requestProject) || 1) - 1;if (count) activeRequests.set(requestProject, count);else activeRequests.delete(requestProject);}};
      try {
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
