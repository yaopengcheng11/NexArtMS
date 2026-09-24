import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INPUT_DIR = fs.existsSync(path.join(PROJECT,'data/raw.json')) ? path.join(PROJECT,'data') : path.resolve(PROJECT,'../pose-reconstruction');
const argv = process.argv.slice(2);
const requestedInput = argv.includes('--input') ? argv[argv.indexOf('--input') + 1] : null;
const inputCandidates = argv.includes('--augmented') ? ['raw-augmented.json', 'raw.json', 'partial.json'] : ['raw.json', 'partial.json'];
const input = requestedInput ? path.resolve(requestedInput) : inputCandidates.map(x => path.join(INPUT_DIR, x)).find(x => fs.existsSync(x));
if (!input) throw new Error('No measured pose data exists yet.');
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const layout = JSON.parse(fs.readFileSync(path.join(INPUT_DIR, 'source-layout.json'), 'utf8'));
const extraPath=path.join(INPUT_DIR,'extra-overrides.json');
if (fs.existsSync(extraPath)) {
  const extra=JSON.parse(fs.readFileSync(extraPath,'utf8'));
  for (const override of extra.shots||[]) {
    const shot=layout.shots.find(s=>s.id===override.id);
    if (!shot) throw new Error(`Unknown override shot ${override.id}`);
    const keys=override.manualKeyframes||[];
    const replacedRoles=new Set(keys.map(k=>k.actor));
    shot.manualKeyframes=[...(shot.manualKeyframes||[]).filter(k=>!replacedRoles.has(k.actor)),...keys];
    shot.extraOverrideNotes=override.notes||'';
  }
}

const breakdown = JSON.parse(fs.readFileSync(fs.existsSync(path.join(PROJECT,'shots.json')) ? path.join(PROJECT,'shots.json') : path.resolve(PROJECT,'../../outputs/jwm-shots/shots.json'), 'utf8'));
const FPS = 24, TOTAL = 1203, ASPECT = 16 / 9, MIN_CONF = .25;
const NAMES = ['nose', 'leftEye', 'rightEye', 'leftEar', 'rightEar', 'leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftWrist', 'rightWrist', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee', 'leftAnkle', 'rightAnkle', 'leftToe', 'rightToe'];
const INDEX = Object.fromEntries(NAMES.map((x, i) => [x, i]));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const distance = (a, b) => Math.hypot((a[0] - b[0]) * ASPECT, a[1] - b[1]);
const mix = (a, b, t) => a + (b - a) * t;
const median = xs => xs.length ? [...xs].sort((a,b) => a-b)[Math.floor(xs.length / 2)] : null;
const percentile = (xs, p) => xs.length ? [...xs].sort((a,b) => a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))] : null;
const valid = p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[2] > MIN_CONF;
const avg = xs => xs.length ? [xs.reduce((a,p)=>a+p[0],0)/xs.length,xs.reduce((a,p)=>a+p[1],0)/xs.length] : null;
const center = (d, ids = [5,6,11,12]) => avg(ids.map(i=>d.keypoints[i]).filter(valid)) || [(d.box[0]+d.box[2])/2,(d.box[1]+d.box[3])/2];
const headCenter = d => avg([0,1,2,3,4].map(i=>d.keypoints[i]).filter(valid));
const quality = d => d.score * (.35 + .65 * d.keypoints.slice(5,17).reduce((s,p)=>s+(p?.[2]||0),0)/12);

function suppress(detections, shot) {
  const largest = Math.max(0,...detections.map(d=>(d.box[2]-d.box[0])*(d.box[3]-d.box[1])));
  const isClose = ['close','medium-close','medium'].includes(shot.size);
  const sorted = detections.filter(d => d.score >= .11 && d.keypoints.filter(valid).length >= 3 && !(isClose && largest>.25 && (d.box[2]-d.box[0])*(d.box[3]-d.box[1])<.04)).sort((a,b)=>quality(b)-quality(a));
  const kept = [];
  for (const d of sorted) {
    const duplicate = kept.some(k => {
      const [a,b] = [d.box,k.box];
      const intersect = Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])) * Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
      const smaller = Math.min((a[2]-a[0])*(a[3]-a[1]),(b[2]-b[0])*(b[3]-b[1]));
      if (intersect / Math.max(.00001,smaller) < .65) return false;
      const dh = headCenter(d), kh = headCenter(k);
      if (dh && kh && distance(dh,kh) > .13) return false;
      return distance(center(d),center(k)) < .24 || (dh && kh && distance(dh,kh) < .07);
    });
    if (!duplicate) kept.push(d);
  }
  return kept.slice(0, 4);
}

function appearance(d) {
  const a = d.appearance || {};
  let sum = 0, weight = 0;
  if (a.pants_rgb) { sum += clamp((a.pants_rgb[0]-a.pants_rgb[2])/25,-2,2)*2; weight += 2; }
  if (a.shirt_rgb) { sum += clamp((a.shirt_rgb[0]-a.shirt_rgb[2])/25,-2,2)*.55; weight += .55; }
  if (a.upper_shirt_rgb) { sum += clamp((a.upper_shirt_rgb[0]-a.upper_shirt_rgb[2])/25,-2,2)*.65; weight += .65; }
  return weight ? sum / weight : 0;
}

function matchDistance(a, b) {
  const ids = [0,5,6,11,12];
  const ds = ids.filter(i=>valid(a.keypoints[i])&&valid(b.keypoints[i])).map(i=>distance(a.keypoints[i],b.keypoints[i]));
  return median(ds) ?? distance(center(a),center(b));
}

function assignments(dets, shot, previous, frameIndex) {
  const fragments = new Set((shot.manualKeyframes || []).filter(k=>k.mode==='fragment').map(k=>k.actor));
  // A manually drawn edge limb is not a second full person. Letting that role
  // compete here can steal the true main body and leave a foot hallucination.
  const roles = [...new Set(shot.order || [shot.dominant])].filter(role=>!fragments.has(role));
  if (fragments.size && roles.length===1) {
    const role=roles[0];
    const scored=dets.map(det=>{
      const face=det.keypoints.slice(0,5).reduce((sum,p)=>sum+(p?.[2]||0),0)/5;
      const core=[5,6,11,12].reduce((sum,i)=>sum+(det.keypoints[i]?.[2]||0),0)/4;
      return {det,score:det.score*(.45+.3*core+.25*face)};
    }).sort((a,b)=>b.score-a.score);
    if (!scored.length) return {};
    const det=scored[0].det;
    previous[role]={det,frame:frameIndex};
    return {[role]:det};
  }
  const options = [-1, ...dets.map((_,i)=>i)];
  const leftOrder = [...dets.keys()].sort((a,b)=>center(dets[a])[0]-center(dets[b])[0]);
  let best = null, bestCost = Infinity;
  for (const ai of roles.includes('A') ? options : [-1]) for (const bi of roles.includes('B') ? options : [-1]) {
    if (ai >= 0 && ai === bi) continue;
    let cost = 0;
    for (const [role,di] of [['A',ai],['B',bi]]) {
      if (!roles.includes(role)) continue;
      if (di < 0) { cost += fragments.has(role) ? .2 : 1.2; continue; }
      const d = dets[di], color = appearance(d);
      cost -= quality(d) * 1.1;
      cost += role === 'A' ? -color*.6 : color*.6;
      const prev = previous[role];
      if (prev && frameIndex - prev.frame < 16) cost += Math.min(2,matchDistance(d,prev.det)*4.5);
      else if (dets.length >= 2) {
        const rank = leftOrder.indexOf(di);
        const expected = roles.indexOf(role);
        cost += Math.abs(rank-expected)*.3;
      } else if (role !== shot.dominant) cost += .55;
      if (fragments.has(role) && role !== shot.dominant && d.keypoints.slice(0,7).filter(valid).length >= 5 && dets.length === 1) cost += 1.4;
    }
    if (cost < bestCost) { bestCost = cost; best = {A:ai,B:bi}; }
  }
  const out = {};
  for (const role of roles) if (best?.[role] >= 0) {
    out[role] = dets[best[role]];
    previous[role] = {det:out[role],frame:frameIndex};
  }
  return out;
}

function sampleJoint(observations, t, maxDistance=Infinity) {
  if (!observations.length) return null;
  let r = observations.findIndex(p=>p.t>=t);
  if (r < 0) return t-observations.at(-1).t<=maxDistance ? [...observations.at(-1).p] : null;
  if (r === 0 || observations[r].t === t) return observations[r].t-t<=maxDistance ? [...observations[r].p] : null;
  const a = observations[r-1], b = observations[r];
  if (Math.min(t-a.t,b.t-t)>maxDistance) return null;
  if (a.t === b.t) return [...b.p];
  const w = (t-a.t)/(b.t-a.t);
  return [mix(a.p[0],b.p[0],w),mix(a.p[1],b.p[1],w),Math.min(a.p[2],b.p[2])];
}

function manualAt(keys, t) {
  if (!keys.length) return null;
  let right = keys.findIndex(k=>k.t>=t);
  if (right < 0) right = keys.length-1;
  const left = right === 0 ? 0 : right-1;
  const a = keys[left], b = keys[right];
  const w = a.t === b.t ? 0 : clamp((t-a.t)/(b.t-a.t),0,1);
  const visible = (w < .5 ? a : b).visible !== false;
  const joints = {};
  for (const name of new Set([...Object.keys(a.joints),...Object.keys(b.joints)])) {
    const p = a.joints[name] || b.joints[name], q = b.joints[name] || a.joints[name];
    joints[INDEX[name]] = visible ? [mix(p[0],q[0],w),mix(p[1],q[1],w),1] : null;
  }
  return {mode:b.mode || a.mode || 'replace',visible,joints};
}

function completeCroppedTorso(j, shot) {
  if (!j[5] || !j[6] || (j[11] && j[12])) return 0;
  const shoulders = avg([j[5],j[6]]);
  // Upper-body inserts need an offscreen pelvis to preserve their source crop.
  // Feet/fragment inserts never enter this path.
  if (shoulders[1] < .25 || !['medium-close','medium','close','medium-wide'].includes(shot.size)) return 0;
  const shoulderWidth = distance(j[5],j[6]);
  const length = clamp(shoulderWidth * 1.25,.14,.65);
  const hipY = Math.max(1.07,shoulders[1] + length);
  if (!j[11]) j[11] = [j[5][0]*.75+shoulders[0]*.25,hipY,.26];
  if (!j[12]) j[12] = [j[6][0]*.75+shoulders[0]*.25,hipY,.26];
  return 1;
}

const rawMap = new Map(raw.frames.map(f=>[f.frame,f]));
const rawComplete = rawMap.size === TOTAL && Array.from({length:TOTAL},(_,i)=>i).every(i=>rawMap.has(i));
const sourceShots = Array.isArray(breakdown) ? breakdown : breakdown.shots;
const frames = Array.from({length:TOTAL},(_,frame)=>({actors:{}}));
const audits = [];
let suppressedTotal=0;
for (let si=0;si<layout.shots.length;si++) {
  const shot = {...sourceShots[si],...layout.shots[si]};
  const begin = Math.round(shot.start*FPS), end = si+1<layout.shots.length ? Math.round(layout.shots[si+1].start*FPS) : TOTAL;
  const observations = {A:Array.from({length:19},()=>[]),B:Array.from({length:19},()=>[])};
  const detected = {A:0,B:0}, low = {A:0,B:0};
  const previous = {};
  let measuredFrames=0,suppressed=0;
  for (let fi=begin;fi<end;fi++) {
    const rawFrame = rawMap.get(fi);
    if (!rawFrame) continue;
    measuredFrames++;
    const candidates = suppress(rawFrame.detections,shot);
    suppressed += rawFrame.detections.length-candidates.length;
    const assigned = assignments(candidates,shot,previous,fi);
    for (const role of ['A','B']) if (assigned[role]) {
      detected[role]++;
      for (let ji=0;ji<17;ji++) {
        const point = assigned[role].keypoints[ji];
        if (valid(point)) observations[role][ji].push({t:fi,p:point});
        else low[role]++;
      }
    }
  }
  suppressedTotal += suppressed;
  const roles = [...new Set([...(shot.order || []),...(shot.manualKeyframes || []).map(k=>k.actor)])];
  const roleStats={};
  for (const role of roles) {
    const keys = (shot.manualKeyframes || []).filter(k=>k.actor===role).sort((a,b)=>a.t-b.t);
    const exists = detected[role] > 0 || keys.some(k=>k.visible!==false);
    if (!exists) continue;
    const actorFrames=[],scales=[],footYs=[],limbSamples=[],frameLimbMax=[];
    const fullBodyManual = keys.some(k=>k.scope==='fullbody');
    let manualCount=0,filledJointCount=0,croppedCount=0,activeCount=0;
    for (let fi=begin;fi<end;fi++) {
      let j = observations[role].map((obs,ji)=>sampleJoint(obs,fi,ji>=1&&ji<=4?3:Infinity));
      for(let ji=0;ji<19;ji++) if(j[ji]&&!observations[role][ji].some(p=>p.t===fi)) filledJointCount++;
      const manual = manualAt(keys,fi/FPS);
      if (manual) {
        manualCount++;
        // Manual fragments describe the only visible parts of that actor in the insert.
        // Discard person-detector hallucinations outside these explicit segments.
        if (manual.mode==='replace' || manual.mode==='fragment') j=Array(19).fill(null);
        for(const [ji,p] of Object.entries(manual.joints)) j[ji]=p;
      }
      if ((shot.actorVisibility||[]).some(v=>v.actor===role&&v.visible===false&&fi/FPS>=v.start&&fi/FPS<v.end)) { actorFrames.push(null); continue; }
      // These blocking inserts show only B's upper body. Detected lower limbs
      // belong to the incoming foot/occluder and must not be filled across time.
      if (role==='B' && ['S06','S12','S18'].includes(shot.id)) for(let ji=13;ji<19;ji++) j[ji]=null;
      if (!manual) croppedCount += completeCroppedTorso(j,shot);
      if (!j.some(Boolean)) { actorFrames.push(null); continue; }
      if (j[5]&&j[6]&&j[11]&&j[12]) scales.push(distance(avg([j[5],j[6]]),avg([j[11],j[12]])));
      else {
        for (const [a,b] of [[11,13],[12,14],[13,15],[14,16],[5,7],[6,8]]) if(j[a]&&j[b]) scales.push(distance(j[a],j[b]));
      }
      const limbEstimates=[];
      for (const [a,b,factor] of [[11,13,1.05],[12,14,1.05],[13,15,1.05],[14,16,1.05],[5,7,1.4],[6,8,1.4],[7,9,1.4],[8,10,1.4]]) {
        // Trust measured/manual endpoints, not extrapolated cropped hips.
        if (j[a] && j[b] && Math.min(j[a][2],j[b][2]) > .5 && [...j[a].slice(0,2),...j[b].slice(0,2)].every(v=>v>=-.1&&v<=1.1)) limbEstimates.push(distance(j[a],j[b])*factor);
      }
      limbSamples.push(...limbEstimates);
      if (limbEstimates.length>=3) frameLimbMax.push(Math.max(...limbEstimates));
      for (const ji of [15,16,17,18]) if(j[ji]) footYs.push(j[ji][1]);
      actorFrames.push(j);
      activeCount++;
    }
    const torsoScale = clamp(median(scales)||.21,.07,.65);
    // Tucked/inverted bodies shorten the projected torso. A consistently
    // longer visible bone provides a better canonical body size for these shots.
    // Manual full-body clips use the least-foreshortened bone in each frame;
    // automatic tracks use all reliable bones to reject isolated detector spikes.
    const limbEstimate = (!keys.length || fullBodyManual)
      ? percentile(fullBodyManual ? frameLimbMax : limbSamples,fullBodyManual ? .85 : .75)
      : null;
    const scale = clamp(Math.max(torsoScale,Math.min(limbEstimate||torsoScale,torsoScale*(fullBodyManual?1.8:1.35))),.07,.65);
    if (!keys.length && role !== shot.dominant && ['close','medium-close','medium'].includes(shot.size) && scale < .12) {
      roleStats[role] = {detectedFrames:detected[role],activeFrames:0,rejected:'tiny background person detection in close camera',scale};
      continue;
    }
    const footY = percentile(footYs,.8);
    const depth = footY===null ? 0 : clamp((-2-(.5-footY)*4*Math.cos(.29))/Math.sin(.29),-4,1);
    for(let fi=begin;fi<end;fi++) {
      const j = actorFrames[fi-begin];
      if (!j) continue;
      frames[fi].actors[role] = {
        j:j.map(p=>p?.map(n=>Math.round(n*100000)/100000)||null),
        scale:Math.round(scale*100000)/100000,
        depth:Math.round(depth*10000)/10000,
        facing:role==='A'?1:-1,
      };
    }
    roleStats[role]={detectedFrames:detected[role],activeFrames:activeCount,manualFrames:manualCount,lowConfidenceObservedJoints:low[role],filledJointCount,croppedTorsoFrames:croppedCount,scale,depth,scaleCalibration:{torsoScale,limbEstimate,fullBodyManual,reliableLimbSamples:limbSamples.length,method:fullBodyManual?'85th percentile of per-frame longest reliable bone':'75th percentile of reliable bones'}};
  }
  audits.push({id:shot.id,startFrame:begin,endFrameExclusive:end,totalFrames:end-begin,measuredFrames,measuredCoverage:measuredFrames/(end-begin),suppressedDetections:suppressed,actors:roleStats,manualKeyframes:shot.manualKeyframes?.length||0,manualFragmentActors:[...new Set((shot.manualKeyframes||[]).filter(k=>k.mode==='fragment').map(k=>k.actor))]});
}
const metadata={schemaVersion:1,fps:FPS,frameCount:TOTAL,source:path.basename(input),complete:rawComplete,measuredFrames:rawMap.size,missingMeasuredFrames:TOTAL-rawMap.size,method:'measured 2D joint tracks with per-shot identity, occlusion fill and manual silhouette corrections; depth estimated',builtAt:new Date().toISOString()};
const result={...metadata,frames,shots:layout.shots.map(({manualKeyframes,...s})=>s)};
const audit={...metadata,suppressedDetections:suppressedTotal,shots:audits};
function atomicWrite(p,data){fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p+'.tmp',JSON.stringify(data));fs.renameSync(p+'.tmp',p);}
atomicWrite(path.join(PROJECT,'src/pose-data.json'),result);
atomicWrite(path.join(PROJECT,'pose-audit.json'),audit);
console.log(JSON.stringify({complete:rawComplete,measured:rawMap.size,total:TOTAL,renderableFrames:frames.filter(f=>Object.keys(f.actors).length).length,suppressedDetections:suppressedTotal,input:path.basename(input)}));
