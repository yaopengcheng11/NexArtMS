import React,{lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react';
import './studio.css';
import './studio-workspaces.css';
import {PeopleSection, ProjectSettings, discardProjectSettingsDraft, type PersonInfo} from './StudioPeople';
const StudioPlayback=lazy(()=>import('./StudioPlayback').then(module=>({default:module.StudioPlayback})));
import {StudioShotAnalysis,type AnalysisWorkspaceInfo} from './StudioShotAnalysis';
import {StudioModelSettings} from './StudioModelSettings';
import {StudioDialog,StudioIcon} from './StudioPrimitives';
import type {ShotAnalysis,ShotProviderStatus} from './studio-shot-analysis-types';

// ---- 类型：与 studio/router.mjs 的 JSON 契约一致 ----
interface ProjectSummary{id:string;revision:string;name:string;sceneMode:'proxy'|'reconstruct';phase:string;sceneStatus:string;createdAt:string;updatedAt:string;trackCount?:number;shotCount?:number;personCount?:number;animalCount?:number}
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
  const input=useRef<HTMLInputElement>(null);
  const[uploadProgress,setUploadProgress]=useState<number|null>(null);
  const[pendingProject,setPendingProject]=useState<ProjectSummary|null>(null);
  const pendingFile=useRef('');
  const[busy,setBusy]=useState(false);
  const[listError,setListError]=useState('');
  const[importError,setImportError]=useState('');
  const{toast,show}=useToast();
  const load=useCallback(()=>{request<{projects:ProjectSummary[]}>('/api/studio/projects').then(r=>{setProjects(r.projects);setListError('');}).catch(e=>{setListError(e.message);show(e.message);});},[show]);
  useEffect(()=>{load();request<Capabilities>('/api/studio/capabilities').then(setCapabilities).catch(()=>{});},[load]);
  const importVideo=async(file:File)=>{
    if(busy)return;setBusy(true);setImportError('');
    let importingProject:ProjectSummary|null=null;
    const fileKey=`${file.name}:${file.size}:${file.lastModified}`;
    try{
      if(capabilities&&file.size>capabilities.limits.maxUploadBytes)throw new Error(`视频超过 ${fmtSize(capabilities.limits.maxUploadBytes)} 的上传限制。`);
      const project=(pendingFile.current===fileKey?pendingProject:null)||(await request<{project:ProjectSummary}>('/api/studio/projects',{name:(file.name.replace(/\.[^.]+$/,'').trim()||'未命名视频').slice(0,80),sceneMode:'proxy'},'POST')).project;
      importingProject=project;pendingFile.current=fileKey;setPendingProject(project);setUploadProgress(0);
      await new Promise<void>((resolve,reject)=>{
        const xhr=new XMLHttpRequest();
        xhr.open('POST',`/api/studio/projects/${project.id}/media?${new URLSearchParams({name:file.name,baseRevision:project.revision})}`);
        xhr.upload.onprogress=event=>{if(event.lengthComputable)setUploadProgress(event.loaded/event.total);};
        xhr.onerror=()=>reject(new Error('上传失败，请重新选择文件，或打开项目继续。'));
        xhr.onload=()=>{if(xhr.status===200)resolve();else{let message=`上传失败（${xhr.status}）`;try{message=JSON.parse(xhr.responseText).error||message;}catch{}reject(new Error(message));}};
        xhr.send(file);
      });
      onOpen(project.id);
    }catch(error){
      if(importingProject){try{const latest=await request<ProjectDetail>(`/api/studio/projects/${importingProject.id}`);if(latest.media){onOpen(importingProject.id);return;}setPendingProject({...importingProject,revision:latest.project.revision});}catch{pendingFile.current='';}}
      setImportError((error as Error).message);show((error as Error).message);load();
    }
    finally{setBusy(false);setUploadProgress(null);if(input.current)input.current.value='';}
  };
  return <div className="studio studio-home">
    <header className="topbar"><div className="identity"><span className="workspace-brand"><StudioIcon name="film"/></span><strong>MotionStage</strong></div><details className="workspace-menu"><summary className="icon-action" aria-label="项目菜单"><StudioIcon name="more"/></summary><div className="workspace-menu-content"><button onClick={event=>{const container=event.currentTarget.closest('details');container?.removeAttribute('open');container?.querySelector('summary')?.focus();onModelSettings();}}>模型设置</button></div></details></header>
    <main className="studio-main home-main">
      {capabilities&&!capabilities.ffmpeg&&<div className="studio-banner studio-banner-error" role="alert"><b>缺少 FFmpeg</b><p>本机未检测到 ffmpeg/ffprobe。导入、预览和切镜分析都需要 FFmpeg；请安装后将其加入 PATH，或设置 FFMPEG/FFPROBE 环境变量。</p></div>}
      <section className="home-projects" aria-labelledby="home-projects-title">
        <div className="home-heading"><div><h1 id="home-projects-title">项目</h1><p>导入素材，查看拉片结果并逐步修正。</p></div><div className="home-import">
          <input ref={input} type="file" accept=".mp4,.mov,video/mp4,video/quicktime" hidden aria-label="导入视频文件" disabled={busy} onChange={event=>{const file=event.target.files?.[0];if(file)void importVideo(file);}}/>
          <button className="primary" disabled={busy||capabilities?.ffmpeg===false} onClick={()=>input.current?.click()}><StudioIcon name="upload"/>{busy?uploadProgress===null?'准备项目…':uploadProgress>=1?'正在准备素材…':`导入中 ${Math.round(uploadProgress*100)}%`:'导入素材'}</button>
        </div></div>
        <div className="home-library-meta"><span>{projects?`${projects.length} 个项目`:'正在读取项目…'}</span><span>{capabilities?`MP4 / MOV · 最长 ${capabilities.limits.maxDurationS} 秒 · ${capabilities.limits.maxHeightPx}p`:'正在读取导入限制…'}</span></div>
        {listError&&<div className="workspace-notice is-error" role="alert"><span>{listError}</span><button onClick={load}>重新读取项目</button></div>}
        {importError&&<div className="workspace-notice is-error" role="alert"><span>{importError}</span><button disabled={busy} onClick={()=>input.current?.click()}>重新选择视频</button></div>}
        {pendingProject&&!busy&&<div className="workspace-notice"><span>上次导入尚未完成，可以回到项目继续。</span><button onClick={()=>onOpen(pendingProject.id)}>打开项目继续</button></div>}
        {projects&&projects.length===0&&<div className="home-empty"><StudioIcon name="film"/><h2>从一段影片开始</h2><p className="muted">导入后，镜头、人物与还原结果会保存在这里。</p></div>}
        <div className="home-project-list">{projects?.map(project=><button key={project.id} className="home-project-row" disabled={busy} onClick={()=>onOpen(project.id)}>
          <span className="home-project-cover" aria-hidden="true"><StudioIcon name="film"/></span><span className="home-project-info"><b title={project.name}>{project.name}</b><small>{project.shotCount||0} 镜 · {project.personCount||0} 个人物{project.animalCount?` · ${project.animalCount} 个动物候选`:''}</small></span>
          <span className={`studio-phase phase-${project.phase}`}>{PHASE_LABELS[project.phase]||project.phase}</span><time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString('zh-CN')}</time><span aria-hidden="true">↗</span>
        </button>)}</div>
        {capabilities&&!capabilities.detectorAvailable&&<details className="home-environment"><summary>人物检测尚未就绪</summary><p className="muted">本机人物检测模型未加载，拉片结果仍可浏览。人物检测需加载 YOLOv8n-pose 模型；模型许可与安装方式见项目说明。</p></details>}
      </section>
    </main>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提示" onClick={()=>show('')}>×</button></div>}
  </div>;
}

// ---- 项目工作台 ----
function JobsStrip({detail,onChanged,show}:{detail:ProjectDetail;onChanged:()=>void;show:(message:string)=>void}){
  const[busy,setBusy]=useState('');
  const activeJobs=detail.jobs.filter(job=>job.state==='queued'||job.state==='running');
  const recentJobs=detail.jobs.filter(job=>job.state!=='queued'&&job.state!=='running');
  useEffect(()=>{if(activeJobs.length===0)return;const timer=window.setInterval(onChanged,1500);return()=>window.clearInterval(timer);},[activeJobs.length,onChanged]);
  const act=async(job:JobInfo,action:'cancel'|'retry')=>{if(busy)return;setBusy(job.id);try{await request(`/api/studio/jobs/${job.id}/${action}`,{baseRevision:detail.project.revision},'POST');onChanged();}catch(e){show((e as Error).message);}finally{setBusy('');}};
  return <section className="workspace-jobs" id="studio-jobs" aria-label="处理记录">
    <div className="workspace-job-detail">
    {detail.jobs.length===0&&<p className="muted">导入后依次执行：素材预览 → 源帧时间戳 → 候选切镜 → 关键帧 → 逐镜语义 → 全片报告。</p>}
    {[...activeJobs,...recentJobs].map(job=>(
      <div key={job.id} className={`studio-job job-${job.state}`}>
        <div className="studio-job-head"><b>{KIND_LABELS[job.kind]||job.kind}</b><span>{job.state==='done'?'已完成':job.state==='failed'?'失败':job.state==='cancelled'?'已取消':job.state==='running'?`进行中 ${Math.round(job.progress*100)}%`:'排队中'}</span></div>
        {job.state==='running'&&<div className="studio-progress"><div style={{width:`${Math.max(3,job.progress*100)}%`}}/></div>}
        {job.output&&<small>{job.output}</small>}
        {job.error&&<small className="studio-job-error">{job.error}</small>}
        {(job.state==='failed'||job.state==='cancelled')&&<div className="studio-job-actions"><button disabled={!!busy} onClick={()=>void act(job,'retry')}>{busy===job.id?'提交中…':'重试'}</button></div>}
        {job.state==='running'&&<div className="studio-job-actions"><button disabled={!!busy} onClick={()=>void act(job,'cancel')}>取消</button></div>}
      </div>))}
    </div>
  </section>;
}

function ImportSection({detail,show,onChanged}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void}){
  const inputRef=useRef<HTMLInputElement>(null);
  const[progress,setProgress]=useState<number|null>(null);
  const[error,setError]=useState('');
  const uploading=useRef(false);
  const media=detail.media;
  const upload=()=>{
    const file=inputRef.current?.files?.[0];
    if(!file||uploading.current)return;
    uploading.current=true;setError('');
    const xhr=new XMLHttpRequest();
    const query=new URLSearchParams({name:file.name,baseRevision:detail.project.revision});
    xhr.open('POST',`/api/studio/projects/${detail.project.id}/media?${query}`);
    xhr.upload.onprogress=event=>{if(event.lengthComputable)setProgress(event.loaded/event.total);};
    xhr.onload=()=>{uploading.current=false;setProgress(null);if(inputRef.current)inputRef.current.value='';if(xhr.status===200){show('导入成功，已开始自动拉片。镜头表和待修正项会陆续显示。');onChanged();}else{let message=`上传失败（${xhr.status}）`;try{message=JSON.parse(xhr.responseText).error||message;}catch{}setError(message);show(message);}};
    xhr.onerror=()=>{uploading.current=false;setProgress(null);if(inputRef.current)inputRef.current.value='';setError('视频未上传成功，请重新选择文件重试。');show('上传网络错误');};
    setProgress(0);
    xhr.send(file);
  };
  if(!media)return <section className="studio-card">
    <div className="panel-title"><h2>导入媒体</h2><span>MP4/MOV · H.264/H.265</span></div>
    <p className="muted">选择视频后自动整理镜头，结果会陆续显示。原片保持完整，支持可变帧率素材。</p>
    {error&&<div className="workspace-notice is-error" role="alert"><span>{error}</span><button onClick={()=>inputRef.current?.click()}>重新选择视频</button></div>}
    <div className="studio-upload-row">
      <input ref={inputRef} type="file" accept=".mp4,.mov,video/mp4,video/quicktime" aria-label="选择视频文件" onChange={upload} disabled={progress!==null}/>
    </div>
    {progress!==null&&<><p className="muted" role="status">{progress>=1?'上传完成，正在准备素材…':`正在上传 · ${Math.round(progress*100)}%`}</p><div className="studio-progress"><div style={{width:`${Math.max(3,progress*100)}%`}}/></div></>}
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

function TracksSection({detail,show,onChanged,selectedShotId,onDraftCountChange}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;onDraftCountChange?:(count:number)=>void}){
  type TrackForm={startFrame:string;endFrame:string;x:string;y:string;w:string;h:string};
  const emptyForm:TrackForm={startFrame:'',endFrame:'',x:'0.3',y:'0.2',w:'0.25',h:'0.5'};
  const[adding,setAdding]=useState(false);
  const[forms,setForms]=useState<Record<string,TrackForm>>({});
  const[error,setError]=useState('');
  const[busy,setBusy]=useState(false);
  const pending=useRef(false);
  const shot=detail.shots.find(item=>item.id===selectedShotId)||detail.shots[0];
  const currentShot=useRef(shot?.id);currentShot.current=shot?.id;
  const form=shot?forms[shot.id]||emptyForm:emptyForm;
  const hasDraft=JSON.stringify(form)!==JSON.stringify(emptyForm);
  const draftCount=Object.values(forms).filter(value=>JSON.stringify(value)!==JSON.stringify(emptyForm)).length;
  useEffect(()=>{onDraftCountChange?.(draftCount);},[draftCount,onDraftCountChange]);
  const edit=(patch:Partial<TrackForm>)=>{if(shot)setForms(current=>({...current,[shot.id]:{...(current[shot.id]||emptyForm),...patch}}));};
  const clearForm=(shotId:string)=>setForms(current=>{const next={...current};delete next[shotId];return next;});
  const act=async(operation:()=>Promise<unknown>,after?:()=>void)=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try{await operation();after?.();await onChanged();}catch(cause){const message=(cause as Error).message;setError(message);show(message);}finally{pending.current=false;setBusy(false);}};
  const bindingByTrack=new Map(detail.bindings.map(binding=>[binding.trackId,binding]));
  const characterById=new Map(detail.characters.map(character=>[character.id,character]));
  const tracks=detail.tracks.filter(track=>track.status==='active'&&(!shot||track.shotId===shot.id));
  const changeCharacter=async(track:TrackInfo,value:string)=>{
    const assignment=value==='unassigned'?{trackId:track.id,disposition:'unassigned'}:value==='ignored'?{trackId:track.id,disposition:'ignored'}:{trackId:track.id,characterId:value,disposition:'bound'};
    await act(()=>request(`/api/studio/projects/${detail.project.id}/cast`,{baseRevision:detail.project.revision,assignments:[assignment]},'PATCH'));
  };
  const mutate=async(action:string,payload:Record<string,unknown>)=>act(()=>request(`/api/studio/projects/${detail.project.id}/tracks/${String(payload.trackId)}/${action}`,{...payload,baseRevision:detail.project.revision},'POST'));
  const addTrack=async()=>{if(!shot)return;const targetId=shot.id;const payload={shotId:targetId,startFrame:form.startFrame.trim()?Number(form.startFrame):shot.startFrame,endFrame:form.endFrame.trim()?Number(form.endFrame):shot.endFrameExclusive-1,box:{x:Number(form.x),y:Number(form.y),w:Number(form.w),h:Number(form.h)}};
    await act(()=>request(`/api/studio/projects/${detail.project.id}/shots/${targetId}/tracks`,{...payload,baseRevision:detail.project.revision},'POST'),()=>{clearForm(targetId);if(currentShot.current===targetId)setAdding(false);show('已补标出场候选。');});};
  if(detail.shots.length===0)return null;
  return <section className="studio-card">
    <div className="panel-title"><h2>逐镜出场修正</h2><span>{detail.tracks.filter(track=>track.status==='active').length} 条有效 · {detail.pendingTrackIds.length} 条待处理</span></div>
    {error&&<div className="workspace-notice is-error" role="alert">{error}</div>}
    {hasDraft&&<p className="workspace-draft-notice" role="status">本镜补标尚未保存 · 收起或切换镜头会保留输入 <button disabled={busy} onClick={()=>{if(shot)clearForm(shot.id);}}>撤回本镜补标草稿</button></p>}
    <div className="studio-toolbar">
      <span className="muted">第 {(shot?.idx??0)+1} 镜 · {seconds(shot?.startUs||0)}—{seconds(shot?.endUs||0)}</span>
      <button onClick={()=>setAdding(value=>!value)}>{adding?'收起补标':'补标出场'}</button>
      <span className="muted">跨切镜不自动连接轨迹；误检删除、拆分、连接均保留版本记录。</span>
    </div>
    {adding&&shot&&<div className="studio-add-track">
      <label>起始帧<input type="number" disabled={busy} value={form.startFrame} placeholder={String(shot.startFrame)} onChange={event=>edit({startFrame:event.target.value})}/></label>
      <label>结束帧<input type="number" disabled={busy} value={form.endFrame} placeholder={String(shot.endFrameExclusive-1)} onChange={event=>edit({endFrame:event.target.value})}/></label>
      <label>框 X<input type="number" disabled={busy} step="0.05" value={form.x} onChange={event=>edit({x:event.target.value})}/></label>
      <label>框 Y<input type="number" disabled={busy} step="0.05" value={form.y} onChange={event=>edit({y:event.target.value})}/></label>
      <label>宽<input type="number" disabled={busy} step="0.05" value={form.w} onChange={event=>edit({w:event.target.value})}/></label>
      <label>高<input type="number" disabled={busy} step="0.05" value={form.h} onChange={event=>edit({h:event.target.value})}/></label>
      <button className="primary" disabled={busy} onClick={addTrack}>{busy?'提交中…':'添加候选'}</button>
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
              :<select disabled={busy} aria-label={`为 ${track.id} 指定角色`} value={value} onChange={event=>changeCharacter(track,event.target.value)}>
              <option value="unassigned">未分配（阻止确认）</option>
              <option value="ignored">忽略（路人/误检）</option>
              {detail.characters.map(character=><option key={character.id} value={character.id}>归并 → {character.name}</option>)}
            </select>}
            <div className="studio-track-actions">
              <button disabled={busy} onClick={()=>{const input=window.prompt('拆分帧号：',String(Math.floor((track.startFrame+track.endFrame)/2)));if(input)mutate('split',{trackId:track.id,splitFrame:Number(input)});}}>拆分</button>
              {tracks.filter(other=>other.id!==track.id&&other.startFrame>=track.endFrame).slice(0,1).map(other=><button disabled={busy} key={other.id} onClick={()=>mutate('merge',{trackId:track.id,otherTrackId:other.id})}>连接下一段</button>)}
              <button disabled={busy} className="danger" onClick={()=>{if(window.confirm('确认删除该候选（误检）？'))mutate('delete',{trackId:track.id});}}>删除误检</button>
            </div>
            {binding&&binding.disposition==='bound'&&characterById.get(binding.characterId||'')&&<small>已归并 → {characterById.get(binding.characterId||'')!.name}</small>}
            {binding&&binding.disposition==='ignored'&&<small>已忽略</small>}
          </div>
        </div>;})}
      {shot&&tracks.length===0&&<p className="muted">{shot.id} 暂无出场候选。空镜属正常；如有人物请“补标出场”。</p>}
    </div>
  </section>;
}

function CastingSection({detail,show,onChanged,onDraftCountChange}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;onDraftCountChange?:(count:number)=>void}){
  const[name,setName]=useState('');
  const[color,setColor]=useState('#28543F');
  const[scale,setScale]=useState('1.75');
  const[allowSimultaneous,setAllowSimultaneous]=useState(false);
  const[heightDrafts,setHeightDrafts]=useState<Record<string,string>>({});
  const[error,setError]=useState('');
  const[busy,setBusy]=useState(false);
  const pending=useRef(false);
  const createDirty=!!name||color!=='#28543F'||scale!=='1.75'||allowSimultaneous;
  const heightDirty=Object.entries(heightDrafts).filter(([id,value])=>value!==String(detail.characters.find(character=>character.id===id)?.scale));
  const draftCount=(createDirty?1:0)+heightDirty.length;
  useEffect(()=>{onDraftCountChange?.(draftCount);},[draftCount,onDraftCountChange]);
  const clearHeight=(id:string)=>setHeightDrafts(current=>{const next={...current};delete next[id];return next;});
  const clearCreate=()=>{setName('');setColor('#28543F');setScale('1.75');setAllowSimultaneous(false);};
  const act=async(operation:()=>Promise<unknown>,after?:()=>void)=>{if(pending.current)return false;pending.current=true;setBusy(true);setError('');try{await operation();after?.();await onChanged();return true;}catch(cause){const message=(cause as Error).message;setError(message);show(message);return false;}finally{pending.current=false;setBusy(false);}};
  const activeTracks=detail.tracks.filter(track=>track.status==='active');
  const approval=detail.approval;
  const createCharacter=async()=>act(()=>request(`/api/studio/projects/${detail.project.id}/characters`,{name,color,scale:Number(scale),allowSimultaneous,baseRevision:detail.project.revision},'POST'),()=>{clearCreate();show('角色资产已创建。');});
  const updateCharacter=async(character:CharacterInfo,fields:Record<string,unknown>)=>act(()=>request(`/api/studio/projects/${detail.project.id}/characters/${character.id}`,{...fields,baseRevision:detail.project.revision},'PATCH'),()=>{if('scale' in fields)clearHeight(character.id);});
  const toggleSimultaneous=async(character:CharacterInfo)=>updateCharacter(character,{allowSimultaneous:!character.allowSimultaneous});
  const approve=async()=>act(()=>request(`/api/studio/projects/${detail.project.id}/approve-cast`,{baseRevision:detail.project.revision},'POST'),()=>show('角色映射已正式确认，输入与算法版本已冻结。'));
  const canApprove=detail.invalidTrackIds.length===0&&detail.pendingTrackIds.length===0&&detail.conflicts.length===0&&activeTracks.length>0;
  const characterName=(id:string)=>detail.characters.find(character=>character.id===id)?.name||id;
  return <section className="studio-card" id="studio-cast">
    <div className="panel-title"><h2>角色外观与身高</h2><span>{detail.characters.length} 个代理角色组</span></div>
    {error&&<div className="workspace-notice is-error" role="alert">{error}</div>}
    {createDirty&&<p className="workspace-draft-notice" role="status">新角色尚未保存 · 收起面板会保留输入 <button disabled={busy} onClick={clearCreate}>撤回新角色草稿</button></p>}
    <div className="studio-cast-grid">
      <div className="studio-characters">
        <h3>代理角色组</h3>
        {detail.characters.map(character=>(
          <div key={character.id} className="studio-character-row">
            <span className="studio-character-swatch" style={{background:character.color}}/>
            <div><b>{character.name}{character.provisional&&<span className="studio-provisional">暂定</span>}</b><small>身高 {character.scale.toFixed(2)} m · 版本 {character.revision.slice(0,8)}</small></div>
            <label>身高 m<input disabled={busy} aria-label={`${character.name} 身高`} type="number" min="0.2" max="3" step="0.05" value={heightDrafts[character.id]??String(character.scale)} onChange={event=>setHeightDrafts(current=>({...current,[character.id]:event.target.value}))} onBlur={event=>{const value=Number(event.currentTarget.value);if(!Number.isFinite(value)||value<0.2||value>3){setError('身高请输入 0.2–3 米；当前输入已保留。');show('身高请输入 0.2–3 米。');return;}if(value!==character.scale)void updateCharacter(character,{scale:value});else clearHeight(character.id);}} onKeyDown={event=>{if(event.key==='Enter')event.currentTarget.blur();}}/>{heightDirty.some(([id])=>id===character.id)&&<button disabled={busy} onMouseDown={event=>event.preventDefault()} onClick={()=>clearHeight(character.id)}>撤回身高草稿</button>}</label>
            <select disabled={busy} aria-label={`${character.name} 代理级别`} value={character.proxyLevel||'CL1'} onChange={event=>updateCharacter(character,{proxyLevel:event.target.value})}>
              {['CL0','CL1','CL2'].map(level=><option key={level} value={level}>{level}</option>)}
            </select>
            <label className="studio-tiny-toggle"><input disabled={busy} type="checkbox" checked={character.allowSimultaneous} onChange={()=>toggleSimultaneous(character)}/>允许同框（分身/镜像）</label>
          </div>))}
        {detail.characters.length===0&&<p className="muted">还没有成片角色。角色不等于原片演员：不同演员可归并为同一角色，同一演员也可拆成多个角色。</p>}
        <div className="studio-character-create">
          <input disabled={busy} aria-label="角色名称" placeholder="角色名称" value={name} maxLength={40} onChange={event=>setName(event.target.value)}/>
          <label>颜色<input disabled={busy} type="color" value={color} onChange={event=>setColor(event.target.value)} aria-label="角色颜色"/></label>
          <label>身高 m<input disabled={busy} type="number" step="0.05" min="0.2" max="3" value={scale} onChange={event=>setScale(event.target.value)} aria-label="角色身高"/></label>
          <label className="studio-tiny-toggle"><input disabled={busy} type="checkbox" checked={allowSimultaneous} onChange={event=>setAllowSimultaneous(event.target.checked)}/>允许同框（分身/镜像）</label>
          <button className="primary" disabled={busy||!name.trim()} onClick={createCharacter}>{busy?'提交中…':'创建代理角色组'}</button>
        </div>
      </div>
      <details className="studio-approval"><summary>保存已核对版本（可选）</summary>
        <p className="muted">仅用于记录已核对版本，不影响查看初稿或导出。</p>{detail.invalidTrackIds.length>0&&<p role="alert" className="studio-job-error">有 {detail.invalidTrackIds.length} 段出场越过当前镜头边界，请在逐镜出场修正中处理。</p>}
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
        <button className="primary studio-approve" disabled={busy||!canApprove||approval?.status==='approved'} onClick={approve}>{approval?.status==='approved'?'已正式确认':'正式确认角色映射'}</button>
        <p className="muted">确认会冻结媒体哈希、切镜、候选与归并版本；此后任何上游修改都会使确认自动失效并回退到“素材已分析”。</p>
      </details>
    </div>
  </section>;
}

function CameraSection({detail,show,onChanged,selectedShotId,onDraftCountChange}:{detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;onDraftCountChange?:(count:number)=>void}){
  type CameraDraft={pointsText:string;personTrackId:string};
  const[drafts,setDrafts]=useState<Record<string,CameraDraft>>({});
  const[errors,setErrors]=useState<Record<string,string>>({});
  const[busy,setBusy]=useState(false);
  const pending=useRef(false);
  const shot=detail.shots.find(item=>item.id===selectedShotId)||detail.shots[0];
  const draft=shot?drafts[shot.id]||{pointsText:'',personTrackId:''}:{pointsText:'',personTrackId:''};
  const{pointsText,personTrackId}=draft;
  const hasDraft=!!pointsText||!!personTrackId;
  const draftCount=Object.values(drafts).filter(value=>value.pointsText||value.personTrackId).length;
  useEffect(()=>{onDraftCountChange?.(draftCount);},[draftCount,onDraftCountChange]);
  const edit=(patch:Partial<CameraDraft>)=>{if(shot)setDrafts(current=>({...current,[shot.id]:{...(current[shot.id]||{pointsText:'',personTrackId:''}),...patch}}));};
  const clear=(shotId:string,field?:keyof CameraDraft)=>setDrafts(current=>{const next={...current};if(field&&next[shotId]){next[shotId]={...next[shotId],[field]:''};if(!next[shotId].pointsText&&!next[shotId].personTrackId)delete next[shotId];}else delete next[shotId];return next;});
  const shotCameras=detail.cameraTracks.filter(camera=>!shot||camera.shotId===shot.id);
  const solve=async(mode:'landmarks'|'person')=>{
    if(!shot||pending.current)return;
    const targetId=shot.id;pending.current=true;setBusy(true);setErrors(current=>({...current,[targetId]:''}));
    try{
      const payload:any={mode,baseRevision:detail.project.revision};
      if(mode==='landmarks'){
        const points=JSON.parse(pointsText||'[]');
        if(!Array.isArray(points)||points.length<6)throw Object.assign(new Error('至少需要 6 个 {X:[x,y,z], x:[u,v]} 对应'),{status:400});
        payload.points=points;
      }else payload.trackId=personTrackId;
      const result=await request<{camera:CameraTrackInfo&{note?:string;distanceMeters?:number}}>(`/api/studio/projects/${detail.project.id}/shots/${targetId}/camera`,payload,'POST');
      clear(targetId,mode==='landmarks'?'pointsText':'personTrackId');
      show(result.camera.needsManualReview?`相机已保存（${result.camera.source}，待人工确认）：${result.camera.note||''}`:`相机已保存：中位重投影 ${result.camera.medianErrorPx}px（达标 ≤8px）`);
      await onChanged();
    }catch(cause){const message=(cause as Error).message;setErrors(current=>({...current,[targetId]:message}));show(message);}finally{pending.current=false;setBusy(false);}
  };
  const estimate=async()=>{if(!shot||pending.current)return;const targetId=shot.id;pending.current=true;setBusy(true);setErrors(current=>({...current,[targetId]:''}));try{await request(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'camera'},'POST');show('已发起人物尺度运镜估计（含推拉，结果为估计值）。');await onChanged();}catch(cause){const message=(cause as Error).message;setErrors(current=>({...current,[targetId]:message}));show(message);}finally{pending.current=false;setBusy(false);}};
  if(detail.shots.length===0)return null;
  return <section className="studio-card">
    <div className="panel-title"><h2>相机校准</h2><span>算法 {detail.algorithms.camera}</span></div>
    {shot&&errors[shot.id]&&<div className="workspace-notice is-error" role="alert">{errors[shot.id]}</div>}
    {hasDraft&&<p className="workspace-draft-notice" role="status">本镜相机修正尚未提交 · 收起或切换镜头会保留输入 <button disabled={busy} onClick={()=>{if(shot)clear(shot.id);}}>撤回本镜相机草稿</button></p>}
    <p className="muted">有 ≥6 个已知三维地标时用 PnP（A5：中位重投影 ≤8px 为高置信）；证据不足时只能得到粗略估计并标记待人工确认。相机与可见场景相互独立。</p>
    <div className="studio-toolbar">
      <span className="muted">第 {(shot?.idx??0)+1} 镜 · 修改作用于当前镜头</span>
      <select disabled={busy} aria-label="人物框估计所用的出场" value={personTrackId} onChange={event=>edit({personTrackId:event.target.value})}>
        <option value="">（选择出场候选用于粗估）</option>
        {detail.tracks.filter(track=>track.status==='active'&&(!shot||track.shotId===shot.id)).map(track=><option key={track.id} value={track.id}>{track.id}（帧 {track.startFrame}–{track.endFrame}）</option>)}
      </select>
      <button disabled={busy||!shot||!personTrackId} onClick={()=>solve('person')}>人物框粗估</button>
      <button disabled={busy||!shot} onClick={()=>solve('landmarks')}>{busy?'提交中…':'地标 PnP 求解'}</button>
      <button disabled={busy||!shot} onClick={()=>void estimate()}>估计运镜（人物尺度）</button>
    </div>
    <label className="studio-landmark-editor">地标对应（JSON：X 为米制三维，x 为画面像素）
      <textarea disabled={busy} rows={3} value={pointsText} placeholder='[{"X":[0,0,0],"x":[320,180]},{"X":[2,0,0],"x":[960,180]},{"X":[0,1.5,0],"x":[320,540]},{"X":[2,1.5,0],"x":[960,540]},{"X":[1,0,1],"x":[500,300]},{"X":[1,1.5,1],"x":[700,520]}]' onChange={event=>edit({pointsText:event.target.value})}/>
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
    <div className="panel-title"><h2>导出三维资产与数据</h2><span>{motionCount} 条动作 · {exportsList?`${exportsList.length} 个交付包`:'…'}</span></div>
    <p className="muted">连续动作为固定骨长的可审查近似还原（单目深度歧义无法消除；接触确认需人工逐镜复核）。交付包含镜头表、归并清单、相机与逐实例动作，以及每组共享的 GLB 代理资产（含各段出场动画）；预览视频渲染与可见场景资产不在本首版范围内。</p>
    <div className="studio-toolbar">
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
  type Workspace='analysis'|'people'|'reconstruction';
  type Tool='tasks'|'exports'|'source'|'tracks'|'roles'|'camera';
  const[detail,setDetail]=useState<ProjectDetail|null>(null);
  const[selectedShotId,setSelectedShotId]=useState('');
  const[settings,setSettings]=useState(false);
  const[tool,setTool]=useState<Tool|null>(null);
  const[discardDialog,setDiscardDialog]=useState(false);
  const[analysisInfo,setAnalysisInfo]=useState<AnalysisWorkspaceInfo|null>(null);
  const[peopleDrafts,setPeopleDrafts]=useState(0);
  const[trackDrafts,setTrackDrafts]=useState(0);
  const[castingDrafts,setCastingDrafts]=useState(0);
  const[cameraDrafts,setCameraDrafts]=useState(0);
  const[settingsDrafts,setSettingsDrafts]=useState(0);
  const[loadError,setLoadError]=useState('');
  const menu=useRef<HTMLDetailsElement>(null);
  const[workspace,setWorkspace]=useState<Workspace>(()=>{const view=new URLSearchParams(location.search).get('view');return view==='people'||view==='reconstruction'?view:'analysis';});
  const[playbackPosition,setPlaybackPosition]=useState<{timeUs:number;requestId:number}>({timeUs:0,requestId:0});
  const position=useRef<{timeUs:number;shotId?:string}>({timeUs:0});
  const activeWorkspace=useRef(workspace);activeWorkspace.current=workspace;
  const initializedPosition=useRef(false);
  const[reconstructionVisited,setReconstructionVisited]=useState(workspace==='reconstruction');
  const[updating,setUpdating]=useState(false);
  const[reconstructionError,setReconstructionError]=useState('');
  const{toast,show}=useToast();
  const toolDrafts=trackDrafts+castingDrafts+cameraDrafts;
  const draftCount=(analysisInfo?.draftCount||0)+peopleDrafts+toolDrafts+settingsDrafts;
  const load=useCallback(()=>request<ProjectDetail>(`/api/studio/projects/${projectId}`).then(next=>{
    setDetail(next);setLoadError('');setSelectedShotId(current=>next.shots.some(shot=>shot.id===current)?current:next.shots[0]?.id||'');
    if(!initializedPosition.current&&next.shots.length){initializedPosition.current=true;position.current={timeUs:next.shots[0].startUs,shotId:next.shots[0].id};setPlaybackPosition(value=>({timeUs:next.shots[0].startUs,requestId:value.requestId+1}));}
  }).catch(e=>{setLoadError(e.message);show(e.message);}),[projectId,show]);
  useEffect(()=>{void load();},[load,modelSettingsRevision]);
  useEffect(()=>{if(!draftCount)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[draftCount]);
  const receiveAnalysisInfo=useCallback((info:AnalysisWorkspaceInfo)=>setAnalysisInfo(info),[]);
  const reportPosition=useCallback((source:Workspace,next:{timeUs:number;shotId?:string})=>{if(source!==activeWorkspace.current)return;position.current=next;if(next.shotId)setSelectedShotId(current=>current===next.shotId?current:next.shotId!);},[]);
  const analysisPosition=useCallback((next:{timeUs:number;shotId?:string})=>reportPosition('analysis',next),[reportPosition]);
  const reconstructionPosition=useCallback((next:{timeUs:number;shotId?:string})=>reportPosition('reconstruction',next),[reportPosition]);
  const navigate=(view:Workspace,shotId?:string,timeUs?:number)=>{
    const nextTime=timeUs??(shotId?detail?.shots.find(shot=>shot.id===shotId)?.startUs:undefined)??position.current.timeUs;
    position.current={timeUs:nextTime,shotId:shotId||position.current.shotId};if(shotId)setSelectedShotId(shotId);
    setPlaybackPosition(value=>({timeUs:nextTime,requestId:value.requestId+1}));activeWorkspace.current=view;setWorkspace(view);if(view==='reconstruction')setReconstructionVisited(true);
    if(view!==workspace){setTool(null);menu.current?.removeAttribute('open');window.scrollTo({top:0,behavior:'instant'});}
    const url=new URL(location.href);url.searchParams.set('view',view);history.replaceState(null,'',url);
  };
  const closeMenu=()=>{const container=menu.current;if(!container?.open)return;const restore=container.contains(document.activeElement);container.removeAttribute('open');if(restore)container.querySelector('summary')?.focus();};
  const openTool=(next:Tool)=>{closeMenu();setTool(next);};
  const back=()=>{if(draftCount)setDiscardDialog(true);else onBack();};
  const updateReconstruction=async()=>{if(updating)return;setUpdating(true);setReconstructionError('');try{await request(`/api/studio/projects/${projectId}/reconstruction`,{},'POST');show('正在更新人物动作与相机，完成后预览会自动刷新。');await load();}catch(error){setReconstructionError((error as Error).message);show((error as Error).message);}finally{setUpdating(false);}};
  if(!detail)return <div className="studio"><header className="topbar"><div className="identity"><span className="workspace-brand"><StudioIcon name="film"/></span><strong>MotionStage</strong></div><button onClick={onBack}>返回项目</button></header><main className="studio-main"><p className="muted" role={loadError?'alert':'status'}>{loadError||'正在读取项目…'}</p>{loadError&&<button onClick={()=>void load()}>重新读取</button>}</main></div>;
  const tabs:[Workspace,string][]=[['analysis','拉片'],['people','人物'],['reconstruction','三维还原']];
  const activeJobs=detail.jobs.filter(job=>['queued','running'].includes(job.state));
  const running=activeJobs.length>0;
  const latestJobs=detail.jobs.filter((job,index,all)=>all.findIndex(item=>item.kind===job.kind)===index);
  const failedJobs=latestJobs.filter(job=>job.state==='failed');
  const statusLabel=running?`${KIND_LABELS[activeJobs[0].kind]||'正在处理'} · ${activeJobs[0].state==='running'?`${Math.round(activeJobs[0].progress*100)}%`:'排队中'}`:failedJobs.length?`${failedJobs.length} 项处理未完成`:analysisInfo?`${analysisInfo.analyzed}/${analysisInfo.total} 镜 · ${analysisInfo.status}`:'处理记录';
  const issues=detail.draft?.issues||[];
  const issueShots=new Set(issues.map(issue=>issue.shotId).filter(Boolean));
  const toolTitles:Record<Tool,string>={tasks:'处理记录',exports:'三维交付包',source:'素材与修改历史',tracks:'修正本镜出场',roles:'修正角色与相机',camera:'本镜相机校准'};
  const openModels=()=>{closeMenu();onModelSettings();};
  return <div className="studio studio-workspaces">
    <header className="topbar workspace-topbar">
      <div className="identity"><button className="icon-action workspace-back" aria-label="返回项目列表" onClick={back}><StudioIcon name="back"/></button><span className="workspace-brand"><StudioIcon name="film"/></span><strong title={detail.project.name}>{detail.project.name}</strong></div>
      <nav className="workspace-nav" role="tablist" aria-label="工作区">{tabs.map(([view,label],index)=><button key={view} id={`tab-${view}`} role="tab" aria-selected={workspace===view} aria-controls={`workspace-${view}`} tabIndex={workspace===view?0:-1} onClick={()=>navigate(view)} onKeyDown={event=>{const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;if(next>=0){event.preventDefault();navigate(tabs[next][0]);document.getElementById(`tab-${tabs[next][0]}`)?.focus();}}}>{label}</button>)}</nav>
      <div className="workspace-header-actions"><button className={`workspace-status${failedJobs.length?' has-error':''}`} aria-label={`处理状态：${statusLabel}，查看处理记录`} onClick={()=>openTool('tasks')}><span className={running?'status-dot is-running':'status-dot'}/><span>{statusLabel}</span></button>
        <details ref={menu} className="workspace-menu" onKeyDown={event=>{if(event.key==='Escape'){menu.current?.removeAttribute('open');menu.current?.querySelector('summary')?.focus();}}}><summary className="icon-action" aria-label="项目菜单"><StudioIcon name="more"/></summary><div className="workspace-menu-content">
          <button onClick={openModels}>模型设置</button><button onClick={()=>{closeMenu();setSettings(true);}}>项目设置{settingsDrafts?' · 未保存':''}</button><div className="workspace-menu-separator"/>
          {analysisInfo?.reportUrl?<a href={analysisInfo.reportUrl} target="_blank" rel="noreferrer" onClick={()=>menu.current?.removeAttribute('open')}>拉片报告{analysisInfo.candidate?'（候选）':''} ↗</a>:<button disabled>拉片报告 · 尚未生成</button>}
          {analysisInfo?.dataUrl&&<a href={analysisInfo.dataUrl} target="_blank" rel="noreferrer" onClick={()=>menu.current?.removeAttribute('open')}>分析数据 ↗</a>}
          <button onClick={()=>openTool('exports')}>三维交付包</button><button onClick={()=>openTool('source')}>素材与修改历史</button>
        </div></details>
      </div>
    </header>
    {settings&&<ProjectSettings detail={detail} onClose={()=>setSettings(false)} onChanged={load} onDeleted={onBack} show={show} onDraftCountChange={setSettingsDrafts}/>}
    <main className="studio-main workspace-main">
      {loadError&&<div className="workspace-notice is-error" role="alert"><span>项目更新未完成：{loadError}</span><button onClick={()=>void load()}>重新读取</button></div>}
      {(settingsDrafts+toolDrafts+(workspace==='reconstruction'?(analysisInfo?.draftCount||0)+peopleDrafts:workspace==='analysis'?peopleDrafts:analysisInfo?.draftCount||0))>0&&<div className="workspace-draft-notice" role="status">此项目仍有未保存修正 · 切换视图会保留草稿{settingsDrafts>0&&<button onClick={()=>setSettings(true)}>继续项目设置</button>}</div>}
      {!detail.media&&<ImportSection detail={detail} show={show} onChanged={load}/>}
      <section id="workspace-analysis" role="tabpanel" aria-labelledby="tab-analysis" hidden={workspace!=='analysis'}>
        <StudioShotAnalysis detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} selectShot={setSelectedShotId} onModelSettings={onModelSettings} active={workspace==='analysis'} playbackPosition={playbackPosition} onPositionChange={analysisPosition} onAnalysisInfo={receiveAnalysisInfo} externalDraftCount={peopleDrafts+toolDrafts}/>
      </section>
      <section id="workspace-people" role="tabpanel" aria-labelledby="tab-people" hidden={workspace!=='people'}>
        <PeopleSection detail={detail} show={show} onChanged={load} selectShot={id=>navigate('people',id)} selectedShotId={selectedShotId} active={workspace==='people'} onSeekAppearance={(shotId,timeUs)=>navigate('people',shotId,timeUs)} onOpenAppearance={(shotId,timeUs,view)=>navigate(view,shotId,timeUs)} onDraftCountChange={setPeopleDrafts} onOpenTrackTools={()=>openTool('tracks')}/>
      </section>
      <section id="workspace-reconstruction" role="tabpanel" aria-labelledby="tab-reconstruction" hidden={workspace!=='reconstruction'}>
        <section className="studio-card reconstruction-workspace" id="studio-playback">
          <div className="workspace-view-heading"><div><h2>三维还原</h2><span>原片与白模对照 · 动作、相机为近似估计</span></div><button className="primary" onClick={()=>void updateReconstruction()} disabled={updating||running||!detail.shots.length}>{updating||running?'正在处理…':'更新还原'}</button></div>
          {reconstructionError&&<div className="workspace-notice is-error" role="alert"><span>{reconstructionError}</span><button onClick={()=>navigate('people')}>查看人物与出场</button></div>}
          {detail.shots.length===0?<div className="workspace-empty"><p className="muted">镜头准备好后即可查看三维初稿。</p></div>:reconstructionVisited&&<Suspense fallback={<p className="muted" role="status">载入三维预览…</p>}><StudioPlayback detail={detail} active={workspace==='reconstruction'} playbackPosition={playbackPosition} onPositionChange={reconstructionPosition}/></Suspense>}
          <div className="workspace-object-summary"><span>{detail.characters.length} 个代理角色 · {Object.keys(detail.motionRefs).length} 条动作{issues.length?` · ${issueShots.size||issues.length} 项待核对`:''}</span><button onClick={()=>openTool('roles')}>修正角色与相机</button></div>
          {!!issues.length&&<details className="workspace-tool"><summary>还原中待核对的内容（{issues.length}）</summary><ul className="workspace-issues">{issues.map((issue,index)=><li key={`${issue.code}:${index}`}>{issue.shotId&&<button onClick={()=>navigate('reconstruction',issue.shotId,issue.startUs)}>{issue.shotId}</button>}<span>{issue.message}</span></li>)}</ul></details>}
        </section>
      </section>
    </main>
    <StudioDialog open={tool!==null} title={toolTitles[tool||'tasks']} onClose={()=>setTool(null)} className={tool==='roles'||tool==='camera'?'workspace-editor-dialog':''}>
      <div hidden={tool!=='tasks'}><JobsStrip detail={detail} onChanged={load} show={show}/>{analysisInfo?.retry&&<div className="workspace-task-next"><p className="muted">{analysisInfo.error||'更新拉片会补跑缺失内容，保留已保存的人工修正。'}</p><button disabled={analysisInfo.retryDisabled} onClick={()=>void analysisInfo.retry?.()}>更新 / 重试拉片</button></div>}</div>
      <div hidden={tool!=='exports'}><MotionExportSection detail={detail} show={show} onChanged={load}/></div>
      <div hidden={tool!=='source'}>{detail.media&&<ImportSection detail={detail} show={show} onChanged={load}/>}<details className="studio-history"><summary>修改历史（{detail.history.length}）</summary><ol>{detail.history.map((entry,index)=><li key={index}><b>{entry.revision}</b> · {new Date(entry.time).toLocaleString('zh-CN')} · {entry.reason}</li>)}</ol></details></div>
      <div hidden={tool!=='tracks'}><TracksSection detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} onDraftCountChange={setTrackDrafts}/></div>
      <div hidden={tool!=='roles'}><CastingSection detail={detail} show={show} onChanged={load} onDraftCountChange={setCastingDrafts}/><details className="workspace-tool"><summary>更多工具</summary><button onClick={()=>setTool('camera')}>校准当前镜头相机</button></details></div>
      <div hidden={tool!=='camera'}><p className="muted">用于当前选中镜头；修改镜头请先返回工作页。</p><CameraSection detail={detail} show={show} onChanged={load} selectedShotId={selectedShotId} onDraftCountChange={setCameraDrafts}/></div>
    </StudioDialog>
    <StudioDialog open={discardDialog} title="有未保存的修正" onClose={()=>setDiscardDialog(false)}><p>返回项目列表会丢弃 {draftCount} 项未保存修正。留在当前项目可以继续编辑。</p><div className="studio-toolbar"><button className="primary" onClick={()=>setDiscardDialog(false)}>继续编辑</button><button onClick={()=>{discardProjectSettingsDraft(projectId);onBack();}}>丢弃草稿并返回</button></div></StudioDialog>
    {toast&&<div className="toast" role="status"><span>{toast}</span><button aria-label="关闭提示" onClick={()=>show('')}><StudioIcon name="close"/></button></div>}
  </div>;
}

export function Studio(){
  const[projectId,setProjectId]= useState<string|null>(new URLSearchParams(location.search).get('project'));
  const[modelsOpen,setModelsOpen]=useState(new URLSearchParams(location.search).get('settings')==='models');
  const[modelSettingsRevision,setModelSettingsRevision]=useState(0);
  const openModels=()=>{setModelsOpen(true);const url=new URL(location.href);url.searchParams.set('settings','models');history.replaceState(null,'',url);};
  const closeModels=()=>{setModelsOpen(false);const url=new URL(location.href);url.searchParams.delete('settings');history.replaceState(null,'',url);};
  return <>{projectId?<ProjectWorkspace key={projectId} projectId={projectId} onBack={()=>{setProjectId(null);history.replaceState(null,'','/');}} onModelSettings={openModels} modelSettingsRevision={modelSettingsRevision}/>:<ProjectList onOpen={id=>{setProjectId(id);history.replaceState(null,'',`/?project=${id}`);}} onModelSettings={openModels}/>} {modelsOpen&&<StudioModelSettings onClose={closeModels} onChanged={()=>setModelSettingsRevision(value=>value+1)}/>}</>;
}
export default Studio;
