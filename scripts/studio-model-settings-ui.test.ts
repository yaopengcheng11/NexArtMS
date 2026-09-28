import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyModelDraft,modelConnectionTest,modelEndpointPreview,modelIds,modelProfilePayload,profileDraft,validateModelDraft,type ModelProfile} from '../src/studio-model-settings-types';
import {isSessionVisualAnalysis,type ShotAnalysis} from '../src/studio-shot-analysis-types';

const saved:ModelProfile={id:'local-profile',revision:'profile-r1',name:'Visual service',provider:'custom',protocol:'openai-chat-completions',endpoint:'https://example.test/v1/chat/completions',models:['vision-a','vision-b'],hasApiKey:true};
test('model settings preserve saved secrets by omitting empty API keys from updates',()=>{
  const draft=profileDraft(saved);
  assert.equal(draft.apiKey,'');
  const payload=modelProfilePayload({...draft,name:' renamed '},'settings-r2');
  assert.equal(payload.name,'renamed');
  assert.equal(payload.baseRevision,'settings-r2');
  assert.equal('apiKey' in payload,false);
  assert.equal('clearApiKey' in payload,false);
  assert.equal(modelProfilePayload({...draft,apiKey:'test-only-key'},'settings-r2').apiKey,'test-only-key');
  assert.equal(modelProfilePayload({...draft,clearApiKey:true},'settings-r2').clearApiKey,true);
});
test('model settings reject ambiguous endpoints and empty model lists before submission',()=>{
  assert.ok(validateModelDraft(emptyModelDraft()));
  const valid=profileDraft(saved);
  assert.equal(validateModelDraft(valid),null);
  for(const endpoint of ['not a url','file:///tmp/key','http://example.test/api','https://user:pass@example.test/api','https://example.test/api?key=secret','https://example.test/api#secret'])assert.ok(validateModelDraft({...valid,endpoint}),endpoint);
  assert.equal(validateModelDraft({...valid,endpoint:'http://127.0.0.1:12345/v1/chat/completions'}),null);
  assert.ok(validateModelDraft({...valid,models:'  \n , '}));
  assert.ok(validateModelDraft({...valid,apiKey:'test-only-key',clearApiKey:true}));
  assert.deepEqual(modelIds('vision-a\n vision-b,vision-a，vision-c\n'),['vision-a','vision-b','vision-c']);
});
test('session visual analysis is distinct from configured automatic providers',()=>{
  assert.equal(isSessionVisualAnalysis(null),false);
  assert.equal(isSessionVisualAnalysis({provider:'openai'} as ShotAnalysis),false);
  assert.equal(isSessionVisualAnalysis({provider:'codex-session'} as ShotAnalysis),true);
  assert.equal(isSessionVisualAnalysis({parameters:{analysisSource:'assistant-session'}} as ShotAnalysis),true);
});

test('request address preview resolves Base URLs without migrating stored settings or keys',()=>{
  const draft={...profileDraft(saved),endpoint:'https://api.minimax.cn/v1',models:'MiniMax-M3'};
  assert.equal(validateModelDraft(draft),null);
  assert.equal(modelEndpointPreview(draft),'https://api.minimax.cn/v1/chat/completions');
  const payload=modelProfilePayload(draft,'settings-r2');
  assert.equal(payload.endpoint,'https://api.minimax.cn/v1');
  assert.equal('apiKey' in payload,false);
  assert.equal(modelEndpointPreview({...draft,protocol:'json-http'}),draft.endpoint);
  assert.equal(modelEndpointPreview({...draft,endpoint:saved.endpoint}),saved.endpoint);
});

test('request address preview and validation never echo URL credentials or query secrets',()=>{
  const draft=profileDraft(saved);
  for(const endpoint of ['https://user:private-test-secret@example.test/v1','https://example.test/v1?key=private-test-secret','https://example.test/v1#private-test-secret','private-test-secret','http://example.test/v1']){
    assert.equal(modelEndpointPreview({...draft,endpoint}),null);
    const error=validateModelDraft({...draft,endpoint});
    assert.ok(error);
    assert.equal(error.includes('private-test-secret'),false);
  }
});

test('connection results belong to the selected model and current provider revision only',()=>{
  const passed={modelId:'vision-a',profileRevision:'profile-r1',status:'success',visionPassed:true};
  const failed={modelId:'vision-b',profileRevision:'profile-r1',status:'failed',visionPassed:false,message:'模型服务 HTTP 401'};
  const profile={...saved,lastTest:failed,lastTests:[passed,failed]};
  assert.equal(modelConnectionTest(profile,'vision-a'),passed);
  assert.equal(modelConnectionTest(profile,'vision-b'),failed);
  assert.equal(modelConnectionTest(profile,'not-tested'),undefined);
  assert.equal(modelConnectionTest({...profile,revision:'profile-r2'},'vision-a'),undefined);
  assert.equal(modelConnectionTest({...saved,lastTest:passed},'vision-a'),passed);
  assert.equal(modelConnectionTest({...saved,lastTest:{...passed,profileRevision:undefined}},'vision-a'),undefined);
});
