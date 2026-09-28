// This module has no Node/browser dependencies: quality accounting and rendering
// must apply exactly the same validity contract to an artifact and its frames.
const JOINT_IDS = ['pelvis', 'neck', 'head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR'];
const vector3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const positive = value => Number.isFinite(value) && value > 0;
const id = value => typeof value === 'string' && value.length > 0;

export function isValidMotionFrame(frame) {
  return !!frame && Number.isInteger(frame.frame) && frame.frame >= 0
    && Number.isFinite(frame.timeS) && frame.timeS >= 0
    && vector3(frame.rootOffset)
    && JOINT_IDS.every(joint => vector3(frame.joints?.[joint]));
}

export function matchesMotionContext(motion, context) {
  return !!motion && !!context && Array.isArray(motion.frames)
    && id(context.trackId) && id(context.shotId) && id(context.characterId)
    && motion.trackId === context.trackId && motion.shotId === context.shotId && motion.characterId === context.characterId
    && positive(motion.bodyHeight) && positive(context.bodyHeight)
    && Math.abs(motion.bodyHeight - context.bodyHeight) <= 1e-9;
}
