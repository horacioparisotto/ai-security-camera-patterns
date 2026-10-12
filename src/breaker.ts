const HOUR = 3_600_000;

export const THRESHOLD = 20; // consecutive failures before pausing
export const FIRST_PAUSE = 24 * HOUR;
export const MAX_PAUSE = 7 * 24 * HOUR;

/**
 * One breaker per cloud storage provider for recording uploads. Uploads run
 * one at a time, two seconds apart, only for files at least two minutes old,
 * so they never starve the live video; the breaker makes sure a full or broken
 * bucket can't loop forever.
 *
 * After 20 consecutive failures it pauses for 24 hours, doubling each time the
 * provider is still broken, up to a week. Local recording and live view are
 * protected from a problem that has nothing to do with them.
 */
export class Breaker {
  private failures = 0;
  private pause = FIRST_PAUSE;
  private openUntil = 0;

  canTry(now = Date.now()): boolean {
    return now >= this.openUntil;
  }

  success(): void {
    this.failures = 0;
    this.pause = FIRST_PAUSE;
  }

  failure(now = Date.now()): void {
    if (++this.failures < THRESHOLD) return;
    this.openUntil = now + this.pause;
    this.pause = Math.min(this.pause * 2, MAX_PAUSE);
    this.failures = 0;
  }
}
