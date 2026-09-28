export interface ShotAnnotation {
  size:string; category:string; camera:string; frame:string; action:string;
  composition:string; scene:string; subjects:string[]; rhythm?:string;
  rhythmNote?:string; uncertainties?:string[]; evidenceFrames:number[];
  cutSuggestions?:{frameIndex:number;action:'split'|'merge';reason:string}[];
}
export interface AnalysisIssue {code:string;severity:'info'|'warning'|'error';message:string;shotId?:string;field?:string}
export interface AnalysisEvidence {frameIndex:number;ptsUs:number;imageRef:string;url?:string}
export interface AnalysisShot {
  id:string;shotRevision:string;startFrame:number;endFrameExclusive:number;startUs:number;endUs:number;
  status:'pending'|'analyzed'|'needs_review'|'failed'|'user_edited';evidenceFrames:AnalysisEvidence[];
  generated:ShotAnnotation|null;overrides:Partial<ShotAnnotation>;effective:Partial<ShotAnnotation>|null;issues:AnalysisIssue[];
}
export interface AnalysisSubject {id:string;kind:'person'|'animal'|'unknown';name:string;description:string;species?:string;referenceFrames?:number[];uncertain?:boolean}
export interface ShotAnalysis {
  id:string;projectId:string;revision:string;status:'processing'|'ready'|'ready_with_issues'|'blocked'|'failed'|'cancelled'|'stale';
  stage:string;mediaHash:string;shotSetHash:string;baseShotSetHash:string;candidate:boolean;provider:string|null;model:string|null;
  error:string|null;progress:number;createdAt:string;updatedAt:string;subjects:AnalysisSubject[];issues:AnalysisIssue[];
  counts:{total:number;analyzed:number;failed:number;needsReview:number;userEdited:number};shots:AnalysisShot[];artifactRef?:string;
  parameters?:{analysisSource?:string;analysisLabel?:string;[key:string]:unknown};
}
export interface ShotProviderStatus {configured:boolean;provider:string|null;model:string|null;reason?:string}

export function isSessionVisualAnalysis(run:ShotAnalysis|null|undefined):boolean {
  return run?.parameters?.analysisSource==='assistant-session'||run?.provider==='codex-session';
}

export const SHOT_FIELD_OPTIONS={
  size:[['none','不适用'],['extreme-wide','大远景'],['wide','远景'],['medium-wide','全景 / 中远景'],['medium','中景'],['medium-close','中近景'],['close','近景'],['extreme-close','特写'],['unknown','不确定']],
  category:[['establishing','建立镜头'],['subject','主体'],['dialogue','对话'],['reaction','反应'],['insert','插入细节'],['pov','主观视角'],['empty','空镜'],['product','产品'],['text-card','字幕卡'],['transition','转场'],['archive','档案素材'],['unknown','不确定']],
  camera:[['static','固定'],['push-in','推进'],['pull-out','拉远'],['zoom-in','变焦放大'],['zoom-out','变焦缩小'],['pan-left','向左摇'],['pan-right','向右摇'],['tilt-up','向上摇'],['tilt-down','向下摇'],['truck-left','向左平移'],['truck-right','向右平移'],['pedestal-up','上升'],['pedestal-down','下降'],['tracking','跟拍'],['arc','环绕'],['whip-pan','甩镜'],['handheld','手持'],['shake','抖动'],['rack-focus','移焦'],['micro-push','轻微推进'],['roll','滚转'],['drone','航拍'],['unknown','不确定']],
} as const;
export function analysisFieldLabel(field:'size'|'category'|'camera',value:string|undefined):string {
  return SHOT_FIELD_OPTIONS[field].find(option=>option[0]===value)?.[1]||value||'待分析';
}

/** Source-frame identity comes only from the PTS map, including VFR files. */
export function sourceFrameAt(ptsUs:readonly number[],timeUs:number):number {
  if(!ptsUs.length)return -1;
  let lo=0,hi=ptsUs.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(ptsUs[mid]<=timeUs)lo=mid+1;else hi=mid;}
  return Math.max(0,lo-1);
}
export function analysisShotAt(shots:readonly AnalysisShot[],timeUs:number):AnalysisShot|undefined {
  return shots.find(shot=>timeUs>=shot.startUs&&timeUs<shot.endUs);
}
/** Candidate edits never mutate the active shot list in the browser. */
export function editedCutFrames(shots:readonly AnalysisShot[],shotIndex:number,action:'split'|'merge'|'move',frame?:number):number[] {
  const shot=shots[shotIndex];
  if(!shot)throw new Error('请先选择镜头');
  const cuts=shots.slice(1).map(item=>item.startFrame);
  if(action==='split'){
    if(!Number.isInteger(frame)||frame!<=shot.startFrame||frame!>=shot.endFrameExclusive)throw new Error('拆分位置必须在所选镜头内部，并使用整数源帧号');
    cuts.push(frame!);
  }else if(action==='merge'){
    if(shotIndex>=shots.length-1)throw new Error('最后一镜没有可合并的后一镜');
    cuts.splice(shotIndex,1);
  }else{
    const next=shots[shotIndex+1];
    if(!next)throw new Error('最后一镜没有可移动的后切点');
    if(!Number.isInteger(frame)||frame!<=shot.startFrame||frame!>=next.endFrameExclusive)throw new Error('切点必须位于相邻两镜内部，并使用整数源帧号');
    cuts[shotIndex]=frame!;
  }
  return [...new Set(cuts)].sort((a,b)=>a-b);
}
export function analysisIssues(run:ShotAnalysis):AnalysisIssue[] {
  const result:AnalysisIssue[]=[],keys=new Set<string>();
  for(const issue of [...run.issues,...run.shots.flatMap(shot=>shot.issues.map(issue=>({...issue,shotId:issue.shotId||shot.id})))]){
    const key=JSON.stringify([issue.code,issue.shotId,issue.field,issue.message]);
    if(!keys.has(key)){keys.add(key);result.push(issue);}
  }
  return result;
}
