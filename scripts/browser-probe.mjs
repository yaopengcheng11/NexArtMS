import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
const base=process.env.BASE_URL||'http://127.0.0.1:8199';
const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{},headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:1500,height:1100},deviceScaleFactor:1});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(new URL('/?lab=rig',base).href);await page.waitForFunction(()=>typeof window.__exportRig==='function');
 await page.screenshot({path:path.join(root,'reports/rig-tpose.png'),fullPage:true});
 const result=await page.evaluate(()=>window.__rigProbe());const base64=await page.evaluate(()=>window.__exportRig());fs.mkdirSync(path.join(root,'public/probes'),{recursive:true});fs.writeFileSync(path.join(root,'public/probes/rig.glb'),Buffer.from(base64,'base64'));
 console.log(JSON.stringify({rig:result,glb:path.join(root,'public/probes/rig.glb')}));
 await page.getByRole('button',{name:'检查屈肘与屈膝'}).click();await page.screenshot({path:path.join(root,'reports/rig-bent.png'),fullPage:true});
 await page.goto(new URL('/?mode=scene',base).href);await page.waitForFunction(()=>typeof window.__sceneProbe==='function');await page.locator('.reference-image').waitFor();await page.waitForFunction(()=>{const i=document.querySelector('.reference-image');return i&&i.complete&&i.naturalWidth>0;});
 await page.screenshot({path:path.join(root,'reports/scene-workbench.png'),fullPage:true});
 const before=await page.evaluate(()=>window.__sceneProbe());
 await page.locator('.shot-card').filter({hasText:'S33'}).click();
 const after=await page.evaluate(()=>window.__sceneProbe());
 if(JSON.stringify(before.worldTransforms)!==JSON.stringify(after.worldTransforms))throw new Error('Scene geometry changes on shot switch');
 if(before.actorCount!==0||after.actorCount!==0)throw new Error('Scene stage has actors');
 await page.getByRole('button',{name:'俯视场地',exact:true}).click();await page.screenshot({path:path.join(root,'reports/scene-top.png'),fullPage:true});
 const response=await page.evaluate(async()=>{const p=await(await fetch('/api/project')).json();const r=await fetch('/api/approve-scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseRevision:p.revision})});return{status:r.status,body:await r.json()};});
 if(response.status!==422)throw new Error('Unmeasured scene passed approval');
 if(errors.length)throw new Error(errors.join('\n'));
 fs.writeFileSync(path.join(root,'reports/browser-m0.json'),JSON.stringify({rig:result,scene:{fixedAcrossShotSwitch:true,actorCount:0,canvas:before.canvas},approvalGuard:response,errors},null,2));console.log('browser checks passed');
}finally{await browser.close();}
