import test from 'node:test';
import assert from 'node:assert/strict';
import {identityReviewState} from '../src/StudioPeople.tsx';
import type {ProjectDetail} from '../src/studio';

const detail={
  people:[
    {id:'person',subject:'person',species:null,method:'manual',assignment:'unassigned',trackIds:['known-person']},
    {id:'dog',subject:'animal',species:'狗',method:'appearance-cluster',assignment:'unassigned',trackIds:['known-dog']},
    {id:'horse',subject:'animal',species:'马',method:'appearance-cluster',assignment:'unassigned',trackIds:['known-horse']},
    {id:'ignored-dog',subject:'animal',species:'狗',method:'user',assignment:'ignored',trackIds:['ignored-animal']},
  ],
  tracks:[
    {id:'known-person',subject:'person',status:'active'},
    {id:'known-dog',subject:'animal',species:'狗',status:'active'},
    {id:'known-horse',subject:'animal',species:'马',status:'active'},
    {id:'ignored-animal',subject:'animal',species:'狗',status:'active'},
    {id:'free-person',subject:'person',status:'active'},
    {id:'free-dog',subject:'animal',species:'狗',status:'active'},
    {id:'free-horse',subject:'animal',species:'马',status:'active'},
    {id:'old-dog',subject:'animal',species:'狗',status:'superseded'},
  ],bindings:[],
} as unknown as Pick<ProjectDetail,'people'|'tracks'|'bindings'>;

test('R11: animal detail lookup includes animal entities and known animals do not enter the unresolved queue',()=>{
  const state=identityReviewState(detail,'animal');
  assert.equal(state.entities.find(entity=>entity.id==='dog')?.subject,'animal');
  assert.deepEqual(state.unresolved.map(track=>track.id),['free-person','free-dog','free-horse']);
  assert.deepEqual(state.queue.map(track=>track.id),['free-dog','free-horse']);
  assert.deepEqual(state.targets.map(entity=>entity.id),['dog','horse']);
});

test('R11/R12: animal targets match selected species and mixed species cannot be assigned in bulk',()=>{
  assert.deepEqual(identityReviewState(detail,'animal',['free-dog']).targets.map(entity=>entity.id),['dog']);
  assert.deepEqual(identityReviewState(detail,'animal',['free-dog','free-horse']).targets,[]);
  assert.deepEqual(identityReviewState(detail,'person').queue.map(track=>track.id),['free-person']);
  assert.deepEqual(identityReviewState(detail,'person').targets.map(entity=>entity.id),['person']);
});
