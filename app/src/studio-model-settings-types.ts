import {resolveModelEndpoint} from '../studio/model-endpoint.mjs';

export interface ModelConnectionTest {
  status?:string;visionPassed?:boolean;message?:string;code?:string;testedAt?:string;modelId?:string;profileRevision?:string;
  // Advisory diagnostics, only present when the request succeeded but grading failed.
  sample?:{content:string;parsed:{pattern:string|null;count:unknown;colorsLeftToRight:unknown[]|null};mismatches:string[]};
}
export interface ModelProfile {
  id:string;revision:string;name:string;provider:string;protocol:string;endpoint:string;
  models:string[];hasApiKey:boolean;secretUnavailable?:boolean;
  lastTest?:ModelConnectionTest|null;lastTests?:ModelConnectionTest[];
}
export function modelConnectionTest(profile:ModelProfile|undefined,modelId:string):ModelConnectionTest|undefined {
  if(!profile)return undefined;
  return [...(profile.lastTests||[]),...(profile.lastTest?[profile.lastTest]:[])].find(result=>result.modelId===modelId&&result.profileRevision===profile.revision);
}
export interface ModelSettings {
  revision:string;profiles:ModelProfile[];active:{profileId:string;modelId:string}|null;
  capabilities?:{modelConnectionTestVersion?:number};
  presets:{id:string;name:string;provider:string;protocol:string;endpoint?:string}[];
  protocols:{id:string;name:string}[];
  secretStorage?:{kind?:string;description?:string;message?:string;persistent?:boolean;available?:boolean};
  runtime:{configured:boolean;provider:string|null;model:string|null;reason?:string;visionVerified?:boolean};
}
export interface ModelProfileDraft {name:string;provider:string;protocol:string;endpoint:string;models:string;apiKey:string;clearApiKey:boolean}
export const emptyModelDraft=():ModelProfileDraft=>({name:'',provider:'custom',protocol:'openai-chat-completions',endpoint:'',models:'',apiKey:'',clearApiKey:false});
export function profileDraft(profile:ModelProfile):ModelProfileDraft {
  return {name:profile.name,provider:profile.provider,protocol:profile.protocol,endpoint:profile.endpoint,models:profile.models.join('\n'),apiKey:'',clearApiKey:false};
}
export function modelIds(text:string):string[] {return [...new Set(text.split(/[\n,，]/).map(value=>value.trim()).filter(Boolean))];}
export function modelProfilePayload(draft:ModelProfileDraft,baseRevision:string) {
  return {baseRevision,name:draft.name.trim(),provider:draft.provider.trim(),protocol:draft.protocol,endpoint:draft.endpoint.trim(),models:modelIds(draft.models),...(draft.apiKey?{apiKey:draft.apiKey}:{}),...(draft.clearApiKey?{clearApiKey:true}:{})};
}
function isSafeModelEndpoint(endpoint:string):boolean {
  try{const url=new URL(endpoint.trim());const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);return ['http:','https:'].includes(url.protocol)&&(url.protocol!=='http:'||local)&&!url.username&&!url.password&&!endpoint.includes('?')&&!endpoint.includes('#');}catch{return false;}
}
export function modelEndpointPreview(value:Pick<ModelProfileDraft,'endpoint'|'protocol'>):string|null {
  return isSafeModelEndpoint(value.endpoint)?resolveModelEndpoint(value.endpoint.trim(),value.protocol):null;
}
export function validateModelDraft(draft:ModelProfileDraft):string|null {
  if(!draft.name.trim())return '请填写供应商名称。';
  if(!draft.protocol)return '请选择接口协议。';
  if(!isSafeModelEndpoint(draft.endpoint))return '请填写 HTTPS API 地址（Base URL 或完整地址，本机服务可用 HTTP），地址中不要包含密钥、查询参数或片段。';
  if(!modelIds(draft.models).length)return '至少填写一个支持图片输入的模型 ID。';
  if(draft.clearApiKey&&draft.apiKey)return '更换密钥与清除密钥不能同时选择。';
  return null;
}
