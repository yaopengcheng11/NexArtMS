import type {MotionFrame} from '../src/studio-stage-math';

export interface MotionContext {
  trackId: string;
  shotId: string;
  characterId: string;
  bodyHeight: number;
}
export function isValidMotionFrame(frame: unknown): frame is MotionFrame;
export function matchesMotionContext(motion: unknown, context: MotionContext): boolean;
