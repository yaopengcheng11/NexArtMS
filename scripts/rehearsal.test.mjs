import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../project-store.mjs';
import {createRehearsalStore} from '../rehearsal-store.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jwm-rehearsal-test-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root, 'public/project'), {recursive:true});
  for (const file of ['scene.json', 'shots.json']) fs.copyFileSync(new URL('../public/project/' + file, import.meta.url), path.join(root, 'public/project', file));
  const projectStore = createStore(root);
  const project = projectStore.read();
  const runStore = createRehearsalStore(root, projectStore);
  return {root, projectStore, project, runStore};
}

function formalBytes(root) {
  const files = ['project.json', ...fs.readdirSync(path.join(root, 'data/revisions')).sort().map(file => 'revisions/' + file)];
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(root, 'data', file), 'utf8')]));
}

test('all five stages complete in order without changing formal project or revisions', t => {
  const f = fixture(t);
  const before = formalBytes(f.root);
  assert.equal(f.runStore.read(), null);
  let run = f.runStore.start(f.project.revision);
  assert.equal(run.mode, 'rehearsal');
  assert.equal(run.sourceSceneRevision, f.project.scene.revision);
  assert.deepEqual(run.projectSnapshot, {scene:f.project.scene, shots:f.project.shots});
  const revisions = new Set([run.revision]);
  for (let stage = 1; stage <= 5; stage++) {
    assert.equal(run.currentStage, stage);
    run = f.runStore.advance(run.revision, stage);
    assert.equal(run.decisions.length, stage);
    assert.equal(run.decisions.at(-1).decision, 'demo_passed');
    assert.equal(run.decisions.at(-1).stage, stage);
    assert.ok(Number.isFinite(Date.parse(run.decisions.at(-1).time)));
    assert.equal(run.status, stage === 5 ? 'complete' : 'active');
    assert.equal(revisions.has(run.revision), false);
    revisions.add(run.revision);
  }
  assert.equal(run.currentStage, 5);
  assert.ok(run.completedAt);
  assert.throws(() => f.runStore.advance(run.revision, 5), e => e.status === 409);
  assert.deepEqual(formalBytes(f.root), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'data/rehearsals', run.id + '.json'), 'utf8')), run);
  assert.deepEqual(createRehearsalStore(f.root, createStore(f.root)).read(), run);
  assert.throws(() => f.projectStore.approve(f.project.revision), e => e.status === 422);
});

test('start resumes an active run and explicit restart preserves the previous run', t => {
  const f = fixture(t);
  const first = f.runStore.start(f.project.revision);
  const advanced = f.runStore.advance(first.revision, 1);
  const reopened = createRehearsalStore(f.root, createStore(f.root));
  assert.deepEqual(reopened.start(f.project.revision), advanced);
  const restarted = reopened.start(f.project.revision, true);
  assert.notEqual(restarted.id, advanced.id);
  assert.notEqual(restarted.revision, advanced.revision);
  assert.equal(restarted.currentStage, 1);
  assert.deepEqual(restarted.decisions, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'data/rehearsals', advanced.id + '.json'), 'utf8')), advanced);
  assert.deepEqual(createRehearsalStore(f.root, createStore(f.root)).start(f.project.revision), restarted);
  assert.throws(() => reopened.advance(advanced.revision, 2), e => e.status === 409);
});

test('stale versions, skipped stages, and malformed stages cannot mutate the run', t => {
  const f = fixture(t);
  assert.throws(() => f.runStore.start('old-project'), e => e.status === 409);
  assert.equal(f.runStore.read(), null);
  assert.throws(() => f.runStore.start(f.project.revision, 'true'), e => e.status === 400);
  let run = f.runStore.start(f.project.revision);
  assert.throws(() => f.runStore.advance(run.revision, 2), e => e.status === 409);
  for (const stage of [0, 6, 1.5, '1', null]) assert.throws(() => f.runStore.advance(run.revision, stage), e => e.status === 400);
  assert.deepEqual(f.runStore.read(), run);
  const old = run;
  run = f.runStore.advance(run.revision, 1);
  assert.throws(() => f.runStore.advance(old.revision, 1), e => e.status === 409);
  assert.throws(() => f.runStore.advance(run.revision, 1), e => e.status === 409);
  assert.deepEqual(f.runStore.read(), run);
});

test('formal project changes invalidate the old run and a fresh start captures the new source', t => {
  const f = fixture(t);
  const run = f.runStore.start(f.project.revision);
  const scene = structuredClone(f.project.scene);
  scene.nodes[1].position[0] += 1;
  const project = f.projectStore.update(f.project.revision, scene, '新的正式修改');
  const before = formalBytes(f.root);
  assert.throws(() => f.runStore.advance(run.revision, 1), e => e.status === 409 && /重新演练/.test(e.message));
  assert.throws(() => f.runStore.start(f.project.revision), e => e.status === 409);
  assert.deepEqual(f.runStore.read(), run);
  const next = f.runStore.start(project.revision);
  assert.notEqual(next.id, run.id);
  assert.equal(next.sourceProjectRevision, project.revision);
  assert.equal(next.sourceSceneRevision, project.scene.revision);
  assert.deepEqual(next.projectSnapshot.scene, project.scene);
  assert.deepEqual(formalBytes(f.root), before);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'data/rehearsals', run.id + '.json'), 'utf8')), run);
});

test('snapshot changes in a returned response cannot change persisted rehearsal or project', t => {
  const f = fixture(t);
  const run = f.runStore.start(f.project.revision);
  run.projectSnapshot.scene.nodes[1].position[0] += 999;
  run.decisions.push({stage:5, decision:'demo_passed'});
  assert.deepEqual(f.runStore.read().projectSnapshot.scene, f.project.scene);
  assert.deepEqual(f.projectStore.read(), f.project);
  assert.deepEqual(f.runStore.read().decisions, []);
});
