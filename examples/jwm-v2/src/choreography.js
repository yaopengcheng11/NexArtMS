import { SHOTS, DURATION } from './shots.js';
export const FPS = 24;
export const CUT_FRAMES = SHOTS.map(s => Math.round(s.start * FPS));
export function shotIndexAt(t) {
  const frame = Math.min(Math.round(DURATION * FPS) - 1, Math.floor(Math.max(0, t) * FPS + 0.0001));
  let lo = 0, hi = CUT_FRAMES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (CUT_FRAMES[mid] <= frame) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, hi);
}
