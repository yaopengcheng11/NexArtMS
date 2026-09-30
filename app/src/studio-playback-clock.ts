/** Source timestamps are absolute; the browser's preview clock starts at zero. */
export function sourceTimeOrigin(ptsUs: unknown): number | null {
  if (!Array.isArray(ptsUs) || !ptsUs.length || !Number.isFinite(ptsUs[0])) return null;
  return Math.round(ptsUs[0]);
}

export function videoTimeToSourceUs(timeSeconds: number, originUs: number): number {
  return Math.round(timeSeconds * 1e6) + originUs;
}

export function sourceUsToVideoTime(timeUs: number, originUs: number, durationSeconds = Infinity): number {
  const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : Infinity;
  return Math.min(duration, Math.max(0, (timeUs - originUs) / 1e6));
}

export function playbackTimeLabel(timeSeconds: number): string {
  const hundredths = Math.floor(Math.max(0, timeSeconds) * 100);
  return `${Math.floor(hundredths / 6000)}:${String(Math.floor(hundredths / 100) % 60).padStart(2, '0')}.${String(hundredths % 100).padStart(2, '0')}`;
}
