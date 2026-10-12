// Runs real SQLite with the sqlite-vec extension, in memory. The embedding
// model is replaced by a tiny deterministic one over three "concepts".
import { afterAll, describe, expect, it } from 'vitest';
import { openEventStore } from '../src/search';

const CONCEPTS = [
  ['person', 'man', 'woman', 'someone'],
  ['vehicle', 'car', 'truck', 'pickup'],
  ['animal', 'dog', 'cat', 'horse'],
];

async function embed(text: string): Promise<number[]> {
  const words = text.toLowerCase().split(/\W+/);
  const v = CONCEPTS.map((group) => words.filter((w) => group.includes(w)).length);
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

describe('semantic event search (sqlite-vec)', () => {
  const store = openEventStore(':memory:', 3, embed);
  afterAll(() => store.close());

  it('finds events by meaning, not by keyword', async () => {
    await store.add('gate', '2026-03-14T02:14:00Z', 'A white pickup stops at the gate');
    await store.add('yard', '2026-03-14T03:40:00Z', 'A dog crosses the yard');
    await store.add('gate', '2026-03-14T05:02:00Z', 'A man walks along the fence');

    const [top] = await store.search('any truck last night?', 3);

    expect(top?.description).toBe('A white pickup stops at the gate');
    expect(top?.cameraId).toBe('gate');
  });

  it('returns results nearest first, up to the limit', async () => {
    const hits = await store.search('someone on foot', 2);

    expect(hits).toHaveLength(2);
    expect(hits[0]!.description).toBe('A man walks along the fence');
    expect(hits[0]!.distance).toBeLessThanOrEqual(hits[1]!.distance);
  });
});
