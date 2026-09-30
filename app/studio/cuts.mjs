// 切镜检测：基于相邻呈现帧灰度直方图的卡方距离，自适应阈值 + 峰值抑制。
// 纯函数部分不依赖 FFmpeg，便于用合成签名测试；候选可由人工改切点覆盖。

// 两帧签名距离：16 桶直方图卡方距离（0=完全相同，1=完全不重叠）。
export function signatureDistance(a, b) {
  let total = 0;
  for (let index = 0; index < a.histogram.length; index++) {
    const sum = a.histogram[index] + b.histogram[index];
    if (sum > 0) {const diff = a.histogram[index] - b.histogram[index];total += (diff * diff) / sum;}
  }
  return total / 2;
}

export function computeScores(signatures) {
  const scores = new Array(signatures.length).fill(0);
  for (let index = 1; index < signatures.length; index++) scores[index] = signatureDistance(signatures[index - 1], signatures[index]);
  return scores;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 从帧距离分数中找硬切点。
 * @returns 排序后的切点数组（新镜头首个呈现帧的序号，不含 0）。
 */
export function detectCutsFromScores(scores, {
  absoluteFloor = 0.2,    // 低于此距离视为同镜内容（噪声/轻微运动）
  adaptiveFactor = 20,    // 自适应阈值 = 中位数 + factor × MAD（JWM 替身集上调优，见 reports/baseline-mixed-cut.json）
  minShotFrames = 2,      // 最短镜头长度：抑制闪白/单帧噪声
} = {}) {
  const count = scores.length;
  if (count < minShotFrames + 1) return [];
  const interior = scores.slice(1); // 帧 0 永远是第一镜首帧
  const base = median(interior);
  const deviations = interior.map(value => Math.abs(value - base));
  const mad = median(deviations) || 1e-6;
  const threshold = Math.max(absoluteFloor, base + adaptiveFactor * mad);
  const candidates = [];
  for (let frame = 1; frame < count; frame++) {
    const score = scores[frame];
    if (score < threshold) continue;
    const previous = scores[frame - 1] ?? -1;
    const next = scores[frame + 1] ?? -1;
    if (score < previous || score < next) continue; // 只取局部峰值
    candidates.push({frame, score});
  }
  // 峰值过密时视为闪白（切出又切回）：成对抵消，而不是保留一个错误切点；
  // 同时保证最小镜头长度。
  const cuts = [];
  for (const candidate of candidates) {
    const last = cuts[cuts.length - 1];
    if (last && candidate.frame - last.frame < minShotFrames) {
      // 两个切点间隔小于最短镜头 → 期间是一段闪帧，两个切点都取消。
      cuts.pop();
      continue;
    }
    cuts.push(candidate);
  }
  return cuts.map(cut => cut.frame);
}

export function cutsToShotBounds(cutFrames, frameCount) {
  const sorted = [...new Set(cutFrames)].filter(frame => Number.isInteger(frame) && frame > 0 && frame < frameCount).sort((a, b) => a - b);
  const bounds = [];
  let start = 0;
  for (const cut of sorted) {
    if (cut - start < 1) continue;
    bounds.push({startFrame: start, endFrameExclusive: cut});
    start = cut;
  }
  if (start < frameCount) bounds.push({startFrame: start, endFrameExclusive: frameCount});
  return bounds;
}

// 由带分数的切点生成置信度：分数相对阈值的富余程度。
export function cutsWithConfidence(cutFrames, scores, options) {
  return cutFrames.map(frame => {
    const score = scores[frame];
    return {frame, confidence: Math.max(0.5, Math.min(1, score / ((options?.absoluteFloor ?? 0.35) * 2.5)))};
  });
}
