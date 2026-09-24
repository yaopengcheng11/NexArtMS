import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fail = (message, status = 409) => Object.assign(new Error(message), {status});

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function createRehearsalStore(root, projectStore) {
  const dataDirectory = path.join(root, 'data');
  const statePath = path.join(dataDirectory, 'rehearsal.json');
  const read = () => fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const persist = run => {
    atomicWrite(path.join(dataDirectory, 'rehearsals', run.id + '.json'), run);
    atomicWrite(statePath, run);
    return run;
  };

  const start = (baseRevision, restart = false) => {
    if (typeof restart !== 'boolean') throw fail('重新演练参数无效', 400);
    const project = projectStore.read();
    if (baseRevision !== project.revision) throw fail('正式项目版本已变化，请刷新后重新演练');
    const previous = read();
    if (!restart && previous?.status === 'active' && previous.sourceProjectRevision === project.revision && previous.sourceSceneRevision === project.scene.revision) return previous;
    const time = new Date().toISOString();
    return persist({
      id:'rehearsal-' + crypto.randomUUID(),
      revision:'rehearsal-revision-' + crypto.randomUUID(),
      mode:'rehearsal',
      currentStage:1,
      status:'active',
      sourceProjectRevision:project.revision,
      sourceSceneRevision:project.scene.revision,
      projectSnapshot:structuredClone({scene:project.scene, shots:project.shots}),
      decisions:[],
      createdAt:time,
      updatedAt:time,
      completedAt:null,
    });
  };

  const advance = (baseRevision, stage) => {
    const run = read();
    if (!run) throw fail('请先开始流程演练');
    if (baseRevision !== run.revision) throw fail('演练版本已变化，请刷新后继续');
    const project = projectStore.read();
    if (run.sourceProjectRevision !== project.revision || run.sourceSceneRevision !== project.scene.revision) throw fail('正式项目版本已变化，请重新演练');
    if (run.status !== 'active') throw fail('本次演练已完成，请重新开始演练');
    if (!Number.isInteger(stage) || stage < 1 || stage > 5) throw fail('演练阶段必须为 1 到 5 的整数', 400);
    if (stage !== run.currentStage) throw fail('请按顺序通过当前演练阶段');
    const time = new Date().toISOString();
    return persist({
      ...run,
      revision:'rehearsal-revision-' + crypto.randomUUID(),
      currentStage:Math.min(stage + 1, 5),
      status:stage === 5 ? 'complete' : 'active',
      decisions:[...run.decisions, {stage, decision:'demo_passed', time}],
      updatedAt:time,
      completedAt:stage === 5 ? time : null,
    });
  };

  return {read, start, advance};
}
