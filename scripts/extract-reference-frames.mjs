import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2];
if(!source)throw new Error('Usage: node scripts/extract-reference-frames.mjs <24fps source.mov>');
const shots=JSON.parse(fs.readFileSync(path.join(root,'public/project/shots.json'),'utf8'));
const entries=shots.flatMap(s=>Object.entries({start:s.startFrame,middle:Math.floor((s.startFrame+s.endFrameExclusive-1)/2),end:s.endFrameExclusive-1}).map(([kind,frame])=>({shotId:s.id,kind,frame,time:frame/24,file:`${s.id}-${kind}.jpg`})));
const frames=[...new Set(entries.map(e=>e.frame))].sort((a,b)=>a-b);
const output=path.join(root,'public/reference-frames');fs.mkdirSync(output,{recursive:true});
const temporary=fs.mkdtempSync(path.join(output,'.extract-'));
try{
 const terms=frames.map(f=>`eq(n\\,${f})`);
 const groups=[];for(let i=0;i<terms.length;i+=24)groups.push(`(${terms.slice(i,i+24).join('+')})`);
 const filter=`select=${groups.join('+')},scale=960:-2`;
 const result=spawnSync(process.env.FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-i',source,'-an','-vf',filter,'-fps_mode','vfr','-q:v','3',path.join(temporary,'%03d.jpg')],{stdio:'inherit'});
 if(result.status!==0)throw new Error('Reference frame extraction failed');
 for(const e of entries){const index=frames.indexOf(e.frame)+1;fs.copyFileSync(path.join(temporary,`${String(index).padStart(3,'0')}.jpg`),path.join(output,e.file));}
 fs.writeFileSync(path.join(output,'manifest.json'),JSON.stringify({fps:24,frameIndexBase:0,entries},null,2));
 console.log(`Extracted ${entries.length} reference images at exact source frames.`);
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
