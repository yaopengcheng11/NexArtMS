// 人物检测与镜内跟踪。
// 计划 §9：识别模型须在 M0 基准与许可审查后固定版本；本模块先固定数据契约与
// 镜内跟踪算法（纯函数），检测器通过 registerDetector 接入。未配置模型时如实
// 报告不可用，不用样片数据冒充分析结果。

// 检测器契约：async detect({videoPath, frames}) → [{frame, box:{x,y,w,h}, confidence}]
// box 使用 0–1 归一化坐标。
const detectors = new Map();

export function registerDetector(name, detector, {version, licenseNote = ''} = {}) {
  detectors.set(name, {run: detector, version: version || name, licenseNote});
}

export function listDetectors() {
  return [...detectors.entries()].map(([name, entry]) => ({name, version: entry.version, licenseNote: entry.licenseNote}));
}

export function hasDetector() {
  return detectors.size > 0;
}

export async function runDetection(spec) {
  if (detectors.size === 0) {
    throw Object.assign(new Error('未配置人物检测模型：M2 的模型选型需在 M0 基准（召回、错配、速度、显存、许可证）完成后固定。'
      + '当前可改用人工补标：在镜头内手动标注出场候选。'), {status: 422});
  }
  const [name, entry] = detectors.entries().next().value;
  const detections = await entry.run(spec);
  return {detector: name, detectorVersion: entry.version, detections};
}

// ---- 镜内跟踪：贪心 IoU 匹配，帧间链接；跨切镜绝不自动承接。 ----
export function boxIoU(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 把逐帧人物框链接为镜内轨迹。
 * @param detections [{frame, box, confidence}] 帧号需在同一镜头内
 * @returns [{startFrame, endFrame, box, confidence, frames}]
 */
export function trackDetections(detections, {iouThreshold = 0.3, maxGapFrames = 2} = {}) {
  const byFrame = new Map();
  for (const detection of detections) {
    if (!byFrame.has(detection.frame)) byFrame.set(detection.frame, []);
    byFrame.get(detection.frame).push(detection);
  }
  const frames = [...byFrame.keys()].sort((a, b) => a - b);
  const tracks = []; // {startFrame, endFrame, box, confidence, lastSeen, boxes}
  const finished = [];
  for (const frame of frames) {
    const boxes = byFrame.get(frame);
    const unmatched = new Set(boxes.keys());
    // 贪心：按 IoU 从大到小匹配仍活跃的轨迹
    const pairs = [];
    boxes.forEach((detection, boxIndex) => {
      for (const track of tracks) {
        const iou = boxIoU(track.box, detection.box);
        if (iou >= iouThreshold) pairs.push({track, boxIndex, iou, detection});
      }
    });
    pairs.sort((a, b) => b.iou - a.iou);
    const usedTracks = new Set();
    for (const pair of pairs) {
      if (usedTracks.has(pair.track) || !unmatched.has(pair.boxIndex) || pair.track.lastSeen < frame - maxGapFrames - 1) continue;
      usedTracks.add(pair.track);
      unmatched.delete(pair.boxIndex);
      pair.track.box = pair.detection.box;
      pair.track.endFrame = frame;
      pair.track.lastSeen = frame;
      pair.track.confidence = Math.min(pair.track.confidence, pair.detection.confidence ?? 1);
      pair.track.observations.push(pair.detection);
    }
    boxes.forEach((detection, boxIndex) => {
      if (!unmatched.has(boxIndex)) return;
      unmatched.delete(boxIndex);
      const track = {startFrame: frame, endFrame: frame, box: detection.box, confidence: detection.confidence ?? 1, lastSeen: frame, observations: [detection]};
      tracks.push(track);
    });
    for (const track of [...tracks]) if (track.lastSeen < frame - maxGapFrames - 1) {tracks.splice(tracks.indexOf(track), 1);finished.push(track);}
  }
  finished.push(...tracks);
  return finished.map(track => ({
    startFrame: track.startFrame,
    endFrame: track.endFrame,
    box: roundBox(track.box),
    confidence: Number(track.confidence.toFixed(3)),
    representativeFrame: track.endFrame,
    observations: track.observations,
    appearance: track.observations.at(-1)?.appearance || null,
  })).sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
}

const roundBox = box => {
  const rounded = Object.fromEntries(Object.entries(box).map(([key, value]) => [key, Number(value.toFixed(4))]));
  return {x: rounded.x, y: rounded.y, w: Math.min(rounded.w, 1 - rounded.x), h: Math.min(rounded.h, 1 - rounded.y)};
};

// 从轨迹框生成观测记录（含逐帧观测占位与来源信息），写入项目 observations。
export function trackObservation({trackId, shotId, provenance, detector, detectorVersion, note = ''}) {
  return {trackId, shotId, provenance, detector, detectorVersion, note, kind: 'in-shot-person-track', coordinateSpace: 'normalized-0-1', generatedAt: new Date().toISOString()};
}
