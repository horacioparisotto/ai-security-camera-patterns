export interface Camera {
  id: string;
  critical: boolean; // gates, entrances: worth the stronger model
}

export interface Clip {
  cameraId: string;
  startedAt: number; // epoch ms
  frame: Uint8Array;
}

export interface Verdict {
  threat: 'person' | 'vehicle' | 'none';
  description: string; // one sentence, read aloud in the guard cabin
}

export interface VisionModel {
  verdict(frame: Uint8Array): Promise<Verdict>;
}

export interface AnalyzerDeps {
  strong: VisionModel; // Claude Haiku 4.5 in production
  cheap: VisionModel; // Gemini 2.5 Flash-Lite in production
  downscale(frame: Uint8Array, height: number): Uint8Array;
  now(): number;
}

export const CACHE_MS = 15_000; // per-camera result cache
export const COALESCE_MS = 60_000; // clips in the same window share one call

/**
 * The alert never waits on AI: motion lights up the guard cabin immediately,
 * and this verdict follows to escalate people and vehicles.
 *
 * Downscaling to 480p and routing by camera tier set the cost of each call.
 * The per-camera cache and clip coalescing decide how many calls happen at
 * all, so a busy scene doesn't become a stream of identical calls.
 */
export function createAnalyzer(deps: AnalyzerDeps) {
  const recent = new Map<string, { at: number; verdict: Verdict }>();
  const inFlight = new Map<string, Promise<Verdict>>();

  return function analyze(cam: Camera, clip: Clip): Promise<Verdict> {
    const hit = recent.get(cam.id);
    if (hit && deps.now() - hit.at < CACHE_MS) {
      return Promise.resolve(hit.verdict);
    }

    const slot = Math.floor(clip.startedAt / COALESCE_MS);
    const key = `${cam.id}:${slot}`;
    let job = inFlight.get(key);
    if (!job) {
      const model = cam.critical ? deps.strong : deps.cheap;
      job = model
        .verdict(deps.downscale(clip.frame, 480))
        .then((verdict) => {
          recent.set(cam.id, { at: deps.now(), verdict });
          return verdict;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    return job;
  };
}
