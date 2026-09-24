export interface ComparisonState {
  frame: number;
  playing: boolean;
  ready: boolean;
  seeking: boolean;
  buffering: boolean;
  rate: number;
  audio: boolean;
  error: string | null;
}

interface ComparisonOptions {
  reference: HTMLVideoElement;
  rendered: HTMLVideoElement;
  fps: number;
  totalFrames: number;
  onChange: (state: ComparisonState) => void;
}

/** Owns both media elements. Consumers must use this clock for transport controls. */
export class ComparisonClock {
  private readonly reference: HTMLVideoElement;
  private readonly rendered: HTMLVideoElement;
  private readonly fps: number;
  private readonly lastFrame: number;
  private readonly onChange: ComparisonOptions['onChange'];
  private state: ComparisonState = {
    frame: 0, playing: false, ready: false, seeking: false,
    buffering: false, rate: 1, audio: false, error: null,
  };
  private disposed = false;
  private wantsPlayback = false;
  private generation = 0;
  private operation = new AbortController();
  private activeTask: Promise<void> = Promise.resolve();
  private raf: number | undefined;
  private frameCallback: number | undefined;
  private lastPresentedAt = -Infinity;
  private decodedReference = false;
  private decodedRendered = false;
  private removers: Array<() => void> = [];

  constructor(options: ComparisonOptions) {
    if (!Number.isFinite(options.fps) || options.fps <= 0 ||
        !Number.isInteger(options.totalFrames) || options.totalFrames < 1) {
      throw new Error('视频帧率和总帧数无效');
    }
    this.reference = options.reference;
    this.rendered = options.rendered;
    this.fps = options.fps;
    this.lastFrame = options.totalFrames - 1;
    this.onChange = options.onChange;
    for (const video of this.videos) {
      video.pause();
      video.muted = true;
      video.playbackRate = 1;
      for (const event of ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'progress', 'seeked']) {
        this.listen(video, event, () => this.refreshReady());
      }
      this.listen(video, 'waiting', () => this.recoverBuffer());
      this.listen(video, 'stalled', () => this.recoverBuffer());
      this.listen(video, 'ended', () => {
        if (this.wantsPlayback) {
          this.wantsPlayback = false;
          this.locate(this.lastFrame);
        }
      });
      this.listen(video, 'error', () => this.fail(new Error(
        `${video === this.reference ? '原片' : '三维视频'}加载失败${video.error?.message ? `：${video.error.message}` : ''}`,
      )));
    }
    // Let React finish installing the instance before the first notification.
    queueMicrotask(() => {
      if (this.disposed) return;
      this.refreshReady();
      if (this.videos.some(video => video.error)) {
        this.fail(new Error('对照视频加载失败，请重新载入'));
        return;
      }
      if (this.videos.some(video => video.currentTime !== 0)) this.locate(0);
      this.watchFrames();
      this.watchDrift();
    });
  }

  getState(): ComparisonState { return { ...this.state }; }

  async play(): Promise<void> {
    if (this.disposed) return;
    if (this.videos.some(video => video.error)) {
      this.fail(new Error('对照视频加载失败，请重新载入'));
      return;
    }
    this.wantsPlayback = true;
    this.publish({ error: null });
    if (this.state.playing || this.state.seeking || this.state.buffering) return this.activeTask;
    if (this.state.frame >= this.lastFrame || this.reference.ended || this.rendered.ended) {
      this.locate(0);
    } else {
      const token = this.newOperation();
      this.activeTask = this.run(token, () => this.start(token));
    }
    return this.activeTask;
  }

  pause(): void {
    if (this.disposed) return;
    this.wantsPlayback = false;
    this.locate(this.state.seeking ? this.state.frame : this.sourceFrame());
  }

  seekFrame(frame: number): void {
    if (this.disposed || !Number.isFinite(frame)) return;
    this.wantsPlayback = false;
    this.locate(this.clampFrame(frame));
  }

  setRate(rate: number): void {
    if (this.disposed || !Number.isFinite(rate)) return;
    const next = Math.min(4, Math.max(0.25, rate));
    this.reference.playbackRate = next;
    this.rendered.playbackRate = next;
    this.publish({ rate: next });
  }

  setAudio(enabled: boolean): void {
    if (this.disposed) return;
    this.reference.muted = !enabled;
    this.rendered.muted = true;
    this.publish({ audio: enabled });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlayback = false;
    this.operation.abort();
    this.generation++;
    this.stopMedia();
    if (this.raf !== undefined) cancelAnimationFrame(this.raf);
    if (this.frameCallback !== undefined) this.reference.cancelVideoFrameCallback?.(this.frameCallback);
    for (const remove of this.removers) remove();
    this.removers = [];
  }

  private get videos(): HTMLVideoElement[] { return [this.reference, this.rendered]; }

  private listen(video: HTMLVideoElement, event: string, callback: () => void): void {
    video.addEventListener(event, callback);
    this.removers.push(() => video.removeEventListener(event, callback));
  }

  private publish(patch: Partial<ComparisonState>): void {
    if (this.disposed) return;
    const changed = Object.entries(patch).some(([key, value]) => this.state[key as keyof ComparisonState] !== value);
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    this.onChange(this.getState());
  }

  private refreshReady(): void {
    if (this.disposed) return;
    this.decodedReference ||= this.reference.readyState >= 2;
    this.decodedRendered ||= this.rendered.readyState >= 2;
    this.publish({ ready: this.decodedReference && this.decodedRendered && !this.videos.some(video => video.error) });
  }

  private clampFrame(frame: number): number {
    return Math.min(this.lastFrame, Math.max(0, Math.round(frame)));
  }

  private sourceFrame(): number {
    return this.clampFrame(Math.floor(this.reference.currentTime * this.fps + 0.00001));
  }

  private current(token: number): boolean { return !this.disposed && token === this.generation; }

  private newOperation(): number {
    this.operation.abort();
    this.operation = new AbortController();
    return ++this.generation;
  }

  private stopMedia(): void {
    for (const video of this.videos) video.pause();
    this.rendered.playbackRate = this.state.rate;
  }

  private async run(token: number, task: () => Promise<void>): Promise<void> {
    try { await task(); }
    catch (error) { if (this.current(token)) this.fail(error); }
  }

  /** Seeks land inside the requested frame. New requests abort waits for older targets. */
  private locate(frame: number, buffering = false): void {
    const token = this.newOperation();
    this.stopMedia();
    this.publish({ frame, playing: false, seeking: true, buffering });
    this.activeTask = this.run(token, async () => {
      if (!await this.seekBoth(frame, token) || !this.current(token)) return;
      this.refreshReady();
      this.publish({ frame, seeking: false, buffering: false });
      if (this.wantsPlayback) await this.start(token);
    });
  }

  private async seekBoth(frame: number, token: number): Promise<boolean> {
    // Chrome can truncate a boundary seek to microseconds while a codec rounds
    // its presentation timestamp upward. Seek just inside the requested frame
    // so both decoders select it; UI time remains the nominal frame / fps.
    const target = frame / this.fps + Math.min(0.0001, 0.01 / this.fps);
    const reached = await Promise.all(this.videos.map(async video => {
      if (!await this.waitUntil(() => video.readyState >= 1, token)) return false;
      if (!this.current(token)) return false;
      // An equal seek need not dispatch seeked; avoid assigning it at all.
      if (Math.abs(video.currentTime - target) > 0.00001 || video.seeking) video.currentTime = target;
      return this.waitUntil(() => !video.seeking && video.readyState >= 2 &&
        Math.abs(video.currentTime - target) <= 0.001, token);
    }));
    return reached.every(Boolean);
  }

  private async start(token: number): Promise<void> {
    if (!this.current(token) || !this.wantsPlayback) return;
    const playable = () => this.videos.every(video => video.readyState >= 3 && !video.seeking);
    if (!playable()) this.publish({ buffering: true, playing: false });
    if (!await this.waitUntil(playable, token) || !this.current(token) || !this.wantsPlayback) return;
    this.reference.playbackRate = this.state.rate;
    this.rendered.playbackRate = this.state.rate;
    this.rendered.muted = true;
    const playback = Promise.all(this.videos.map(video => video.play()));
    // play() can remain pending during a network stall. Abort makes cleanup prompt.
    const signal = this.operation.signal;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<false>(resolve => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) resolve(false);
    });
    try {
      const started = await Promise.race([playback.then(() => true), cancelled]);
      if (!started || !this.current(token) || !this.wantsPlayback) {
        if (this.disposed || !this.wantsPlayback) this.stopMedia();
        return;
      }
      this.publish({ playing: true, buffering: false, seeking: false });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private recoverBuffer(): void {
    if (this.disposed || !this.wantsPlayback || this.state.seeking ||
        (this.state.buffering && this.videos.every(video => video.paused))) return;
    const frame = this.sourceFrame();
    const token = this.newOperation();
    this.stopMedia();
    this.publish({ frame, playing: false, buffering: true });
    this.activeTask = this.run(token, async () => {
      if (!await this.waitUntil(() => this.videos.every(video => video.readyState >= 3), token)) return;
      if (!this.current(token)) return;
      this.publish({ seeking: true });
      if (!await this.seekBoth(frame, token) || !this.current(token)) return;
      this.publish({ seeking: false });
      if (this.wantsPlayback) await this.start(token);
    });
  }

  private waitUntil(predicate: () => boolean, token: number): Promise<boolean> {
    if (!this.current(token)) return Promise.resolve(false);
    if (predicate()) return Promise.resolve(true);
    const signal = this.operation.signal;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setInterval>;
      let timeout: ReturnType<typeof setTimeout>;
      const events = ['loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough', 'seeked', 'progress'];
      const finish = (result: boolean, error?: Error) => {
        clearInterval(timer);
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        for (const video of this.videos) for (const event of events) video.removeEventListener(event, check);
        if (error) reject(error); else resolve(result);
      };
      const abort = () => finish(false);
      const check = () => {
        if (!this.current(token)) finish(false);
        else if (predicate()) finish(true);
      };
      signal.addEventListener('abort', abort, { once: true });
      for (const video of this.videos) for (const event of events) video.addEventListener(event, check);
      timer = setInterval(check, 40);
      timeout = setTimeout(() => finish(false, new Error('等待视频就绪超时，请重新载入视频')), 20000);
      check();
    });
  }

  private watchFrames(): void {
    if (typeof this.reference.requestVideoFrameCallback !== 'function') return;
    this.frameCallback = this.reference.requestVideoFrameCallback((_now, metadata) => {
      if (this.disposed) return;
      this.lastPresentedAt = performance.now();
      if (this.state.playing && !this.state.seeking) this.publish({ frame: this.clampFrame(metadata.mediaTime * this.fps) });
      this.watchFrames();
    });
  }

  private watchDrift(): void {
    if (this.disposed) return;
    if (this.state.playing) {
      // Hidden media can stop delivering presentation callbacks while still playing.
      if (typeof this.reference.requestVideoFrameCallback !== 'function' || performance.now() - this.lastPresentedAt > 100) {
        this.publish({ frame: this.sourceFrame() });
      }
      const drift = this.rendered.currentTime - this.reference.currentTime;
      if (Math.abs(drift) > 2 / this.fps) {
        this.locate(this.sourceFrame());
      } else {
        // Keep normal playback continuous. Only a large drift triggers a seek.
        const correction = Math.abs(drift) > 0.2 / this.fps ? Math.sign(drift) * 0.08 : 0;
        this.rendered.playbackRate = this.state.rate * (1 - correction);
      }
    }
    this.raf = requestAnimationFrame(() => this.watchDrift());
  }

  private fail(error: unknown): void {
    if (this.disposed) return;
    this.wantsPlayback = false;
    this.newOperation();
    this.stopMedia();
    const message = error instanceof Error ? error.message : String(error);
    this.publish({
      playing: false, seeking: false, buffering: false,
      ready: this.state.ready && !this.videos.some(video => video.error),
      error: message || '视频播放失败',
    });
  }
}
