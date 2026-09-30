import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createStudioStore} from '../studio/db.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';
import {createShotAnalysisStore} from '../studio/shot-analysis-store.mjs';
import {semanticPersonId} from '../studio/project-operations.mjs';

async function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-workspace-'));
  const store = createStudioStore(root);
  const calls = [];
  const analysis = createShotAnalysisStore(store, root);
  const jobs = {analysisStore: analysis, enqueue(id, kind, options) {calls.push({id, kind, options});return store.createJob(id, kind, {options});}};
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
  try {await run({store,project,revision,request,calls,analysis});}
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

test('project detail keeps distinct semantic descriptions for same-name people', async () => fixture(async ({store,project,revision,request,analysis}) => {
  const subjects = [
    {id:'P-01',kind:'person',name:'黑衣男子',description:'左侧戴帽子的男子',referenceFrames:[0]},
    {id:'P_01',kind:'person',name:'黑衣男子',description:'右侧戴眼镜的男子',referenceFrames:[0]},
  ];
  const run = analysis.createRun(project.id);
  analysis.updateRun(project.id,run.id,{subjects});
  const tracks = subjects.map((_,index) => store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.1+index*.5,y:.1,w:.2,h:.7},provenance:'user'},revision()));
  store.summarizePeople(project.id,revision(),new Map(),{groups:subjects.map((subject,index) => ({subjectId:subject.id,name:subject.name,trackIds:[tracks[index].id]}))});
  const result = await request('GET',`/api/studio/projects/${project.id}`);
  assert.equal(result.status,200);
  assert.equal(result.body.people.length,2);
  for (const subject of subjects) assert.equal(result.body.people.find(person => person.id === semanticPersonId(project.id,subject.id)).description,subject.description);
}));

test('project detail preserves legacy descriptions only when the subject key is unambiguous', async () => fixture(async ({store,project,revision,request,analysis}) => {
  const track = store.insertTrack(project.id,'S01',{startFrame:0,endFrame:8,box:{x:.1,y:.1,w:.2,h:.7},provenance:'user'},revision());
  const personId = store.getTracks(project.id).find(row => row.id === track.id).person_id;
  store.db.prepare("UPDATE source_people SET id='person-p01',method='semantic-v1' WHERE id=?").run(personId);
  store.db.prepare("UPDATE tracks SET person_id='person-p01' WHERE id=?").run(track.id);
  const run = analysis.createRun(project.id);
  const subject = {id:'P01',kind:'person',name:'黑衣男子',description:'左侧戴帽子的男子',referenceFrames:[0]};
  analysis.updateRun(project.id,run.id,{subjects:[subject]});
  const route = `/api/studio/projects/${project.id}`;
  assert.equal((await request('GET',route)).body.people[0].description,subject.description);
  analysis.updateRun(project.id,run.id,{subjects:[subject,{...subject,id:'P-01',description:'右侧戴眼镜的男子'}]});
  assert.equal((await request('GET',route)).body.people[0].description,undefined,'a colliding legacy slug cannot select an arbitrary subject');
  assert.equal(store.getPeople(project.id)[0].id,'person-p01','reading detail must not migrate stored identities');
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
