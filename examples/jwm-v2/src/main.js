import { createViewer } from './scene.js';
import { shotIndexAt } from './choreography.js';
import { SHOTS, DURATION } from './shots.js';

const $ = (id) => document.getElementById(id);
const root = $('app');
const viewer = createViewer($('three-view'));
const video = $('reference-video');
const playButton = $('play-button');
const soundButton = $('sound-button');
const cameraButton = $('camera-button');
const comparisonButton = $('comparison-button');
const overlayButton = $('overlay-button');
const timeline = $('timeline');
const scrubber = $('scrubber');
const shotRows = $('shot-rows');
const speedSelect = $('speed-select');
const timeLabel = $('time-label');
const timeInput = $('time-input');
const currentShotLabel = $('current-shot');
const shotTitle = $('shot-title');
const shotDescription = $('shot-description');
const shotMeta = $('shot-meta');
const FPS = 24;
const FRAME_COUNT = Math.round(DURATION * FPS);
const LAST_FRAME = (FRAME_COUNT - 1) / FPS;
const SEEK_EPSILON = 0.00001;
const supportsPresentedFrames = typeof video.requestVideoFrameCallback === 'function';

let time = 0;
let playing = false;
let videoClockReady = false;
let videoFailed = false;
let soundEnabled = false;
let freeCamera = false;
let comparisonVisible = true;
let overlay = false;
let speed = 1;
let previousFrame = performance.now();
let lastShot = -1;
let presentedTime = null;
let pendingTarget = null;
let editingTime = false;

const cameraNames = { static: '固定机位', 'tilt-up': '上摇', 'pan-right': '向右摇' };
const sizeNames = { close: '特写', 'medium-close': '中近景', medium: '中景', 'medium-wide': '中远景', wide: '全景' };
const frameAt = (value) => Math.max(0, Math.min(FRAME_COUNT - 1, Math.round(value * FPS)));
const nearestFrameTime = (value) => frameAt(value) / FPS;
const shotStart = (shot) => Math.round(shot.start * FPS) / FPS + SEEK_EPSILON;

function format(t) {
  const seconds = Math.max(0, Math.min(DURATION, t));
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(2).padStart(5, '0');
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

function setTime(value, syncVideo = true) {
  if (!Number.isFinite(value)) return;
  time = nearestFrameTime(value);
  presentedTime = time;
  if (syncVideo && Number.isFinite(video.duration)) {
    pendingTarget = time;
    // The epsilon makes an exact cut select the first frame after the cut.
    video.currentTime = Math.min(time + SEEK_EPSILON, video.duration - SEEK_EPSILON);
  }
  viewer.render(time);
  updateUI(true);
}

function pause() {
  playing = false;
  video.pause();
  playButton.textContent = '▶ 播放';
  playButton.setAttribute('aria-label', '播放');
  root.classList.remove('is-playing');
}

async function play() {
  if (time >= LAST_FRAME - SEEK_EPSILON) setTime(0);
  playing = true;
  video.playbackRate = speed;
  video.muted = !soundEnabled;
  try {
    await video.play();
    videoClockReady = true;
  } catch (_) {
    playing = false;
    $('reference-state').textContent = '播放未启动，请再点一次播放。';
    return;
  }
  if (!playing) return;
  playButton.textContent = 'Ⅱ 暂停';
  playButton.setAttribute('aria-label', '暂停');
  root.classList.add('is-playing');
}

function stepFrame(direction) {
  pause();
  setTime((frameAt(time) + direction) / FPS);
}

function updateComparison() {
  root.classList.toggle('hide-comparison', !comparisonVisible);
  root.classList.toggle('overlay-mode', overlay);
  comparisonButton.textContent = comparisonVisible && !overlay ? '并排对照' : '显示对照';
  comparisonButton.setAttribute('aria-pressed', String(comparisonVisible && !overlay));
  overlayButton.setAttribute('aria-pressed', String(overlay));
  overlayButton.textContent = overlay ? '叠加中' : '叠加对齐';
  $('overlay-controls').hidden = !overlay;
  const target = overlay ? $('stage-frame') : $('reference-frame');
  if (video.parentElement !== target) target.prepend(video);
  $('view-state').textContent = overlay ? '原片叠加 · 镜头机位' : freeCamera ? '自由视角' : '镜头机位';
}

playButton.addEventListener('click', () => playing ? pause() : play());
$('restart-button').addEventListener('click', () => { pause(); setTime(0); });
$('previous-frame').addEventListener('click', () => stepFrame(-1));
$('next-frame').addEventListener('click', () => stepFrame(1));
timeInput.addEventListener('input', () => { editingTime = true; });
$('seek-form').addEventListener('submit', (event) => {
  event.preventDefault();
  pause();
  const requested = Number(timeInput.value);
  editingTime = false;
  setTime(requested);
  timeInput.value = time.toFixed(3);
});
soundButton.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  video.muted = !soundEnabled;
  soundButton.textContent = soundEnabled ? '原声开' : '原声关';
  soundButton.setAttribute('aria-pressed', String(soundEnabled));
});
cameraButton.addEventListener('click', () => {
  freeCamera = !freeCamera;
  if (freeCamera && overlay) overlay = false;
  viewer.setFreeCamera(freeCamera);
  cameraButton.textContent = freeCamera ? '自由视角' : '镜头机位';
  cameraButton.setAttribute('aria-pressed', String(freeCamera));
  updateComparison();
});
comparisonButton.addEventListener('click', () => {
  if (overlay || !comparisonVisible) { comparisonVisible = true; overlay = false; }
  else comparisonVisible = false;
  updateComparison();
});
overlayButton.addEventListener('click', () => {
  overlay = !overlay;
  comparisonVisible = true;
  if (overlay && freeCamera) {
    freeCamera = false;
    viewer.setFreeCamera(false);
    cameraButton.textContent = '镜头机位';
    cameraButton.setAttribute('aria-pressed', 'false');
  }
  updateComparison();
});
$('overlay-opacity').addEventListener('input', (event) => {
  root.style.setProperty('--reference-opacity', String(Number(event.target.value) / 100));
  $('overlay-value').value = `${event.target.value}%`;
});
speedSelect.addEventListener('change', () => {
  speed = Number(speedSelect.value);
  video.playbackRate = speed;
});

scrubber.max = String(FRAME_COUNT - 1);
scrubber.addEventListener('input', () => setTime(Number(scrubber.value) / FPS));
timeline.addEventListener('pointerdown', (event) => {
  const bounds = timeline.getBoundingClientRect();
  setTime((event.clientX - bounds.left) / bounds.width * DURATION);
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.code === 'Space') {
    event.preventDefault();
    playing ? pause() : play();
  } else if (event.code === 'ArrowRight' || event.code === 'ArrowLeft') {
    event.preventDefault();
    const direction = event.code === 'ArrowRight' ? 1 : -1;
    if (event.shiftKey) stepFrame(direction);
    else {
      const index = Math.max(0, Math.min(SHOTS.length - 1, shotIndexAt(time) + direction));
      setTime(shotStart(SHOTS[index]));
    }
  }
});

const segments = SHOTS.map((shot) => {
  const bar = document.createElement('div');
  bar.className = `shot-segment ${shot.subjects.length === 2 ? 'dual' : shot.subjects[0] === 'P1' ? 'orange' : 'blue'}`;
  bar.style.left = `${shot.start / DURATION * 100}%`;
  bar.style.width = `${(shot.end - shot.start) / DURATION * 100}%`;
  bar.title = `${shot.id} · ${format(shot.start)}–${format(shot.end)}`;
  timeline.append(bar);
  return bar;
});
const playhead = document.createElement('div');
playhead.className = 'playhead';
timeline.append(playhead);

const rows = SHOTS.map((shot) => {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'shot-row';
  const number = document.createElement('span');
  number.className = 'shot-row-number';
  number.textContent = shot.id;
  const body = document.createElement('span');
  body.className = 'shot-row-body';
  const size = document.createElement('strong');
  size.textContent = sizeNames[shot.size] || shot.size;
  const description = document.createElement('small');
  description.textContent = shot.frame;
  body.append(size, description);
  const start = document.createElement('span');
  start.className = 'shot-row-time';
  start.textContent = format(shotStart(shot));
  row.append(number, body, start);
  row.addEventListener('click', () => setTime(shotStart(shot)));
  shotRows.append(row);
  return row;
});

function updateUI(force = false) {
  const shotIndex = shotIndexAt(time + SEEK_EPSILON);
  const shot = SHOTS[shotIndex];
  const frameNumber = frameAt(time);
  timeLabel.textContent = `${format(time)} / ${format(DURATION)}`;
  $('frame-label').textContent = `第 ${frameNumber + 1} / ${FRAME_COUNT} 帧`;
  if (document.activeElement !== timeInput && !editingTime) timeInput.value = time.toFixed(3);
  scrubber.value = String(frameNumber);
  playhead.style.left = `${time / DURATION * 100}%`;
  root.dataset.mediaTime = time.toFixed(6);
  root.dataset.frame = String(frameNumber);
  root.dataset.syncMode = supportsPresentedFrames ? 'presented-frame' : 'video-time';
  if (shotIndex !== lastShot || force) {
    currentShotLabel.textContent = `${shot.id} / ${SHOTS.length}`;
    shotTitle.textContent = `${sizeNames[shot.size] || shot.size} · ${cameraNames[shot.camera] || shot.camera}`;
    shotDescription.textContent = shot.frame;
    shotMeta.textContent = `${format(shotStart(shot))}–${format(shot.end)} · ${(shot.end - shot.start).toFixed(2)} 秒 · ${shot.subjects.map((id) => id === 'P1' ? '橙色 P1' : '蓝色 P2').join(' + ')}`;
    if (lastShot >= 0) {
      segments[lastShot].classList.remove('active');
      rows[lastShot].classList.remove('active');
    }
    segments[shotIndex].classList.add('active');
    rows[shotIndex].classList.add('active');
    if (shotIndex !== lastShot) {
      const selected = rows[shotIndex];
      const top = selected.offsetTop - shotRows.offsetTop;
      if (top < shotRows.scrollTop || top + selected.offsetHeight > shotRows.scrollTop + shotRows.clientHeight) {
        shotRows.scrollTop = Math.max(0, top - shotRows.clientHeight / 2);
      }
    }
    lastShot = shotIndex;
  }
}

// mediaTime describes the frame actually being presented. currentTime follows
// the audio clock and can lead the visible image by a frame during playback.
function presentedFrame(_now, metadata) {
  const nextTime = Math.max(0, Math.min(LAST_FRAME, metadata.mediaTime));
  if (pendingTarget === null || Math.abs(nextTime - pendingTarget) < 0.5 / FPS) {
    pendingTarget = null;
    presentedTime = nextTime;
    time = nextTime;
    viewer.render(time);
    updateUI();
  }
  video.requestVideoFrameCallback(presentedFrame);
}
if (supportsPresentedFrames) video.requestVideoFrameCallback(presentedFrame);
video.addEventListener('loadedmetadata', () => {
  videoClockReady = true;
  setTime(time);
});
video.addEventListener('seeked', () => {
  if (!supportsPresentedFrames) {
    pendingTarget = null;
    time = nearestFrameTime(video.currentTime);
    presentedTime = time;
    viewer.render(time);
    updateUI(true);
  }
});
video.addEventListener('ended', () => {
  pendingTarget = null;
  time = LAST_FRAME;
  presentedTime = time;
  pause();
  viewer.render(time);
  updateUI(true);
});
video.addEventListener('error', () => {
  videoClockReady = false;
  videoFailed = true;
  $('reference-state').textContent = '原片预览无法载入。请通过项目的本地预览打开。';
});

function frame(now) {
  const delta = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000));
  previousFrame = now;
  if (playing && pendingTarget === null) {
    if (videoClockReady && !supportsPresentedFrames) time = Math.floor(video.currentTime * FPS) / FPS;
    else if (videoFailed) time = Math.min(LAST_FRAME, time + delta * speed);
    else if (presentedTime !== null) time = presentedTime;
    if (time >= LAST_FRAME && video.ended) pause();
  }
  viewer.render(time);
  updateUI();
  requestAnimationFrame(frame);
}

updateUI(true);
requestAnimationFrame(frame);
