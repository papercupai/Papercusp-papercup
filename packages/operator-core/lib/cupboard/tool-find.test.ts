/**
 * Tests for hybrid tool-find (lexical + semantic floored-union).
 * Run with: npx vitest run packages/operator-core/lib/cupboard/tool-find.test.ts
 */
import { describe, expect, it } from 'vitest';
import type { ToolDiscoveryEntry } from './tools-discovery';
import { cosineSimilarity, decisiveToolForSymptom, findTools } from './tool-find';

const entry = (tool: string, description: string): ToolDiscoveryEntry =>
  ({
    tool,
    category: tool.includes(':') ? tool.slice(0, tool.indexOf(':')) : tool,
    capability: null,
    description,
    provider: null,
    unit: null,
  }) as unknown as ToolDiscoveryEntry;

const corpus: ToolDiscoveryEntry[] = [
  entry('flags:set', 'feature flag set'),
  entry('cup:spawn', 'place a worker bee'),
  entry('coord:orient', 'orientation bootstrap read'),
  entry('coord:glance', 'quick peer status'),
  entry('dev:why', 'top-down runtime causal chain'),
  entry('gateway:status', 'gateway queue admission details for slow agents'),
  entry('accounts:status', 'account capacity and rate limit status'),
  entry('dev:service_health', 'probe local services and desktop'),
  entry('dev:pipeline_position', 'is a code change live, deployed, or blocked in the pipeline'),
  entry('state:read', 'read a registered state cell by name'),
  entry('change_ledger:calendar', 'browse the change ledger by date'),
  entry('coord:roster', 'complete parked agent audit with frozen evidence pages'),
  entry('audit:list', 'audit log of agent and user actions'),
];

// Deterministic embedding space: one orthogonal axis per concept.
const VEC: Record<string, number[]> = {
  'flags:set': [1, 0, 0, 0],
  'cup:spawn': [0, 1, 0, 0],
  'coord:orient': [0, 0, 1, 0],
  'coord:glance': [0, 0, 0, 1],
};
const embeddings = new Map<string, number[]>(Object.entries(VEC));
// Query embedder: map known intents to the matching axis.
const QVEC: Record<string, number[]> = {
  'deploy a bot': [0, 1, 0, 0], // → cup:spawn (no lexical overlap)
  'coord:glance': [0, 0, 1, 0], // semantically nearest coord:orient, but exact-name is glance
  faint: [0.3, 0, 0, 0.05], // weak similarity to flags:set
};
const mockEmbedder = async (q: string): Promise<number[]> => QVEC[q] ?? [0, 0, 0, 0];

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('is 0 for degenerate input', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  /**
   * P-019 — two vectors of different width are from different embedding spaces
   * and are not comparable at all.
   *
   * The pre-fix implementation scored `Math.min(a.length, b.length)` dimensions,
   * so this pair returned a confident **1.0** — the strongest possible "these
   * are the same thing" claim, from a comparison that means nothing. That is why
   * 0 is the answer and not a prefix score: the failure has to be inert, not
   * merely approximate.
   */
  it('MISMATCHED WIDTHS score 0, never a prefix comparison', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0, 0, 0, 0])).toBe(0);
    expect(cosineSimilarity([1, 2, 3, 4], [1, 2, 3])).toBe(0);
    // Equal widths still work — the guard must not blanket-zero the real path.
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
});

describe('findTools', () => {
  it.each([
    'find agents working before account limits and summarize what each was doing',
    'recover interrupted work after credentials ran out',
    'what were sessions doing when provider access stopped',
  ])('admits semantic recovery for %s despite a page of keyword distractors', async query => {
    const distractors = Array.from({ length: 20 }, (_, i) => entry(`noise:${i}`, query));
    const recovery = entry('sessions:digest', 'Historical task and stop evidence');
    const index = new Map([
      ...distractors.map(e => [e.tool, [0, 1]] as [string, number[]]),
      [recovery.tool, [1, 0]] as [string, number[]],
    ]);
    const hits = await findTools([...distractors, recovery], query, {
      limit: 3, embedder: async () => [1, 0], embeddings: index,
    });
    expect(hits[0].tool).toBe('sessions:digest');
    expect(hits[0].via).toBe('semantic');
    const degraded = await findTools([...distractors, recovery], query, {
      limit: 3, embedder: async () => { throw new Error('unavailable'); }, embeddings: index,
    });
    expect(degraded.every(hit => hit.via === 'lexical')).toBe(true);
    expect(degraded).toHaveLength(3);
    expect(degraded[0].tool).toBe('sessions:digest');
  });

  it('pins several explicit names ahead of a stronger semantic candidate', async () => {
    const hits = await findTools(corpus, 'coord:glance flags:set recover work', {
      limit: 3, embedder: async () => [0, 1, 0, 0], embeddings,
    });
    expect(hits.slice(0, 2).map(hit => hit.tool)).toEqual(['coord:glance', 'flags:set']);
  });
  it.each(['parked agent audit', 'audit parked agents', 'parked-agent audit'])(
    'routes %s to the complete roster surface ahead of generic audit tools', async query => {
      const hits = await findTools(corpus, query, { limit: 3 });
      expect(hits[0].tool).toBe('coord:roster');
    },
  );
  it('preserves an explicitly named tool in a parked-agent audit query', async () => {
    const query = 'audit:list for parked agent audit';
    expect(decisiveToolForSymptom(query)).toBeNull();
    expect((await findTools(corpus, query, { limit: 3 }))[0].tool).toBe('audit:list');
  });
  it('lexical-only when no embedder (graceful) — exact name leads', async () => {
    const hits = await findTools(corpus, 'orient');
    expect(hits[0].tool).toBe('coord:orient');
    expect(hits.every((h) => h.via === 'lexical')).toBe(true);
  });

  it('semantic leg BROADENS recall — finds a tool with no lexical overlap', async () => {
    // "deploy a bot" shares no tokens with "place a worker bee"/"cup:spawn".
    const lexicalOnly = await findTools(corpus, 'deploy a bot');
    expect(lexicalOnly.find((h) => h.tool === 'cup:spawn')).toBeUndefined();

    const hybrid = await findTools(corpus, 'deploy a bot', { embedder: mockEmbedder, embeddings });
    const spawn = hybrid.find((h) => h.tool === 'cup:spawn');
    expect(spawn).toBeDefined();
    expect(spawn!.via).toBe('semantic');
  });

  it('exact-name lexical hit stays #1 even when the semantic leg prefers a sibling', async () => {
    // query embeds nearest coord:orient, but the exact NAME match is coord:glance.
    const hits = await findTools(corpus, 'coord:glance', { embedder: mockEmbedder, embeddings });
    expect(hits[0].tool).toBe('coord:glance'); // lexical authority preserved (floored-union)
  });

  it('annotates a hit liked by BOTH legs', async () => {
    const hits = await findTools(corpus, 'flags:set', {
      embedder: async () => [1, 0, 0, 0], // perfectly matches flags:set
      embeddings,
    });
    const flags = hits.find((h) => h.tool === 'flags:set')!;
    expect(flags.via).toBe('both');
    expect(flags.cosine).toBeCloseTo(1);
  });

  it('applies the minCosine floor to semantic-only hits', async () => {
    // "faint" embeds with cosine ≈0.987 to flags:set actually — make it clearly below floor:
    const weak = await findTools(corpus, 'zzz', {
      embedder: async () => [0.3, 0, 0, 0.05],
      embeddings,
      minCosine: 0.99, // nothing clears this
    });
    expect(weak.length).toBe(0); // no lexical hit for 'zzz', semantic all below floor
  });

  it('respects limit', async () => {
    const hits = await findTools(corpus, 'coord', { limit: 1 });
    expect(hits.length).toBe(1);
  });

  it('routes a natural-language slowness symptom to the causal-chain tool first', async () => {
    const hits = await findTools(corpus, 'why are all agent turns slow and queued?', { limit: 3 });
    expect(hits[0].tool).toBe('dev:why');
  });

  it('routes connection-refused / running-with-no-window symptoms to service health first', async () => {
    expect((await findTools(corpus, 'the process is running but no window appears'))[0].tool)
      .toBe('dev:service_health');
  });

  it('never overrides an explicit exact tool name', () => {
    expect(decisiveToolForSymptom('gateway:status for slow agents')).toBeNull();
  });

  // WI-6524: the liveness/staleness question family — tools:find ranked
  // dev:pipeline_position 13th and state:read absent from the top 25 for these
  // exact phrasings, even though each tool is the platform's one authoritative
  // answer. Decisive routing closes the intent→tool gap without waiting on the
  // semantic index to eventually learn it.
  it('routes "is my change live" phrasing to dev:pipeline_position first', async () => {
    expect(decisiveToolForSymptom('is my change live on the running server yet')).toBe('dev:pipeline_position');
    const hits = await findTools(corpus, 'is my change live on the running server yet', { limit: 3 });
    expect(hits[0].tool).toBe('dev:pipeline_position');
  });

  it('routes other change-liveness phrasings to dev:pipeline_position', () => {
    expect(decisiveToolForSymptom('has my fix shipped yet')).toBe('dev:pipeline_position');
    expect(decisiveToolForSymptom('which sha is deployed right now')).toBe('dev:pipeline_position');
  });

  it('routes "is this value stale" phrasing to state:read first', async () => {
    expect(decisiveToolForSymptom('check whether a value I was given is stale')).toBe('state:read');
    const hits = await findTools(corpus, 'check whether a value I was given is stale', { limit: 3 });
    expect(hits[0].tool).toBe('state:read');
  });

  it('does not force-route an unrelated query containing "live"/"stale"', () => {
    expect(decisiveToolForSymptom('live audio streaming latency')).toBeNull();
    expect(decisiveToolForSymptom('a stale UI cache after a nuqs change')).toBeNull();
  });

  it('degrades to lexical when the embedder throws', async () => {
    const hits = await findTools(corpus, 'orient', {
      embedder: async () => {
        throw new Error('embedder down');
      },
      embeddings,
    });
    expect(hits[0].tool).toBe('coord:orient');
  });

  it('degrades to lexical when the query embedder exceeds its budget', async () => {
    const hits = await findTools(corpus, 'deploy a bot', {
      embedder: () => new Promise<number[]>(() => {}),
      embeddings,
      embedTimeoutMs: 5,
    });
    expect(hits.find((h) => h.tool === 'cup:spawn')).toBeUndefined();
    expect(hits.every((h) => h.via === 'lexical')).toBe(true);
    expect(hits.every((h) => h.cosine === null)).toBe(true);
  });

  it('carries argSchema through to the hit (null when absent)', async () => {
    const withSchema = {
      ...entry('flags:set', 'feature flag set'),
      argSchema: 'key:string the flag key; enabled?:boolean on or off',
    } as ToolDiscoveryEntry;
    const hits = await findTools([withSchema], 'flags:set');
    expect(hits[0].argSchema).toBe('key:string the flag key; enabled?:boolean on or off');

    // The base corpus entries have no argSchema → null, never undefined.
    const plain = await findTools(corpus, 'orient');
    expect(plain[0].argSchema).toBeNull();
  });

  /**
   * P-019 — the boot-built catalog index and the per-call query embedding are
   * normally the same space (measured 2026-08-08: both gemma@768), but nothing
   * STRUCTURALLY pins them together. A settings change that swaps embedder width
   * mid-process leaves a stale index in a different space.
   *
   * ⚠ Tested at the CALL SITE, not just on `cosineSimilarity`: a guard that the
   * caller never invokes is not a guard. `deploy a bot` is the right probe
   * because it has NO lexical overlap with `cup:spawn` — it can only be found
   * semantically — so its ABSENCE proves the leg genuinely did not run, rather
   * than merely scoring differently.
   */
  it('a WIDTH-MISMATCHED index skips the semantic leg entirely (lexical-only)', async () => {
    const wideQuery = async (): Promise<number[]> => [0, 1, 0, 0, 0, 0]; // 6-d vs the index's 4-d
    const hits = await findTools(corpus, 'deploy a bot', {
      embedder: wideQuery,
      embeddings, // 4-d
    });
    // Semantic-only discovery is gone, and no hit claims a semantic origin.
    expect(hits.some((h) => h.tool === 'cup:spawn')).toBe(false);
    expect(hits.every((h) => h.via === 'lexical')).toBe(true);
    expect(hits.every((h) => h.cosine === null)).toBe(true);
  });

  /**
   * CALIBRATION for the test above — without this, "no cup:spawn" would also be
   * satisfied by a semantic leg that is broken for some unrelated reason, and
   * the guard test would pass against a tool that can never search semantically.
   */
  it('CONTROL: the same query DOES find cup:spawn when the widths agree', async () => {
    const hits = await findTools(corpus, 'deploy a bot', { embedder: mockEmbedder, embeddings });
    expect(hits.some((h) => h.tool === 'cup:spawn')).toBe(true);
    expect(hits.find((h) => h.tool === 'cup:spawn')?.via).toBe('semantic');
  });
});
