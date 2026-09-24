import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export function validateScene(scene){
  if(!scene||scene.units!=='m'||!Array.isArray(scene.nodes)||!Array.isArray(scene.cameras))throw new Error('场景数据结构不完整');
  const ids=new Set();for(const n of scene.nodes){if(ids.has(n.id))throw new Error('场景对象编号重复');ids.add(n.id);for(const key of['position','rotation','scale','size'])if(n[key]&&(!Array.isArray(n[key])||n[key].length!==3||n[key].some(v=>!Number.isFinite(v))))throw new Error('场景变换数值无效');}
  for(const c of scene.cameras){if(!Number.isFinite(c.fov)||c.fov<5||c.fov>130||[...c.position,...c.target].some(v=>!Number.isFinite(v)))throw new Error('机位参数无效');}
}
export function createStore(root){
  const dir=path.join(root,'data');fs.mkdirSync(dir,{recursive:true});const statePath=path.join(dir,'project.json');
  const persist=p=>{const tmp=statePath+'.'+crypto.randomUUID()+'.tmp';const json=JSON.stringify(p,null,2);fs.mkdirSync(path.join(dir,'revisions'),{recursive:true});fs.writeFileSync(path.join(dir,'revisions',p.revision+'.json'),json,{flag:'wx'});try{fs.writeFileSync(tmp,json);fs.renameSync(tmp,statePath);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}return p;};
  const read=()=>{
    if(fs.existsSync(statePath))return JSON.parse(fs.readFileSync(statePath,'utf8'));
    const scene=JSON.parse(fs.readFileSync(path.join(root,'public/project/scene.json'),'utf8'));validateScene(scene);
    const shots=JSON.parse(fs.readFileSync(path.join(root,'public/project/shots.json'),'utf8'));
    const p={id:'jwm-rebuild',revision:'project-r1',scene,shots,feedback:'',approval:{status:'ready_for_review',reason:'这是固定场景初稿。机位参照点误差尚未量化，G1 还未通过。'},quality:{fixedScene:true,cameraCoverage:scene.cameras.length,cameraMeasurement:'pending',actorCount:0},history:[{revision:'project-r1',time:new Date().toISOString(),reason:'创建固定场景候选'}]};return persist(p);
  };
  const update=(expected,scene,feedback)=>{
    const p=read();if(expected!==p.revision)throw Object.assign(new Error('当前版本已变化，请刷新后保存'),{status:409});validateScene(scene);
    const revision='project-'+crypto.randomUUID().slice(0,8);scene={...scene,revision:'scene-'+crypto.randomUUID().slice(0,8)};
    return persist({...p,revision,scene,feedback:String(feedback||''),approval:{status:'ready_for_review',reason:'场景已保存为新版本，需要重新核对。'},quality:{...p.quality,cameraMeasurement:'pending'},history:[...p.history,{revision,time:new Date().toISOString(),reason:'保存场景修改与意见'}]});
  };
  const approve=expected=>{const p=read();if(expected!==p.revision)throw Object.assign(new Error('确认版本已过期'),{status:409});if(p.quality.cameraMeasurement!=='passed')throw Object.assign(new Error('机位参照点测量尚未完成，不能把 G1 标为通过。场景意见可先保存。'),{status:422});const revision='project-'+crypto.randomUUID().slice(0,8),time=new Date().toISOString(),sceneRevision=p.scene.revision;return persist({...p,revision,approval:{status:'approved',reason:'用户已确认场景',sceneRevision,time},history:[...p.history,{revision,sceneRevision,time,reason:'用户确认场景通过'}]});};
  return{read,update,approve};
}
