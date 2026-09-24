import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CUT_FRAMES, shotIndexAt } from '../src/choreography.js';
import { DURATION } from '../src/shots.js';
const data=JSON.parse(fs.readFileSync(new URL('../src/pose-data.json',import.meta.url)));
assert.equal(data.frames.length,1203,'All original video frames must exist');
assert.equal(data.shots.length,47);
let actorFrames=0,empty=[];
const audit=JSON.parse(fs.readFileSync(new URL('../pose-audit.json',import.meta.url)));
const manualFrames=audit.shots.reduce((n,s)=>n+Object.values(s.actors).reduce((m,a)=>m+(a.manualFrames||0),0),0);
for(let i=0;i<data.frames.length;i++) {
  const actors=data.frames[i].actors;
  if(!Object.keys(actors).length)empty.push(i);
  for(const [id,p] of Object.entries(actors)) {
    assert.ok(['A','B'].includes(id));actorFrames++;
    assert.ok(Number.isFinite(p.scale)&&p.scale>0&&p.scale<2,`scale ${i} ${id}`);
    assert.ok(Number.isFinite(p.depth??0));
    assert.ok(p.j.length>=17);
    for(const joint of p.j)if(joint){assert.ok(joint.length>=3);assert.ok(joint.every(Number.isFinite),`Nonfinite joint ${i} ${id}`);}

  }
}
for(let s=0;s<CUT_FRAMES.length;s++) {
  assert.equal(shotIndexAt(CUT_FRAMES[s]/24),s,`Cut ${s} must select its own first frame`);
  if(s>0)assert.equal(shotIndexAt((CUT_FRAMES[s]-1)/24),s-1,`No cross-cut interpolation ${s}`);
}
assert.equal(shotIndexAt(DURATION),46);
const H=4,W=H*16/9,a=.29;
const up=new THREE.Vector3(0,Math.cos(a),-Math.sin(a)),forward=new THREE.Vector3(0,Math.sin(a),Math.cos(a));
const camera=new THREE.OrthographicCamera(-W/2,W/2,H/2,-H/2,.05,120);
camera.position.copy(forward).multiplyScalar(16);camera.lookAt(0,0,0);camera.updateMatrixWorld();
let projectionError=0;
for(const [u,v] of [[0,0],[1,1],[.25,.8],[.9,.15],[-.2,1.4]])for(const depth of[-5,0,3]) {
  const world=new THREE.Vector3((u-.5)*W,0,0).addScaledVector(up,(.5-v)*H).addScaledVector(forward,depth);
  const p=world.project(camera);
  const e=Math.hypot((p.x+1)/2-u,(1-p.y)/2-v);projectionError=Math.max(projectionError,e);
  assert.ok(e<1e-10,'Depth reconstruction must preserve source-camera projected landmarks');
}
console.log(JSON.stringify({frames:data.frames.length,shots:47,actorFrames,manualFrames,emptyFrames:empty,cutChecks:94,projectionError,warning:'Projection error verifies the 3D transform only, not detector accuracy.'},null,2));
