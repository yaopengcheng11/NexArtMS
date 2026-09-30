import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceTimeOrigin, sourceUsToVideoTime, videoTimeToSourceUs} from '../src/studio-playback-clock';
import {shotAt} from '../src/studio-timeline';
import type {ShotInfo} from '../src/studio';

test('non-zero PTS origin selects the same shot after seeking and switching workspaces', () => {
  const pts = [2400000, 2442000, 2515000, 2570000, 2660000];
  const origin = sourceTimeOrigin(pts)!;
  const shots = [
    {id: 'S01', startUs: pts[0], endUs: pts[2]},
    {id: 'S02', startUs: pts[2], endUs: 2710000},
  ] as ShotInfo[];
  const videoTime = sourceUsToVideoTime(pts[2], origin);
  assert.equal(videoTime, 0.115);
  const resumedSourceTime = videoTimeToSourceUs(videoTime, origin);
  assert.equal(resumedSourceTime, pts[2]);
  assert.equal(shotAt(shots, resumedSourceTime).shot?.id, 'S02');
  assert.equal(shotAt(shots, resumedSourceTime - 1).shot?.id, 'S01');
  for (const time of pts) assert.equal(videoTimeToSourceUs(sourceUsToVideoTime(time, origin), origin), time);
});

test('zero and negative source origins are valid, missing evidence does not become zero', () => {
  assert.equal(sourceTimeOrigin([0, 42000]), 0);
  assert.equal(sourceTimeOrigin([-80000, -38000, 0]), -80000);
  assert.equal(videoTimeToSourceUs(sourceUsToVideoTime(0, -80000), -80000), 0);
  for (const input of [undefined, null, [], [NaN], [Infinity], ['0']]) assert.equal(sourceTimeOrigin(input), null);
});

test('requested source positions clamp to the playable video range', () => {
  assert.equal(sourceUsToVideoTime(1000000, 2400000, 5), 0);
  assert.equal(sourceUsToVideoTime(999999999, 2400000, 5), 5);
  assert.equal(sourceUsToVideoTime(3000000, 2400000, NaN), 0.6);
});
