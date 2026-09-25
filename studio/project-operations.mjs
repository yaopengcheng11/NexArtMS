import fs from 'node:fs';
import path from 'node:path';
import {clusterPeople, clusterKnownPeople, PEOPLE_ALGORITHM} from './people.mjs';

export function migratePeople(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_people(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
    method TEXT NOT NULL, reviewed INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS source_people_project ON source_people(project_id);`);
  const columns = db.prepare('PRAGMA table_info(tracks)').all().map(row => row.name);
  for (const [name, type] of [['person_id', 'TEXT'], ['appearance', 'TEXT'], ['representative_frame', 'INTEGER']]) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE tracks ADD COLUMN ${name} ${type}`);
  }
  // Legacy track IDs are kept intact; no speculative identity merge in migration.
  db.exec(`INSERT OR IGNORE INTO source_people(id,project_id,name,method,reviewed)
    SELECT 'person-' || id,project_id,'人物候选 ' || substr(id,3),'legacy',0 FROM tracks WHERE person_id IS NULL;
    UPDATE tracks SET person_id='person-' || id WHERE person_id IS NULL;`);
}

export function projectOperations({db, root, tx, query, fail, newId, nowIso, assertRevision, bumpRevision, invalidateApprovalLocked, patchCast}) {
  const ensurePerson = (trackId, projectId, {appearance, representativeFrame} = {}) => {
    const id = newId('person');
    const count = db.prepare('SELECT COUNT(*) AS n FROM source_people WHERE project_id=?').get(projectId).n;
    db.prepare('INSERT INTO source_people(id,project_id,name,method) VALUES(?,?,?,?)').run(id, projectId, `人物候选 ${count + 1}`, appearance ? PEOPLE_ALGORITHM : 'manual');
    db.prepare('UPDATE tracks SET person_id=?,appearance=?,representative_frame=? WHERE id=?').run(id, appearance ? JSON.stringify(appearance) : null, representativeFrame ?? null, trackId);
  };
  const getPeople = projectId => {
    const tracks = query.tracks.all(projectId).filter(row => row.status === 'active');
    const bindings = new Map(query.bindings.all(projectId).map(row => [row.track_id, row]));
    return db.prepare('SELECT * FROM source_people WHERE project_id=? ORDER BY rowid').all(projectId).flatMap(person => {
      const members = tracks.filter(track => track.person_id === person.id);
      if (!members.length && person.method !== 'count-guided-v2' && !person.reviewed) return [];
      const states = new Set(members.map(track => {const b = bindings.get(track.id);return b?.disposition === 'bound' ? b.character_id : b?.disposition || 'unassigned';}));
      return [{id: person.id, name: person.name, method: person.method, reviewed: !!person.reviewed,
        trackIds: members.map(row => row.id), shotIds: [...new Set(members.map(row => row.shot_id))],
        representativeTrackId: members.length ? members.reduce((a, b) => b.confidence > a.confidence ? b : a).id : null,
        assignment: states.size === 1 ? [...states][0] : states.size ? 'mixed' : person.assignment,
        appearances: members.map(row => ({trackId: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame}))}];
    });
  };
  const assertPeople = (projectId, ids) => {
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) throw fail('请选择不重复的人物候选', 400);
    const people = new Map(getPeople(projectId).map(person => [person.id, person]));
    if (ids.some(id => !people.has(id))) throw fail('人物候选不存在或已合并，请刷新', 404);
    return ids.map(id => people.get(id));
  };
  const editPeople = (projectId, baseRevision, input) => {
    assertRevision(projectId, baseRevision);
    const people = assertPeople(projectId, input.personIds);
    const writeBinding = (trackId, assignment) => {
      const disposition = ['ignored','unassigned'].includes(assignment) ? assignment : 'bound';
      const characterId = disposition === 'bound' ? assignment : null;
      const previous = query.bindings.all(projectId).find(row => row.track_id === trackId);
      if (previous?.character_id !== characterId || previous?.disposition !== disposition) db.prepare('UPDATE tracks SET motion_ref=NULL WHERE id=?').run(trackId);
      db.prepare(`INSERT INTO bindings(track_id,project_id,character_id,disposition,note,updated_by,updated_at) VALUES(?,?,?,?,?,'user',?)
        ON CONFLICT(track_id) DO UPDATE SET character_id=excluded.character_id,disposition=excluded.disposition,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(trackId,projectId,characterId,disposition,'角色档案分组',nowIso());
    };
    if (['assign-appearances', 'release-appearances'].includes(input.action)) {
      if (people.length !== 1) throw fail('请选择一个素材角色', 400);
      const ids = input.trackIds;
      const active = query.tracks.all(projectId).filter(row => row.status === 'active');
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !active.some(t => t.id === id))) throw fail('请选择有效的出场片段', 400);
      if (input.action === 'release-appearances' && ids.some(id => !people[0].trackIds.includes(id))) throw fail('出场不属于该角色', 400);
      if (people[0].assignment === 'mixed') throw fail('该角色的代理分组不一致，请先为角色选择统一代理组', 422);
      tx(() => {
        // The profile keeps its group even when its last appearance is released.
        db.prepare('UPDATE source_people SET reviewed=1,assignment=? WHERE id=?').run(people[0].assignment, people[0].id);
        for (const id of ids) {
          db.prepare('UPDATE tracks SET person_id=? WHERE id=?').run(input.action === 'assign-appearances' ? people[0].id : null, id);
          writeBinding(id, input.action === 'assign-appearances' ? people[0].assignment : 'unassigned');
        }
        invalidateApprovalLocked(projectId, '调整角色的出场镜头');
        bumpRevision(projectId, `${input.action === 'assign-appearances' ? '归入角色' : '移回待核对'} ${ids.length} 段出场`);
      });
      return getPeople(projectId);
    }
    if (input.action === 'assign') {
      const value = input.assignment;
      if (!['ignored','unassigned'].includes(value) && !query.characters.all(projectId).some(row=>row.id===value)) throw fail('目标代理组不存在',404);
      tx(()=>{
        for (const person of people) {
          db.prepare('UPDATE source_people SET reviewed=1,assignment=? WHERE id=?').run(value,person.id);
          for (const trackId of person.trackIds) writeBinding(trackId,value);
        }
        invalidateApprovalLocked(projectId,'角色代理分组被修改');
        bumpRevision(projectId,`更新 ${people.length} 个角色的代理分组`);
      });
      return getPeople(projectId);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : null;
    if (name !== null && (!name || name.length > 40)) throw fail('人物名称必须是 1–40 个字符', 400);
    if (!['merge', 'split', 'rename', 'review'].includes(input.action)) throw fail('未知人物操作', 400);
    if (input.action !== 'merge' && people.length !== 1) throw fail('该操作请选择一个人物候选', 400);
    const members = query.tracks.all(projectId).filter(track => track.status === 'active' && people.some(person => person.id === track.person_id));
    if (input.action === 'merge') {
      if (people.length < 2) throw fail('至少选择两个人物候选', 400);
      for (let i = 0; i < members.length; i++) for (const other of members.slice(i + 1)) {
        const a = members[i];
        if (a.shot_id === other.shot_id && a.start_frame <= other.end_frame && other.start_frame <= a.end_frame) throw fail('这些候选在同一镜头同时出现，不能标为同一素材人物；可分到同一代理角色组并明确允许同框。', 422);
      }
    }
    let selected = [];
    if (input.action === 'split') {
      selected = input.trackIds;
      if (!Array.isArray(selected) || !selected.length || selected.length >= members.length || new Set(selected).size !== selected.length || selected.some(id => !members.some(track => track.id === id))) throw fail('请选择该人物的一部分出场片段拆为独立人物', 400);
    }
    tx(() => {
      const targetId = people[0].id;
      if (input.action === 'merge') {
        for (const person of people.slice(1)) db.prepare('UPDATE tracks SET person_id=? WHERE project_id=? AND person_id=?').run(targetId, projectId, person.id);
      } else if (input.action === 'split') {
        const nextId = newId('person');
        db.prepare('INSERT INTO source_people(id,project_id,name,method,reviewed,assignment) VALUES(?,?,?,?,1,?)').run(nextId, projectId, name || `${people[0].name}（拆出）`.slice(0, 40), 'user', people[0].assignment);
        for (const trackId of selected) db.prepare('UPDATE tracks SET person_id=? WHERE id=?').run(nextId, trackId);
      }
      db.prepare('UPDATE source_people SET name=?,method=?,reviewed=1 WHERE id=?').run(input.action === 'split' ? people[0].name : name || people[0].name, 'user', targetId);
      invalidateApprovalLocked(projectId, '素材人物标记被修改');
      bumpRevision(projectId, `修改素材人物：${input.action}`);
    });
    return getPeople(projectId);
  };
  const summarizePeople = (projectId, baseRevision, descriptors) => {
    assertRevision(projectId, baseRevision);
    const rows = query.tracks.all(projectId).filter(row => row.status === 'active');
    const people = getPeople(projectId);
    const expectedCount = query.project.get(projectId).source_people_count;
    if (expectedCount) {
      const protectedPeople = people.filter(person => person.reviewed || (person.method !== 'legacy' && person.assignment !== 'unassigned'));
      if (protectedPeople.length) throw fail('已有核对或分组结果，请从角色详情调整出场；自动整理不会覆盖这些人工决定。', 409);
      const tracks = rows.map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame, confidence: row.confidence, box: JSON.parse(row.box),
        appearance: descriptors?.get(row.id) || (row.appearance ? JSON.parse(row.appearance) : null)}));
      const {groups} = clusterKnownPeople(tracks, expectedCount);
      const previousSlots = people.filter(person => person.method === 'count-guided-v2');
      tx(() => {
        db.prepare("UPDATE tracks SET person_id=NULL WHERE project_id=? AND status='active'").run(projectId);
        groups.forEach((members, index) => {
          const id = previousSlots[index]?.id || newId('person');
          db.prepare('INSERT OR IGNORE INTO source_people(id,project_id,name,method) VALUES(?,?,?,?)').run(id, projectId, `角色 ${index + 1}`, 'count-guided-v2');
          for (const trackId of members) db.prepare('UPDATE tracks SET person_id=?,appearance=? WHERE id=?').run(id, JSON.stringify(tracks.find(t=>t.id===trackId).appearance), trackId);
        });
        const keep = new Set(groups.map((_, index) => previousSlots[index]?.id).filter(Boolean));
        for (const person of people) if (!keep.has(person.id)) db.prepare('DELETE FROM source_people WHERE id=? AND id NOT IN (SELECT person_id FROM tracks WHERE person_id IS NOT NULL)').run(person.id);
        invalidateApprovalLocked(projectId, '按已知角色数量整理出场');
        bumpRevision(projectId, `按用户指定的 ${expectedCount} 名角色整理出场；不确定片段保留待核对`);
      });
      return getPeople(projectId);
    }
    // Explicit grouping/identity choices are protected from re-analysis.
    const eligible = new Set(people.filter(p => !p.reviewed && p.assignment === 'unassigned').map(p => p.id));
    const tracks = rows.filter(row => eligible.has(row.person_id)).map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame,
      appearance: descriptors?.get(row.id) || (row.appearance ? JSON.parse(row.appearance) : null)}));
    const groups = clusterPeople(tracks);
    tx(() => {
      for (const ids of groups) {
        const id = newId('person');
        const ordinal = db.prepare('SELECT COUNT(*) AS n FROM source_people WHERE project_id=?').get(projectId).n + 1;
        db.prepare('INSERT INTO source_people(id,project_id,name,method) VALUES(?,?,?,?)').run(id, projectId, `人物候选 ${ordinal}`, PEOPLE_ALGORITHM);
        for (const trackId of ids) {
          const descriptor = tracks.find(track => track.id === trackId).appearance;
          db.prepare('UPDATE tracks SET person_id=?,appearance=? WHERE id=?').run(id, descriptor ? JSON.stringify(descriptor) : null, trackId);
        }
      }
      db.prepare('DELETE FROM source_people WHERE project_id=? AND id NOT IN (SELECT person_id FROM tracks WHERE project_id=?)').run(projectId, projectId);
      invalidateApprovalLocked(projectId, '自动汇总素材人物');
      bumpRevision(projectId, `按外观汇总 ${tracks.length} 段出场为 ${groups.length} 个人物候选（待核对）`);
    });
    return getPeople(projectId);
  };
  const updateProject = (projectId, input, baseRevision) => {
    const project = assertRevision(projectId, baseRevision);
    const name = input.name === undefined ? project.name : typeof input.name === 'string' ? input.name.trim() : '';
    const note = input.note === undefined ? project.note : input.note;
    const mode = input.sceneMode ?? project.scene_mode;
    const expectedCount = input.sourcePeopleCount === undefined ? project.source_people_count : input.sourcePeopleCount;
    if (expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 30)) throw fail('片中角色数量须为 1–30 的整数，未知时可留空', 400);
    if (!name || name.length > 80) throw fail('项目名称必须是 1–80 个字符', 400);
    if (typeof note !== 'string' || note.length > 400) throw fail('项目说明最多 400 个字符', 400);
    if (!['proxy', 'reconstruct'].includes(mode)) throw fail('场景模式必须是 proxy 或 reconstruct', 400);
    tx(() => {
      db.prepare('UPDATE projects SET name=?,note=?,scene_mode=?,scene_status=? WHERE id=?').run(name, note, mode, mode === project.scene_mode ? project.scene_status : mode === 'proxy' ? 'not_requested' : 'pending', projectId);
      db.prepare('UPDATE projects SET source_people_count=? WHERE id=?').run(expectedCount, projectId);
      if (mode !== project.scene_mode) invalidateApprovalLocked(projectId, '场景模式被修改');
      bumpRevision(projectId, '更新项目设置');
    });
    return query.project.get(projectId);
  };
  const deleteProject = (projectId, baseRevision, confirmName) => {
    const project = assertRevision(projectId, baseRevision);
    if (confirmName !== project.name) throw fail('请输入完整项目名称确认删除', 400);
    if (query.jobs.all(projectId).some(job => ['queued', 'running'].includes(job.state))) throw fail('项目有排队或运行中的任务，请等待任务结束或取消完成后再删除', 409);
    if (!/^p-[a-f0-9]{12}$/.test(projectId)) throw fail('项目目录标识无效', 400);
    const parent = fs.realpathSync(path.join(root, 'data', 'projects'));
    const source = path.resolve(parent, projectId);
    if (path.dirname(source) !== parent) throw fail('项目目录越界', 400);
    const exists = fs.existsSync(source);
    if (exists && (fs.lstatSync(source).isSymbolicLink() || path.dirname(fs.realpathSync(source)) !== parent)) throw fail('项目目录不能是符号链接或目录联接', 409);
    const trashRoot = path.join(root, 'data', '.deleted-projects');
    fs.mkdirSync(trashRoot, {recursive: true});
    if (fs.lstatSync(trashRoot).isSymbolicLink()) throw fail('删除暂存目录不能是链接', 409);
    const target = path.join(trashRoot, `${projectId}-${newId('delete')}`);
    if (exists) fs.renameSync(source, target);
    try {
      tx(() => {
        for (const table of ['project_history', 'media', 'shots', 'tracks', 'characters', 'bindings', 'jobs', 'cast_approval', 'camera_tracks', 'source_people']) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
        db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      });
    } catch (cause) {if (exists) fs.renameSync(target, source);throw cause;}
    let cleanupPending = false;
    try {if (exists) fs.rmSync(target, {recursive: true, force: true});} catch {cleanupPending = true;}
    return {deleted: true, cleanupPending, message: cleanupPending ? '项目记录已删除，文件清理失败，文件仍在 data/.deleted-projects 中。' : '项目及其本地素材、分析数据和导出文件已删除。'};
  };
  return {ensurePerson, getPeople, editPeople, summarizePeople, updateProject, deleteProject};
}
