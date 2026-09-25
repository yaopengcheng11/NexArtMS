import {useEffect,useState} from 'react';
import {SceneViewport} from './SceneViewport';
import {RigLab} from './rig-lab';
import {VideoComparison} from './VideoComparison';
import type {Project,SceneAsset,Shot} from './types';
import './rehearsal.css';

type Stage=1|2|3|4|5;
interface RehearsalRun {
  id:string;
  revision:string;
  mode:'rehearsal';
  currentStage:Stage;
  status:'active'|'complete';
  sourceProjectRevision:string;
  sourceSceneRevision:string;
  projectSnapshot:{scene:SceneAsset;shots:Shot[]};
  decisions:{stage:Stage;decision:'demo_passed';time:string}[];
}
const stages=[
  {name:'场景还原',title:'先检查这片场地',description:'对照原片，查看固定场景中的空间布局与镜头视角。'},
  {name:'角色确认',title:'看看角色如何确认',description:'用现有合成小人体验身份参考、角色区分和三档表达的查看方式。'},
  {name:'关键姿态',title:'逐镜查看关键画面',description:'选择镜头，体验原片与三维样例并排审查的流程。'},
  {name:'完整镜头',title:'连起来看一遍',description:'播放现有三维样片，体验从单帧审查进入完整视频审查。'},
  {name:'导出交付',title:'查看可下载的样例',description:'体验交付页，下载现有视频和用于检查文件结构的技术样例。'},
];
const nextLabels=['演练通过 → 角色确认','演练通过 → 关键姿态','演练通过 → 完整镜头','演练通过 → 导出交付','完成演练'];
const formatTime=(n:number)=>`${Math.floor(n/60).toString().padStart(2,'0')}:${(n%60).toFixed(2).padStart(5,'0')}`;
async function request<T>(url:string,body?:unknown):Promise<T>{
  const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'请求未完成，请重试。');
  return result;
}

function ReferenceImage({src,alt}:{src:string;alt:string}){
  const[failed,setFailed]=useState(false);
  useEffect(()=>setFailed(false),[src]);
  return failed?<div className="rehearsal-media-error" role="status">这张参考图暂时无法载入。请重新载入页面后再查看。</div>:<img className="reference-image" src={src} alt={alt} loading="lazy" onError={()=>setFailed(true)}/>;
}

function ShotSelector({shots,value,onChange}:{shots:Shot[];value:string;onChange:(id:string)=>void}){
  return <label className="rehearsal-shot-select">选择镜头 <select value={value} onChange={event=>onChange(event.target.value)}>{shots.map(shot=><option key={shot.id} value={shot.id}>{shot.id} · {formatTime(shot.start)} · {shot.seconds.toFixed(2)} 秒 · {shot.frame}</option>)}</select><span>{shots.length} 镜</span></label>;
}

function StageContent({stage,run,shotId,setShotId}:{stage:Stage;run:RehearsalRun;shotId:string;setShotId:(id:string)=>void}){
  const[mode,setMode]=useState<'shot'|'free'|'top'>('shot');
  const[grid,setGrid]=useState(false);
  const[selected,setSelected]=useState('');
  const[actor,setActor]=useState<'P1'|'P2'>('P1');
  const[colors,setColors]=useState({P1:0xd9773e,P2:0x547a94});
  const{scene,shots}=run.projectSnapshot;
  const shot=shots.find(item=>item.id===shotId)||shots[0];
  if(stage===1)return <>
    <div className="rehearsal-toolbar"><ShotSelector shots={shots} value={shotId} onChange={setShotId}/><div className="segmented">{([['shot','镜头视角'],['free','自由观察'],['top','俯视场地']] as const).map(([value,label])=><button key={value} className={mode===value?'chosen':''} aria-pressed={mode===value} onClick={()=>setMode(value)}>{label}</button>)}</div><label className="toggle"><input type="checkbox" checked={grid} onChange={event=>setGrid(event.target.checked)}/>场地网格</label></div>
    <div className="comparison"><section className="view-pane"><div className="view-title"><b>三维空场景 · 演练快照</b><span>{mode==='shot'?`${shot?.id} · 初步机位`:'可拖动观察'}</span></div><SceneViewport asset={scene} shotId={shotId} mode={mode} grid={grid} onSelect={setSelected}/></section><section className="view-pane"><div className="view-title"><b>原片参考 · {shot?.id}</b><span>中间帧</span></div><ReferenceImage src={`/reference-frames/${shot?.id}-middle.jpg`} alt={`${shot?.id} 原片中间帧`}/></section></div>
    <p className="rehearsal-caption">{shot?.frame}{selected&&<> · 当前查看：{scene.nodes.find(node=>node.id===selected)?.label||selected}</>}</p>
    <div className="rehearsal-note"><b>本步体验：查看布局 → 对照镜头 → 进入角色页</b><p>这里使用开始演练时的场景快照。机位标定、像素误差检查和正式 G1 确认仍由正式流程完成。</p></div>
  </>;
  if(stage===2)return <>
    <div className="rehearsal-reference-grid">{[{id:'P1',shot:'S01'},{id:'P2',shot:'S04'}].map(item=><section className="view-pane" key={item.id}><div className="view-title"><b>{item.id} · 原片身份参考</b><span>{item.shot} 中间帧</span></div><ReferenceImage src={`/reference-frames/${item.shot}-middle.jpg`} alt={`${item.id} 身份参考，原片 ${item.shot} 中间帧`}/></section>)}</div>
    <p className="rehearsal-caption">原片身份参考；正式 T Pose 参考尚待制作。下方为刚性合成小人，用来体验查看方式。</p>
    <section className="rehearsal-rig-card"><div className="rehearsal-rig-heading"><div><h2>一套骨架，三种表达</h2><p>当前查看 {actor} 的颜色样例 · 只影响此页显示</p></div><div className="rehearsal-color-controls"><div className="segmented">{(['P1','P2'] as const).map(id=><button key={id} className={actor===id?'chosen':''} aria-pressed={actor===id} onClick={()=>setActor(id)}>{id} 样例</button>)}</div><label>样例颜色 <input aria-label={`${actor} 样例颜色`} type="color" value={`#${colors[actor].toString(16).padStart(6,'0')}`} onChange={event=>setColors(value=>({...value,[actor]:Number.parseInt(event.target.value.slice(1),16)}))}/></label></div></div><RigLab embedded color={colors[actor]}/></section>
    <div className="rehearsal-note"><b>本步体验：查看身份参考 → 检查档位与姿态 → 进入关键姿态页</b><p>P1／P2 标签和颜色属于界面演练。通过此步只记录演练进度，正式角色尚未确认。</p></div>
  </>;
  if(stage===3)return <>
    <div className="rehearsal-toolbar"><ShotSelector shots={shots} value={shotId} onChange={setShotId}/></div>
    <div className="comparison"><section className="view-pane"><div className="view-title"><b>原片参考 · {shot?.id}</b><span>中间帧</span></div><ReferenceImage src={`/reference-frames/${shot?.id}-middle.jpg`} alt={`${shot?.id} 原片关键画面`}/></section><section className="view-pane"><div className="view-title"><b>旧版 V2 三维样例 · {shot?.id}</b><span>中间帧</span></div><ReferenceImage src={`/demo/v2-frames/${shot?.id}-middle.jpg`} alt={`${shot?.id} 旧版 V2 三维中间帧样例`}/></section></div>
    <p className="rehearsal-caption">{shot?.frame} · {shot?.seconds.toFixed(2)} 秒</p>
    <div className="rehearsal-note"><b>旧版 V2 样例，未由新流程求解</b><p>这些画面用于体验逐镜对比。它们没有经过本次场景标定、角色确认或关键姿态求解；仍需在正式制作中核对人物位置、动作与机位。</p></div>
  </>;
  if(stage===4)return <>
    <VideoComparison shots={shots}/>
    <div className="rehearsal-note"><b>现有版本仍有抖动，用于演练审查流程</b><p>支持并排对照、透明叠加、逐帧和按镜跳转，观察动作衔接、脚底接触和镜头稳定性。本页通过只表示体验过审查步骤，画面问题仍需在正式制作中修复。</p></div>
    <div className="rehearsal-checklist"><span>01 · 人物动作是否连续</span><span>02 · 脚底与地面是否稳定</span><span>03 · 镜头运动是否平顺</span></div>
  </>;
  return <>
    <div className="rehearsal-download-grid"><section className="rehearsal-download-card"><span className="rehearsal-file-kind">视频样例</span><h2>旧版 V2 预演视频</h2><p>现有三维样片，保留当前动作与抖动问题，可用于离线体验审查。</p><a className="rehearsal-download" href="/demo/v2.mp4" download="jwm-v2-demo.mp4">下载视频 · MP4 <span>↓</span></a></section><section className="rehearsal-download-card"><span className="rehearsal-file-kind">模型技术样例</span><h2>刚性小人合成动作</h2><p>用于检查骨架、刚性蒙皮与合成屈肘动画的结构。</p><a className="rehearsal-download" href="/probes/rig.glb" download="rig-technical-demo.glb">下载模型 · GLB <span>↓</span></a></section><section className="rehearsal-download-card rehearsal-dcc-card"><span className="rehearsal-file-kind">DCC 技术样例</span><h2>相同刚性小人的格式样例</h2><p>以下文件用于查看导出格式；Maya／Houdini 尚未验证。</p><div className="rehearsal-dcc-links">{[['BLEND','blend'],['FBX','fbx'],['USD','usdc']].map(([name,ext])=><a className="rehearsal-download" key={ext} href={`/probes/dcc/rig.${ext}`} download={`rig-technical-demo.${ext}`}>{name} <span>↓</span></a>)}</div></section></div>
    <div className="rehearsal-note"><b>刚性小人合成动作样例，不等于原视频三维整包</b><p>这些模型文件不包含原片全部角色、47 镜动作和镜头动画。完成演练不会生成新的生产交付物，也不会更改正式标定或 G1 状态。</p></div>
  </>;
}

export function Rehearsal(){
  const[project,setProject]=useState<Project|null>(null);
  const[run,setRun]=useState<RehearsalRun|null>(null);
  const[viewedStage,setViewedStage]=useState<Stage>(1);
  const[shotId,setShotId]=useState('S33');
  const[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState(false);
  const[error,setError]=useState('');
  const applyRun=(next:RehearsalRun|null)=>{setRun(next);setViewedStage(next?.currentStage||1);const shots=next?.projectSnapshot.shots;if(shots&&!shots.some(shot=>shot.id===shotId))setShotId(shots.find(shot=>shot.id==='S33')?.id||shots[0]?.id||'S33');};
  const load=async()=>{setLoading(true);setError('');try{const[p,r]=await Promise.all([request<Project>('/api/project'),request<RehearsalRun|null>('/api/rehearsal')]);setProject(p);applyRun(r);}catch(cause){setError((cause as Error).message);}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const start=async(restart=false)=>{if(!project||busy)return;setBusy(true);setError('');try{const freshProject=await request<Project>('/api/project');setProject(freshProject);applyRun(await request<RehearsalRun>('/api/rehearsal/start',{baseRevision:freshProject.revision,...(restart?{restart:true}:{})}));setShotId('S33');}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}};
  const advance=async()=>{if(!run||busy||run.status!=='active'||viewedStage!==run.currentStage)return;setBusy(true);setError('');try{applyRun(await request<RehearsalRun>('/api/rehearsal/advance',{baseRevision:run.revision,stage:run.currentStage}));window.scrollTo({top:0,behavior:'smooth'});}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}};
  const current=stages[viewedStage-1];
  const completed=run?.status==='complete';
  return <div className="rehearsal"><header className="topbar"><div className="identity"><span className="brand-mark">M</span><div><strong>MotionStage <i>/</i> 流程演练</strong><small>从场景检查走到交付预览</small></div></div><span className="rehearsal-mode-badge">界面流程样例</span><a className="rehearsal-back" href="/?mode=scene">返回场景工作台 ↗</a></header>
    <div className="rehearsal-banner"><span className="rehearsal-banner-symbol">i</span><p><strong>你正在体验五阶段流程。</strong>演练进度独立保存；正式标定、G1 与角色确认状态均不会因此改变。</p></div>
    <nav className="rehearsal-progress" aria-label="演练阶段">{stages.map((stage,index)=>{const number=(index+1) as Stage;const available=!!run&&number<=run.currentStage;const passed=!!run&&(completed||run.decisions.some(decision=>decision.stage===number));return <button key={stage.name} className={`rehearsal-stage ${run&&number===viewedStage?'is-current':''} ${passed?'is-passed':''}`} disabled={!available||busy} aria-current={run&&number===viewedStage?'step':undefined} onClick={()=>{setViewedStage(number);setError('');}}><span className="rehearsal-stage-number">{passed?'✓':number.toString().padStart(2,'0')}</span><span><b>{stage.name}</b><small>{!run?'等待开始':passed?'演练已通过':number===run.currentStage?'当前步骤':'待前一步演练通过'}</small></span></button>;})}</nav>
    <main className="rehearsal-main">
      {error&&<div className="rehearsal-error" role="alert"><div><b>这次操作未完成</b><p>{error}</p></div><button onClick={()=>void load()} disabled={busy||loading}>重新载入进度</button>{run&&<button onClick={()=>void start(true)} disabled={busy||loading}>基于当前场景重新演练</button>}</div>}
      {loading?<section className="rehearsal-welcome" aria-live="polite"><span className="eyebrow">流程演练</span><h1>正在打开演练工作台</h1><p>载入正式场景版本与独立演练进度…</p></section>:!run?<section className="rehearsal-welcome"><span className="eyebrow">FIVE STAGES / 五阶段</span><h1>先把整个流程走一遍</h1><p>从场景、角色和关键姿态，到完整镜头与导出交付。用现有素材了解每一步怎么看、怎样进入下一步。</p><div className="rehearsal-welcome-points"><span>保留当前场景快照</span><span>每一步由你主动通过</span><span>随时返回已到过的步骤</span></div><button className="rehearsal-primary" onClick={()=>void start()} disabled={busy||!project}>{busy?'正在开始…':'开始流程演练'} <span>→</span></button><p className="rehearsal-welcome-footnote">本次操作仅创建演练记录，正式工作台保留现有状态。</p></section>:<>
        {completed&&<section className="rehearsal-complete" role="status"><span>✓</span><div><h2>五阶段演练已完成</h2><p>你已走完界面样例。仍可点击上方步骤回看，正式制作进度保持原状态。</p></div></section>}
        <div className="rehearsal-heading"><div><span className="eyebrow">{viewedStage.toString().padStart(2,'0')} / {current.name} · 演练</span><h1>{current.title}</h1><p>{current.description}</p></div><span className="rehearsal-progress-count">{completed?'5 / 5 步已完成':`${run.decisions.length} / 5 步已通过`}</span></div>
        <StageContent key={`${run.id}-${viewedStage}`} stage={viewedStage} run={run} shotId={shotId} setShotId={setShotId}/>
        <footer className="rehearsal-footer"><div><b>{completed?'演练记录已保存':viewedStage===run.currentStage?'准备好就继续下一步':'正在回看已通过的演练步骤'}</b><p>{completed?'正式流程仍需完成标定、角色和动作制作。':'这里的“通过”只记录界面演练进度。'}</p></div><div className="rehearsal-footer-actions">{viewedStage>1&&<button className="rehearsal-secondary" disabled={busy} onClick={()=>setViewedStage((viewedStage-1) as Stage)}>← 上一步</button>}{completed?<><a className="rehearsal-secondary" href="/?mode=scene">返回场景工作台</a><button className="rehearsal-primary" disabled={busy} onClick={()=>void start(true)}>{busy?'正在重新开始…':'重新演练'}</button></>:viewedStage<run.currentStage?<button className="rehearsal-primary" disabled={busy} onClick={()=>setViewedStage(run.currentStage)}>回到当前步骤 · {stages[run.currentStage-1].name} →</button>:<button className="rehearsal-primary" disabled={busy} onClick={()=>void advance()}>{busy?'正在保存演练进度…':nextLabels[viewedStage-1]}</button>}</div></footer>
        <details className="rehearsal-record"><summary>查看本次演练记录</summary><p>来源项目版本：{run.sourceProjectRevision}<br/>来源场景版本：{run.sourceSceneRevision}<br/>演练版本：{run.revision}</p><p>演练快照与开始时的正式项目一致。之后的正式修改会在重新演练时载入。</p>{run.decisions.length>0&&<ol>{run.decisions.map(decision=><li key={decision.stage}>{stages[decision.stage-1].name}：演练通过 · {new Date(decision.time).toLocaleString('zh-CN')}</li>)}</ol>}</details>
      </>}
    </main></div>;
}
export default Rehearsal;
