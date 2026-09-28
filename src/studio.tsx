import React,{useCallback,useEffect, useRef,useState} from 'react';
import './studio.css';
import {PeopleSection, ProjectSettings, type PersonInfo} from './StudioPeople';
import {StageSection} from './StudioStage';
import {StudioPlayback} from './StudioPlayback';
import {StudioShotAnalysis} from './StudioShotAnalysis';
import {StudioModelSettings} from './StudioModelSettings';
import type {ShotAnalysis,ShotProviderStatus} from './studio-shot-analysis-types';

// ---- 类型：与 studio/router.mjs 的 JSON 契约一致 ----
interface ProjectSummary{id:string;revision:string;name:string;sceneMode:'proxy'|'reconstruct';phase:string;sceneStatus:string;createdAt:string;updatedAt:string;trackCount?:number;shotCount?:number;personCount?:number}
interface MediaInfo{id:string;sha256:string;originalName:string;durationUs:number;width:number;height:number;rotation:number;timebase:string;fps:number;vfr:boolean;videoCodec:string;audioCodec:string|null;ptsCount:number;sizeBytes:number}
export interface ShotInfo{id:string;idx:number;startFrame:number;endFrameExclusive:number;startUs:number;endUs:number;source:'auto'|'user';revision:string}
export interface TrackInfo{id:string;shotId:string;startFrame:number;endFrame:number;startUs:number;endUs:number;box:{x:number;y:number;w:number;h:number};confidence:number;provenance:'auto'|'user';status:string;subject:'person'|'animal';species?:string|null}
export interface CharacterInfo{id:string;revision:string;name:string;color:string;scale:number;rigRef:string;allowSimultaneous:boolean;proxyLevel:'CL0'|'CL1'|'CL2';rigFamily:string;provisional:boolean}
interface BindingInfo{trackId:string;characterId:string|null;disposition:string;note:string;updatedBy:string;updatedAt:string}
interface ConflictInfo{shotId:string;characterId:string;trackA:string;trackB:string;overlapFrames:[number,number]}
interface ApprovalInfo{project_id:string;revision:string;status:string;approved_at:string;approved_by:string;frozen:{media:{sha256:string};shots:{count:number;revision:string};tracks:{activeCount:number;revision:string};characters:{revision:string};bindings:{revision:string};algorithmVersions:Record<string,string>}}
interface JobInfo{id:string;kind:string;state:'queued'|'running'|'done'|'failed'|'cancelled';progress:number;error:string|null;output:string|null;algorithmVersion:string;createdAt:string;updatedAt:string}
interface HistoryEntry{revision:string;time:string;reason:string}
export interface ProjectDetail{workflowTarget?:'shot_analysis'|'legacy';shotAnalysis?:ShotAnalysis|null;shotAnalysisProvider?:ShotProviderStatus;identitySuggestions?:{a:string;b:string;aName:string;bName:string;score:number}[];draft?:{state:string;coveragePct:number|null;solvedCount:number;boundCount:number;note?:string;visibleDurationUs?:number;solvedDurationUs?:number;subjectCoverage?:Record<string,{visibleDurationUs:number;solvedDurationUs:number;coveragePct:number|null}>;issues?:{code:string;severity:string;message:string;trackId?:string;shotId?:string;startUs?:number;endUs?:number}[]};people:PersonInfo[];invalidTrackIds:string[];project:{sourcePeopleCount:number|null;id:string;schemaVersion:number;revision:string;name:string;sceneMode:'proxy'|'reconstruct';phase:string;sceneStatus:string;note:string;createdAt:string;updatedAt:string};media:MediaInfo|null;shots:ShotInfo[];tracks:TrackInfo[];characters:CharacterInfo[];bindings:BindingInfo[];pendingTrackIds:string[];conflicts:ConflictInfo[];approval:ApprovalInfo|null;jobs:JobInfo[];cameraTracks:CameraTrackInfo[];motionRefs:Record<string,string>;motionVersions?:Record<string,string>;history:HistoryEntry[];algorithms:Record<string,string>;detectors:{name:string;version:string;licenseNote:string}[];detectorAvailable:boolean}
interface Capabilities{ffmpeg:boolean;detectors:{name:string;version:string}[];detectorAvailable:boolean;visionModel:{name:string;version:string;license:string;file:string;sha256:string}|null;limits:{maxUploadBytes:number;maxDurationS:number;maxWidthPx:number;maxHeightPx:number};algorithms:Record<string,string>;schemaVersion:number}
export interface CameraTrackInfo{id:string;shotId:string;source:string;intrinsics:Record<string,number>;extrinsics:{rotation:number[];translation:number[]};confidence:number;medianErrorPx:number|null;needsManualReview:boolean}
interface ExportSummary{exportId:string;generatedAt?:string;instanceCount?:number;characterGlbs?:{characterId:string;file:string;instance?:string;frames?:number}[];included?:string[];notIncluded?:Record<string,string|undefined>;broken?:boolean}

const PHASE_LABELS:Record<string,string>={draft:'草稿',analyzed:'素材已分析',cast_confirmed:'角色已确认',keyframes_confirmed:'关键姿态已确认（待实现）',motion_confirmed:'动作已确认（待实现）',delivered:'已交付（待实现）'};
const PHASE_ORDER=['draft','analyzed','cast_confirmed'];
const KIND_LABELS:Record<string,string>={proxy:'生成素材预览',pts:'PTS 时间戳映射',cuts:'自动切镜',shot_frames:'拉片 · 提取关键帧',shot_analyze:'拉片 · 逐镜语义分析',shot_validate:'拉片 · 检查全片结果',shot_report:'拉片 · 生成报告',detect:'人物检测',people:'全片人物汇总',motion:'生成动作',camera:'人物尺度运镜估计',export:'导出交付包'};
const seconds=(us:number)=>`${(us/1e6).toFixed(2)} s`;
const fmtSize=(bytes:number)=>bytes>1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:`${(bytes/1024).toFixed(0)} KB`;

async function request<T>(url:string,body?:unknown,method='GET'):Promise<T>{
  const response=await fetch(url,body===undefined?{method}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(result.error||'请求未完成'),{status:response.status});
  return result;
}

function useToast(){
  const[toast,setToast]=useState('');
  const show=useCallback((message:string)=>{setToast(message);window.setTimeout(()=>setToast(current=>current===message?'':current),6000);},[]);
  return{toast,show};
}

// ---- 项目列表 ----
function ProjectList({onOpen,onModelSettings}:{onOpen:(id:string)=>void;onModelSettings:()=>void}){
  const[projects,setProjects]=useState<ProjectSummary[]|null>(null);
  const[capabilities,setCapabilities]=useState<Capabilities|null>(null);
  const[name,setName]=useState('');
  const[busy,setBusy]=useState(false);
  const{toast,show}=useToast();
  const load=useCallback(()=>{request<{projects:ProjectSummary[]}>('/api/studio/projects').then(r=>setProjects(r.projects)).catch(e=>show(e.message));},[show]);
  useEffect(()=>{load();request<Capabilities>('/api/studio/capabilities').then(setCapabilities).catch(()=>{});},[load]);
  const create=async()=>{if(!name.trim()||busy)return;setBusy(true);try{const r=await request<{project:ProjectSummary}>('/api/studio/projects',{name,sceneMode:'proxy'},'POST');onOpen(r.project.id);}catch(e){show((e as Error).message);}finally{setBusy(false);}};
  return <div className="studio">
    <header className="topbar"><div className="identity"><span className="brand-mark studio-mark">M</span><div><strong>MotionStage <i>/</i> 混剪项目</strong><small>导入素材 → 自动拉片 → 集中修正</small></div></div><div className="top-meta"><button onClick={onModelSettings}>模型设置</button><a className="quiet-link" href="/?mode=scene">场景工作台 ↗</a><a className="quiet-link" href="/?mode=rehearsal">流程演练 ↗</a></div></header>
    <main className="studio-main">
      {capabilities&&!capabilities.ffmpeg&&<div className="studio-banner studio-banner-error" role="alert"><b>缺少 FFmpeg</b><p>本机未检测到 ffmpeg/ffprobe。导入、预览和切镜分析都需要 FFmpeg；请安装后将其加入 PATH，或设置 FFMPEG/FFPROBE 环境变量。</p></div>}
      {capabilities&&!capabilities.detectorAvailable&&<details className="studio-banner"><summary>后续人物检测模型未加载</summary><p>人物检测与二维姿态需加载 YOLOv8n-pose（ONNX，AGPL 许可，见 docs/model-decisions.md）。拉片的逐镜语义分析使用单独配置的视觉模型。</p></details>}
      <section className="studio-card">
        <div className="panel-title"><h2>新建项目</h2><span>{capabilities?`输入上限 ${capabilities.limits.maxDurationS} 秒 · ${capabilities.limits.maxHeightPx}p · MP4/MOV（H.264/H.265）`:'读取限制中…'}</span></div>
        <div className="studio-create">
          <input aria-label="项目名称" placeholder="项目名称，例如：城市混剪 01" value={name} maxLength={80} onChange={event=>setName(event.target.value)}/>
          <p className="muted">上传后自动生成全片镜头表、关键帧与逐镜语义，不确定项集中修正。拉片完成后，可进入角色归组和三维还原；项目默认使用内置场景。</p>
          <button className="primary" disabled={busy||!name.trim()} onClick={create}>{busy?'创建中…':'创建项目'}</button>
        </div>
      </section>
      <section className="studio-card">
        <div className="panel-title"><h2>项目列表</h2><span>{projects?`${projects.length} 个`:'载入中…'}</span></div>
        {projects&&projects.length===0&&<p className="muted">还没有项目。上传的素材保存在本机 data/projects/ 下，与 JWM 样片数据互不影响。</p>}
        <div className="studio-project-grid">{projects?.map(project=>(
          <button key={project.id} className="studio-project-card" onClick={()=>onOpen(project.id)}>
            <div><b>{project.name}</b><span className={`studio-phase phase-${project.phase}`}>{PHASE_LABELS[project.phase]||project.phase}</span></div>
            <small>{project.sceneMode==='proxy'?'默认场景':'从视频还原场景（待开发）'} · {project.shotCount||0} 镜 · {project.personCount||0} 个人物候选</small>
            <small>创建于 {new Date(project.createdAt).toLocaleString('zh-CN')}</small>
          </button>))}</div>
      </section>
    </main>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button onClick={()=>show('')}>×</button></div>}
  </div>;
}

// ---- 项目工作台 ----
function JobsStrip({detail,onChanged,show}:{detail:ProjectDetail;onChanged:()=>void;show:(message:string)=>void}){
  const activeJobs=detail.jobs.filter(job=>job.state==='queued'||job.state==='running');
  const recentJobs=detail.jobs.filter(job=>job.state!=='queued'&&job.state!=='running').slice(0,4);
  useEffect(()=>{if(activeJobs.length===0)return;const timer=window.setInterval(onChanged,1500);return()=>window.clearInterval(timer);},[activeJobs.length,onChanged]);
  const act=async(job:JobInfo,action:'cancel'|'retry')=>{try{await request(`/api/studio/jobs/${job.id}/${action}`,{baseRevision:detail.project.revision},'POST');onChanged();}catch(e){show((e as Error).message);}};
  return <section className="studio-card" id="studio-jobs">
    <div className="panel-title"><h2>分析任务</h2><span>{activeJobs.length>0?`${activeJobs.length} 个进行中`:'空闲'}</span></div>
    {detail.jobs.length===0&&<p className="muted">导入后依次执行：素材预览 → 源帧时间戳 → 候选切镜 → 关键帧 → 逐镜语义 → 全片报告。</p>}
    {[...activeJobs,...recentJobs].map(job=>(
      <div key={job.id} className={`studio-job job-${job.state}`}>
        <div className="studio-job-head"><b>{KIND_LABELS[job.kind]||job.kind}</b><span>{job.state==='done'?'已完成':job.state==='failed'?'失败':job.state==='cancelled'?'已取消':job.state==='running'?`进行中 ${Math.round(job.progress*100)}%`:'排队中'}</span></div>
        {job.state==='running'&&<div className="studio-progress"><div style={{width:`${Math.max(3,job.progress*100)}%`}}/></div>}
        {job.output&&<small>{job.output}</small>}
        {job.error&&<small className="studio-job-error">{job.error}</small>}
        {(job.state==='failed'||job.state==='cancelled')&&<div className="studio-job-actions"><button onClick={()=>act(job,'retry')}>重试</button></div>}
        {job.state==='running'&&<div className="studio-job-actions"><button onClick={()=>act(job,'cancel')}>取消</button></div>}
      </div>))}
  </section>;
}

function ImportSection({detail,show,onChanged}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void}){
  const inputRef=useRef<HTMLInputElement>(null);
  const[progress,setProgress]=useState<number|null>(null);
  const media=detail.media;
  const upload=()=>{
    const file=inputRef.current?.files?.[0];
    if(!file)return;
    const xhr=new XMLHttpRequest();
    const query=new URLSearchParams({name:file.name,baseRevision:detail.project.revision});
    xhr.open('POST',`/api/studio/projects/${detail.project.id}/media?${query}`);
    xhr.upload.onprogress=event=>{if(event.lengthComputable)setProgress(event.loaded/event.total);};
    xhr.onload=()=>{setProgress(null);if(xhr.status===200){show('导入成功，已开始自动拉片。镜头表和待修正项会陆续显示。');onChanged();}else{try{show(JSON.parse(xhr.responseText).error||`上传失败（${xhr.status}）`);}catch{show(`上传失败（${xhr.status}）`);}}};
    xhr.onerror=()=>{setProgress(null);show('上传网络错误');};
    setProgress(0);
    xhr.send(file);
  };
  if(!media)return <section className="studio-card">
    <div className="panel-title"><h2>导入媒体</h2><span>MP4/MOV · H.264/H.265</span></div>
    <p className="muted">原片只读保存并计算 SHA-256；分析一律使用源时间戳（支持可变帧率），不会以固定帧率推算。超出范围会得到明确原因与预处理建议。</p>
    <div className="studio-upload-row">
      <input ref={inputRef} type="file" accept=".mp4,.mov,video/mp4,video/quicktime" aria-label="选择视频文件" onChange={upload} disabled={progress!==null}/>
    </div>
    {progress!==null&&<div className="studio-progress"><div style={{width:`${Math.max(3,progress*100)}%`}}/></div>}
  </section>;
  return <section className="studio-card">
    <div className="panel-title"><h2>已导入媒体</h2><span>{media.vfr?'可变帧率（VFR）':`${media.fps.toFixed(2)} fps`}</span></div>
    <div className="studio-media-grid">
      <video className="studio-media-video" src={`/api/studio/projects/${detail.project.id}/media/preview`} controls preload="metadata"/>
      <dl className="studio-media-facts">
        <div><dt>文件</dt><dd>{media.originalName}</dd></div>
        <div><dt>时长</dt><dd>{seconds(media.durationUs)} · {media.ptsCount} 个呈现帧</dd></div>
        <div><dt>画面</dt><dd>{media.width}×{media.height}{media.rotation?` · 旋转 ${media.rotation}°`:''}</dd></div>
        <div><dt>编码</dt><dd>{media.videoCodec}{media.audioCodec?` / ${media.audioCodec}`:' / 无音轨'}</dd></div>
        <div><dt>SHA-256</dt><dd title={media.sha256}>{media.sha256.slice(0,16)}…</dd></div>
        <div><dt>时间基</dt><dd>{media.timebase}</dd></div>
      </dl>
    </div>
  </section>;
}

function CutsSection({detail,show,onChanged,selectedShotId,selectShot}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;selectShot:(id:string)=>void}){
  const[editing,setEditing]=useState(false);
  const[cutText,setCutText]=useState('');
  const media=detail.media;
  const startCuts=async()=>{try{await request(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'cuts'},'POST');show('已重新发起自动切镜（生成候选新版）。');onChanged();}catch(e){show((e as Error).message);}};
  const[detectSubject,setDetectSubject]=useState<'person'|'animal'|'both'>('person');
  const startDetect=async()=>{try{await request(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'detect',subjects:detectSubject},'POST');show(`已发起${detectSubject==='person'?'人物':detectSubject==='animal'?'动物':'人物+动物'}检测任务。`);onChanged();}catch(e){show((e as Error).message);}};
  const beginEdit=()=>{setCutText(detail.shots.slice(1).map(shot=>shot.startFrame).join(', '));setEditing(true);};
  const saveCuts=async()=>{const cutFrames=cutText.split(/[,，\s]+/).filter(Boolean).map(Number);try{await request(`/api/studio/projects/${detail.project.id}/shots`,{cutFrames,baseRevision:detail.project.revision},'PATCH');setEditing(false);show('切点已保存；此前基于旧切点的确认已失效。');onChanged();}catch(e){show((e as Error).message);}};
  if(!media)return null;
  return <section className="studio-card">
    <div className="panel-title"><h2 id="studio-cuts">切镜</h2><span>{detail.shots.length} 镜 · {detail.shots[0]?.source==='user'?'人工切点':`算法 ${detail.algorithms.cuts}`}</span></div>
    <div className="studio-toolbar">
      <button onClick={startCuts} disabled={detail.jobs.some(job=>(job.kind==='cuts')&&(job.state==='queued'||job.state==='running'))}>重新自动切镜</button>
      <select aria-label="检测对象" value={detectSubject} onChange={event=>setDetectSubject(event.target.value as typeof detectSubject)}>
        <option value="person">检测：人物</option>
        <option value="animal">检测：动物</option>
        <option value="both">检测：人物 + 动物</option>
      </select>
      <button onClick={startDetect}>发起检测</button>
      {!editing&&<button className="ghost" onClick={beginEdit} disabled={detail.shots.length===0}>编辑切点</button>}
      <span className="muted">自动切点可修正；改切点会使既有确认失效（下游批准自动失效）。</span>
    </div>
    {editing&&<div className="studio-cut-editor">
      <label>切点帧号（新镜头首个呈现帧，逗号分隔；不含 0 与末帧）<textarea value={cutText} rows={2} onChange={event=>setCutText(event.target.value)}/></label>
      <div><button className="primary" onClick={saveCuts}>保存切点</button><button className="ghost" onClick={()=>setEditing(false)}>取消</button></div>
    </div>}
    {detail.shots.length>0&&<div className="studio-shot-strip">
      {detail.shots.map(shot=>(
        <button key={shot.id} className={`studio-shot-card ${shot.id===selectedShotId?'selected':''}`} onClick={()=>selectShot(shot.id)}>
          <img src={`/api/studio/projects/${detail.project.id}/shots/${shot.id}/preview`} alt={`${shot.id} 中间帧`} loading="lazy"/>
          <span>{shot.id}</span>
          <small>{seconds(shot.startUs)}–{seconds(shot.endUs)}</small>
        </button>))}
    </div>}
  </section>;
}

function TracksSection({detail,show,onChanged,selectedShotId,selectShot}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;selectShot:(id:string)=>void}){
  const[adding,setAdding]=useState(false);
  const[form,setForm]=useState({startFrame:'',endFrame:'',x:'0.3',y:'0.2',w:'0.25',h:'0.5'});
  const shot=detail.shots.find(item=>item.id===selectedShotId)||detail.shots[0];
  const bindingByTrack=new Map(detail.bindings.map(binding=>[binding.trackId,binding]));
  const characterById=new Map(detail.characters.map(character=>[character.id,character]));
  const tracks=detail.tracks.filter(track=>track.status==='active'&&(!shot||track.shotId===shot.id));
  const changeCharacter=async(track:TrackInfo,value:string)=>{
    const assignment=value==='unassigned'?{trackId:track.id,disposition:'unassigned'}:value==='ignored'?{trackId:track.id,disposition:'ignored'}:{trackId:track.id,characterId:value,disposition:'bound'};
    try{await request(`/api/studio/projects/${detail.project.id}/cast`,{baseRevision:detail.project.revision,assignments:[assignment]},'PATCH');onChanged();}catch(e){show((e as Error).message);}
  };
  const mutate=async(action:string,payload:Record<string,unknown>)=>{try{await request(`/api/studio/projects/${detail.project.id}/tracks/${String(payload.trackId)}/${action}`,{...payload,baseRevision:detail.project.revision},'POST');onChanged();}catch(e){show((e as Error).message);}};
  const addTrack=async()=>{if(!shot)return;const payload={shotId:shot.id,startFrame:Number(form.startFrame),endFrame:Number(form.endFrame),box:{x:Number(form.x),y:Number(form.y),w:Number(form.w),h:Number(form.h)}};
    try{await request(`/api/studio/projects/${detail.project.id}/shots/${shot.id}/tracks`,{...payload,baseRevision:detail.project.revision},'POST');setAdding(false);show('已补标出场候选。');onChanged();}catch(e){show((e as Error).message);}};
  if(detail.shots.length===0)return null;
  return <section className="studio-card">
    <div className="panel-title"><h2>逐镜出场修正</h2><span>{detail.tracks.filter(track=>track.status==='active').length} 条有效 · {detail.pendingTrackIds.length} 条待处理</span></div>
    <div className="studio-toolbar">
      <select aria-label="选择镜头" value={shot?.id||''} onChange={event=>selectShot(event.target.value)}>
        {detail.shots.map(item=><option key={item.id} value={item.id}>{item.id} · {seconds(item.startUs)}–{seconds(item.endUs)} · {detail.tracks.filter(track=>track.status==='active'&&track.shotId===item.id).length} 人次</option>)}
      </select>
      <button onClick={()=>setAdding(value=>!value)}>{adding?'收起补标':'补标出场'}</button>
      <span className="muted">跨切镜不自动连接轨迹；误检删除、拆分、连接均保留版本记录。</span>
    </div>
    {adding&&shot&&<div className="studio-add-track">
      <label>起始帧<input type="number" value={form.startFrame} placeholder={String(shot.startFrame)} onChange={event=>setForm(f=>({...f,startFrame:event.target.value}))}/></label>
      <label>结束帧<input type="number" value={form.endFrame} placeholder={String(shot.endFrameExclusive-1)} onChange={event=>setForm(f=>({...f,endFrame:event.target.value}))}/></label>
      <label>框 X<input type="number" step="0.05" value={form.x} onChange={event=>setForm(f=>({...f,x:event.target.value}))}/></label>
      <label>框 Y<input type="number" step="0.05" value={form.y} onChange={event=>setForm(f=>({...f,y:event.target.value}))}/></label>
      <label>宽<input type="number" step="0.05" value={form.w} onChange={event=>setForm(f=>({...f,w:event.target.value}))}/></label>
      <label>高<input type="number" step="0.05" value={form.h} onChange={event=>setForm(f=>({...f,h:event.target.value}))}/></label>
      <button className="primary" onClick={addTrack}>添加候选</button>
    </div>}
    <div className="studio-track-grid">
      {shot&&tracks.map(track=>{
        const binding=bindingByTrack.get(track.id);
        const value=binding?.disposition==='bound'?binding.characterId||'':binding?.disposition==='ignored'?'ignored':'unassigned';
        return <div key={track.id} className={`studio-track-card ${binding?'':'studio-track-pending'}`}>
          <img src={`/api/studio/projects/${detail.project.id}/tracks/${track.id}/preview`} alt={`${shot.id} 出场截图`} loading="lazy"/>
          <div className="studio-track-meta">
            <b>{track.subject==='animal'?'🐾 动物 · ':'自动候选'} · 置信 {track.confidence.toFixed(2)}</b>
            <small>帧 {track.startFrame}–{track.endFrame} · {seconds(track.startUs)}–{seconds(track.endUs)}</small>
            {track.subject==='animal'
              ?<small>动物仅作画面标注，不参与角色归并与确认。</small>
              :<select aria-label={`为 ${track.id} 指定角色`} value={value} onChange={event=>changeCharacter(track,event.target.value)}>
              <option value="unassigned">未分配（阻止确认）</option>
              <option value="ignored">忽略（路人/误检）</option>
              {detail.characters.map(character=><option key={character.id} value={character.id}>归并 → {character.name}</option>)}
            </select>}
            <div className="studio-track-actions">
              <button onClick={()=>{const input=window.prompt('拆分帧号：',String(Math.floor((track.startFrame+track.endFrame)/2)));if(input)mutate('split',{trackId:track.id,splitFrame:Number(input)});}}>拆分</button>
              {tracks.filter(other=>other.id!==track.id&&other.startFrame>=track.endFrame).slice(0,1).map(other=><button key={other.id} onClick={()=>mutate('merge',{trackId:track.id,otherTrackId:other.id})}>连接下一段</button>)}
              <button className="danger" onClick={()=>{if(window.confirm('确认删除该候选（误检）？'))mutate('delete',{trackId:track.id});}}>删除误检</button>
            </div>
            {binding&&binding.disposition==='bound'&&characterById.get(binding.characterId||'')&&<small>已归并 → {characterById.get(binding.characterId||'')!.name}</small>}
            {binding&&binding.disposition==='ignored'&&<small>已忽略</small>}
          </div>
        </div>;})}
      {shot&&tracks.length===0&&<p className="muted">{shot.id} 暂无出场候选。空镜属正常；如有人物请“补标出场”。</p>}
    </div>
  </section>;
}

function CastingSection({detail,show,onChanged}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void}){
  const[name,setName]=useState('');
  const[color,setColor]=useState('#28543F');
  const[scale,setScale]=useState('1.75');
  const[allowSimultaneous,setAllowSimultaneous]=useState(false);
  const activeTracks=detail.tracks.filter(track=>track.status==='active');
  const approval=detail.approval;
  const createCharacter=async()=>{try{await request(`/api/studio/projects/${detail.project.id}/characters`,{name,color,scale:Number(scale),allowSimultaneous,baseRevision:detail.project.revision},'POST');setName('');show('角色资产已创建。');onChanged();}catch(e){show((e as Error).message);}};
  const toggleSimultaneous=async(character:CharacterInfo)=>{try{await request(`/api/studio/projects/${detail.project.id}/characters/${character.id}`,{allowSimultaneous:!character.allowSimultaneous,baseRevision:detail.project.revision},'PATCH');onChanged();}catch(e){show((e as Error).message);}};
  const updateCharacter=async(character:CharacterInfo,fields:Record<string,unknown>)=>{try{await request(`/api/studio/projects/${detail.project.id}/characters/${character.id}`,{...fields,baseRevision:detail.project.revision},'PATCH');onChanged();}catch(e){show((e as Error).message);}};
  const approve=async()=>{try{await request(`/api/studio/projects/${detail.project.id}/approve-cast`,{baseRevision:detail.project.revision},'POST');show('角色映射已正式确认，输入与算法版本已冻结。');onChanged();}catch(e){show((e as Error).message);}};
  const canApprove=detail.invalidTrackIds.length===0&&detail.pendingTrackIds.length===0&&detail.conflicts.length===0&&activeTracks.length>0;
  const characterName=(id:string)=>detail.characters.find(character=>character.id===id)?.name||id;
  return <section className="studio-card" id="studio-cast">
    <div className="panel-title"><h2>代理角色组与确认</h2><span>{detail.characters.length} 个代理角色组</span></div>
    <div className="studio-cast-grid">
      <div className="studio-characters">
        <h3>代理角色组</h3>
        {detail.characters.map(character=>(
          <div key={character.id} className="studio-character-row">
            <span className="studio-character-swatch" style={{background:character.color}}/>
            <div><b>{character.name}{character.provisional&&<span className="studio-provisional">暂定</span>}</b><small>身高 {character.scale.toFixed(2)} m · 版本 {character.revision.slice(0,8)}</small></div>
            <label>身高 m<input key={`${character.id}:${character.scale}`} aria-label={`${character.name} 身高`} type="number" min="0.2" max="3" step="0.05" defaultValue={character.scale} onBlur={event=>{const value=Number(event.currentTarget.value);if(!Number.isFinite(value)||value<0.2||value>3){event.currentTarget.value=String(character.scale);show('身高请输入 0.2–3 米。');return;}if(value!==character.scale)void updateCharacter(character,{scale:value});}} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}/></label>
            <select aria-label={`${character.name} 代理级别`} value={character.proxyLevel||'CL1'} onChange={event=>updateCharacter(character,{proxyLevel:event.target.value})}>
              {['CL0','CL1','CL2'].map(level=><option key={level} value={level}>{level}</option>)}
            </select>
            <label className="studio-tiny-toggle"><input type="checkbox" checked={character.allowSimultaneous} onChange={()=>toggleSimultaneous(character)}/>允许同框（分身/镜像）</label>
          </div>))}
        {detail.characters.length===0&&<p className="muted">还没有成片角色。角色不等于原片演员：不同演员可归并为同一角色，同一演员也可拆成多个角色。</p>}
        <div className="studio-character-create">
          <input aria-label="角色名称" placeholder="角色名称" value={name} maxLength={40} onChange={event=>setName(event.target.value)}/>
          <label>颜色<input type="color" value={color} onChange={event=>setColor(event.target.value)} aria-label="角色颜色"/></label>
          <label>身高 m<input type="number" step="0.05" min="0.2" max="3" value={scale} onChange={event=>setScale(event.target.value)} aria-label="角色身高"/></label>
          <button className="primary" disabled={!name.trim()} onClick={createCharacter}>创建代理角色组</button>
        </div>
      </div>
      <div className="studio-approval">
        <h3>正式确认门槛</h3>{detail.invalidTrackIds.length>0&&<p role="alert" className="studio-job-error">有 {detail.invalidTrackIds.length} 段出场越过当前镜头边界，请在逐镜出场修正中处理。</p>}
        <ul>
          <li className={detail.pendingTrackIds.length?'bad':'ok'}>{detail.pendingTrackIds.length?`${detail.pendingTrackIds.length} 条候选未绑定或未忽略`:'✓ 所有有效候选均已绑定或明确忽略'}</li>
          <li className={detail.conflicts.length?'bad':'ok'}>{detail.conflicts.length?`${detail.conflicts.length} 处同镜同角色冲突`:'✓ 无未解释的同框冲突'}</li>
          <li className={detail.project.phase==='draft'?'bad':'ok'}>{detail.project.phase==='draft'?'素材尚未分析完成':'✓ 素材分析完成'}</li>
        </ul>
        {detail.conflicts.length>0&&<div className="studio-conflicts">
          {detail.conflicts.map((conflict,index)=><small key={index}>{conflict.shotId}：{characterName(conflict.characterId)} 由 {conflict.trackA.slice(0,10)}… 与 {conflict.trackB.slice(0,10)}… 同框（帧 {conflict.overlapFrames[0]}–{conflict.overlapFrames[1]}）。如确属分身/镜像，请在角色上勾选“允许同框”。</small>)}
        </div>}
        {approval&&<div className={`studio-approval-state ${approval.status}`}>
          <b>{approval.status==='approved'?'已确认（生效中）':'已失效——上游输入或归并被修改，需重新确认'}</b>
          <small>冻结于 {new Date(approval.approved_at).toLocaleString('zh-CN')} · 切点版本 {approval.frozen.shots.revision.slice(0,8)} · 候选版本 {approval.frozen.tracks.revision.slice(0,8)} · 归并版本 {approval.frozen.bindings.revision.slice(0,8)} · 切镜算法 {approval.frozen.algorithmVersions.cuts}</small>
        </div>}
        <button className="primary studio-approve" disabled={!canApprove||approval?.status==='approved'} onClick={approve}>{approval?.status==='approved'?'已正式确认':'正式确认角色映射'}</button>
        <p className="muted">确认会冻结媒体哈希、切镜、候选与归并版本；此后任何上游修改都会使确认自动失效并回退到“素材已分析”。</p>
      </div>
    </div>
  </section>;
}

function CameraSection({detail,show,onChanged,selectedShotId,selectShot}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;selectShot:(id:string)=>void}){
  const[pointsText,setPointsText]=useState('');
  const[personTrackId,setPersonTrackId]=useState('');
  const shot=detail.shots.find(item=>item.id===selectedShotId)||detail.shots[0];
  const shotCameras=detail.cameraTracks.filter(camera=>!shot||camera.shotId===shot.id);
  const solve=async(mode:'landmarks'|'person')=>{
    try{
      const payload:any={mode,baseRevision:detail.project.revision};
      if(mode==='landmarks'){
        const points=JSON.parse(pointsText||'[]');
        if(!Array.isArray(points)||points.length<6)throw Object.assign(new Error('至少需要 6 个 {X:[x,y,z], x:[u,v]} 对应'),{status:400});
        payload.points=points;
      }else payload.trackId=personTrackId;
      const result=await request<{camera:CameraTrackInfo&{note?:string;distanceMeters?:number}}>(`/api/studio/projects/${detail.project.id}/shots/${shot?.id}/camera`,payload,'POST');
      show(result.camera.needsManualReview?`相机已保存（${result.camera.source}，待人工确认）：${result.camera.note||''}`:`相机已保存：中位重投影 ${result.camera.medianErrorPx}px（达标 ≤8px）`);
      onChanged();
    }catch(e){show((e as Error).message);}
  };
  if(detail.shots.length===0)return null;
  return <section className="studio-card">
    <div className="panel-title"><h2>相机求解（M4）</h2><span>算法 {detail.algorithms.camera}</span></div>
    <p className="muted">有 ≥6 个已知三维地标时用 PnP（A5：中位重投影 ≤8px 为高置信）；证据不足时只能得到粗略估计并标记待人工确认。相机与可见场景相互独立。</p>
    <div className="studio-toolbar">
      <select aria-label="按镜头求解" value={shot?.id||''} onChange={event=>selectShot(event.target.value)}>
        {detail.shots.map(item=><option key={item.id} value={item.id}>{item.id}</option>)}
      </select>
      <select aria-label="人物框估计所用的出场" value={personTrackId} onChange={event=>setPersonTrackId(event.target.value)}>
        <option value="">（选择出场候选用于粗估）</option>
        {detail.tracks.filter(track=>track.status==='active'&&(!shot||track.shotId===shot.id)).map(track=><option key={track.id} value={track.id}>{track.id}（帧 {track.startFrame}–{track.endFrame}）</option>)}
      </select>
      <button disabled={!shot||!personTrackId} onClick={()=>solve('person')}>人物框粗估</button>
      <button disabled={!shot} onClick={()=>solve('landmarks')}>地标 PnP 求解</button>
      <button disabled={!shot} onClick={async()=>{try{await request(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'camera'},'POST');show('已发起人物尺度运镜估计（含推拉，结果为估计值）。');onChanged();}catch(e){show((e as Error).message);}}}>估计运镜（人物尺度）</button>
    </div>
    <label className="studio-landmark-editor">地标对应（JSON：X 为米制三维，x 为画面像素）
      <textarea rows={3} value={pointsText} placeholder='[{"X":[0,0,0],"x":[320,180]},{"X":[2,0,0],"x":[960,180]},{"X":[0,1.5,0],"x":[320,540]},{"X":[2,1.5,0],"x":[960,540]},{"X":[1,0,1],"x":[500,300]},{"X":[1,1.5,1],"x":[700,520]}]' onChange={event=>setPointsText(event.target.value)}/>
    </label>
    {shotCameras.length>0&&<div className="studio-camera-list">
      {shotCameras.map(camera=>(
        <div key={camera.id} className={`studio-camera-row ${camera.needsManualReview?'warn':''}`}>
          <b>{camera.source==='landmark-pnp'?'地标 PnP':'人物框粗估'}</b>
          <span>{camera.medianErrorPx!==null?`中位重投影 ${camera.medianErrorPx}px`:'无重投影证据'}</span>
          <span>置信 {camera.confidence.toFixed(2)}</span>
          {camera.needsManualReview&&<em>待人工确认</em>}
        </div>))}
    </div>}
  </section>;
}

function MotionExportSection({detail,show,onChanged}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void}){
  const[exportsList,setExportsList]=useState<ExportSummary[]|null>(null);
  const activeJobs=detail.jobs.filter(job=>job.state==='queued'||job.state==='running');
  const loadExports=useCallback(()=>{request<{exports:ExportSummary[]}>(`/api/studio/projects/${detail.project.id}/exports`).then(r=>setExportsList(r.exports)).catch(()=>{});},[detail.project.id]);
  useEffect(()=>{loadExports();},[loadExports,activeJobs.length]);
  const start=async(kind:'motion'|'export')=>{try{await request(`/api/studio/projects/${detail.project.id}/analysis`,{kind},'POST');show(kind==='motion'?'已发起连续动作生成任务。':'已发起交付包导出任务。');onChanged();}catch(e){show((e as Error).message);}};
  const motionCount=Object.keys(detail.motionRefs).length;
  return <section className="studio-card">
    <div className="panel-title"><h2>连续动作与交付（M5 / M6）</h2><span>{motionCount} 条动作 · {exportsList?`${exportsList.length} 个交付包`:'…'}</span></div>
    <p className="muted">连续动作为固定骨长的可审查近似还原（单目深度歧义无法消除；接触确认需人工逐镜复核）。交付包含镜头表、归并清单、相机与逐实例动作，以及每组共享的 GLB 代理资产（含各段出场动画）；预览视频渲染与可见场景资产不在本首版范围内。</p>
    <div className="studio-toolbar">
      <button onClick={()=>start('motion')} disabled={activeJobs.some(job=>job.kind==='motion')}>生成连续动作（已归并候选）</button>
      <button onClick={()=>start('export')} disabled={activeJobs.some(job=>job.kind==='export')}>生成交付包</button>
    </div>
    {exportsList&&exportsList.length>0&&<div className="studio-export-list">
      {exportsList.map(item=>(
        <div key={item.exportId} className="studio-export-card">
          <div><b>{item.exportId}</b>{item.broken&&<span>（清单损坏）</span>}{item.instanceCount!==undefined&&<span> · {item.instanceCount} 个实例</span>}{item.generatedAt&&<span> · {new Date(item.generatedAt).toLocaleString('zh-CN')}</span>}</div>
          <div className="studio-export-links">
            <a href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=manifest.json`}>manifest.json</a>
            <a href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=shots.json`}>shots.json</a>
            <a href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=cast.json`}>cast.json</a>
            <a href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=cameras.json`}>cameras.json</a>
            {item.included?.some(entry=>entry.startsWith('timeline.json'))&&<a href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=timeline.json`}>timeline.json</a>}
            {item.characterGlbs?.map(glb=><a key={glb.characterId+glb.file} href={`/api/studio/projects/${detail.project.id}/exports/${item.exportId}/file?path=characters/${glb.file}`}>{glb.file}</a>)}
          </div>
        </div>))}
    </div>}
  </section>;
}

function ProjectWorkspace({projectId,onBack,onModelSettings,modelSettingsRevision}:{projectId:string;onBack:()=>void;onModelSettings:()=>void;modelSettingsRevision:number}){
  const[detail,setDetail]=useState<ProjectDetail|null>(null);
  const[selectedShotId,setSelectedShotId]=useState('');
  const[settings,setSettings]=useState(false);
  const[laterOpen,setLaterOpen]=useState<boolean|null>(null);
  const{toast,show}=useToast();
  const load=useCallback(()=>request<ProjectDetail>(`/api/studio/projects/${projectId}`).then(next=>{setDetail(next);setSelectedShotId(current=>next.shots.some(shot=>shot.id===current)?current:next.shots[0]?.id||'');}).catch(e=>show(e.message)),[projectId,show]);
  useEffect(()=>{void load();},[load,modelSettingsRevision]);
  if(!detail)return <div className="studio"><header className="topbar"><div className="identity"><span className="brand-mark studio-mark">M</span><div><strong>MotionStage</strong><small>载入中…</small></div></div><a className="quiet-link" href="#" onClick={event=>{event.preventDefault();onBack();}}>← 返回项目列表</a></header><main className="studio-main"><p className="muted">载入项目数据…</p></main>{toast&&<div className="toast" role="status"><span>{toast}</span><button onClick={()=>show('')}>×</button></div>}</div>;
  const phaseIndex=PHASE_ORDER.indexOf(detail.project.phase);
  const analysisFirst=detail.workflowTarget==='shot_analysis'||!detail.media;
  const sceneLabel=detail.project.sceneMode==='proxy'?'默认场景（内置舞台）':detail.project.sceneStatus==='approved'?'视频还原场景已批准':'视频还原场景待做（M4S 未实现）';
  return <div className="studio">
    <header className="topbar"><div className="identity"><span className="brand-mark studio-mark">M</span><div><strong>{detail.project.name} <i>/</i> {detail.project.sceneMode==='proxy'?'默认场景':'视频还原场景'}</strong><small>MotionStage · 版本 {detail.project.revision} · 更新于 {new Date(detail.project.updatedAt).toLocaleString('zh-CN')}</small></div></div><div className="top-meta"><button onClick={onModelSettings}>模型设置</button><button onClick={()=>setSettings(true)}>项目设置</button><span className={`studio-scene scene-${detail.project.sceneStatus}`}>{sceneLabel}</span><a className="quiet-link" href="#" onClick={event=>{event.preventDefault();onBack();}}>← 项目列表</a></div></header>
    {settings&&<ProjectSettings detail={detail} onClose={()=>setSettings(false)} onChanged={load} onDeleted={onBack} show={show}/>}
    {analysisFirst?<nav className="studio-steps" aria-label="阶段"><div className={`studio-step ${detail.media?'done':'current'}`}><span>{detail.media?'✓':1}</span><b>导入素材</b><em>›</em></div><div className={`studio-step ${detail.media?'current':''}`}><span>2</span><b>自动拉片与集中修正</b><em>›</em></div><div className="studio-step"><span>3</span><b>后续：角色与三维还原</b></div></nav>:<nav className="studio-steps" aria-label="阶段">{PHASE_ORDER.map((phase,index)=>(
      <div key={phase} className={`studio-step ${index===phaseIndex?'current':''} ${index<phaseIndex?'done':''}`}>
        <span>{index<phaseIndex?'✓':index+1}</span><b>{PHASE_LABELS[phase]}</b><em>›</em>
      </div>))}
      <div className="studio-step locked"><span>…</span><b>{PHASE_LABELS.keyframes_confirmed}之后阶段由 M4–M6 实现</b></div>
    </nav>}
    <main className="studio-main">
      {detail.media?<details className="studio-import-details"><summary>已导入：{detail.media.originalName} · {seconds(detail.media.durationUs)} · 素材信息</summary><ImportSection detail={detail} show={show} onChanged={load}/></details>:<ImportSection detail={detail} show={show} onChanged={load}/>}
      <StudioShotAnalysis detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} selectShot={setSelectedShotId} onModelSettings={onModelSettings}/>
      <JobsStrip detail={detail} onChanged={load} show={show}/>
      <details className="studio-later-stages" open={laterOpen??!analysisFirst} onToggle={event=>setLaterOpen(event.currentTarget.open)}><summary>后续工作台 · 人物 / 动物、角色分组与三维还原</summary>{(laterOpen??!analysisFirst)&&<div className="studio-later-content">
      {detail.draft&&detail.draft.state!=='not_ready'&&<section className={`studio-card studio-draft draft-${detail.draft.state}`}>
        <div className="panel-title"><h2>三维初稿</h2><span>{detail.draft.state==='building'?'自动生成中…':detail.draft.state==='ready'?'可整片播放':detail.draft.state==='ready_with_issues'?'可播放 · 有待修正项':detail.draft.state==='blocked'?'被失败任务阻塞':'未开始'}</span></div>
        <p className="muted">{detail.draft.note||''}{detail.draft.coveragePct!==null?` 有效动作时间覆盖：${detail.draft.coveragePct}%（${((detail.draft.solvedDurationUs||0)/1e6).toFixed(2)} / ${((detail.draft.visibleDurationUs||0)/1e6).toFixed(2)} 主体秒，包含未绑定人物和动物）。`:''}{detail.draft.state==='building'?' 上传后的自动链（检测 → 人物汇总 → 临时组 → 动作）正在执行，无需人工点击。':''}</p>
        {!!detail.draft.issues?.length&&<details className="studio-quality-issues"><summary>待修正项（{detail.draft.issues.length}）</summary><ul>{detail.draft.issues.map((issue,index)=><li key={`${issue.code}:${issue.trackId||issue.shotId||index}:${index}`}>{issue.shotId&&<b>{issue.shotId} · </b>}{issue.message}{issue.trackId&&<small> · {issue.trackId}</small>}</li>)}</ul></details>}
      </section>}
      <CutsSection detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} selectShot={setSelectedShotId}/>
      <PeopleSection detail={detail} show={show} onChanged={load} selectShot={setSelectedShotId}/>
      <details className="studio-track-tools"><summary>逐镜出场修正：补标、删除误检、拆分轨迹</summary><TracksSection detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} selectShot={setSelectedShotId}/></details>
      <CameraSection detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} selectShot={setSelectedShotId}/>
      <CastingSection detail={detail} show={show} onChanged={load}/>
      <StageSection detail={detail} selectedShotId={selectedShotId} selectShot={setSelectedShotId}/>
      <section className="studio-card" id="studio-playback">
        <div className="panel-title"><h2>整片同步播放</h2><span>原片时钟 · 空镜正常播放 · 占位如实标注</span></div>
        {detail.shots.length===0?<p className="muted">等待切镜完成后可用。</p>:<StudioPlayback detail={detail}/>}
      </section>
      <MotionExportSection detail={detail} show={show} onChanged={load}/>
      </div>}</details>
      <details className="studio-history"><summary>版本历史（{detail.history.length} 条，全程可追溯）</summary><ol>{detail.history.map((entry,index)=><li key={index}><b>{entry.revision}</b> · {new Date(entry.time).toLocaleString('zh-CN')} · {entry.reason}</li>)}</ol></details>
    </main>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button onClick={()=>show('')}>×</button></div>}
  </div>;
}

export function Studio(){
  const[projectId,setProjectId]= useState<string|null>(new URLSearchParams(location.search).get('project'));
  const[modelsOpen,setModelsOpen]=useState(new URLSearchParams(location.search).get('settings')==='models');
  const[modelSettingsRevision,setModelSettingsRevision]=useState(0);
  const openModels=()=>{setModelsOpen(true);const url=new URL(location.href);url.searchParams.set('settings','models');history.replaceState(null,'',url);};
  const closeModels=()=>{setModelsOpen(false);const url=new URL(location.href);url.searchParams.delete('settings');history.replaceState(null,'',url);};
  return <>{projectId?<ProjectWorkspace projectId={projectId} onBack={()=>{setProjectId(null);history.replaceState(null,'','/');}} onModelSettings={openModels} modelSettingsRevision={modelSettingsRevision}/>:<ProjectList onOpen={id=>{setProjectId(id);history.replaceState(null,'',`/?project=${id}`);}} onModelSettings={openModels}/>} {modelsOpen&&<StudioModelSettings onClose={closeModels} onChanged={()=>setModelSettingsRevision(value=>value+1)}/>}</>;
}
export default Studio;
