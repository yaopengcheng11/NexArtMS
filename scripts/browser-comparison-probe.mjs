import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.BASE_URL;if(!base)throw new Error('Set BASE_URL to a test project currently at rehearsal stage 4.');
fs.mkdirSync(path.join(root,'reports'),{recursive:true});
const browser=await chromium.launch({...process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{},headless:true,args:['--enable-webgl','--ignore-gpu-blocklist']});
const errors=[],pausedFrames=[],playback=[];
try{
 const before=await(await fetch(base+'/api/rehearsal')).text();
 const page=await browser.newPage({viewport:{width:1600,height:1200}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/?mode=rehearsal');await page.waitForFunction(()=>window.__comparisonProbe?.().ready===true);
 const probe=()=>page.evaluate(()=>window.__comparisonProbe());
 await page.evaluate(()=>{window.__presented={};for(const video of document.querySelectorAll('.vcmp-video')){const name=video.getAttribute('aria-label')==='原片视频'?'reference':'rendered';video.dataset.instance=name;const callback=(_,metadata)=>{window.__presented[name]=Math.round(metadata.mediaTime*24);video.requestVideoFrameCallback(callback);};video.requestVideoFrameCallback(callback);}});
 const waitFrame=async frame=>{await page.waitForFunction(frame=>{const p=window.__comparisonProbe();return p.frame===frame&&!p.seeking&&!p.playing&&!p.buffering&&Math.abs(p.referenceTime*24-frame)<.025&&Math.abs(p.renderedTime*24-frame)<.025;},frame);await page.waitForFunction(frame=>window.__presented.reference===frame&&window.__presented.rendered===frame,frame);};
 const seek=async frame=>{await page.getByRole('spinbutton',{name:'跳转秒数'}).fill(String(frame/24));await page.getByRole('button',{name:'跳转',exact:true}).click();await waitFrame(frame);};
 assert.equal(await page.locator('.vcmp-shot-row').count(),47);assert.equal(await page.locator('.vcmp-shot-segment').count(),47);
 for(const frame of [98,99,662,1184,1202]){await seek(frame);pausedFrames.push({frame,...await probe(),presented:await page.evaluate(()=>window.__presented)});}
 assert.equal(await page.getByRole('button',{name:'下一帧 ›',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'▶ 播放',exact:true}).click();await page.waitForFunction(()=>{const p=window.__comparisonProbe();return p.playing&&p.frame>0&&p.frame<100;});await page.getByRole('button',{name:'Ⅱ 暂停',exact:true}).click();await page.waitForFunction(()=>!window.__comparisonProbe().seeking);
 await page.locator('.vcmp-shot-row').filter({hasText:'S33'}).click();await waitFrame(663);
 await page.locator('.vcmp-screen').click({position:{x:20,y:20}});await page.keyboard.press('Shift+ArrowRight');await waitFrame(664);await page.keyboard.press('ArrowLeft');await waitFrame(578);
 await page.getByRole('spinbutton',{name:'跳转秒数'}).focus();await page.keyboard.press('ArrowRight');assert.equal((await probe()).frame,578);
 await page.getByRole('slider',{name:'视频进度（帧）'}).evaluate(element=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;for(const frame of [103,399,713,98]){setter.call(element,String(frame));element.dispatchEvent(new Event('input',{bubbles:true}));}});await waitFrame(98);
 await seek(686);await page.locator('.vcmp').screenshot({path:path.join(root,'reports/comparison-side.png')});
 await page.getByRole('button',{name:'叠加对齐',exact:true}).click();
 await page.getByRole('slider',{name:'原片叠加比例'}).evaluate(element=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,'35');element.dispatchEvent(new Event('input',{bubbles:true}));});
 await page.getByRole('checkbox',{name:'三分参考线'}).check();
 const layout=await page.locator('.vcmp-screen').evaluate(element=>{const videos=[...element.querySelectorAll('video')];return videos.map(v=>{const r=v.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,opacity:getComputedStyle(v).opacity,fit:getComputedStyle(v).objectFit,instance:v.dataset.instance};});});
 for(const key of ['x','y','width','height'])assert.ok(Math.abs(layout[0][key]-layout[1][key])<.1);assert.equal(layout[1].opacity,'0.35');assert.equal(layout[0].fit,'contain');assert.equal((await probe()).frame,686);
 await page.locator('.vcmp').screenshot({path:path.join(root,'reports/comparison-overlay.png')});
 await page.getByRole('button',{name:'原声关',exact:true}).click();assert.equal((await probe()).referenceMuted,false);assert.equal((await probe()).renderedMuted,true);await page.getByRole('button',{name:'原声开',exact:true}).click();
 for(const [mode,rate] of [['并排对照',1],['叠加对齐',2],['三维单看',.5]]){
  await page.getByRole('button',{name:mode,exact:true}).click();await seek(240);await page.getByRole('combobox',{name:'播放速度'}).selectOption(String(rate));
  await page.getByRole('button',{name:'▶ 播放',exact:true}).click();await page.waitForFunction(()=>window.__comparisonProbe().playing);
  const samples=await page.evaluate(()=>new Promise(resolve=>{const samples=[],start=performance.now();const sample=()=>{const p=window.__comparisonProbe();if(performance.now()-start>150)samples.push({frame:p.frame,driftFrames:Math.abs(p.referenceTime-p.renderedTime)*24,playing:p.playing,seeking:p.seeking,buffering:p.buffering});if(performance.now()-start>2500)resolve(samples);else requestAnimationFrame(sample);};sample();}));
  const steady=samples.filter(s=>s.playing&&!s.seeking&&!s.buffering);assert.ok(steady.length>20);assert.ok(steady.at(-1).frame-steady[0].frame>24*rate);
  const drift=steady.map(s=>s.driftFrames).sort((a,b)=>a-b);const result={mode,rate,sampleCount:steady.length,maxDriftFrames:drift.at(-1),p95DriftFrames:drift[Math.floor(drift.length*.95)],frameAdvance:steady.at(-1).frame-steady[0].frame};playback.push(result);assert.ok(result.p95DriftFrames<=1.1,JSON.stringify(result));
  await page.getByRole('button',{name:'Ⅱ 暂停',exact:true}).click();await page.waitForFunction(()=>!window.__comparisonProbe().seeking&&!window.__comparisonProbe().playing);
 }
 await page.getByRole('button',{name:'并排对照',exact:true}).click();await seek(686);await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.vcmp').screenshot({path:path.join(root,'reports/comparison-mobile.png')});
 await page.setViewportSize({width:1600,height:1200});
 await page.getByRole('button',{name:'从头',exact:false}).click();await waitFrame(0);await page.getByRole('button',{name:'▶ 播放',exact:true}).click();await page.waitForFunction(()=>window.__comparisonProbe().playing);
 await page.getByLabel('三维还原视频',{exact:true}).evaluate(video=>{video.src='/intentional-missing-video.mp4';video.load();});await page.waitForFunction(()=>!!window.__comparisonProbe().error);
 assert.ok(await page.locator('.vcmp-video').evaluateAll(videos=>videos.every(v=>v.paused)));
 assert.equal(await(await fetch(base+'/api/rehearsal')).text(),before);assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(root,'reports/comparison-browser.json'),JSON.stringify({pausedFrames,playback,overlayLayout:layout,rapidSeek:true,shortcuts:true,audioIsolation:true,replayFromEnd:true,mobileNoOverflow:true,errorStopsBoth:true,rehearsalProgressUnchanged:true,errors},null,2));
 console.log(JSON.stringify({pausedFrameChecks:pausedFrames.length,playback,overlayAligned:true,shortcuts:true,errorStopsBoth:true}));
}finally{await browser.close();}
