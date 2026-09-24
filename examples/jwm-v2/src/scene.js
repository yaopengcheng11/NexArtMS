import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { shotIndexAt, FPS } from './choreography.js';
import DATA from './pose-data.json';
import BACKGROUND from './background-data.json';

// Source coordinates are the animation authority. Depth is a bounded estimate;
// changing it never changes the original camera's projected joint locations.
const H = 4, W = H * 16 / 9, TILT = 0.29;
const UP = new THREE.Vector3(0, Math.cos(TILT), -Math.sin(TILT));
const FORWARD = new THREE.Vector3(0, Math.sin(TILT), Math.cos(TILT));
const Y = new THREE.Vector3(0, 1, 0);
const vec = (u,v,d=0) => new THREE.Vector3((u-.5)*W,0,0).addScaledVector(UP,(.5-v)*H).addScaledVector(FORWARD,d);
const clamp = THREE.MathUtils.clamp;
const sphereGeo = new THREE.SphereGeometry(1, 16, 12);
const cylinderGeo = new THREE.CylinderGeometry(1,1,1,12);
const cubeGeo = new THREE.BoxGeometry(1,1,1);

function mesh(parent, geometry, material) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m); return m;
}
function cylinder(m, a, b, radius, taper=1) {
  const delta = new THREE.Vector3().subVectors(b,a);
  m.position.copy(a).add(b).multiplyScalar(.5);
  m.quaternion.setFromUnitVectors(Y, delta.clone().normalize());
  m.scale.set(radius,Math.max(.0001,delta.length()),radius*taper);
}
export function buildPuppet(scene, color) {
  const group = new THREE.Group(); scene.add(group);
  const mat = new THREE.MeshStandardMaterial({color,roughness:.74,metalness:0});
  const jointMat = new THREE.MeshStandardMaterial({color:new THREE.Color(color).multiplyScalar(.88),roughness:.8});
  const bones = [[5,7],[7,9],[6,8],[8,10],[11,13],[13,15],[12,14],[14,16]];
  const limbs = bones.map(()=>mesh(group,cylinderGeo,mat));
  const joints = Array.from({length:17},()=>mesh(group,sphereGeo,jointMat));
  const torso = mesh(group,sphereGeo,mat), pelvis=mesh(group,sphereGeo,mat);
  const clavicle=mesh(group,cylinderGeo,mat),hipBar=mesh(group,cylinderGeo,mat);
  const neck = mesh(group,cylinderGeo,mat), head=mesh(group,sphereGeo,mat);
  const feet = [mesh(group,sphereGeo,mat),mesh(group,sphereGeo,mat)];
  const hands = [mesh(group,sphereGeo,mat),mesh(group,sphereGeo,mat)];
  function apply(actor) {
    group.visible = !!actor;
    if (!actor) return;
    const k = actor.j;
    const size = actor.scale * H;
    const canShadow = actor.j[15]?.[1]<1.03 || actor.j[16]?.[1]<1.03;
    group.traverse(o=>{if(o.isMesh)o.castShadow=canShadow;});
    const projected = k.map(p=>p && p[2]>0 ? vec(p[0],p[1],0):null);
    const depth = Array(k.length).fill(0);
    const side = actor.facing || 1;
    const shoulderWidth = projected[5] && projected[6] ? projected[5].distanceTo(projected[6]) : size*.55;
    const sideDepth = Math.sqrt(Math.max(0,(size*.62)**2-shoulderWidth**2))*.5;
    for (const index of [5,11]) depth[index] = sideDepth*side;
    for (const index of [6,12]) depth[index] = -sideDepth*side;
    const addDepth = (a,b,length,sign)=>{
      if(projected[a] && projected[b]) depth[b] = depth[a] + sign*Math.sqrt(Math.max(0,length*length-projected[a].distanceToSquared(projected[b])))*.7;
    };
    addDepth(5,7,size*.70,.8); addDepth(7,9,size*.64,1);
    addDepth(6,8,size*.70,-.8); addDepth(8,10,size*.64,1);
    addDepth(11,13,size*.91,.7); addDepth(13,15,size*.91,-.6);
    addDepth(12,14,size*.91,-.7); addDepth(14,16,size*.91,.6);
    // Forearms and fists are in front of the chest in the filmed guards.
    for(const i of [7,8,9,10]) depth[i]=Math.max(depth[i],size*(i>8?.32:.18));
    let rootDepth=actor.depth||0;
    for(let i=0;i<projected.length;i++)if(projected[i]) {
      const padding=size*(i===0?.23:i>=5?.10:0);
      rootDepth=Math.max(rootDepth,(-2+padding-projected[i].y)/FORWARD.y-depth[i]);
    }
    const p = projected.map((v,i)=>v ? v.addScaledVector(FORWARD,rootDepth+depth[i]):null);
    const valid = i=>!!p[i];
    for(let n=0;n<bones.length;n++) {
      const [a,b]=bones[n]; const m=limbs[n]; m.visible=valid(a)&&valid(b);
      if(m.visible) cylinder(m,p[a],p[b],size*(n<4?.082:.115));
    }
    joints.forEach((m,i)=>{
      m.visible=i>=5&&valid(i);
      if(m.visible) {m.position.copy(p[i]);m.scale.setScalar(size*(i>=11?.118:.087));}
    });
    const fullTorso = [5,6,11,12].every(valid);
    torso.visible=pelvis.visible=clavicle.visible=hipBar.visible=fullTorso;
    if(fullTorso) {
      cylinder(clavicle,p[5],p[6],size*.115);
      cylinder(hipBar,p[11],p[12],size*.15);
      const top=p[5].clone().add(p[6]).multiplyScalar(.5);
      const bottom=p[11].clone().add(p[12]).multiplyScalar(.5);
      const axis=top.clone().sub(bottom), length=axis.length();
      const right=p[6].clone().sub(p[5]);
      if(right.lengthSq()<.0001)right.set(1,0,0);right.normalize();
      const z=new THREE.Vector3().crossVectors(right,axis).normalize();
      const x=new THREE.Vector3().crossVectors(axis,z).normalize();
      const rotation=new THREE.Matrix4().makeBasis(x,axis.clone().normalize(),z);
      torso.quaternion.setFromRotationMatrix(rotation);
      torso.position.copy(top).add(bottom).multiplyScalar(.5);
      torso.scale.set(size*.31,length*.61,size*.21);
      pelvis.position.copy(bottom);pelvis.quaternion.copy(torso.quaternion);
      pelvis.scale.set(size*.29,size*.19,size*.21);
    }
    head.visible=valid(0);neck.visible=valid(0)&&valid(5)&&valid(6);
    if(head.visible) {
      const shoulders=valid(5)&&valid(6)?p[5].clone().add(p[6]).multiplyScalar(.5):p[0].clone().addScaledVector(UP,-size*.6);
      let center=p[0].clone();
      if(valid(3)&&valid(4)&&k[3][2]>.3&&k[4][2]>.3) center.copy(p[3]).add(p[4]).multiplyScalar(.5);
      else if(valid(1)&&valid(2)&&k[1][2]>.3&&k[2][2]>.3) center.copy(p[1]).add(p[2]).multiplyScalar(.5).addScaledVector(UP,-size*.02);
      const axis=center.clone().sub(shoulders).normalize();
      center.addScaledVector(axis,-size*.045);
      let radius=size*.215;
      if(valid(1)&&valid(2)&&k[1][2]>.5&&k[2][2]>.5) radius=clamp(p[1].distanceTo(p[2])*1.6,size*.20,size*.37);
      head.position.copy(center);head.quaternion.setFromUnitVectors(Y,axis);
      head.scale.set(radius,radius*1.28,radius*.96);
      cylinder(neck,shoulders,center,size*.064);
    }
    feet.forEach((m,i)=>{
      const ankle=15+i,knee=13+i;
      m.visible=valid(ankle);if(!m.visible)return;
      let to;
      if(k[17+i]) to=vec(k[17+i][0],k[17+i][1],rootDepth+depth[ankle]);
      else {
        const shift=new THREE.Vector3(side*size*.16,-size*.045,0);
        if(valid(knee)) {
          const leg=p[ankle].clone().sub(p[knee]).normalize();
          shift.addScaledVector(leg,size*.04);
        }
        to=p[ankle].clone().add(shift).addScaledVector(FORWARD,size*.11);
      }
      m.position.copy(p[ankle]).add(to).multiplyScalar(.5);
      m.quaternion.setFromUnitVectors(Y,to.clone().sub(p[ankle]).normalize());
      m.scale.set(size*.098,Math.max(size*.13,p[ankle].distanceTo(to)*.7),size*.078);
    });
    hands.forEach((m,i)=>{const idx=9+i;m.visible=valid(idx);if(m.visible){m.position.copy(p[idx]);m.scale.set(size*.105,size*.125,size*.10);}});
  }
  return { apply, group };
}

function addBox(parent,mat,x,y,z,w,h,d) {
  const m=mesh(parent,cubeGeo,mat);m.position.set(x,y,z);m.scale.set(w,h,d);return m;
}
function makeTomb(parent,bounds,depth,mat,edge) {
  const [u,v,w,h]=bounds, group=new THREE.Group();parent.add(group);
  group.position.copy(vec(u+w/2,v+h,depth));group.rotation.x=-TILT;
  const width=w*W,height=h*H;
  const unit=Math.min(width/4.8,height/1.7);
  group.scale.set(width/4.8,height/1.7,unit);
  // Low enclosing grave wall, stepped central stele and curved shoulder walls.
  addBox(group,edge,0,.075,0,4.9,.15,.55);
  addBox(group,mat,0,.17,0,4.65,.12,.44);
  addBox(group,mat,0,.71,0,4.5,1.04,.17);
  const contour=[[-2.25,1.12],[-1.85,1.16],[-1.4,1.23],[-1,1.3],[-.58,1.4],[-.33,1.57],[0,1.68],[.33,1.57],[.58,1.4],[1,1.3],[1.4,1.23],[1.85,1.16],[2.25,1.12]];
  for(let i=1;i<contour.length;i++) {
    const a=new THREE.Vector3(contour[i-1][0],contour[i-1][1],.04),b=new THREE.Vector3(contour[i][0],contour[i][1],.04);
    const cap=mesh(group,cylinderGeo,edge);cylinder(cap,a,b,.067);cap.scale.z=.11;
  }
  const shape=new THREE.Shape();shape.moveTo(-2.25,.85);for(const [x,y]of contour)shape.lineTo(x,y);shape.lineTo(2.25,.85);shape.closePath();
  mesh(group,new THREE.ExtrudeGeometry(shape,{depth:.18,bevelEnabled:false}),mat);
  for(const sign of[-1,1]) {
    addBox(group,edge,sign*2.17,.72,.07,.16,1.08,.26);
    const ball=mesh(group,sphereGeo,edge);ball.position.set(sign*2.17,1.34,.04);ball.scale.setScalar(.12);
    addBox(group,edge,sign*1.26,.68,.14,1.31,.70,.06);
    addBox(group,mat,sign*1.26,.68,.181,1.16,.56,.035);
  }
  addBox(group,edge,0,.86,.16,.77,1.26,.12);
  addBox(group,mat,0,.87,.235,.54,1.05,.04);
}
function buildBackdrop(scene) {
  const group=new THREE.Group();scene.add(group);
  const clay=new THREE.MeshStandardMaterial({color:0xe7e5df,roughness:1});
  const hillMat=new THREE.MeshStandardMaterial({color:0xc7ccc7,roughness:1,flatShading:true,side:THREE.DoubleSide});
  const wall=new THREE.MeshStandardMaterial({color:0xd9ddda,roughness:.96});
  const edge=new THREE.MeshStandardMaterial({color:0xbec6c2,roughness:.9});
  let current=-1,lastFrame=-1,hillGeometry=null;
  function update(index,spec,frame) {
    if(frame===lastFrame)return;lastFrame=frame;
    const liveSky=BACKGROUND.frames[frame]?.skyline;
    if(index===current && hillGeometry && liveSky) {
      const attribute=hillGeometry.attributes.position;
      for(let row=0;row<6;row++)for(let i=0;i<liveSky.length;i++) {
        const [u,v]=liveSky[i],uvY=v+(1.7-v)*row/5;
        const p=vec(u,uvY,-9+row*.75+Math.sin(i*1.4+row*1.7)*.22);
        attribute.setXYZ(row*liveSky.length+i,p.x,p.y,p.z);
      }
      attribute.needsUpdate=true;hillGeometry.computeVertexNormals();
      return;
    }
    current=index;
    while(group.children.length) { const c=group.children[0];group.remove(c);c.traverse(n=>{if(n.geometry&&![cubeGeo,cylinderGeo,sphereGeo].includes(n.geometry))n.geometry.dispose();}); }
    const groundUV=spec.groundY ?? .78;
    const farZ=(-2*Math.cos(TILT)-(.5-groundUV)*H)/Math.sin(TILT);
    const nearZ=18;
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(100,nearZ-farZ),clay);
    ground.rotation.x=-Math.PI/2;ground.position.set(0,-2,(nearZ+farZ)/2);ground.receiveShadow=true;group.add(ground);
    const skyline=liveSky||spec.skyline||[[0,.25],[.3,.23],[.6,.16],[1,.27]];
    const points=[]; const indices=[];
    for(let row=0;row<6;row++) for(let i=0;i<skyline.length;i++) {
      const [u,v]=skyline[i];
      const uvY=v+(1.7-v)*row/5;
      const depth=-9+row*.75+Math.sin(i*1.4+row*1.7)*.22;
      const p=vec(u,uvY,depth);points.push(p.x,p.y,p.z);
    }
    for(let row=0;row<5;row++)for(let i=0;i<skyline.length-1;i++) {
      const a=row*skyline.length+i,b=a+1,c=a+skyline.length,d=c+1;indices.push(a,c,b,b,c,d);
    }
    const geom=new THREE.BufferGeometry();geom.setAttribute('position',new THREE.Float32BufferAttribute(points,3));geom.setIndex(indices);geom.computeVertexNormals();
    hillGeometry=geom;
    const hills=mesh(group,geom,hillMat);hills.castShadow=false;
    const tombBounds=index===29?[[0,.55,.29,.36]]:spec.tombs||[];
    for(const bounds of tombBounds) {
      const bottom=bounds[1]+bounds[3];
      const depth=(-2-(.5-bottom)*H*Math.cos(TILT))/Math.sin(TILT);
      makeTomb(group,bounds,depth,wall,edge);
    }
    // Small clay grass tufts convey the uneven field without photographic textures.
    let seed=773+index;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
    const positions=[];
    for(let i=0;i<380;i++) {
      const u=random(),v=.57+random()*.6;
      const point=vec(u,v,-1.4);
      if(point.y<-2)point.y=-1.997;
      positions.push(point.x,point.y,point.z,point.x+(random()-.5)*.035,point.y+.018+random()*.06,point.z);
    }
    const strawGeo=new THREE.BufferGeometry();strawGeo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    group.add(new THREE.LineSegments(strawGeo,new THREE.LineBasicMaterial({color:0xaab2ab,transparent:true,opacity:.3})));
  }
  return { update };
}

export function createViewer(container) {
  const scene=new THREE.Scene();scene.background=new THREE.Color(0xb6c9da);
  const camera=new THREE.OrthographicCamera(-W/2,W/2,H/2,-H/2,.05,120);
  camera.position.copy(FORWARD).multiplyScalar(16);camera.lookAt(0,0,0);
  const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.02;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xf5f8ff,0x9faba3,2.0));
  const light=new THREE.DirectionalLight(0xfff4e7,2.3);light.position.set(-4,10,10);light.castShadow=true;
  light.shadow.mapSize.set(2048,2048);Object.assign(light.shadow.camera,{left:-8,right:8,top:10,bottom:-8,near:.1,far:50});light.shadow.bias=-.0001;scene.add(light);
  const actors={A:buildPuppet(scene,0xd9753f),B:buildPuppet(scene,0x407fb4)};
  const backdrop=buildBackdrop(scene);
  const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.enabled=false;controls.minZoom=.35;controls.maxZoom=4;
  let free=false;
  new ResizeObserver(()=>{
    const width=Math.max(2,container.clientWidth),height=Math.max(2,container.clientHeight);
    renderer.setSize(1280,720,false);
  }).observe(container);
  function setFreeCamera(value){free=value;controls.enabled=value;if(value){controls.target.set(0,0,0);controls.update();}else{camera.zoom=1;camera.position.copy(FORWARD).multiplyScalar(16);camera.up.set(0,1,0);camera.lookAt(0,0,0);camera.updateProjectionMatrix();}}
  function render(t){
    const index=shotIndexAt(t);const frame=clamp(Math.floor(t*FPS+.0001),0,DATA.frames.length-1);
    const f=DATA.frames[frame];
    for(const id of['A','B'])actors[id].apply(f?.actors[id]||null);
    backdrop.update(index,DATA.shots[index],frame);
    if(free)controls.update();
    renderer.render(scene,camera);
    container.dataset.poseFrame=String(frame);container.dataset.poseShot=String(index+1);
    return index;
  }
  render(0);
  return { render,setFreeCamera };
}
