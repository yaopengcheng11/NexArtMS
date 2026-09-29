import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createShotAnalysisProvider} from './shot-analysis-provider.mjs';
import {SHOT_ANALYSIS_SCHEMA_VERSION, SHOT_ANALYSIS_PROMPT_VERSION, validateAnnotation, validateSubjects, validateIssues} from './shot-analysis-schema.mjs';
import {validate as validateReelbench, renderMd as renderReelbenchMd, shotNo} from '../vendor/reelbench/video-shots/scripts/video-shots.mjs';

const issue = (code, message, extra = {}) => ({code, severity: 'warning', message, ...extra});
const problem = (message, code = 'analysis_invalid', status = 422) => Object.assign(new Error(message), {code, status});
// Errors that mean "semantics cannot run right now" — a degraded draft, not a malfunction.
export const SEMANTIC_UNAVAILABLE_CODES = ['provider_unconfigured', 'missing_api_key', 'secret_unavailable', 'secret_codec_failed'];
const atomic = (file, data) => {fs.mkdirSync(path.dirname(file), {recursive: true});const tmp = `${file}.${crypto.randomUUID()}.tmp`;fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 2));fs.renameSync(tmp, file);};
const safe = (directory, relative) => {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw problem('分析文件路径无效');
  const resolved = path.resolve(directory, relative), root = path.resolve(directory);
  if (!resolved.startsWith(root + path.sep)) throw problem('分析文件越出运行目录');
  return resolved;
};
const jpeg = file => {try {const fd = fs.openSync(file, 'r');try {const b = Buffer.alloc(3);return fs.readSync(fd, b, 0, 3, 0) === 3 && b[0] === 255 && b[1] === 216 && b[2] === 255;} finally {fs.closeSync(fd);}} catch {return false;}};
const sample = (values, count) => values.length <= count ? values : [...new Set(Array.from({length: count}, (_, i) => values[Math.round(i * (values.length - 1) / (count - 1))]))];
export function evidenceIndices(shot, dense = false) {
  const length = shot.endFrameExclusive - shot.startFrame;
  if (!Number.isSafeInteger(length) || length < 1) throw problem('镜头源帧范围无效');
  const offsets = dense || length <= 12 ? Array.from({length: Math.min(length, 9)}, (_, i) => Math.round(i * (length - 1) / Math.max(1, Math.min(length, 9) - 1))) : [0, .15, .5, .85, 1].map(f => Math.round(f * (length - 1)));
  return [...new Set(offsets.map(offset => shot.startFrame + offset))].sort((a, b) => a - b);
}

function ffmpegFrames(source, indices, directory, guard, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false, stderr = '';
    const child = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', source, '-map', '0:v:0', '-vf', `select=${indices.map(n => `eq(n\\,${n})`).join('+')},scale='min(768,iw)':-2`, '-fps_mode', 'passthrough', '-q:v', '3', '-start_number', '0', path.join(directory, '%06d.jpg')], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
    const finish = error => {if (settled) return;settled = true;clearTimeout(timer);clearInterval(poll);error ? reject(error) : resolve();};
    const timer = setTimeout(() => {child.kill();finish(problem('关键帧抽取超时', 'frames_timeout', 504));}, timeoutMs);
    const poll = setInterval(() => {try {guard();} catch (error) {child.kill();finish(error);}}, 100);
    child.stderr.on('data', chunk => {stderr = (stderr + chunk.toString()).slice(-800);});
    child.on('error', () => finish(problem('无法启动 FFmpeg，请检查 FFMPEG 配置', 'ffmpeg_missing', 500)));
    child.on('close', code => {try {guard();if (code !== 0) throw problem(`关键帧抽取失败 (${code})：${stderr}`, 'frames_failed', 500);finish();} catch (error) {finish(error);}});
  });
}

// 联系表（contact sheet）：上游 video-shots 的看片方式——多帧拼成一张大图、每格标注
// shot 与源帧号，单次请求的图片数降一个数量级；同镜相邻格即 a/b 运镜对照。
const SHEET = {tileW: 480, tileH: 270, cols: 3, per: 12};
const sheetFont = () => {
  if (process.platform !== 'win32') return null;
  for (const name of ['arial.ttf', 'Arial.ttf', 'segoeui.ttf']) {
    const candidate = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', name);
    if (fs.existsSync(candidate)) return candidate.replaceAll('\\', '/');
  }
  return null;
};
const composeSheet = (inputs, labels, output, font, guard, timeoutMs = 90000) => new Promise((resolve, reject) => {
  let settled = false, stderr = '';
  const rows = Math.ceil(inputs.length / SHEET.cols);
  const filter = [
    ...inputs.map((_, i) => `[${i}:v]scale=${SHEET.tileW}:${SHEET.tileH}:force_original_aspect_ratio=decrease,pad=${SHEET.tileW}:${SHEET.tileH}:(ow-iw)/2:(oh-ih)/2:color=black,drawtext=fontfile='${font.replaceAll(':', '\\:')}':text='${labels[i]}':x=8:y=6:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6[t${i}]`),
    `[${inputs.map((_, i) => `t${i}`).join('][')}]concat=n=${inputs.length}:v=1:a=0[c]`,
    `[c]tile=${SHEET.cols}x${rows}:padding=4:margin=4:color=white[out]`,
  ].join(';');
  const child = spawn(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', ...inputs.flatMap(file => ['-i', file]), '-filter_complex', filter, '-map', '[out]', '-frames:v', '1', '-q:v', '4', output], {windowsHide: true, stdio: ['ignore', 'ignore', 'pipe']});
  const finish = error => {if (settled) return;settled = true;clearTimeout(timer);clearInterval(poll);error ? reject(error) : resolve();};
  const timer = setTimeout(() => {child.kill();finish(problem('联系表生成超时', 'sheet_timeout', 504));}, timeoutMs);
  const poll = setInterval(() => {try {guard();} catch (error) {child.kill();finish(error);}}, 100);
  child.stderr.on('data', chunk => {stderr = (stderr + chunk.toString()).slice(-400);});
  child.on('error', () => finish(problem('无法启动 FFmpeg，联系表回退逐帧', 'sheet_failed', 500)));
  child.on('close', code => {if (code !== 0) return finish(problem(`联系表生成失败 (${code})：${stderr}`, 'sheet_failed', 500));try {guard();if (!jpeg(output)) throw problem('联系表输出缺失', 'sheet_failed', 500);finish();} catch (error) {finish(error);}});
});
const buildSheets = async (directory, frames, guard) => {
  const font = sheetFont();
  if (!font || frames.length < 3) return null;
  const temp = path.join(directory, `sheet-${crypto.randomUUID()}`);
  fs.mkdirSync(temp);
  try {
    const sheets = [];
    for (let i = 0; i < frames.length; i += SHEET.per) {
      const chunk = frames.slice(i, i + SHEET.per), output = path.join(temp, `${sheets.length}.jpg`);
      await composeSheet(chunk.map(f => safe(directory, f.imageRef)), chunk.map(f => `${f.shotId || 'ref'} f${f.frameIndex}`), output, font, guard);
      sheets.push({tiles: chunk.map(({frameIndex, ptsUs, shotId}) => ({frameIndex, ptsUs, shotId: shotId || null})), dataUrl: `data:image/jpeg;base64,${fs.readFileSync(output).toString('base64')}`});
    }
    return sheets;
  } catch {return null;}
  finally {fs.rmSync(temp, {recursive: true, force: true, maxRetries: 5});}
};

export function createShotAnalysisEngine({store, analysisStore, root, provider, providerResolver}) {
  const defaultVisual = provider?.overview && provider?.analyzeBatch ? provider : createShotAnalysisProvider(provider);
  const get = (projectId, runId) => {const run = analysisStore.getRun(projectId, runId);if (!run) throw problem('拉片运行不存在', 'analysis_missing', 404);return run;};
  const guardFor = (projectId, runId, opts) => () => {
    if (opts.isCancelled?.()) throw problem('拉片任务已取消', 'analysis_cancelled', 409);
    const run = get(projectId, runId);
    if (run.status === 'cancelled') throw problem('拉片运行已取消', 'analysis_cancelled', 409);
    analysisStore.assertCurrent(projectId, runId);
  };
  const mutate = (projectId, runId, guard, patch) => {guard();return analysisStore.updateRun(projectId, runId, patch);};
  const metadata = projectId => {
    const media = store.getMedia(projectId);if (!media) throw problem('项目没有原片');
    const pts = store.loadPtsFor(media);
    if (!pts.length || pts.length !== media.pts_count || pts.some((p, i) => !Number.isFinite(p) || p < 0 || i > 0 && p <= pts[i - 1])) throw problem('原片 PTS 映射无效，必须逐呈现帧严格递增');
    return {media, pts};
  };
  const framePayload = (directory, shots, extra = []) => {
    const map = new Map();
    for (const shot of shots) for (const evidence of shot.evidenceFrames || []) map.set(evidence.frameIndex, {...evidence, shotId: shot.id});
    for (const frame of extra) if (!map.has(frame.frameIndex)) map.set(frame.frameIndex, frame);
    return [...map.values()].map(evidence => {
      const file = safe(directory, evidence.imageRef);if (!jpeg(file)) throw problem(`证据帧 ${evidence.frameIndex} 缺失或不是 JPEG`);
      return {frameIndex: evidence.frameIndex, ptsUs: evidence.ptsUs, shotId: evidence.shotId, imageRef: evidence.imageRef, dataUrl: `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`};
    });
  };
  const extract = async (projectId, runId, shots, opts, dense = false) => {
    const guard = guardFor(projectId, runId, opts), directory = analysisStore.runDirectory(projectId, runId);
    const {media, pts} = metadata(projectId);
    const subjectRefs = get(projectId, runId).subjects.flatMap(s => s.referenceFrames || []);
    const expected = new Map(shots.map(shot => [shot.id, [...new Set([...evidenceIndices(shot, dense), ...(shot.generated?.evidenceFrames || []), ...(shot.overrides?.evidenceFrames || []), ...subjectRefs.filter(f => f >= shot.startFrame && f < shot.endFrameExclusive)])].sort((a, b) => a - b).map(frameIndex => {
      if (frameIndex >= pts.length) throw problem('镜头源帧超出 PTS 映射');
      return {frameIndex, ptsUs: Math.round(pts[frameIndex] * 1e6), imageRef: `frames/f${String(frameIndex).padStart(9, '0')}.jpg`};
    })]));
    const missing = [...new Map([...expected.values()].flat().map(f => [f.frameIndex, f])).values()].filter(f => !jpeg(safe(directory, f.imageRef))).sort((a, b) => a.frameIndex - b.frameIndex);
    fs.mkdirSync(path.join(directory, 'frames'), {recursive: true});
    for (let i = 0; i < missing.length; i += 96) {
      guard();
      const chunk = missing.slice(i, i + 96), temp = path.join(directory, `extract-${crypto.randomUUID()}`);
      fs.mkdirSync(temp);
      try {
        await ffmpegFrames(safe(root, media.original_ref), chunk.map(f => f.frameIndex), temp, guard);
        guard();
        for (let j = 0; j < chunk.length; j++) {
          const output = path.join(temp, `${String(j).padStart(6, '0')}.jpg`);
          if (!jpeg(output)) throw problem(`源帧 ${chunk[j].frameIndex} 未被精确抽取`);
          fs.renameSync(output, safe(directory, chunk[j].imageRef));
        }
      } finally {
        // This is a newly generated, bounded run-private directory, never the shared previews directory.
        if (path.dirname(temp) === path.resolve(directory) && path.basename(temp).startsWith('extract-')) fs.rmSync(temp, {recursive: true, force: true, maxRetries: 5});
      }
      opts.onProgress?.(Math.min(1, (i + chunk.length) / Math.max(1, missing.length)), `提取原片证据帧 ${Math.min(i + chunk.length, missing.length)}/${missing.length}`);
    }
    for (const shot of shots) {guard();const byFrame = new Map([...(shot.evidenceFrames || []), ...expected.get(shot.id)].map(f => [f.frameIndex, f]));analysisStore.updateShot(projectId, runId, shot.id, {evidenceFrames: [...byFrame.values()].sort((a, b) => a.frameIndex - b.frameIndex)}, {shotRevision: shot.shotRevision});}
    return get(projectId, runId);
  };
  const frames = async (projectId, runId, opts = {}) => {
    const guard = guardFor(projectId, runId, opts);guard();
    const run = get(projectId, runId);if (!run.shots.length) throw problem('尚无切镜结果，不能抽取拉片关键帧');
    mutate(projectId, runId, guard, {status: 'processing', stage: 'frames', progress: 0, error: null});
    await extract(projectId, runId, run.shots, opts);
    mutate(projectId, runId, guard, {progress: 1});opts.onProgress?.(1, '原片关键帧已生成');return get(projectId, runId);
  };
  const analyze = async (projectId, runId, opts = {}) => {
    const guard = guardFor(projectId, runId, opts);guard();
    // 语义模型不可用（未配置/缺密钥/密钥不可解密）时降级为 blocked 底稿返回：
    // 任务正常完成，自动链继续校验、报告与检测；重试语义在配置模型后进行。
    const blockedAnalysis = reason => {
      const message = `全片语义分析未执行：${reason}。镜头表与关键帧底稿已保留，配置视觉模型后可重试；后续检测与动作任务不受影响。`;
      mutate(projectId, runId, guard, {status: 'blocked', stage: 'analyze', error: message, issues: [issue('provider_unconfigured', reason, {severity: 'error'})]});
      return get(projectId, runId);
    };
    let visual;
    try {visual = providerResolver ? await providerResolver(projectId, runId) : defaultVisual;}
    catch (error) {
      if (!SEMANTIC_UNAVAILABLE_CODES.includes(error.code)) throw error;
      return blockedAnalysis(error.message);
    }
    guard();
    const status = visual.status();
    if (!status.configured) return blockedAnalysis(status.reason);
    const provenance = {provider: status.provider, model: status.model, schemaVersion: SHOT_ANALYSIS_SCHEMA_VERSION, promptVersion: SHOT_ANALYSIS_PROMPT_VERSION};
    let run = get(projectId, runId);
    if (Object.entries(provenance).some(([key, value]) => run[key] !== value)) {
      // A resumed job may run under a newly configured provider/model. Archive the previous result before invalidating generated text.
      if (run.shots.some(s => s.generated) || run.quality?.overview?.completed) {
        const previousRef = `history/provenance-${crypto.randomUUID()}.json`;
        guard();atomic(safe(analysisStore.runDirectory(projectId, runId), previousRef), run);
        mutate(projectId, runId, guard, {quality: {usage: run.quality?.usage || {}, previousProvenance: {artifactRef: previousRef, provider: run.provider, model: run.model, schemaVersion: run.schemaVersion, promptVersion: run.promptVersion}}, artifactRef: null, issues: []});
      } else mutate(projectId, runId, guard, {quality: {}, artifactRef: null, issues: []});
      for (const shot of run.shots) {guard();analysisStore.updateShot(projectId, runId, shot.id, {generated: null, status: 'pending', issues: []}, {shotRevision: shot.shotRevision});}
    }
    run = mutate(projectId, runId, guard, {status: 'processing', stage: 'analyze', progress: 0, ...provenance, error: null});
    const directory = analysisStore.runDirectory(projectId, runId), settings = {batchSize: 6, maxCalls: 64, ...visual.settings};
    let calls = 0, completed = run.shots.filter(s => s.generated).length;
    let quality = {...(run.quality || {}), schemaVersion: SHOT_ANALYSIS_SCHEMA_VERSION, providerSettings: settings};
    let runIssues = (run.issues || []).filter(i => !['provider_unconfigured', 'overview_failed', 'batch_failed', 'analysis_budget'].includes(i.code));
    const invoke = async (method, payload) => {
      if (calls >= settings.maxCalls) throw problem('本片视觉调用预算已用完，未分析镜头保留待重试', 'analysis_budget');
      guard();calls++;quality = {...quality, usage: {...quality.usage, calls: (quality.usage?.calls || 0) + 1}};
      const controller = new AbortController();
      const poll = setInterval(() => {try {guard();} catch (error) {controller.abort(error);}}, 100);
      try {const result = await visual[method](payload, {signal: controller.signal});guard();quality = {...quality, usage: {...quality.usage, attempts: (quality.usage?.attempts || 0) + (result.usage?.attempts || 1), totalTokens: (quality.usage?.totalTokens || 0) + (result.usage?.totalTokens || 0)}};return result;}
      catch (error) {quality = {...quality, usage: {...quality.usage, attempts: (quality.usage?.attempts || 0) + (error.attempts || 1), failedCalls: (quality.usage?.failedCalls || 0) + 1}};throw error;}
      finally {clearInterval(poll);}
    };
    const base = () => ({schemaVersion: SHOT_ANALYSIS_SCHEMA_VERSION, promptVersion: SHOT_ANALYSIS_PROMPT_VERSION, mediaHash: run.mediaHash, shotSetRevision: run.shotSetHash, subjectCatalog: run.subjects || [], overview: quality.overview?.summary || ''});
    const classifyFailure = error => {
      guard();
      if (['http_401', 'http_403'].includes(error.code)) {mutate(projectId, runId, guard, {status: 'blocked', error: error.message, quality});throw error;}
    };
    // The overview is a bounded contact-sheet equivalent, spanning the whole source. It is not a claim of exhaustive identity discovery.
    if (!quality.overview?.completed) {
      const evidence = sample(run.shots.flatMap(s => (s.evidenceFrames || []).map(f => ({...f, shotId: s.id}))), 32);
      try {
        const frames = framePayload(directory, [], evidence), sheets = await buildSheets(directory, frames, guard);
        const result = await invoke('overview', {...base(), shots: run.shots.map(({id, startFrame, endFrameExclusive, startUs, endUs}) => ({id, startFrame, endFrameExclusive, startUs, endUs})), evidenceFrames: sheets ? frames.map(({dataUrl, imageRef, ...meta}) => meta) : frames, ...(sheets ? {sheets} : {})});
        const output = result.output;
        const subjects = validateSubjects(output?.subjects, {allowedFrames: evidence.map(f => f.frameIndex)}), issues = validateIssues(output?.issues);
        if (typeof output?.summary !== 'string' || !output.summary.trim() || output.summary.length > 4000 || !subjects.valid || !issues.valid || Object.keys(output).some(k => !['summary', 'subjects', 'issues'].includes(k))) throw problem('全片概览响应 schema 无效', 'overview_schema');
        const catalog = new Map((run.subjects || []).map(s => [s.id, s]));
        for (const subject of subjects.value) {
          if (catalog.has(subject.id) && catalog.get(subject.id).kind !== subject.kind) throw problem('概览试图改变既有主体类型', 'subject_conflict');
          if (!catalog.has(subject.id)) catalog.set(subject.id, subject);
        }
        guard();atomic(path.join(directory, 'batches', 'overview.json'), {...provenance, ...result});
        quality.overview = {completed: true, summary: output.summary, evidenceFrames: evidence.map(f => f.frameIndex)};
        runIssues.push(...issues.value);
        run = mutate(projectId, runId, guard, {subjects: [...catalog.values()], issues: runIssues, quality});
      } catch (error) {classifyFailure(error);runIssues.push(issue('overview_failed', error.message));mutate(projectId, runId, guard, {issues: runIssues, quality});}
    }
    const pending = run.shots.filter(s => !s.generated || !validateAnnotation(s.generated, {allowedFrames: s.evidenceFrames.map(f => f.frameIndex), subjectIds: run.subjects.map(s => s.id), shot: s}).valid);
    for (let index = 0; index < pending.length; index += settings.batchSize) {
      guard();run = get(projectId, runId);let batch = pending.slice(index, index + settings.batchSize).map(s => run.shots.find(current => current.id === s.id));
      const referenceFrames = sample((run.subjects || []).flatMap(s => s.referenceFrames || []).map(f => run.shots.flatMap(s => s.evidenceFrames.map(e => ({...e, shotId: s.id}))).find(e => e.frameIndex === f)).filter(Boolean), 8);
      // 单次请求每镜均匀采样最多 5 帧：完整证据仍保存在本地与报告，采样子集只用于控制单请求规模。
      // 密集复核（frameCap 为 0）不采样——它的目的就是补充更多帧。有联系表时图片合并发送，逐帧仅留元数据。
      const payload = async (frameCap = 5, group = batch) => {
        const sampled = frameCap ? group.map(s => ({...s, evidenceFrames: sample(s.evidenceFrames, frameCap)})) : group;
        const frames = framePayload(directory, sampled, referenceFrames), sheets = await buildSheets(directory, frames, guard);
        return {...base(), shots: group.map(({id, startFrame, endFrameExclusive, startUs, endUs}) => ({id, startFrame, endFrameExclusive, startUs, endUs})), neighboringShots: run.shots.filter((s, i) => group.some(b => run.shots[i - 1]?.id === b.id || run.shots[i + 1]?.id === b.id)).map(({id, startFrame, endFrameExclusive, effective}) => ({id, startFrame, endFrameExclusive, frame: effective?.frame || null})), evidenceFrames: sheets ? frames.map(({dataUrl, imageRef, ...meta}) => meta) : frames, ...(sheets ? {sheets} : {})};
      };
      const parseBatch = (result, input, group = batch) => {
        const output = result.output;
        if (!output || Object.keys(output).some(k => !['annotations', 'subjects', 'issues'].includes(k)) || !Array.isArray(output.annotations) || output.annotations.length !== group.length) throw problem('逐镜分析响应数量或 schema 无效', 'batch_schema');
        const subjects = validateSubjects(output.subjects || [], {allowedFrames: input.evidenceFrames.map(f => f.frameIndex)}), issues = validateIssues(output.issues);
        if (!subjects.valid || !issues.valid) throw problem([...subjects.errors, ...issues.errors].join('；'), 'batch_schema');
        const catalog = new Map((run.subjects || []).map(s => [s.id, s]));
        for (const sub of subjects.value) {
          if (catalog.has(sub.id)) {if (catalog.get(sub.id).kind !== sub.kind) throw problem('模型试图改变已建立主体类型', 'subject_conflict');}
          else catalog.set(sub.id, sub);
        }
        const seen = new Set(), values = [];
        for (const entry of output.annotations) {
          const shot = group.find(s => s.id === entry.shotId);
          if (!shot || seen.has(entry.shotId) || Object.keys(entry).some(k => !['shotId', 'annotation'].includes(k))) throw problem('逐镜分析 ID 无效、重复或含未允许字段', 'batch_schema');
          seen.add(entry.shotId);
          const validation = validateAnnotation(entry.annotation, {allowedFrames: shot.evidenceFrames.map(f => f.frameIndex), subjectIds: catalog.keys(), shot});
          if (!validation.valid) throw problem(`${shot.id}：${validation.errors.join('；')}`, 'batch_schema');
          // Images contain no audio. Do not accept confident dialogue or invented transcriptions from this adapter.
          if (validation.value.audio?.trim() || validation.value.category === 'dialogue') throw problem(`${shot.id}：当前接口未提供音频，不能生成对白或对话类别`, 'unsupported_audio');
          values.push({shot, annotation: validation.value});
        }
        return {values, subjects: [...catalog.values()], issues: issues.value};
      };
      try {
        let input = await payload(), result = await invoke('analyzeBatch', input), parsed = parseBatch(result, input);
        const uncertain = parsed.values.filter(v => v.annotation.uncertainties?.length || v.annotation.cutSuggestions?.length).map(v => v.shot).filter(s => evidenceIndices(s, true).some(f => !s.evidenceFrames.some(e => e.frameIndex === f)));
        if (uncertain.length && calls < settings.maxCalls) {
          // 密集复核只重发不确定的镜头：已成功且确定的首轮语义原样保留，本次可选调用失败也不影响它们。
          try {
            await extract(projectId, runId, uncertain, {...opts, onProgress: undefined}, true);
            run = get(projectId, runId);
            const denseGroup = uncertain.map(s => run.shots.find(x => x.id === s.id));
            const denseInput = {...(await payload(0, denseGroup)), refinement: '追加密集帧后复核动作、切点及不确定项；仍不能判定时保留 unknown 和原因。'};
            const retry = await invoke('analyzeBatch', denseInput);
            const dense = parseBatch(retry, denseInput, denseGroup);
            const denseById = new Map(dense.values.map(v => [v.shot.id, v])), denseIds = new Set(denseById.keys());
            parsed = {...parsed, values: parsed.values.map(v => denseById.get(v.shot.id) || v), subjects: dense.subjects, issues: [...parsed.issues.filter(i => !i.shotId || !denseIds.has(i.shotId)), ...dense.issues]};
          } catch (error) {classifyFailure(error);parsed.issues.push(issue('dense_review_failed', `密集帧二次核查未完成：${error.message}`));}
        }
        guard();atomic(path.join(directory, 'batches', `${String(index).padStart(5, '0')}-${crypto.randomUUID().slice(0, 8)}.json`), {...provenance, shotIds: batch.map(s => s.id), ...result});
        // Save catalog before annotations so every subject reference resolves, retaining human overrides in updateShot.
        run = mutate(projectId, runId, guard, {subjects: parsed.subjects, quality});
        for (const {shot, annotation} of parsed.values) {
          guard();const local = [...parsed.issues.filter(i => i.shotId === shot.id), ...(annotation.uncertainties || []).map(message => issue('uncertain', message, {shotId: shot.id})), ...(annotation.cutSuggestions || []).map(s => issue('cut_suggestion', `源帧 ${s.frameIndex}：${s.action}；${s.reason}`, {shotId: shot.id}))];
          analysisStore.updateShot(projectId, runId, shot.id, {generated: annotation, status: local.length ? 'needs_review' : 'analyzed', issues: local}, {shotRevision: shot.shotRevision});completed++;
        }
        runIssues.push(...parsed.issues.filter(i => !i.shotId));
      } catch (error) {
        classifyFailure(error);
        for (const shot of batch) {guard();analysisStore.updateShot(projectId, runId, shot.id, {status: 'failed', issues: [issue(error.code || 'batch_failed', error.message, {shotId: shot.id, severity: 'error'})]}, {shotRevision: shot.shotRevision});}
      }
      mutate(projectId, runId, guard, {progress: Math.min(1, (index + batch.length) / Math.max(1, pending.length)), quality, issues: runIssues});
      opts.onProgress?.(Math.min(1, (index + batch.length) / Math.max(1, pending.length)), `逐镜分析 ${completed}/${run.shots.length}`);
    }
    run = get(projectId, runId);
    if (!run.shots.some(s => s.generated)) {const error = '全部逐镜语义分析失败，关键帧底稿仍保留，可检查模型配置后重试。';mutate(projectId, runId, guard, {status: 'failed', error, quality, issues: runIssues});throw problem(error, 'analysis_all_failed', 502);}
    return mutate(projectId, runId, guard, {progress: 1, quality, issues: runIssues});
  };
  const aspect = (width, height) => {let a = width, b = height;while (b) [a, b] = [b, a % b];return a ? `${width / a}:${height / a}` : '未知';};
  const reelbenchDoc = (run, media) => ({schemaVersion: 1, title: `项目 ${run.projectId} 拉片 ${run.id}`, source: media.original_name, lang: 'zh', meta: {durationSeconds: media.duration_us / 1e6, width: media.width, height: media.height, aspect: aspect(media.width, media.height), hasAudio: !!media.audio_codec, fps: media.fps_num / media.fps_den}, cast: run.subjects, seedCuts: run.shots.slice(1).map(s => s.startUs / 1e6), shots: run.shots.map((shot, i) => ({...(shot.effective || shot.generated || {}), id: shotNo(i), stableShotId: shot.id, start: shot.startUs / 1e6, end: shot.endUs / 1e6, seconds: Math.round((shot.endUs - shot.startUs) / 1e4) / 100, startFrame: shot.startFrame, endFrameExclusive: shot.endFrameExclusive, note: [shot.effective?.note, shot.endUs - shot.startUs < 300000 ? '源片短镜，待复核；不根据最小时长自动吞并。' : '', ...(shot.effective?.uncertainties || [])].filter(Boolean).join('；')}))});
  const validate = async (projectId, runId, opts = {}) => {
    const guard = guardFor(projectId, runId, opts);guard();
    let run = mutate(projectId, runId, guard, {stage: 'validate', progress: 0});const {media, pts} = metadata(projectId), directory = analysisStore.runDirectory(projectId, runId);
    const checks = [], check = (id, failures, skipped) => checks.push({id, status: skipped ? 'skipped' : failures.length ? 'failed' : 'passed', issues: failures, ...(skipped ? {reason: skipped} : {})});
    const semanticsUnavailable = run.status === 'blocked' && !run.shots.some(shot => shot.generated);
    const semanticSkipReason = '全片语义尚未分析：视觉模型未配置或暂不可用。此项未执行，不代表通过。';
    const semanticGates = new Set(['size', 'category', 'camera', 'transition', 'frame-text', 'dedup', 'subjects', 'category-evidence', 'motion', 'rhythm']);
    const timeErrors = [], evidenceErrors = [], semanticErrors = [];
    run.shots.forEach((shot, i) => {
      if (shot.startFrame !== (i ? run.shots[i - 1].endFrameExclusive : 0) || shot.endFrameExclusive <= shot.startFrame || shot.endFrameExclusive > pts.length || i === run.shots.length - 1 && shot.endFrameExclusive !== pts.length || shot.startUs !== Math.round(pts[shot.startFrame] * 1e6) || shot.endUs !== (shot.endFrameExclusive < pts.length ? Math.round(pts[shot.endFrameExclusive] * 1e6) : media.duration_us)) timeErrors.push(`${shot.id} 源帧/PTS 边界不连续或不精确`);
      if (!shot.evidenceFrames?.length) evidenceErrors.push(`${shot.id} 无关键帧`);
      for (const evidence of shot.evidenceFrames || []) if (evidence.frameIndex < shot.startFrame || evidence.frameIndex >= shot.endFrameExclusive || evidence.ptsUs !== Math.round(pts[evidence.frameIndex] * 1e6) || !jpeg(safe(directory, evidence.imageRef))) evidenceErrors.push(`${shot.id} 帧 ${evidence.frameIndex} 证据无效`);
      if (!semanticsUnavailable) {const validation = validateAnnotation(shot.effective || shot.generated, {allowedFrames: shot.evidenceFrames.map(f => f.frameIndex), subjectIds: run.subjects.map(s => s.id), shot});if (!validation.valid) semanticErrors.push(`${shot.id}：${validation.errors.join('；')}`);}
    });
    if (!run.shots.length) timeErrors.push('无镜头');
    check('source-frame-timeline', timeErrors);check('source-frame-evidence', evidenceErrors);check('annotation-schema', semanticErrors, semanticsUnavailable ? semanticSkipReason : undefined);
    const subjectCheck = validateSubjects(run.subjects, {allowedFrames: run.shots.flatMap(s => s.evidenceFrames.map(e => e.frameIndex))});check('subject-evidence', semanticsUnavailable ? [] : subjectCheck.errors, semanticsUnavailable ? semanticSkipReason : undefined);
    const exchange = reelbenchDoc(run, media), upstream = validateReelbench(exchange, {lang: 'zh'});
    for (const gate of upstream.gates) {
      if (gate.id === 'frames') {check('reelbench-frames', [], '使用精确源帧命名，已由 source-frame-evidence 检查代替上游 S01a.jpg 约定');continue;}
      if (semanticsUnavailable && semanticGates.has(gate.id)) {check(`reelbench-${gate.id}`, [], semanticSkipReason);continue;}
      // unknown is a supported local value with explicit evidence limits. Validate all known
      // values, but never count the incomplete upstream enum check as passed or malformed.
      if (['size', 'category', 'camera', 'rhythm'].includes(gate.id) && exchange.shots.some(s => s[gate.id] === 'unknown')) {
        const known = exchange.shots.filter(s => s[gate.id] !== 'unknown');
        const scoped = validateReelbench({...exchange, shots: known}, {lang: 'zh'}).gates.find(g => g.id === gate.id);
        const failures = scoped?.issues || [];
        check(`reelbench-${gate.id}`, failures, failures.length ? undefined : `${exchange.shots.length - known.length} 个镜头保留 unknown，等待视觉复核；其余 ${known.length} 个镜头已按上游词表检查，此项整体不计通过。`);
        continue;
      }
      check(`reelbench-${gate.id}`, gate.issues, gate.skipped || undefined);
    }
    check('visual-truth-human-review', [], '格式与引用检查不能证明视觉判断正确；需核看原片或人工参考');
    const validationIssues = checks.filter(c => c.status === 'failed').map(c => issue('validation_failed', `${c.id}：${c.issues.join('；').slice(0, 1600)}`, {severity: ['source-frame-timeline', 'source-frame-evidence'].includes(c.id) ? 'error' : 'warning'}));
    const quality = {...run.quality, engineChecks: checks, upstreamHints: semanticsUnavailable ? [] : upstream.hints, checksSummary: {passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length, skipped: checks.filter(c => c.status === 'skipped').length}};
    const retainedIssues = run.issues.filter(i => !['validation_failed', 'semantic_analysis_unavailable'].includes(i.code));
    if (semanticsUnavailable && !retainedIssues.some(i => i.code === 'provider_unconfigured')) retainedIssues.push(issue('semantic_analysis_unavailable', `全片 ${run.shots.length} 个镜头尚未完成语义分析。${run.error || '请配置可用视觉模型后重试。'}`, {severity: 'error'}));
    run = mutate(projectId, runId, guard, {quality, issues: [...retainedIssues, ...validationIssues], progress: 1});
    opts.onProgress?.(1, `校验通过 ${quality.checksSummary.passed}，失败 ${quality.checksSummary.failed}，跳过 ${quality.checksSummary.skipped}`);
    if (timeErrors.length || evidenceErrors.length) {mutate(projectId, runId, guard, {status: 'failed', error: [...timeErrors, ...evidenceErrors].join('；').slice(0, 2000)});throw problem('源帧时间或证据校验失败，不能发布拉片报告');}
    return run;
  };
  const report = async (projectId, runId, opts = {}) => {
    const guard = guardFor(projectId, runId, opts);guard();let run = get(projectId, runId);
    if (['cancelled', 'stale'].includes(run.status) || !run.quality?.engineChecks) throw problem('拉片尚未校验或已过期，不能发布报告');
    const directory = analysisStore.runDirectory(projectId, runId), {media} = metadata(projectId), doc = reelbenchDoc(run, media);
    const hasIssues = run.issues.length > 0 || run.shots.some(s => s.status === 'failed' || s.issues.length || s.status === 'pending') || run.quality.engineChecks.some(c => c.status !== 'passed');
    const terminalError = ['blocked', 'failed'].includes(run.status);
    run = {...run, status: terminalError ? run.status : hasIssues ? 'ready_with_issues' : 'ready', stage: 'done', progress: 1, artifactRef: 'report.json'};
    const htmlEscape = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
    const fileUrl = ref => `/api/studio/projects/${encodeURIComponent(projectId)}/shot-analysis/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(ref)}`;
    const semanticDraft = run.status === 'blocked' && !run.shots.some(s => s.generated);
    const markdownBody = semanticDraft ? ['## 原片镜头底稿', '', '全片语义尚未分析，景别、动作、运镜及主体识别相关检查均未执行。原片帧与证据检查按实际结果保留。', '', '| 镜头 | 起始源帧 | 结束源帧（不含） | 起始微秒 | 结束微秒 | 状态 |', '| --- | ---: | ---: | ---: | ---: | --- |', ...run.shots.map(s => `| ${s.id} | ${s.startFrame} | ${s.endFrameExclusive} | ${s.startUs} | ${s.endUs} | 未分析 |`), '', '## 检查记录', '', ...run.quality.engineChecks.map(c => `- ${c.id}：${c.status}${c.reason ? `；${c.reason}` : ''}${c.issues.length ? `；${c.issues.join('；')}` : ''}`)].join('\n') : renderReelbenchMd(doc, {lang: 'zh'});
    const lines = ['# 全片拉片结果', '', `状态：${run.status}；模型：${run.provider} / ${run.model}`, '', '**原片帧号与微秒时间为项目真值；上游交换表的两位小数仅用于显示。**', '', `校验：通过 ${run.quality.checksSummary.passed} / 失败 ${run.quality.checksSummary.failed} / 跳过 ${run.quality.checksSummary.skipped}。跳过不表示通过。`, '', '## 待修正项', '', ...[...run.issues, ...run.shots.flatMap(s => s.issues)].map(i => `- ${i.shotId || '全片'} [${i.code}] ${i.message}`), '', markdownBody];
    const rows = run.shots.map((s, i) => `<article id="${htmlEscape(s.id)}"><h2><button data-us="${s.startUs}">${shotNo(i)} · ${htmlEscape(s.id)}</button> <small>${s.startFrame}–${s.endFrameExclusive - 1} 帧 · ${s.startUs}–${s.endUs} µs · ${htmlEscape(s.status)}</small></h2><div class="frames">${s.evidenceFrames.map(e => `<a href="${fileUrl(e.imageRef)}"><img loading="lazy" alt="源帧 ${e.frameIndex}，${e.ptsUs} 微秒" src="${fileUrl(e.imageRef)}"><span>源帧 ${e.frameIndex} · ${e.ptsUs} µs</span></a>`).join('')}</div><dl>${['size', 'category', 'camera', 'frame', 'action', 'composition', 'scene', 'subjects'].map(field => `<dt>${field}</dt><dd>${htmlEscape(Array.isArray(s.effective?.[field]) ? s.effective[field].join(', ') : s.effective?.[field] || '未分析')}</dd>`).join('')}</dl><ul>${s.issues.map(x => `<li>${htmlEscape(x.message)}</li>`).join('')}</ul></article>`).join('');
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>全片拉片报告</title><style>body{font:16px/1.6 system-ui;max-width:1200px;margin:24px auto;padding:0 20px;background:#f8f8f4;color:#202520}video{width:100%;max-height:60vh;background:#000}article{border-top:1px solid #bcc8bb;margin-top:24px;padding-top:12px}.frames{display:flex;gap:8px;overflow:auto}.frames a{flex:0 0 180px;color:inherit}.frames img{width:180px}.frames span,small{font-size:12px}dt{font-weight:bold}dd{margin:0 0 8px}button{cursor:pointer}li{margin-bottom:6px}.notice{background:#fff4d2;padding:16px}</style><h1>全片拉片报告</h1><p class="notice">状态 ${run.status}。通过 ${run.quality.checksSummary.passed} / 失败 ${run.quality.checksSummary.failed} / 跳过 ${run.quality.checksSummary.skipped}。格式检查不等于视觉判断准确；所有未完成和不确定项留待统一修正。</p><p><a href="${fileUrl('report.json')}">下载精确时间 JSON</a> · <a href="${fileUrl('report.md')}">下载 Markdown</a></p><video controls preload="metadata" src="/api/studio/projects/${encodeURIComponent(projectId)}/media/preview"></video><h2>全片概览</h2><p>${htmlEscape(run.quality.overview?.summary || '概览未生成')}</p><h2>主体候选</h2><ul>${run.subjects.map(s => `<li>${htmlEscape(s.id)} [${htmlEscape(s.kind)}] ${htmlEscape(s.name)}：${htmlEscape(s.description)}${s.uncertain ? '（待确认）' : ''}</li>`).join('')}</ul><h2>校验记录</h2><ul>${run.quality.engineChecks.map(c => `<li>${htmlEscape(c.id)}：${htmlEscape(c.status)} ${htmlEscape(c.reason || c.issues.join('；'))}</li>`).join('')}</ul>${rows}<script>document.addEventListener('click',e=>{const b=e.target.closest('button[data-us]');if(b){const v=document.querySelector('video');v.currentTime=Number(b.dataset.us)/1e6;v.scrollIntoView({block:'center'});}});</script></html>`;
    guard();atomic(path.join(directory, 'report.json'), run);atomic(path.join(directory, 'report.md'), lines.join('\n'));atomic(path.join(directory, 'report.html'), html);atomic(path.join(directory, 'reelbench-shots.json'), doc);
    mutate(projectId, runId, guard, {status: run.status, stage: 'done', progress: 1, artifactRef: 'report.json', error: terminalError ? run.error : null});opts.onProgress?.(1, terminalError ? '拉片底稿和失败原因已保存；语义尚未完成' : '全片拉片报告已生成；待修正项集中保留');return get(projectId, runId);
  };
  return {frames, analyze, validate, report};
}
