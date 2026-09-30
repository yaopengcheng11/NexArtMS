// Isolated browser fixture: simulated media clock and local data; no project API or real media access.
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Playback source-clock fixture</title></head><body><div id="root"></div><script type="module">
import React, {useRef,useState,useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {StudioPlayback} from '/src/StudioPlayback.tsx';
import '/src/style.css';
import '/src/studio.css';
const times=new WeakMap(), playing=new WeakSet();
Object.defineProperty(HTMLMediaElement.prototype,'currentTime',{get(){return times.get(this)||0;},set(value){times.set(this,value);queueMicrotask(()=>{this.dispatchEvent(new Event('timeupdate'));this.dispatchEvent(new Event('seeked'));});},configurable:true});
Object.defineProperty(HTMLMediaElement.prototype,'duration',{get(){return 3;},configurable:true});
Object.defineProperty(HTMLMediaElement.prototype,'paused',{get(){return !playing.has(this);},configurable:true});
HTMLMediaElement.prototype.pause=function(){playing.delete(this);this.dispatchEvent(new Event('pause'));};
HTMLMediaElement.prototype.play=function(){playing.add(this);this.dispatchEvent(new Event('play'));return Promise.resolve();};
const detail={project:{id:'fixture',revision:'fixture'},media:{id:'source',width:640,height:360,ptsCount:4},shots:[{id:'S01',idx:0,startFrame:0,endFrameExclusive:2,startUs:2400000,endUs:3400000},{id:'S02',idx:1,startFrame:2,endFrameExclusive:4,startUs:3400000,endUs:5400000}],tracks:[{id:'T1',shotId:'S02',subject:'person',status:'active',startFrame:2,endFrame:3,startUs:3400000,endUs:5400000,box:{x:.3,y:.1,w:.25,h:.8}}],characters:[{id:'C1',name:'人物一',scale:1.75,color:'#547a94',proxyLevel:'CL1'}],bindings:[{trackId:'T1',characterId:'C1',disposition:'bound'}],cameraTracks:[],motionRefs:{},motionVersions:{}};
function Fixture(){
 const [active,setActive]=useState(true),[position,setPosition]=useState({timeUs:2400000,requestId:0}),[inspect,setInspect]=useState('');
 const report=useRef({timeUs:2400000,shotId:'S01'}),calls=useRef(0),saved=useRef(2400000);
 useEffect(()=>{const timer=setInterval(()=>{const video=document.querySelector('video');setInspect(JSON.stringify({sourceUs:report.current.timeUs,shotId:report.current.shotId,videoSeconds:video?.currentTime,paused:video?.paused,canvasCount:document.querySelectorAll('canvas').length,positionReports:calls.current}));},100);return()=>clearInterval(timer);},[]);
 const seek=timeUs=>setPosition(value=>({timeUs,requestId:value.requestId+1}));
 return React.createElement('main',{style:{maxWidth:1100,margin:'24px auto',padding:20}},
  React.createElement('h1',null,'隔离播放验证（模拟媒体时钟）'),
  React.createElement('div',{className:'studio-toolbar'},
   React.createElement('button',{onClick:()=>document.querySelector('video').play()},'模拟开始播放'),
   React.createElement('button',{onClick:()=>seek(4150000)},'外部定位第二镜'),
   React.createElement('button',{onClick:()=>{saved.current=report.current.timeUs;setActive(false);}},'隐藏工作区'),
   React.createElement('button',{onClick:()=>{seek(saved.current);setActive(true);}},'恢复原位置'),
   React.createElement('button',{onClick:()=>seek(2400000)},'外部定位第一镜')),
  React.createElement('output',{id:'fixture-state',style:{display:'block',margin:'12px 0'}},inspect),
  React.createElement('div',{hidden:!active},React.createElement(StudioPlayback,{detail,active,playbackPosition:position,onPositionChange:next=>{report.current=next;calls.current++;}})));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;
const fixturePlugin = {name: 'isolated-playback-fixture', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith('/api/')) {
      res.setHeader('Content-Type','application/json');
      if (req.url.endsWith('/media/pts')) return res.end(JSON.stringify({ready:true,ptsUs:[2400000,2473000,3400000,3515000]}));
      res.statusCode=204;return res.end();
    }
    if (req.url !== '/playback-fixture') return next();
    res.setHeader('Content-Type','text/html');
    res.end(await server.transformIndexHtml(req.url,html));
  });
}};
const server = await createServer({configFile:false,root,plugins:[react(),fixturePlugin],server:{host:'127.0.0.1',port:8207,strictPort:true}});
await server.listen();
console.log('Isolated fixture: http://127.0.0.1:8207/playback-fixture');
