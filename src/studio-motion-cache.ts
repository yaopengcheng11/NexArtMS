import {useEffect, useRef, useState} from 'react';
import type {ProjectDetail} from './studio';
import type {MotionData} from './studio-stage-math';
import {matchesMotionContext} from '../studio/motion-validation.mjs';

/** Include binding/height so edits cannot render an obsolete solve before its ref is cleared. */
export function motionCacheKey(detail: ProjectDetail, trackId: string): string | null {
  const ref = detail.motionRefs[trackId];
  const binding = detail.bindings.find(row => row.trackId === trackId);
  const track = detail.tracks.find(row => row.id === trackId);
  const character = detail.characters.find(row => row.id === binding?.characterId);
  if (!ref || track?.status !== 'active' || binding?.disposition !== 'bound' || !character) return null;
  // If the server supplies versions, absence means the referenced file is missing.
  if (detail.motionVersions && !detail.motionVersions[trackId]) return null;
  return JSON.stringify([detail.project.id, ref, detail.motionVersions?.[trackId] ?? detail.project.revision, character.id, character.scale]);
}

export function tagMotion(detail: ProjectDetail, trackId: string, motion: MotionData): MotionData {
  return {...motion, artifactKey: motionCacheKey(detail, trackId) ?? undefined};
}

export function currentMotion(detail: ProjectDetail, trackId: string, motion: MotionData | undefined): MotionData | undefined {
  const key = motionCacheKey(detail, trackId);
  const binding = detail.bindings.find(row => row.trackId === trackId);
  const track = detail.tracks.find(row => row.id === trackId);
  const character = detail.characters.find(row => row.id === binding?.characterId);
  if (!key || !motion || !track || !character || !matchesMotionContext(motion, {
    trackId, shotId: track.shotId, characterId: character.id, bodyHeight: character.scale,
  })) return undefined;
  if (motion.artifactKey ? motion.artifactKey !== key : !!detail.motionVersions) return undefined;
  return motion;
}

/** Resolve shot IDs as IDs, including direct/backwards seeks. */
export function motionTracksForShot(detail: ProjectDetail, shotId: string): string[] {
  const shot = shotId ? detail.shots.find(row => row.id === shotId) : detail.shots[0];
  return shot ? detail.tracks.filter(track => track.shotId === shot.id && motionCacheKey(detail, track.id)).map(track => track.id) : [];
}

export class MotionArtifactCache {
  private keys: Record<string, string> = {};
  private motions: Record<string, MotionData> = {};
  private pending = new Map<string, object>();
  private failures = new Map<string, {attempts: number; retryAt: number}>();

  reconcile(keys: Record<string, string>) {
    for (const id of Object.keys(this.keys)) {
      if (keys[id] !== this.keys[id]) {
        delete this.motions[id];
        this.pending.delete(id);
        this.failures.delete(id);
      }
    }
    this.keys = {...keys};
  }

  snapshot() { return {...this.motions}; }

  async load(id: string, fetchMotion: (key: string) => Promise<MotionData>, now = Date.now()): Promise<boolean> {
    const key = this.keys[id];
    if (!key || this.motions[id] || this.pending.has(id) || (this.failures.get(id)?.retryAt ?? 0) > now) return false;
    const request = {};
    this.pending.set(id, request);
    try {
      const motion = await fetchMotion(key);
      if (this.pending.get(id) !== request || this.keys[id] !== key) return false;
      this.motions[id] = {...motion, artifactKey: key};
      this.failures.delete(id);
      return true;
    } catch {
      if (this.pending.get(id) === request && this.keys[id] === key) {
        const attempts = (this.failures.get(id)?.attempts ?? 0) + 1;
        this.failures.set(id, {attempts, retryAt: now + Math.min(30000, 2000 * 2 ** (attempts - 1))});
      }
      return false;
    } finally {
      if (this.pending.get(id) === request) this.pending.delete(id);
    }
  }
}

export function useStudioMotions(detail: ProjectDetail, shotId: string) {
  const cache = useRef(new MotionArtifactCache());
  const [motions, setMotions] = useState<Record<string, MotionData>>({});
  const keys = Object.fromEntries(detail.tracks.flatMap(track => {
    const key = motionCacheKey(detail, track.id);
    return key ? [[track.id, key]] : [];
  }));
  const keySignature = JSON.stringify(keys);
  const idsSignature = JSON.stringify(motionTracksForShot(detail, shotId));
  useEffect(() => {
    const current = cache.current;
    current.reconcile(JSON.parse(keySignature));
    setMotions(current.snapshot());
    let active = true;
    const publish = () => {
      if (!active) return;
      const snapshot = current.snapshot();
      setMotions(previous => Object.keys(previous).length === Object.keys(snapshot).length
        && Object.keys(snapshot).every(id => previous[id] === snapshot[id]) ? previous : snapshot);
    };
    const load = () => {
      for (const trackId of JSON.parse(idsSignature) as string[]) {
        void current.load(trackId, async key => {
          const response = await fetch(`/api/studio/projects/${detail.project.id}/tracks/${trackId}/motion?v=${encodeURIComponent(key)}`, {cache: 'no-store'});
          if (!response.ok) throw new Error(String(response.status));
          const result = await response.json();
          if (!result.motion || result.motion.trackId !== trackId) throw new Error('Invalid motion response');
          if (detail.motionVersions && result.motionVersion !== JSON.parse(key)[2]) throw new Error('Motion artifact changed during request');
          return result.motion;
        }).then(publish);
      }
    };
    load();
    const retry = setInterval(load, 2000);
    return () => {active = false;clearInterval(retry);};
  }, [detail.project.id, keySignature, idsSignature]);
  return motions;
}
