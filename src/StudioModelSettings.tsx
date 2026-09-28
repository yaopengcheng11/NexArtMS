import {useCallback,useEffect,useRef,useState} from 'react';
import {emptyModelDraft,modelConnectionTest,modelEndpointPreview,modelProfilePayload,profileDraft,validateModelDraft,type ModelProfileDraft,type ModelSettings} from './studio-model-settings-types';
import {sameModelEndpoint} from '../studio/model-endpoint.mjs';
import './StudioModelSettings.css';

type Props={onClose:()=>void;onChanged:()=>void};
const API='/api/studio/model-settings';
async function api(path='',body?:unknown,method='GET'):Promise<ModelSettings>{
  const response=await fetch(`${API}${path}`,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const value=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(value.error||`请求失败（${response.status}）`),{status:response.status});
  return value;
}
export function StudioModelSettings({onClose,onChanged}:Props){
  const dialog=useRef<HTMLDialogElement>(null);
  const testPanel=useRef<HTMLElement>(null);
  const initialLoad=useRef(true);
  const [testFocus,setTestFocus]=useState(0);
  const [settings,setSettings]=useState<ModelSettings|null>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [adding,setAdding]=useState(false);
  const [draft,setDraft]=useState<ModelProfileDraft>(emptyModelDraft);
  const [savedDraft,setSavedDraft]=useState<ModelProfileDraft>(emptyModelDraft);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [model,setModel]=useState('');
  const [confirmDelete,setConfirmDelete]=useState(false);
  const dirty=JSON.stringify(draft)!==JSON.stringify(savedDraft);
  const profile=settings?.profiles.find(value=>value.id===selected);
  const connectionTestingReady=(settings?.capabilities?.modelConnectionTestVersion||0)>=2;
  const setCleanDraft=(next:ModelProfileDraft)=>{setDraft(next);setSavedDraft(next);};
  const load=useCallback(async()=>{try{
    const result=await api();setSettings(result);setError('');
    if(initialLoad.current){
      initialLoad.current=false;
      const target=result.profiles.find(item=>item.id===result.active?.profileId)||result.profiles[0];
      if(target){setSelected(target.id);setCleanDraft(profileDraft(target));setModel(result.active?.profileId===target.id?result.active.modelId:target.models[0]||'');}
    }
  }catch(cause){setError((cause as Error).message);}},[]);
  useEffect(()=>{dialog.current?.showModal();void load();},[load]);
  useEffect(()=>{if(!testFocus)return;const frame=requestAnimationFrame(()=>testPanel.current?.scrollIntoView({block:'nearest'}));return()=>cancelAnimationFrame(frame);},[testFocus]);
  const mayLeave=()=>!dirty||window.confirm('有未保存的模型设置，确定放弃这些修改吗？');
  const close=()=>{if(!busy&&mayLeave())onClose();};
  const change=(patch:Partial<ModelProfileDraft>)=>{setDraft(value=>({...value,...patch}));setNotice('');setError('');};
  const choose=(id:string|null)=>{
    if(busy||!mayLeave())return;
    const target=settings?.profiles.find(value=>value.id===id);
    setSelected(id);setAdding(false);setCleanDraft(target?profileDraft(target):emptyModelDraft());
    setModel(target?(settings?.active?.profileId===id?settings.active.modelId:target.models[0]||''):'');
    if(target)setTestFocus(value=>value+1);
    setError('');setNotice('');setConfirmDelete(false);
  };
  const preset=(id:string)=>{
    const value=settings?.presets.find(item=>item.id===id);
    const next={...emptyModelDraft(),name:value?.name||'',provider:value?.provider||'custom',protocol:value?.protocol||settings?.protocols[0]?.id||'',endpoint:value?.endpoint||''};
    setCleanDraft(next);setAdding(true);setSelected(null);setError('');setNotice('');
  };
  const mutate=async(label:string,path:string,body:unknown,method='POST')=>{
    setBusy(label);setError('');setNotice('');
    try{const result=await api(path,body,method);setSettings(result);onChanged();return result;}
    catch(cause){setError((cause as Error).message);if((cause as {status?:number}).status===409){try{setSettings(await api());}catch{/* Keep both draft and visible conflict when refresh is unavailable. */}}return null;}
    finally{setBusy('');}
  };
  const save=async()=>{
    if(!connectionTestingReady){setError('旧后台无法安全保存此配置，请重启服务后再保存。');return;}
    if(!settings)return;const validation=validateModelDraft(draft);if(validation){setError(validation);return;}
    const previousIds=new Set(settings.profiles.map(value=>value.id));
    const result=await mutate('save',profile?`/profiles/${encodeURIComponent(profile.id)}`:'/profiles',modelProfilePayload(draft,settings.revision),profile?'PATCH':'POST');
    if(!result)return;
    const current=profile?result.profiles.find(value=>value.id===profile.id):result.profiles.find(value=>!previousIds.has(value.id));
    if(current){setSelected(current.id);setAdding(false);setCleanDraft(profileDraft(current));setModel(current.models.includes(model)?model:current.models[0]||'');}
    setNotice('供应商已保存。点击“测试连接”检查当前模型，测试通过后可设为默认视觉模型。');
    setTestFocus(value=>value+1);
  };
  const selectDefault=async()=>{
    if(!settings||!profile)return;
    if(await mutate('select','/select',{baseRevision:settings.revision,profileId:profile.id,modelId:model}))setNotice('默认视觉模型已更新。已有拉片结果保留；可回到项目重新发起分析。');
  };
  const clearDefault=async()=>{if(settings&&await mutate('select','/select',{baseRevision:settings.revision,profileId:null,modelId:null}))setNotice('已取消默认视觉模型，后台自动语义分析已停用。选择默认模型后可重新启用。');};
  const test=async()=>{
    if(!settings||!profile||!connectionTestingReady)return;
    await mutate('test',`/profiles/${encodeURIComponent(profile.id)}/test`,{baseRevision:settings.revision,modelId:model});
  };
  const remove=async()=>{
    if(!settings||!profile)return;
    if(await mutate('delete',`/profiles/${encodeURIComponent(profile.id)}`,{baseRevision:settings.revision},'DELETE')){setSelected(null);setAdding(false);setConfirmDelete(false);setCleanDraft(emptyModelDraft());setNotice('供应商已删除。');}
  };
  const tested=dirty||!connectionTestingReady?undefined:modelConnectionTest(profile,model);
  const testOk=tested?.visionPassed===true&&tested.status==='success';
  const draftEndpoint=modelEndpointPreview(draft);
  const testEndpoint=profile&&connectionTestingReady?modelEndpointPreview(profile):null;
  const endpointChangesTarget=profile&&draft.endpoint.trim()!==profile.endpoint&&!sameModelEndpoint(draft.endpoint.trim(),draft.protocol,profile.endpoint,profile.protocol);
  return <dialog ref={dialog} className="model-settings-dialog" aria-labelledby="model-settings-title" onCancel={event=>{event.preventDefault();close();}}>
    <header className="model-settings-header"><div><span className="model-settings-eyebrow">MOTIONSTAGE / SETTINGS</span><h2 id="model-settings-title">模型设置</h2><p>管理视觉模型供应商，为全片拉片选择默认模型。</p></div><button className="model-settings-close" aria-label="关闭模型设置" disabled={!!busy} onClick={close}>×</button></header>
    <div className="model-settings-runtime"><span className={`model-status-dot ${settings?.runtime.configured?'ready':''}`}/><span>{settings?.runtime.configured?`自动语义分析已配置 · ${settings.runtime.provider} / ${settings.runtime.model}${settings.runtime.visionVerified===false?' · 图片输入尚未验证':''}`:'自动语义分析尚未配置视觉模型'}</span>{settings?.active&&<button onClick={()=>void clearDefault()} disabled={!!busy||dirty}>取消默认</button>}</div>
    <div className="model-settings-layout">
      <aside className="model-settings-sidebar" aria-label="已配置的供应商"><div className="model-settings-sidebar-title">供应商 <span>{settings?.profiles.length||0}</span></div><div className="model-settings-profile-list">{settings?.profiles.map(item=><button key={item.id} className={selected===item.id?'selected':''} aria-pressed={selected===item.id} onClick={()=>choose(item.id)} disabled={!!busy}><span className="model-profile-icon">{item.name.slice(0,1).toUpperCase()}</span><span><b>{item.name}</b><small>{settings.active?.profileId===item.id?`默认 · ${settings.active.modelId}`:`${item.models.length} 个模型`}</small></span><span className={`model-status-dot ${settings.active?.profileId===item.id?'ready':''}`}/></button>)}</div>{settings&&!settings.profiles.length&&<p className="model-settings-empty">还没有供应商。添加接口后，后续导入可自动进行真实语义分析。</p>}<button className="model-settings-add" onClick={()=>choose(null)} disabled={!!busy}>＋ 添加供应商</button></aside>
      <main className="model-settings-content" aria-busy={!!busy}>
        {error&&<div className="model-settings-message error" role="alert">{error}{!settings&&<button onClick={()=>void load()}>重新读取</button>}</div>}
        {notice&&<div className="model-settings-message" role="status">{notice}</div>}
        {settings&&!connectionTestingReady&&<div className="model-settings-message error" role="alert">后台服务尚未更新，请重启本机服务后再测试。为保留已有密钥，更新前暂停保存供应商配置。</div>}
        {!settings&&!error&&<p role="status">正在读取模型设置…</p>}
        {settings&&!profile&&!adding&&<><div className="model-settings-section-heading"><h3>添加供应商</h3><button aria-label="刷新模型设置" onClick={()=>void load()} disabled={!!busy}>↻</button></div><p className="model-settings-hint">选择接口模板，或连接自己的服务。请填写支持图片输入的模型 ID；文本模型或订阅套餐不一定支持视觉 API。</p><div className="model-preset-grid">{settings.presets.map(item=><button key={item.id} onClick={()=>preset(item.id)}><span className="model-preset-icon">{item.id==='custom'?'+':item.name.slice(0,1).toUpperCase()}</span><span><b>{item.name}</b><small>{settings.protocols.find(value=>value.id===item.protocol)?.name||item.protocol}</small></span><span aria-hidden="true">›</span></button>)}{!settings.presets.some(item=>item.id==='custom')&&<button onClick={()=>preset('custom')}><span className="model-preset-icon">＋</span><span><b>自定义供应商</b><small>填写兼容接口</small></span><span aria-hidden="true">›</span></button>}</div></>}
        {settings&&(profile||adding)&&<>
          <div className="model-settings-section-heading"><h3>{profile?'编辑供应商':'配置供应商'}</h3><button onClick={()=>choose(null)} disabled={!!busy}>返回供应商列表</button></div>
          {profile&&<section ref={testPanel} className="model-settings-test" aria-labelledby="model-connection-title">
            <h4 id="model-connection-title">模型连接测试</h4>
            {testEndpoint&&<p style={{overflowWrap:'anywhere'}}>实际请求地址：{testEndpoint}</p>}
            <label>用于拉片的模型<select aria-label="用于拉片的模型" value={model} onChange={event=>setModel(event.target.value)} disabled={!!busy||dirty}>{profile.models.map(id=><option key={id} value={id}>{id}</option>)}</select></label>
            <div className="model-settings-actions"><button className="primary" disabled={!!busy||dirty||!model||!connectionTestingReady} onClick={()=>void test()}>{busy==='test'?'正在测试连接…':'测试连接'}</button><button disabled={!!busy||dirty||!model||(settings.active?.profileId===profile.id&&settings.active.modelId===model)} onClick={()=>void selectDefault()}>{settings.active?.profileId===profile.id&&settings.active.modelId===model?'当前默认视觉模型':'设为默认视觉模型'}</button></div>
            <p>检查接口是否可调用，同时验证图片输入。只发送一张测试图片，不发送项目视频；供应商可能按调用计费。</p>
            {!connectionTestingReady?<p role="status">后台更新后可进行连接测试。</p>:dirty?<p className="model-settings-hint">有未保存的修改，请先保存供应商，再测试连接。</p>:busy==='test'?<div className="model-settings-test-result" role="status">正在请求所选模型，请稍候…</div>:tested?<div className={`model-settings-test-result ${testOk?'success':'error'}`} role="status"><b>{testOk?'连接成功 · 图片输入通过':'测试未通过'} · {model}</b><span>{tested.message||'请检查模型与接口配置后重试。'}</span>{tested.testedAt&&<small>上次测试：{new Date(tested.testedAt).toLocaleString('zh-CN')}</small>}</div>:<p role="status">当前模型尚未测试，请点击“测试连接”。</p>}
          </section>}
          {profile?.secretUnavailable&&<div className="model-settings-message error" role="alert">已保存的密钥在当前环境无法解密，请重新输入并保存。</div>}
          <form className="model-settings-form" onSubmit={event=>{event.preventDefault();void save();}}>
            <div className="model-settings-form-row"><label>供应商名称<input value={draft.name} onChange={event=>change({name:event.target.value})} required maxLength={100} placeholder="例如：我的视觉服务" disabled={!!busy}/></label><label>接口协议<select aria-label="接口协议" value={draft.protocol} onChange={event=>change({protocol:event.target.value})} disabled={!!busy}>{settings.protocols.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>
            <label>{draft.protocol==='json-http'?'API 地址（完整请求地址）':'API 地址（Base URL）'}<input type="url" value={draft.endpoint} onChange={event=>change({endpoint:event.target.value})} placeholder={draft.protocol==='json-http'?'https://your-provider.example/analyze':'https://your-provider.example/v1'} required autoComplete="off" spellCheck={false} disabled={!!busy}/><small>{draft.protocol==='json-http'?'填写服务的完整请求地址，JSON HTTP 协议会直接请求此地址。':'填写供应商提供的 Base URL，所选协议会自动确定请求路径，无需手动添加。'}不要在地址里放密钥。{profile?.hasApiKey&&endpointChangesTarget&&" 更换地址时，请重新填写密钥；留空会清除旧密钥。"}</small>{draftEndpoint&&<small style={{overflowWrap:'anywhere'}}>{connectionTestingReady?'实际请求地址':'更新后台后的请求地址'}：{draftEndpoint}</small>}</label>
            <label>API 密钥<input type="password" name="model-api-key" value={draft.apiKey} onChange={event=>change({apiKey:event.target.value,clearApiKey:false})} autoComplete="new-password" spellCheck={false} placeholder={profile?.hasApiKey?'密钥已保存；留空保留，输入新值可替换':'填入此服务的 API Key（本地免鉴权服务可留空）'} disabled={!!busy||draft.clearApiKey}/><small>{profile?.hasApiKey?'已保存密钥不返回浏览器。':'密钥只提交到本机服务端，不写入浏览器存储。'}</small></label>
            {profile?.hasApiKey&&<label className="model-settings-checkbox"><input type="checkbox" checked={draft.clearApiKey} onChange={event=>change({clearApiKey:event.target.checked,apiKey:''})} disabled={!!busy}/>清除已保存的密钥</label>}
            <label>视觉模型 ID<textarea value={draft.models} onChange={event=>change({models:event.target.value})} placeholder="每行一个模型 ID，与供应商控制台保持一致" rows={3} required spellCheck={false} disabled={!!busy}/><small>可填多个，每行一个；配置不会自动证明模型具备视觉能力。</small></label>
            <div className="model-settings-actions"><button type="submit" className="primary" disabled={!!busy||(!adding&&!dirty)||!connectionTestingReady}>{busy==='save'?'保存中…':'保存供应商'}</button>{dirty&&<><button type="button" disabled={!!busy} onClick={()=>{setDraft(savedDraft);setError('');}}>撤回修改</button><span>有未保存修改</span></>}</div>
          </form>
          {profile&&<div className="model-settings-delete">{confirmDelete?<><p>删除「{profile.name}」及其保存的密钥？如它是默认供应商，会同时取消默认选择。</p><button className="danger" onClick={()=>void remove()} disabled={!!busy}>确认删除</button><button onClick={()=>setConfirmDelete(false)} disabled={!!busy}>保留供应商</button></>:<button className="danger" onClick={()=>setConfirmDelete(true)} disabled={!!busy||dirty}>删除供应商</button>}</div>}
        </>}
      </main>
    </div>
    <footer className="model-settings-footer"><span>{settings?.secretStorage?.message||settings?.secretStorage?.description||'配置保存在运行 MotionStage 的本机服务中。'}</span><span>已有拉片结果与自动模型配置分别保留。</span></footer>
  </dialog>;
}
