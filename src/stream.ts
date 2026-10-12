import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

export interface StreamCamera {
  id: string;
  rtspUrl: string;
}

export interface StreamDeps {
  spawn(cmd: string, args: string[]): Pick<ChildProcess, 'on'>;
  setTimeout(fn: () => void, ms: number): unknown;
  now(): number;
  isActive(cameraId: string): boolean; // false once removed or shutting down
  hlsDir: string;
  warn(msg: string, data: object): void;
}

/** FFmpeg arguments: repackage RTSP to HLS without decoding or re-encoding. */
export function ffmpegArgs(cam: StreamCamera, hlsDir: string): string[] {
  return [
    '-rtsp_transport', 'tcp',
    '-i', cam.rtspUrl,
    '-c', 'copy', // remux only: no re-encode
    '-f', 'hls',
    '-hls_time', '1', // 1-second segments
    '-hls_list_size', '3',
    '-hls_flags', 'delete_segments',
    join(hlsDir, cam.id, 'index.m3u8'),
  ];
}

/**
 * One FFmpeg process per camera. Because the server never encodes video, the
 * platform is designed to run on an inexpensive N100-class mini PC.
 *
 * A camera that drops restarts on its own without touching the others; a
 * stream that ran for a while resets the backoff, and one that keeps failing
 * is retried more slowly, so a dead camera can't spin the CPU.
 */
export function startStream(cam: StreamCamera, deps: StreamDeps, attempt = 0): void {
  const proc = deps.spawn('ffmpeg', ffmpegArgs(cam, deps.hlsDir));
  const startedAt = deps.now();

  proc.on('error', (err) => deps.warn('ffmpeg error', { cam: cam.id, err }));
  proc.on('close', () => {
    if (!deps.isActive(cam.id)) return; // camera removed, or the server is shutting down
    const next = deps.now() - startedAt > 60_000 ? 0 : attempt + 1;
    const delay = Math.min(1_000 * 2 ** next, 30_000);
    deps.setTimeout(() => startStream(cam, deps, next), delay);
  });
}

export const productionDeps = (isActive: StreamDeps['isActive'], hlsDir: string): StreamDeps => ({
  spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: 'ignore' }),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  now: () => Date.now(),
  isActive,
  hlsDir,
  warn: (msg, data) => console.warn(msg, data),
});
