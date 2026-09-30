import test from 'node:test';
import assert from 'node:assert/strict';
import {playbackTimeOrigin, sourceTimeOrigin, sourceUsToVideoTime, videoTimeToSourceUs} from '../src/studio-playback-clock';
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

test('audio leading the video keeps its preview offset without advancing the source shot', () => {
  const offset = playbackTimeOrigin({sourceOriginUs: 500000, mediaOriginUs: 500000})!;
  const shots = [{id: 'S01', startUs: 500000, endUs: 1500000}, {id: 'S02', startUs: 1500000, endUs: 2500000}] as ShotInfo[];
  assert.equal(offset, 0);
  assert.equal(videoTimeToSourceUs(1, offset), 1000000);
  assert.equal(shotAt(shots, videoTimeToSourceUs(1, offset)).shot?.id, 'S01');
  assert.equal(sourceUsToVideoTime(shots[1].startUs, offset), 1.5);
  for (const sourceUs of [500000, 1000000, 1500000, 2400000]) {
    assert.equal(videoTimeToSourceUs(sourceUsToVideoTime(sourceUs, offset), offset), sourceUs);
  }
});

test('served media determines the offset for rebased proxies, retained timestamps, and original fallback', () => {
  for (const [sourceOriginUs, mediaOriginUs, sourcePositionUs, expectedVideoTime] of [
    [0, 0, 1000000, 1],
    [2400000, 0, 3515000, 1.115],
    [2400000, 500000, 3515000, 1.615],
    [2400000, 2400000, 3515000, 3.515],
    [-80000, 0, 42000, 0.122],
  ]) {
    const offset = playbackTimeOrigin({sourceOriginUs, mediaOriginUs})!;
    assert.equal(sourceUsToVideoTime(sourcePositionUs, offset), expectedVideoTime);
    assert.equal(videoTimeToSourceUs(expectedVideoTime, offset), sourcePositionUs);
  }
  for (const value of [undefined, null, {}, {sourceOriginUs: 0}, {sourceOriginUs: NaN, mediaOriginUs: 0}, {sourceOriginUs: 0, mediaOriginUs: Infinity}, {sourceOriginUs: '0', mediaOriginUs: 0}]) {
    assert.equal(playbackTimeOrigin(value), null, 'missing preview evidence must not imply a zero video origin');
  }
});
