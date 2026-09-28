import React, {useEffect, useRef, useState} from 'react';
import type {ProjectDetail} from './studio';
import {suspendProjectMedia} from './studio-project-media';

export interface PersonInfo {
  id:string;name:string;subject:'person'|'animal';species:string|null;method:string;reviewed:boolean;
  trackIds:string[];shotIds:string[];
  representativeTrackId:string|null;assignment:string;
  appearances:{trackId:string;shotId:string;startFrame:number;endFrame:number}[];
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
    <label>场景选项<select aria-label="项目场景选项" value={sceneMode} onChange={e=>setSceneMode(e.target.value as typeof sceneMode)}>
      <option value="proxy">默认场景 · 内置舞台（推荐）</option><option value="reconstruct">从视频还原场景 · 待开发</option>
    </select></label>
    <p className="muted">默认场景使用内置通用舞台与尺度参照，随时可用；改为“从视频还原”需要额外制作并重新确认项目（该分支尚未开发）。更改场景选项后需要重新确认项目；相机和动作数据会保留。</p>
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

export function PeopleSection({detail,onChanged,show,selectShot}:{detail:ProjectDetail;onChanged:()=>void;show:(s:string)=>void;selectShot:(id:string)=>void}) {
  const[selected,setSelected]=useState<string[]>([]);
  const[openPersonId,setOpenPersonId]=useState<string|null>(null);
  const[openShotId,setOpenShotId]=useState('');
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
  const reviewedCount=people.filter(person=>person.reviewed).length;
  const openPerson=entities.find(person=>person.id===openPersonId);
  const personShots=detail.shots.filter(shot=>openPerson?.shotIds.includes(shot.id));
  const shot=personShots.find(shot=>shot.id===openShotId)||personShots[0];
  const appearances=openPerson?.appearances.filter(a=>a.shotId===shot?.id)||[];
  const queueShots=detail.shots.filter(s=>queue.some(t=>t.shotId===s.id));
  const currentQueueShot=queueShots.some(s=>s.id===queueShot)?queueShot:queueShots[0]?.id;
  const queuedTracks=queue.filter(t=>t.shotId===currentQueueShot);
  const chosenTarget=targets.some(p=>p.id===targetPerson)?targetPerson:targets[0]?.id||'';
  const selectedAnimals=selected.some(id=>animals.some(animal=>animal.id===id));
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
  return <section className="studio-card" id="studio-people">
    <div className="panel-title"><h2>素材身份</h2><span>人物 {people.length}（已核对 {reviewedCount}）· 动物 {animals.length} · 出场 {detail.tracks.filter(t=>t.status==='active').length} 段</span></div>
    <p className="muted">检测出场 → 暂定素材身份 → 叙事组（角色卡）。身份为自动建议：点击查看出场镜头并核对。动物与人物分开统计；同品种动物不因物种相同而自动合并。</p>
    <div className="studio-role-actions">
      <details className="studio-role-setup"><summary>整理角色</summary><div className="studio-toolbar">
        <label>片中角色数<input aria-label="片中角色数" type="number" min="1" max="30" placeholder="未知可留空" value={count} onChange={e=>setCount(e.target.value)}/></label>
        <button disabled={busy||analysing||!detail.tracks.some(t=>t.status==='active')} onClick={summarize}>{analysing?'正在整理…':'整理人物出场'}</button>
        <small>已知人数用于建立角色档案；不确定的出场保留待核对。</small>
      </div></details>
      {unresolved.length>0&&<button aria-expanded={queueOpen} onClick={()=>{setQueueOpen(value=>!value);setOpenPersonId(null);setSelectedTracks([]);}}>待核对出场 · {unresolved.length} 段</button>}
    </div>
    {analysing&&<p role="status" className="muted">正在识别与整理角色，完成后会自动刷新。</p>}
    {detail.identitySuggestions&&detail.identitySuggestions.length>0&&<div className="studio-suggest">
      <b>疑似同一个体（外观相似，仅提示）</b>
      <div className="studio-suggest-list">{detail.identitySuggestions.slice(0,5).map(suggestion=>(
        <span key={suggestion.a+suggestion.b}>
          {suggestion.aName} ↔ {suggestion.bName}（{Math.round(suggestion.score*100)}%）
          <button onClick={()=>{setSelected([suggestion.a,suggestion.b]);setOpenPersonId(null);}}>选择并合并</button>
        </span>))}</div>
      <small>自动合并偏保守以避免错误合并；确认无误后再合并。</small>
    </div>}
    <div className="studio-role-grid">{people.map(person=>{
      const group=detail.characters.find(c=>c.id===person.assignment);
      return <article className={`studio-role-card ${openPersonId===person.id?'opened':''}`} key={person.id}>
        <label className="studio-role-select"><input type="checkbox" aria-label={`选择${person.name}`} checked={selected.includes(person.id)} onChange={()=>toggleEntity(person)}/><span>选择</span></label>
        <button className="studio-role-open" aria-label={`查看${person.name}的镜头`} aria-expanded={openPersonId===person.id} onClick={()=>{setOpenPersonId(current=>current===person.id?null:person.id);setOpenShotId('');setQueueOpen(false);setSelectedTracks([]);}}>
          {person.representativeTrackId?<img src={preview(person.representativeTrackId)} alt={person.name} loading="lazy"/>:<div className="studio-role-placeholder">待选择参考出场</div>}
          <div><b>{person.name}</b><span>{person.shotIds.length} 个镜头 <i>查看 ›</i></span></div>
        </button>
        <small className="studio-role-group" style={{color:group?.color}}>{group?`代理组：${group.name}`:person.assignment==='mixed'?'部分出场分组不同':'尚未分配代理组'}</small>
      </article>;
    })}</div>
    {!people.length&&!analysing&&<p className="muted">尚未整理出人物身份。运行检测后自动汇总；原始出场都保留在待核对入口中。</p>}
    <div className="studio-animals-head"><h3>动物个体</h3><small>分物种独立身份；动物代理与动作还原在后续里程碑开放，当前可合并/改名/忽略。</small></div>
    <div className="studio-role-grid studio-animals-grid">{animals.map(animal=>(
      <article className={`studio-role-card ${openPersonId===animal.id?'opened':''}`} key={animal.id}>
        <label className="studio-role-select"><input type="checkbox" aria-label={`选择${animal.name}`} checked={selected.includes(animal.id)} onChange={()=>toggleEntity(animal)}/><span>选择</span></label>
        <button className="studio-role-open" aria-label={`查看${animal.name}的镜头`} aria-expanded={openPersonId===animal.id} onClick={()=>{setOpenPersonId(current=>current===animal.id?null:animal.id);setOpenShotId('');setQueueOpen(false);setSelectedTracks([]);}}>
          {animal.representativeTrackId?<img src={preview(animal.representativeTrackId)} alt={animal.name} loading="lazy"/>:<div className="studio-role-placeholder">待选择参考出场</div>}
          <div><b>🐾 {animal.name}</b><span>{animal.shotIds.length} 个镜头 <i>查看 ›</i></span></div>
        </button>
        <small className="studio-role-group">{animal.species||'动物'} · {animal.reviewed?'已核对':'暂定个体'}</small>
      </article>))}
      {!animals.length&&<p className="muted">暂无动物身份。使用“检测：动物/人物+动物”后按物种汇总个体。</p>}
    </div>
    {selected.length>0&&<div className="studio-toolbar studio-group-toolbar">
      <span>已选 {selected.length} 名角色</span>
      <select aria-label="目标代理角色组" value={assignment} onChange={e=>setAssignment(e.target.value)}><option value="">选择代理角色组</option>
        {!selectedAnimals&&detail.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="ignored">忽略所选角色</option><option value="unassigned">撤销分组</option>
      </select>
      <button className="primary" disabled={busy||!assignment} onClick={()=>act('assign',selected,{assignment})}>应用分组</button>
      {!selectedAnimals&&<a href="#studio-cast">创建代理角色组</a>}
      <button disabled={busy||selected.length<2} onClick={()=>act('merge')}>合并为同一素材身份</button>
      <button onClick={()=>setSelected([])}>取消选择</button>
    </div>}
    {openPerson&&<section className="studio-role-detail" aria-label={`${openPerson.name}的镜头`}>
      <div className="panel-title"><h3>{openPerson.name}的镜头</h3><button onClick={()=>setOpenPersonId(null)}>收起镜头</button></div>
      <div className="studio-toolbar">
        <button disabled={busy} onClick={()=>{const name=window.prompt('角色名称',openPerson.name);if(name!==null)act('rename',[openPerson.id],{name});}}>标记 / 改名</button>
        {!openPerson.reviewed&&<button disabled={busy} onClick={()=>act('review',[openPerson.id])}>确认该角色</button>}
        <small>{openPerson.reviewed?'已核对':'自动归属，出场镜头可核对和修正'}</small>
      </div>
      <div className="studio-role-shots">{personShots.map(s=><button key={s.id} className={shot?.id===s.id?'chosen':''} aria-label={`查看${openPerson.name}在${s.id}的出场`} onClick={()=>{setOpenShotId(s.id);setSelectedTracks([]);}}>
        <img loading="lazy" src={`/api/studio/projects/${detail.project.id}/shots/${s.id}/preview`} alt={`${openPerson.name} · ${s.id}`}/>
        <b>{s.id}</b><small>{(s.startUs/1e6).toFixed(2)}–{(s.endUs/1e6).toFixed(2)} 秒</small>
      </button>)}</div>
      {shot&&<details className="studio-role-evidence" key={shot.id}><summary>修正 {shot.id} 的出场归属（{appearances.length} 段）</summary>
        <div className="studio-evidence-grid">{appearances.map(a=><label key={a.trackId}><input type="checkbox" checked={selectedTracks.includes(a.trackId)} onChange={()=>toggleTrack(a.trackId)}/><img src={preview(a.trackId)} alt={`${shot.id} 帧 ${a.startFrame}`} loading="lazy"/><span>帧 {a.startFrame}–{a.endFrame}</span></label>)}</div>
        <div className="studio-toolbar"><button disabled={busy||!selectedTracks.length} onClick={()=>act('release-appearances',[openPerson.id],{trackIds:selectedTracks})}>移回待核对</button>
          <button disabled={busy||!selectedTracks.length} onClick={()=>act('split',[openPerson.id],{trackIds:selectedTracks})}>拆为另一角色</button>
          <button onClick={()=>{selectShot(shot.id);document.getElementById('studio-cuts')?.scrollIntoView({behavior:'smooth'});}}>打开镜头工作台</button></div>
      </details>}
      {!personShots.length&&<p className="muted">还没有确定的出场，从待核对入口为这个角色选择参考片段。</p>}
    </section>}
    {queueOpen&&<section className="studio-role-detail" aria-label="待核对出场">
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
  </section>;
}
