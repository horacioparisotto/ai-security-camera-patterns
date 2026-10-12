# ai-security-camera-patterns

[![CI](https://github.com/horacioparisotto/ai-security-camera-patterns/actions/workflows/ci.yml/badge.svg)](https://github.com/horacioparisotto/ai-security-camera-patterns/actions/workflows/ci.yml)

Patterns from **[OurBlock.io](https://ourblock.io)**, a 24/7 AI camera-security platform I built end to end as solo founder, live in production on a rural property. Every motion event lights up the guard cabin within a second; a vision model separates real threats from false positives, describes each event in one sentence read aloud in Spanish, and escalates people and vehicles to a critical alert.

> **Rewritten from scratch.** OurBlock is my own product, but its source stays private because it protects a real property. These are simplified versions of its core patterns, with the AI providers, FFmpeg and storage behind small interfaces so the tests run anywhere. Semantic search runs on real SQLite with sqlite-vec.

**Results:** −94% AI cost per analyzed frame · 94 tests in the real codebase, all passing.
Full case study: [horacioparisotto.com](https://www.horacioparisotto.com/)

```bash
npm ci && npm test
```

## Patterns

### 1. The right model, and fewer calls · [`src/analyze.ts`](src/analyze.ts)

The alert never waits on AI. Critical cameras go to a stronger model (Claude Haiku 4.5), the rest to a cheaper one (Gemini 2.5 Flash-Lite), on frames downscaled to 480p. A 15-second per-camera result cache and 60-second clip coalescing keep a busy scene from turning into a stream of identical calls. Together: −94% AI cost per analyzed frame, from list prices.

### 2. A circuit breaker for cloud uploads · [`src/breaker.ts`](src/breaker.ts)

Recordings upload one at a time, two seconds apart, only once a file is at least two minutes old, so uploads never starve the live video. Each storage provider has its own breaker: after 20 consecutive failures it pauses for 24 hours, doubling up to a week, so a full or broken bucket can't loop forever.

### 3. Live video without transcoding · [`src/stream.ts`](src/stream.ts)

Each camera's RTSP stream is repackaged to HLS in 1-second segments with FFmpeg's `-c copy`: never decoded, never re-encoded. That one decision drives the hardware: the platform is designed for an inexpensive N100-class mini PC (about $269 per site instead of $1,300 or more). One process per camera, with backoff, so a dead camera neither takes the others down nor spins the CPU.

### 4. A voice that never goes silent · [`src/voice.ts`](src/voice.ts)

Alerts are read aloud through a three-level fallback: ElevenLabs, then OpenAI TTS, then espeak-ng running locally, so the cabin still hears every alert without internet. A timeout counts as a failure, and alerts are queued so they never talk over each other.

### 5. Semantic search in a single file · [`src/search.ts`](src/search.ts)

Event descriptions are embedded and stored next to the events in SQLite with sqlite-vec: no separate vector database. For a product installed one mini PC per site, a backup is copying a folder and there is no database server to run. The test runs real KNN queries.

### 6. An agent loop you can test · [`src/agent.ts`](src/agent.ts)

Complex questions go to an investigation agent that plans, calls tools such as the event search, and answers, streaming each step over Server-Sent Events. The model is injected, so the control loop is tested with scripted responses: no network, no cost, same result every run. A step limit and unknown-tool handling keep a confused model from becoming an endless bill or a crash.

---

Horacio Parisotto · Senior Full-Stack & AI Engineer · [Portfolio](https://www.horacioparisotto.com/) · [LinkedIn](https://www.linkedin.com/in/horacioparisotto/)
