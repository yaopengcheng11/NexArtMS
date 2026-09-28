import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisIssues,analysisShotAt,editedCutFrames,sourceFrameAt,SHOT_FIELD_OPTIONS,type AnalysisShot,type ShotAnalysis} from '../src/studio-shot-analysis-types';
// @ts-expect-error backend module owns the runtime vocabulary contract.
import {ANNOTATION_ENUMS} from '../studio/shot-analysis-schema.mjs';

const shots=[
  {id:'retained-shot-z',startFrame:0,endFrameExclusive:3,startUs:40000,endUs:190000},
  {id:'new-shot-a',startFrame:3,endFrameExclusive:7,startUs:190000,endUs:460000},
  {id:'retained-shot-b',startFrame:7,endFrameExclusive:10,startUs:460000,endUs:720000},
] as AnalysisShot[];

test('拉片源帧步进使用实际 VFR PTS 和非零起始时间，不根据 fps 估算',()=>{
  const pts=[40000,81000,130000,190000,250000,300000,370000,460000,550000,660000];
  assert.equal(sourceFrameAt(pts,0),0);
  assert.equal(sourceFrameAt(pts,129999),1);
  assert.equal(sourceFrameAt(pts,130000),2);
  assert.equal(sourceFrameAt(pts,189999),2);
  assert.equal(sourceFrameAt(pts,190000),3);
  assert.equal(sourceFrameAt(pts,1000000),9);
  assert.equal(sourceFrameAt([],1000),-1);
  assert.equal(analysisShotAt(shots,189999)?.id,'retained-shot-z');
  assert.equal(analysisShotAt(shots,190000)?.id,'new-shot-a');
  assert.equal(analysisShotAt(shots,720000),undefined);
});

test('拉片拆分、合并、移动按数组边界生成完整候选切点，保留活动镜头',()=>{
  const original=structuredClone(shots);
  assert.deepEqual(editedCutFrames(shots,1,'split',5),[3,5,7]);
  assert.deepEqual(editedCutFrames(shots,1,'merge'),[3]);
  assert.deepEqual(editedCutFrames(shots,0,'move',6),[6,7]);
  assert.deepEqual(editedCutFrames(shots,1,'move',4),[3,4]);
  assert.deepEqual(shots,original);
  for(const frame of [0,3,7,5.5,NaN])assert.throws(()=>editedCutFrames(shots,1,'split',frame));
  assert.throws(()=>editedCutFrames(shots,2,'merge'));
  assert.throws(()=>editedCutFrames(shots,2,'move',9));
  assert.throws(()=>editedCutFrames(shots,0,'move',7));
});

test('UI可保存词表与后端schema保持一致，包含明确的不确定选项',()=>{
  for(const field of ['size','category','camera'] as const){
    assert.deepEqual(SHOT_FIELD_OPTIONS[field].map(option=>option[0]).sort(),[...ANNOTATION_ENUMS[field]].sort());
    assert.ok(SHOT_FIELD_OPTIONS[field].every(option=>option[1]));
  }
});

test('集中待修正列表去重全局/逐镜重复问题，并保留具体镜头与字段',()=>{
  const first={code:'unknown',severity:'warning',message:'运镜需核对',shotId:'shot-x',field:'camera'};
  const run={issues:[first],shots:[{id:'shot-x',issues:[{...first,shotId:undefined}]},{id:'shot-y',issues:[{...first,shotId:undefined}]}]} as ShotAnalysis;
  const issues=analysisIssues(run);
  assert.equal(issues.length,2);
  assert.deepEqual(issues.map(issue=>issue.shotId),['shot-x','shot-y']);
  assert.equal(issues[0].field,'camera');
});
