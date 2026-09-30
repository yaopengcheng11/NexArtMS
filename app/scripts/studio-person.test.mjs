import test from 'node:test';
import assert from 'node:assert/strict';
import {boxIoU, trackDetections, registerDetector, listDetectors, hasDetector, runDetection, trackObservation} from '../studio/person.mjs';
import {appearanceDescriptor, clusterPeople, clusterKnownPeople} from '../studio/people.mjs';
import {decodePoseOutput, letterboxMapper} from '../studio/vision.mjs';

test('exported detector probabilities are not sigmoid-converted again',()=>{
  const data=new Float32Array(56*2);
  for(let i=0;i<2;i++){
    data[i]=160+i*320;data[2+i]=320;data[4+i]=120;data[6+i]=320;
    data[8+i]=i===0?0.9:0.01;
    for(let k=0;k<17;k++){data[(5+k*3)*2+i]=160+i*320;data[(6+k*3)*2+i]=320;data[(7+k*3)*2+i]=k===9?0.02:0.95;}
  }
  const decoded=decodePoseOutput({data,dims:[1,56,2]},{mapper:letterboxMapper(640,640),sourceWidth:640,sourceHeight:640});
  assert.equal(decoded.length,1,'background probability .01 must be rejected');
  assert.equal(decoded[0].score,0.9);assert.equal(decoded[0].keypoints[9].v,0.02,'hidden wrist must remain low confidence');
});

test('known character count produces identity groups and an unresolved queue, never extra cards',()=>{
  const red=Array(128).fill(0),blue=Array(128).fill(0);red[0]=red[64]=1;blue[10]=blue[74]=1;
  const track=(id,shotId,appearance,confidence=.9)=>({id,shotId,startFrame:0,endFrame:20,appearance,confidence});
  const result=clusterKnownPeople([track('red1','S01',red),track('red2','S02',red),track('blue1','S03',blue),track('unknown','S04',null),track('low','S05',blue,.1)],2);
  assert.equal(result.groups.length,2);
  assert.ok(result.groups.some(ids=>ids.includes('red1')&&ids.includes('red2')));
  assert.deepEqual(new Set(result.unresolvedIds),new Set(['unknown','low']));
});

test('sampled 60 fps tracking preserves exact frame observations and one-to-one poses', () => {
  const detections = [0,6,12].flatMap(frame => [
    {...detection(frame, 0.1 + frame / 100, 0.1), keypoints:['a',frame]},
    {...detection(frame, 0.7, 0.1), keypoints:['b',frame]},
  ]);
  const tracks=trackDetections(detections,{maxGapFrames:11});
  assert.equal(tracks.length,2);
  assert.deepEqual(tracks[0].observations.map(o=>o.keypoints),[['a',0],['a',6],['a',12]]);
  assert.equal(tracks[0].representativeFrame,12);
  assert.equal(new Set(tracks.flatMap(t=>t.observations)).size,6);
});

test('appearance suggestions merge across shots, exclude co-occurrence and separate colours', () => {
  const colour=(r,g,b)=>appearanceDescriptor(Buffer.from(Array.from({length:32*32},()=>[r,g,b]).flat()),32,32,{x:0,y:0,w:1,h:1});
  const red=colour(220,10,10), blue=colour(10,10,220);
  const track=(id,shotId,appearance)=>({id,shotId,startFrame:0,endFrame:10,appearance});
  assert.deepEqual(clusterPeople([track('a','S01',red),track('b','S02',red),track('c','S03',blue)]),[['a','b'],['c']]);
  assert.deepEqual(clusterPeople([track('a','S01',red),track('b','S01',red)]),[['a'],['b']]);
  assert.deepEqual(clusterPeople([track('a','S01',null),track('b','S02',null)]),[['a'],['b']]);
});

const box = (x, y, w = 0.2, h = 0.4) => ({x, y, w, h});
const detection = (frame, x, y, confidence = 0.9) => ({frame, box: box(x, y), confidence});

test('IoU math matches the overlap definition', () => {
  assert.equal(boxIoU(box(0, 0), box(0, 0)), 1);
  assert.equal(boxIoU(box(0, 0), box(0.5, 0)), 0);
  const overlap = boxIoU(box(0, 0, 0.5, 0.5), box(0.25, 0, 0.5, 0.5));
  assert.ok(Math.abs(overlap - 1 / 3) < 1e-9);
});

test('a person walking smoothly becomes one continuous track', () => {
  const detections = Array.from({length: 12}, (_, frame) => detection(frame, 0.1 + frame * 0.01, 0.15));
  const tracks = trackDetections(detections);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].startFrame, 0);
  assert.equal(tracks[0].endFrame, 11);
});

test('two people side by side stay two tracks even when crossing with maintained overlap', () => {
  const detections = [];
  for (let frame = 0; frame < 20; frame++) {
    detections.push(detection(frame, 0.1 + frame * 0.02, 0.1));   // A 左→右
    detections.push(detection(frame, 0.7 - frame * 0.02, 0.1));   // B 右→左
  }
  const tracks = trackDetections(detections);
  assert.equal(tracks.length, 2, 'IoU 链接不应把两个持续可分的人合成一条轨迹');
  for (const track of tracks) assert.equal(track.endFrame - track.startFrame, 19);
});

test('a short occlusion gap within the max gap still continues the same track', () => {
  const detections = [];
  for (let frame = 0; frame < 8; frame++) detections.push(detection(frame, 0.4, 0.2));
  for (let frame = 11; frame < 20; frame++) detections.push(detection(frame, 0.4, 0.2)); // 3 帧被完全遮挡
  const tracks = trackDetections(detections, {maxGapFrames: 3});
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].startFrame, 0);
  assert.equal(tracks[0].endFrame, 19);
});

test('a long disappearance starts a new track instead of silently bridging', () => {
  const detections = [];
  for (let frame = 0; frame < 5; frame++) detections.push(detection(frame, 0.4, 0.2));
  for (let frame = 30; frame < 35; frame++) detections.push(detection(frame, 0.4, 0.2));
  const tracks = trackDetections(detections);
  assert.equal(tracks.length, 2);
});

test('cross-shot isolation is structural: each shot is tracked independently', () => {
  // 帧号空间按镜头传入；同一人在两个镜头的框绝不共享轨迹 ID（调用方按镜头调用）。
  const shotA = trackDetections([detection(0, 0.2, 0.2), detection(1, 0.2, 0.2)]);
  const shotB = trackDetections([detection(0, 0.2, 0.2), detection(1, 0.2, 0.2)]);
  assert.equal(shotA.length, 1);
  assert.equal(shotB.length, 1);
  assert.notEqual(shotA[0], shotB[0]);
});

test('without a registered detector, detection fails honestly instead of inventing candidates', async () => {
  const previous = listDetectors();
  assert.equal(hasDetector(), previous.length > 0, '本测试要求初始无检测器注册');
  await assert.rejects(() => runDetection({videoPath: 'x'}), error => {
    assert.equal(error.status, 422);
    assert.match(error.message, /未配置人物检测模型/);
    assert.match(error.message, /人工补标/);
    return true;
  });
});

test('a registered detector is used and reported with its version', async () => {
  registerDetector('fixture', async spec => {
    assert.equal(spec.videoPath, 'fixture.mp4');
    return [detection(0, 0.1, 0.1)];
  }, {version: 'fixture-v1', licenseNote: 'test-only'});
  const result = await runDetection({videoPath: 'fixture.mp4'});
  assert.equal(result.detector, 'fixture');
  assert.equal(result.detectorVersion, 'fixture-v1');
  assert.equal(result.detections.length, 1);
  const observation = trackObservation({shotId: 'S01', provenance: 'auto', detector: result.detector, detectorVersion: result.detectorVersion});
  assert.equal(observation.coordinateSpace, 'normalized-0-1');
});
