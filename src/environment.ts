import * as THREE from 'three';
import type {SceneAsset,SceneNode} from './types';

export function terrainHeight(asset:SceneAsset,x:number,z:number){
  let h=asset.terrain.baseY;
  for(const r of asset.terrain.ridges||[])h+=r.height*Math.exp(-2*(((x-r.x)/r.radiusX)**2+((z-r.z)/r.radiusZ)**2));
  const flat=asset.nodes.find(n=>n.type==='terrain')?.parameters?.flatZone as {minX:number;maxX:number;minZ:number;maxZ:number;height:number;blend:number}|undefined;
  if(flat){const distance=Math.max(flat.minX-x,x-flat.maxX,flat.minZ-z,z-flat.maxZ,0);const t=THREE.MathUtils.smoothstep(distance,0,flat.blend);h=THREE.MathUtils.lerp(flat.height,h,t);}
  return h;
}
const material=(color:string|number)=>new THREE.MeshStandardMaterial({color,roughness:.92,metalness:0});
function box(parent:THREE.Object3D,size:number[],at:number[],mat:THREE.Material){const m=new THREE.Mesh(new THREE.BoxGeometry(...size as [number,number,number]),mat);m.position.set(...at as [number,number,number]);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;}
function tomb(node:SceneNode){
  const group=new THREE.Group();const [w,h,d]=node.size||[5,2.6,1];
  const clay=material(node.color||'#dedbd2'),edge=material('#b8b6ad');
  const parameters=node.parameters||{};const forward=Number(parameters.wingForwardDepth||d*.7),low=Number(parameters.sideWallHeight||h*.46);
  const top=(x:number)=>low+(h-low)*Math.exp(-((x/(w*.19))**2));
  const z=(x:number)=>forward*(Math.abs(x)/(w*.5))**2;
  box(group,[Number(parameters.platformWidth||w+.4),.16,Number(parameters.platformDepth||d+.5)],[0,.08,d*.35],edge);
  const points:THREE.Vector3[]=[];
  for(let i=0;i<=40;i++)points.push(new THREE.Vector3(-w/2+w*i/40,top(-w/2+w*i/40),z(-w/2+w*i/40)));
  for(let i=0;i<points.length-1;i++){
    const a=points[i],b=points[i+1],vertices:number[]=[];const thick=.12;
    for(const dz of[-thick,thick])vertices.push(a.x,.16,a.z+dz,b.x,.16,b.z+dz,b.x,b.y,b.z+dz,a.x,a.y,a.z+dz);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex([0,2,1,0,3,2,4,5,6,4,6,7,0,4,7,0,7,3,1,2,6,1,6,5,3,7,6,3,6,2]);g.computeVertexNormals();const m=new THREE.Mesh(g,clay);m.castShadow=true;m.receiveShadow=true;group.add(m);
  }
  const rim=new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),70,.045,6,false),edge);rim.castShadow=true;group.add(rim);
  for(const u of[-.5,-.34,-.18,.18,.34,.5]){const x=u*w,ph=top(x)+.05;box(group,[.24,ph,.24],[x,ph/2,z(x)],clay);const ball=new THREE.Mesh(new THREE.SphereGeometry(.15,12,8),edge);ball.position.set(x,ph+.1,z(x));ball.castShadow=true;group.add(ball);}
  box(group,[Number(parameters.centralPanelWidth||w*.16),Number(parameters.centralPanelHeight||h*.68),.06],[0,h*.43,.155],edge);
  const medallion=new THREE.Mesh(new THREE.CylinderGeometry(.21,.21,.07,24),clay);medallion.rotation.x=Math.PI/2;medallion.position.set(0,h*.84,.16);group.add(medallion);
  return group;
}
function tree(node:SceneNode){
  const g=new THREE.Group(),p=node.parameters||{},mat=material(node.color||'#c2c8bd');const height=Number(p.trunkHeight||3.1),radius=Number(p.trunkRadius||.115);
  const trunk=new THREE.Mesh(new THREE.CylinderGeometry(radius*.6,radius,height,8),mat);trunk.position.y=height/2;trunk.castShadow=true;g.add(trunk);
  for(let i=0;i<3;i++){const angle=i*Math.PI*2/3;const branch=new THREE.Mesh(new THREE.CylinderGeometry(.035,.07,1.5,7),mat);branch.position.set(Math.cos(angle)*.4,height*.7,Math.sin(angle)*.4);branch.rotation.z=Math.cos(angle)*-.6;branch.rotation.x=Math.sin(angle)*.6;branch.castShadow=true;g.add(branch);const crown=new THREE.Mesh(new THREE.IcosahedronGeometry(1,1),mat);crown.position.set(Math.cos(angle)*.65,height+.05+i*.13,Math.sin(angle)*.55);crown.scale.set(.9,.5,.7);crown.castShadow=true;g.add(crown);}return g;
}
function fence(node:SceneNode){const g=new THREE.Group();const[w,h,d]=node.size||[5.6,2.76,.16];const mat=material(node.color||'#d0d2ce'),edge=material('#b3b9ac');box(g,[w,h,d],[0,0,0],mat);for(let i=0;i<4;i++)box(g,[.065,h+.15,d+.08],[-w/2+i*w/3,.03,0],edge);for(let i=0;i<14;i++)box(g,[w,.015,d+.015],[0,-h/2+i*h/13,0],edge);return g;}
export function buildEnvironment(asset:SceneAsset){
  const group=new THREE.Group();group.name='fixed-environment';
  const {width,depth,segments}=asset.terrain;
  const geo=new THREE.PlaneGeometry(width,depth,segments,segments);geo.rotateX(-Math.PI/2);
  const pos=geo.attributes.position;
  for(let i=0;i<pos.count;i++)pos.setY(i,terrainHeight(asset,pos.getX(i),pos.getZ(i)));
  geo.computeVertexNormals();const terrain=new THREE.Mesh(geo,material('#d7d4c9'));terrain.name='ground';terrain.receiveShadow=true;group.add(terrain);
  const nodeObjects:Record<string,THREE.Object3D>={};
  for(const n of asset.nodes){
    if(n.type==='terrain')continue;
    const item=n.type==='tomb'?tomb(n):n.type==='tree'?tree(n):n.type==='fence'?fence(n):new THREE.Group();
    if(!['tomb','tree','fence'].includes(n.type))box(item,n.size||[1,1,1],[0,(n.size?.[1]||1)/2,0],material(n.color||'#c8c6bc'));
    item.name=n.id;item.userData.nodeId=n.id;item.position.set(...n.position);
    if(n.rotation)item.rotation.set(...n.rotation);if(n.scale)item.scale.set(...n.scale);
    group.add(item);nodeObjects[n.id]=item;
  }
  return {group,nodeObjects};
}
export function disposeObject(root:THREE.Object3D){root.traverse(o=>{if(o instanceof THREE.Mesh||o instanceof THREE.LineSegments){o.geometry.dispose();for(const mat of(Array.isArray(o.material)?o.material:[o.material]))mat.dispose();}});}
