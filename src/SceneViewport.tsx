import {useEffect,useRef} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {buildEnvironment,disposeObject} from './environment';
import type {SceneAsset} from './types';
export function SceneViewport({asset,shotId,mode,grid,onSelect}:{asset:SceneAsset;shotId:string;mode:'shot'|'free'|'top';grid:boolean;onSelect:(id:string)=>void}){
  const holder=useRef<HTMLDivElement>(null);
  const runtime=useRef<{renderer:THREE.WebGLRenderer;camera:THREE.PerspectiveCamera;controls:OrbitControls;scene:THREE.Scene;groundGrid:THREE.GridHelper;asset:SceneAsset}|null>(null);
  const selectRef=useRef(onSelect);selectRef.current=onSelect;
  useEffect(()=>{
    const host=holder.current!;const scene=new THREE.Scene();scene.background=new THREE.Color('#cad6da');scene.fog=new THREE.Fog('#cad6da',70,170);
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(1280,720,false);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.15;host.appendChild(renderer.domElement);
    const camera=new THREE.PerspectiveCamera(45,16/9,.05,250);camera.position.set(14,12,22);
    const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,1,0);controls.enableDamping=true;controls.minDistance=1;controls.maxDistance=110;
    scene.add(new THREE.HemisphereLight('#ffffff','#8c8d7c',2.5));const sun=new THREE.DirectionalLight('#fff5df',3);sun.position.set(-15,30,18);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-35,right:35,top:35,bottom:-35,near:.1,far:100});sun.shadow.bias=-.0002;scene.add(sun);
    const env=buildEnvironment(asset);scene.add(env.group);
    const groundGrid=new THREE.GridHelper(70,35,'#758780','#9ba39b');groundGrid.position.y=asset.terrain.baseY+.025;scene.add(groundGrid);
    const axes=new THREE.AxesHelper(2);axes.position.y=asset.terrain.baseY+.03;scene.add(axes);
    const ray=new THREE.Raycaster();const onPointer=(event:PointerEvent)=>{
      if(event.button!==0)return;const rect=renderer.domElement.getBoundingClientRect();ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);
      const hit=ray.intersectObjects(env.group.children,true)[0];let item:THREE.Object3D|null=hit?.object||null;while(item&&!item.userData.nodeId)item=item.parent;if(item?.userData.nodeId)selectRef.current(item.userData.nodeId);
    };
    renderer.domElement.addEventListener('pointerup',onPointer);
    runtime.current={renderer,camera,controls,scene,groundGrid,asset};
    let raf=0;const animate=()=>{controls.update();renderer.render(scene,camera);raf=requestAnimationFrame(animate);};animate();
    (window as any).__sceneProbe=()=>({actorCount:0,nodeCount:asset.nodes.length,sceneId:asset.id,sceneRevision:asset.revision,camera:camera.position.toArray(),worldTransforms:env.group.children.map(n=>({id:n.name,position:n.position.toArray(),quaternion:n.quaternion.toArray(),scale:n.scale.toArray()})),canvas:[renderer.domElement.width,renderer.domElement.height]});
    return()=>{cancelAnimationFrame(raf);renderer.domElement.removeEventListener('pointerup',onPointer);controls.dispose();disposeObject(scene);renderer.dispose();host.replaceChildren();runtime.current=null;delete(window as any).__sceneProbe;};
  },[asset]);
  useEffect(()=>{
    const r=runtime.current;if(!r)return;
    const spec=asset.cameras.find(c=>c.shotId===shotId)||asset.cameras[0];r.groundGrid.visible=grid;r.controls.enabled=mode!=='shot';
    if(mode==='shot'&&spec){r.camera.position.set(...spec.position);r.camera.fov=spec.fov;r.controls.target.set(...spec.target);r.camera.up.set(0,1,0);}
    else if(mode==='top'){r.camera.position.set(0,55,1);r.controls.target.set(0,0,0);r.camera.up.set(0,0,-1);r.camera.fov=48;}
    else{r.camera.position.set(9,7,10);r.controls.target.set(-3,1,-5);r.camera.up.set(0,1,0);r.camera.fov=48;}
    r.camera.lookAt(r.controls.target);r.camera.updateProjectionMatrix();r.controls.update();
  },[asset,shotId,mode,grid]);
  return <div className="canvas-host" ref={holder}/>;
}
