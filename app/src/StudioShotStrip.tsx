import React,{useEffect,useRef,useState} from 'react';

export interface ShotStripItem{
  id:string;index:number;startUs:number;endUs:number;
  thumbnail?:string;status?:string;description?:string;meta?:string;dirty?:boolean;
}
export const shotTime=(us:number)=>{
  const milliseconds=Math.max(0,Math.round(us/1000));
  return `${String(Math.floor(milliseconds/60000)).padStart(2,'0')}:${String(Math.floor(milliseconds/1000)%60).padStart(2,'0')}.${String(milliseconds%1000).padStart(3,'0')}`;
};

/** One locator, with two mutually exclusive presentations of the same selection. */
export function StudioShotStrip({items,selectedId,onSelect,scopeLabel='全部镜头',emptyMessage='镜头准备好后会出现在这里。',disabled=false}:{
  items:ShotStripItem[];selectedId:string;onSelect:(item:ShotStripItem)=>void;scopeLabel?:string;emptyMessage?:string;disabled?:boolean;
}){
  const[expanded,setExpanded]=useState(false);
  const selected=useRef<HTMLButtonElement|null>(null);
  const viewport=useRef<HTMLDivElement|null>(null);
  useEffect(()=>{
    const follow=()=>{
    const button=selected.current,container=viewport.current;
    if(!button||!container||button.closest('[hidden]')||!button.getClientRects().length)return;
    const item=button.getBoundingClientRect(),bounds=container.getBoundingClientRect();
    // Follow the shot inside the locator without moving the watched picture/page.
    if(expanded){const delta=item.top<bounds.top?item.top-bounds.top:item.bottom>bounds.bottom?item.bottom-bounds.bottom:0;if(delta)container.scrollTop+=delta;}
    else{const delta=item.left<bounds.left?item.left-bounds.left:item.right>bounds.right?item.right-bounds.right:0;if(delta)container.scrollLeft+=delta;}
    };
    follow();
    const container=viewport.current;if(!container)return;
    const observer=new ResizeObserver(follow);observer.observe(container);
    return()=>observer.disconnect();
  },[selectedId,expanded,scopeLabel]);
  return <section className="workspace-shot-locator" aria-label="镜头定位">
    <div className="workspace-shot-heading"><span>{scopeLabel} <small>· {items.length} 镜</small></span><button className="quiet-action" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收起镜头表':'展开镜头表'}</button></div>
    {!items.length?<p className="workspace-empty muted">{emptyMessage}</p>:<div ref={viewport} className={`workspace-shot-items ${expanded?'is-table':'is-strip'}`} data-presentation={expanded?'list':'strip'} aria-label={expanded?'镜头表':'镜头条'}>
      {items.map(item=><button key={item.id} ref={item.id===selectedId?selected:undefined} className="workspace-shot-item" aria-pressed={item.id===selectedId} disabled={disabled} onClick={()=>onSelect(item)} aria-label={`第${item.index+1}镜 · ${shotTime(item.startUs)}${item.dirty?' · 未保存':''}`}>
        {item.thumbnail?<img src={item.thumbnail} alt="" loading="lazy"/>:<span className="workspace-shot-placeholder" aria-hidden="true">{String(item.index+1).padStart(2,'0')}</span>}
        <span className="workspace-shot-caption"><b>第 {item.index+1} 镜</b><small>{shotTime(item.startUs)}{expanded?` — ${shotTime(item.endUs)}`:''}</small>{expanded&&<><span className="workspace-shot-description">{item.description||'暂无镜头描述'}</span>{item.meta&&<small>{item.meta}</small>}</>}{item.status&&<span className="workspace-shot-status">{item.status}</span>}{item.dirty&&<em>未保存</em>}</span>
      </button>)}
    </div>}
  </section>;
}
