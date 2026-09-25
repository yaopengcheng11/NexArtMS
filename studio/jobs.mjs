import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fail, newId, stableHash, ALGORITHM_VERSIONS} from './db.mjs';
import {buildProxy, extractPtsMap, extractSignatures, extractStill} from './media.mjs';
import {computeScores, detectCutsFromScores, cutsToShotBounds} from './cuts.mjs';
import {runDetection, trackDetections, trackObservation} from './person.mjs';
import {frameStream} from './vision.mjs';
import {appearanceDescriptor, PEOPLE_ALGORITHM} from './people.mjs';
import {buildMotion} from './pose3d.mjs';

// 任务运行器：同项目内 FIFO 串行（SQLite 单写入 + 限制同项目并发编辑）。
// 支持：进度、协作式取消、失败记录、重试；服务重启后的 queued/running 任务由
// store 初始化时如实标记为失败。分析任务在入队时锁定项目版本；期间若用户修改
// 了项目，任务如实失败而不是覆盖人工决策。
export function createJobRunner(store, root, limits) {
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
    const media = store.getMedia(projectId);
    if (!media) throw fail('项目还没有导入媒体', 422);
    const originalPath = resolveRef(media.original_ref);
    const proxyPath = resolveRef(media.proxy_ref);

    if (job.kind === 'people') {
      const tracks = store.getTracks(projectId).filter(track => track.status === 'active');
      if (!tracks.length) throw fail('请先检测人物或补标出场', 422);
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
      store.updateJob(job.id, {progress: 1, algorithm_version: PEOPLE_ALGORITHM, output: `${people.length} 个人物候选；外观相似建议需人工核对，已有分组已保留。`});
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
      step(job, 0.05, '提取帧签名…');
      const signatures = await extractSignatures(proxyPath);
      step(job, 0.5, '计算切镜得分…');
      const scores = computeScores(signatures);
      const cutFrames = detectCutsFromScores(scores);
      step(job, 0.7, `写入 ${cutFrames.length + 1} 个镜头候选…`);
      const pts = store.loadPtsFor(store.getMedia(projectId));
      const bounds = cutsToShotBounds(cutFrames, pts.length);
      const shots = bounds.map((bound, idx) => ({
        id: `S${String(idx + 1).padStart(2, '0')}`,
        startFrame: bound.startFrame,
        endFrameExclusive: bound.endFrameExclusive,
        startUs: Math.round(pts[bound.startFrame] * 1e6),
        endUs: bound.endFrameExclusive < pts.length ? Math.round(pts[bound.endFrameExclusive] * 1e6) : store.getMedia(projectId).duration_us,
      }));
      store.replaceShots(projectId, shots, 'auto', baseRevision);
      step(job, 0.85, '生成镜头缩略图…');
      let index = 0;
      for (const shot of store.getShots(projectId)) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        const middle = Math.floor((shot.start_frame + shot.end_frame_exclusive - 1) / 2);
        await extractStill(originalPath, path.join(store.previewsDir(projectId), 'shots', `${shot.id}.jpg`), {timeS: pts[middle] ?? shot.start_us / 1e6});
        store.updateJob(job.id, {progress: 0.85 + 0.14 * (++index / Math.max(1, shots.length))});
      }
      store.updateJob(job.id, {progress: 1, output: `${shots.length} 镜 · 自动切点 ${cutFrames.length} 个（算法 ${ALGORITHM_VERSIONS.cuts}）`});
      return;
    }
    if (job.kind === 'detect') {
      if (store.getShots(projectId).length === 0) throw fail('切镜结果尚未生成，无法按镜头检测人物', 422);
      step(job, 0.05, '运行人物检测…');
      const media2 = store.getMedia(projectId);
      const stride = media2.pts_count > 0 ? Math.max(1, Math.round((media2.pts_count / (media2.duration_us / 1e6)) / 10)) : 2; // 约 10 fps 采样
      const {detector, detectorVersion, detections} = await runDetection({
        videoPath: originalPath, proxyPath, projectId, job,
        sourceWidth: media2.width, sourceHeight: media2.height, frameCount: media2.pts_count, stride,
        onProgress: fraction => {if (fraction !== undefined) store.updateJob(job.id, {progress: 0.05 + fraction * 0.55});},
        isCancelled: () => cancelled(job.id),
      });
      step(job, 0.62, `镜内跟踪 ${detections.length} 个逐帧人物框…`);
      const shots = store.getShots(projectId);
      fs.mkdirSync(path.join(store.observationsDir(projectId), 'poses'), {recursive: true});
      const pts = store.loadPtsFor(media2);
      const specs = [];       // insertTracks 的批量规格（保持顺序对应 poseFrames）
      const poseFrames = [];  // 每条轨迹的关键点观测
      for (const shot of shots) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        const inShot = detections.filter(detection => detection.frame >= shot.start_frame && detection.frame < shot.end_frame_exclusive);
        if (inShot.length === 0) continue;
        for (const track of trackDetections(inShot, {maxGapFrames: stride * 2 - 1})) {
          const startFrame = Math.max(track.startFrame, shot.start_frame);
          const endFrame = Math.min(track.endFrame, shot.end_frame_exclusive - 1);
          specs.push({shotId: shot.id, startFrame, endFrame, box: track.box, confidence: track.confidence, provenance: 'auto', appearance: track.appearance, representativeFrame: track.representativeFrame});
          const frames = track.observations.filter(observation => observation.keypoints).map(observation => ({
            frame: observation.frame, timeS: pts[observation.frame], box: observation.box, keypoints: observation.keypoints,
          }));
          poseFrames.push(frames);
        }
      }
      const created = store.insertTracks(projectId, specs, baseRevision);
      store.summarizePeople(projectId, store.getProjectRow(projectId).revision);
      created.forEach((track, index) => {
        if (poseFrames[index]?.length > 0) {
          fs.writeFileSync(path.join(store.observationsDir(projectId), 'poses', `${track.id}.json`),
            JSON.stringify({trackId: track.id, shotId: track.shot_id, detector, detectorVersion, tracker: ALGORITHM_VERSIONS.tracker, coordinateSpace: 'normalized-0-1', joints: 'COCO-17', frames: poseFrames[index]}, null, 1));
        }
      });
      fs.mkdirSync(path.join(store.observationsDir(projectId), 'tracks'), {recursive: true});
      fs.writeFileSync(path.join(store.observationsDir(projectId), 'tracks', `${job.id}.json`),
        JSON.stringify(trackObservation({shotId: '*', provenance: 'auto', detector, detectorVersion, note: `逐帧框 ${detections.length} 个 → 镜内轨迹 ${created.length} 条（采样步长 ${stride}）`}), null, 2));
      store.updateJob(job.id, {progress: 1, algorithm_version: `${detector}@${detectorVersion}`, output: `检测器 ${detector}@${detectorVersion}：镜内轨迹 ${created.length} 条（采样步长 ${stride}）`});
      return;
    }
    if (job.kind === 'motion') {
      step(job, 0.05, '读取姿态观测与已确认映射…');
      const media2 = store.getMedia(projectId);
      const cast = store.getCast(projectId);
      if (cast.invalidTrackIds.length) throw fail('出场越过当前镜头边界，请先修正', 422);
      const bindingByTrack = new Map(cast.bindings.map(row => [row.track_id, row]));
      const tracks = store.getTracks(projectId).filter(track => track.status === 'active' && bindingByTrack.get(track.id)?.disposition === 'bound');
      if (tracks.length === 0) throw fail('还没有已绑定角色的出场候选（请先检测/补标并完成归并）', 422);
      const motionDir = path.join(store.observationsDir(projectId), 'motion');
      fs.mkdirSync(motionDir, {recursive: true});
      let built = 0;
      const characterById = new Map(store.getCharacters(projectId).map(row => [row.id, row]));
      for (const track of tracks) {
        if (cancelled(job.id)) throw fail('任务已被取消', 409);
        const poseFile = path.join(store.observationsDir(projectId), 'poses', `${track.id}.json`);
        if (!fs.existsSync(poseFile)) continue;
        const pose = JSON.parse(fs.readFileSync(poseFile, 'utf8'));
        const character = characterById.get(bindingByTrack.get(track.id).character_id);
        const motion = buildMotion(pose.frames.filter(frame => frame.frame >= track.start_frame && frame.frame <= track.end_frame), {width: media2.width, height: media2.height, bodyHeight: character?.scale || 1.75});
        if (motion.frames.filter(Boolean).length < 2) continue;
        const motionFile = path.join(motionDir, `${track.id}.json`);
        fs.writeFileSync(motionFile, JSON.stringify({
          trackId: track.id, shotId: track.shot_id, characterId: bindingByTrack.get(track.id).character_id,
          characterName: character?.name || '', bodyHeight: character?.scale || 1.75,
          tracker: pose.tracker || 'unrecorded-legacy-tracker',
          sourceObservation: `observations/poses/${track.id}.json`, algorithm: ALGORITHM_VERSIONS.motion, ...motion,
        }));
        store.assertRevision(projectId, baseRevision);
        store.setMotionRef(projectId, track.id, `data/projects/${projectId}/observations/motion/${track.id}.json`);
        built++;
        store.updateJob(job.id, {progress: 0.05 + 0.9 * built / tracks.length});
      }
      if (built === 0) throw fail('已绑定的候选还没有姿态观测（请先运行带模型的人物检测，或等待模型可用）', 422);
      store.updateJob(job.id, {progress: 1, output: `生成 ${built} 条连续动作（算法 ${ALGORITHM_VERSIONS.motion}）`});
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
        if (finalState.cancel_requested) store.updateJob(job.id, {state: 'cancelled', error: '任务在完成前被取消'});
        else if (finalState.state === 'running') store.updateJob(job.id, {state: 'done'});
      } catch (cause) {
        const isCancel = cause?.message === '任务已被取消';
        store.updateJob(job.id, {state: isCancel ? 'cancelled' : 'failed', error: String(cause?.message || cause)});
      }
    });
    chain.set(projectId, next);
    next.finally(() => {
      if (scheduled.get(job.id) === generation) scheduled.delete(job.id);
      if (chain.get(projectId) === next && store.listJobs(projectId).every(item => item.state !== 'queued')) chain.delete(projectId);
    });
    return job;
  };

  const enqueue = (projectId, kind) => {
    const baseRevision = store.getProjectRow(projectId)?.revision || '';
    if (store.listJobs(projectId).some(job => job.kind === kind && ['queued', 'running'].includes(job.state))) throw fail('同类任务已在排队或运行', 409);
    const job = store.createJob(projectId, kind, {inputHash: stableHash({kind, baseRevision}), algorithmVersion: ALGORITHM_VERSIONS[kind] || ''});
    return schedule(job, baseRevision);
  };
  const retry = (projectId, jobId, baseRevision) => {
    const previous = store.getJob(jobId);
    if (store.listJobs(projectId).some(job => job.id !== jobId && job.kind === previous?.kind && ['queued', 'running'].includes(job.state))) throw fail('同类任务已在运行', 409);
    return schedule(store.retryJob(projectId, jobId, baseRevision), baseRevision);
  };
  return {enqueue, retry};
}
