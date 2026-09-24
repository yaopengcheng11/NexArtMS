import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2];
if(!source)throw new Error('Usage: node scripts/prepare-rehearsal.mjs <existing V2 MP4>');
const output=path.join(root,'public/demo');fs.mkdirSync(output,{recursive:true});
fs.copyFileSync(source,path.join(output,'v2.mp4'));
const shots=JSON.parse(fs.readFileSync(path.join(root,'public/project/shots.json'),'utf8'));
const entries=shots.map(s=>({shotId:s.id,frame:Math.floor((s.startFrame+s.endFrameExclusive-1)/2),file:`${s.id}-middle.jpg`}));
const framesPath=path.join(output,'v2-frames');fs.mkdirSync(framesPath,{recursive:true});
const temp=fs.mkdtempSync(path.join(output,'.frames-'));
try{
 const terms=entries.map(e=>`eq(n\\,${e.frame})`);const groups=[];for(let i=0;i<terms.length;i+=20)groups.push(`(${terms.slice(i,i+20).join('+')})`);
 const result=spawnSync(process.env.FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-an','-vf',`select=${groups.join('+')},scale=960:-2`,'-fps_mode','vfr','-q:v','3',path.join(temp,'%03d.jpg')],{stdio:'inherit'});
 if(result.status!==0)throw new Error('V2 sample extraction failed');
 entries.forEach((entry,i)=>fs.copyFileSync(path.join(temp,`${String(i+1).padStart(3,'0')}.jpg`),path.join(framesPath,entry.file)));
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({purpose:'流程演练中的旧版 V2 参考样例，未经新流程还原或去抖',fps:24,entries},null,2));
 console.log(`Prepared existing V2 video and ${entries.length} middle-frame samples.`);
}finally{fs.rmSync(temp,{recursive:true,force:true});}
