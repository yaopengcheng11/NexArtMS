import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createRigidCharacter} from './rig';
import {sampleAt} from './studio-timeline';
import {useStudioMotions} from './studio-motion-cache';
import type {ProjectDetail} from './studio';

// 整片同步播放（V2 P3/R6）：以原片代理视频的时间为唯一时钟，
// 每帧经 sampleAt 采样三维状态；空镜正常播放，占位实例如实标注。

function parseColor(color: string | undefined, fallback = 0x547a94): number {
  const parsed = Number.parseInt((color || '').replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function StudioPlayback({detail}: {detail: ProjectDetail}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState({shotId: '—', t: '00:00.00', instances: 0, placeholders: 0, interpolated: 0, cameraEstimate: false});
  const [followShot, setFollowShot] = useState('');
  const motions = useStudioMotions(detail, followShot);
  const latest = useRef({detail, motions});
  latest.current = {detail, motions};

  useEffect(() => {
    const hostElement = hostRef.current;
    const video = videoRef.current;
    if (!hostElement || !video) return;
    const renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    hostElement.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9ede5');
    const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 2000);
    camera.position.set(0, 1.8, 6);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = false;
    controls.target.set(0, 0.9, 0);
    scene.add(new THREE.HemisphereLight('#ffffff', '#8e987c', 2.7));
    const sun = new THREE.DirectionalLight('#fff5e7', 3);
    sun.position.set(-4, 7, 5);
    scene.add(sun);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({color: '#d6ddcf', roughness: 1}));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const gridHelper = new THREE.GridHelper(20, 20, '#9db3a0', '#c3cfc2');
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.4;
    scene.add(gridHelper);

    const characters = new THREE.Group();
    scene.add(characters);
    const rigs = new Map<string, ReturnType<typeof createRigidCharacter>>();
    let lastInstanceKey = '';
    let raf = 0;
    let lastReport = 0;
    let previousShotId = '';

    const resize = () => {
      const width = hostElement.clientWidth || 640;
      const media = latest.current.detail.media;
      const aspect = media?.width && media?.height ? media.width / media.height : 16 / 9;
      const height = Math.round(width / aspect);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostElement);
    resize();

    const tick = () => {
      const ptsUs = Math.round(video.currentTime * 1e6);
      const {detail: currentDetail, motions: currentMotions} = latest.current;
      const sample = sampleAt(currentDetail, currentMotions, ptsUs);
      // 实例集合（trackId+级别+颜色）变化时重建骨架
      const key = sample.instances.map(instance => `${instance.trackId}:${instance.character.proxyLevel}:${instance.character.color}:${instance.character.scale}`).join('|');
      if (key !== lastInstanceKey) {
        lastInstanceKey = key;
        for (const [, rig] of rigs) {rig.dispose();characters.remove(rig.group);}
        rigs.clear();
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
      if (sample.camera) {
        camera.fov = sample.camera.fov;
        camera.position.set(...sample.camera.position);
        camera.up.set(...sample.camera.up);
        controls.target.set(...sample.camera.target);
        camera.lookAt(...sample.camera.target);
      }
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      const visible = sample.instances.filter(instance => instance.visible);
      hostElement.dataset.shotId = sample.shot?.id || '';
      hostElement.dataset.ptsUs = String(ptsUs);
      hostElement.dataset.visibleCount = String(visible.length);
      // solved = 有动作产物驱动的实例（观测/估计/插值），区别于站立占位
      hostElement.dataset.solvedCount = String(visible.filter(instance => instance.quality !== 'placeholder').length);
      hostElement.dataset.observedCount = String(visible.filter(instance => instance.provenance === 'observed').length);
      hostElement.dataset.interpolatedCount = String(visible.filter(instance => instance.provenance === 'interpolated').length);
      hostElement.dataset.estimatedCount = String(visible.filter(instance => instance.provenance === 'estimated').length);
      hostElement.dataset.placeholderCount = String(visible.filter(instance => instance.quality === 'placeholder').length);
      hostElement.dataset.renderSignature = JSON.stringify(visible.map(instance => [instance.trackId, instance.character.proxyLevel, instance.quality, instance.pose?.frame, instance.pose?.rootPosition, currentMotions[instance.trackId]?.artifactKey]));
      const shotId = sample.shot?.id || '';
      if (shotId !== previousShotId) {previousShotId = shotId;setFollowShot(shotId);}
      // 状态栏 4 次/秒，避免每帧 setState
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        const visible = sample.instances.filter(instance => instance.visible);
        const placeholders = visible.filter(instance => instance.quality === 'placeholder').length;
        const interpolated = visible.filter(instance => instance.provenance === 'interpolated').length;
        setStatus({shotId: sample.shot?.id || '—', t: `${Math.floor(ptsUs / 6e7)}:${String(Math.floor(ptsUs / 1e6) % 60).padStart(2, '0')}.${String(Math.floor(ptsUs / 1e4) % 100).padStart(2, '0')}`, instances: visible.length, placeholders, interpolated, cameraEstimate: sample.cameraIsEstimate});
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const [, rig] of rigs) rig.dispose();
      scene.traverse(child => {
        if (child instanceof THREE.Mesh) {child.geometry.dispose();(child.material as THREE.Material).dispose();}
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [detail.project.id]);

  return <div className="studio-playback">
    <div className="studio-playback-grid">
      <video ref={videoRef} className="studio-media-video" src={`/api/studio/projects/${detail.project.id}/media/preview`} controls preload="metadata"/>
      <div className="studio-stage-canvas" ref={hostRef}/>
    </div>
    <div className="studio-playback-status">
      <span>当前镜头 <b>{status.shotId}</b></span>
      <span>{status.t}</span>
      <span>可见实例 {status.instances}</span>
      <span className={status.placeholders ? 'studio-playback-warn' : ''}>占位 {status.placeholders}</span>
      <span>插值 {status.interpolated}</span>
      {status.cameraEstimate && <span className="studio-playback-warn">相机为估计值</span>}
      <span className="muted">时间以原片为准；切点间不做插值。</span>
    </div>
    <div className="studio-shot-strip">
      {detail.shots.map(shot => (
        <button key={shot.id}
          className={`studio-shot-card ${shot.id === status.shotId ? 'selected' : ''}`}
          onClick={() => {if (videoRef.current) {videoRef.current.pause();videoRef.current.currentTime = shot.startUs / 1e6;}}}>
          <span>{shot.id}</span>
          <small>{((shot.endUs - shot.startUs) / 1e6).toFixed(2)}s</small>
        </button>))}
    </div>
    <p className="muted">三维随原片时间采样，缺失动作区间显示站立占位。没有外参解的镜头使用固定默认相机；角色落点由人物框估计，等待统一修正。</p>
  </div>;
}
