import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fail, newId, stableHash, ALGORITHM_VERSIONS} from './db.mjs';
import {buildProxy, extractPtsMap, extractSignatures, extractStill} from './media.mjs';
import {fitPersonDolly, dollyCameraSamples} from './camera.mjs';
import {computeScores, detectCutsFromScores, cutsToShotBounds} from './cuts.mjs';
import {runDetection, trackDetections, trackObservation} from './person.mjs';
import {frameStream} from './vision.mjs';
import {appearanceDescriptor, aggregateAppearance, PEOPLE_ALGORITHM} from './people.mjs';
import {draftQuality, readMotionArtifact} from './draft-quality.mjs';
import {createShotAnalysisStore} from './shot-analysis-store.mjs';
import {createShotAnalysisEngine, SEMANTIC_UNAVAILABLE_CODES} from './shot-analysis.mjs';
import {createModelSettings} from './model-settings.mjs';

// 多数票：className 出现次数最多者；空输入返回 null。
const majorityName = names => {
  if (!names.length) return null;
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
};
import {buildMotion} from './pose3d.mjs';

// 任务运行器：同项目内 FIFO 串行（SQLite 单写入 + 限制同项目并发编辑）。
// 支持：进度、协作式取消、失败记录、重试；服务重启后的 queued/running 任务由
// store 初始化时如实标记为失败。分析任务在入队时锁定项目版本；期间若用户修改
// 了项目，任务如实失败而不是覆盖人工决策。
export function createJobRunner(store, root, limits, analysisOptions = {}) {
  const analysisStore = analysisOptions.analysisStore || createShotAnalysisStore(store, root);
  const modelSettings = analysisOptions.modelSettings || createModelSettings(root);
  const analysisEngine = createShotAnalysisEngine({store, analysisStore, root, provider: analysisOptions.provider,
    ...(analysisOptions.provider ? {} : {providerResolver: async (projectId, runId) => {
      let run = analysisStore.getRun(projectId, runId);
      if (!run.parameters?.modelSnapshot) {
        run = analysisStore.updateRun(projectId, runId, {parameters: {...run.parameters, modelSnapshot: modelSettings.snapshot()}});
      }
      return modelSettings.providerFor(run.parameters.modelSnapshot);
    }})});
  const chain = new Map(); // projectId → Promise
  const scheduled = new Map(); // jobId → generation; a cancelled queued callback cannot steal a retry
  const resolveRef = ref => path.join(root, ref);
  const toRef = absolute => path.relative(root, absolute).replaceAll('\\', '/');

  const cancelled = jobId => store.getJob(jobId)?.cancel_requested === 1;
  const step = (job, progress, note = '') => {
    if (cancelled(job.id)) throw fail('任务已被取消', 409);
    const fields = {progress};
    if (note) fields.output = note;
    store.updateJob(job.id, fields);
  };

  const runJob = async (job, baseRevision) => {
    const projectId = job.project_id;
    const jobOptions = job.options ? JSON.parse(job.options) : {};
    const media = store.getMedia(projectId);
    if (!media) throw fail('项目还没有导入媒体', 422);
    const originalPath = resolveRef(media.original_ref);
    const proxyPath = resolveRef(media.proxy_ref);

    if (jobOptions.analysisRunId) {
      analysisStore.assertCurrent(projectId, jobOptions.analysisRunId);
      analysisStore.updateRun(projectId, jobOptions.analysisRunId, {status: 'processing', stage: job.kind.replace(/^shot_/, ''), error: null});
    }
    const analysisStage = {shot_frames: 'frames', shot_analyze: 'analyze', shot_validate: 'validate', shot_report: 'report'}[job.kind];
    if (analysisStage) {
      if (!jobOptions.analysisRunId) throw fail('拉片任务缺少运行记录', 422);
      // A blocked/partially failed analysis still gets a report; preserve that result state.
      if (['shot_validate', 'shot_report'].includes(job.kind) && jobOptions.resultStatus) {
        analysisStore.updateRun(projectId, jobOptions.analysisRunId, {status: jobOptions.resultStatus, error: jobOptions.resultError || null});
      }
      const result = await analysisEngine[analysisStage](projectId, jobOptions.analysisRunId, {
        onProgress: (fraction, note) => step(job, fraction, note || ''),
        isCancelled: () => cancelled(job.id),
      });
      step(job, 1, result?.error || (result?.status === 'blocked' ? '关键帧底稿已生成，等待配置视觉模型' : `拉片${analysisStage === 'report' ? '报告' : '阶段'}已保存`));
      return;
    }

    if (job.kind === 'people') {
      const tracks = store.getTracks(projectId).filter(track => track.status === 'active' && track.subject !== 'animal');
      if (!tracks.length) {
        // Empty footage and animal-only footage are valid inputs to the whole-film draft.
        store.assertRevision(projectId, baseRevision);
        const autoOptions = job.options ? JSON.parse(job.options) : {};
        if (autoOptions.auto) store.ensureProvisionalGroups(projectId, store.getProjectRow(projectId).revision);
        const animals = store.getPeople(projectId).filter(person => person.subject === 'animal').length;
        store.updateJob(job.id, {progress: 1, algorithm_version: PEOPLE_ALGORITHM, output: `0 个人物候选、${animals} 个动物候选；保留空镜与动物候选，继续生成全片初稿`});
        return;
      }
      const byFrame = new Map();
      for (const track of tracks) {
        const frame = track.representative_frame ?? track.end_frame;
        if (!byFrame.has(frame)) byFrame.set(frame, []);
        byFrame.get(frame).push(track);
      }
      const descriptors = new Map();
      const size = 160, scale = Math.min(size / media.width, size / media.height);
      await frameStream(originalPath, {width: size, height: size, onFrame: async (rgb, frame) => {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        for (const track of byFrame.get(frame) || []) {
          const box = JSON.parse(track.box);
          descriptors.set(track.id, appearanceDescriptor(rgb, size, size, {
            x: ((size - media.width * scale) / 2 + box.x * media.width * scale) / size,
            y: ((size - media.height * scale) / 2 + box.y * media.height * scale) / size,
            w: box.w * media.width * scale / size, h: box.h * media.height * scale / size}));
        }
        if (frame % 60 === 0) step(job, Math.min(0.95, frame / Math.max(1, media.pts_count)), '提取外观线索，汇总人物候选…');
      }});
      const people = store.summarizePeople(projectId, baseRevision, descriptors);
      const personCount = people.filter(person => person.subject !== 'animal').length;
      const animalCount = people.filter(person => person.subject === 'animal').length;
      let groups = [];
      const autoOptions = job.options ? JSON.parse(job.options) : {};
      if (autoOptions.auto) groups = store.ensureProvisionalGroups(projectId, store.getProjectRow(projectId).revision);
      store.updateJob(job.id, {progress: 1, algorithm_version: PEOPLE_ALGORITHM, output: `${personCount} 个人物候选、${animalCount} 个动物候选${groups.length ? `；自动建立 ${groups.length} 个临时叙事组（默认 CL1，可改）` : '；外观相似建议需人工核对，已有分组已保留。'}`});
      return;
    }

    if (job.kind === 'proxy') {
      step(job, 0.02, '转码代理视频…');
      await buildProxy(originalPath, proxyPath, fraction => store.updateJob(job.id, {progress: 0.02 + fraction * 0.9}), media.duration_us);
      store.updateJob(job.id, {progress: 0.95, output: '校验代理时长…'});
      const proxyProbe = await import('./media.mjs').then(module => module.probeMedia(proxyPath, limits));
      if (Math.abs(proxyProbe.durationUs - media.duration_us) > 500000) throw fail(`代理时长 ${proxyProbe.durationUs}µs 与原片 ${media.duration_us}µs 相差超过 0.5 秒`, 500);
      store.updateJob(job.id, {progress: 1});
      return;
    }
    if (job.kind === 'pts') {
      step(job, 0.1, '逐帧读取源时间戳（PTS）…');
      const {file, pts} = await extractPtsMap(originalPath, store.observationsDir(projectId), media.id);
      store.db.prepare('UPDATE media SET pts_map_ref=?, pts_count=? WHERE id=?').run(toRef(file), pts.length, media.id);
      store.updateJob(job.id, {progress: 1, output: `${pts.length} 个呈现帧的时间戳`});
      return;
    }
    if (job.kind === 'cuts') {
      if (!store.getMedia(projectId).pts_count) throw fail('PTS 映射尚未生成，无法按源呈现帧切镜', 422);
      const existingSnapshot = jobOptions.analysisRunId ? analysisStore.getRun(projectId, jobOptions.analysisRunId)?.shots : null;
      let shots = existingSnapshot?.length ? existingSnapshot : null;
      // A retry after thumbnail failure keeps the initialized, version-checked boundaries.
      if (!shots) {
      step(job, 0.05, '提取帧签名…');
      const signatures = await extractSignatures(proxyPath);
      step(job, 0.5, '计算切镜得分…');
      const scores = computeScores(signatures);
      const cutFrames = detectCutsFromScores(scores);
      step(job, 0.7, `写入 ${cutFrames.length + 1} 个镜头候选…`);
      const pts = store.loadPtsFor(store.getMedia(projectId));
      const bounds = cutsToShotBounds(cutFrames, pts.length);
      shots = bounds.map((bound, idx) => ({
        id: `S${String(idx + 1).padStart(2, '0')}`,
        startFrame: bound.startFrame,
        endFrameExclusive: bound.endFrameExclusive,
        startUs: Math.round(pts[bound.startFrame] * 1e6),
        endUs: bound.endFrameExclusive < pts.length ? Math.round(pts[bound.endFrameExclusive] * 1e6) : store.getMedia(projectId).duration_us,
      }));
      store.replaceShots(projectId, shots, 'auto', baseRevision);
      if (jobOptions.analysisRunId) analysisStore.setShots(projectId, jobOptions.analysisRunId, shots);
      }
      step(job, 0.85, '生成镜头缩略图…');
      const pts = store.loadPtsFor(store.getMedia(projectId));
      let index = 0;
      for (const shot of store.getShots(projectId)) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        const middle = Math.floor((shot.start_frame + shot.end_frame_exclusive - 1) / 2);
        await extractStill(originalPath, path.join(store.previewsDir(projectId), 'shots', `${shot.id}.jpg`), {timeS: pts[middle] ?? shot.start_us / 1e6});
        store.updateJob(job.id, {progress: 0.85 + 0.14 * (++index / Math.max(1, shots.length))});
      }
      store.updateJob(job.id, {progress: 1, output: `${shots.length} 镜 · 自动切点 ${Math.max(0, shots.length - 1)} 个（算法 ${ALGORITHM_VERSIONS.cuts}）`});
      return;
    }
    if (job.kind === 'detect') {
      const jobOptions = job.options ? JSON.parse(job.options) : {};
      const subjects = jobOptions.subjects || 'person'; // 'person' | 'animal' | 'both'
      const subjectLabel = subjects === 'person' ? '人物' : subjects === 'animal' ? '动物' : '人物+动物';
      if (store.getShots(projectId).length === 0) throw fail('切镜结果尚未生成，无法按镜头检测', 422);
      step(job, 0.05, `运行${subjectLabel}检测…`);
      const media2 = store.getMedia(projectId);
      const stride = media2.pts_count > 0 ? Math.max(1, Math.round((media2.pts_count / (media2.duration_us / 1e6)) / 10)) : 2; // 约 10 fps 采样
      let runSubjects = subjects;
      let degraded = '';
      let detectionResult;
      try {
        detectionResult = await runDetection({
          videoPath: originalPath, proxyPath, projectId, job, subjects: runSubjects,
          sourceWidth: media2.width, sourceHeight: media2.height, frameCount: media2.pts_count, stride,
          onProgress: fraction => {if (fraction !== undefined) store.updateJob(job.id, {progress: 0.05 + fraction * 0.55});},
          isCancelled: () => cancelled(job.id),
        });
      } catch (cause) {
        // 可降级分支：动物模型缺失时回退人物检测；技术失败如实标注，不冒充"没有动物"
        if (runSubjects === 'both' && /动物检测模型未安装/.test(String(cause?.message))) {
          runSubjects = 'person';
          degraded = '（降级：动物检测模型未安装，仅完成人物检测）';
          detectionResult = await runDetection({
            videoPath: originalPath, proxyPath, projectId, job, subjects: runSubjects,
            sourceWidth: media2.width, sourceHeight: media2.height, frameCount: media2.pts_count, stride,
            onProgress: fraction => {if (fraction !== undefined) store.updateJob(job.id, {progress: 0.05 + fraction * 0.55});},
            isCancelled: () => cancelled(job.id),
          });
        } else throw cause;
      }
      const {detector, detectorVersion, detections} = detectionResult;
      step(job, 0.62, `镜内跟踪 ${detections.length} 个逐帧检测框…`);
      const shots = store.getShots(projectId);
      fs.mkdirSync(path.join(store.observationsDir(projectId), 'poses'), {recursive: true});
      const pts = store.loadPtsFor(media2);
      const specs = [];       // insertTracks 的批量规格（保持顺序对应 poseFrames）
      const poseFrames = [];  // 每条轨迹的关键点观测
      const personDetections = detections.filter(detection => detection.subject === 'person');
      const animalDetections = detections.filter(detection => detection.subject === 'animal');
      for (const shot of shots) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        for (const [groupDetections, subject] of [[personDetections, 'person'], [animalDetections, 'animal']]) {
          const inShot = groupDetections.filter(detection => detection.frame >= shot.start_frame && detection.frame < shot.end_frame_exclusive);
          if (inShot.length === 0) continue;
          for (const track of trackDetections(inShot, {maxGapFrames: stride * 2 - 1})) {
            const startFrame = Math.max(track.startFrame, shot.start_frame);
            const endFrame = Math.min(track.endFrame, shot.end_frame_exclusive - 1);
            // 物种多数票：单帧分类可能抖动，按整条轨迹的多数 className 定物种（V2 §7.2）
            const species = subject === 'animal' ? majorityName(track.observations.map(o => o.className).filter(Boolean)) : null;
            // 多帧外观聚合（V2 §7.2）：逐桶中位数，拒绝单帧噪声
            const appearance = aggregateAppearance(track.observations);
            specs.push({shotId: shot.id, startFrame, endFrame, box: track.box, confidence: track.confidence, provenance: 'auto',
              subject, ...(species ? {species} : {}),
              ...(subject === 'person' ? {appearance, representativeFrame: track.representativeFrame} : {appearance})});
            const frames = subject === 'person' ? track.observations.filter(observation => observation.keypoints).map(observation => ({
              frame: observation.frame, timeS: pts[observation.frame], box: observation.box, keypoints: observation.keypoints,
            })) : [];
            poseFrames.push(frames);
          }
        }
      }
      const successfulSubjects = runSubjects === 'both' ? ['person', 'animal'] : [runSubjects];
      const created = store.insertTracks(projectId, specs, baseRevision, successfulSubjects);
      if (successfulSubjects.includes('person')) store.summarizePeople(projectId, store.getProjectRow(projectId).revision);
      if (successfulSubjects.includes('animal')) store.summarizeAnimalEntities(projectId, store.getProjectRow(projectId).revision);
      created.forEach((track, index) => {
        if (poseFrames[index]?.length > 0) {
          fs.writeFileSync(path.join(store.observationsDir(projectId), 'poses', `${track.id}.json`),
            JSON.stringify({trackId: track.id, shotId: track.shot_id, detector, detectorVersion, tracker: ALGORITHM_VERSIONS.tracker, coordinateSpace: 'normalized-0-1', joints: 'COCO-17', frames: poseFrames[index]}, null, 1));
        }
      });
      fs.mkdirSync(path.join(store.observationsDir(projectId), 'tracks'), {recursive: true});
      fs.writeFileSync(path.join(store.observationsDir(projectId), 'tracks', `${job.id}.json`),
        JSON.stringify(trackObservation({shotId: '*', provenance: 'auto', detector, detectorVersion, note: `逐帧框 ${detections.length} 个 → 镜内轨迹 ${created.length} 条（采样步长 ${stride}）`}), null, 2));
      store.updateJob(job.id, {progress: 1, algorithm_version: `${detector}@${detectorVersion}`, output: `检测器 ${detector}@${detectorVersion}（${subjectLabel}）：镜内轨迹 ${created.length} 条（采样步长 ${stride}）${degraded}`});
      return;
    }
    if (job.kind === 'camera') {
      // P6-e：人物尺度运镜估计。有地标解的镜头跳过（不覆盖真实求解）。
      step(job, 0.05, '拟合人物尺度运镜…');
      const shots = store.getShots(projectId);
      const media2 = store.getMedia(projectId);
      const tracks = store.getTracks(projectId).filter(track => track.status === 'active' && track.subject !== 'animal' && track.motion_ref);
      const cameras = store.getCameraTracks(projectId);
      let written = 0;
      for (const shot of shots) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        if (cameras.some(camera => camera.shot_id === shot.id && camera.source === 'landmark-pnp')) continue;
        let chosen = null;
        for (const track of tracks.filter(track => track.shot_id === shot.id)) {
          const candidate = path.join(store.observationsDir(projectId), 'poses', `${track.id}.json`);
          if (!fs.existsSync(candidate)) continue;
          const pose = JSON.parse(fs.readFileSync(candidate, 'utf8'));
          const frames = pose.frames.filter(frame => frame && frame.box);
          if (frames.length >= 2 && (!chosen || frames.length > chosen.length)) chosen = frames;
        }
        if (!chosen) continue;
        const dolly = fitPersonDolly(chosen, {imageHeight: media2.height});
        if (!dolly) continue;
        const samples = dollyCameraSamples(dolly, {target: [0, 1.0, 0], cameraHeight: 1.55});
        if (!samples) continue;
        const fovDegrees = 2 * Math.atan(media2.height / 2 / dolly.focalPx) * 180 / Math.PI;
        store.assertRevision(projectId, store.getProjectRow(projectId).revision);
        store.saveCameraTrack(projectId, shot.id, {
          source: 'person-track-dolly',
          intrinsics: {fx: dolly.focalPx, fy: dolly.focalPx, cx: media2.width / 2, cy: media2.height / 2, width: media2.width, height: media2.height, fovDegrees: Number(fovDegrees.toFixed(1))},
          extrinsics: {rotation: null, translation: null, samples, note: '人物尺度推拉估计：目标位于内置舞台原点，方向与距离为估计值'},
          confidence: 0.25,
          medianErrorPx: null,
          // 每次保存自身会推进项目版本，逐镜头刷新 baseRevision
          evidence: {baseRevision: store.getProjectRow(projectId).revision, frames: chosen.length, minDistanceMeters: dolly.minDistance, maxDistanceMeters: dolly.maxDistance, algorithm: ALGORITHM_VERSIONS.camera},
        });
        written++;
        store.updateJob(job.id, {progress: 0.05 + 0.9 * written / shots.length});
      }
      store.updateJob(job.id, {progress: 1, output: `运镜估计 ${written} 个镜头（人物尺度推拉，方向与距离为估计值）`});
      return;
    }
    if (job.kind === 'motion') {
      step(job, 0.05, '读取姿态观测与已确认映射…');
      store.assertRevision(projectId, baseRevision);
      const media2 = store.getMedia(projectId);
      const cast = store.getCast(projectId);
      if (cast.invalidTrackIds.length) throw fail('出场越过当前镜头边界，请先修正', 422);
      const bindingByTrack = new Map(cast.bindings.map(row => [row.track_id, row]));
      const tracks = store.getTracks(projectId).filter(track => track.status === 'active' && bindingByTrack.get(track.id)?.disposition === 'bound');
      const motionDir = path.join(store.observationsDir(projectId), 'motion');
      fs.mkdirSync(motionDir, {recursive: true});
      let built = 0;
      const characterById = new Map(store.getCharacters(projectId).map(row => [row.id, row]));
      for (const track of tracks) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        store.assertRevision(projectId, baseRevision);
        // Never retain an old artifact when this run cannot solve its current input.
        store.setMotionRef(projectId, track.id, null);
        if (track.subject === 'animal') continue;
        const poseFile = path.join(store.observationsDir(projectId), 'poses', `${track.id}.json`);
        if (!fs.existsSync(poseFile)) continue;
        const pose = JSON.parse(fs.readFileSync(poseFile, 'utf8'));
        const character = characterById.get(bindingByTrack.get(track.id).character_id);
        const samples = pose.frames.filter(frame => frame.frame >= track.start_frame && frame.frame <= track.end_frame);
        const motion = buildMotion(samples, {width: media2.width, height: media2.height, bodyHeight: character?.scale || 1.75});
        if (motion.frames.filter(Boolean).length < 2) continue;
        const motionFile = path.join(motionDir, `${track.id}.json`);
        const temporaryFile = `${motionFile}.${job.id}.tmp`;
        fs.writeFileSync(temporaryFile, JSON.stringify({
          trackId: track.id, shotId: track.shot_id, characterId: bindingByTrack.get(track.id).character_id,
          characterName: character?.name || '', bodyHeight: character?.scale || 1.75,
          tracker: pose.tracker || 'unrecorded-legacy-tracker',
          sourceObservation: `observations/poses/${track.id}.json`, algorithm: ALGORITHM_VERSIONS.motion, sampleTimesS: samples.map(frame => frame.timeS), ...motion,
        }));
        store.assertRevision(projectId, baseRevision);
        fs.renameSync(temporaryFile, motionFile);
        store.setMotionRef(projectId, track.id, `data/projects/${projectId}/observations/motion/${track.id}.json`);
        built++;
        store.updateJob(job.id, {progress: 0.05 + 0.9 * built / tracks.length});
      }
      const allTracks = store.getTracks(projectId), motions = {}, artifactErrors = {};
      for (const track of allTracks.filter(row => row.status === 'active' && row.motion_ref)) {
        try {motions[track.id] = readMotionArtifact(root, track.motion_ref).motion;}
        catch (cause) {artifactErrors[track.id] = cause.message;}
      }
      const ignoredTrackIds = store.getPeople(projectId).filter(person => person.assignment === 'ignored').flatMap(person => person.trackIds);
      const quality = draftQuality({tracks: allTracks, bindings: cast.bindings, characters: store.getCharacters(projectId), ignoredTrackIds, shots: store.getShots(projectId), cameraTracks: store.getCameraTracks(projectId), jobs: [], motions, artifactErrors});
      store.updateJob(job.id, {progress: 1, output: `全片初稿已生成：有效动作 ${built}/${tracks.length} 条；主体可见时间覆盖 ${quality.coveragePct ?? '不适用'}%（${(quality.solvedDurationUs / 1e6).toFixed(2)}/${(quality.visibleDurationUs / 1e6).toFixed(2)} 主体秒）；${quality.issues.length} 项待修正（算法 ${ALGORITHM_VERSIONS.motion}）。缺少姿态观测的人物使用占位；动物尚未在三维中还原。`});
      return;
    }
    if (job.kind === 'export') {
      step(job, 0.05, '生成交付包…');
      const exportId = newId('exp');
      const outputDir = path.join(store.exportsDir(projectId), exportId);
      fs.mkdirSync(outputDir, {recursive: true});
      // 脚本与 cwd 固定为仓库根（tsx/three 从仓库解析）；数据根目录用参数传入（测试可为临时目录）
      const moduleRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', path.join(moduleRoot, 'scripts', 'build-export-package.mjs'),
          '--project', projectId, '--store-root', root, '--output', outputDir, '--export-id', exportId], {windowsHide: true, cwd: moduleRoot});
        let stderr = [];
        child.stderr.on('data', chunk => stderr.push(chunk));
        child.on('error', cause => reject(fail(`无法启动导出脚本：${cause.message}`, 500)));
        child.on('close', code => code === 0 ? resolve() : reject(fail(`导出脚本失败（${code}）：${Buffer.concat(stderr).toString('utf8').slice(-800)}`, 500)));
      });
      store.updateJob(job.id, {progress: 1, output: `交付包 ${exportId} 已生成`});
      return;
    }
    throw fail(`未知任务类型 ${job.kind}`, 400);
  };

  const schedule = (job, baseRevision) => {
    const projectId = job.project_id;
    const generation = Symbol(job.id);
    scheduled.set(job.id, generation);
    const previous = chain.get(projectId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const current = store.getJob(job.id);
      if (!current || current.state !== 'queued' || scheduled.get(job.id) !== generation) return;
      store.updateJob(job.id, {state: 'running', progress: 0});
      try {
        await runJob(current, baseRevision);
        const finalState = store.getJob(job.id);
        if (finalState.cancel_requested) {
          store.updateJob(job.id, {state: 'cancelled', error: '任务在完成前被取消'});
          const options = finalState.options ? JSON.parse(finalState.options) : {};
          if (options.analysisRunId) analysisStore.updateRun(projectId, options.analysisRunId, {status: 'cancelled', error: '任务已被取消'});
        }
        else if (finalState.state === 'running') {
          store.updateJob(job.id, {state: 'done'});
          // 自动初稿链（V2 R1/P5）：上传后的任务按依赖自动串联；人工单独发起的任务不自动续跑
          const options = finalState.options ? JSON.parse(finalState.options) : {};
          if (options.auto && options.targetStage === 'shot_analysis') {
            const nextKind = {proxy: 'pts', pts: 'cuts', cuts: 'shot_frames', shot_frames: 'shot_analyze', shot_analyze: 'shot_validate', shot_validate: 'shot_report'}[finalState.kind];
            const result = analysisStore.getRun(projectId, options.analysisRunId);
            if (nextKind && result && !['cancelled', 'stale'].includes(result.status)) {
              enqueue(projectId, nextKind, {...options, resultStatus: result.status, resultError: result.error || null});
            }
            // 拉片链收尾（shot_report 完成，或 shot_analyze 失败且无后续校验）后
            // 自动进入检测分支（V2 R1：拉片失败不阻断自动初稿；全链按项目 FIFO 串行）。
            const analysisKinds = ['shot_frames', 'shot_analyze', 'shot_validate', 'shot_report'];
            const analysisTail = analysisKinds.includes(finalState.kind) && (finalState.kind === 'shot_report' || finalState.state === 'failed' || finalState.state === 'cancelled');
            void nextKind;
            if (analysisTail && !store.listJobs(projectId).some(job => job.kind === 'detect')) {
              enqueue(projectId, 'detect', {subjects: 'both', auto: true});
            }
          } else {
            const nextAuto = {cuts: {kind: 'detect', options: {subjects: 'both'}}, detect: {kind: 'people'}, people: {kind: 'motion'}, motion: {kind: 'camera'}}[finalState.kind];
            if (options.auto && nextAuto) enqueue(projectId, nextAuto.kind, {...nextAuto.options, auto: true});
          }
        }
      } catch (cause) {
        const isCancel = cancelled(job.id) || cause?.message === '任务已被取消';
        store.updateJob(job.id, {state: isCancel ? 'cancelled' : 'failed', error: String(cause?.message || cause)});
        const options = current.options ? JSON.parse(current.options) : {};
        if (options.analysisRunId) {
          const previous = analysisStore.getRun(projectId, options.analysisRunId);
          if (previous && !['stale', 'cancelled'].includes(previous.status)) {
            // 语义不可用（未配置/缺密钥）降级为 blocked 底稿；网络与鉴权类瞬时失败仍按 failed 可重试。
            const resultStatus = isCancel ? 'cancelled' : previous.status === 'blocked' || SEMANTIC_UNAVAILABLE_CODES.includes(cause?.code) ? 'blocked' : 'failed';
            analysisStore.updateRun(projectId, options.analysisRunId, {status: resultStatus, error: String(cause?.message || cause)});
            // Terminal diagnostics can be exported even when semantic analysis cannot run.
            // The failed model job remains failed, and the report retains blocked/failed.
            if (current.kind === 'shot_analyze' && (resultStatus === 'blocked' || cause?.code === 'analysis_all_failed') && options.auto) {
              enqueue(projectId, 'shot_validate', {...options, resultStatus, resultError: String(cause.message)});
            }
          }
        }
        // V2 R1：拉片是可降级分支——语义提供方未配置/失败时，检测分支仍自动执行。
        const autoOptions = current.options ? JSON.parse(current.options) : {};
        const autoAnalysisKinds = ['shot_frames', 'shot_analyze', 'shot_validate', 'shot_report'];
        if (autoOptions.auto && autoOptions.targetStage === 'shot_analysis' && autoAnalysisKinds.includes(current.kind)
          && !isCancel && !store.listJobs(projectId).some(job => job.kind === 'detect')) {
          enqueue(projectId, 'detect', {subjects: 'both', auto: true});
        }
      }
    });
    chain.set(projectId, next);
    // 任务状态在 catch 首句已落库；其后收尾逻辑（链式入队等）的意外失败不得变成
    // 未处理的 Promise 拒绝把进程带崩。
    next.catch(() => {}).finally(() => {
      if (scheduled.get(job.id) === generation) scheduled.delete(job.id);
      if (chain.get(projectId) === next && store.listJobs(projectId).every(item => item.state !== 'queued')) chain.delete(projectId);
    });
    return job;
  };

  const enqueue = (projectId, kind, options = {}) => {
    const baseRevision = store.getProjectRow(projectId)?.revision || '';
    if (store.listJobs(projectId).some(job => job.kind === kind && ['queued', 'running'].includes(job.state))) throw fail('同类任务已在排队或运行', 409);
    const job = store.createJob(projectId, kind, {inputHash: stableHash({kind, baseRevision, options}), algorithmVersion: ALGORITHM_VERSIONS[kind] || '', options});
    return schedule(job, baseRevision);
  };
  const retry = (projectId, jobId, baseRevision) => {
    const previous = store.getJob(jobId);
    store.assertRevision(projectId, baseRevision);
    if (!previous || previous.project_id !== projectId) throw fail('任务不存在', 404);
    if (!['failed', 'cancelled'].includes(previous.state)) throw fail(`任务处于 ${previous.state} 状态，不能重试`, 422);
    if (store.listJobs(projectId).some(job => job.id !== jobId && job.kind === previous?.kind && ['queued', 'running'].includes(job.state))) throw fail('同类任务已在运行', 409);
    const options = previous.options ? JSON.parse(previous.options) : {};
    if (options.analysisRunId) {
      if (store.listJobs(projectId).some(job => ['queued', 'running'].includes(job.state) && JSON.parse(job.options || '{}').analysisRunId)) throw fail('拉片任务正在执行，请稍后重试', 409);
      analysisStore.resumeRun(projectId, options.analysisRunId);
    }
    return schedule(store.retryJob(projectId, jobId, baseRevision), baseRevision);
  };
  const refreshAnalysisReport = async (projectId, runId) => {
    const run = analysisStore.getRun(projectId, runId);
    if (!run?.quality?.engineChecks || store.listJobs(projectId).some(job => ['queued', 'running'].includes(job.state) && JSON.parse(job.options || '{}').analysisRunId)) return run;
    await analysisEngine.validate(projectId, runId);
    return analysisEngine.report(projectId, runId);
  };
  return {enqueue, retry, analysisStore, refreshAnalysisReport, modelSettings};
}
