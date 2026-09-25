import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createStudioStore, SCHEMA_VERSION} from '../studio/db.mjs';
import {canonicalBones} from '../studio/pose3d.mjs';

const exec=promisify(execFile);
const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
function fixture() {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-v3-'));
  const store=createStudioStore(root);
  const p=store.createProject({name:'Group fixture',sceneMode:'proxy'});
  const rev=()=>store.getProjectRow(p.id).revision;
  store.insertMedia(p.id,{id:'media-test',sha256:'a'.repeat(64),originalName:'x.mp4',originalRef:'x.mp4',proxyRef:'proxy.mp4',
    durationUs:2e6,width:640,height:360,timebase:'1/24',fpsNum:24,fpsDen:1,vfr:false,rotation:0,videoCodec:'h264',audioCodec:null,sizeBytes:10,ptsCount:48,baseRevision:rev()});
  store.replaceShots(p.id,[{id:'S01',startFrame:0,endFrameExclusive:24,startUs:0,endUs:1e6},{id:'S02',startFrame:24,endFrameExclusive:48,startUs:1e6,endUs:2e6}],'user',rev());
  const a=store.insertTrack(p.id,'S01',{startFrame:0,endFrame:12,box:{x:.1,y:.1,w:.3,h:.7},provenance:'user'},rev());
  const b=store.insertTrack(p.id,'S02',{startFrame:24,endFrame:36,box:{x:.3,y:.1,w:.3,h:.7},provenance:'user'},rev());
  const character=store.createCharacter(p.id,{name:'Hero',color:'#28734F',scale:1.75},rev());
  return {root,store,p,a,b,character,rev,clean(){try{store.close();}catch{}fs.rmSync(root,{recursive:true,force:true,maxRetries:5});}};
}

test('whole-video people can merge, split, be grouped together and survive reopening',()=>{
  const f=fixture();
  try {
    let people=f.store.getPeople(f.p.id);
    assert.equal(people.length,2);
    f.store.editPeople(f.p.id,f.rev(),{action:'merge',personIds:people.map(p=>p.id),name:'Same source actor'});
    people=f.store.getPeople(f.p.id);
    assert.equal(people.length,1);assert.deepEqual(people[0].shotIds,['S01','S02']);
    f.store.editPeople(f.p.id,f.rev(),{action:'split',personIds:[people[0].id],trackIds:[f.b.id],name:'Different actor'});
    people=f.store.getPeople(f.p.id);assert.equal(people.length,2);
    f.store.editPeople(f.p.id,f.rev(),{action:'assign',personIds:people.map(p=>p.id),assignment:f.character.id});
    assert.equal(new Set(f.store.getCast(f.p.id).bindings.map(b=>b.character_id)).size,1);
    f.store.summarizePeople(f.p.id,f.rev(),new Map());
    assert.equal(f.store.getPeople(f.p.id).length,2,'manual identity choices survive automatic summary');
    const reopen=createStudioStore(f.root,{recoverInterrupted:false});
    try{assert.deepEqual(reopen.getPeople(f.p.id),f.store.getPeople(f.p.id));}finally{reopen.close();}
    assert.throws(()=>f.store.editPeople(f.p.id,'stale',{action:'rename',personIds:[people[0].id],name:'bad'}),e=>e.status===409);
  }finally{f.clean();}
});

test('new grouping/height invalidates motions; cut changes block invalid appearances',()=>{
  const f=fixture();
  try {
    f.store.patchCast(f.p.id,f.rev(),[{trackId:f.a.id,characterId:f.character.id,disposition:'bound'},{trackId:f.b.id,disposition:'ignored'}]);
    f.store.setMotionRef(f.p.id,f.a.id,'old-motion.json');
    f.store.updateCharacter(f.p.id,f.character.id,{scale:2},f.rev());
    assert.equal(f.store.getTracks(f.p.id).find(t=>t.id===f.a.id).motion_ref,null);
    f.store.setMotionRef(f.p.id,f.a.id,'old-motion.json');
    f.store.patchCast(f.p.id,f.rev(),[{trackId:f.a.id,disposition:'unassigned'}]);
    assert.equal(f.store.getTracks(f.p.id).find(t=>t.id===f.a.id).motion_ref,null);
    f.store.replaceShots(f.p.id,[{id:'S01',startFrame:0,endFrameExclusive:6,startUs:0,endUs:250000},{id:'S02',startFrame:6,endFrameExclusive:48,startUs:250000,endUs:2e6}],'user',f.rev());
    assert.deepEqual(f.store.getCast(f.p.id).invalidTrackIds,[f.a.id]);
    assert.throws(()=>f.store.approveCast(f.p.id,f.rev()),e=>e.status===422&&/镜头边界/.test(e.message));
  }finally{f.clean();}
});

test('re-detection replaces unreviewed auto tracks and refuses to overwrite manual grouping',()=>{
  const f=fixture();
  try {
    const specs=[{shotId:'S01',startFrame:6,endFrame:10,box:{x:.1,y:.1,w:.2,h:.5},provenance:'auto'}];
    const first=f.store.insertTracks(f.p.id,specs,f.rev());
    const second=f.store.insertTracks(f.p.id,specs,f.rev());
    assert.equal(f.store.getTracks(f.p.id).filter(t=>t.status==='active'&&t.provenance==='auto').length,1);
    assert.equal(f.store.getTracks(f.p.id).find(t=>t.id===first[0].id).status,'superseded');
    f.store.patchCast(f.p.id,f.rev(),[{trackId:second[0].id,characterId:f.character.id,disposition:'bound'}]);
    assert.throws(()=>f.store.insertTracks(f.p.id,specs,f.rev()),e=>e.status===409);
    assert.equal(f.store.getCast(f.p.id).bindings[0].character_id,f.character.id);
  }finally{f.clean();}
});

test('settings preserve data and deletion checks revision, confirmation, jobs and isolated scope',()=>{
  const f=fixture();
  try {
    const other=f.store.createProject({name:'Keep',sceneMode:'proxy'});
    const file=path.join(f.store.projectDir(f.p.id),'fixture.txt');fs.writeFileSync(file,'delete only this');
    f.store.updateProject(f.p.id,{name:'Renamed',note:'note',sceneMode:'reconstruct'},f.rev());
    assert.equal(f.store.getProjectRow(f.p.id).scene_status,'pending');assert.equal(f.store.getTracks(f.p.id).length,2);
    assert.throws(()=>f.store.deleteProject(f.p.id,'stale','Renamed'),e=>e.status===409);
    assert.throws(()=>f.store.deleteProject(f.p.id,f.rev(),'Wrong'),e=>e.status===400);
    const job=f.store.createJob(f.p.id,'people');
    assert.throws(()=>f.store.deleteProject(f.p.id,f.rev(),'Renamed'),e=>e.status===409);
    f.store.updateJob(job.id,{state:'cancelled'});
    assert.equal(f.store.deleteProject(f.p.id,f.rev(),'Renamed').cleanupPending,false);
    assert.equal(fs.existsSync(file),false);assert.equal(f.store.getProjectRow(f.p.id),null);
    for(const table of ['tracks','shots','bindings','source_people','media','characters','jobs','project_history'])assert.equal(f.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id=?`).get(f.p.id).n,0);
    assert.ok(f.store.getProjectRow(other.id));assert.ok(fs.existsSync(f.store.projectDir(other.id)));
  }finally{f.clean();}
});

test('v2 migration backs up and preserves tracks, grouping and project identity',()=>{
  const f=fixture();
  try {
    f.store.patchCast(f.p.id,f.rev(),[{trackId:f.a.id,disposition:'bound',characterId:f.character.id}]);
    f.store.db.exec('DROP TABLE source_people; ALTER TABLE tracks DROP COLUMN person_id; ALTER TABLE tracks DROP COLUMN appearance; ALTER TABLE tracks DROP COLUMN representative_frame; PRAGMA user_version=2;');
    f.store.close();
    const migrated=createStudioStore(f.root);
    try {
      assert.equal(migrated.getProjectRow(f.p.id).schema_version,SCHEMA_VERSION);
      assert.equal(migrated.getPeople(f.p.id).length,2);
      assert.equal(migrated.getCast(f.p.id).bindings[0].character_id,f.character.id);
      assert.equal(migrated.getTracks(f.p.id)[0].id,f.a.id);
      assert.ok(fs.readdirSync(path.join(f.root,'data')).some(file=>file.startsWith(`studio-before-v${SCHEMA_VERSION}-`)));
    }finally{migrated.close();}
  }finally{f.clean();}
});

test('two source character profiles survive refresh and re-summary without turning unresolved tracks back into cards',()=>{
  const f=fixture();
  try {
    assert.equal(f.store.getProjectRow(f.p.id).source_people_count,null,'no global default of two');
    f.store.updateProject(f.p.id,{sourcePeopleCount:2},f.rev());
    const red=Array(128).fill(0),blue=Array(128).fill(0);red[0]=red[64]=1;blue[10]=blue[74]=1;
    const descriptors=new Map([[f.a.id,red],[f.b.id,blue]]);
    f.store.summarizePeople(f.p.id,f.rev(),descriptors);
    const people=f.store.getPeople(f.p.id);assert.equal(people.length,2);
    f.store.summarizePeople(f.p.id,f.rev(),descriptors);
    assert.deepEqual(f.store.getPeople(f.p.id).map(p=>p.id),people.map(p=>p.id));
    const first=people.find(p=>p.trackIds.includes(f.a.id));
    f.store.editPeople(f.p.id,f.rev(),{action:'release-appearances',personIds:[first.id],trackIds:[f.a.id]});
    assert.equal(f.store.getPeople(f.p.id).length,2,'empty role slot remains for reference selection');
    const reopened=createStudioStore(f.root,{recoverInterrupted:false});
    try{assert.equal(reopened.getTracks(f.p.id).find(t=>t.id===f.a.id).person_id,null);assert.equal(reopened.getPeople(f.p.id).length,2);}finally{reopened.close();}
    f.store.editPeople(f.p.id,f.rev(),{action:'assign-appearances',personIds:[first.id],trackIds:[f.a.id]});
    assert.ok(f.store.getPeople(f.p.id).find(p=>p.id===first.id).trackIds.includes(f.a.id));
    assert.throws(()=>f.store.summarizePeople(f.p.id,f.rev(),descriptors),e=>e.status===409,'manual identity decisions are protected');
  }finally{f.clean();}
});

test('organizing legacy source identities preserves each existing proxy binding',()=>{
  const f=fixture();
  try{
    f.store.patchCast(f.p.id,f.rev(),[{trackId:f.a.id,characterId:f.character.id,disposition:'bound'},{trackId:f.b.id,characterId:f.character.id,disposition:'bound'}]);
    f.store.db.prepare("UPDATE source_people SET method='legacy',reviewed=0 WHERE project_id=?").run(f.p.id);
    const before=f.store.getCast(f.p.id).bindings;
    f.store.updateProject(f.p.id,{sourcePeopleCount:2},f.rev());
    f.store.summarizePeople(f.p.id,f.rev(),new Map());
    assert.equal(f.store.getPeople(f.p.id).length,2);
    assert.deepEqual(f.store.getCast(f.p.id).bindings,before);
  }finally{f.clean();}
});

test('correcting source-role membership inherits the target proxy group and clears stale motion, including empty profiles',()=>{
  const f=fixture();
  try{
    const [a,b]=f.store.getPeople(f.p.id);
    const other=f.store.createCharacter(f.p.id,{name:'Other',color:'#999999',scale:2},f.rev());
    f.store.editPeople(f.p.id,f.rev(),{action:'assign',personIds:[a.id],assignment:f.character.id});
    f.store.editPeople(f.p.id,f.rev(),{action:'assign',personIds:[b.id],assignment:other.id});
    f.store.setMotionRef(f.p.id,f.b.id,'old-other-motion.json');
    f.store.editPeople(f.p.id,f.rev(),{action:'release-appearances',personIds:[b.id],trackIds:[f.b.id]});
    assert.equal(f.store.getCast(f.p.id).bindings.find(row=>row.track_id===f.b.id).disposition,'unassigned');
    assert.equal(f.store.getTracks(f.p.id).find(row=>row.id===f.b.id).motion_ref,null);
    assert.equal(f.store.getPeople(f.p.id).find(row=>row.id===b.id).assignment,other.id,'empty role retains proxy group');
    f.store.editPeople(f.p.id,f.rev(),{action:'assign-appearances',personIds:[a.id],trackIds:[f.b.id]});
    assert.equal(f.store.getCast(f.p.id).bindings.find(row=>row.track_id===f.b.id).character_id,f.character.id);
    assert.equal(f.store.getPeople(f.p.id).find(row=>row.id===a.id).assignment,f.character.id);
    f.store.editPeople(f.p.id,f.rev(),{action:'assign',personIds:[b.id],assignment:f.character.id});
    assert.equal(f.store.getPeople(f.p.id).find(row=>row.id===b.id).assignment,f.character.id,'empty role can change proxy group');
  }finally{f.clean();}
});

function sampleMotion(character,track) {
  const bones=canonicalBones(character.scale);
  const frames=[0,6,12].map((offset,index)=>{
    const joints={pelvis:[0,1,0]};
    for(const bone of bones) {
      const d=bone.child.startsWith('hip')||bone.child.startsWith('knee')||bone.child.startsWith('ankle')?[0,-1,0]:bone.child.includes('L')?[Math.cos(index*.4),Math.sin(index*.4),0]:bone.child.includes('R')?[-1,0,0]:[0,1,0];
      joints[bone.child]=joints[bone.parent].map((n,i)=>n+d[i]*bone.length);
    }
    return {frame:track.start_frame+offset,timeS:(track.start_frame+offset)/24,rootOffset:[index*.1,1,0],joints,contacts:{}};
  });
  return {characterId:character.id,bodyHeight:character.scale,bones,frames};
}

test('export two source people as ONE group asset with TWO clips; GLB reload verifies every endpoint and skin attribute',async()=>{
  const f=fixture();
  try {
    f.store.editPeople(f.p.id,f.rev(),{action:'assign',personIds:f.store.getPeople(f.p.id).map(p=>p.id),assignment:f.character.id});
    const samples=new Map();
    for(const track of [f.a,f.b]) {
      const motion=sampleMotion(f.character,track);samples.set(track.id,motion);
      const dir=path.join(f.store.observationsDir(f.p.id),'motion');fs.mkdirSync(dir,{recursive:true});
      const file=path.join(dir,`${track.id}.json`);fs.writeFileSync(file,JSON.stringify(motion));
      f.store.setMotionRef(f.p.id,track.id,path.relative(f.root,file));
    }
    const out=path.join(f.store.exportsDir(f.p.id),'exp-test');fs.mkdirSync(out);
    await exec(process.execPath,['--import','tsx','scripts/build-export-package.mjs','--project',f.p.id,'--store-root',f.root,'--output',out],{cwd:repo});
    const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    assert.equal(manifest.instanceCount,2);assert.equal(manifest.characterGlbs.length,1);assert.equal(manifest.characterGlbs[0].clips.length,2);
    const bytes=fs.readFileSync(path.join(out,'characters',manifest.characterGlbs[0].file));
    const json=JSON.parse(bytes.subarray(20,20+bytes.readUInt32LE(12)).toString());
    for(const mesh of json.meshes)for(const primitive of mesh.primitives){
      assert.equal(primitive.mode??4,4,'must be triangles, not unskinned lines');
      const n=json.accessors[primitive.attributes.POSITION].count;
      assert.equal(json.accessors[primitive.attributes.JOINTS_0].count,n);assert.equal(json.accessors[primitive.attributes.WEIGHTS_0].count,n);
    }
    const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
    let meshCount=0;gltf.scene.traverse(object=>{if(object.isSkinnedMesh)meshCount++;});assert.equal(meshCount,canonicalBones().length);
    for(const track of [f.a,f.b]) {
      const clip=gltf.animations.find(clip=>clip.name===`motion-${track.id}`);
      const mixer=new THREE.AnimationMixer(gltf.scene);const action=mixer.clipAction(clip);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
      for(const frame of samples.get(track.id).frames) {
        mixer.setTime(frame.timeS-samples.get(track.id).frames[0].timeS);gltf.scene.updateMatrixWorld(true);
        for(const segment of samples.get(track.id).bones) {
          const bone=gltf.scene.getObjectByName(segment.name);
          for(const [local,joint] of [[new THREE.Vector3(),segment.parent],[new THREE.Vector3(0,1,0),segment.child]]) {
            const expected=new THREE.Vector3(...frame.joints[joint]).add(new THREE.Vector3(frame.rootOffset[0],0,frame.rootOffset[2]));
            assert.ok(local.applyMatrix4(bone.matrixWorld).distanceTo(expected)<1e-5,`${track.id} ${segment.name} ${joint} matches source motion`);
          }
        }
      }
      mixer.stopAllAction();mixer.uncacheRoot(gltf.scene);
    }
    // Old persisted motion files must not masquerade as a newly selected role.
    const broken=JSON.parse(fs.readFileSync(path.join(f.store.observationsDir(f.p.id),'motion',`${f.a.id}.json`),'utf8'));
    broken.bodyHeight=2;fs.writeFileSync(path.join(f.store.observationsDir(f.p.id),'motion',`${f.a.id}.json`),JSON.stringify(broken));
    await assert.rejects(()=>exec(process.execPath,['--import','tsx','scripts/build-export-package.mjs','--project',f.p.id,'--store-root',f.root,'--output',out],{cwd:repo}),e=>/动作版本已过期/.test(e.stderr));
  }finally{f.clean();}
});
