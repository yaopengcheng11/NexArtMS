import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStudioStore} from '../studio/db.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workspace-'));
  const store = createStudioStore(root);
  const calls = [];
  const jobs = {enqueue(id, kind, options) {calls.push({id, kind, options});return store.createJob(id, kind, {options});}};
  const router = createStudioRouter(store, root, {limits: DEFAULT_LIMITS, jobs});
  const server = http.createServer((req, res) => {router(req, res).then(handled => {if (!handled) res.writeHead(404).end();}).catch(error => res.writeHead(500).end(error.message));});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const project = store.createProject({name: 'workspace fixture'});
  const revision = () => store.getProjectRow(project.id).revision;
  store.insertMedia(project.id, {id:'m-fixture',sha256:'a'.repeat(64),originalName:'fixture.mp4',originalRef:'media/fixture.mp4',proxyRef:'proxies/preview.mp4',durationUs:1000000,width:320,height:240,timebase:'1/10',fpsNum:10,fpsDen:1,vfr:false,rotation:0,videoCodec:'h264',audioCodec:null,sizeBytes:10,ptsCount:10,baseRevision:revision()});
  store.replaceShots(project.id, [{id:'S01',startFrame:0,endFrameExclusive:10,startUs:0,endUs:1000000}], 'user', revision());
  const request = async (method, route, body = {}, origin = base) => {
    const response = await fetch(base + route, {method, headers: {Origin:origin,'Content-Type':'application/json'}, ...(method==='GET'?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  try {await run({store,project,revision,request,calls});}
  finally {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));store.close();
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('studio-workspace-'));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5});
  }
}

test('project summary counts humans separately from animals', async () => fixture(async ({store,project,revision,request}) => {
  store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.1,y:.1,w:.2,h:.7},provenance:'user'},revision());
  store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.6,y:.6,w:.2,h:.2},provenance:'user',subject:'animal',species:'dog'},revision());
  const result=await request('GET','/api/studio/projects');
  assert.equal(result.status,200);
  assert.equal(result.body.projects[0].personCount,1);
  assert.equal(result.body.projects[0].animalCount,1);
}));

test('update reconstruction reuses the local motion/camera chain without approval or visual analysis', async () => fixture(async ({store,project,revision,request,calls}) => {
  const track=store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.1,y:.1,w:.2,h:.7},provenance:'user'},revision());
  const character=store.createCharacter(project.id,{name:'fixture person',color:'#28543f',scale:1.75},revision());
  store.patchCast(project.id,revision(),[{trackId:track.id,characterId:character.id,disposition:'bound'}]);
  const poseDir=path.join(store.observationsDir(project.id),'poses');fs.mkdirSync(poseDir,{recursive:true});
  fs.writeFileSync(path.join(poseDir,`${track.id}.json`),JSON.stringify({frames:[{frame:0},{frame:8}]}));
  const route=`/api/studio/projects/${project.id}/reconstruction`;
  const result=await request('POST',route);
  assert.equal(result.status,200);
  assert.deepEqual(calls,[{id:project.id,kind:'motion',options:{auto:true}}]);
  const repeated=await request('POST',route);
  assert.equal(repeated.status,200);
  assert.equal(repeated.body.alreadyProcessing,true);
  assert.equal(calls.length,1,'double click must not queue the same work again');
}));

test('unbound or pose-less people receive an actionable prerequisite error instead of an empty update', async () => fixture(async ({store,project,revision,request,calls}) => {
  const track=store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.1,y:.1,w:.2,h:.7},provenance:'user'},revision());
  const route=`/api/studio/projects/${project.id}/reconstruction`;
  const unbound=await request('POST',route);assert.equal(unbound.status,422);assert.match(unbound.body.error,/三维角色/);
  const character=store.createCharacter(project.id,{name:'fixture person',color:'#28543f',scale:1.75},revision());
  store.patchCast(project.id,revision(),[{trackId:track.id,characterId:character.id,disposition:'bound'}]);
  const noPose=await request('POST',route);assert.equal(noPose.status,422);assert.match(noPose.body.error,/姿态观测/);
  assert.equal(calls.length,0);
}));

test('missing human observations and cross-origin requests never enqueue reconstruction', async () => fixture(async ({store,project,revision,request,calls}) => {
  store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.6,y:.6,w:.2,h:.2},provenance:'user',subject:'animal',species:'dog'},revision());
  const route=`/api/studio/projects/${project.id}/reconstruction`;
  assert.equal((await request('POST',route)).status,422);
  assert.equal((await request('POST',route,{},'https://unrelated.example')).status,403);
  assert.equal(calls.length,0);
}));

test('explicit detection recovery continues the existing local reconstruction chain', async () => fixture(async ({project,request,calls}) => {
  const response=await request('POST',`/api/studio/projects/${project.id}/analysis`,{kind:'detect',subjects:'person',continueReconstruction:true});
  assert.equal(response.status,200);
  assert.deepEqual(calls,[{id:project.id,kind:'detect',options:{subjects:'person',auto:true}}]);
}));
