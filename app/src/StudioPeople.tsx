import React, {useEffect, useRef, useState} from 'react';
import type {ProjectDetail} from './studio';
import {suspendProjectMedia} from './studio-project-media';

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

export function ProjectSettings({detail,onClose,onChanged,onDeleted,show}:{detail:ProjectDetail;onClose:()=>void;onChanged:()=>void;onDeleted:()=>void;show:(s:string)=>void}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const[name,setName]=useState(detail.project.name);
  const[note,setNote]=useState(detail.project.note);
  const[sceneMode,setSceneMode]=useState(detail.project.sceneMode);
  const[confirmName,setConfirmName]=useState('');
  const[busy,setBusy]=useState(false);
  const[deletePhase,setDeletePhase]=useState<'releasing'|'deleting'|null>(null);
  const pending=useRef(false);
  const[error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  const active=detail.jobs.some(job=>job.state==='queued'||job.state==='running');
  const save=async()=>{setBusy(true);setError('');try {
    await mutate(`/api/studio/projects/${detail.project.id}`,{name,note,sceneMode,baseRevision:detail.project.revision});
    onChanged();onClose();show('项目设置已保存。');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
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
    onDeleted();
  }catch(e){previews.restore();setError((e as Error).message);}finally{pending.current=false;setBusy(false);setDeletePhase(null);}};
  return <dialog ref={dialog} className="studio-settings" aria-labelledby="settings-title" onCancel={event=>{if(busy||pending.current)event.preventDefault();else onClose();}}>
    <div className="panel-title"><h2 id="settings-title">项目设置</h2><button onClick={onClose} disabled={busy} aria-label="关闭项目设置">×</button></div>
    <label>项目名称<input aria-label="修改项目名称" value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
    <label>项目说明<textarea aria-label="项目说明" value={note} maxLength={400} rows={3} onChange={e=>setNote(e.target.value)}/></label>
    <details className="people-settings-scene"><summary>三维场景设置</summary>
      <label>场景选项<select aria-label="项目场景选项" value={sceneMode} onChange={e=>setSceneMode(e.target.value as typeof sceneMode)}>
        <option value="proxy">内置舞台 · 近似还原</option><option value="reconstruct" disabled>从视频生成真实场景 · 尚不可用</option>
      </select></label>
      <p className="muted">当前使用内置舞台呈现人物和相机的近似位置。{sceneMode==='reconstruct'?'这个旧项目选择了尚不可用的场景模式，可改回内置舞台。':''}更改模式会使已有正式确认失效；相机和动作数据会保留。</p>
    </details>
    <button className="primary" onClick={save} disabled={busy||!name.trim()}>保存项目设置</button>
    <section className="studio-delete-zone"><h3>删除项目</h3>
      <p>删除“{detail.project.name}”的本地素材、人物标记、动作及导出文件。此操作无法在界面撤销。</p>
      {active&&<p>还有任务进行中，请等待结束或取消完成后再删除。</p>}
      <label>输入完整项目名称确认<input aria-label="输入项目名称确认删除" value={confirmName} onChange={e=>setConfirmName(e.target.value)} placeholder={detail.project.name}/></label>
      <button className="danger" disabled={busy||active||confirmName!==detail.project.name} onClick={remove}>{deletePhase==='releasing'?'正在释放预览…':deletePhase==='deleting'?'正在删除项目…':'永久删除项目'}</button>
    </section>
    {error&&<p className="studio-job-error" role="alert">{error}</p>}
  </dialog>;
}

export function PeopleSection({detail,onChanged,show,selectShot,onOpenAppearance}:{detail:ProjectDetail;onChanged:()=>void;show:(s:string)=>void;selectShot:(id:string)=>void;onOpenAppearance?:(shotId:string,timeUs:number,workspace:'analysis'|'reconstruction')=>void}) {
  const[selected,setSelected]=useState<string[]>([]);
  const[openPersonId,setOpenPersonId]=useState<string|null>(null);
  const[openShotId,setOpenShotId]=useState('');
  const[query,setQuery]=useState('');
  const[viewSubject,setViewSubject]=useState<'person'|'animal'>('person');
  const[correcting,setCorrecting]=useState(false);
  const[queueOpen,setQueueOpen]=useState(false);
  const[queueShot,setQueueShot]=useState('');
  const[queueSubject,setQueueSubject]=useState<'person'|'animal'>('person');
  const[selectedTracks,setSelectedTracks]=useState<string[]>([]);
  const[targetPerson,setTargetPerson]=useState('');
  const[assignment,setAssignment]=useState('');
  const[count,setCount]=useState(detail.project.sourcePeopleCount?.toString()||'');
  const[busy,setBusy]=useState(false);
  // Legacy tracklets remain evidence in the review queue, never identity cards.
  const {people,animals,entities,unresolved,queue,targets}=identityReviewState(detail,queueSubject,selectedTracks);
  const visibleEntities=(viewSubject==='person'?people:animals).filter(person=>personMatchesQuery(detail,person,query));
  const openPerson=visibleEntities.find(person=>person.id===openPersonId);
  const personShots=detail.shots.filter(shot=>openPerson?.shotIds.includes(shot.id));
  const shot=personShots.find(shot=>shot.id===openShotId)||personShots[0];
  const appearances=openPerson?.appearances.filter(a=>a.shotId===shot?.id)||[];
  const queueShots=detail.shots.filter(s=>queue.some(t=>t.shotId===s.id));
  const currentQueueShot=queueShots.some(s=>s.id===queueShot)?queueShot:queueShots[0]?.id;
  const queuedTracks=queue.filter(t=>t.shotId===currentQueueShot);
  const chosenTarget=targets.some(p=>p.id===targetPerson)?targetPerson:targets[0]?.id||'';
  const selectedAnimals=selected.some(id=>animals.some(animal=>animal.id===id));
  const suggestions=(detail.identitySuggestions||[]).filter(suggestion=>entities.some(person=>person.id===suggestion.a&&person.subject===viewSubject)&&entities.some(person=>person.id===suggestion.b&&person.subject===viewSubject));
  const toggleEntity=(person:PersonInfo)=>{setAssignment('');setSelected(ids=>ids.includes(person.id)?ids.filter(id=>id!==person.id):[...ids.filter(id=>entities.some(other=>other.id===id&&other.subject===person.subject)),person.id]);};
  useEffect(()=>{setSelected(ids=>ids.filter(id=>detail.people.some(person=>person.id===id)));},[detail.people]);
  useEffect(()=>setCount(detail.project.sourcePeopleCount?.toString()||''),[detail.project.sourcePeopleCount]);
  const act=async(action:string,ids=selected,extra:Record<string,unknown>={})=>{setBusy(true);try{
    await mutate(`/api/studio/projects/${detail.project.id}/people`,{baseRevision:detail.project.revision,action,personIds:ids,...extra});
    setSelected([]);setSelectedTracks([]);onChanged();
  }catch(e){show((e as Error).message);}finally{setBusy(false);}};
  const summarize=async()=>{setBusy(true);try{
    const expected=count.trim()?Number(count):null;
    if(expected!==null&&(!Number.isInteger(expected)||expected<1||expected>30))throw new Error('角色数请输入 1–30 的整数');
    if(expected!==detail.project.sourcePeopleCount)await mutate(`/api/studio/projects/${detail.project.id}`,{sourcePeopleCount:expected,baseRevision:detail.project.revision});
    await mutate(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'people'},'POST');onChanged();
    show('正在整理角色及出场镜头，无法确定归属的片段会进入待核对出场。');
  }catch(e){show((e as Error).message);}finally{setBusy(false);}};
  const toggleTrack=(id:string)=>setSelectedTracks(ids=>ids.includes(id)?ids.filter(value=>value!==id):[...ids,id]);
  const preview=(id:string)=>`/api/studio/projects/${detail.project.id}/tracks/${id}/preview?v=3`;
  const analysing=detail.jobs.some(j=>['people','detect'].includes(j.kind)&&['queued','running'].includes(j.state));
  const activeJobs=detail.jobs.some(job=>['queued','running'].includes(job.state));
  const canDetect=!busy&&!activeJobs&&!!detail.media&&detail.shots.length>0&&detail.detectorAvailable;
  const detect=async()=>{
    if(!canDetect)return;
    setBusy(true);
    try {
      await mutate(`/api/studio/projects/${detail.project.id}/analysis`,{kind:'detect',subjects:viewSubject,continueReconstruction:true},'POST');
      onChanged();show(`已提交${viewSubject==='person'?'人物':'动物'}出场检测，完成后继续整理出场并更新三维初稿。`);
    }catch(error){show((error as Error).message);}finally{setBusy(false);}
  };
  const openAppearance=(shotId:string,timeUs:number,workspace:'analysis'|'reconstruction')=>{
    selectShot(shotId);
    if(onOpenAppearance)onOpenAppearance(shotId,timeUs,workspace);
    else document.getElementById(workspace==='analysis'?'studio-cuts':'studio-playback')?.scrollIntoView({behavior:'smooth'});
  };
  const changeSubject=()=>{setViewSubject(value=>value==='person'?'animal':'person');setQuery('');setOpenPersonId(null);setSelected([]);setSelectedTracks([]);setQueueOpen(false);};
  return <section className="studio-card people-workspace" id="studio-people">
    <div className="panel-title"><h2>{viewSubject==='person'?'人物出场':'动物出场'}</h2><span>{viewSubject==='person'?`${people.length} 位人物`:`${animals.length} 个动物候选`}</span></div>
    <div className="people-search-row">
      <label className="people-search"><span className="people-search-label">片内筛选</span><input type="search" aria-label="按名字或已有描述筛选人物" placeholder="按名字或已有描述筛选" value={query} onChange={event=>setQuery(event.target.value)}/></label>
      {(animals.length>0||viewSubject==='animal')&&<button className="people-subject-switch" onClick={changeSubject}>{viewSubject==='person'?`查看动物 · ${animals.length}`:'返回人物'}</button>}
    </div>
    {analysing&&<p role="status" className="muted">正在整理人物出场，完成后自动刷新。</p>}
    <details className="people-corrections" open={correcting} onToggle={event=>{const opened=event.currentTarget.open;setCorrecting(opened);if(!opened){setSelected([]);setQueueOpen(false);}}}>
      <summary>修正{viewSubject==='person'?'人物':'动物'}{unresolved.filter(track=>(track.subject||'person')===viewSubject).length>0&&<small> · 有出场待核对</small>}</summary>
      <p className="muted">选择卡片可以合并、忽略或调整用于三维的角色。自动结果仅作参考，核对不影响继续查看。</p>
      {suggestions.length>0&&<div className="studio-suggest">
        <b>外观接近，待核对</b>
        <div className="studio-suggest-list">{suggestions.slice(0,5).map(suggestion=><span key={suggestion.a+suggestion.b}>{suggestion.aName} ↔ {suggestion.bName}<button onClick={()=>{setSelected([suggestion.a,suggestion.b]);setAssignment('');}}>选择这两位</button></span>)}</div>
        <small>外观相似不代表同一个体，请查看出场后再决定是否合并。</small>
      </div>}
      {selected.length>0&&<div className="studio-toolbar studio-group-toolbar">
      <span>已选 {selected.length} 名角色</span>
      <select aria-label="用于三维的角色" value={assignment} onChange={e=>setAssignment(e.target.value)}><option value="">选择处理方式</option>
        {!selectedAnimals&&detail.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="ignored">忽略所选角色</option><option value="unassigned">撤销分组</option>
      </select>
      <button className="primary" disabled={busy||!assignment} onClick={()=>act('assign',selected,{assignment})}>应用</button>
      <button disabled={busy||selected.length<2} onClick={()=>act('merge')}>合并为同一个体</button>
      <button onClick={()=>setSelected([])}>取消选择</button>
      </div>}
      <div className="studio-toolbar">{unresolved.length>0&&<button aria-expanded={queueOpen} onClick={()=>{setQueueOpen(value=>!value);setQueueSubject(viewSubject);setOpenPersonId(null);setSelectedTracks([]);}}>核对未归属出场 · {unresolved.filter(track=>(track.subject||'person')===viewSubject).length} 段</button>}</div>
      {queueOpen&&<section className="people-review-queue" aria-label="待核对出场">
      <div className="panel-title"><h3>待核对出场</h3><button onClick={()=>setQueueOpen(false)}>收起待核对</button></div>
      <p className="muted">这些片段暂时没有确定角色归属，可按镜头检查后归入角色。</p>
      <div className="studio-toolbar"><select aria-label="待核对主体类别" value={queueSubject} onChange={e=>{setQueueSubject(e.target.value as 'person'|'animal');setQueueShot('');setSelectedTracks([]);setTargetPerson('');}}><option value="person">人物出场</option><option value="animal">动物出场</option></select>
        <select aria-label="待核对镜头" value={currentQueueShot||''} onChange={e=>{setQueueShot(e.target.value);setSelectedTracks([]);}}>{queueShots.map(s=><option key={s.id} value={s.id}>{s.id} · {queue.filter(t=>t.shotId===s.id).length} 段</option>)}</select>
        <button onClick={()=>setSelectedTracks(queuedTracks.map(t=>t.id))}>选择本镜头出场</button>
        <select aria-label="归入素材角色" value={chosenTarget} onChange={e=>setTargetPerson(e.target.value)}>{targets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button disabled={busy||!selectedTracks.length||!chosenTarget} onClick={()=>act('assign-appearances',[chosenTarget],{trackIds:selectedTracks})}>归入该角色</button>
      </div>
      {!queue.length&&<p className="muted">该类别没有待核对出场。</p>}
      {selectedTracks.length>0&&!targets.length&&<p className="muted">没有同类别、同物种的目标身份；请分别选择同物种出场。</p>}
      <div className="studio-evidence-grid">{queuedTracks.map(track=><label key={track.id}><input aria-label={`选择出场${track.id}`} type="checkbox" checked={selectedTracks.includes(track.id)} onChange={()=>toggleTrack(track.id)}/><img src={preview(track.id)} alt={`${track.shotId} 待核对出场`} loading="lazy"/><span>帧 {track.startFrame}–{track.endFrame}</span></label>)}</div>
      </section>}
      <details className="studio-role-setup"><summary>{viewSubject==='person'?'人数或结果不对？':'动物出场结果不对？'}</summary>
      {viewSubject==='person'&&<div className="studio-toolbar">
        <label>片中人数<input aria-label="片中角色数" type="number" min="1" max="30" placeholder="未知可留空" value={count} onChange={e=>setCount(e.target.value)}/></label>
        <button disabled={busy||activeJobs||!detail.tracks.some(t=>t.status==='active')} onClick={summarize}>{analysing?'正在整理…':'重新整理出场'}</button>
        <small>仅重新归组已有出场，不重新检测画面。</small>
      </div>}
      <div className="studio-toolbar">
        <button disabled={!canDetect} onClick={()=>void detect()}>重新检测{viewSubject==='person'?'人物':'动物'}出场</button>
        {viewSubject==='person'&&!animals.length&&<button disabled={busy} onClick={changeSubject}>查找动物出场</button>}
        <small>切点采用后或漏检时可重新检测；成功后继续整理并更新三维初稿。已有人工决定受保护，重新检测可能被拒绝，请按反馈修正具体出场。</small>
        {!detail.detectorAvailable?<small role="status">出场检测模型尚未加载，暂时无法重新检测。已有结果仍可查看。</small>:!detail.media?<small role="status">请先导入视频。</small>:!detail.shots.length?<small role="status">请先完成视频切镜，再检测出场。</small>:activeJobs?<small role="status">当前还有任务在处理，请等待完成后再检测。</small>:null}
      </div></details>
    </details>
    <div className={`people-browser ${openPerson?'has-selection':''}`}>
      <div className="people-directory">
        {!!query.trim()&&<p className="people-filter-count" role="status">找到 {visibleEntities.length} {viewSubject==='person'?'位人物':'个动物候选'}</p>}
        <div className="studio-role-grid">{visibleEntities.map(person=>{
          const description=personDescription(detail,person);
          return <article className={`studio-role-card ${openPersonId===person.id?'opened':''}`} key={person.id}>
            {correcting&&<label className="studio-role-select"><input type="checkbox" aria-label={`选择${person.name}`} checked={selected.includes(person.id)} onChange={()=>toggleEntity(person)}/><span>选择</span></label>}
            <button className="studio-role-open" aria-label={`查看${person.name}的镜头`} aria-expanded={openPersonId===person.id} onClick={()=>{setOpenPersonId(current=>current===person.id?null:person.id);setOpenShotId('');setQueueOpen(false);setSelectedTracks([]);}}>
              {person.representativeTrackId?<img src={preview(person.representativeTrackId)} alt={person.name} loading="lazy"/>:<div className="studio-role-placeholder">暂无参考画面</div>}
              <div><b>{person.name}</b>{description&&<p className="people-description">{description}</p>}<span>{person.shotIds.length} 个镜头 <i>查看出场 ›</i></span></div>
            </button>
            <small className={`people-identity-status ${person.reviewed?'reviewed':''}`}>{person.subject==='animal'&&`${person.species||'动物'} · `}{person.reviewed?'已核对':'暂定匹配'}</small>
          </article>;
        })}</div>
        {!visibleEntities.length&&!analysing&&<div className="people-empty"><p>{query.trim()?'没有匹配的结果，试试更短的名字或描述。':viewSubject==='person'?'人物出场还没有整理完成。':'暂无动物出场。'}</p>{query.trim()&&<button onClick={()=>setQuery('')}>清除筛选</button>}{!query.trim()&&unresolved.length>0&&<button onClick={()=>{setCorrecting(true);setQueueOpen(true);setQueueSubject(viewSubject);}}>查看待核对出场</button>}</div>}
      </div>
      {openPerson&&<section className="people-results" aria-label={`${openPerson.name}的镜头`}>
        <div className="panel-title"><div><h3>{openPerson.name}的出场</h3><small>{personShots.length} 个镜头 · {openPerson.reviewed?'已核对':'自动匹配，待核对'}</small></div><button onClick={()=>setOpenPersonId(null)}>收起</button></div>
        <div className="people-appearance-grid">{personShots.map(s=>{
          const timeUs=appearanceStartUs(detail,openPerson,s.id,s.startUs);
          return <article key={s.id} className={`people-appearance ${shot?.id===s.id?'chosen':''}`}>
            <button className="people-appearance-preview" aria-label={`查看${openPerson.name}在${s.id}的出场`} onClick={()=>{setOpenShotId(s.id);setSelectedTracks([]);openAppearance(s.id,timeUs,'analysis');}}>
              <img loading="lazy" src={`/api/studio/projects/${detail.project.id}/shots/${s.id}/preview`} alt={`${openPerson.name} · ${s.id}`}/>
              <span><b>{s.id}</b><small>{(timeUs/1e6).toFixed(2)} 秒起</small></span>
            </button>
            <div className="people-appearance-actions"><button onClick={()=>openAppearance(s.id,timeUs,'analysis')}>查看拉片</button><button onClick={()=>openAppearance(s.id,timeUs,'reconstruction')}>三维还原</button></div>
          </article>;
        })}</div>
        <details className="people-local-correction" key={openPerson.id}><summary>修正{openPerson.name}的出场</summary>
          <div className="studio-toolbar">
            <button disabled={busy} onClick={()=>{const name=window.prompt('人物名称',openPerson.name);if(name!==null)act('rename',[openPerson.id],{name});}}>改名</button>
            {!openPerson.reviewed&&<button disabled={busy} onClick={()=>act('review',[openPerson.id])}>这些出场属于同一个体</button>}
            <button disabled={busy} onClick={()=>act('assign',[openPerson.id],{assignment:'ignored'})}>忽略此{openPerson.subject==='animal'?'动物':'人物'}</button>
          </div>
          {shot&&<div className="people-shot-correction">
            <label>需要修正的镜头<select aria-label="选择需要修正的出场镜头" value={shot.id} onChange={event=>{setOpenShotId(event.target.value);setSelectedTracks([]);}}>{personShots.map(s=><option key={s.id} value={s.id}>{s.id} · {(s.startUs/1e6).toFixed(2)} 秒</option>)}</select></label>
            <div className="studio-evidence-grid">{appearances.map(a=><label key={a.trackId}><input type="checkbox" aria-label={`选择出场${a.trackId}`} checked={selectedTracks.includes(a.trackId)} onChange={()=>toggleTrack(a.trackId)}/><img src={preview(a.trackId)} alt={`${shot.id} 帧 ${a.startFrame}`} loading="lazy"/><span>帧 {a.startFrame}–{a.endFrame}</span></label>)}</div>
            <div className="studio-toolbar"><button disabled={busy||!selectedTracks.length} onClick={()=>act('release-appearances',[openPerson.id],{trackIds:selectedTracks})}>不属于此人 · 移回待核对</button><button disabled={busy||!selectedTracks.length} onClick={()=>act('split',[openPerson.id],{trackIds:selectedTracks})}>拆为另一个体</button></div>
          </div>}
        </details>
        {!personShots.length&&<p className="muted">还没有确定的出场，可从“修正人物”核对未归属片段。</p>}
      </section>}
    </div>
  </section>;
}
