/** Source timestamps are absolute; the served preview can retain a leading video offset. */
export function sourceTimeOrigin(ptsUs: unknown): number | null {
  if (!Array.isArray(ptsUs) || !ptsUs.length || !Number.isFinite(ptsUs[0])) return null;
  return Math.round(ptsUs[0]);
}

/** Match corresponding first frames instead of assuming the preview's first frame is at zero. */
export function playbackTimeOrigin(playback: unknown): number | null {
  if (!playback || typeof playback !== 'object') return null;
  const {sourceOriginUs, mediaOriginUs} = playback as {sourceOriginUs?: unknown; mediaOriginUs?: unknown};
  if (typeof sourceOriginUs !== 'number' || !Number.isFinite(sourceOriginUs)
    || typeof mediaOriginUs !== 'number' || !Number.isFinite(mediaOriginUs)) return null;
  return Math.round(sourceOriginUs) - Math.round(mediaOriginUs);
}

export function videoTimeToSourceUs(timeSeconds: number, sourceOffsetUs: number): number {
  return Math.round(timeSeconds * 1e6) + sourceOffsetUs;
}

export function sourceUsToVideoTime(timeUs: number, sourceOffsetUs: number, durationSeconds = Infinity): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : Infinity;
  return Math.min(duration, Math.max(0, (timeUs - sourceOffsetUs) / 1e6));
}

export function playbackTimeLabel(timeSeconds: number): string {
  const hundredths = Math.floor(Math.max(0, timeSeconds) * 100);
  return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}
