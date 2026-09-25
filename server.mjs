import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStore} from './project-store.mjs';
import {createRehearsalStore} from './rehearsal-store.mjs';
import {createStudioStore} from './studio/db.mjs';
import {createJobRunner} from './studio/jobs.mjs';
import {createStudioRouter} from './studio/router.mjs';
import {DEFAULT_LIMITS} from './studio/media.mjs';
import {registerVisionDetector} from './studio/vision.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const store=createStore(root);const port=Number(process.env.PORT||8199);
const rehearsalStore=createRehearsalStore(root,store);
const studioStore=createStudioStore(root);
const studioJobs=createJobRunner(studioStore,root,DEFAULT_LIMITS);
const studioRouter=createStudioRouter(studioStore,root,{limits:DEFAULT_LIMITS,jobs:studioJobs});
registerVisionDetector(root).then(runner=>{if(runner)console.log('[studio] 已加载人物检测/姿态模型；detect 任务可用');else console.log('[studio] 未配置人物检测模型（node scripts/fetch-detector-model.mjs 可启用）；detect 任务将如实失败');}).catch(cause=>console.log('[studio] 检测模型加载失败：',cause.message));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.md':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/studio/')){
      const handled=await studioRouter(req,res);
      if(handled)return;
    }
    if(url.pathname.startsWith('/api/')){
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      if(req.method==='GET'&&url.pathname==='/api/project'){res.end(JSON.stringify(store.read()));return;}
      if(req.method==='GET'&&url.pathname==='/api/rehearsal'){res.end(JSON.stringify(rehearsalStore.read()));return;}
      let data='';for await(const b of req){data+=b;if(data.length>2e6)throw new Error('请求过大');}const body=JSON.parse(data||'{}');
      if(req.method==='POST'&&url.pathname==='/api/scene'){res.end(JSON.stringify(store.update(body.baseRevision,body.scene,body.feedback)));return;}
      if(req.method==='POST'&&url.pathname==='/api/approve-scene'){res.end(JSON.stringify(store.approve(body.baseRevision)));return;}
      if(req.method==='POST'&&url.pathname==='/api/rehearsal/start'){res.end(JSON.stringify(rehearsalStore.start(body.baseRevision,body.restart)));return;}
      if(req.method==='POST'&&url.pathname==='/api/rehearsal/advance'){res.end(JSON.stringify(rehearsalStore.advance(body.baseRevision,body.stage)));return;}
      res.writeHead(404).end(JSON.stringify({error:'接口不存在'}));return;
    }
    const pathname=decodeURIComponent(url.pathname);const suffix=pathname==='/'?'index.html':pathname.slice(1);
    if(suffix.split('/').includes('..')){res.writeHead(403).end();return;}
    let file=path.join(root,'dist',suffix);if(!fs.existsSync(file))file=path.join(root,'public',suffix);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end('Not found');return;}
    const size=fs.statSync(file).size;const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-cache'};
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if(range){const start=+range[1],end=range[2]?Math.min(+range[2],size-1):size-1;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`});fs.createReadStream(file,{start,end}).pipe(res);}
    else{res.writeHead(200,{...headers,'Content-Length':size});fs.createReadStream(file).pipe(res);}
  }catch(e){res.writeHead(e.status||400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`混剪项目（主页） http://127.0.0.1:${port}/ · 场景工作台 http://127.0.0.1:${port}/?mode=scene`));
