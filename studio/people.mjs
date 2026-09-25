// Clothing-colour evidence is a conservative suggestion, never a verified identity.
export const PEOPLE_ALGORITHM = 'body-colour-complete-link-v1';

export function appearanceDescriptor(rgb, width, height, box) {
  const values = [];
  // Two body regions; avoid background along box edges and most of the head.
  for (const [top, bottom] of [[0.2, 0.55], [0.55, 0.9]]) {
    const bins = Array(64).fill(0);
    let count = 0;
    const x0 = Math.max(0, Math.floor((box.x + box.w * 0.2) * width));
    const x1 = Math.min(width, Math.ceil((box.x + box.w * 0.8) * width));
    const y0 = Math.max(0, Math.floor((box.y + box.h * top) * height));
    const y1 = Math.min(height, Math.ceil((box.y + box.h * bottom) * height));
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      const at = (y * width + x) * 3;
      bins[(rgb[at] >> 6) * 16 + (rgb[at + 1] >> 6) * 4 + (rgb[at + 2] >> 6)]++;
      count++;
    }
    if (count < 4) return null;
    values.push(...bins.map(value => value / count));
  }
  return values;
}

export function appearanceSimilarity(a, b) {
  if (!a || !b || a.length !== 128 || b.length !== 128) return 0;
  return a.reduce((sum, value, index) => sum + Math.sqrt(value * b[index]), 0) / 2;
}

export function clusterPeople(tracks, {threshold = 0.94, margin = 0.04} = {}) {
  const groups = [];
  for (const track of tracks) {
    const ranked = groups.map(group => {
      const overlaps = group.some(other => other.shotId === track.shotId && other.startFrame <= track.endFrame && track.startFrame <= other.endFrame);
      // Complete linkage prevents an uncertain chain gradually joining different people.
      return {group, score: overlaps ? 0 : Math.min(...group.map(other => appearanceSimilarity(other.appearance, track.appearance)))};
    }).sort((a, b) => b.score - a.score);
    if (ranked[0]?.score >= threshold && ranked[0].score - (ranked[1]?.score || 0) >= margin) ranked[0].group.push(track);
    else groups.push([track]);
  }
  return groups.map(group => group.map(track => track.id));
}

// The user supplies the number of source people. Uncertain detections stay in a
// review queue instead of becoming extra identity cards or being forced to fit.
export function clusterKnownPeople(tracks, count) {
  const weight = track => Math.max(1, Math.sqrt(track.endFrame - track.startFrame + 1)) * (track.confidence || 0.5);
  const usable = tracks.filter(track => track.appearance?.length === 128 && (track.confidence ?? 1) >= 0.4 && (!track.box || track.box.w * track.box.h >= 0.01));
  const groups = Array.from({length: count}, () => []);
  if (!usable.length) return {groups, unresolvedIds: tracks.map(t => t.id)};
  const ranked = [...usable].sort((a, b) => weight(b) - weight(a));
  const seeds = [ranked[0]];
  while (seeds.length < count && seeds.length < usable.length) {
    const candidates = usable.filter(t => !seeds.includes(t));
    candidates.sort((a, b) => {
      const score = t => (1 - Math.max(...seeds.map(seed => appearanceSimilarity(seed.appearance, t.appearance)))) * Math.sqrt(weight(t));
      return score(b) - score(a);
    });
    seeds.push(candidates[0]);
  }
  let centres = seeds.map(seed => seed.appearance);
  for (let iteration = 0; iteration < 30; iteration++) {
    const buckets = centres.map(() => []);
    for (const track of usable) {
      const scores = centres.map(c => appearanceSimilarity(c, track.appearance));
      buckets[scores.indexOf(Math.max(...scores))].push(track);
    }
    centres = buckets.map((members, index) => {
      if (!members.length) return centres[index];
      const total = members.reduce((sum, track) => sum + weight(track), 0);
      return Array.from({length:128}, (_, i) => members.reduce((sum, track) => sum + track.appearance[i] * weight(track), 0) / total);
    });
  }
  const matches = usable.map(track => {
    const ranked = centres.map((centre, index) => ({index, score: appearanceSimilarity(centre, track.appearance)})).sort((a,b)=>b.score-a.score);
    return {track, index: ranked[0].index, score: ranked[0].score, margin: ranked[0].score - (ranked[1]?.score || 0)};
  }).sort((a,b)=>b.margin-a.margin || weight(b.track)-weight(a.track));
  const assigned = new Set();
  for (const match of matches) {
    if (match.score < 0.55 || match.margin < 0.035) continue;
    const group = groups[match.index];
    if (group.some(other => other.shotId === match.track.shotId && other.startFrame <= match.track.endFrame && match.track.startFrame <= other.endFrame)) continue;
    group.push({...match.track, identityScore: match.score});assigned.add(match.track.id);
  }
  return {groups: groups.map(group => group.sort((a,b)=>b.identityScore-a.identityScore).map(track=>track.id)), unresolvedIds: tracks.filter(t=>!assigned.has(t.id)).map(t=>t.id)};
}
