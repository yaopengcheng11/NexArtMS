import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
const url=process.env.BASE_URL||'http://127.0.0.1:8199';
const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{},headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[];const report={fixedSceneShots:0,referenceImages:0,saveAndReload:'not requested',errors};
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.waitForFunction(()=>typeof window.__sceneProbe==='function');
 const imageReady=()=>page.waitForFunction(()=>{const i=document.querySelector('.reference-image');return i&&i.complete&&i.naturalWidth===960;});
 await imageReady();await page.screenshot({path:path.join(root,'reports/scene-workbench.png'),fullPage:true});
 const initial=await page.evaluate(()=>window.__sceneProbe());
 const cards=page.locator('.shot-card');
 for(let i=0;i<await cards.count();i++){
  await cards.nth(i).click();await imageReady();
  const probe=await page.evaluate(()=>window.__sceneProbe());
  assert.deepEqual(probe.worldTransforms,initial.worldTransforms);assert.equal(probe.actorCount,0);
  report.fixedSceneShots++;report.referenceImages++;
 }
 await cards.filter({hasText:'S33'}).click();await imageReady();
 for(const name of ['开始帧','结束帧','中间帧']){await page.getByRole('button',{name,exact:true}).click();await imageReady();report.referenceImages++;}
 await page.getByRole('button',{name:'查看原片',exact:true}).click();
 await page.waitForFunction(()=>{const v=document.querySelector('video');return v&&v.readyState>=2&&!v.seeking;});
 report.originalVideoLoaded=true;
 await page.getByRole('button',{name:'返回参考帧',exact:true}).click();await imageReady();
 await page.getByRole('button',{name:'俯视场地',exact:true}).click();await page.screenshot({path:path.join(root,'reports/scene-top.png'),fullPage:true});
 if(process.env.CHECK_SAVE==='1'){
  const original=await page.evaluate(async()=>await(await fetch('/api/project')).json());
  const node=original.scene.nodes.find(n=>n.type==='tomb');const field=page.getByLabel('左右 X',{exact:true});
  await field.fill(String(node.position[0]+0.25));await page.locator('textarea').fill('浏览器临时验收：保存后重开');
  await page.getByRole('button',{name:'保存修改与意见',exact:true}).click();await page.getByRole('status').waitFor();await page.reload();
  await page.waitForFunction(()=>typeof window.__sceneProbe==='function');
  assert.equal(await field.inputValue(),String(node.position[0]+0.25));assert.equal(await page.locator('textarea').inputValue(),'浏览器临时验收：保存后重开');
  const saved=await page.evaluate(async()=>await(await fetch('/api/project')).json());assert.notEqual(saved.revision,original.revision);assert.equal(saved.history.length,original.history.length+1);
  await field.fill(String(node.position[0]));await page.locator('textarea').fill(original.feedback);
  await page.getByRole('button',{name:'保存修改与意见',exact:true}).click();await page.getByRole('status').waitFor();
  report.saveAndReload='passed; restored original scene and feedback';
 }
 const approval=await page.evaluate(async()=>{const p=await(await fetch('/api/project')).json();const r=await fetch('/api/approve-scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:p.revision})});return{status:r.status,body:await r.json()};});
 assert.equal(approval.status,422);report.approvalGuard=approval;assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'reports/browser-scene.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser.close();}
