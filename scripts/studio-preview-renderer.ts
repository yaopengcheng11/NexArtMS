import * as THREE from 'three';
import {createRigidCharacter} from '../src/rig';
import type {SampledFrame} from '../src/studio-timeline';

// Offline acceptance rendering consumes the exact snapshots in timeline.json.
// It does not run a second pose solver or interpolate across missing observations.
export function createPreviewRenderer(width: number, height: number) {
  const renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setSize(width, height);
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#e9ede5';
  document.body.appendChild(renderer.domElement);
  const status = document.createElement('div');
  status.style.cssText = 'position:fixed;left:18px;top:14px;padding:10px 14px;border-radius:6px;background:rgba(255,255,255,.9);color:#26382a;font:16px sans-serif;line-height:1.6;pointer-events:none';
  document.body.appendChild(status);
  const scene = new THREE.Scene();scene.background = new THREE.Color('#e9ede5');
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.01, 2000);
  scene.add(new THREE.HemisphereLight('#ffffff', '#8e987c', 2.7));
  const sun = new THREE.DirectionalLight('#fff5e7', 3);sun.position.set(-4, 7, 5);scene.add(sun);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({color: '#d6ddcf', roughness: 1}));
  floor.rotation.x = -Math.PI / 2;scene.add(floor);
  const grid = new THREE.GridHelper(20, 20, '#9db3a0', '#c3cfc2');
  (grid.material as THREE.Material).transparent = true;(grid.material as THREE.Material).opacity = .4;scene.add(grid);
  const rigs = new Map<string, ReturnType<typeof createRigidCharacter>>();
  let key = '';
  return (frame: Pick<SampledFrame, 'camera' | 'instances'> & {shotId?: string;ptsUs?: number;cameraNote?: string}) => {
    const nextKey = frame.instances.map(instance => `${instance.trackId}:${instance.character.proxyLevel}:${instance.character.scale}:${instance.character.color}`).join('|');
    if (nextKey !== key) {
      for (const rig of rigs.values()) {scene.remove(rig.group);rig.dispose();}
      rigs.clear();key = nextKey;
      for (const instance of frame.instances) {
        const rig = createRigidCharacter({id: instance.trackId, height: instance.character.scale, level: instance.character.proxyLevel, color: Number.parseInt(instance.character.color.slice(1), 16)});
        rigs.set(instance.trackId, rig);scene.add(rig.group);
      }
    }
    for (const instance of frame.instances) {
      const rig = rigs.get(instance.trackId)!;rig.group.visible = instance.visible;
      if (instance.visible && instance.pose) rig.applyPose(instance.pose);
    }
    if (frame.camera) {camera.fov = frame.camera.fov;camera.position.set(...frame.camera.position);camera.up.set(...frame.camera.up);camera.lookAt(...frame.camera.target);}
    camera.updateProjectionMatrix();renderer.render(scene, camera);
    const visible = frame.instances.filter(instance => instance.visible);
    status.textContent = `三维初稿 · ${frame.shotId || '空镜'} · ${((frame.ptsUs || 0) / 1e6).toFixed(2)} 秒\n已求解 ${visible.filter(instance => instance.quality === 'solved').length} · 站立占位 ${visible.filter(instance => instance.quality === 'placeholder').length} · ${frame.cameraNote || '默认相机'}`;
    status.style.whiteSpace = 'pre';
  };
}
