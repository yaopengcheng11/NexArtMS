import {useEffect,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
import {createRigidCharacter} from './rig';

export function RigLab({embedded=false,color=0xd9773e}:{embedded?:boolean;color?:number}={}){
  const host=useRef<HTMLDivElement>(null);const action=useRef<(v:boolean)=>void>(()=>{});const[pose,setPose]=useState(false);
  useEffect(()=>{
    setPose(false);
    const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setSize(1280,600,false);renderer.shadowMap.enabled=true;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;host.current!.appendChild(renderer.domElement);
    const scene=new THREE.Scene();scene.background=new THREE.Color('#e9ede5');const camera=new THREE.PerspectiveCamera(32,1280/600,.01,100);camera.position.set(0,2,8.3);camera.lookAt(0,.9,0);
    const controls=new OrbitControls(camera,renderer.domElement);controls.target.set(0,.9,0);controls.enableDamping=true;
    scene.add(new THREE.HemisphereLight('#ffffff','#8e987c',2.7));const light=new THREE.DirectionalLight('#fff5e7',3);light.position.set(-3,6,5);light.castShadow=true;scene.add(light);
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(30,30),new THREE.MeshStandardMaterial({color:'#d6ddcf',roughness:1}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
    const rigs=(['CL0','CL1','CL2'] as const).map((level,i)=>{const rig=createRigidCharacter({id:`lab-${level}`,height:1.75,color,level});rig.group.position.x=(i-1)*2.2;scene.add(rig.group);return rig;});
    setPose(false);
    action.current=(active)=>{for(const rig of rigs){rig.resetPose();if(active)rig.applyPose({rotations:{forearm_L:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),-1.35).toArray(),upperArm_R:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),.45).toArray(),shin_L:new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),-.6).toArray()}});}};
    (window as any).__exportRig=async()=>{
      const rig=createRigidCharacter({id:'probe',height:1.75,color:0xd9773e,level:'CL2'});const skin=rig.toSkinnedMesh();const exportScene=new THREE.Scene();exportScene.add(skin);
      const values=[0,.7,0].flatMap(angle=>new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),angle).toArray());
      const clip=new THREE.AnimationClip('probe_elbow_48frames',47/24,[new THREE.QuaternionKeyframeTrack(`${rig.bones.forearm_L.name}.quaternion`,[0,23/24,47/24],values)]);
      const buffer=await new GLTFExporter().parseAsync(exportScene,{binary:true,animations:[clip],onlyVisible:false});
      rig.dispose();const bytes=new Uint8Array(buffer as ArrayBuffer);let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);
    };
    (window as any).__rigProbe=()=>({counts:rigs.map(r=>({level:r.level,bones:Object.keys(r.bones).length,parts:r.looks[r.level].length})),actors:'Synthetic technical fixtures; not approved production characters'});
    let raf=0;const animate=()=>{controls.update();renderer.render(scene,camera);raf=requestAnimationFrame(animate);};animate();
    return()=>{cancelAnimationFrame(raf);controls.dispose();rigs.forEach(r=>r.dispose());floor.geometry.dispose();floor.material.dispose();renderer.dispose();host.current?.replaceChildren();delete(window as any).__rigProbe;delete(window as any).__exportRig;};
  },[color]);
  const content=<>{!embedded&&<><a href="/">← 返回空场景工作台</a><span className="eyebrow" style={{display:'block',marginTop:28}}>M0 / 角色结构技术验证</span><h1>一套骨架，三种表达</h1><p className="lab-description">这是验证关节、档位与导出结构的合成小人。正式原片角色将在场景确认后制作。</p></>}<div className="lab-actions"><button onClick={()=>{action.current(false);setPose(false);}}>标准 T Pose</button><button onClick={()=>{action.current(true);setPose(true);}}>检查屈肘与屈膝</button><span className="lab-description">{pose?'相同关节动作：CL1 保留整体肢体方向，CL2 表现肘膝细节':'三档共享固定身高、比例和关节定义'}</span></div><div className="canvas-host" style={{aspectRatio:'1280 / 600'}} ref={host}/><div className="lab-levels"><span>CL0 · 轮廓与重心</span><span>CL1 · 主要肢体</span><span>CL2 · 关节与末梢</span></div><p className="lab-description">22 个骨架节点；可见部件分别为 2／6／27。模型使用刚性父子绑定；导出时自动生成单骨 100% 权重。此页不代表原片动作已去抖，也不替代用户的角色确认。</p></>;
  return embedded?<section className="lab lab-embedded">{content}</section>:<main className="lab">{content}</main>;
}
