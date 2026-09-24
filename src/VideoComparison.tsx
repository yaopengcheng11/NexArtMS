import {useEffect,useRef,useState} from 'react';
import {ComparisonClock,type ComparisonState} from './comparison-clock';
import type {Shot} from './types';
import './video-comparison.css';

type Mode='side'|'overlay'|'rendered';
type ReviewShot=Shot&{subjects?:string[];camera?:string};
const time=(value:number)=>`${Math.floor(value/60).toString().padStart(2,'0')}:${(value%60).toFixed(2).padStart(5,'0')}`;
const sizeNames:Record<string,string>={'extreme-close':'大特写',close:'特写','medium-close':'中近景',medium:'中景','medium-wide':'中远景',wide:'全景','extreme-wide':'大远景'};
const cameraNames:Record<string,string>={static:'固定机位','tilt-up':'上摇','tilt-down':'下摇','pan-right':'向右摇','pan-left':'向左摇','push-in':'推进','pull-out':'拉远',tracking:'跟随'};
const shotColor=(shot:ReviewShot)=>shot.subjects?.length===1?(shot.subjects[0]==='P1'?'#9c5c3d':'#3f6890'):'#727b82';
const initialState:ComparisonState={frame:0,playing:false,ready:false,seeking:false,buffering:false,rate:1,audio:false,error:null};

export function VideoComparison({shots,fps=24}:{shots:ReviewShot[];fps?:number}){
  const root=useRef<HTMLDivElement>(null),reference=useRef<HTMLVideoElement>(null),rendered=useRef<HTMLVideoElement>(null);
  const clock=useRef<ComparisonClock|null>(null),list=useRef<HTMLDivElement>(null),secondsInput=useRef<HTMLInputElement>(null);
  const[state,setState]=useState<ComparisonState>(initialState),[mode,setMode]=useState<Mode>('side'),[opacity,setOpacity]=useState(.5),[grid,setGrid]=useState(false),[jumpSeconds,setJumpSeconds]=useState('0.000'),[inputError,setInputError]=useState('');
  const modeRef=useRef(mode),opacityRef=useRef(opacity);modeRef.current=mode;opacityRef.current=opacity;
  const totalFrames=Math.max(1,...shots.map(shot=>shot.endFrameExclusive));
  const currentIndex=Math.max(0,shots.findIndex(shot=>state.frame>=shot.startFrame&&state.frame<shot.endFrameExclusive));
  const current=shots[currentIndex];

  useEffect(()=>{
    const engine=new ComparisonClock({reference:reference.current!,rendered:rendered.current!,fps,totalFrames,onChange:setState});clock.current=engine;
    (window as any).__comparisonProbe=()=>({...engine.getState(),fps,totalFrames,mode:modeRef.current,opacity:opacityRef.current,referenceTime:reference.current?.currentTime,renderedTime:rendered.current?.currentTime,referenceMuted:reference.current?.muted,renderedMuted:rendered.current?.muted,referenceRate:reference.current?.playbackRate,renderedRate:rendered.current?.playbackRate});
    const keydown=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null;
      if(event.altKey||event.ctrlKey||event.metaKey||target?.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(event.code==='Space'){
        if(target?.closest('button,a'))return;
        event.preventDefault();const current=engine.getState();if(current.playing||current.buffering)engine.pause();else void engine.play();
      }else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        event.preventDefault();const direction=event.key==='ArrowLeft'?-1:1;const frame=engine.getState().frame;
        if(event.shiftKey)engine.seekFrame(frame+direction);
        else{const index=Math.max(0,shots.findIndex(shot=>frame>=shot.startFrame&&frame<shot.endFrameExclusive));engine.seekFrame(shots[Math.max(0,Math.min(shots.length-1,index+direction))]?.startFrame||0);}
      }
    };
    window.addEventListener('keydown',keydown);
    return()=>{window.removeEventListener('keydown',keydown);engine.dispose();clock.current=null;delete(window as any).__comparisonProbe;};
  },[fps,totalFrames,shots]);

  useEffect(()=>{if(document.activeElement!==secondsInput.current)setJumpSeconds((state.frame/fps).toFixed(3));},[state.frame,fps]);
  useEffect(()=>{
    const viewport=list.current,row=viewport?.querySelector<HTMLElement>('[aria-current="true"]');if(!viewport||!row)return;
    const outer=viewport.getBoundingClientRect(),inner=row.getBoundingClientRect();
    if(inner.top<outer.top||inner.bottom>outer.bottom)viewport.scrollTop+=inner.top-outer.top-viewport.clientHeight/2+inner.height/2;
  },[current?.id]);

  const seek=(frame:number)=>{setInputError('');clock.current?.seekFrame(frame);};
  const toggle=()=>{const engine=clock.current;if(!engine)return;const now=engine.getState();if(now.playing||now.buffering)engine.pause();else void engine.play();};
  const jump=()=>{const value=Number(jumpSeconds);if(!jumpSeconds.trim()||!Number.isFinite(value)){setInputError('请输入有效的秒数。');return;}seek(Math.round(value*fps));};
  const unavailable=!state.ready||!!state.error;
  const active=state.playing||state.buffering;

  return <div className="vcmp" ref={root} tabIndex={0} aria-label="原片与三维视频对照播放器" onPointerDown={event=>{if(!(event.target as HTMLElement).closest('button,input,select,textarea,a'))root.current?.focus({preventScroll:true});}}>
    <div className="vcmp-header"><div><h2>原片与三维还原 · 同步对照</h2><p>同一时间、同一画幅，检查动作与构图</p></div><span className="vcmp-mode-badge">{fps} fps · {totalFrames} 帧</span></div>
    <div className={`vcmp-screen mode-${mode}${grid&&mode==='overlay'?' with-grid':''}`}>
      <div className="vcmp-pane rendered-pane"><video className="vcmp-video" ref={rendered} src="/demo/v2.mp4" preload="auto" playsInline muted aria-label="三维还原视频"/><span className="vcmp-video-label">三维还原 · 旧版 V2</span></div>
      <div className="vcmp-pane reference-pane"><video className="vcmp-video" ref={reference} src="/reference.mp4" preload="auto" playsInline muted style={{opacity:mode==='overlay'?opacity:1}} aria-label="原片视频"/><span className="vcmp-video-label">原片</span></div>
      {(state.seeking||state.buffering||!state.ready)&&!state.error&&<div className="vcmp-waiting" role="status">{!state.ready?'正在载入两路画面…':state.seeking?'正在对齐到目标帧…':'正在缓冲，同步播放稍后继续…'}</div>}
    </div>
    {mode==='overlay'&&<div className="vcmp-alignment"><label>原片叠加 <input aria-label="原片叠加比例" type="range" min="0" max="100" value={Math.round(opacity*100)} onChange={event=>setOpacity(Number(event.target.value)/100)}/><output>{Math.round(opacity*100)}%</output></label><span>0% 看三维 · 100% 看原片</span><label><input type="checkbox" checked={grid} onChange={event=>setGrid(event.target.checked)}/>三分参考线</label></div>}
    <div className="vcmp-transport">
      <div className="vcmp-timeline-heading"><h3>镜头时间线</h3><div className="vcmp-time-display"><span>第 {state.frame+1} / {totalFrames} 帧</span><strong>{time(state.frame/fps)} / {time(totalFrames/fps)}</strong></div></div>
      <div className="vcmp-shot-strip" role="group" aria-label="镜头时间带">{shots.map(shot=><button className={`vcmp-shot-segment ${shot.id===current?.id?'is-current':''}`} style={{flexGrow:shot.endFrameExclusive-shot.startFrame,flexBasis:0,backgroundColor:shotColor(shot)}} key={shot.id} disabled={unavailable} aria-label={`时间带 ${shot.id} ${time(shot.start)}`} aria-current={shot.id===current?.id?'true':undefined} title={`${shot.id} · ${time(shot.start)} · ${shot.frame}`} onClick={()=>seek(shot.startFrame)}/>)}</div>
      <input className="vcmp-scrubber" aria-label="视频进度（帧）" type="range" min="0" max={totalFrames-1} step="1" value={state.frame} disabled={unavailable} onChange={event=>seek(Number(event.target.value))}/>
      <div className="vcmp-controls">
        <button className={`vcmp-play ${active?'is-playing':''}`} onClick={toggle} disabled={unavailable}>{active?'Ⅱ 暂停':'▶ 播放'}</button>
        <button onClick={()=>seek(0)} disabled={unavailable}>↺ 从头</button>
        <button onClick={()=>seek((clock.current?.getState().frame||0)-1)} disabled={unavailable||state.frame===0}>‹ 上一帧</button>
        <button onClick={()=>seek((clock.current?.getState().frame||0)+1)} disabled={unavailable||state.frame===totalFrames-1}>下一帧 ›</button>
        <label>秒 <input ref={secondsInput} aria-label="跳转秒数" type="number" min="0" max={(totalFrames-1)/fps} step="0.001" value={jumpSeconds} onChange={event=>{setJumpSeconds(event.target.value);setInputError('');}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();jump();}}}/></label><button onClick={jump} disabled={unavailable}>跳转</button>
        <span className="vcmp-divider"/>
        <div className="vcmp-mode-switch" role="group" aria-label="显示方式">{([['rendered','三维单看'],['side','并排对照'],['overlay','叠加对齐']] as const).map(([value,label])=><button key={value} className={mode===value?'is-selected':''} aria-pressed={mode===value} onClick={()=>setMode(value)}>{label}</button>)}</div>
        <button onClick={()=>clock.current?.setAudio(!state.audio)} disabled={unavailable} aria-pressed={state.audio}>原声{state.audio?'开':'关'}</button>
        <label>速度 <select aria-label="播放速度" value={state.rate} onChange={event=>clock.current?.setRate(Number(event.target.value))}>{[.25,.5,1,1.5,2].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label>
      </div>
      <p className="vcmp-keyboard-help">点击画面后：空格播放／暂停 · ← → 切镜 · Shift + ← → 逐帧。定位会暂停，点击播放继续。</p>
      {(state.error||inputError)&&<div className="vcmp-error" role="alert">{state.error||inputError}{state.error&&<button onClick={()=>window.location.reload()}>重新载入</button>}</div>}
    </div>
    <div className="vcmp-info-grid">
      <section className="vcmp-current-shot"><h3>当前镜头 · {current?.id}</h3><p>{current&&`${time(current.start)}–${time(current.end)} · ${current.seconds.toFixed(2)} 秒`}</p><h2>{sizeNames[current?.size]||'镜头画面'} · {cameraNames[current?.camera||'']||'原片机位'}</h2><p>{current?.frame}</p><div className="vcmp-legend">橙色对应 P1，蓝色对应 P2。叠加模式用原片覆盖三维画面，拖动比例滑杆检查人物轮廓、地面与背景的位置差异。</div></section>
      <section className="vcmp-shot-table"><div className="vcmp-timeline-heading"><h3>镜头表</h3><span>点击镜头跳到首帧</span></div><div className="vcmp-shot-list" ref={list}>{shots.map(shot=><button key={shot.id} className={`vcmp-shot-row ${shot.id===current?.id?'is-current':''}`} aria-current={shot.id===current?.id?'true':undefined} disabled={unavailable} onClick={()=>seek(shot.startFrame)}><strong>{shot.id}</strong><div><h4>{sizeNames[shot.size]||'镜头画面'}</h4><p>{shot.frame}</p></div><time>{time(shot.start)}</time></button>)}</div></section>
    </div>
  </div>;
}
