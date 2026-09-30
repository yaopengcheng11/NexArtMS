import React, {useEffect, useRef, useState} from 'react';
import type {ProjectDetail} from './studio';
import {suspendProjectMedia} from './studio-project-media';
import {StudioShotStrip} from './StudioShotStrip';
import {StudioDialog} from './StudioPrimitives';

export interface PersonInfo {
  id:string;name:string;subject:'person'|'animal';species:string|null;method:string;reviewed:boolean;
  description?:string;
  trackIds:string[];shotIds:string[];
  representativeTrackId:string|null;assignment:string;
  appearances:{trackId:string;shotId:string;startFrame:number;endFrame:number}[];
}

export function personDescription(detail:Pick<ProjectDetail,'shotAnalysis'>, person:PersonInfo):string {
  if(person.description?.trim())return person.description.trim();
  if(person.method!=='semantic-v1')return '';
  const subjects=(detail.shotAnalysis?.subjects||[]).filter(subject=>subject.kind===(person.subject||'person'));
  const subject=subjects.find(subject=>`person-${subject.id.toLowerCase().replace(/[^a-z0-9]/g,'')}`===person.id);
  if(subject)return subject.description||'';
  const sameName=subjects.filter(subject=>subject.name===person.name);
  return sameName.length===1?sameName[0].description||'':'';
}

export function personMatchesQuery(detail:Pick<ProjectDetail,'shotAnalysis'>, person:PersonInfo, query:string):boolean {
  const text=[person.name,personDescription(detail,person),person.species||''].join(' ').toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/).every(word=>text.includes(word));
}

export function appearanceStartUs(detail:Pick<ProjectDetail,'tracks'>, person:PersonInfo, shotId:string, fallback:number):number {
  const ids=new Set(person.appearances.filter(appearance=>appearance.shotId===shotId).map(appearance=>appearance.trackId));
  const starts=detail.tracks.filter(track=>ids.has(track.id)&&Number.isFinite(track.startUs)).map(track=>track.startUs);
  return starts.length?Math.min(...starts):fallback;
}

export function identityReviewState(detail:Pick<ProjectDetail,'people'|'tracks'|'bindings'>, subject:'person'|'animal', selectedTrackIds:string[]=[]) {
  const people=detail.people.filter(person=>person.method!=='legacy'&&person.assignment!=='ignored'&&(person.subject||'person')==='person');
  const animals=detail.people.filter(person=>person.subject==='animal'&&person.assignment!=='ignored');
  const entities=[...people,...animals];
  const knownTrackIds=new Set(entities.flatMap(person=>person.trackIds));
  const ignoredTrackIds=new Set([...detail.bindings.filter(binding=>binding.disposition==='ignored').map(binding=>binding.trackId),
    ...detail.people.filter(person=>person.assignment==='ignored').flatMap(person=>person.trackIds)]);
  const unresolved=detail.tracks.filter(track=>track.status==='active'&&!knownTrackIds.has(track.id)&&!ignoredTrackIds.has(track.id));
  const queue=unresolved.filter(track=>(track.subject||'person')===subject);
  const species=new Set(queue.filter(track=>selectedTrackIds.includes(track.id)).map(track=>track.species||'未知动物'));
  const targets=entities.filter(person=>person.subject===subject&&(subject!=='animal'||!species.size||(species.size===1&&species.has(person.species||'未知动物'))));
  return {people,animals,entities,unresolved,queue,targets};
}

async function mutate(url:string, body:unknown, method='PATCH') {
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'操作失败');
  return result;
}

type SettingsDraft={name:string;note:string;sceneMode:ProjectDetail['project']['sceneMode']};
const settingsDrafts=new Map<string,SettingsDraft>();
export function discardProjectSettingsDraft(projectId:string){settingsDrafts.delete(projectId);}

export function ProjectSettings({detail,onClose,onChanged,onDeleted,show,onDraftCountChange}:{detail:ProjectDetail;onClose:()=>void;onChanged:()=>void;onDeleted:()=>void;show:(s:string)=>void;onDraftCountChange?:(count:number)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const[name,setName]=useState(()=>settingsDrafts.get(detail.project.id)?.name??detail.project.name);
  const[note,setNote]=useState(()=>settingsDrafts.get(detail.project.id)?.note??detail.project.note);
  const[sceneMode,setSceneMode]=useState(()=>settingsDrafts.get(detail.project.id)?.sceneMode??detail.project.sceneMode);
  const[confirmName,setConfirmName]=useState('');
  const[busy,setBusy]=useState(false);
  const[deletePhase,setDeletePhase]=useState<'releasing'|'deleting'|null>(null);
  const pending=useRef(false);
  const saved=useRef(false);
  const[error,setError]=useState('');
  useEffect(()=>{const element=dialog.current;const returnTo=document.activeElement as HTMLElement|null;element?.showModal();return()=>{element?.close();if(returnTo?.isConnected)returnTo.focus();};},[]);
  useEffect(()=>{
    if(saved.current)return;
    if(name!==detail.project.name||note!==detail.project.note||sceneMode!==detail.project.sceneMode)settingsDrafts.set(detail.project.id,{name,note,sceneMode});
    else settingsDrafts.delete(detail.project.id);
  },[detail.project.id,detail.project.name,detail.project.note,detail.project.sceneMode,name,note,sceneMode]);
  const active=detail.jobs.some(job=>job.state==='queued'||job.state==='running');
  const dirty=name!==detail.project.name||note!==detail.project.note||sceneMode!==detail.project.sceneMode;
  useEffect(()=>{onDraftCountChange?.(saved.current?0:dirty?1:0);},[dirty,name,note,sceneMode,onDraftCountChange]);
  const save=async()=>{if(pending.current)return;pending.current=true;setBusy(true);setError('');try {
    await mutate(`/api/studio/projects/${detail.project.id}`,{name,note,sceneMode,baseRevision:detail.project.revision});
    saved.current=true;
    settingsDrafts.delete(detail.project.id);
    onDraftCountChange?.(0);
    onChanged();onClose();show('项目设置已保存。');
  }catch(e){setError((e as Error).message);}finally{pending.current=false;setBusy(false);}};
  const remove=async()=>{
    if(pending.current)return;
    pending.current=true;setBusy(true);setDeletePhase('releasing');setError('');
    const previews=suspendProjectMedia(document,detail.project.id);
    try {
    // Give the browser a turn to abort its media requests before DELETE reaches the server.
    await new Promise<void>(resolve=>window.setTimeout(resolve,0));
    setDeletePhase('deleting');
    const result=await mutate(`/api/studio/projects/${detail.project.id}`,{baseRevision:detail.project.revision,confirmName},'DELETE');
    if(result.cleanupPending)window.alert(result.message);
    previews.discard();
    saved.current=true;
    settingsDrafts.delete(detail.project.id);
    onDraftCountChange?.(0);
    onDeleted();
  }catch(e){previews.restore();setError((e as Error).message);}finally{pending.current=false;setBusy(false);setDeletePhase(null);}};
  return <dialog ref={dialog} className="studio-settings" aria-labelledby="settings-title" onCancel={event=>{if(busy||pending.current)event.preventDefault();else onClose();}}>
    <div className="panel-title"><h2 id="settings-title">项目设置</h2><button onClick={onClose} disabled={busy} aria-label="关闭项目设置">关闭</button></div>
    <label>项目名称<input aria-label="修改项目名称" value={name} maxLength={80} disabled={busy} onChange={e=>{saved.current=false;setName(e.target.value);}}/></label>
    <label>项目说明<textarea aria-label="项目说明" value={note} maxLength={400} rows={3} disabled={busy} onChange={e=>{saved.current=false;setNote(e.target.value);}}/></label>
    <details className="people-settings-scene"><summary>三维场景设置</summary>
      <label>场景选项<select aria-label="项目场景选项" value={sceneMode} disabled={busy} onChange={e=>{saved.current=false;setSceneMode(e.target.value as typeof sceneMode);}}>
        <option value="proxy">内置舞台 · 近似还原</option><option value="reconstruct" disabled>从视频生成真实场景 · 尚不可用</option>
      </select></label>
      <p className="muted">当前使用内置舞台呈现人物和相机的近似位置。{sceneMode==='reconstruct'?'这个旧项目选择了尚不可用的场景模式，可改回内置舞台。':''}更改模式会使已有正式确认失效；相机和动作数据会保留。</p>
    </details>
    {dirty&&<p role="status" className="people-draft-state">设置尚未保存；关闭后重新打开会保留草稿。</p>}
    <div className="studio-toolbar"><button className="primary" onClick={save} disabled={busy||!name.trim()||!dirty}>保存项目设置</button><button disabled={busy||!dirty} onClick={()=>{saved.current=true;setName(detail.project.name);setNote(detail.project.note);setSceneMode(detail.project.sceneMode);settingsDrafts.delete(detail.project.id);onDraftCountChange?.(0);}}>撤回设置草稿</button></div>
    <details className="studio-delete-zone"><summary>删除项目</summary>
      <p>删除“{detail.project.name}”的本地素材、人物标记、动作及导出文件。此操作无法在界面撤销。</p>
      {active&&<p>还有任务进行中，请等待结束或取消完成后再删除。</p>}
      <label>输入完整项目名称确认<input aria-label="输入项目名称确认删除" value={confirmName} onChange={e=>setConfirmName(e.target.value)} placeholder={detail.project.name}/></label>
      <button className="danger" disabled={busy||active||confirmName!==detail.project.name} onClick={remove}>{deletePhase==='releasing'?'正在释放预览…':deletePhase==='deleting'?'正在删除项目…':'永久删除项目'}</button>
    </details>
    {error&&<p className="studio-job-error" role="alert">{error}</p>}
  </dialog>;
}

export function PeopleSection({detail,onChanged,show,selectShot,selectedShotId,onSeekAppearance,onOpenAppearance,onDraftCountChange,onOpenTrackTools,active=true}:{
  detail:ProjectDetail;onChanged:()=>void;show:(s:string)=>void;selectShot:(id:string)=>void;selectedShotId?:string;
  onSeekAppearance?:(shotId:string,timeUs:number)=>void;
  onOpenAppearance?:(shotId:string,timeUs:number,workspace:'analysis'|'reconstruction')=>void;
  onDraftCountChange?:(count:number)=>void;
  onOpenTrackTools?:()=>void;
  active?:boolean;
}) {
  const[selected,setSelected]=useState<string[]>([]);
  const[openPersonId,setOpenPersonId]=useState<string|null>(null);
  const[openShotId,setOpenShotId]=useState('');
  const[query,setQuery]=useState('');
  const[viewSubject,setViewSubject]=useState<'person'|'animal'>('person');
  const[editor,setEditor]=useState<'person'|'tools'|'queue'|null>(null);
  const[narrow,setNarrow]=useState(()=>typeof window!=='undefined'&&window.matchMedia('(max-width: 768px)').matches);
  const[queueScope,setQueueScope]=useState(false);
  const[queueSubject,setQueueSubject]=useState<'person'|'animal'>('person');
  const[queueShot,setQueueShot]=useState('');
  const[trackSelections,setTrackSelections]=useState<Record<string,string[]>>({});
  const[targetPerson,setTargetPerson]=useState('');
  const[assignment,setAssignment]=useState('');
  const[nameDrafts,setNameDrafts]=useState<Record<string,string>>({});
  const[count,setCount]=useState(detail.project.sourcePeopleCount?.toString()||'');
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const pending=useRef(false);
  const editButton=useRef<HTMLButtonElement>(null);
  const queueEditButton=useRef<HTMLButtonElement>(null);
  const toolsButton=useRef<HTMLButtonElement>(null);
  const returnFocus=useRef<HTMLElement|null>(null);
  const restoreFocus=useRef(false);
  const nameInput=useRef<HTMLInputElement>(null);
  const queueOpen=queueScope;
  // Legacy tracklets remain evidence in the review queue, never identity cards.
  const baseState=identityReviewState(detail,queueSubject);
  const {people,animals,entities,unresolved,queue}=baseState;
  const visibleEntities=(viewSubject==='person'?people:animals).filter(person=>personMatchesQuery(detail,person,query));
  // Filtering directory cards does not clear an already chosen person or its drafts.
  const openPerson=entities.find(person=>person.id===openPersonId);
  const personShots=detail.shots.filter(shot=>openPerson?.shotIds.includes(shot.id));
  const queueShots=detail.shots.filter(shot=>queue.some(track=>track.shotId===shot.id));
  const activeShotId=selectedShotId??openShotId;
  const shot=personShots.find(shot=>shot.id===activeShotId);
  const currentQueueShot=queueShots.find(shot=>shot.id===(selectedShotId??queueShot));
  const selectionKey=queueOpen?`queue:${queueSubject}:${currentQueueShot?.id||''}`:`${openPerson?.id||''}:${shot?.id||''}`;
  const selectedTracks=trackSelections[selectionKey]||[];
  const {targets}=identityReviewState(detail,queueSubject,selectedTracks);
  const chosenTarget=targets.some(person=>person.id===targetPerson)?targetPerson:targets[0]?.id||'';
  const shortChoice=(text:string,limit:number)=>Array.from(text).length>limit?`${Array.from(text).slice(0,limit).join('')}…`:text;
  const personChoiceLabel=(person:PersonInfo)=>{
    if(!entities.some(other=>other.id!==person.id&&other.name===person.name))return person.name;
    const description=shortChoice(personDescription(detail,person),10);
    const repeatedDescription=entities.some(other=>other.id!==person.id&&other.name===person.name&&shortChoice(personDescription(detail,other),10)===description);
    const qualifier=description&&!repeatedDescription?description:`${person.subject==='animal'?'动物':'人物'} ${entities.findIndex(other=>other.id===person.id)+1}`;
    return `${shortChoice(person.name,14)} · ${qualifier}`;
  };
  const characterChoiceLabel=(character:ProjectDetail['characters'][number],index:number)=>detail.characters.some(other=>other.id!==character.id&&other.name===character.name)?`${shortChoice(character.name,14)} · 角色 ${index+1}`:character.name;
  const appearances=openPerson?.appearances.filter(appearance=>appearance.shotId===shot?.id)||[];
  const queuedTracks=queue.filter(track=>track.shotId===currentQueueShot?.id);
  const selectedAnimals=selected.some(id=>animals.some(animal=>animal.id===id));
  const suggestions=(detail.identitySuggestions||[]).filter(suggestion=>entities.some(person=>person.id===suggestion.a&&person.subject===viewSubject)&&entities.some(person=>person.id===suggestion.b&&person.subject===viewSubject));
  const unresolvedCount=unresolved.filter(track=>(track.subject||'person')===viewSubject).length;
  const nameValue=openPerson?(nameDrafts[openPerson.id]??openPerson.name):'';
  const dirtyNames=entities.filter(person=>nameDrafts[person.id]!==undefined&&nameDrafts[person.id]!==person.name).length;
  const countDirty=count!==(detail.project.sourcePeopleCount?.toString()||'');
  const draftCount=dirtyNames+(countDirty?1:0)+(selected.length>0&&assignment?1:0);
  const updateTrackSelection=(ids:string[])=>setTrackSelections(previous=>({...previous,[selectionKey]:ids}));
  const toggleTrack=(id:string)=>updateTrackSelection(selectedTracks.includes(id)?selectedTracks.filter(value=>value!==id):[...selectedTracks,id]);
  const toggleEntity=(person:PersonInfo)=>{setAssignment('');setSelected(ids=>ids.includes(person.id)?ids.filter(id=>id!==person.id):[...ids.filter(id=>entities.some(other=>other.id===id&&other.subject===person.subject)),person.id]);};
  useEffect(()=>{setSelected(ids=>ids.filter(id=>detail.people.some(person=>person.id===id)));},[detail.people]);
  useEffect(()=>{const media=window.matchMedia('(max-width: 768px)');const changed=()=>setNarrow(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  useEffect(()=>{if(!active){restoreFocus.current=false;setEditor(null);}},[active]);
  useEffect(()=>{onDraftCountChange?.(draftCount);},[draftCount,onDraftCountChange]);
  useEffect(()=>{
    if(editor==='person')nameInput.current?.focus();
    else if(editor===null&&restoreFocus.current){
      restoreFocus.current=false;
      const previous=returnFocus.current;
      if(previous?.isConnected&&previous.getClientRects().length)previous.focus();else (editButton.current||queueEditButton.current||toolsButton.current)?.focus();
    }
  },[editor,openPersonId,narrow]);
  const openEditor=(mode:'person'|'tools'|'queue')=>{returnFocus.current=document.activeElement as HTMLElement|null;if(mode!=='queue')setQueueScope(false);setEditor(mode);};
  const act=async(action:string,ids=selected,extra:Record<string,unknown>={})=>{
    if(pending.current)return false;
    pending.current=true;setBusy(true);setError('');
    try {
      await mutate(`/api/studio/projects/${detail.project.id}/people`,{baseRevision:detail.project.revision,action,personIds:ids,...extra});
      setSelected([]);setAssignment('');updateTrackSelection([]);onChanged();return true;
    }catch(e){const message=(e as Error).message;setError(message);show(message);return false;}
    finally{pending.current=false;setBusy(false);}
  };
  const saveName=async()=>{
    if(!openPerson||nameValue===openPerson.name)return;
    const id=openPerson.id;
    if(await act('rename',[id],{name:nameValue})){
      setNameDrafts(previous=>{const next={...previous};delete next[id];return next;});
      restoreFocus.current=true;setEditor(null);show('人物名称已保存。');
    }
  };
  const summarize=async()=>{
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try {
      const expected=count.trim()?Number(count):null;
      if(expected!==null&&(!Number.isInteger(expected)||expected<1||expected>30))throw new Error('角色数请输入 1–30 的整数');
      if(expected!==detail.project.sourcePeopleCount)await mutate(`/api/studio/projects/${detail.project.id}`,{sourcePeopleCount:expected,baseRevision:detail.project.revision});
      await mutate(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'people'},'POST');onChanged();
      show('正在整理角色及出场镜头，无法确定归属的片段会进入待核对出场。');
    }catch(e){const message=(e as Error).message;setError(message);show(message);}
    finally{pending.current=false;setBusy(false);}
  };
  const preview=(id:string)=>`/api/studio/projects/${detail.project.id}/tracks/${id}/preview?v=3`;
  const analysing=detail.jobs.some(job=>['people','detect'].includes(job.kind)&&['queued','running'].includes(job.state));
  const activeJobs=detail.jobs.some(job=>['queued','running'].includes(job.state));
  const canDetect=!busy&&!activeJobs&&!!detail.media&&detail.shots.length>0&&detail.detectorAvailable;
  const detect=async()=>{
    if(!canDetect||pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try {
      await mutate(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'detect',subjects:viewSubject,continueReconstruction:true},'POST');
      onChanged();show(`已提交${viewSubject==='person'?'人物':'动物'}出场检测，完成后继续整理出场并更新三维初稿。`);
    }catch(e){const message=(e as Error).message;setError(message);show(message);}
    finally{pending.current=false;setBusy(false);}
  };
  const openAppearance=(shotId:string,timeUs:number,workspace:'analysis'|'reconstruction')=>{
    selectShot(shotId);
    if(onOpenAppearance)onOpenAppearance(shotId,timeUs,workspace);
    else document.getElementById(workspace==='analysis'?'studio-cuts':'studio-playback')?.scrollIntoView({behavior:'smooth'});
  };
  const seek=(id:string)=>{
    const current=detail.shots.find(shot=>shot.id===id);if(!current)return;
    setOpenShotId(id);setQueueShot(id);
    const queueStarts=queue.filter(track=>track.shotId===id&&Number.isFinite(track.startUs)).map(track=>track.startUs);
    const timeUs=queueOpen?(queueStarts.length?Math.min(...queueStarts):current.startUs):openPerson?appearanceStartUs(detail,openPerson,id,current.startUs):current.startUs;
    if(onSeekAppearance)onSeekAppearance(id,timeUs);else selectShot(id);
  };
  const clearScope=()=>{restoreFocus.current=editor!==null;setQueueScope(false);setOpenPersonId(null);setEditor(null);};
  const changeSubject=()=>{setViewSubject(value=>value==='person'?'animal':'person');setQuery('');setQueueScope(false);setOpenPersonId(null);setEditor(null);};
  const closeEditor=()=>{restoreFocus.current=true;setEditor(null);};
  const stripShots=queueOpen?queueShots:openPerson?personShots:detail.shots;
  const stripItems=stripShots.map(shot=>({
    id:shot.id,index:shot.idx,startUs:shot.startUs,endUs:shot.endUs,
    thumbnail:`/api/studio/projects/${detail.project.id}/shots/${shot.id}/preview`,
    description:openPerson?`${openPerson.name}的出场`:queueOpen?'待核对出场':undefined,
    meta:openPerson?`${(appearanceStartUs(detail,openPerson,shot.id,shot.startUs)/1e6).toFixed(2)} 秒起`:undefined,
  }));
  const editorPanel=editor&&<aside className="workspace-editor people-editor" aria-busy={busy} aria-label={editor==='person'?'人物修正':editor==='queue'?'未归属出场修正':'人物工具'} onKeyDown={event=>{if(event.key==='Escape'&&!busy&&!narrow){event.stopPropagation();closeEditor();}}}>
        {!narrow&&<div className="panel-title"><h3>{editor==='person'?'修正人物':editor==='queue'?'核对未归属':'人物工具'}</h3><button aria-label="收起人物修正" onClick={closeEditor} disabled={busy}>收起</button></div>}
        {error&&<p className="studio-job-error" role="alert">{error}</p>}
        {editor==='person'&&openPerson&&<>
          <label className="people-editor-field">名称<input ref={nameInput} aria-label="人物名称" value={nameValue} maxLength={80} onChange={event=>setNameDrafts(previous=>({...previous,[openPerson.id]:event.target.value}))}/></label>
          {nameValue!==openPerson.name&&<p role="status" className="people-draft-state">名称尚未保存</p>}
          <div className="people-editor-submit"><button className="primary" disabled={busy||!nameValue.trim()||nameValue===openPerson.name} onClick={()=>void saveName()}>{busy?'保存中…':'保存名称'}</button><button disabled={busy||nameValue===openPerson.name} onClick={()=>setNameDrafts(previous=>{const next={...previous};delete next[openPerson.id];return next;})}>撤回名称草稿</button></div>
          <details className="people-advanced-tools"><summary>更多出场工具</summary>
            {shot&&<div className="studio-toolbar"><button onClick={()=>openAppearance(shot.id,appearanceStartUs(detail,openPerson,shot.id,shot.startUs),'analysis')}>在拉片查看本次出场</button><button onClick={()=>openAppearance(shot.id,appearanceStartUs(detail,openPerson,shot.id,shot.startUs),'reconstruction')}>在三维还原查看本次出场</button></div>}
            <div className="studio-toolbar">{!openPerson.reviewed&&<button disabled={busy} onClick={()=>void act('review',[openPerson.id])}>确认出场属于同一个体</button>}<button disabled={busy} onClick={()=>void act('assign',[openPerson.id],{assignment:'ignored'})}>忽略此{openPerson.subject==='animal'?'动物':'人物'}</button></div>
            <p className="muted">点选底部镜头条，再选择需修正的出场片段。</p>
            {shot?<div className="people-shot-correction"><h4>{shot.id} 的出场</h4><div className="studio-evidence-grid">{appearances.map(appearance=><label key={appearance.trackId}><input type="checkbox" aria-label={`选择出场${appearance.trackId}`} checked={selectedTracks.includes(appearance.trackId)} onChange={()=>toggleTrack(appearance.trackId)}/><img src={preview(appearance.trackId)} alt={`${shot.id} 帧 ${appearance.startFrame}`} loading="lazy"/><span>帧 {appearance.startFrame}–{appearance.endFrame}</span></label>)}</div><div className="studio-toolbar"><button disabled={busy||!selectedTracks.length} onClick={()=>void act('release-appearances',[openPerson.id],{trackIds:selectedTracks})}>移回未归属出场</button><button disabled={busy||!selectedTracks.length} onClick={()=>void act('split',[openPerson.id],{trackIds:selectedTracks})}>拆为另一个体</button></div></div>:<><p className="muted">请先从镜头条选择此人的出场镜头。</p>{narrow&&<button onClick={closeEditor}>收起并选择镜头</button>}</>}
          </details>
        </>}
        {editor==='tools'&&<>
          <p className="muted">在人物卡片勾选要处理的角色；人工核对不影响观看。</p>
          {narrow&&<div className="people-bulk-picker" aria-label="选择批量处理的角色">{visibleEntities.map(person=><label key={person.id}><input type="checkbox" checked={selected.includes(person.id)} onChange={()=>toggleEntity(person)}/><span>{person.name}<small>{personDescription(detail,person)||person.id}</small></span></label>)}</div>}
          {onOpenTrackTools&&<button disabled={!selectedShotId} onClick={()=>{closeEditor();onOpenTrackTools();}}>补标与修正本镜出场</button>}
          {suggestions.length>0&&<details className="people-advanced-tools"><summary>外观接近 · {suggestions.length} 组待核对</summary><div className="studio-suggest-list">{suggestions.slice(0,5).map(suggestion=><span key={suggestion.a+suggestion.b}>{suggestion.aName} ↔ {suggestion.bName}<button onClick={()=>{setSelected([suggestion.a,suggestion.b]);setAssignment('');}}>选择这两位</button></span>)}</div><p className="muted">外观相似不代表同一个体，请查看出场后再决定。</p></details>}
          {selected.length>0&&<div className="people-bulk-tools"><p>已选 {selected.length} 个角色</p><label className="people-editor-field">分组或忽略<select aria-label="用于三维的角色" value={assignment} onChange={event=>setAssignment(event.target.value)}><option value="">选择处理方式</option>{!selectedAnimals&&detail.characters.map((character,index)=><option key={character.id} value={character.id} title={character.name}>{characterChoiceLabel(character,index)}</option>)}<option value="ignored">忽略所选角色</option><option value="unassigned">撤销分组</option></select></label><div className="studio-toolbar"><button className="primary" disabled={busy||!assignment} onClick={()=>void act('assign',selected,{assignment})}>应用分组</button><button disabled={busy||selected.length<2} onClick={()=>void act('merge')}>合并为同一个体</button><button disabled={busy} onClick={()=>{setSelected([]);setAssignment('');}}>取消选择</button></div></div>}
          <details className="studio-role-setup people-advanced-tools"><summary>{viewSubject==='person'?'人数或结果不对？':'动物结果不对？'}</summary>
            {viewSubject==='person'&&<><label className="people-editor-field">片中人数<input aria-label="片中角色数" type="number" min="1" max="30" placeholder="未知可留空" value={count} onChange={event=>setCount(event.target.value)}/></label><div className="studio-toolbar"><button disabled={busy||activeJobs||!detail.tracks.some(track=>track.status==='active')} onClick={()=>void summarize()}>{analysing?'正在整理…':'重新整理出场'}</button>{countDirty&&<button disabled={busy} onClick={()=>setCount(detail.project.sourcePeopleCount?.toString()||'')}>撤回人数草稿</button>}</div><p className="muted">只重新归组已有出场，不重新检测画面。</p></>}
            <div className="studio-toolbar"><button disabled={!canDetect} onClick={()=>void detect()}>重新检测{viewSubject==='person'?'人物':'动物'}出场</button>{viewSubject==='person'&&!animals.length&&<button disabled={busy} onClick={changeSubject}>查找动物出场</button>}</div>
            <p className="muted">切点采用后或漏检时可重新检测；成功后继续整理并更新三维初稿。已有人工决定受保护，重新检测可能被拒绝，请按反馈修正具体出场。</p>
            {!detail.detectorAvailable?<p className="people-state" role="status">检测模型尚未加载，已有结果仍可查看。</p>:!detail.media?<p className="people-state" role="status">请先导入视频。</p>:!detail.shots.length?<p className="people-state" role="status">请先完成视频切镜。</p>:activeJobs?<p className="people-state" role="status">还有任务在处理，请等待完成。</p>:null}
          </details>
        </>}
        {editor==='queue'&&<>
          <label className="people-editor-field">主体类别<select aria-label="待核对主体类别" value={queueSubject} onChange={event=>setQueueSubject(event.target.value as 'person'|'animal')}><option value="person">人物出场</option><option value="animal">动物出场</option></select></label>
          {!queue.length?<p className="muted">该类别没有待核对出场。</p>:!currentQueueShot?<><p className="muted">请从底部镜头条选择待核对镜头。</p>{narrow&&<button onClick={closeEditor}>收起并选择镜头</button>}</>:<>
            <h4>{currentQueueShot.id} · {queuedTracks.length} 段</h4>
            <button disabled={busy} onClick={()=>updateTrackSelection(queuedTracks.map(track=>track.id))}>选择本镜头出场</button>
            <div className="studio-evidence-grid">{queuedTracks.map(track=><label key={track.id}><input aria-label={`选择出场${track.id}`} type="checkbox" checked={selectedTracks.includes(track.id)} onChange={()=>toggleTrack(track.id)}/><img src={preview(track.id)} alt={`${track.shotId} 待核对出场`} loading="lazy"/><span>帧 {track.startFrame}–{track.endFrame}</span></label>)}</div>
            <label className="people-editor-field">归入素材角色<select aria-label="归入素材角色" value={chosenTarget} onChange={event=>setTargetPerson(event.target.value)}>{targets.map(person=><option key={person.id} value={person.id} title={`${person.name} · ${personDescription(detail,person)}`}>{personChoiceLabel(person)}</option>)}</select></label>
            {selectedTracks.length>0&&!targets.length&&<p className="people-state">没有同类别、同物种的目标身份，请分别选择同物种出场。</p>}
            <button className="primary" disabled={busy||!selectedTracks.length||!chosenTarget} onClick={()=>void act('assign-appearances',[chosenTarget],{trackIds:selectedTracks})}>归入该角色</button>
          </>}
        </>}
      </aside>;
  return <section className="studio-card people-workspace" id="studio-people">
    <div className="panel-title people-directory-title"><div><h2>{viewSubject==='person'?'人物':'动物'}</h2><span>{viewSubject==='person'?`${people.length} 位人物`:`${animals.length} 个动物候选`}</span></div>
      <button ref={toolsButton} aria-expanded={editor==='tools'} onClick={()=>editor==='tools'?closeEditor():openEditor('tools')}>更多{viewSubject==='person'?'人物':'动物'}工具</button>
    </div>
    <div className="people-search-row">
      <label className="people-search"><span className="people-search-label">片内筛选</span><input type="search" aria-label="按名字或已有描述筛选人物" placeholder="搜索名字或已有描述" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {(animals.length>0||viewSubject==='animal')&&<button className="people-subject-switch" onClick={changeSubject}>{viewSubject==='person'?`动物 · ${animals.length}`:'返回人物'}</button>}
      {unresolvedCount>0&&<button className="people-unassigned" aria-pressed={queueOpen} onClick={()=>{setQueueSubject(viewSubject);setOpenPersonId(null);setEditor(null);setQueueScope(value=>!value);}}>未归属 · {unresolvedCount} 段</button>}
    </div>
    {analysing&&<p role="status" className="people-state">正在整理{viewSubject==='person'?'人物':'动物'}出场，完成后自动刷新。</p>}
    {draftCount>0&&<p role="status" className="people-draft-state">有 {draftCount} 项未保存的修改；关闭面板或切换人物会保留草稿。</p>}
    {error&&!editor&&<p className="studio-job-error" role="alert">{error}</p>}
    <div className={`people-layout ${editor&&!narrow?'has-editor':''}`}>
      <div className="people-main">
        {!!query.trim()&&<p className="people-filter-count" role="status">找到 {visibleEntities.length} {viewSubject==='person'?'位人物':'个动物候选'}</p>}
        <div className="studio-role-grid">{visibleEntities.map(person=>{
          const description=personDescription(detail,person);
          const duplicate=entities.filter(other=>other.name===person.name).length>1;
          const identityLabel=duplicate?`${person.name} · ${description||person.id}`:person.name;
          return <article className={`studio-role-card ${openPersonId===person.id?'opened':''}`} key={person.id}>
            {editor==='tools'&&!narrow&&<label className="studio-role-select"><input type="checkbox" aria-label={`选择${identityLabel}`} checked={selected.includes(person.id)} onChange={()=>toggleEntity(person)}/><span>选择</span></label>}
            <button className="studio-role-open" aria-label={`查看${identityLabel}的镜头`} title={person.name} aria-pressed={openPersonId===person.id} onClick={()=>{setQueueScope(false);setOpenPersonId(current=>current===person.id?null:person.id);if(editor!=='tools')setEditor(null);}}>
              {person.representativeTrackId?<img src={preview(person.representativeTrackId)} alt={person.name} loading="lazy"/>:<div className="studio-role-placeholder">暂无参考画面</div>}
              <div><b title={person.name}>{person.name}</b>{description&&<p className="people-description">{description}</p>}<span>{person.shotIds.length} 个镜头</span></div>
            </button>
            <small className={`people-identity-status ${person.reviewed?'reviewed':''}`}>{person.subject==='animal'&&`${person.species||'动物'} · `}{person.reviewed?'已核对':'暂定匹配'}{nameDrafts[person.id]!==undefined&&nameDrafts[person.id]!==person.name?' · 未保存':''}</small>
          </article>;
        })}</div>
        {!visibleEntities.length&&!analysing&&<div className="people-empty"><p>{query.trim()?'没有匹配的结果，试试更短的名字或描述。':viewSubject==='person'?'人物出场尚未生成。':'暂无动物出场。'}</p>{query.trim()&&<button onClick={()=>setQuery('')}>清除搜索</button>}{!query.trim()&&!unresolvedCount&&<small>已有镜头仍可浏览；检测与整理可从“更多{viewSubject==='person'?'人物':'动物'}工具”查看。</small>}</div>}
        {openPerson&&<section className="people-selected-summary" aria-label={`${openPerson.name}的出场摘要`}>
          <div className="people-summary-copy"><h3>{openPerson.name}</h3><p>{personShots.length} 个镜头 · {openPerson.reviewed?'已核对':'自动匹配，待核对'}{openPerson.subject==='animal'?` · ${openPerson.species||'动物'}`:''}</p>{personDescription(detail,openPerson)&&<details className="people-description-detail"><summary>人物描述</summary><p>{personDescription(detail,openPerson)}</p></details>}</div>
          <div className="people-summary-actions"><button onClick={clearScope}>查看全部镜头</button>{editor!=='person'&&<button ref={editButton} onClick={()=>openEditor('person')}>修正</button>}
          </div>
          {shot&&<div className="people-selected-appearance"><span>当前 {shot.id} · {(appearanceStartUs(detail,openPerson,shot.id,shot.startUs)/1e6).toFixed(2)} 秒起</span></div>}
          {!personShots.length&&<p className="muted">还没有确定的出场，可核对未归属片段。</p>}
        </section>}
        {queueOpen&&<div className="people-queue-summary"><p>镜头条已筛为未归属{queueSubject==='person'?'人物':'动物'}；点选镜头后修正出场。</p><button onClick={clearScope}>查看全部镜头</button>{editor!=='queue'&&<button ref={queueEditButton} onClick={()=>openEditor('queue')}>修正未归属出场</button>}</div>}
      </div>
      {editor&&!narrow&&editorPanel}
    </div>
    {narrow&&<StudioDialog open={!!editor&&active} title={editor==='person'?'修正人物':editor==='queue'?'核对未归属':'人物工具'} onClose={()=>{if(!busy)closeEditor();}} className="people-editor-dialog">{editorPanel}</StudioDialog>}
    <StudioShotStrip items={stripItems} selectedId={selectedShotId??openShotId} onSelect={item=>seek(item.id)} scopeLabel={queueOpen?`未归属${queueSubject==='person'?'人物':'动物'}`:openPerson?`${openPerson.name}的出场`:'全部镜头'} emptyMessage={queueOpen?'该类别没有待核对镜头。':openPerson?'此人尚无确定的出场镜头。':'还没有镜头。'}/>
  </section>;
}
