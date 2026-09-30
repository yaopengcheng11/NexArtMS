import {useCallback,useEffect,useRef,useState} from 'react';
import type {ProjectDetail} from './studio';
import {analysisFieldLabel,analysisIssues,analysisShotAt,editedCutFrames,isSessionVisualAnalysis,sourceFrameAt,SHOT_FIELD_OPTIONS,type AnalysisShot,type ShotAnalysis,type ShotAnnotation,type ShotProviderStatus} from './studio-shot-analysis-types';

type Props={detail:ProjectDetail;show:(message:string)=>void;onChanged:()=>void;selectedShotId:string;selectShot:(id:string)=>void;onModelSettings?:()=>void;active?:boolean;playbackPosition?:{timeUs:number;requestId:number};onPositionChange?:(position:{timeUs:number;shotId?:string})=>void};
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

export function StudioShotAnalysis({detail,show,onChanged,selectedShotId,selectShot,onModelSettings,active=true,playbackPosition,onPositionChange}:Props){
  const base=`/api/studio/projects/${encodeURIComponent(detail.project.id)}`;
  const [response,setResponse]=useState<AnalysisResponse|null>(null);
  const [loadError,setLoadError]=useState('');
  const [busy,setBusy]=useState('');
  const [selected,setSelected]=useState(selectedShotId);
  const [timeUs,setTimeUs]=useState(0);
  const [ptsUs,setPtsUs]=useState<number[]>([]);
  const [ptsError,setPtsError]=useState('');
  const [videoError,setVideoError]=useState(false);
  const [mediaReady,setMediaReady]=useState(false);
  const syncTarget=useRef({active,onPositionChange});syncTarget.current={active,onPositionChange};
  const consumedSeek=useRef(-1);
  const [cutFrame,setCutFrame]=useState('');
  const [drafts,setDrafts]=useState<Record<string,Partial<ShotAnnotation>>>({});
  const video=useRef<HTMLVideoElement>(null);
  const ptsOrigin=useRef(0);
  ptsOrigin.current=ptsUs[0]||0;
  const ptsReady=useRef(false);ptsReady.current=ptsUs.length>0;
  const requestVersion=useRef(0);
  const latest=useRef<{run:ShotAnalysis|null;selected:string}>({run:null,selected:''});
  const refresh=useCallback(async()=>{
    const version=++requestVersion.current;
    try{const result=await request<AnalysisResponse>(`${base}/shot-analysis`);if(version===requestVersion.current){setResponse(result);setLoadError('');}}
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
  useEffect(()=>{
    const controller=new AbortController();setPtsUs([]);setPtsError('');
    if(detail.media?.ptsCount)void request<{ptsUs:number[]}>(`${base}/media/pts`,undefined,'GET',controller.signal).then(result=>setPtsUs(result.ptsUs)).catch(error=>{if(!controller.signal.aborted)setPtsError((error as Error).message);});
    return()=>controller.abort();
  },[base,detail.media?.id,detail.media?.ptsCount]);
  useEffect(()=>{
    if(!run)return;
    setSelected(current=>run.shots.some(shot=>shot.id===current)?current:run.shots[0]?.id||'');
  },[run]);
  useEffect(()=>{setVideoError(false);video.current?.load();},[detail.jobs.filter(job=>job.kind==='proxy').map(job=>`${job.id}:${job.state}`).join('|')]);
  const syncVideo=useCallback(()=>{
    if(!syncTarget.current.active||!ptsReady.current)return;
    const t=Math.round((video.current?.currentTime||0)*1e6)+ptsOrigin.current;setTimeUs(t);
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
    if(!active||!mediaReady||!ptsUs.length||!run||!playbackPosition||consumedSeek.current===playbackPosition.requestId)return;
    const t=Math.max(ptsUs[0],Math.min(ptsUs[ptsUs.length-1],playbackPosition.timeUs));
    if(video.current){video.current.pause();video.current.currentTime=(t-ptsUs[0])/1e6;}
    setTimeUs(t);const target=analysisShotAt(run.shots,t);if(target)setSelected(target.id);
    consumedSeek.current=playbackPosition.requestId;
  },[active,mediaReady,ptsUs,run,playbackPosition]);
  const seek=(pts:number)=>{if(video.current){video.current.pause();video.current.currentTime=(pts-ptsOrigin.current)/1e6;}setTimeUs(pts);const target=analysisShotAt(run?.shots||[],pts);if(target)setSelected(target.id);if(active&&!run?.candidate)onPositionChange?.({timeUs:pts,shotId:target?.id});};
  const choose=(shot:AnalysisShot)=>{setSelected(shot.id);seek(shot.startUs);if(!run?.candidate)selectShot(shot.id);};
  const frameIndex=sourceFrameAt(ptsUs,timeUs);
  const step=(direction:number)=>{if(frameIndex<0)return;const next=Math.max(0,Math.min(ptsUs.length-1,frameIndex+direction));seek(ptsUs[next]);};
  const selectedIndex=run?.shots.findIndex(shot=>shot.id===selected)??-1;
  const shot=run?.shots[selectedIndex];
  const draftKey=run&&shot?`${run.id}:${shot.id}`:'';
  const draft=drafts[draftKey]||{};
  const hasDraft=Object.keys(draft).length>0;
  const draftCount=run?Object.entries(drafts).filter(([key,value])=>key.startsWith(`${run.id}:`)&&Object.keys(value).length).length:0;
  const value={...shot?.effective,...draft};
  const edit=(patch:Partial<ShotAnnotation>)=>setDrafts(current=>({...current,[draftKey]:{...current[draftKey],...patch}}));
  const discard=()=>setDrafts(current=>{const next={...current};delete next[draftKey];return next;});
  const issues=run?analysisIssues(run):[];
  const readOnly=run?.status==='stale'||run?.status==='cancelled';
  const locked=!!busy||run?.status==='processing'||readOnly;
  const fileUrl=(name:string)=>`${base}/shot-analysis/${encodeURIComponent(run!.id)}/file?path=${encodeURIComponent(name)}`;
  const fieldInput=([field,label]:readonly[FieldKey,string])=>{
    const options=field in SHOT_FIELD_OPTIONS?SHOT_FIELD_OPTIONS[field as keyof typeof SHOT_FIELD_OPTIONS]:null;
    return <label key={field}>{label}{options?<select aria-label={label} value={value[field]||''} disabled={!!busy||readOnly} onChange={event=>edit({[field]:event.target.value})}><option value="" disabled>尚未分析</option>{options.map(([id,text])=><option key={id} value={id}>{text}</option>)}</select>:<textarea aria-label={label} rows={field==='frame'||field==='action'?3:2} value={value[field]||''} disabled={!!busy||readOnly} onChange={event=>edit({[field]:event.target.value})} placeholder={shot?.generated?'':'尚无模型结果，可填入人工修正'}/>}</label>;
  };
  const start=async()=>{
    setBusy('start');
    try{await request(`${base}/shot-analysis`,{baseRevision:detail.project.revision,...(run?{sourceRunId:run.id,sourceRunRevision:run.revision}:{})},'POST');show('已开始全片拉片，待修正项会统一汇总。');await refresh();onChanged();}
    catch(error){show((error as Error).message);}finally{setBusy('');}
  };
  const save=async()=>{
    if(!run||!shot)return;setBusy('save');
    const overrides={...draft,...(draft.uncertainties?{uncertainties:draft.uncertainties.map(item=>item.trim()).filter(Boolean)}:{})};
    try{await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/shots/${encodeURIComponent(shot.id)}`,{baseRevision:run.revision,overrides},'PATCH');discard();await refresh();onChanged();show('人工修正已保存；模型原文保留。');}
    catch(error){show((error as Error).message);await refresh();}finally{setBusy('');}
  };
  const recut=async(action:'split'|'merge'|'move')=>{
    if(!run||!shot)return;
    try{
      const candidateFrame=cutFrame.trim()?Number(cutFrame):frameIndex;
      const cutFrames=editedCutFrames(run.shots,selectedIndex,action,candidateFrame);
      setBusy('recut');await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/recut`,{baseRevision:run.revision,cutFrames},'POST');
      setCutFrame('');await refresh();onChanged();show('切点修正已生成候选版本，检查结果后可采用。');
    }catch(error){show((error as Error).message);}finally{setBusy('');}
  };
  const adopt=async()=>{
    if(!run)return;setBusy('apply');
    try{await request(`${base}/shot-analysis/${encodeURIComponent(run.id)}/apply`,{baseRevision:detail.project.revision},'POST');await refresh();onChanged();show('已采用候选切点；受影响的下游数据已标记过期。');}
    catch(error){show((error as Error).message);}finally{setBusy('');}
  };
  if(!detail.media)return null;
  return <section className="studio-card shot-analysis" id="studio-shot-analysis" data-analysis-run={run?.id||''}>
    <div className="panel-title"><h2>拉片</h2><span role="status">{run?`${run.counts.analyzed}/${run.counts.total} 镜 · ${STATUS[run.status]||run.status}`:response?'尚未开始':'读取中…'}</span></div>

    {loadError&&<div className="studio-banner studio-banner-error" role="alert"><b>拉片数据未能读取</b><p>{loadError}</p><button onClick={()=>void refresh()}>重新读取</button></div>}
    {(sessionAnalysis||(provider&&!provider.configured))&&<details className="analysis-config" open={!run?.counts.analyzed}><summary>{run?.counts.analyzed?'后续自动分析设置':'配置自动语义分析'}</summary>
      <p className="muted">{sessionAnalysis?'当前为会话分析结果，已保留。后续自动分析需要配置视觉模型。':provider?.reason||'关键帧与镜头表可用，自动生成描述需要视觉模型。'}</p>
      {onModelSettings&&<button onClick={onModelSettings}>配置视觉模型</button>}
    </details>}
    {run?.error&&<div className={`studio-banner${run.status==='failed'?' studio-banner-error':''}`} role={run.status==='failed'?'alert':undefined}><b>{STATUS[run.status]||run.status}</b><p>{run.error}</p></div>}
    {run?.status==='processing'&&<div className="analysis-progress" aria-live="polite"><div><b>{STAGE[run.stage]||run.stage}</b><span>已分析 {run.counts.analyzed}/{run.counts.total} 镜{run.counts.failed?` · ${run.counts.failed} 镜失败`: ''}{run.counts.needsReview?` · ${run.counts.needsReview} 镜待核对`: ''}</span></div>{run.status==='processing'&&<div className="studio-progress"><div style={{width:`${Math.max(1,Math.min(100,run.progress*100))}%`}}/></div>}</div>}
    <div className="studio-toolbar">
      <button onClick={()=>void start()} disabled={!!busy||run?.status==='processing'||draftCount>0}>{busy==='start'?'提交中…':run?'更新 / 重试拉片':'开始自动拉片'}</button>
      {run?.artifactRef&&<><a href={fileUrl(run.artifactRef)} target="_blank" rel="noreferrer">分析数据 ↗</a><a href={fileUrl('report.html')} target="_blank" rel="noreferrer">拉片报告 ↗</a></>}
      {run?.model&&<details className="analysis-model-info"><summary>分析来源</summary><span className="muted">{sessionAnalysis?'来源：本次会话视觉分析（一次性）':`本次使用 ${run.provider} / ${run.model}`}</span></details>}
      {draftCount>0&&<span className="analysis-unsaved">{draftCount} 镜有未保存修正，请保存或撤回后再创建新版本。</span>}
    </div>
    {run?.candidate&&<div className="studio-banner analysis-candidate"><div><b>正在查看候选切点版本</b><p>采用后切换活动镜头；受影响的旧检测、相机与动作会过期。</p></div><button onClick={()=>void adopt()} disabled={!!busy||draftCount>0||!['ready','ready_with_issues','blocked'].includes(run.status)}>采用此候选版本</button></div>}
    <div className="analysis-workspace">
      <div className="analysis-viewer">
        <video ref={video} onLoadedMetadata={()=>setMediaReady(true)} className="studio-media-video" src={`${base}/media/preview`} controls preload="metadata" onTimeUpdate={syncVideo} onSeeked={syncVideo} onError={()=>setVideoError(true)} onLoadedData={()=>setVideoError(false)} aria-label="拉片原片预览"/>
        {videoError&&<p className="studio-job-error">预览暂不可播放；请查看素材预览任务状态。<button onClick={()=>video.current?.load()}>重载视频</button></p>}
        <div className="studio-toolbar analysis-video-tools">
          <button disabled={selectedIndex<=0} onClick={()=>run&&choose(run.shots[selectedIndex-1])}>上一镜</button>
          <button disabled={frameIndex<=0} onClick={()=>step(-1)}>上一帧</button>
          <button disabled={frameIndex<0||frameIndex>=ptsUs.length-1} onClick={()=>step(1)}>下一帧</button>
          <button disabled={!run||selectedIndex<0||selectedIndex>=run.shots.length-1} onClick={()=>run&&choose(run.shots[selectedIndex+1])}>下一镜</button>
        </div>
        <p className="analysis-clock">{time(timeUs)} · {frameIndex>=0?`源帧 ${frameIndex}`:'等待源帧 PTS'}{shot?` · 第 ${selectedIndex+1} 镜`:''}</p>
        {ptsError&&<p className="studio-job-error">时间映射不可用：{ptsError}</p>}
        {shot&&<div className="analysis-evidence" aria-label="所选镜头关键帧">
          {shot.evidenceFrames.length?shot.evidenceFrames.map((evidence,index)=><button key={`${evidence.frameIndex}:${index}`} onClick={()=>seek(evidence.ptsUs)}><img src={evidence.url||fileUrl(evidence.imageRef)} alt={`第 ${selectedIndex+1} 镜证据帧 ${evidence.frameIndex}`} loading="lazy"/><span>帧 {evidence.frameIndex} · {time(evidence.ptsUs)}</span></button>):<p className="muted">该镜关键帧尚未生成。</p>}
        </div>}
      </div>
      <div className="analysis-shot-list" aria-label="全片镜头表">
        {!run?.shots.length&&<p className="muted">{run?.status==='processing'?'正在等待候选切镜，全片镜头表将在切镜完成后出现。':run?'当前运行尚无镜头底稿，请查看上方状态和分析任务。':'开始拉片后，这里显示逐镜状态与关键帧。'}</p>}
        {run?.shots.map((item,index)=><button key={item.id} aria-pressed={item.id===selected} className={`analysis-shot-row ${item.id===selected?'selected':''}`} onClick={()=>choose(item)}>
          {item.evidenceFrames[0]&&<img src={item.evidenceFrames[0].url||fileUrl(item.evidenceFrames[0].imageRef)} alt="" loading="lazy"/>}
          <span><b>第 {index+1} 镜 <small>{SHOT_STATUS[item.status]||item.status}</small></b><small>{time(item.startUs)} — {time(item.endUs)}</small><span>{item.effective?.action||item.effective?.frame||'语义尚未生成'}</span><small>{analysisFieldLabel('size',item.effective?.size)} · {analysisFieldLabel('camera',item.effective?.camera)}</small>{drafts[`${run.id}:${item.id}`]&&<em>未保存修正</em>}</span>
        </button>)}
      </div>
    </div>
    {run&&shot&&<section className="analysis-detail" aria-labelledby="analysis-shot-title">
      <div className="panel-title"><h3 id="analysis-shot-title">第 {selectedIndex+1} 镜 · {SHOT_STATUS[shot.status]}</h3><span>{shot.id} · {time(shot.startUs)}—{time(shot.endUs)}</span></div>
      <div className="analysis-result-summary">
        <div className="analysis-result-tags">{CORE_FIELDS.map(([field,label])=><span key={field}>{label} · {analysisFieldLabel(field,value[field])}</span>)}</div>
        <p>{value.action||value.frame||'此镜头的语义分析尚未生成，关键帧仍可查看。'}</p>
        {!!value.subjects?.length&&<p className="muted">出场：{value.subjects.map(id=>run.subjects.find(subject=>subject.id===id)?.name||id).join('、')}</p>}
        {hasDraft&&<span className="analysis-unsaved">本镜有未保存修改</span>}
      </div>
      <details className="analysis-cut-tools"><summary>调整本镜切点</summary><div className="studio-toolbar"><label>源帧号<input type="number" min={0} max={Math.max(0,detail.media.ptsCount-1)} step={1} value={cutFrame} onChange={event=>setCutFrame(event.target.value)} placeholder={frameIndex>=0?`当前 ${frameIndex}`:'整数源帧号'}/></label><button disabled={locked||draftCount>0} onClick={()=>void recut('split')}>在此帧拆分本镜</button><button disabled={locked||draftCount>0||selectedIndex>=run.shots.length-1} onClick={()=>void recut('move')}>将本镜后切点移至此帧</button><button disabled={locked||draftCount>0||selectedIndex>=run.shots.length-1} onClick={()=>void recut('merge')}>与后一镜合并</button></div><p className="muted">帧号从 0 开始。只生成候选版本；变化区间重新取证与分析，原活动镜头在采用前保持不变。采用后，人物检测、相机与动作需重跑。</p></details>
      <details className="analysis-edit-tools"><summary>修改本镜{hasDraft?' · 未保存':''}</summary>
      <fieldset className="analysis-subject-picker"><legend>本镜出场（报告标记，不改变人物归属）</legend>{run.subjects.length?run.subjects.map(subject=><label key={subject.id}><input type="checkbox" disabled={!!busy||readOnly} checked={(value.subjects||[]).includes(subject.id)} onChange={event=>edit({subjects:event.target.checked?[...(value.subjects||[]),subject.id]:(value.subjects||[]).filter(id=>id!==subject.id)})}/>{subject.kind==='person'?'人物':subject.kind==='animal'?'动物':'待定'} · {subject.id} {subject.name}</label>):<p className="muted">全片候选表尚无主体。</p>}</fieldset>
      <div className="analysis-editor-grid">{CORE_FIELDS.map(fieldInput)}</div>
      <div className="studio-toolbar"><button onClick={()=>void save()} disabled={!!busy||!hasDraft||readOnly}>{busy==='save'?'保存中…':'保存本镜修正'}</button><button disabled={!!busy||!hasDraft} onClick={discard}>撤回未保存修改</button><span className="muted">人工修正与模型原文分别保存；切换镜头会保留未保存草稿。</span></div>
      <details className="analysis-optional"><summary>更多描述：画面、动作、构图与场景</summary><p className="muted">这几项只写进拉片报告，不参与后续检测、相机、动作与导出。想快就跳过。</p><div className="analysis-editor-grid">{DETAIL_FIELDS.map(fieldInput)}<label>不确定项（每行一项）<textarea rows={3} value={(value.uncertainties||[]).join('\n')} disabled={!!busy||readOnly} onChange={event=>edit({uncertainties:event.target.value.split('\n')})}/></label></div></details>
      </details>
      <details className="analysis-generated"><summary>查看模型原始结果{Object.keys(shot.overrides).length?'（有人工覆盖）':''}</summary>{shot.generated?<dl>{TEXT_FIELDS.map(([field,label])=><div key={field}><dt>{label}</dt><dd>{shot.generated?.[field]||'未提供'}</dd></div>)}<div><dt>主体引用</dt><dd>{shot.generated.subjects.join('、')||'无'}</dd></div><div><dt>证据源帧</dt><dd>{shot.generated.evidenceFrames.join('、')}</dd></div><div><dt>不确定项</dt><dd>{shot.generated.uncertainties?.join('；')||'无记录'}</dd></div></dl>:<p className="muted">此镜尚未获得模型语义结果。</p>}{shot.generated&&<details><summary>完整原始语义数据</summary><pre>{JSON.stringify(shot.generated,null,2)}</pre></details>}</details>
    </section>}
    {run&&<>
      <details className="analysis-catalog"><summary>全片人物分析依据</summary><div className="analysis-subjects">{(['person','animal','unknown'] as const).map(kind=>{const subjects=run.subjects.filter(subject=>subject.kind===kind);return <section key={kind}><h3>{kind==='person'?'人物候选':kind==='animal'?'动物候选':'类型待定'} <span>{subjects.length}</span></h3>{subjects.length?subjects.map(subject=><article key={subject.id}><b>{subject.id} · {subject.name||'未命名'}{subject.uncertain&&' · 待核对'}</b><p>{subject.description}</p>{subject.species&&<small>物种：{subject.species}</small>}{!!subject.referenceFrames?.length&&<div>{subject.referenceFrames.map(frame=><button key={frame} disabled={ptsUs[frame]===undefined} onClick={()=>seek(ptsUs[frame])}>证据帧 {frame}</button>)}</div>}</article>):<p className="muted">{run.counts.analyzed?'未列出此类候选，不代表已确认全片为零。':'等待视觉分析结果。'}</p>}</section>;})}</div></details>
      <details className="analysis-issues"><summary>查看分析中的不确定内容（{issues.length} 条）</summary>{issues.length?<ul>{issues.map((issue,index)=><li key={`${issue.code}:${issue.shotId||''}:${index}`} className={`issue-${issue.severity}`}>{issue.shotId&&<button onClick={()=>{const target=run.shots.find(item=>item.id===issue.shotId);if(target)choose(target);}}>{run.shots.findIndex(item=>item.id===issue.shotId)>=0?`第 ${run.shots.findIndex(item=>item.id===issue.shotId)+1} 镜`:issue.shotId}</button>}<span>{issue.message}{issue.field&&<small> · {issue.field}</small>}</span></li>)}</ul>:<p className="muted">{run.status==='processing'?'全片扫描仍在进行，问题会陆续汇总。':run.counts.analyzed===0?'尚无可审查的语义结果。':'当前没有记录待修正项；视觉准确性仍需结合原片核对。'}</p>}</details>
      <details className="analysis-guide"><summary>修正说明</summary><ol><li><b>切点</b> — 唯一影响后续检测与交付的修改。改完点顶部「采用此候选版本」；采用后人物检测、相机、动作需要重跑。</li><li><b>本镜人物出场</b> — 不影响计算，作为你手工归并角色时的参考。</li><li><b>景别 / 类别 / 运镜</b> — 快速扫一遍改错的即可。</li><li><b>报告补充（可选）</b> — 画面描述、动作等文字只写进拉片报告，想快就整段跳过。</li></ol><p className="muted">改完每镜记得点「保存本镜修正」。页面最下方「集中待修正项」只列系统判定的问题，模型给错的结果不会出现在那里，需要你自己扫镜头列表。</p></details>
      <p className="muted analysis-provenance">运行 {run.id} · 更新于 {new Date(run.updatedAt).toLocaleString('zh-CN')} · 源片 {run.mediaHash?.slice(0,12)} · 切镜版本 {run.shotSetHash?.slice(0,12)}</p>
    </>}
  </section>;
}
