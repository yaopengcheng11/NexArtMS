import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStudioStore} from './studio/db.mjs';
import {createJobRunner} from './studio/jobs.mjs';
import {createStudioRouter} from './studio/router.mjs';
import {DEFAULT_LIMITS} from './studio/media.mjs';
import {registerVisionDetector} from './studio/vision.mjs';
// root = 代码与静态资源所在目录（app/）；数据根默认为仓库根（root 的上一级），
// 与 app/ 平级的 data/ 保存用户项目、数据库与模型权重。STUDIO_DATA_ROOT 仍可为
// 测试指定独立数据目录（其中的 data/ 子目录作为数据根）。
const root=path.dirname(fileURLToPath(import.meta.url));
const dataRoot=process.env.STUDIO_DATA_ROOT?path.resolve(process.env.STUDIO_DATA_ROOT):path.resolve(root,'..');
const port=Number(process.env.PORT||8199);
const studioStore=createStudioStore(dataRoot);
const studioJobs=createJobRunner(studioStore,dataRoot,DEFAULT_LIMITS);
const studioRouter=createStudioRouter(studioStore,dataRoot,{limits:DEFAULT_LIMITS,jobs:studioJobs});
registerVisionDetector(dataRoot).then(runner=>{if(runner)console.log('[studio] 已加载人物检测/姿态模型；detect 任务可用');else console.log('[studio] 未配置人物检测模型（node scripts/fetch-detector-model.mjs 可启用）；detect 任务将如实失败');}).catch(cause=>console.log('[studio] 检测模型加载失败：',cause.message));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.mp4':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.md':'text/plain; charset=utf-8'};
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/studio/')){
      const handled=await studioRouter(req,res);
      if(handled)return;
    }
    if(url.pathname.startsWith('/api/')){
      res.writeHead(404).end(JSON.stringify({error:'接口不存在'}));return;
    }
    const pathname=decodeURIComponent(url.pathname);const suffix=pathname==='/'?'index.html':pathname.slice(1);
    if(suffix.split('/').includes('..')){res.writeHead(403).end();return;}
    let file=path.join(root,'dist',suffix);if(!fs.existsSync(file))file=path.join(root,'public',suffix);
    if(!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end('Not found');return;}
    const size=fs.statSync(file).size;const headers={'Content-Type':types[path.extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'no-cache'};
    const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const serve=(extra)=>{const stream=fs.createReadStream(file,extra);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);};
    if(range){const start=+range[1],end=range[2]?Math.min(+range[2],size-1):size-1;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`});serve({start,end});}
    else{res.writeHead(200,{...headers,'Content-Length':size});serve({});}
  }catch(e){res.writeHead(e.status||400,{'Content-Type':'application/json'}).end(JSON.stringify({error:e.message}));}
});
server.listen(port,'127.0.0.1',()=>console.log(`MotionStage 混剪项目 http://127.0.0.1:${port}/`));
