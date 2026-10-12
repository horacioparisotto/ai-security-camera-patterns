export interface Voice {
  name: string;
  speak(text: string): Promise<Uint8Array>;
}

export interface AnnouncerDeps {
  voices: Voice[]; // ElevenLabs → OpenAI TTS → espeak-ng (local) in production
  play(audio: Uint8Array): Promise<void>;
  timeoutMs: number;
  warn(msg: string, data: object): void;
}

/**
 * Every alert is read aloud in the guard cabin. Speech falls back through
 * three levels, from a natural cloud voice down to one that runs locally, so
 * the cabin still hears every alert without internet. Alerts are queued so
 * they never talk over each other.
 *
 * The timeout matters as much as the fallback: a cloud voice that answers in
 * ten seconds is as useless to a guard as one that never answers.
 */
export function createAnnouncer(deps: AnnouncerDeps) {
  async function synthesize(text: string): Promise<Uint8Array> {
    for (const voice of deps.voices) {
      try {
        return await withTimeout(voice.speak(text), deps.timeoutMs);
      } catch (err) {
        deps.warn('voice failed', { voice: voice.name, err });
      }
    }
    // The screen still shows the alert; only speech is lost.
    throw new Error('All voices failed');
  }

  let queue: Promise<void> = Promise.resolve();
  return function announce(text: string): Promise<void> {
    // Chain onto the previous alert: one at a time, in order.
    queue = queue
      .then(() => synthesize(text))
      .then(deps.play)
      .catch((err) => deps.warn('announcement failed', { err }));
    return queue;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
