import {useCallback,useEffect,useRef,useState} from 'react';
import type {ProjectDetail} from './studio';
import {StudioShotStrip} from './StudioShotStrip';
import {playbackTimeOrigin,sourceUsToVideoTime,videoTimeToSourceUs} from './studio-playback-clock';
import {analysisFieldLabel,analysisIssues,analysisShotAt,editedCutFrames,isSessionVisualAnalysis,sourceFrameAt,SHOT_FIELD_OPTIONS,type AnalysisShot,type ShotAnalysis,type ShotAnnotation,type ShotProviderStatus} from './studio-shot-analysis-types';
import './studio-analysis-workspace.css';

export type AnalysisWorkspaceInfo={status:string;analyzed:number;total:number;reportUrl?:string;dataUrl?:string;source?:string;draftCount:number;processing:boolean;retry:()=>void;retryDisabled:boolean;error?:string;candidate?:boolean};
type Props={detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;selectShot:(id:string)=>void;onModelSettings?:()=>void;onAnalysisInfo?:(info:AnalysisWorkspaceInfo)=>void;externalDraftCount?:number;active?:boolean;playbackPosition?:{timeUs:number;requestId:number};onPositionChange?:(position:{timeUs:number;shotId?:string})=>void};
type AnalysisResponse={analysis:ShotAnalysis|null;provider:ShotProviderStatus};
const STATUS:Record<string,string>={processing:'正在拉片',ready:'全片分析完成',ready_with_issues:'全片扫描结束 · 有待修正项',blocked:'语义待配置 · 底稿已保留',failed:'分析失败',cancelled:'已取消',stale:'结果已过期'};
const STAGE:Record<string,string>={proxy:'生成素材预览',pts:'读取源帧时间戳',cuts:'检测候选切镜',frames:'提取关键帧',analyze:'逐镜语义分析',validate:'检查全片结果',report:'生成报告',done:'扫描结束'};
const SHOT_STATUS:Record<string,string>={pending:'待分析',analyzed:'已分析',needs_review:'待核对',failed:'失败',user_edited:'人工已修正'};
const CORE_FIELDS=[['size','景别'],['category','镜头类别'],['camera','运镜']] as const;
const DETAIL_FIELDS=[['frame','画面描述'],['action','动作'],['composition','构图'],['scene','场景'],['rhythmNote','节奏说明']] as const;
const TEXT_FIELDS=[...CORE_FIELDS,...DETAIL_FIELDS] as const;
type FieldKey=typeof TEXT_FIELDS[number][0];
const time=(us:number)=>`${(us/1e6).toFixed(3)} s`;
async function request<T>(url:string,body?:unknown,method='GET',signal?:AbortSignal):Promise<T>{
  const response=await fetch(url,{method,signal,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||`请求失败（${response.status}）`);
  return result;
}

export function StudioShotAnalysis({detail,show,onChanged,selectedShotId,selectShot,onModelSettings,onAnalysisInfo,externalDraftCount=0,active=true,playbackPosition,onPositionChange}:Props){
  const base=`/api/studio/projects/${encodeURIComponent(detail.project.id)}`;
  const [response,setResponse]=useState<AnalysisResponse|null>(null);
  const [loadError,setLoadError]=useState('');
  const [operationError,setOperationError]=useState('');
  const [busy,setBusy]=useState('');
  const [selected,setSelected]=useState(selectedShotId);
  const [timeUs,setTimeUs]=useState(0);
  const [ptsUs,setPtsUs]=useState<number[]>([]);
  const [playbackOffsetUs,setPlaybackOffsetUs]=useState<number|null>(null);
  const [clockRetry,setClockRetry]=useState(0);
  const [ptsError,setPtsError]=useState('');
  const [videoError,setVideoError]=useState(false);
  const [mediaReady,setMediaReady]=useState(false);
  const syncTarget=useRef({active,onPositionChange});syncTarget.current={active,onPositionChange};
  const consumedSeek=useRef(-1);
  const [cutFrame,setCutFrame]=useState('');
  const [drafts,setDrafts]=useState<Record<string,Partial<ShotAnnotation>>>({});
  const pendingDrafts=useRef(drafts);pendingDrafts.current=drafts;
  const [editorOpen,setEditorOpen]=useState(false);
  const [narrow,setNarrow]=useState(()=>window.matchMedia('(max-width: 768px)').matches);
  const editor=useRef<HTMLElement>(null);
  const editButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{const query=window.matchMedia('(max-width: 768px)');const changed=()=>setNarrow(query.matches);query.addEventListener('change',changed);return()=>query.removeEventListener('change',changed);},[]);
  useEffect(()=>{if(!active)setEditorOpen(false);},[active]);
  useEffect(()=>{
    if(!editorOpen)return;
    editor.current?.querySelector<HTMLElement>('select:not(:disabled),button:not(:disabled)')?.focus();
    const handleKey=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();setEditorOpen(false);window.requestAnimationFrame(()=>{if(active)editButton.current?.focus();});}
      if(event.key!=='Tab'||!narrow)return;
      const nodes=Array.from(editor.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary')||[]).filter(node=>node.getClientRects().length);
      const first=nodes[0],last=nodes[nodes.length-1];
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',handleKey);return()=>document.removeEventListener('keydown',handleKey);
  },[editorOpen,narrow,active]);
  const video=useRef<HTMLVideoElement>(null);
  const playbackOffset=useRef(playbackOffsetUs);playbackOffset.current=playbackOffsetUs;
  const ptsReady=useRef(false);ptsReady.current=ptsUs.length>0&&playbackOffsetUs!==null;
  const requestVersion=useRef(0);
  const latest=useRef<{run:ShotAnalysis|null;selected:string}>({run:null,selected:''});
  const refresh=useCallback(async()=>{
    const version=++requestVersion.current;
    try{const result=await request<AnalysisResponse>(`${base}/shot-analysis`);if(version===requestVersion.current){
      const currentRun=latest.current.run;
      if(currentRun&&result.analysis?.id!==currentRun.id&&Object.entries(pendingDrafts.current).some(([key,value])=>key.startsWith(`${currentRun.id}:`)&&Object.keys(value).length)){
        setLoadError('服务端已有新的拉片版本。本页保留当前版本和未保存修正；请先处理草稿，再重新读取最新结果。');return;
      }
      setResponse(result);setLoadError('');
    }}
    catch(error){if(version===requestVersion.current)setLoadError((error as Error).message);}
  },[base]);
  useEffect(()=>{void refresh();return()=>{requestVersion.current++;};},[refresh,detail]);
  const run=response?.analysis||null;
  const provider=response?.provider;
  const sessionAnalysis=isSessionVisualAnalysis(run);
  latest.current={run,selected};
  useEffect(()=>{
    if(run?.status!=='processing')return;
    const timer=window.setInterval(()=>{void refresh();},2500);return()=>window.clearInterval(timer);
  },[run?.status,refresh]);
  const proxyVersion=detail.jobs.filter(job=>job.kind==='proxy').map(job=>`${job.id}:${job.state}`).join('|');
  useEffect(()=>{
    const controller=new AbortController();setPtsUs([]);setPlaybackOffsetUs(null);setPtsError('');
    if(detail.media?.ptsCount)void request<{ptsUs:number[];playback:unknown;playbackError?:string}>(`${base}/media/pts`,undefined,'GET',controller.signal).then(result=>{
      if(controller.signal.aborted)return;
      setPtsUs(result.ptsUs);
      const offset=playbackTimeOrigin(result.playback);setPlaybackOffsetUs(offset);
      if(offset===null)setPtsError(result.playbackError||'视频时间信息尚未就绪');
    }).catch(error=>{if(!controller.signal.aborted)setPtsError((error as Error).message);});
    return()=>controller.abort();
  },[base,detail.media?.id,detail.media?.ptsCount,proxyVersion,clockRetry]);
  useEffect(()=>{
    if(!run)return;
    setSelected(current=>run.shots.some(shot=>shot.id===current)?current:run.shots[0]?.id||'');
  },[run]);
  useEffect(()=>{setVideoError(false);setMediaReady(false);consumedSeek.current=-1;video.current?.load();},[detail.media?.id,proxyVersion]);
  const syncVideo=useCallback(()=>{
    if(!syncTarget.current.active||!ptsReady.current)return;
    const t=videoTimeToSourceUs(video.current?.currentTime||0,playbackOffset.current!);setTimeUs(t);
    const shot=analysisShotAt(latest.current.run?.shots||[],t);
    if(shot&&shot.id!==latest.current.selected)setSelected(shot.id);
    if(!latest.current.run?.candidate)syncTarget.current.onPositionChange?.({timeUs:t,shotId:shot?.id});
  },[]);
  useEffect(()=>{
    const element=video.current;if(!element)return;if(!active){element.pause();return;}if(typeof element.requestVideoFrameCallback!=='function')return;
    let token=0,stopped=false;
    const next=()=>{if(stopped)return;syncVideo();token=element.requestVideoFrameCallback(next);};
    token=element.requestVideoFrameCallback(next);
    return()=>{stopped=true;element.cancelVideoFrameCallback(token);};
  },[detail.media?.id,run?.id,syncVideo,active]);
  useEffect(()=>{
    if(!active||!mediaReady||!ptsUs.length||playbackOffsetUs===null||!run||!playbackPosition||consumedSeek.current===playbackPosition.requestId)return;
    const t=Math.max(ptsUs[0],Math.min(ptsUs[ptsUs.length-1],playbackPosition.timeUs));
    if(video.current){video.current.pause();video.current.currentTime=sourceUsToVideoTime(t,playbackOffsetUs,video.current.duration);}
    setTimeUs(t);const target=analysisShotAt(run.shots,t);if(target)setSelected(target.id);
    consumedSeek.current=playbackPosition.requestId;
  },[active,mediaReady,ptsUs,playbackOffsetUs,run,playbackPosition]);
  const seek=(pts:number)=>{if(playbackOffset.current===null)return;if(video.current){video.current.pause();video.current.currentTime=sourceUsToVideoTime(pts,playbackOffset.current,video.current.duration);}setTimeUs(pts);const target=analysisShotAt(run?.shots||[],pts);if(target)setSelected(target.id);if(active&&!run?.candidate)onPositionChange?.({timeUs:pts,shotId:target?.id});};
  const choose=(shot:AnalysisShot)=>{setSelected(shot.id);seek(shot.startUs);if(!run?.candidate)selectShot(shot.id);};
  const frameIndex=sourceFrameAt(ptsUs,timeUs);
  const step=(direction:number)=>{if(frameIndex<0)return;const next=Math.max(0,Math.min(ptsUs.length-1,frameIndex+direction));seek(ptsUs[next]);};
  const selectedIndex=run?.shots.findIndex(shot=>shot.id===selected)??-1;
  const shot=run?.shots[selectedIndex];
  const draftKey=run&&shot?`${run.id}:${shot.id}`:'';
  const draft=drafts[draftKey]||{};
  const hasDraft=Object.keys(draft).length>0;
  const draftCount=run?Object.entries(drafts).filter(([key,value])=>key.startsWith(`${run.id}:`)&&Object.keys(value).length).length:0;
  const versionDraftCount=draftCount+externalDraftCount;
  const versionGuardMessage=externalDraftCount>0?`人物或修正工具有 ${externalDraftCount} 项未保存输入。请先保存或撤回，再更新拉片、调整切点或采用候选版本。`:draftCount>0?'请先保存或撤回当前拉片修正，再更新拉片、调整切点或采用候选版本。':'';
  useEffect(()=>{if(!draftCount)return;const protect=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[draftCount]);
  const value={...shot?.effective,...draft};
  const edit=(patch:Partial<ShotAnnotation>)=>setDrafts(current=>({...current,[draftKey]:{...current[draftKey],...patch}}));
  const discard=()=>setDrafts(current=>{const next={...current};delete next[draftKey];return next;});
  const issues=run?analysisIssues(run):[];
  const readOnly=run?.status==='stale'||run?.status==='cancelled';
  const locked=!!busy||run?.status==='processing'||readOnly;
  const fileUrl=(name:string)=>`${base}/shot-analysis/${encodeURIComponent(run!.id)}/file?path=${encodeURIComponent(name)}`;
  const closeEditor=()=>{setEditorOpen(false);window.requestAnimationFrame(()=>{if(active)editButton.current?.focus();});};
  const fieldInput=([field,label]:readonly[FieldKey,string])=>{
    const options=field in SHOT_FIELD_OPTIONS?SHOT_FIELD_OPTIONS[field as keyof typeof SHOT_FIELD_OPTIONS]:null;
    return <label key={field}>{label}{options?<select aria-label={label} value={value[field]||''} disabled={!!busy||readOnly} onChange={event=>edit({[field]:event.target.value})}><option value="" disabled>尚未分析</option>{options.map(([id,text])=><option key={id} value={id}>{text}</option>)}</select>:<textarea aria-label={label} rows={field==='frame'||field==='action'?3:2} value={value[field]||''} disabled={!!busy||readOnly} onChange={event=>edit({[field]:event.target.value})} placeholder={shot?.generated?'':'尚无模型结果，可填入人工修正'}/>}</label>;
  };
  const start=async()=>{
    if(versionDraftCount){setOperationError(versionGuardMessage);show(versionGuardMessage);return;}
    setOperationError('');setBusy('start');
    try{await request(`${base}/shot-analysis`,{baseRevision:detail.project.revision,...(run?{sourceRunId:run.id,sourceRunRevision:run.revision}:{})},'POST');show('已开始全片拉片，待修正项会统一汇总。');await refresh();onChanged();}
    catch(error){setOperationError((error as Error).message);show((error as Error).message);}finally{setBusy('');}
  };
  const startAction=useRef(start);startAction.current=start;
  const retryAnalysis=useCallback(()=>{void startAction.current();},[]);
  const dataUrl=run?.artifactRef?fileUrl(run.artifactRef):undefined;
  const reportUrl=run?.artifactRef?fileUrl('report.html'):undefined;
  const analysisSource=run?.model?(sessionAnalysis?'本次会话视觉分析（一次性）':`${run.provider} / ${run.model}`):undefined;
  useEffect(()=>{onAnalysisInfo?.({status:run?STATUS[run.status]||run.status:response?'尚未开始':'读取中…',analyzed:run?.counts.analyzed||0,total:run?.counts.total||0,reportUrl,dataUrl,source:analysisSource,draftCount,processing:run?.status==='processing',retry:retryAnalysis,retryDisabled:!!busy||run?.status==='processing'||versionDraftCount>0,error:versionGuardMessage||operationError||loadError||run?.error||undefined,candidate:run?.candidate});},[onAnalysisInfo,run?.status,run?.counts.analyzed,run?.counts.total,run?.candidate,reportUrl,dataUrl,analysisSource,draftCount,versionDraftCount,versionGuardMessage,retryAnalysis,busy,operationError,loadError,run?.error,!!response]);
  const save=async()=>{
    if(!run||!shot)return;setOperationError('');setBusy('save');
    const overrides={...draft,...(draft.uncertainties?{uncertainties:draft.uncertainties.map(item=>item.trim()).filter(Boolean)}:{})};
    try{await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/shots/${encodeURIComponent(shot.id)}`,{baseRevision:run.revision,overrides},'PATCH');discard();await refresh();onChanged();if(latest.current.selected===shot.id)closeEditor();show('人工修正已保存；模型原文保留。');}
    catch(error){setOperationError((error as Error).message);show((error as Error).message);await refresh();}finally{setBusy('');}
  };
  const recut=async(action:'split'|'merge'|'move')=>{
    if(!run||!shot)return;
    if(versionDraftCount){setOperationError(versionGuardMessage);show(versionGuardMessage);return;}
    try{
      const candidateFrame=cutFrame.trim()?Number(cutFrame):frameIndex;
      const cutFrames=editedCutFrames(run.shots,selectedIndex,action,candidateFrame);
      setOperationError('');setBusy('recut');await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/recut`,{baseRevision:run.revision,cutFrames},'POST');
      setCutFrame('');await refresh();onChanged();show('切点修正已生成候选版本，检查结果后可采用。');
    }catch(error){setOperationError((error as Error).message);show((error as Error).message);}finally{setBusy('');}
  };
  const adopt=async()=>{
    if(versionDraftCount){setOperationError(versionGuardMessage);show(versionGuardMessage);return;}
    if(!run)return;setOperationError('');setBusy('apply');
    try{await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/apply`,{baseRevision:detail.project.revision},'POST');await refresh();onChanged();show('已采用候选切点；受影响的下游数据已标记过期。');}
    catch(error){setOperationError((error as Error).message);show((error as Error).message);}finally{setBusy('');}
  };
  if(!detail.media)return null;
  return <section className="studio-card shot-analysis analysis-workbench" id="studio-shot-analysis" data-analysis-run={run?.id||''}>
    {loadError&&<div className="studio-banner studio-banner-error" role="alert"><b>拉片数据未能读取</b><p>{loadError}</p><button onClick={()=>void refresh()}>重新读取</button></div>}
    {operationError&&<div className="studio-banner studio-banner-error" role="alert"><b>操作尚未完成</b><p>{operationError}</p><button onClick={()=>setOperationError('')}>已了解</button></div>}
    {run?.error&&<div className={`studio-banner${run.status==='failed'?' studio-banner-error':''}`} role={run.status==='failed'?'alert':'status'}><b>{STATUS[run.status]||run.status}</b><p>{run.error}</p>{onModelSettings&&(sessionAnalysis||!provider?.configured)&&<button onClick={onModelSettings}>配置视觉模型</button>}</div>}
    {!run&&response&&<div className="analysis-empty-start"><div><b>先看原片，再开始拉片</b><p>{versionGuardMessage||(provider?.configured?'自动拉片会建立镜头底稿并分析画面。':provider?.reason||'镜头底稿可以生成；自动描述需要配置视觉模型。')}</p></div><button className="analysis-primary" onClick={()=>void start()} disabled={!!busy||versionDraftCount>0}>{busy==='start'?'提交中…':'开始拉片'}</button></div>}
    {run?.status==='processing'&&<div className="analysis-progress" aria-live="polite"><div><b>{STAGE[run.stage]||run.stage}</b><span>已分析 {run.counts.analyzed}/{run.counts.total} 镜{run.counts.failed?` · ${run.counts.failed} 镜失败`:''}{run.counts.needsReview?` · ${run.counts.needsReview} 镜待核对`:''}</span></div><div className="studio-progress"><div style={{width:`${Math.max(1,Math.min(100,run.progress*100))}%`}}/></div></div>}
    {draftCount>0&&<div className="analysis-draft-notice" role="status"><span>{draftCount} 镜有未保存修正 · 切换镜头和视图会保留草稿</span>{!hasDraft&&!editorOpen&&<button onClick={()=>{const target=run?.shots.find(item=>Object.keys(drafts[`${run.id}:${item.id}`]||{}).length);if(target){choose(target);video.current?.pause();setEditorOpen(true);}}}>继续未保存修正</button>}</div>}
    {run?.candidate&&<div className="studio-banner analysis-candidate"><div><b>正在查看候选切点版本</b><p>采用后更新活动镜头；受影响的人物检测、相机与动作需要重跑。</p>{versionGuardMessage&&<p className="analysis-unsaved">{versionGuardMessage}</p>}</div>{!editorOpen&&<button className="analysis-primary" onClick={()=>void adopt()} disabled={!!busy||versionDraftCount>0||!['ready','ready_with_issues','blocked'].includes(run.status)}>{busy==='apply'?'采用中…':'采用候选版本'}</button>}</div>}
    <div className="analysis-viewing-space" data-editing={editorOpen}>
      <div className="analysis-main-view">
        <div className="analysis-viewer">
          <video ref={video} onLoadedMetadata={()=>setMediaReady(true)} className="studio-media-video" src={`${base}/media/preview`} controls preload="metadata" onTimeUpdate={syncVideo} onSeeked={syncVideo} onError={()=>setVideoError(true)} onLoadedData={()=>setVideoError(false)} aria-label="拉片原片预览"/>
          {videoError&&<div className="studio-job-error" role="alert">预览暂不可播放；请查看素材预览任务状态。<button onClick={()=>{video.current?.load();setClockRetry(value=>value+1);}}>重载视频</button></div>}
          <div className="analysis-playback-controls">
            <div className="studio-toolbar analysis-video-tools"><button disabled={selectedIndex<=0||!!busy} onClick={()=>run&&choose(run.shots[selectedIndex-1])}>上一镜</button><button disabled={frameIndex<=0} onClick={()=>step(-1)}>上一帧</button><button disabled={frameIndex<0||frameIndex>=ptsUs.length-1} onClick={()=>step(1)}>下一帧</button><button disabled={!run||selectedIndex<0||selectedIndex>=run.shots.length-1||!!busy} onClick={()=>run&&choose(run.shots[selectedIndex+1])}>下一镜</button></div>
            <span className="analysis-clock">{time(timeUs)} · {frameIndex>=0?`源帧 ${frameIndex}`:'等待源帧时间信息'}</span>
          </div>
          {ptsError&&<div className="studio-job-error" role="alert">时间映射不可用：{ptsError}<button onClick={()=>setClockRetry(value=>value+1)}>重试时间映射</button></div>}
        </div>
        {run&&shot&&<section className="analysis-selected-summary" aria-labelledby="analysis-shot-title">
          <div className="analysis-summary-copy"><div className="analysis-summary-heading"><h3 id="analysis-shot-title">第 {selectedIndex+1} 镜</h3><span>{SHOT_STATUS[shot.status]||shot.status}</span><span>{time(shot.startUs)} — {time(shot.endUs)}</span>{hasDraft&&<em>本镜未保存</em>}</div><div className="analysis-result-tags">{CORE_FIELDS.map(([field])=><span key={field}>{analysisFieldLabel(field,value[field])}</span>)}</div><p>{value.action||value.frame||'语义尚未生成，可查看原片并按需修正。'}</p></div>
          {!editorOpen&&<button ref={editButton} className="analysis-edit-entry" onClick={()=>{video.current?.pause();setEditorOpen(true);}}>{readOnly?'查看详情':'修正'}</button>}
        </section>}
      </div>
      {run&&shot&&editorOpen&&<>
        {narrow&&<div className="analysis-editor-scrim" onClick={closeEditor} aria-hidden="true"/>}
        <aside ref={editor} className="analysis-context-editor" role={narrow?'dialog':'region'} aria-modal={narrow||undefined} aria-labelledby="analysis-editor-title">
          <div className="analysis-editor-heading"><div><h3 id="analysis-editor-title">第 {selectedIndex+1} 镜 · 修正</h3><span>{hasDraft?'未保存修改':readOnly?'此版本仅供查看':'人工修正保留模型原文'}</span></div><button onClick={closeEditor} aria-label="收起修正">收起</button></div>
          <div className="analysis-editor-content">
            <div className="analysis-editor-grid">{CORE_FIELDS.map(fieldInput)}</div>
            <details className="analysis-more-tools"><summary>更多修正工具</summary>
              <details className="analysis-optional"><summary>描述与人物出场</summary><p className="muted">报告标记不改变人物归属，也不影响三维还原计算。</p><fieldset className="analysis-subject-picker"><legend>本镜出场</legend>{run.subjects.length?run.subjects.map(subject=><label key={subject.id}><input type="checkbox" disabled={!!busy||readOnly} checked={(value.subjects||[]).includes(subject.id)} onChange={event=>edit({subjects:event.target.checked?[...(value.subjects||[]),subject.id]:(value.subjects||[]).filter(id=>id!==subject.id)})}/>{subject.kind==='person'?'人物':subject.kind==='animal'?'动物':'待定'} · {subject.name||subject.id}</label>):<p className="muted">全片候选表尚无主体。</p>}</fieldset><div className="analysis-editor-grid">{DETAIL_FIELDS.map(fieldInput)}<label>不确定项（每行一项）<textarea rows={3} value={(value.uncertainties||[]).join('\n')} disabled={!!busy||readOnly} onChange={event=>edit({uncertainties:event.target.value.split('\n')})}/></label></div></details>
              <details className="analysis-cut-tools"><summary>调整本镜切点</summary><div className="studio-toolbar"><label>源帧号<input type="number" min={0} max={Math.max(0,detail.media.ptsCount-1)} step={1} value={cutFrame} onChange={event=>setCutFrame(event.target.value)} placeholder={frameIndex>=0?`当前 ${frameIndex}`:'整数源帧号'}/></label><button disabled={locked||versionDraftCount>0} onClick={()=>void recut('split')}>在此帧拆分本镜</button><button disabled={locked||versionDraftCount>0||selectedIndex>=run.shots.length-1} onClick={()=>void recut('move')}>移动本镜后切点</button><button disabled={locked||versionDraftCount>0||selectedIndex>=run.shots.length-1} onClick={()=>void recut('merge')}>与后一镜合并</button></div><p className="muted">帧号从 0 开始。生成候选版本后检查并采用；采用前保留原活动镜头，采用后受影响的检测、相机与动作需重跑。</p>{versionGuardMessage&&<p className="analysis-unsaved">{versionGuardMessage}</p>}</details>
              <details className="analysis-generated"><summary>关键帧与模型原始结果</summary><div className="analysis-evidence" aria-label="所选镜头关键帧">{shot.evidenceFrames.length?shot.evidenceFrames.map((evidence,index)=><button key={`${evidence.frameIndex}:${index}`} onClick={()=>seek(evidence.ptsUs)}><img src={evidence.url||fileUrl(evidence.imageRef)} alt={`第 ${selectedIndex+1} 镜证据帧 ${evidence.frameIndex}`} loading="lazy"/><span>源帧 {evidence.frameIndex} · {time(evidence.ptsUs)}</span></button>):<p className="muted">该镜关键帧尚未生成。</p>}</div>{shot.generated?<><dl>{TEXT_FIELDS.map(([field,label])=><div key={field}><dt>{label}</dt><dd>{shot.generated?.[field]||'未提供'}</dd></div>)}<div><dt>主体引用</dt><dd>{shot.generated.subjects.join('、')||'无'}</dd></div><div><dt>证据源帧</dt><dd>{shot.generated.evidenceFrames.join('、')}</dd></div><div><dt>不确定项</dt><dd>{shot.generated.uncertainties?.join('；')||'无记录'}</dd></div></dl><pre aria-label="完整原始语义数据">{JSON.stringify(shot.generated,null,2)}</pre></>:<p className="muted">此镜尚未获得模型语义结果。</p>}</details>
              <details className="analysis-catalog"><summary>全片人物分析依据</summary><div className="analysis-subjects">{(['person','animal','unknown'] as const).map(kind=>{const subjects=run.subjects.filter(subject=>subject.kind===kind);return <section key={kind}><h3>{kind==='person'?'人物候选':kind==='animal'?'动物候选':'类型待定'} <span>{subjects.length}</span></h3>{subjects.length?subjects.map(subject=><article key={subject.id}><b>{subject.name||'未命名'}{subject.uncertain&&' · 待核对'}</b><p>{subject.description}</p>{subject.species&&<small>物种：{subject.species}</small>}{!!subject.referenceFrames?.length&&<div>{subject.referenceFrames.map(frame=><button key={frame} disabled={ptsUs[frame]===undefined} onClick={()=>seek(ptsUs[frame])}>证据帧 {frame}</button>)}</div>}</article>):<p className="muted">{run.counts.analyzed?'未列出此类候选，不代表全片为零。':'等待视觉分析结果。'}</p>}</section>;})}</div></details>
              <details className="analysis-issues"><summary>待核对内容（{issues.length} 条）</summary>{issues.length?<ul>{issues.map((issue,index)=><li key={`${issue.code}:${issue.shotId||''}:${index}`} className={`issue-${issue.severity}`}>{issue.shotId&&<button onClick={()=>{const target=run.shots.find(item=>item.id===issue.shotId);if(target)choose(target);}}>{run.shots.findIndex(item=>item.id===issue.shotId)>=0?`第 ${run.shots.findIndex(item=>item.id===issue.shotId)+1} 镜`:issue.shotId}</button>}<span>{issue.message}{issue.field&&<small> · {issue.field}</small>}</span></li>)}</ul>:<p className="muted">{run.status==='processing'?'全片扫描仍在进行。':run.counts.analyzed===0?'尚无可审查的语义结果。':'没有记录待修正项；视觉准确性仍需结合原片核对。'}</p>}</details>
              <details className="analysis-guide"><summary>分析来源与修正说明</summary><p>{analysisSource||'分析来源尚未记录'}</p><p className="muted">切点修正影响后续检测与交付；人物出场、景别、类别、运镜及描述作为报告修正保存。从顶部处理状态更新拉片，从项目菜单导出报告。</p><p className="analysis-provenance">运行 {run.id} · {new Date(run.updatedAt).toLocaleString('zh-CN')}<br/>源片 {run.mediaHash?.slice(0,12)} · 切镜版本 {run.shotSetHash?.slice(0,12)}</p></details>
            </details>
          </div>
          <div className="analysis-editor-actions"><button className="analysis-primary" onClick={()=>void save()} disabled={!!busy||!hasDraft||readOnly}>{busy==='save'?'保存中…':'保存修正'}</button><button disabled={!!busy||!hasDraft} onClick={()=>{discard();closeEditor();}}>撤回本镜草稿</button></div>
        </aside>
      </>}
    </div>
    <StudioShotStrip items={(run?.shots||[]).map((item,index)=>({id:item.id,index,startUs:item.startUs,endUs:item.endUs,thumbnail:item.evidenceFrames[0]?(item.evidenceFrames[0].url||fileUrl(item.evidenceFrames[0].imageRef)):undefined,status:SHOT_STATUS[item.status]||item.status,description:item.effective?.action||item.effective?.frame||'语义尚未生成',meta:`${analysisFieldLabel('size',item.effective?.size)} · ${analysisFieldLabel('camera',item.effective?.camera)}`,dirty:Object.keys(drafts[`${run!.id}:${item.id}`]||{}).length>0}))} selectedId={selected} disabled={!!busy} onSelect={item=>{const target=run?.shots.find(shot=>shot.id===item.id);if(target)choose(target);}} scopeLabel={run?.candidate?'候选版本 · 全部镜头':'全部镜头'} emptyMessage={run?.status==='processing'?'候选切镜处理中，镜头底稿就绪后将在这里显示。':run?'此运行尚无镜头底稿，请查看处理状态。':'开始拉片后显示镜头底稿。'}/>
  </section>;
}
