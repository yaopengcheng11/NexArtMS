import test from 'node:test';
import assert from 'node:assert/strict';
import {isProjectMediaUrl,suspendProjectMedia} from '../src/studio-project-media';

test('preview release uses an exact project path on the current origin',()=>{
  const base='http://127.0.0.1:8215/?project=p-current';
  for(const value of ['/api/studio/projects/p-current/media/preview','http://127.0.0.1:8215/api/studio/projects/p-current/shots/s1/preview?version=2'])assert.equal(isProjectMediaUrl(value,'p-current',base),true);
  for(const value of ['/api/studio/projects/p-current-other/media/preview','/api/studio/projects/p-other/media/preview','http://127.0.0.1:8216/api/studio/projects/p-current/media/preview','https://example.test/api/studio/projects/p-current/media/preview','data:image/png;base64,a',null])assert.equal(isProjectMediaUrl(value,'p-current',base),false);
});

// A small DOM contract fixture keeps state restoration deterministic; browser playback is
// also covered by the deletion acceptance probe, without requiring Chromium for unit tests.
class ElementFixture {
  attrs=new Map<string,string>();isConnected=true;currentTime=8;paused=false;ended=false;
  pauses=0;loads=0;plays=0;children:ElementFixture[]=[];events=new Map<string,()=>void>();
  constructor(src:string){this.attrs.set('src',src);}
  get currentSrc(){return this.attrs.get('src')||'';}
  getAttribute(name:string){return this.attrs.get(name)||null;}
  hasAttribute(name:string){return this.attrs.has(name);}
  setAttribute(name:string,value:string){this.attrs.set(name,value);}
  removeAttribute(name:string){this.attrs.delete(name);}
  querySelectorAll(){return this.children;}
  pause(){this.pauses++;this.paused=true;}
  load(){this.loads++;this.currentTime=0;}
  async play(){this.plays++;this.paused=false;}
  addEventListener(name:string,callback:()=>void){this.events.set(name,callback);}
  removeEventListener(name:string){this.events.delete(name);}
}
function fixture(){
  const current=new ElementFixture('/api/studio/projects/p-current/media/preview');
  const other=new ElementFixture('/api/studio/projects/p-other/media/preview');
  const image=new ElementFixture('/api/studio/projects/p-current/shots/s1/preview');
  const scope={baseURI:'http://127.0.0.1:8215/',querySelectorAll:(selector:string)=>selector==='video,audio'?[current,other]:[image]} as unknown as Document;
  return {scope,current,other,image};
}
test('failed deletion restores project previews and their playback state without touching another project',()=>{
  const {scope,current,other,image}=fixture();
  const suspended=suspendProjectMedia(scope,'p-current');
  assert.equal(current.getAttribute('src'),null);assert.equal(current.pauses,1);assert.equal(current.loads,1);
  assert.equal(image.getAttribute('src'),null);
  assert.equal(other.pauses,0);assert.equal(other.loads,0);
  suspended.restore();
  assert.equal(current.getAttribute('src'),'/api/studio/projects/p-current/media/preview');
  assert.equal(image.getAttribute('src'),'/api/studio/projects/p-current/shots/s1/preview');
  current.events.get('loadedmetadata')?.();
  assert.equal(current.currentTime,8);assert.equal(current.paused,false);assert.equal(current.plays,1);
  suspended.restore();assert.equal(current.loads,2);
});
test('successful deletion does not reopen previews and failed deletion preserves replaced or unmounted sources',()=>{
  const success=fixture();const discarded=suspendProjectMedia(success.scope,'p-current');
  discarded.discard();discarded.restore();assert.equal(success.current.getAttribute('src'),null);
  const changed=fixture();const suspended=suspendProjectMedia(changed.scope,'p-current');
  changed.current.setAttribute('src','/api/studio/projects/p-other/media/preview');changed.image.isConnected=false;
  suspended.restore();assert.equal(changed.current.getAttribute('src'),'/api/studio/projects/p-other/media/preview');
  assert.equal(changed.current.loads,1);assert.equal(changed.image.getAttribute('src'),null);
});
