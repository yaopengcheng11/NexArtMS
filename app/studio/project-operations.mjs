import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {clusterPeople, clusterPeopleWithSuggestions, clusterAnimalTracks, clusterKnownPeople, appearanceSimilarity, PEOPLE_ALGORITHM} from './people.mjs';

export function semanticPersonId(projectId, subjectId) {
  return `person-semantic-${createHash('sha256').update(JSON.stringify([projectId, String(subjectId)])).digest('hex')}`;
}

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
  const ensurePerson = (trackId, projectId, {appearance, representativeFrame, subject = 'person', species = null} = {}) => {
    const id = newId('person');
    const count = db.prepare('SELECT COUNT(*) AS n FROM source_people WHERE project_id=?').get(projectId).n;
    db.prepare('INSERT INTO source_people(id,project_id,name,method,subject,species) VALUES(?,?,?,?,?,?)').run(id, projectId,
      subject === 'animal' ? `动物·${species || '未知动物'} ${count + 1}` : `人物候选 ${count + 1}`, appearance ? PEOPLE_ALGORITHM : 'manual', subject, species);
    db.prepare('UPDATE tracks SET person_id=?,appearance=?,representative_frame=? WHERE id=?').run(id, appearance ? JSON.stringify(appearance) : null, representativeFrame ?? null, trackId);
  };
  const getPeople = projectId => {
    // V2 P4：素材身份层同时覆盖人物与动物（兼容层复用 source_people，subject 区分）
    const tracks = query.tracks.all(projectId).filter(row => row.status === 'active');
    const bindings = new Map(query.bindings.all(projectId).map(row => [row.track_id, row]));
    return db.prepare('SELECT * FROM source_people WHERE project_id=? ORDER BY rowid').all(projectId).flatMap(person => {
      const subject = person.subject || 'person';
      const members = tracks.filter(track => track.person_id === person.id && (track.subject || 'person') === subject);
      if (!members.length && person.method !== 'count-guided-v2' && !person.reviewed) return [];
      const states = new Set(members.map(track => {const b = bindings.get(track.id);return b?.disposition === 'bound' ? b.character_id : b?.disposition || 'unassigned';}));
      return [{id: person.id, name: person.name, subject, species: person.species || null, method: person.method, reviewed: !!person.reviewed,
        trackIds: members.map(row => row.id), shotIds: [...new Set(members.map(row => row.shot_id))],
        representativeTrackId: members.length ? members.reduce((a, b) => b.confidence > a.confidence ? b : a).id : null,
        assignment: subject === 'animal' ? (person.assignment || 'unassigned') : (states.size === 1 ? [...states][0] : states.size ? 'mixed' : person.assignment),
        appearances: members.map(row => ({trackId: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame}))}];
    });
  };

  // 身份质心：成员轨迹多帧外观的均值（用于稳定映射与疑似关联）
  const entityCentroid = personId => {
    const appearances = db.prepare('SELECT appearance FROM tracks WHERE person_id=? AND appearance IS NOT NULL').all(personId)
      .map(row => JSON.parse(row.appearance)).filter(a => a?.length === 128);
    if (!appearances.length) return null;
    return Array.from({length: 128}, (_, index) => appearances.reduce((sum, a) => sum + a[index], 0) / appearances.length);
  };

  const identityProtected = person => !!person.reviewed || person.method === 'user' || !!db.prepare(`SELECT t.id FROM tracks t
    JOIN bindings b ON b.track_id=t.id LEFT JOIN characters c ON c.id=b.character_id
    WHERE t.person_id=? AND (COALESCE(b.updated_by,'')<>'auto' OR (b.disposition='bound' AND COALESCE(c.provisional,0)=0)) LIMIT 1`).get(person.id);
  const overlaps = (a, b) => a.shot_id === b.shot_id && a.start_frame <= b.end_frame && b.start_frame <= a.end_frame;
  const assertDistinctAppearances = members => {
    for (let index = 0; index < members.length; index++) for (const other of members.slice(index + 1)) {
      if (overlaps(members[index], other)) throw fail('这些出场在同一镜头同时出现，不能标为同一素材身份；叙事代理分组与素材身份不同。', 422);
    }
  };
  const reusableIdentities = (projectId, subject) => db.prepare('SELECT * FROM source_people WHERE project_id=? AND subject=?').all(projectId, subject)
    .filter(person => !identityProtected(person))
    .map(person => ({person, centroid: entityCentroid(person.id), members: query.tracks.all(projectId).filter(row => row.status === 'active' && row.person_id === person.id)}))
    .filter(entry => entry.centroid);
  const compatibleIdentity = (entry, members) => entry.members.every(previous => members.every(member => previous.id === member.id
    || !overlaps(previous, {shot_id: member.shotId, start_frame: member.startFrame, end_frame: member.endFrame})));
  const restoreAutoBinding = (projectId, trackId, person) => {
    const group = person?.assignment && query.character.get(person.assignment, projectId);
    if (!group?.provisional) return;
    db.prepare(`INSERT INTO bindings(track_id,project_id,character_id,disposition,note,updated_by,updated_at) VALUES(?,?,?,'bound','自动临时组','auto',?)
      ON CONFLICT(track_id) DO UPDATE SET character_id=excluded.character_id,disposition='bound',note=excluded.note,updated_by='auto',updated_at=excluded.updated_at
      WHERE bindings.updated_by='auto'`).run(trackId, projectId, group.id, nowIso());
  };

  // 疑似关联（V2 §7.2/C）：相似但未合并的身份对，帮助定位过度拆分
  const getEntitySuggestions = projectId => {
    const entities = getPeople(projectId).map(person => ({...person, centroid: entityCentroid(person.id)})).filter(p => p.centroid);
    const suggestions = [];
    for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) {
      const a = entities[i], b = entities[j];
      if (a.subject !== b.subject) continue;
      if (a.subject === 'animal' && a.species !== b.species) continue;
      const score = appearanceSimilarity(a.centroid, b.centroid);
      if (score >= 0.84) suggestions.push({a: a.id, b: b.id, aName: a.name, bName: b.name, score: Number(score.toFixed(3))});
    }
    return suggestions.sort((a, b) => b.score - a.score).slice(0, 20);
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
      const selected = active.filter(track => ids.includes(track.id));
      if (selected.some(track => (track.subject || 'person') !== people[0].subject)) throw fail('人物与动物出场只能归入相同类别的素材身份', 422);
      if (people[0].subject === 'animal' && selected.some(track => (track.species || '未知动物') !== (people[0].species || '未知动物'))) throw fail('不同物种的动物不能归入同一身份', 422);
      if (input.action === 'release-appearances' && ids.some(id => !people[0].trackIds.includes(id))) throw fail('出场不属于该角色', 400);
      if (people[0].assignment === 'mixed') throw fail('该角色的代理分组不一致，请先为角色选择统一代理组', 422);
      if (input.action === 'assign-appearances') assertDistinctAppearances(active.filter(track => track.person_id === people[0].id || ids.includes(track.id)));
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
      if (people.some(person => person.subject === 'animal') && !['ignored','unassigned'].includes(value)) throw fail('动物叙事组（四足骨架/代理/动作）尚未开放：当前只能忽略或撤销动物身份', 422);
      if (!['ignored','unassigned'].includes(value) && !query.characters.all(projectId).some(row=>row.id===value)) throw fail('目标代理组不存在',404);
      tx(()=>{
        for (const person of people) {
          db.prepare('UPDATE source_people SET reviewed=1,assignment=? WHERE id=?').run(value,person.id);
          for (const trackId of person.trackIds) writeBinding(trackId,value);
        }
        invalidateApprovalLocked(projectId,'角色代理分组被修改');
        bumpRevision(projectId,`更新 ${people.length} 个素材身份的分组`);
      });
      return getPeople(projectId);
    }
    const name = typeof input.name === 'string' ? input.name.trim() : null;
    if (name !== null && (!name || name.length > 40)) throw fail('人物名称必须是 1–40 个字符', 400);
    if (!['merge', 'split', 'rename', 'review'].includes(input.action)) throw fail('未知人物操作', 400);
    if (input.action !== 'merge' && people.length !== 1) throw fail('该操作请选择一个人物候选', 400);
    if (new Set(people.map(person => person.subject)).size > 1) throw fail('人物与动物不能合并为同一素材身份', 422);
    if (input.action === 'merge' && people[0].subject === 'animal' && new Set(people.map(person => person.species || '未知动物')).size > 1) throw fail('不同物种的动物不能合并为同一身份（同品种也不代表同一个体，请逐一核对）', 422);
    const members = query.tracks.all(projectId).filter(track => track.status === 'active' && (track.subject || 'person') === people[0].subject && people.some(person => person.id === track.person_id));
    if (input.action === 'merge') {
      if (people.length < 2) throw fail('至少选择两个人物候选', 400);
      assertDistinctAppearances(members);
    }
    let selected = [];
    if (input.action === 'split') {
      selected = input.trackIds;
      if (!Array.isArray(selected) || !selected.length || selected.length >= members.length || new Set(selected).size !== selected.length || selected.some(id => !members.some(track => track.id === id))) throw fail('请选择该人物的一部分出场片段拆为独立人物', 400);
    }
    tx(() => {
      const targetId = people[0].id;
      if (input.action === 'merge') {
        for (const person of people.slice(1)) {
          db.prepare('UPDATE tracks SET person_id=? WHERE project_id=? AND person_id=?').run(targetId, projectId, person.id);
          db.prepare('DELETE FROM source_people WHERE id=? AND project_id=?').run(person.id, projectId);
        }
      } else if (input.action === 'split') {
        const nextId = newId('person');
        db.prepare('INSERT INTO source_people(id,project_id,name,method,reviewed,assignment,subject,species) VALUES(?,?,?,?,1,?,?,?)').run(nextId, projectId, name || `${people[0].name}（拆出）`.slice(0, 40), 'user', people[0].assignment, people[0].subject, people[0].species);
        for (const trackId of selected) db.prepare('UPDATE tracks SET person_id=? WHERE id=?').run(nextId, trackId);
      }
      db.prepare('UPDATE source_people SET name=?,method=?,reviewed=1 WHERE id=?').run(input.action === 'split' ? people[0].name : name || people[0].name, 'user', targetId);
      invalidateApprovalLocked(projectId, '素材人物标记被修改');
      bumpRevision(projectId, `修改素材人物：${input.action}`);
    });
    return getPeople(projectId);
  };
  const summarizePeople = (projectId, baseRevision, descriptors, semantic) => {
    assertRevision(projectId, baseRevision);
    const rows = query.tracks.all(projectId).filter(row => row.status === 'active' && (row.subject || 'person') !== 'animal');
    const people = getPeople(projectId).filter(person => person.subject === 'person');
    // 语义主体路径（优先）：拉片逐镜语义已判定全片人物主体时，镜内出场直接归属该主体，
    // 身份数量与拉片"人物候选"一致；颜色外观不再是跨镜身份依据。
    if (semantic?.groups?.length) {
      const protectedPeople = people.filter(person => person.method === 'legacy' ? person.reviewed : identityProtected(person));
      if (protectedPeople.length) throw fail('已有核对或分组结果，请从角色详情调整出场；自动整理不会覆盖这些人工决定。', 409);
      const previousSlots = new Map(db.prepare("SELECT * FROM source_people WHERE project_id=? AND method='semantic-v1'").all(projectId).map(person => [person.id, person]));
      const legacyId = subjectId => `person-${String(subjectId).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const legacyCounts = new Map();
      for (const group of semantic.groups) {
        const id = legacyId(group.subjectId);
        legacyCounts.set(id, (legacyCounts.get(id) || 0) + 1);
      }
      tx(() => {
        db.prepare("UPDATE tracks SET person_id=NULL WHERE project_id=? AND status='active' AND (subject IS NULL OR subject='person')").run(projectId);
        db.prepare("DELETE FROM bindings WHERE project_id=? AND updated_by='auto' AND track_id IN (SELECT id FROM tracks WHERE project_id=? AND status='active' AND (subject IS NULL OR subject='person'))").run(projectId, projectId);
        const keep = new Set();
        for (const group of semantic.groups) {
          // Identity comes from the exact subject ID within its project, never its display name or a lossy slug.
          const id = semanticPersonId(projectId, group.subjectId);
          // Old semantic-v1 records can retain their automatic group on rerun only when their old key is unambiguous.
          // Reviewed/user decisions were rejected above; loading a project does not migrate any identity.
          const oldId = legacyId(group.subjectId);
          const previous = previousSlots.get(id) || (oldId !== 'person-' && legacyCounts.get(oldId) === 1 ? previousSlots.get(oldId) : null);
          keep.add(id);
          db.prepare(`INSERT INTO source_people(id,project_id,name,method,subject,assignment) VALUES(?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name WHERE source_people.project_id=excluded.project_id`)
            .run(id, projectId, group.name, 'semantic-v1', 'person', previous?.assignment || 'unassigned');
          for (const trackId of group.trackIds) {
            const appearance = descriptors?.get(trackId);
            db.prepare('UPDATE tracks SET person_id=?,appearance=? WHERE id=?').run(id, appearance ? JSON.stringify(appearance) : null, trackId);
            restoreAutoBinding(projectId, trackId, previous);
          }
        }
        for (const person of people) if (!keep.has(person.id)) db.prepare('DELETE FROM source_people WHERE id=? AND id NOT IN (SELECT person_id FROM tracks WHERE person_id IS NOT NULL)').run(person.id);
        invalidateApprovalLocked(projectId, '按拉片语义主体整理出场');
        bumpRevision(projectId, `按拉片语义主体（${semantic.groups.length} 名）整理出场；语义未覆盖的片段保留待核对`);
      });
      return getPeople(projectId);
    }
    const expectedCount = query.project.get(projectId).source_people_count;
    if (expectedCount) {
      // Legacy IDs are per-track placeholders, not confirmed source identities;
      // count-guided organization may replace those while retaining user bindings.
      const protectedPeople = people.filter(person => person.method === 'legacy' ? person.reviewed : identityProtected(person));
      if (protectedPeople.length) throw fail('已有核对或分组结果，请从角色详情调整出场；自动整理不会覆盖这些人工决定。', 409);
      const tracks = rows.map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame, confidence: row.confidence, box: JSON.parse(row.box),
        appearance: descriptors?.get(row.id) || (row.appearance ? JSON.parse(row.appearance) : null)}));
      const {groups} = clusterKnownPeople(tracks, expectedCount);
      const previousSlots = people.filter(person => person.method === 'count-guided-v2');
      tx(() => {
        db.prepare("UPDATE tracks SET person_id=NULL WHERE project_id=? AND status='active' AND subject='person'").run(projectId);
        db.prepare("DELETE FROM bindings WHERE project_id=? AND updated_by='auto' AND track_id IN (SELECT id FROM tracks WHERE project_id=? AND status='active' AND subject='person')").run(projectId, projectId);
        groups.forEach((members, index) => {
          const id = previousSlots[index]?.id || newId('person');
          db.prepare('INSERT OR IGNORE INTO source_people(id,project_id,name,method) VALUES(?,?,?,?)').run(id, projectId, `角色 ${index + 1}`, 'count-guided-v2');
          for (const trackId of members) {
            db.prepare('UPDATE tracks SET person_id=?,appearance=? WHERE id=?').run(id, JSON.stringify(tracks.find(t=>t.id===trackId).appearance), trackId);
            restoreAutoBinding(projectId, trackId, previousSlots[index]);
          }
        });
        const keep = new Set(groups.map((_, index) => previousSlots[index]?.id).filter(Boolean));
        for (const person of people) if (!keep.has(person.id)) db.prepare('DELETE FROM source_people WHERE id=? AND id NOT IN (SELECT person_id FROM tracks WHERE person_id IS NOT NULL)').run(person.id);
        invalidateApprovalLocked(projectId, '按已知角色数量整理出场');
        bumpRevision(projectId, `按用户指定的 ${expectedCount} 名角色整理出场；不确定片段保留待核对`);
      });
      return getPeople(projectId);
    }
    // Explicit grouping/identity choices are protected from re-analysis.
    const eligible = new Set(people.filter(person => !identityProtected(person)).map(p => p.id));
    const tracks = rows.filter(row => eligible.has(row.person_id)).map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame,
      appearance: descriptors?.get(row.id) || (row.appearance ? JSON.parse(row.appearance) : null)})).filter(track => track.appearance?.length === 128);
    // 稳定 ID 映射（V2 §7.2）：旧身份质心（含已替换轨迹）相似即复用 ID，避免重跑后名称/颜色/绑定漂移
    const oldCentroids = reusableIdentities(projectId, 'person');
    const {groups} = clusterPeopleWithSuggestions(tracks);
    tx(() => {
      const usedOld = new Set();
      let ordinal = db.prepare("SELECT COUNT(*) AS n FROM source_people WHERE project_id=? AND (subject IS NULL OR subject='person')").get(projectId).n;
      for (const ids of groups) {
        const members = ids.map(id => tracks.find(track => track.id === id));
        const centroid = Array.from({length: 128}, (_, index) => members.reduce((sum, t) => sum + t.appearance[index], 0) / members.length);
        let best = null, bestScore = 0;
        for (const entry of oldCentroids) {
          if (usedOld.has(entry.person.id) || !compatibleIdentity(entry, members)) continue;
          const score = appearanceSimilarity(entry.centroid, centroid);
          if (score > bestScore) {bestScore = score;best = entry;}
        }
        let entityId;
        if (best && bestScore >= 0.9) {entityId = best.person.id;usedOld.add(entityId);}
        else {
          entityId = newId('person');
          ordinal++;
          db.prepare('INSERT INTO source_people(id,project_id,name,method) VALUES(?,?,?,?)').run(entityId, projectId, `人物候选 ${ordinal}`, PEOPLE_ALGORITHM);
        }
        for (const trackId of ids) {
          const descriptor = tracks.find(track => track.id === trackId).appearance;
          db.prepare('UPDATE tracks SET person_id=?,appearance=? WHERE id=?').run(entityId, JSON.stringify(descriptor), trackId);
          db.prepare("DELETE FROM bindings WHERE track_id=? AND updated_by='auto'").run(trackId);
          restoreAutoBinding(projectId, trackId, best && bestScore >= 0.9 ? best.person : null);
        }
      }
      db.prepare("DELETE FROM source_people WHERE project_id=? AND (subject IS NULL OR subject='person') AND reviewed=0 AND method<>'user' AND id NOT IN (SELECT person_id FROM tracks WHERE project_id=? AND person_id IS NOT NULL)").run(projectId, projectId);
      invalidateApprovalLocked(projectId, '自动汇总素材人物');
      bumpRevision(projectId, `按多帧外观汇总 ${tracks.length} 段出场为 ${groups.length} 个人物身份（稳定映射）`);
    });
    return getPeople(projectId);
  };

  // 动物素材身份（V2 P4/R2）：分物种聚类、同品种不自动合并、稳定 ID 映射
  const summarizeAnimalEntities = (projectId, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const protectedIds = new Set(getPeople(projectId).filter(identityProtected).map(person => person.id));
    const manualTracks = new Set(query.bindings.all(projectId).filter(binding => binding.updated_by !== 'auto').map(binding => binding.track_id));
    const rows = query.tracks.all(projectId).filter(row => row.status === 'active' && row.subject === 'animal' && row.appearance && !protectedIds.has(row.person_id) && !manualTracks.has(row.id));
    const tracks = rows.map(row => ({id: row.id, shotId: row.shot_id, startFrame: row.start_frame, endFrame: row.end_frame,
      species: row.species || '未知动物', appearance: row.appearance ? JSON.parse(row.appearance) : null})).filter(track => track.appearance?.length === 128);
    if (!tracks.length) return getPeople(projectId);
    const oldCentroids = reusableIdentities(projectId, 'animal');
    const {groups, speciesOf} = clusterAnimalTracks(tracks);
    tx(() => {
      const usedOld = new Set();
      let ordinal = db.prepare("SELECT COUNT(*) AS n FROM source_people WHERE project_id=? AND subject='animal'").get(projectId).n;
      for (const ids of groups) {
        const species = speciesOf.get(ids[0]) || '未知动物';
        const members = ids.map(id => tracks.find(track => track.id === id));
        const centroid = Array.from({length: 128}, (_, index) => members.reduce((sum, t) => sum + t.appearance[index], 0) / members.length);
        let best = null, bestScore = 0;
        for (const entry of oldCentroids) {
          if (usedOld.has(entry.person.id) || (entry.person.species || '未知动物') !== species || !compatibleIdentity(entry, members)) continue;
          const score = appearanceSimilarity(entry.centroid, centroid);
          if (score > bestScore) {bestScore = score;best = entry;}
        }
        let entityId;
        if (best && bestScore >= 0.9) {entityId = best.person.id;usedOld.add(entityId);}
        else {
          entityId = newId('person');
          ordinal++;
          db.prepare('INSERT INTO source_people(id,project_id,name,method,subject,species) VALUES(?,?,?,?,?,?)').run(entityId, projectId, `动物·${species} ${ordinal}`, 'appearance-cluster', 'animal', species);
        }
        for (const trackId of ids) db.prepare('UPDATE tracks SET person_id=? WHERE id=?').run(entityId, trackId);
      }
      db.prepare("DELETE FROM source_people WHERE project_id=? AND subject='animal' AND reviewed=0 AND method<>'user' AND id NOT IN (SELECT person_id FROM tracks WHERE project_id=? AND person_id IS NOT NULL)").run(projectId, projectId);
      bumpRevision(projectId, `动物身份汇总：${groups.length} 个个体（分物种、稳定映射）`);
    });
    return getPeople(projectId);
  };
  // 自动初稿（V2 R1/1.2）：每个自动素材身份建立一个临时叙事组（CL1、自动配色），
  // 并把其出场绑定到组；幂等——已有组的身份跳过，人工决定不覆盖。
  const ensureProvisionalGroups = (projectId, baseRevision) => {
    assertRevision(projectId, baseRevision);
    const people = getPeople(projectId);
    const existingNames = new Set(db.prepare('SELECT name FROM characters WHERE project_id=?').all(projectId).map(row => row.name));
    const created = [];
    let removedStale = 0;
    tx(() => {
      // 自动身份重整后可清理无有效绑定的旧组；人工档案/绑定仍引用的组必须保留，
      // 包括用户把最后一段出场移回待核对后留下的角色档案分组。
      const stale = db.prepare(`SELECT c.id FROM characters c WHERE c.project_id=? AND c.provisional=1 AND NOT EXISTS (
        SELECT 1 FROM bindings b JOIN tracks t ON t.id=b.track_id WHERE b.character_id=c.id AND t.status='active')
        AND NOT EXISTS (SELECT 1 FROM source_people p WHERE p.project_id=c.project_id AND p.assignment=c.id AND (p.reviewed=1 OR p.method='user'))
        AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.character_id=c.id AND COALESCE(b.updated_by,'')<>'auto')`).all(projectId);
      for (const row of stale) {
        db.prepare('DELETE FROM bindings WHERE character_id=?').run(row.id);
        db.prepare("UPDATE source_people SET assignment='unassigned' WHERE project_id=? AND assignment=?").run(projectId, row.id);
        db.prepare('DELETE FROM characters WHERE id=?').run(row.id);
        removedStale++;
      }
      for (const person of people) {
        if (person.subject === 'animal') continue; // 动物叙事组待 P7（四足骨架）
        if (!person.trackIds.length) continue;
        if (identityProtected(person) || person.assignment === 'ignored') continue;
        if (person.assignment && !['unassigned', 'mixed', 'ignored'].includes(person.assignment)) continue;
        let name = person.name.startsWith('人物候选') ? person.name.replace('人物候选', '角色') : person.name;
        let suffix = 2;
        while (existingNames.has(name)) name = `${person.name.replace('人物候选', '角色')}·${suffix++}`;
        const color = ['0xd9773e', '0x547a94', '0x6f9e58', '0xb0567c', '0x8a6fb0', '0xb99a3f', '0x4f9e9e', '0xa05f4f', '0x5d8a6c', '0x7a7a4f', '0x946fb0', '0x4f6d9e']
          [db.prepare('SELECT COUNT(*) AS n FROM characters WHERE project_id=?').get(projectId).n % 12].replace('0x', '#').toUpperCase();
        const id = newId('c');
        const time = nowIso();
        db.prepare('INSERT INTO characters(id, project_id, revision, name, color, scale, rig_ref, allow_simultaneous, proxy_level, rig_family, provisional, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, projectId, 'r-' + Math.random().toString(16).slice(2, 14), name, color, 1.75, '', 0, 'CL1', 'humanoid', 1, time, time);
        existingNames.add(name);
        db.prepare('UPDATE source_people SET assignment=?, reviewed=0 WHERE id=?').run(id, person.id);
        for (const trackId of person.trackIds) {
          db.prepare(`INSERT INTO bindings(track_id,project_id,character_id,disposition,note,updated_by,updated_at) VALUES(?,?,?,'bound','自动临时组','auto',?)
            ON CONFLICT(track_id) DO UPDATE SET character_id=excluded.character_id,disposition='bound',note=excluded.note,updated_by='auto',updated_at=excluded.updated_at`)
            .run(trackId, projectId, id, time);
        }
        created.push({id, name, trackCount: person.trackIds.length});
      }
      if (created.length) bumpRevision(projectId, `自动建立 ${created.length} 个临时叙事组（默认 CL1）`);
      else if (removedStale) bumpRevision(projectId, `清理 ${removedStale} 个失效临时叙事组`);
    });
    return created;
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
    const target = path.resolve(trashRoot, `${projectId}-${newId('delete')}`);
    if (path.dirname(target) !== path.resolve(trashRoot)) throw fail('删除暂存路径越界', 400);
    // One atomic attempt. The HTTP layer releases readers and retries asynchronously;
    // blocking here would prevent fs.close and cancelled preview callbacks from running.
    try {if (exists) fs.renameSync(source, target);}
    catch (cause) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(cause.code)) throw cause;
      throw Object.assign(fail(`项目文件仍被其他进程占用（${cause.code}），项目数据保持原样。请等待文件读取结束后重试。`, 409), {code: 'project_files_busy'});
    }
    try {
      tx(() => {
        db.prepare('DELETE FROM shot_annotations WHERE run_id IN (SELECT id FROM shot_analysis_runs WHERE project_id=?)').run(projectId);
        db.prepare('DELETE FROM shot_analysis_runs WHERE project_id=?').run(projectId);
        for (const table of ['project_history', 'media', 'shots', 'tracks', 'characters', 'bindings', 'jobs', 'cast_approval', 'camera_tracks', 'source_people']) db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
        db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
      });
    } catch (cause) {if (exists) fs.renameSync(target, source);throw cause;}
    let cleanupPending = false;
    try {if (exists) fs.rmSync(target, {recursive: true, force: true});} catch {cleanupPending = true;}
    return {deleted: true, cleanupPending, message: cleanupPending ? '项目记录已删除，文件清理失败，文件仍在 data/.deleted-projects 中。' : '项目及其本地素材、分析数据和导出文件已删除。'};
  };
  return {ensurePerson, getPeople, editPeople, summarizePeople, summarizeAnimalEntities, getEntitySuggestions, ensureProvisionalGroups, updateProject, deleteProject};
}
