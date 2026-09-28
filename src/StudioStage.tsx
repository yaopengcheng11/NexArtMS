import {useEffect, useRef, useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {createRigidCharacter, type CharacterLevel} from './rig';
import {usableCamera} from './studio-stage-math';
import {sampleAt} from './studio-timeline';
import {useStudioMotions} from './studio-motion-cache';
import type {CameraTrackInfo, ProjectDetail, ShotInfo, TrackInfo} from './studio';

// 三维确认视图：默认舞台（内置通用场景）+ 已归并角色（CL0–CL2）+ 逐镜相机。
// 角色落点由人物框与相机估计推得（单目尺度耦合），仅用于审查。

interface StageInstance {
  track: TrackInfo;
  characterColor: number;
  characterName: string;
  height: number;
  level: CharacterLevel;
}

function parseColor(color: string | undefined, fallback = 0x547a94): number {
  const parsed = Number.parseInt((color || '').replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function StageCanvas({detail, shot, mode, grid, camera}: {
  detail: ProjectDetail;
  shot: ShotInfo | undefined;
  mode: 'shot' | 'free' | 'top';
  grid: boolean;
  camera: CameraTrackInfo | undefined;
}) {
  const host = useRef<HTMLDivElement>(null);
  const motions = useStudioMotions(detail, shot?.id || '');

  const bindingByTrack = new Map(detail.bindings.map(row => [row.trackId, row]));
  const characterById = new Map(detail.characters.map(row => [row.id, row]));
  const instances: StageInstance[] = (shot ? detail.tracks.filter(track =>
    track.status === 'active' && track.subject !== 'animal' && track.shotId === shot.id && bindingByTrack.get(track.id)?.disposition === 'bound') : [])
    .map(track => {
      const character = characterById.get(bindingByTrack.get(track.id)?.characterId || '');
      return {track, characterColor: parseColor(character?.color), characterName: character?.name || '未命名角色', height: character?.scale || 1.75, level: character?.proxyLevel || 'CL1'};
    });

  useEffect(() => {
    const hostElement = host.current;
    if (!hostElement) return;
    const renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    hostElement.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#e9ede5');
    const viewCamera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 2000);
    viewCamera.position.set(0, 1.6, 5.5);
    const controls = new OrbitControls(viewCamera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 0.9, 0);
    scene.add(new THREE.HemisphereLight('#ffffff', '#8e987c', 2.7));
    const sun = new THREE.DirectionalLight('#fff5e7', 3);
    sun.position.set(-4, 7, 5);
    scene.add(sun);

    // 默认舞台：中性地面 + 参照网格 + 原点标记（与具体视频无关的通用场景）
    const stage = new THREE.Group();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({color: '#d6ddcf', roughness: 1}));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    stage.add(floor);
    const gridHelper = new THREE.GridHelper(20, 20, '#9db3a0', '#c3cfc2');
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.55;
    stage.add(gridHelper);    const originRing = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.34, 48), new THREE.MeshBasicMaterial({color: '#4d8061', side: THREE.DoubleSide}));
    originRing.rotation.x = -Math.PI / 2;
    originRing.position.y = 0.002;
    stage.add(originRing);
    const axis = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 1.75), new THREE.MeshBasicMaterial({color: '#b99a60'}));
    axis.position.set(-1.4, 0.01, 1.2);
    stage.add(axis);
    scene.add(stage);

    const characters = new THREE.Group();
    scene.add(characters);
    const rigs: ReturnType<typeof createRigidCharacter>[] = [];

    const resize = () => {
      const width = hostElement.clientWidth || 640;
      const aspect = detail.media?.width && detail.media?.height ? detail.media.width / detail.media.height : 16 / 9;
      const height = Math.round(width / aspect);
      renderer.setSize(width, height, false);
      viewCamera.aspect = width / height;
      viewCamera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(hostElement);
    resize();

    // 内容重建：角色 + 相机
    const rebuild = () => {
      for (const rig of rigs) {rig.dispose();characters.remove(rig.group);}
      rigs.length = 0;
      const sample = sampleAt(detail, motions, shot ? Math.floor((shot.startUs + shot.endUs) / 2) : 0);
      sample.instances.forEach(instance => {
        const rig = createRigidCharacter({id: `stage-${instance.trackId}`, color: parseColor(instance.character.color), height: instance.character.scale, level: instance.character.proxyLevel});
        rig.group.visible = instance.visible;
        if (instance.pose) rig.applyPose(instance.pose);
        characters.add(rig.group);
        rigs.push(rig);
      });
      gridHelper.visible = grid;
      // 相机模式
      if (mode === 'shot' && sample.camera) {
        const view = sample.camera;
        viewCamera.fov = view.fov;
        viewCamera.position.set(...view.position);
        viewCamera.up.set(...view.up);
        controls.target.set(...view.target);
        controls.enabled = false;
      } else {
        viewCamera.fov = 40;
        viewCamera.up.set(0, 1, 0);
        controls.enabled = true;
        if (mode === 'top') {
          const center = rigs.length ? rigs[0].bones.root.position : {x: 0, z: 0};
          viewCamera.position.set(center.x, 14, center.z + 0.01);
          controls.target.set(center.x, 0, center.z);
        } else {
          viewCamera.position.set(0, 1.6, 5.5);
          controls.target.set(0, 0.9, 0);
        }
      }
      viewCamera.updateProjectionMatrix();
      controls.update();
    };
    rebuild();

    let raf = 0;
    const animate = () => {controls.update();renderer.render(scene, viewCamera);raf = requestAnimationFrame(animate);};
    animate();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      for (const rig of rigs) rig.dispose();
      stage.traverse(child => {
        if (child instanceof THREE.Mesh) {child.geometry.dispose();(child.material as THREE.Material).dispose();}
      });
      characters.traverse(child => {
        if (child instanceof THREE.Mesh) {child.geometry.dispose();(child.material as THREE.Material).dispose();}
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, shot?.id, mode, grid, camera, instances.length, motions]);

  const legend = [...new Map(instances.map(instance => [instance.characterName + instance.characterColor, instance])).values()];
  return <div className="studio-stage-canvas" ref={host} data-level={instances.map(instance => instance.level).join(',')}>
    {instances.length === 0 && <div className="studio-stage-empty">当前镜头没有已归并的角色出场。</div>}
    {legend.map(entry => (
      <span key={entry.characterName + entry.characterColor} className="studio-stage-legend">
        <i style={{background: `#${entry.characterColor.toString(16).padStart(6, '0')}`}}/>{entry.characterName} · {entry.level}
      </span>
    ))}
  </div>;
}

export function StageSection({detail, selectedShotId, selectShot}: {
  detail: ProjectDetail;
  selectedShotId: string;
  selectShot: (id: string) => void;
}) {
  const [mode, setMode] = useState<'shot' | 'free' | 'top'>('free');
  const [grid, setGrid] = useState(true);
  const shot = detail.shots.find(item => item.id === selectedShotId) || detail.shots[0];
  const camera = detail.cameraTracks.filter(item => item.shotId === shot?.id).sort((a, b) => b.confidence - a.confidence)[0];
  const cameraUsable = usableCamera(camera ?? null);
  return <section className="studio-card" id="studio-stage">
    <div className="panel-title"><h2>角色与场景（三维确认）</h2><span>默认舞台 · CL0–CL2 代理角色 · 逐镜相机</span></div>
    <p className="muted">把已归并的角色放进内置默认舞台，按镜头检查走位、比例与相机。角色落点由人物框与相机估计推得——单目尺度耦合无法消除，这里仅用于审查，不是最终走位。</p>
    <div className="studio-toolbar">
      {detail.shots.length > 0 && <select aria-label="选择镜头" value={shot?.id || ''} onChange={event => selectShot(event.target.value)}>
        {detail.shots.map(item => <option key={item.id} value={item.id}>{item.id} · {((item.endUs - item.startUs) / 1e6).toFixed(2)}s</option>)}
      </select>}
      <span className="muted">档位按各角色保存的 CL0–CL2 配置显示</span>
      <div className="segmented" role="radiogroup" aria-label="视角">
        {([['shot', '镜头视角'], ['free', '自由观察'], ['top', '俯视走位']] as const).map(([value, label]) => <button key={value} className={mode === value ? 'chosen' : ''} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}
      </div>
      <label className="studio-tiny-toggle"><input type="checkbox" checked={grid} onChange={event => setGrid(event.target.checked)}/>参照网格</label>
    </div>
    {detail.shots.length === 0
      ? <p className="muted">还没有切镜结果；导入媒体并等待自动切镜完成后即可使用本视图。</p>
      : <div className="studio-stage-grid">
        <StageCanvas detail={detail} shot={shot} mode={mode} grid={grid} camera={camera}/>
        <div className="studio-stage-side">
          <img className="studio-stage-frame" src={`/api/studio/projects/${detail.project.id}/shots/${shot?.id}/preview`} alt={`${shot?.id} 原片中间帧`}/>
          <dl className="studio-stage-facts">
            <div><dt>镜头</dt><dd>{shot ? `${shot.id} · 帧 ${shot.startFrame}–${shot.endFrameExclusive - 1}` : '—'}</dd></div>
            <div><dt>相机</dt><dd>{camera
              ? cameraUsable
                ? `${camera.source === 'landmark-pnp' ? '地标 PnP' : '估计解'} · ${camera.medianErrorPx !== null ? `中位误差 ${camera.medianErrorPx}px` : '无重投影证据'}${camera.needsManualReview ? ' · 待人工确认' : ''}`
                : '仅有距离估计（无外参解）——使用默认观察视角'
              : '未求解——使用默认观察视角'}</dd></div>
            <div><dt>角色</dt><dd>{detail.characters.length ? detail.characters.map(character => character.name).join('、') : '尚未创建成片角色'}</dd></div>
          </dl>
          <p className="muted">「镜头视角」使用上表相机解（若可用）；角色带动作产物时按动作姿态摆放，否则为站立参考姿态。动作生成见下方“连续动作与交付”。</p>
        </div>
      </div>}
  </section>;
}
