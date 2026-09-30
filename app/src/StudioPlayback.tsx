import {useEffect, useRef, useState, type RefObject} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createRigidCharacter} from './rig';
import {sampleAt, shotAt} from './studio-timeline';
import {useStudioMotions} from './studio-motion-cache';
import {playbackTimeLabel, playbackTimeOrigin, sourceUsToVideoTime, videoTimeToSourceUs} from './studio-playback-clock';
import {StudioShotStrip} from './StudioShotStrip';
import type {ProjectDetail} from './studio';
import './studio-playback-workspace.css';

type ViewMode = 'shot' | 'free' | 'top';
interface PlaybackStatus {
  shotId: string;
  shotIndex: number;
  time: string;
  placeholders: number;
  missingPeople: number;
  cameraNote: string;
}
interface PlaybackProps {
  detail: ProjectDetail;
  active?: boolean;
  playbackPosition?: {timeUs: number; requestId: number};
  onPositionChange?: (position: {timeUs: number; shotId?: string}) => void;
}

function parseColor(color: string | undefined, fallback = 0x547a94): number {
  const parsed = Number.parseInt((color || '').replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Mounted only in the visible workspace, so hidden pages keep no renderer or motion polling. */
function PlaybackViewport({detail, videoRef, originUs, mode, onStatus, onPositionChange}: {
  detail: ProjectDetail;
  videoRef: RefObject<HTMLVideoElement | null>;
  originUs: number;
  mode: ViewMode;
  onStatus: (status: PlaybackStatus) => void;
  onPositionChange: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [followShot, setFollowShot] = useState(() => shotAt(detail.shots, videoTimeToSourceUs(videoRef.current?.currentTime || 0, originUs)).shot?.id || '');
  const [renderError, setRenderError] = useState('');
  const motions = useStudioMotions(detail, followShot);
  const latest = useRef({detail, motions, mode, originUs, onStatus, onPositionChange});
  latest.current = {detail, motions, mode, originUs, onStatus, onPositionChange};

  useEffect(() => {
    const hostElement = hostRef.current;
    const video = videoRef.current;
    if (!hostElement || !video) return;
    let renderer: THREE.WebGLRenderer;
    try {renderer = new THREE.WebGLRenderer({antialias: true});}
    catch {setRenderError('当前浏览器无法显示三维画面，原片仍可观看。');return;}
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    hostElement.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#141920');
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 2000);
    camera.position.set(0, 1.8, 6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.9, 0);
    controls.enableDamping = true;
    scene.add(new THREE.HemisphereLight('#ffffff', '#687487', 2.7));
    const sun = new THREE.DirectionalLight('#fff5e7', 3);
    sun.position.set(-4, 7, 5);
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({color: '#202833', roughness: 1}));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.GridHelper(20, 20, '#68778c', '#354151');
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.4;
    scene.add(grid);
    const characters = new THREE.Group();
    scene.add(characters);
    const rigs = new Map<string, ReturnType<typeof createRigidCharacter>>();
    let lastInstanceKey = '', previousShotId = '', previousView = '';
    let raf = 0, lastReport = 0;
    const clearRigs = () => {
      for (const rig of rigs.values()) {characters.remove(rig.group);rig.dispose();}
      rigs.clear();
    };
    const resize = () => {
      const width = hostElement.clientWidth || 640;
      const media = latest.current.detail.media;
      const aspect = media?.width && media?.height ? media.width / media.height : 16 / 9;
      renderer.setSize(width, Math.round(width / aspect), false);
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostElement);
    resize();

    const tick = () => {
      const {detail: currentDetail, motions: currentMotions, originUs: origin, mode: currentMode} = latest.current;
      const ptsUs = videoTimeToSourceUs(video.currentTime, origin);
      latest.current.onPositionChange();
      const sample = sampleAt(currentDetail, currentMotions, ptsUs);
      const key = sample.instances.map(instance => `${instance.trackId}:${instance.character.proxyLevel}:${instance.character.color}:${instance.character.scale}`).join('|');
      if (key !== lastInstanceKey) {
        lastInstanceKey = key;
        clearRigs();
        for (const instance of sample.instances) {
          const rig = createRigidCharacter({id: `play-${instance.trackId}`, color: parseColor(instance.character.color), height: instance.character.scale, level: instance.character.proxyLevel});
          characters.add(rig.group);
          rigs.set(instance.trackId, rig);
        }
      }
      for (const instance of sample.instances) {
        const rig = rigs.get(instance.trackId);
        if (!rig) continue;
        rig.group.visible = instance.visible;
        if (instance.visible && instance.pose) rig.applyPose(instance.pose);
      }
      const visible = sample.instances.filter(instance => instance.visible);
      controls.enabled = currentMode !== 'shot';
      controls.enableRotate = currentMode === 'free';
      if (currentMode === 'shot' && sample.camera) {
        camera.fov = sample.camera.fov;
        camera.position.set(...sample.camera.position);
        camera.up.set(...sample.camera.up);
        controls.target.set(...sample.camera.target);
        camera.lookAt(...sample.camera.target);
      } else if (`${currentMode}:${sample.shot?.id}` !== previousView) {
        const center = visible[0]?.pose?.rootPosition || [0, 0, 0];
        camera.fov = 40;
        camera.up.set(...(currentMode === 'top' ? [0, 0, -1] : [0, 1, 0]) as [number, number, number]);
        camera.position.set(center[0] + (currentMode === 'top' ? 0 : 4), currentMode === 'top' ? 15 : 3.5, center[2] + (currentMode === 'top' ? 0 : 6));
        controls.target.set(center[0], currentMode === 'top' ? 0 : 0.9, center[2]);
        camera.lookAt(controls.target);
      }
      previousView = `${currentMode}:${sample.shot?.id}`;
      if (controls.enabled) controls.update();
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      hostElement.dataset.shotId = sample.shot?.id || '';
      hostElement.dataset.ptsUs = String(ptsUs);
      hostElement.dataset.visibleCount = String(visible.length);
      hostElement.dataset.solvedCount = String(visible.filter(instance => instance.quality !== 'placeholder').length);
      hostElement.dataset.observedCount = String(visible.filter(instance => instance.provenance === 'observed').length);
      hostElement.dataset.interpolatedCount = String(visible.filter(instance => instance.provenance === 'interpolated').length);
      hostElement.dataset.estimatedCount = String(visible.filter(instance => instance.provenance === 'estimated').length);
      hostElement.dataset.placeholderCount = String(visible.filter(instance => instance.quality === 'placeholder').length);
      hostElement.dataset.renderSignature = JSON.stringify(visible.map(instance => [instance.trackId, instance.character.proxyLevel, instance.quality, instance.pose?.frame, instance.pose?.rootPosition, currentMotions[instance.trackId]?.artifactKey]));
      const shotId = sample.shot?.id || '';
      if (shotId !== previousShotId) {previousShotId = shotId;setFollowShot(shotId);}
      const now = performance.now();
      if (!lastReport || now - lastReport > 250) {
        lastReport = now;
        const cameraTrack = currentDetail.cameraTracks.filter(item => item.shotId === shotId).sort((a, b) => b.confidence - a.confidence)[0];
        const ignoredPeople = new Set((currentDetail.people || []).filter(person => person.assignment === 'ignored').flatMap(person => person.trackIds));
        const visibleTracks = currentDetail.tracks.filter(track => {
          const binding = currentDetail.bindings.find(item => item.trackId === track.id);
          if (binding?.disposition === 'ignored' || (!binding && ignoredPeople.has(track.id))) return false;
          return track.status === 'active' && track.subject !== 'animal' && track.shotId === shotId && ptsUs >= track.startUs && ptsUs < track.endUs;
        });
        latest.current.onStatus({shotId, shotIndex: sample.index, time: playbackTimeLabel(video.currentTime),
          placeholders: visible.filter(instance => instance.quality === 'placeholder').length,
          missingPeople: visibleTracks.filter(track => !visible.some(instance => instance.trackId === track.id)).length,
          cameraNote: sample.cameraIsEstimate ? cameraTrack?.source === 'person-track-dolly' ? '运镜为估计' : '使用默认相机' : cameraTrack?.needsManualReview ? '相机待核对' : ''});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      clearRigs();
      scene.traverse(child => {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [detail.project.id, videoRef]);

  return <div className="studio-stage-canvas studio-playback-canvas" ref={hostRef} style={{aspectRatio: `${detail.media?.width || 16} / ${detail.media?.height || 9}`, maxWidth: `${56 * (detail.media?.width || 16) / (detail.media?.height || 9)}vh`}}>
    {renderError && <p className="studio-playback-unavailable" role="status">{renderError}</p>}
  </div>;
}
export function StudioPlayback({detail, active = true, playbackPosition, onPositionChange}: PlaybackProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [mode, setMode] = useState<ViewMode>('free');
  const [retry, setRetry] = useState(0);
  const [videoError, setVideoError] = useState(false);
  const [clock, setClock] = useState<{key: string; originUs: number | null; error: string}>({key: '', originUs: null, error: ''});
  const [status, setStatus] = useState<PlaybackStatus>({shotId: '', shotIndex: -1, time: '0:00.00', placeholders: 0, missingPeople: 0, cameraNote: ''});
  const mediaKey = `${detail.project.id}:${detail.media?.id || ''}`;
  const proxyVersion = detail.jobs.filter(job => job.kind === 'proxy').map(job => `${job.id}:${job.state}`).join('|');
  const originUs = clock.key === mediaKey ? clock.originUs : null;
  const current = useRef({detail, active, originUs, playbackPosition, onPositionChange});
  current.current = {detail, active, originUs, playbackPosition, onPositionChange};
  const analysis = detail.shotAnalysis && !detail.shotAnalysis.candidate && detail.shotAnalysis.mediaHash === detail.media?.sha256 ? detail.shotAnalysis : null;
  const stripItems = detail.shots.map(shot => {
    const analyzed = analysis?.shots.find(item => item.id === shot.id && item.startUs === shot.startUs && item.endUs === shot.endUs);
    const evidence = analyzed?.evidenceFrames[0];
    const thumbnail = evidence ? evidence.url || `/api/studio/projects/${encodeURIComponent(detail.project.id)}/shot-analysis/${encodeURIComponent(analysis!.id)}/file?path=${encodeURIComponent(evidence.imageRef)}` : undefined;
    return {id: shot.id, index: shot.idx, startUs: shot.startUs, endUs: shot.endUs, thumbnail,
      description: analyzed?.effective?.action || analyzed?.effective?.frame};
  });

  useEffect(() => {
    const controller = new AbortController();
    setClock({key: mediaKey, originUs: null, error: ''});
    void fetch(`/api/studio/projects/${detail.project.id}/media/pts`, {signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error('读取视频时间信息失败');
        const result = await response.json();
        const origin = playbackTimeOrigin(result.playback);
        if (origin === null) throw new Error(result.playbackError || '视频时间信息尚未就绪');
        if (!controller.signal.aborted) setClock({key: mediaKey, originUs: origin, error: ''});
      }).catch(error => {if (!controller.signal.aborted) setClock({key: mediaKey, originUs: null, error: (error as Error).message});});
    return () => controller.abort();
  }, [mediaKey, detail.project.id, detail.media?.ptsCount, proxyVersion, retry]);

  const publishPosition = () => {
    const {detail: latestDetail, active: isActive, originUs: origin, onPositionChange: publish} = current.current;
    const video = videoRef.current;
    if (!isActive || !video || origin === null) return;
    const timeUs = videoTimeToSourceUs(video.currentTime, origin);
    const shot = shotAt(latestDetail.shots, timeUs).shot;
    publish?.({timeUs, shotId: shot?.id});
  };
  const seek = (timeUs: number) => {
    const video = videoRef.current;
    const origin = current.current.originUs;
    if (!video || origin === null || !Number.isFinite(timeUs)) return;
    video.pause();
    video.currentTime = sourceUsToVideoTime(timeUs, origin, video.duration);
    publishPosition();
  };
  const restorePosition = () => {
    const {active: isActive, playbackPosition: position} = current.current;
    if (isActive && position) seek(position.timeUs);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!active) {video?.pause();return;}
    restorePosition();
  }, [active, playbackPosition?.requestId, originUs, mediaKey]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {video?.pause();};
  }, [mediaKey]);
  useEffect(() => {setVideoError(false);}, [mediaKey, proxyVersion]);

  const hasActiveTracks = detail.tracks.some(track => track.status === 'active' && track.subject !== 'animal');

  return <div className="studio-playback studio-playback-workspace" data-active={active}>
    <div className="studio-playback-grid">
      <div className="studio-playback-pane">
        <div className="studio-playback-pane-label"><b>原片</b></div>
        <video ref={videoRef} className="studio-media-video" src={`/api/studio/projects/${detail.project.id}/media/preview?media=${encodeURIComponent(detail.media?.id || '')}`} controls preload="metadata"
          style={{aspectRatio: `${detail.media?.width || 16} / ${detail.media?.height || 9}`}} aria-label="三维还原原片预览"
          onTimeUpdate={publishPosition} onSeeked={publishPosition} onPause={publishPosition} onLoadedMetadata={restorePosition}
          onError={() => setVideoError(true)} onLoadedData={() => setVideoError(false)}
          onPlay={() => {if (!current.current.active) videoRef.current?.pause();}}/>
        {videoError && <p className="studio-playback-source-error" role="alert">原片预览暂不可播放。<button onClick={() => {videoRef.current?.load();setRetry(value => value + 1);}}>重载视频</button></p>}
      </div>
      <div className="studio-playback-pane">
        <div className="studio-playback-pane-label"><b>三维初稿</b><span>近似还原</span></div>
        {active && originUs !== null
          ? <PlaybackViewport detail={detail} videoRef={videoRef} originUs={originUs} mode={mode} onStatus={setStatus} onPositionChange={publishPosition}/>
          : <div className="studio-stage-canvas studio-playback-canvas"><div className="studio-playback-unavailable" role="status">
              {active ? clock.key === mediaKey && clock.error ? <>{clock.error}，三维同步暂不可用。<button onClick={() => setRetry(value => value + 1)}>重试</button></> : '正在读取视频时间信息…' : '切回此页后继续查看'}
            </div></div>}
      </div>
    </div>
    <div className="studio-playback-toolbar">
      <div className="studio-playback-status" aria-live="off">
        <b>{status.shotIndex >= 0 ? `第 ${status.shotIndex + 1} 镜` : '等待镜头'}</b><span>{status.time}</span>
        {!hasActiveTracks && <span className="studio-playback-warn">尚无可还原的人物结果</span>}
        {status.placeholders > 0 && <span className="studio-playback-warn">{status.placeholders} 人缺少动作，暂用站立占位</span>}
        {status.missingPeople > 0 && <span className="studio-playback-warn">{status.missingPeople} 人尚未还原</span>}
        {status.cameraNote && <span className="studio-playback-warn">{status.cameraNote}</span>}
      </div>
      <label className="studio-playback-view">视角<select aria-label="三维观察视角" value={mode} onChange={event => setMode(event.target.value as ViewMode)}>
        <option value="shot">镜头视角</option><option value="free">自由观察</option><option value="top">俯视</option>
      </select></label>
    </div>
    <StudioShotStrip items={stripItems} selectedId={status.shotId} onSelect={item => seek(item.startUs)} disabled={originUs === null} scopeLabel="全部镜头" emptyMessage="镜头尚未生成，请查看处理状态。"/>
  </div>;
}
