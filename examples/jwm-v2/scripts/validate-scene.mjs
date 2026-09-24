import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildPuppet } from '../src/scene.js';
import data from '../src/pose-data.json';
const scene=new THREE.Scene();const actor=buildPuppet(scene,0xdd8844);
let frames=0,transforms=0;
for(const [frame,f] of data.frames.entries())for(const [id,p]of Object.entries(f.actors)){
 actor.apply(p);frames++;
 actor.group.traverse(o=>{if(o.isMesh&&o.visible){for(const v of [...o.position,...o.quaternion,...o.scale])assert.ok(Number.isFinite(v),`Invalid mesh transform at frame ${frame}, actor ${id}`);transforms++;}});
}
console.log(JSON.stringify({actorFramesRendered:frames,meshTransformsVerified:transforms,nonFiniteTransforms:0}));
