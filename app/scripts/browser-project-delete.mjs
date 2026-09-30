// Real browser / HTTP regression fixture. All project data lives in a new OS temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {createStudioStore} from '../studio/db.mjs';
import {createJobRunner} from '../studio/jobs.mjs';
import {createStudioRouter} from '../studio/router.mjs';
import {DEFAULT_LIMITS} from '../studio/media.mjs';

const repo=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot=path.dirname(repo); // 仓库根：验证报告写 docs/reports/
const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-delete-browser-'));
const reportDir=path.join(repoRoot,'docs','reports','project-delete-acceptance');
fs.mkdirSync(reportDir,{recursive:true});
const store=createStudioStore(root);
function fixture(name){
  const project=store.createProject({name,sceneMode:'proxy'});
  const file=path.join(store.mediaDir(project.id),'fixture.mp4');
  execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc2=size=160x120:rate=12:duration=20','-c:v','libx264','-pix_fmt','yuv420p',file],{windowsHide:true});
  const ref=path.relative(root,file);
  store.insertMedia(project.id,{id:`m-${project.id}`,sha256:'a'.repeat(64),originalName:'fixture.mp4',originalRef:ref,proxyRef:ref,durationUs:20e6,width:160,height:120,rotation:0,timebase:'1/12',fpsNum:12,fpsDen:1,vfr:false,videoCodec:'h264',audioCodec:null,ptsCount:240,sizeBytes:fs.statSync(file).size,baseRevision:store.getProjectRow(project.id).revision});
  store.replaceShots(project.id,[{id:'S01',startFrame:0,endFrameExclusive:240,startUs:0,endUs:20e6}],'user',store.getProjectRow(project.id).revision);
  return project;
}
const project=fixture('删除预览锁验收');
const other=fixture('其他项目保持播放');
const router=createStudioRouter(store,root,{jobs:createJobRunner(store,root,DEFAULT_LIMITS)});
let firstDelete=true;
const server=http.createServer(async(req,res)=>{
  try {
    if(req.method==='DELETE'&&req.url===`/api/studio/projects/${project.id}`&&firstDelete){
      firstDelete=false;
      await new Promise(resolve=>setTimeout(resolve,800));
      res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'验收注入：项目暂时无法删除'}));return;
    }
    if(await router(req,res))return;
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=pathname.startsWith('/assets/')?path.join(repo,'dist',pathname):path.join(repo,'dist','index.html');
    if(!file.startsWith(path.join(repo,'dist'))||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
    res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    fs.createReadStream(file).pipe(res);
  }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1365,height:1000}});
const errors=[];page.on('pageerror',error=>errors.push(String(error)));
const checks=[];
const check=(name,result)=>{checks.push({name,pass:!!result});assert.ok(result,name);};
try {
  await page.goto(`${base}/?project=${project.id}`);
  await page.getByRole('button',{name:'项目设置',exact:true}).waitFor();
  const video=page.getByLabel('拉片原片预览');
  await video.evaluate(async element=>{element.muted=true;element.loop=true;await element.play();element.currentTime=8;});
  await page.evaluate(async otherId=>{
    const other=document.createElement('video');other.id='other-project-video';other.src=`/api/studio/projects/${otherId}/media/preview`;other.muted=true;other.loop=true;document.body.append(other);await other.play();
  },other.id);
  if(!await page.locator('.studio-later-stages').evaluate(element=>element.open))await page.locator('.studio-later-stages > summary').click();
  await page.locator('.studio-role-setup > summary').click();
  await page.getByLabel('片中角色数').fill('7');
  await page.getByRole('button',{name:'项目设置',exact:true}).click();
  await page.getByLabel('修改项目名称').fill('未保存名称草稿');
  await page.getByLabel('项目说明',{exact:true}).fill('未保存说明草稿');
  await page.getByLabel('输入项目名称确认删除').fill(project.name);
  await page.getByRole('button',{name:'永久删除项目'}).click();
  await page.getByRole('button',{name:'正在删除项目…'}).waitFor();
  check('删除等待中释放同项目所有视频源',await page.locator('.studio video').evaluateAll(elements=>elements.every(element=>element.paused&&!element.getAttribute('src'))));
  check('其他项目视频继续播放',await page.locator('#other-project-video').evaluate(element=>!element.paused&&!!element.getAttribute('src')));
  await page.keyboard.press('Escape');
  check('删除等待时Esc不能关闭设置',await page.locator('dialog').evaluate(element=>element.open));
  await page.getByRole('alert').filter({hasText:'验收注入'}).waitFor();
  await page.waitForFunction(()=>{const video=document.querySelector('[aria-label="拉片原片预览"]');return video&&!video.paused&&video.currentTime>=8;});
  check('失败恢复视频源播放位置和播放状态',await video.evaluate(element=>!element.paused&&element.currentTime>=8&&element.currentTime<12));
  check('失败保留项目设置草稿',await page.getByLabel('修改项目名称').inputValue()==='未保存名称草稿'&&await page.getByLabel('项目说明',{exact:true}).inputValue()==='未保存说明草稿');
  check('失败保留工作台未保存编辑',await page.getByLabel('片中角色数').inputValue()==='7');
  check('失败保留项目及素材',!!store.getProjectRow(project.id)&&fs.existsSync(store.projectDir(project.id)));
  await page.screenshot({path:path.join(reportDir,'failure-restored.png')});
  await page.getByRole('button',{name:'永久删除项目'}).click();
  await page.getByRole('heading',{name:'项目列表',exact:true}).waitFor();
  check('同页视频播放中删除成功并返回列表',store.getProjectRow(project.id)===null&&!fs.existsSync(store.projectDir(project.id)));
  check('其他项目数据和视频不受删除影响',!!store.getProjectRow(other.id)&&fs.existsSync(store.projectDir(other.id))&&await page.locator('#other-project-video').evaluate(element=>!element.paused));
  check('没有页面脚本异常',errors.length===0);
  await page.screenshot({path:path.join(reportDir,'deleted.png')});
}finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
  assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('studio-delete-browser-'));
  fs.rmSync(root,{recursive:true,force:true,maxRetries:5});
  const result={checks,errors,passed:checks.filter(check=>check.pass).length};
  fs.writeFileSync(path.join(reportDir,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
