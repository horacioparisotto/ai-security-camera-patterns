import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { investigate, StepLimitReached, toSse, type AgentEvent, type Llm, type LlmReply } from '../src/agent';
import { CACHE_MS, createAnalyzer, type Camera, type Clip, type Verdict, type VisionModel } from '../src/analyze';
import { Breaker, FIRST_PAUSE, MAX_PAUSE, THRESHOLD } from '../src/breaker';
import { ffmpegArgs, startStream, type StreamDeps } from '../src/stream';
import { createAnnouncer, type Voice } from '../src/voice';

const HOUR = 3_600_000;
const gate: Camera = { id: 'gate', critical: true };
const yard: Camera = { id: 'yard', critical: false };
const clip = (cameraId: string, startedAt: number): Clip => ({ cameraId, startedAt, frame: new Uint8Array(8) });
const verdict: Verdict = { threat: 'person', description: 'A person walks to the gate.' };

function analyzer() {
  let now = 0;
  const strong: VisionModel = { verdict: vi.fn(async () => verdict) };
  const cheap: VisionModel = { verdict: vi.fn(async () => ({ ...verdict, threat: 'none' as const })) };
  const analyze = createAnalyzer({ strong, cheap, downscale: (f) => f, now: () => now });
  return { analyze, strong, cheap, advance: (ms: number) => (now += ms) };
}

describe('vision routing, cache and coalescing', () => {
  it('sends critical cameras to the stronger model', async () => {
    const { analyze, strong, cheap } = analyzer();
    await analyze(gate, clip('gate', 0));
    await analyze(yard, clip('yard', 0));

    expect(strong.verdict).toHaveBeenCalledTimes(1);
    expect(cheap.verdict).toHaveBeenCalledTimes(1);
  });

  it('shares one call between clips of the same window', async () => {
    const { analyze, strong } = analyzer();
    await Promise.all([analyze(gate, clip('gate', 1_000)), analyze(gate, clip('gate', 2_000))]);

    expect(strong.verdict).toHaveBeenCalledTimes(1);
  });

  it('serves a busy camera from cache, then calls again after it expires', async () => {
    const { analyze, strong, advance } = analyzer();
    await analyze(gate, clip('gate', 0));
    advance(CACHE_MS - 1);
    await analyze(gate, clip('gate', 70_000));
    expect(strong.verdict).toHaveBeenCalledTimes(1);

    advance(2);
    await analyze(gate, clip('gate', 140_000));
    expect(strong.verdict).toHaveBeenCalledTimes(2);
  });
});

describe('upload circuit breaker', () => {
  it(`pauses after ${THRESHOLD} consecutive failures, doubling up to a week`, () => {
    const b = new Breaker();
    let now = 0;
    const failMany = () => {
      for (let i = 0; i < THRESHOLD; i++) b.failure(now);
    };

    failMany();
    expect(b.canTry(now + FIRST_PAUSE - 1)).toBe(false);
    now += FIRST_PAUSE;
    expect(b.canTry(now)).toBe(true);

    failMany();
    expect(b.canTry(now + 2 * FIRST_PAUSE - 1)).toBe(false);

    for (let i = 0; i < 5; i++) {
      now += MAX_PAUSE;
      failMany();
    }
    expect(b.canTry(now + MAX_PAUSE)).toBe(true);
  });

  it('a success resets the count and the pause', () => {
    const b = new Breaker();
    for (let i = 0; i < THRESHOLD - 1; i++) b.failure(0);
    b.success();
    b.failure(0);

    expect(b.canTry(0)).toBe(true);
  });

  it('does not pause on scattered failures', () => {
    const b = new Breaker();
    for (let i = 0; i < 100; i++) {
      b.failure(i * HOUR);
      if (i % 10 === 0) b.success();
    }
    expect(b.canTry(100 * HOUR)).toBe(true);
  });
});

describe('FFmpeg streams', () => {
  function fakeDeps(active = true) {
    const procs: EventEmitter[] = [];
    let now = 0;
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const deps: StreamDeps = {
      spawn: vi.fn(() => {
        const p = new EventEmitter();
        procs.push(p);
        return p as never;
      }),
      setTimeout: (fn, ms) => timers.push({ fn, ms }),
      now: () => now,
      isActive: () => active,
      hlsDir: '/var/hls',
      warn: vi.fn(),
    };
    return { deps, procs, timers, advance: (ms: number) => (now += ms) };
  }

  it('remuxes without re-encoding, in 1-second segments', () => {
    const args = ffmpegArgs({ id: 'gate', rtspUrl: 'rtsp://cam/1' }, '/var/hls');

    expect(args.join(' ')).toContain('-c copy');
    expect(args.join(' ')).toContain('-hls_time 1');
    expect(args.at(-1)).toBe('/var/hls/gate/index.m3u8');
  });

  it('backs off while a camera keeps failing, and resets after a long run', () => {
    const { deps, procs, timers, advance } = fakeDeps();
    startStream({ id: 'gate', rtspUrl: 'rtsp://cam/1' }, deps);

    for (let i = 0; i < 6; i++) {
      procs.at(-1)!.emit('close');
      timers.at(-1)!.fn();
    }
    expect(timers.map((t) => t.ms)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);

    advance(120_000); // the latest stream ran for two minutes
    procs.at(-1)!.emit('close');
    expect(timers.at(-1)!.ms).toBe(1_000);
  });

  it('does not restart a removed camera', () => {
    const { deps, procs, timers } = fakeDeps(false);
    startStream({ id: 'gate', rtspUrl: 'rtsp://cam/1' }, deps);
    procs[0]!.emit('close');

    expect(timers).toHaveLength(0);
  });
});

describe('voice fallback', () => {
  const voice = (name: string, speak: Voice['speak']): Voice => ({ name, speak: vi.fn(speak) });

  it('falls back to the next voice and finally to the local one', async () => {
    const played: string[] = [];
    const announce = createAnnouncer({
      voices: [
        voice('elevenlabs', async () => Promise.reject(new Error('offline'))),
        voice('openai', async () => Promise.reject(new Error('offline'))),
        voice('espeak', async (t) => new TextEncoder().encode(`espeak:${t}`)),
      ],
      play: async (a) => void played.push(new TextDecoder().decode(a)),
      timeoutMs: 50,
      warn: () => {},
    });

    await announce('Vehicle at the gate');
    expect(played).toEqual(['espeak:Vehicle at the gate']);
  });

  it('treats a slow voice as a failed one', async () => {
    const played: string[] = [];
    const announce = createAnnouncer({
      voices: [voice('slow', () => new Promise(() => {})), voice('local', async () => new Uint8Array([1]))],
      play: async () => void played.push('local'),
      timeoutMs: 20,
      warn: () => {},
    });

    await announce('Person at the gate');
    expect(played).toEqual(['local']);
  });

  it('never talks over itself: alerts play one at a time, in order', async () => {
    const log: string[] = [];
    const announce = createAnnouncer({
      voices: [voice('v', async (t) => new TextEncoder().encode(t))],
      play: async (a) => {
        const t = new TextDecoder().decode(a);
        log.push(`start ${t}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`end ${t}`);
      },
      timeoutMs: 50,
      warn: () => {},
    });

    await Promise.all([announce('one'), announce('two')]);
    expect(log).toEqual(['start one', 'end one', 'start two', 'end two']);
  });
});

describe('investigation agent', () => {
  const scripted = (replies: LlmReply[]): Llm => ({ next: vi.fn(async () => replies.shift()!) });
  const search = { name: 'search_events', description: 'Search the event log', run: vi.fn(async () => [{ id: 1 }]) };

  it('searches the event log before answering', async () => {
    const llm = scripted([
      { type: 'tool_call', id: 't1', tool: 'search_events', args: { text: 'vehicle at the gate' } },
      { type: 'answer', text: 'One vehicle reached the gate at 02:14.' },
    ]);
    const seen: AgentEvent[] = [];

    const answer = await investigate('Any vehicles last night?', llm, [search], (e) => seen.push(e));

    expect(answer).toBe('One vehicle reached the gate at 02:14.');
    expect(seen.map((e) => e.type)).toEqual(['tool_call', 'result', 'answer']);
  });

  it('reports an unknown tool back to the model instead of crashing', async () => {
    const llm = scripted([
      { type: 'tool_call', id: 't1', tool: 'delete_everything', args: {} },
      { type: 'answer', text: 'I can only search the log.' },
    ]);
    const seen: AgentEvent[] = [];

    await investigate('?', llm, [search], (e) => seen.push(e));
    expect(seen[1]).toEqual({ type: 'result', tool: 'delete_everything', result: { error: 'Unknown tool: delete_everything' } });
  });

  it('stops at the step limit', async () => {
    const llm: Llm = { next: async () => ({ type: 'tool_call', id: 'x', tool: 'search_events', args: {} }) };

    await expect(investigate('?', llm, [search], () => {}, 3)).rejects.toBeInstanceOf(StepLimitReached);
  });

  it('frames events for Server-Sent Events', () => {
    expect(toSse({ type: 'answer', text: 'ok' })).toBe('event: answer\ndata: {"type":"answer","text":"ok"}\n\n');
  });
});
