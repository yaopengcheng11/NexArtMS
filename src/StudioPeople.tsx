import React, {useEffect, useRef, useState} from 'react';
import type {ProjectDetail} from './studio';

export interface PersonInfo {
  id:string;name:string;method:string;reviewed:boolean;trackIds:string[];shotIds:string[];
  representativeTrackId:string|null;assignment:string;
  appearances:{trackId:string;shotId:string;startFrame:number;endFrame:number}[];
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
  const[error,setError]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  const active=detail.jobs.some(job=>job.state==='queued'||job.state==='running');
  const save=async()=>{setBusy(true);setError('');try {
    await mutate(`/api/studio/projects/${detail.project.id}`,{name,note,sceneMode,baseRevision:detail.project.revision});
    onChanged();onClose();show('项目设置已保存。');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const remove=async()=>{setBusy(true);setError('');try {
    const result=await mutate(`/api/studio/projects/${detail.project.id}`,{baseRevision:detail.project.revision,confirmName},'DELETE');
    if(result.cleanupPending)window.alert(result.message);
    onDeleted();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <dialog ref={dialog} className="studio-settings" aria-labelledby="settings-title" onCancel={onClose}>
    <div className="panel-title"><h2 id="settings-title">项目设置</h2><button onClick={onClose} disabled={busy} aria-label="关闭项目设置">×</button></div>
    <label>项目名称<input aria-label="修改项目名称" value={name} maxLength={80} onChange={e=>setName(e.target.value)}/></label>
    <label>项目说明<textarea aria-label="项目说明" value={note} maxLength={400} rows={3} onChange={e=>setNote(e.target.value)}/></label>
    <label>场景选项<select aria-label="项目场景选项" value={sceneMode} onChange={e=>setSceneMode(e.target.value as typeof sceneMode)}>
      <option value="proxy">不建立可见场景 · 专注相机和动作</option><option value="reconstruct">建立可见场景 · 当前仍待开发</option>
    </select></label>
    <p className="muted">更改场景选项后需要重新确认项目；相机和动作数据会保留。</p>
    <button className="primary" onClick={save} disabled={busy||!name.trim()}>保存项目设置</button>
    <section className="studio-delete-zone"><h3>删除项目</h3>
      <p>删除“{detail.project.name}”的本地素材、人物标记、动作及导出文件。此操作无法在界面撤销。</p>
      {active&&<p>还有任务进行中，请等待结束或取消完成后再删除。</p>}
      <label>输入完整项目名称确认<input aria-label="输入项目名称确认删除" value={confirmName} onChange={e=>setConfirmName(e.target.value)} placeholder={detail.project.name}/></label>
      <button className="danger" disabled={busy||active||confirmName!==detail.project.name} onClick={remove}>永久删除项目</button>
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
  const[selectedTracks,setSelectedTracks]=useState<string[]>([]);
  const[targetPerson,setTargetPerson]=useState('');
  const[assignment,setAssignment]=useState('');
  const[count,setCount]=useState(detail.project.sourcePeopleCount?.toString()||'');
  const[busy,setBusy]=useState(false);
  // Legacy tracklets remain evidence in the review queue, never identity cards.
  const people=detail.people.filter(person=>person.method!=='legacy'&&person.assignment!=='ignored');
  const knownTrackIds=new Set(people.flatMap(person=>person.trackIds));
  const ignoredTrackIds=new Set(detail.bindings.filter(binding=>binding.disposition==='ignored').map(binding=>binding.trackId));
  const unresolved=detail.tracks.filter(track=>track.status==='active'&&!knownTrackIds.has(track.id)&&!ignoredTrackIds.has(track.id));
  const openPerson=people.find(person=>person.id===openPersonId);
  const personShots=detail.shots.filter(shot=>openPerson?.shotIds.includes(shot.id));
  const shot=personShots.find(shot=>shot.id===openShotId)||personShots[0];
  const appearances=openPerson?.appearances.filter(a=>a.shotId===shot?.id)||[];
  const queueShots=detail.shots.filter(s=>unresolved.some(t=>t.shotId===s.id));
  const currentQueueShot=queueShots.some(s=>s.id===queueShot)?queueShot:queueShots[0]?.id;
  const queuedTracks=unresolved.filter(t=>t.shotId===currentQueueShot);
  const chosenTarget=people.some(p=>p.id===targetPerson)?targetPerson:people[0]?.id||'';
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
    <div className="panel-title"><h2>全片角色</h2><span>{people.length} 名角色</span></div>
    <p className="muted">点击角色，查看它出现的镜头。勾选多个角色可分到同一个代理角色组。</p>
    <div className="studio-role-actions">
      <details className="studio-role-setup"><summary>整理角色</summary><div className="studio-toolbar">
        <label>片中角色数<input aria-label="片中角色数" type="number" min="1" max="30" placeholder="未知可留空" value={count} onChange={e=>setCount(e.target.value)}/></label>
        <button disabled={busy||analysing||!detail.tracks.some(t=>t.status==='active')} onClick={summarize}>{analysing?'正在整理…':'整理人物出场'}</button>
        <small>已知人数用于建立角色档案；不确定的出场保留待核对。</small>
      </div></details>
      {unresolved.length>0&&<button aria-expanded={queueOpen} onClick={()=>{setQueueOpen(value=>!value);setOpenPersonId(null);setSelectedTracks([]);}}>待核对出场 · {unresolved.length} 段</button>}
    </div>
    {analysing&&<p role="status" className="muted">正在识别与整理角色，完成后会自动刷新。</p>}
    <div className="studio-role-grid">{people.map(person=>{
      const group=detail.characters.find(c=>c.id===person.assignment);
      return <article className={`studio-role-card ${openPersonId===person.id?'opened':''}`} key={person.id}>
        <label className="studio-role-select"><input type="checkbox" aria-label={`选择${person.name}`} checked={selected.includes(person.id)} onChange={()=>setSelected(ids=>ids.includes(person.id)?ids.filter(id=>id!==person.id):[...ids,person.id])}/><span>选择</span></label>
        <button className="studio-role-open" aria-label={`查看${person.name}的镜头`} aria-expanded={openPersonId===person.id} onClick={()=>{setOpenPersonId(current=>current===person.id?null:person.id);setOpenShotId('');setQueueOpen(false);setSelectedTracks([]);}}>
          {person.representativeTrackId?<img src={preview(person.representativeTrackId)} alt={person.name} loading="lazy"/>:<div className="studio-role-placeholder">待选择参考出场</div>}
          <div><b>{person.name}</b><span>{person.shotIds.length} 个镜头 <i>查看 ›</i></span></div>
        </button>
        <small className="studio-role-group" style={{color:group?.color}}>{group?`代理组：${group.name}`:person.assignment==='mixed'?'部分出场分组不同':'尚未分配代理组'}</small>
      </article>;
    })}</div>
    {!people.length&&!analysing&&<p className="muted">尚未整理出角色。展开“整理角色”，填入已知人数后开始；原始出场都保留在待核对入口中。</p>}
    {selected.length>0&&<div className="studio-toolbar studio-group-toolbar">
      <span>已选 {selected.length} 名角色</span>
      <select aria-label="目标代理角色组" value={assignment} onChange={e=>setAssignment(e.target.value)}><option value="">选择代理角色组</option>
        {detail.characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="ignored">忽略所选角色</option><option value="unassigned">撤销分组</option>
      </select>
      <button className="primary" disabled={busy||!assignment} onClick={()=>act('assign',selected,{assignment})}>应用分组</button>
      <a href="#studio-cast">创建代理角色组</a>
      <button disabled={busy||selected.length<2} onClick={()=>act('merge')}>合并为同一素材角色</button>
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
      <div className="studio-toolbar"><select aria-label="待核对镜头" value={currentQueueShot||''} onChange={e=>{setQueueShot(e.target.value);setSelectedTracks([]);}}>{queueShots.map(s=><option key={s.id} value={s.id}>{s.id} · {unresolved.filter(t=>t.shotId===s.id).length} 段</option>)}</select>
        <button onClick={()=>setSelectedTracks(queuedTracks.map(t=>t.id))}>选择本镜头出场</button>
        <select aria-label="归入素材角色" value={chosenTarget} onChange={e=>setTargetPerson(e.target.value)}>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button disabled={busy||!selectedTracks.length||!chosenTarget} onClick={()=>act('assign-appearances',[chosenTarget],{trackIds:selectedTracks})}>归入该角色</button>
      </div>
      <div className="studio-evidence-grid">{queuedTracks.map(track=><label key={track.id}><input aria-label={`选择出场${track.id}`} type="checkbox" checked={selectedTracks.includes(track.id)} onChange={()=>toggleTrack(track.id)}/><img src={preview(track.id)} alt={`${track.shotId} 待核对出场`} loading="lazy"/><span>帧 {track.startFrame}–{track.endFrame}</span></label>)}</div>
    </section>}
  </section>;
}
