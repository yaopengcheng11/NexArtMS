import test from 'node:test';
import assert from 'node:assert/strict';
import { ComparisonClock, type ComparisonState } from '../src/comparison-clock.ts';

// Media seek completion is controlled separately from assigning currentTime.
// This models the browser race that synchronous currentTime-only mocks miss.
class Video extends EventTarget {
  private time = 0;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  muted = false;
  playbackRate = 1;
  error: { message: string } | null = null;
  assignments: number[] = [];
  playCalls = 0;
  playResult: (() => Promise<void>) | undefined;
  automaticSeek = true;
  truncateMicroseconds = false;
  get currentTime(): number { return this.time; }
  set currentTime(value: number) {
    if (value === this.time && !this.seeking) return;
    this.time = this.truncateMicroseconds ? Math.floor(value * 1e6) / 1e6 : value;
    this.assignments.push(value);
    this.seeking = true;
    this.ended = false;
    if (this.automaticSeek) queueMicrotask(() => this.finishSeek());
  }
  advance(time: number): void { this.time = time; }
  finishSeek(): void {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    return this.playResult?.() ?? Promise.resolve();
  }
  pause(): void { this.paused = true; }
  event(name: string): void { this.dispatchEvent(new Event(name)); }
}

const settle = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); };

function assertFrame(video: Video, frame: number): void {
  assert.ok(video.currentTime >= frame / 24 && video.currentTime < (frame + 1) / 24,
    `${video.currentTime} must decode inside frame ${frame}`);
  assert.equal(Math.floor(video.currentTime * 24), frame);
}

function setup() {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = callback => { frames.set(++nextId, callback); return nextId; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const reference = new Video();
  const rendered = new Video();
  const states: ComparisonState[] = [];
  const clock = new ComparisonClock({
    reference: reference as unknown as HTMLVideoElement,
    rendered: rendered as unknown as HTMLVideoElement,
    fps: 24, totalFrames: 1203, onChange: state => states.push(state),
  });
  const tick = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(performance.now());
  };
  return { reference, rendered, states, clock, tick, frames };
}

test('initial/equal seek settles without seeked; frame seeks wait for both decoders and latest drag wins', async () => {
  const { reference, rendered, clock } = setup();
  try {
    await settle();
    assert.equal(clock.getState().ready, true);
    assert.equal(reference.muted, true);
    assert.equal(rendered.muted, true);
    clock.seekFrame(0);
    await settle();
    assert.equal(clock.getState().seeking, false);
    assertFrame(reference, 0);
    const assignments = reference.assignments.length;
    clock.seekFrame(0);
    await settle();
    assert.equal(clock.getState().seeking, false);
    assert.equal(reference.assignments.length, assignments, 'equal seek needs no seeked event');

    reference.automaticSeek = rendered.automaticSeek = false;
    clock.seekFrame(120);
    await settle();
    reference.finishSeek();
    await settle();
    assert.equal(clock.getState().seeking, true, 'one decoded video is insufficient');
    clock.seekFrame(480);
    clock.seekFrame(719);
    await settle();
    assert.equal(clock.getState().frame, 719);
    assertFrame(reference, 719);
    assertFrame(rendered, 719);
    rendered.finishSeek();
    await settle();
    assert.equal(clock.getState().seeking, true);
    reference.finishSeek();
    await settle();
    assert.equal(clock.getState().seeking, false);
    assert.equal(clock.getState().frame, 719);
    assert.equal(clock.getState().playing, false);
  } finally { clock.dispose(); }
});

test('playback corrects small drift without seeking, recovers large drift, and snaps pause to source frame', async () => {
  const { reference, rendered, clock, tick } = setup();
  try {
    await settle();
    await clock.play();
    reference.advance(1.01);
    rendered.advance(1.03);
    tick();
    assert.equal(rendered.assignments.length, 0, 'normal playback must remain continuous');
    assert.ok(rendered.playbackRate < reference.playbackRate);
    rendered.advance(1.3);
    tick();
    assert.equal(reference.paused, true);
    assert.equal(rendered.paused, true);
    await settle();
    assertFrame(reference, 24);
    assertFrame(rendered, 24);
    assert.equal(clock.getState().playing, true);

    reference.advance(2.076);
    rendered.advance(2.082);
    clock.pause();
    await settle();
    assertFrame(reference, 49);
    assertFrame(rendered, 49);
    assert.equal(clock.getState().frame, 49);
    assert.equal(clock.getState().playing, false);
  } finally { clock.dispose(); }
});

test('either video buffering pauses both and resumes only after readiness and synchronized seek', async () => {
  const { reference, rendered, clock } = setup();
  try {
    await settle();
    await clock.play();
    reference.advance(3.02);
    rendered.advance(2.99);
    rendered.readyState = 2;
    rendered.event('waiting');
    await settle();
    assert.equal(clock.getState().buffering, true);
    assert.equal(reference.paused, true);
    assert.equal(rendered.paused, true);
    rendered.readyState = 4;
    rendered.event('canplay');
    await settle();
    assert.equal(clock.getState().playing, true);
    assert.equal(clock.getState().buffering, false);
    assertFrame(reference, 72);
    assertFrame(rendered, 72);
  } finally { clock.dispose(); }
});

test('play rejection pauses both; audio is reference-only and end/replay respects last frame', async () => {
  const { reference, rendered, clock } = setup();
  try {
    await settle();
    rendered.playResult = () => Promise.reject(new Error('NotAllowedError'));
    await clock.play();
    assert.equal(reference.paused, true);
    assert.equal(rendered.paused, true);
    assert.match(clock.getState().error ?? '', /NotAllowedError/);
    rendered.playResult = undefined;
    clock.setAudio(true);
    assert.equal(reference.muted, false);
    assert.equal(rendered.muted, true);
    clock.setRate(0.5);
    await clock.play();
    assert.equal(reference.playbackRate, 0.5);
    reference.ended = true;
    reference.event('ended');
    await settle();
    assert.equal(clock.getState().frame, 1202);
    assertFrame(reference, 1202);
    assertFrame(rendered, 1202);
    assert.equal(clock.getState().playing, false);
    await clock.play();
    assertFrame(reference, 0);
    assertFrame(rendered, 0);
    assert.equal(clock.getState().playing, true);
  } finally { clock.dispose(); }
});

test('pause supersedes buffer recovery and dispose cancels pending seeks and future callbacks', async () => {
  const { reference, rendered, clock, states, frames, tick } = setup();
  await settle();
  await clock.play();
  reference.advance(4.1);
  rendered.readyState = 2;
  rendered.event('stalled');
  clock.pause();
  await settle();
  rendered.readyState = 4;
  rendered.event('canplay');
  await settle();
  assert.equal(clock.getState().playing, false);
  assert.equal(clock.getState().buffering, false);
  reference.automaticSeek = rendered.automaticSeek = false;
  clock.seekFrame(850);
  await settle();
  assert.equal(clock.getState().seeking, true);
  clock.dispose();
  const count = states.length;
  reference.finishSeek();
  rendered.finishSeek();
  reference.event('waiting');
  tick();
  await settle();
  assert.equal(states.length, count);
  assert.equal(frames.size, 0);
  assert.equal(reference.paused, true);
  assert.equal(rendered.paused, true);
});

test('disposing during pending play settles its promise without a late state update', async () => {
  const { reference, rendered, clock, states } = setup();
  await settle();
  let finish: (() => void) | undefined;
  rendered.playResult = () => new Promise<void>(resolve => { finish = resolve; });
  const pending = clock.play();
  await settle();
  clock.dispose();
  const count = states.length;
  await pending;
  finish?.();
  await settle();
  assert.equal(states.length, count);
  assert.equal(reference.paused, true);
  assert.equal(rendered.paused, true);
});

test('microsecond truncation cannot select the preceding decoded frame at fractional frame boundaries', async () => {
  const { reference, rendered, clock } = setup();
  try {
    await settle();
    reference.truncateMicroseconds = rendered.truncateMicroseconds = true;
    // Real Chrome/codec regressions: exact seeks selected 97, 661, and 1201.
    for (const frame of [98, 662, 1202]) {
      assert.equal(Math.floor((Math.floor(frame / 24 * 1e6) / 1e6) * 24), frame - 1,
        'the fixture must reproduce a truncated frame-boundary seek');
      clock.seekFrame(frame);
      await settle();
      assert.equal(clock.getState().seeking, false);
      assert.equal(clock.getState().frame, frame);
      assertFrame(reference, frame);
      assertFrame(rendered, frame);
    }
    reference.advance(662 / 24 + 0.001);
    clock.pause();
    await settle();
    assertFrame(reference, 662);
    assertFrame(rendered, 662);
  } finally { clock.dispose(); }
});
