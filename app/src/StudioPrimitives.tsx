import React,{useEffect,useId,useRef,type ReactNode} from 'react';

export function StudioIcon({name}:{name:'back'|'film'|'more'|'close'|'upload'}){
  const paths={back:<path d="m14 5-7 7 7 7M7 12h14"/>,film:<><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 10h18M6 5l3 5m3-5 3 5m3-5 3 5M3 5l17-3"/></>,more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,close:<path d="m6 6 12 12M18 6 6 18"/>,upload:<><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/></>};
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function StudioDialog({open,title,onClose,children,className=''}:{open:boolean;title:string;onClose:()=>void;children:ReactNode;className?:string}){
  const element=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  useEffect(()=>{
    const dialog=element.current;if(!dialog)return;
    if(open&&!dialog.open){
      const trigger=document.activeElement as HTMLElement|null;
      const returnTo=trigger?.closest<HTMLDetailsElement>('details')?.querySelector<HTMLElement>('summary')||trigger;
      dialog.showModal();
      return()=>{dialog.close();if(returnTo?.isConnected&&returnTo.getClientRects().length)returnTo.focus();};
    }
    if(!open&&dialog.open)dialog.close();
  },[open]);
  useEffect(()=>{if(open&&element.current?.open)element.current.querySelector<HTMLButtonElement>('button')?.focus();},[title,open]);
  return <dialog ref={element} className={`workspace-dialog ${className}`} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}}>
    <header className="workspace-dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-action" aria-label={`关闭${title}`} onClick={onClose}><StudioIcon name="close"/></button></header>
    <div className="workspace-dialog-content">{children}</div>
  </dialog>;
}
