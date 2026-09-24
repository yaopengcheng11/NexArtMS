import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.BASE_URL;
if(!base||!process.env.DISPOSABLE_REHEARSAL)throw new Error('Set BASE_URL and DISPOSABLE_REHEARSAL=1 for an isolated test project.');
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{},headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[];const stages=[];
try{
 const before=await(await fetch(base+'/api/project')).text();
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.waitForFunction(()=>typeof window.__sceneProbe==='function');
 await page.locator('#stage-confirmation').screenshot({path:path.join(root,'reports/rehearsal-entry.png')});
 assert.equal(await page.getByRole('button',{name:'确认场景通过',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'演练通过 → 角色确认',exact:true}).click();
 await page.waitForURL('**/?mode=rehearsal');
 await page.waitForFunction(()=>typeof window.__rigProbe==='function');
 let run=await(await fetch(base+'/api/rehearsal')).json();assert.equal(run.currentStage,2);assert.equal(run.decisions[0].stage,1);
 await page.screenshot({path:path.join(root,'reports/rehearsal-characters.png'),fullPage:true});stages.push(2);
 await page.reload();await page.waitForFunction(()=>typeof window.__rigProbe==='function');
 for(const expected of [3,4,5]){
  await page.getByRole('button',{name:/^演练通过 →/}).click();
  await page.waitForFunction(async expected=>{const r=await(await fetch('/api/rehearsal')).json();return r.currentStage===expected;},expected);
  run=await(await fetch(base+'/api/rehearsal')).json();assert.equal(run.currentStage,expected);stages.push(expected);
  if(expected===3){await page.waitForFunction(()=>{const i=document.querySelector('img[src="/demo/v2-frames/S33-middle.jpg"]');return i&&i.complete&&i.naturalWidth>0;});await page.screenshot({path:path.join(root,'reports/rehearsal-keyframes.png'),fullPage:true});}
  if(expected===4){await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2;});const duration=await page.getByLabel('三维还原视频',{exact:true}).evaluate(v=>v.duration);assert.ok(Math.abs(duration-50.125)<.05);}
 }
 const links=['/demo/v2.mp4','/probes/rig.glb','/probes/dcc/rig.blend','/probes/dcc/rig.fbx','/probes/dcc/rig.usdc'];
 for(const href of links){const response=await fetch(base+href);assert.equal(response.status,200);assert.ok(Number(response.headers.get('content-length'))>1000);await response.body.cancel();}
 const downloadEvent=page.waitForEvent('download');await page.locator('a[href="/probes/rig.glb"]').click();const download=await downloadEvent;assert.equal(await download.failure(),null);assert.ok(fs.statSync(await download.path()).size>1000);
 await page.getByRole('button',{name:'完成演练',exact:true}).click();
 await page.waitForFunction(async()=>{const r=await(await fetch('/api/rehearsal')).json();return r.status==='complete';});
 run=await(await fetch(base+'/api/rehearsal')).json();assert.equal(run.decisions.length,5);assert.deepEqual(run.decisions.map(d=>d.decision),Array(5).fill('demo_passed'));
 await page.reload();await page.getByRole('button',{name:/重新演练/}).waitFor();await page.screenshot({path:path.join(root,'reports/rehearsal-complete.png'),fullPage:true});
 assert.equal(await(await fetch(base+'/api/project')).text(),before);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'reports/rehearsal-browser.json'),JSON.stringify({homepageEntry:true,stagesVisited:stages,decisions:run.decisions,refreshResume:true,downloadsChecked:links,glbDownload:true,completed:true,formalProjectUnchanged:true,errors},null,2));
 console.log('Five-stage browser rehearsal passed; formal project unchanged.');
}finally{await browser.close();}
