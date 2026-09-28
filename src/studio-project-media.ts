/** Match only this server's resource URLs for one exact project. */
export function isProjectMediaUrl(value:string|null,projectId:string,baseUrl:string):boolean {
  if(!value)return false;
  try {
    const base=new URL(baseUrl);
    const url=new URL(value,base);
    return url.origin===base.origin&&url.pathname.startsWith(`/api/studio/projects/${encodeURIComponent(projectId)}/`);
  } catch {return false;}
}

/** Release browser requests without unmounting editors; restore only after a failed deletion. */
export function suspendProjectMedia(scope:Document|HTMLElement,projectId:string) {
  const baseUrl=scope.ownerDocument?.baseURI||scope.baseURI;
  const belongs=(value:string|null)=>isProjectMediaUrl(value,projectId,baseUrl);
  const attributes:{element:Element;name:string;value:string}[]=[];
  const media:{element:HTMLMediaElement;time:number;playing:boolean}[]=[];
  let settled=false;
  const releaseAttribute=(element:Element,name:string,srcset=false)=>{
    const value=element.getAttribute(name);
    if(value&&(srcset?value.split(',').some(candidate=>belongs(candidate.trim().split(/\s+/)[0])):belongs(value))){
      attributes.push({element,name,value});element.removeAttribute(name);
      return true;
    }
    return false;
  };
  for(const element of scope.querySelectorAll<HTMLMediaElement>('video,audio')){
    const sources=[...element.querySelectorAll('source')];
    const source=element.currentSrc||element.getAttribute('src');
    const selected=belongs(source)||(!source&&sources.some(item=>belongs(item.getAttribute('src'))));
    if(selected){
      media.push({element,time:element.currentTime,playing:!element.paused&&!element.ended});
      element.pause();
    }
    const released=releaseAttribute(element,'src');
    for(const child of sources)releaseAttribute(child,'src');
    releaseAttribute(element,'poster');
    if(selected||released)element.load();
  }
  for(const element of scope.querySelectorAll('img,picture source')){
    releaseAttribute(element,'src');releaseAttribute(element,'srcset',true);
  }
  return {
    restore(){
      if(settled)return;
      settled=true;
      const restored=new Set<Element>();
      for(const {element,name,value} of attributes){
        // A re-render or navigation may have deliberately replaced the source.
        if(element.isConnected&&!element.hasAttribute(name)){
          element.setAttribute(name,value);restored.add(element);
        }
      }
      for(const {element,time,playing} of media){
        if(!element.isConnected||(!restored.has(element)&&![...element.querySelectorAll('source')].some(source=>restored.has(source))))continue;
        const resume=()=>{
          element.removeEventListener('error',cancel);
          if(!element.isConnected)return;
          if(Number.isFinite(time))element.currentTime=time;
          if(playing)void element.play().catch(()=>{});
        };
        const cancel=()=>element.removeEventListener('loadedmetadata',resume);
        element.addEventListener('loadedmetadata',resume,{once:true});
        element.addEventListener('error',cancel,{once:true});
        element.load();
      }
    },
    discard(){settled=true;}
  };
}
