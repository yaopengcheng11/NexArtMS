// Isolated browser acceptance fixture. All API mutations stay in this process's memory.
// Run: node scripts/studio-ui-fixture.mjs; no database, real project media or provider is accessed.
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=await mkdtemp(join(tmpdir(),'nexart-ui-fixture-'));
const mediaFiles=new Map();
for(const duration of [8,80]){
  const file=join(temporary,`source-${duration}.mp4`);
  const generated=spawnSync(process.env.FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=0x1c2838:s=960x540:r=30:d=${duration}`,'-vf','drawbox=x=80:y=80:w=800:h=350:color=0x31445a:t=fill,drawbox=x=250:y=125:w=140:h=275:color=0x98adc3:t=fill,drawbox=x=600:y=175:w=95:h=225:color=0xbe9165:t=fill','-an','-c:v','libx264','-preset','ultrafast','-crf','29','-pix_fmt','yuv420p','-movflags','+faststart','-y',file],{encoding:'utf8'});
  if(generated.status!==0)throw new Error(`Fixture MP4 could not be generated: ${generated.stderr}`);
  mediaFiles.set(duration,await readFile(file));
}
const now='2026-09-30T00:00:00.000Z';
const longName='在雨后老街手持长柄摄影机穿越站台寻找同伴并等待末班列车的灰衣主角与旅行者';
const clone=value=>JSON.parse(JSON.stringify(value));
const projects=new Map(),controls=new Map(),mutationLog=[];
const provider={configured:true,provider:'isolated-fixture',model:'local-synthetic-visual-fixture',reason:'只提供内存夹具结果，不调用模型。'};
const annotation=index=>({size:['medium','close','wide','medium-close'][index%4],category:'subject',camera:index%2?'tracking':'static',frame:`隔离画面 ${index+1}：灰衣人物与棕衣人物站在简化站台。`,action:'两位人物停步交谈，背景保持静止。',composition:'主体位于画面中部，留出前景与上方空间。',scene:'雨后站台',subjects:['subject-a','subject-b'],rhythm:'calm',rhythmNote:'平稳',uncertainties:[],evidenceFrames:[index*60]});
function createProject(id){
  const dense=id==='fixture-dense',empty=id==='fixture-empty',offset=id==='fixture-offset'?2400000:0;
  const count=empty?0:dense?200:4,duration=dense?80:8,framesPerShot=dense?12:60;
  const ptsUs=Array.from({length:duration*30},(_,frame)=>offset+Math.round(frame*1e6/30));
  const shots=Array.from({length:count},(_,index)=>({id:`S${String(index+1).padStart(3,'0')}`,idx:index,startFrame:index*framesPerShot,endFrameExclusive:(index+1)*framesPerShot,startUs:offset+Math.round(index*framesPerShot*1e6/30),endUs:offset+Math.round((index+1)*framesPerShot*1e6/30),source:'auto',revision:'shots-r1'}));
  const track=(name,shotIndex,subject='person',species=null)=>({id:name,shotId:shots[shotIndex]?.id||'',startFrame:shotIndex*framesPerShot+6,endFrame:(shotIndex+1)*framesPerShot-4,startUs:offset+Math.round((shotIndex*framesPerShot+6)*1e6/30),endUs:offset+Math.round(((shotIndex+1)*framesPerShot-3)*1e6/30),box:{x:.23,y:.18,w:.2,h:.65},confidence:.91,provenance:'auto',status:'active',subject,species});
  const tracks=empty?[]:[track('T-a1',0),track('T-a2',1),track('T-b1',1),track('T-b2',2),track('T-dog',2,'animal','狗'),track('T-free',3)];
  const entity=(entityId,name,ids,subject='person',species=null)=>({id:entityId,name,subject,species,method:'manual',description:entityId==='person-a'?'灰衣、长柄摄影机，站台左侧。':entityId==='person-b'?'棕衣、背包，站台右侧。':'棕色短毛狗，靠近棕衣人物。',reviewed:entityId==='person-a',trackIds:ids,shotIds:[...new Set(tracks.filter(track=>ids.includes(track.id)).map(track=>track.shotId))],representativeTrackId:ids[0]||null,assignment:'unassigned',appearances:tracks.filter(track=>ids.includes(track.id)).map(track=>({trackId:track.id,shotId:track.shotId,startFrame:track.startFrame,endFrame:track.endFrame}))});
  const people=empty?[]:[entity('person-a',longName,['T-a1','T-a2']),entity('person-b',longName,['T-b1','T-b2']),entity('animal-a','棕色短毛狗',['T-dog'],'animal','狗')];
  const characters=empty?[]:[{id:'C-a',name:'灰衣人物',color:'#98adc3',scale:1.75},{id:'C-b',name:'棕衣人物',color:'#be9165',scale:1.72}].map(character=>({...character,revision:'characters-r1',rigRef:'builtin',allowSimultaneous:false,proxyLevel:'CL1',rigFamily:'humanoid',provisional:true}));
  const run=empty?null:{id:`analysis-${id}`,projectId:id,revision:'analysis-r1',status:'ready',stage:'done',mediaHash:'synthetic-media-hash',shotSetHash:'fixture-shots',baseShotSetHash:'fixture-shots',candidate:false,provider:provider.provider,model:provider.model,error:null,progress:1,createdAt:now,updatedAt:now,subjects:empty?[]:[{id:'subject-a',kind:'person',name:longName,description:'灰衣、長柄摄影机。'},{id:'subject-b',kind:'person',name:longName,description:'棕衣、背包。'},{id:'subject-dog',kind:'animal',name:'棕色短毛狗',description:'短毛棕色狗',species:'狗'}],issues:[],counts:{total:count,analyzed:count,failed:0,needsReview:0,userEdited:0},shots:shots.map((shot,index)=>({id:shot.id,shotRevision:shot.revision,startFrame:shot.startFrame,endFrameExclusive:shot.endFrameExclusive,startUs:shot.startUs,endUs:shot.endUs,status:'analyzed',evidenceFrames:[{frameIndex:shot.startFrame,ptsUs:shot.startUs,imageRef:`frames/${shot.id}.svg`}],generated:annotation(index),overrides:{},effective:annotation(index),issues:[]})),artifactRef:'analysis.json',parameters:{analysisSource:'isolated-fixture',analysisLabel:'隔离验收夹具'}};
  const detail={workflowTarget:'shot_analysis',shotAnalysis:run,shotAnalysisProvider:provider,identitySuggestions:empty?[]:[{a:'person-a',b:'person-b',aName:longName,bName:longName,score:.75}],draft:{state:'partial',coveragePct:0,solvedCount:0,boundCount:0,note:'隔离夹具没有生成动作；这里验证真实无结果状态。',issues:empty?[]:[{code:'missing-motion',severity:'warning',message:'本镜尚无动作结果，可先查看原片与代理舞台。',shotId:shots[0].id,startUs:shots[0].startUs}]},people,invalidTrackIds:[],project:{sourcePeopleCount:empty?null:2,id,schemaVersion:2,revision:'project-r1',name:empty?'空项目 · 隔离验收':dense?'200 镜头 · 隔离验收':offset?'非零源时间起点 · 隔离验收':'雨后站台 · 隔离验收',sceneMode:'proxy',phase:'analyzed',sceneStatus:'proxy',note:'全部记录均为内存夹具。',createdAt:now,updatedAt:now},media:empty?null:{id:`media-${id}`,sha256:'synthetic-media-hash',originalName:'isolated-synthetic-stage.mp4',durationUs:duration*1e6,width:960,height:540,rotation:0,timebase:'1/15360',fps:30,vfr:false,videoCodec:'h264',audioCodec:null,ptsCount:ptsUs.length,sizeBytes:mediaFiles.get(duration).length},shots,tracks,characters,bindings:[],pendingTrackIds:empty?[]:['T-free'],conflicts:[],approval:null,jobs:empty?[]:['proxy','cuts','shot_analyze'].map((kind,index)=>({id:`job-${id}-${index}`,kind,state:'done',progress:1,error:null,output:'隔离夹具已准备',algorithmVersion:'fixture-v1',createdAt:now,updatedAt:now})),cameraTracks:[],motionRefs:{},motionVersions:{},history:[{revision:'project-r1',time:now,reason:'初始化隔离验收夹具'}],algorithms:{cuts:'fixture-v1'},detectors:[{name:'fixture-detector',version:'1',licenseNote:'仅内存夹具'}],detectorAvailable:true};
  return {detail,run,ptsUs,offset,duration,revisionCounter:1,runCounter:1,exports:empty?[]:[{exportId:'fixture-export',generatedAt:now,instanceCount:0,characterGlbs:[],included:['manifest.json','shots.json','cast.json','cameras.json','timeline.json'],notIncluded:{motion:'隔离夹具没有动作数据'}}]};
}
function getProject(id){if(!projects.has(id))projects.set(id,createProject(id));return projects.get(id);}
for(const id of ['fixture','fixture-dense','fixture-empty','fixture-offset'])getProject(id);
const settings={revision:'models-r1',capabilities:{modelConnectionTestVersion:2},profiles:[{id:'fixture-provider',name:'隔离视觉夹具',provider:'custom',protocol:'openai-compatible',endpoint:'http://127.0.0.1:8208/never-call-provider',models:['local-synthetic-visual-fixture'],hasApiKey:false,createdAt:now,updatedAt:now,tests:{}}],active:{profileId:'fixture-provider',modelId:provider.model},presets:[{id:'custom',name:'自定义供应商',provider:'custom',protocol:'openai-compatible',endpoint:''}],protocols:[{id:'openai-compatible',name:'兼容接口'}],secretStorage:{kind:'memory-fixture',persistent:false,available:true,message:'隔离夹具：不保存密钥、不请求供应商。'},runtime:{...provider,visionVerified:false}};
const capabilities={ffmpeg:true,detectors:[{name:'fixture-detector',version:'1'}],detectorAvailable:true,visionModel:null,limits:{maxUploadBytes:200000000,maxDurationS:600,maxWidthPx:1920,maxHeightPx:1080},algorithms:{cuts:'fixture-v1'},schemaVersion:2};
function thumbnail(index,track=false){const colors=['#31445a','#5b493d','#314d45','#483b58'];return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#1c2838"/><rect x="80" y="80" width="800" height="350" rx="4" fill="${colors[index%colors.length]}"/><path d="M0 430H960M120 0V540M800 0V540" stroke="#8293a3" stroke-opacity=".3"/><rect x="250" y="125" width="140" height="275" rx="24" fill="#98adc3"/><rect x="600" y="175" width="95" height="225" rx="18" fill="#be9165"/><text x="36" y="508" fill="#d8e2ee" font-family="sans-serif" font-size="25">${track?'APPEARANCE':'SHOT'} ${index+1} / ISOLATED FIXTURE</text></svg>`;}
const json=(res,value,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
const body=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1000000)throw new Error('Fixture request too large');}return raw?JSON.parse(raw):{};};
function bump(state,reason){state.detail.project.revision=`project-r${++state.revisionCounter}`;state.detail.history.unshift({revision:state.detail.project.revision,time:now,reason});}
const html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>NexArtMS · 隔离 UI 验收</title><style>body{margin:0}.fixture-label{padding:4px 12px;background:#25303e;color:#dbe4ef;font:12px/1.5 system-ui}.fixture-label a{color:#b4ceff;margin-left:12px}</style></head><body><aside class="fixture-label" aria-label="隔离验收说明">隔离 UI 夹具 · 合成画面／内存数据 · 不访问真实项目与模型<a href="/?project=fixture">标准</a><a href="/?project=fixture-dense">200 镜</a><a href="/?project=fixture-empty">空项目</a><a href="/?project=fixture-offset">非零起点</a><a href="/?home=1">项目列表</a></aside><div id="root"></div><script type="module">const query=new URLSearchParams(location.search);if(!query.has('project')&&!query.has('home'))history.replaceState(null,'','/?project=fixture');await import('/src/main.tsx');</script></body></html>`;
const plugin={name:'isolated-actual-studio-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url||'/', 'http://127.0.0.1:8208');
  try {
    if(url.pathname==='/fixture-state'){const state=getProject(url.searchParams.get('project')||'fixture');return json(res,{isolation:'memory only; no provider calls',control:controls.get(state.detail.project.id)||{},mutationLog,detail:state.detail,run:state.run});}
    if(url.pathname==='/fixture-control'){
      if(req.method!=='POST')return json(res,{error:'Use POST with projectId, conflict, fail, delayMs or reset'},405);
      const payload=await body(req),id=payload.projectId||'fixture';
      if(payload.reset){projects.set(id,createProject(id));controls.delete(id);mutationLog.length=0;}
      else controls.set(id,{...(controls.get(id)||{}),...payload});
      return json(res,{projectId:id,control:controls.get(id)||{},reset:!!payload.reset});
    }
    if(url.pathname==='/'){
      const id=url.searchParams.get('project')||'fixture';
      if(url.searchParams.has('conflict'))controls.set(id,{...(controls.get(id)||{}),conflict:url.searchParams.get('conflict')==='1'});
      if(url.searchParams.has('fail'))controls.set(id,{...(controls.get(id)||{}),fail:url.searchParams.get('fail')==='1'});
      res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(await server.transformIndexHtml(req.url,html));
    }
    if(!url.pathname.startsWith('/api/'))return next();
    const method=req.method||'GET',mutation=!['GET','HEAD'].includes(method),payload=mutation?await body(req):{};
    if(mutation)mutationLog.push({method,path:url.pathname,payload:clone(payload),at:new Date().toISOString()});
    if(url.pathname==='/api/studio/capabilities')return json(res,capabilities);
    if(url.pathname.startsWith('/api/studio/model-settings')){
      if(method==='POST'&&url.pathname.endsWith('/select'))settings.active=payload.profileId?{profileId:payload.profileId,modelId:payload.modelId}:null;
      if(mutation&&url.pathname.endsWith('/test'))return json(res,{...settings,error:'隔离诊断不调用供应商；用于界面验证。'});
      return json(res,settings);
    }
    if(url.pathname==='/api/studio/projects'&&method==='GET')return json(res,{projects:[...projects.values()].map(({detail})=>({...detail.project,trackCount:detail.tracks.length,shotCount:detail.shots.length,personCount:detail.people.filter(person=>person.subject==='person').length,animalCount:detail.people.filter(person=>person.subject==='animal').length}))});
    const match=url.pathname.match(/^\/api\/studio\/projects\/([^/]+)(.*)$/);
    if(!match)return json(res,{error:'Unmatched isolated API; real server is never contacted.'},404);
    const id=decodeURIComponent(match[1]),suffix=match[2],state=getProject(id),control=controls.get(id)||{};
    if(mutation&&control.delayMs)await new Promise(resolve=>setTimeout(resolve,Math.min(Number(control.delayMs),3000)));
    if(mutation&&control.conflict)return json(res,{error:'隔离版本冲突：后台版本已更新，当前输入保留。'},409);
    if(mutation&&control.fail)return json(res,{error:'隔离提交失败：服务暂不可用，当前输入保留。'},503);
    if(suffix===''&&method==='GET')return json(res,state.detail);
    if(suffix===''&&method==='PATCH'){Object.assign(state.detail.project,payload);delete state.detail.project.baseRevision;bump(state,'隔离设置更新');return json(res,{project:state.detail.project});}
    if(suffix===''&&method==='DELETE'){projects.delete(id);return json(res,{deleted:true,cleanupPending:false});}
    if(suffix==='/media/pts')return json(res,{ready:true,ptsUs:state.ptsUs,playback:{sourceOriginUs:state.offset,mediaOriginUs:0},playbackError:null});
    if(suffix==='/media/preview'){
      const media=mediaFiles.get(state.duration),range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      res.setHeader('Content-Type','video/mp4');res.setHeader('Accept-Ranges','bytes');res.setHeader('Cache-Control','no-store');
      if(range){const start=Number(range[1]),end=Math.min(Number(range[2]||media.length-1),media.length-1);if(start>=media.length){res.statusCode=416;return res.end();}res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${media.length}`);res.setHeader('Content-Length',end-start+1);return res.end(method==='HEAD'?undefined:media.subarray(start,end+1));}
      res.setHeader('Content-Length',media.length);return res.end(method==='HEAD'?undefined:media);
    }
    if(/\/(shots|tracks)\/[^/]+\/preview$/.test(suffix)){const number=Number(suffix.match(/S(\d+)/)?.[1]||1)-1;res.setHeader('Content-Type','image/svg+xml');return res.end(thumbnail(number,suffix.includes('/tracks/')));}
    if(suffix==='/shot-analysis'&&method==='GET')return json(res,{analysis:state.run,provider});
    if(suffix==='/shot-analysis'&&method==='POST')return json(res,{analysis:state.run,provider});
    const override=suffix.match(/^\/shot-analysis\/[^/]+\/shots\/([^/]+)$/);
    if(override&&method==='PATCH'){
      if(payload.baseRevision!==state.run?.revision)return json(res,{error:'隔离版本冲突：拉片版本已变化，草稿保留。'},409);
      const shot=state.run.shots.find(shot=>shot.id===decodeURIComponent(override[1]));if(!shot)return json(res,{error:'Fixture shot does not exist'},404);
      Object.assign(shot.overrides,payload.overrides);shot.effective={...shot.generated,...shot.overrides};shot.status='user_edited';state.run.counts.userEdited=state.run.shots.filter(shot=>shot.status==='user_edited').length;state.run.revision=`analysis-r${++state.runCounter}`;bump(state,'隔离镜头修正');return json(res,{analysis:state.run});
    }
    if(/^\/shot-analysis\/[^/]+\/file$/.test(suffix)){
      const file=url.searchParams.get('path')||'';
      if(file.endsWith('.svg')){const index=Number(file.match(/S(\d+)/)?.[1]||1)-1;res.setHeader('Content-Type','image/svg+xml');return res.end(thumbnail(index));}
      if(file==='report.html'){res.setHeader('Content-Type','text/html; charset=utf-8');return res.end('<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>隔离拉片报告</title><h1>隔离拉片报告</h1><p>合成画面与内存结果；未请求真实模型。</p></html>');}
      return json(res,state.run);
    }
    if(suffix==='/people'&&method==='PATCH'){
      const chosen=state.detail.people.filter(person=>payload.personIds?.includes(person.id));
      if(payload.action==='rename')chosen.forEach(person=>person.name=String(payload.name).trim());
      if(payload.action==='review')chosen.forEach(person=>person.reviewed=true);
      if(payload.action==='assign')chosen.forEach(person=>person.assignment=payload.assignment);
      if(payload.action==='merge'&&chosen.length>1){const first=chosen[0];first.trackIds=[...new Set(chosen.flatMap(person=>person.trackIds))];first.shotIds=[...new Set(chosen.flatMap(person=>person.shotIds))];first.appearances=chosen.flatMap(person=>person.appearances);state.detail.people=state.detail.people.filter(person=>!chosen.slice(1).includes(person));}
      if(payload.action==='assign-appearances'&&chosen[0]){const person=chosen[0],tracks=state.detail.tracks.filter(track=>payload.trackIds?.includes(track.id));person.trackIds=[...new Set([...person.trackIds,...tracks.map(track=>track.id)])];person.shotIds=[...new Set([...person.shotIds,...tracks.map(track=>track.shotId)])];person.appearances.push(...tracks.map(track=>({trackId:track.id,shotId:track.shotId,startFrame:track.startFrame,endFrame:track.endFrame})));}
      if(['release-appearances','split'].includes(payload.action)&&chosen[0]){const person=chosen[0],released=person.appearances.filter(appearance=>payload.trackIds?.includes(appearance.trackId));person.appearances=person.appearances.filter(appearance=>!payload.trackIds?.includes(appearance.trackId));person.trackIds=person.appearances.map(appearance=>appearance.trackId);person.shotIds=[...new Set(person.appearances.map(appearance=>appearance.shotId))];if(payload.action==='split')state.detail.people.push({...clone(person),id:`person-split-${state.revisionCounter}`,name:'拆分身份 · 隔离',trackIds:released.map(appearance=>appearance.trackId),shotIds:[...new Set(released.map(appearance=>appearance.shotId))],appearances:released});}
      bump(state,'隔离人物修正');return json(res,{people:state.detail.people});
    }
    if(suffix==='/exports')return json(res,{exports:state.exports});
    if(/^\/exports\/[^/]+\/file$/.test(suffix))return json(res,{fixture:true,path:url.searchParams.get('path'),project:id,shots:state.detail.shots});
    if(suffix==='/analysis'||suffix==='/reconstruction'){bump(state,'隔离处理请求（未执行真实处理）');return json(res,{queued:false,fixture:true});}
    if(suffix==='/cast'&&method==='PATCH'){bump(state,'隔离角色分组');return json(res,{fixture:true});}
    if(suffix==='/approve-cast'&&method==='POST'){bump(state,'隔离确认');return json(res,{fixture:true});}
    if(/^\/characters(?:\/[^/]+)?$/.test(suffix)&&mutation){bump(state,'隔离角色修正');return json(res,{fixture:true});}
    return json(res,{error:`Unmatched isolated API: ${method} ${suffix}; real server is never contacted.`},404);
  }catch(error){return json(res,{error:`Isolated fixture error: ${error.message}`},500);}
});}};
const server=await createServer({configFile:false,root,plugins:[react(),plugin],server:{host:'127.0.0.1',port:8208,strictPort:true}});
await server.listen();
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await server.close();await rm(temporary,{recursive:true,force:true});process.exit(0);};
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
console.log('Actual Studio isolated UI fixture: http://127.0.0.1:8208/?project=fixture');
console.log('Variants: fixture-dense / fixture-empty / fixture-offset; model/provider access is fully stubbed.');
console.log('POST /fixture-control {projectId:"fixture",conflict:true|false,fail:true|false,delayMs:0,reset:true}; GET /fixture-state?project=fixture');
