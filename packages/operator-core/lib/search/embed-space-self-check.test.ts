import { describe, it, expect } from 'vitest';
import {
  cosineDistance,
  parseVectorText,
  pickCanaryRow,
  runEmbedSpaceSelfCheckTick,
  DEFAULT_DISTANCE_ALERT_THRESHOLD,
  type CanaryRow,
  type EmbedSpaceSelfCheckDeps,
} from './embed-space-self-check';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';
import type { Sql } from 'postgres';
import { EMBEDDER_DIM_SPECS, type EmbedderMode, type EmbedderProfileSpec, type ResolvedEmbedder } from '@papercusp/memory';
import { createSelfCheckMemo } from '@papercusp/search';

const SELF_CHECK_PROFILES: Record<'local' | 'openai', EmbedderProfileSpec> = {
  local: {
    ...EMBEDDER_DIM_SPECS.local,
    profileId: 'self-check-local-space@v1',
    model: 'self-check-local',
    modelRevision: 'test-revision',
    nativeDims: 3,
    mrl: 'none',
    trainedDims: [3],
    targetDims: 3,
  },
  openai: {
    ...EMBEDDER_DIM_SPECS.openai,
    profileId: 'self-check-openai-space@v1',
    model: 'self-check-openai',
    modelRevision: 'test-revision',
    nativeDims: 3,
    mrl: 'none',
    trainedDims: [3],
    targetDims: 3,
  },
};

function resolved(mode: 'local' | 'openai', embed: () => Promise<number[]>): ResolvedEmbedder {
  return { mode: mode as EmbedderMode, dims: 3, profile: SELF_CHECK_PROFILES[mode], embed };
}

// `pickCanary` is injected in every case below, so this handle is never dereferenced —
// it exists only to stop the tick falling back to `getOrgPg().sql`, which opens a real
// pool against the developer's live DB. That fallback is wrapped in a try/catch that
// degrades to `{ ok: false, skipped: 'pg_unavailable' }`, so once the no-real-PG rail
// (EI-19311807188719573) started throwing there, these tests failed on a plain
// AssertionError with the rail message nowhere in sight — and before the rail they
// were passing only because they really were reading the live database.
const SQL_STUB = {} as unknown as Sql;
// A fresh memo per call: the default is one per PROCESS, so without this a
// healthy case would make the next case with the same canary skip its embed.
const runTick = (deps: EmbedSpaceSelfCheckDeps) =>
  runEmbedSpaceSelfCheckTick({ sql: SQL_STUB, memo: createSelfCheckMemo(), ...deps });

describe('cosineDistance (pure)', () => {
  it('identical vectors → distance ~0', () => {
    expect(cosineDistance([1, 0, 0], [1, 0, 0])).toBeCloseTo(0, 10);
    expect(cosineDistance([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])).toBeCloseTo(0, 10);
  });

  it('orthogonal vectors → distance 1', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 10);
  });

  it('opposite vectors → distance 2', () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 10);
  });

  it('a scaled-but-parallel vector still reads distance ~0 (cosine ignores magnitude)', () => {
    expect(cosineDistance([2, 0, 0], [10, 0, 0])).toBeCloseTo(0, 10);
  });

  it('mismatched dimensions → maximal distance (1), not a throw — a dimension mismatch IS a desync signal', () => {
    expect(() => cosineDistance([1, 2, 3], [1, 2])).not.toThrow();
    expect(cosineDistance([1, 2, 3], [1, 2])).toBe(1);
  });

  it('an all-zero vector on either side → maximal distance (1), not NaN/Infinity', () => {
    expect(cosineDistance([0, 0, 0], [1, 2, 3])).toBe(1);
    expect(cosineDistance([1, 2, 3], [0, 0, 0])).toBe(1);
  });

  it('empty vectors → maximal distance (1)', () => {
    expect(cosineDistance([], [])).toBe(1);
  });
});

describe('parseVectorText (pure)', () => {
  it('parses a pgvector ::text literal into a number array', () => {
    expect(parseVectorText('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });

  it('parses negative numbers and scientific notation', () => {
    expect(parseVectorText('[-0.5,1.2e-3,0]')).toEqual([-0.5, 0.0012, 0]);
  });
});

describe('pickCanaryRow', () => {
  function fakeSql(byTable: Record<string, Array<Record<string, string>>>) {
    return {
      unsafe: async (query: string) => {
        const tableMatch = query.match(/FROM (\S+)/);
        const table = tableMatch?.[1];
        if (!table) return [];
        if (table in byTable) return byTable[table];
        throw new Error(`no such table (simulated pre-migration column): ${table}`);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('returns the first TARGETS table with a matching-mode row', async () => {
    const sql = fakeSql({
      'harness_shared.harness_escalations': [{ body: 'hello world', vec: '[0.1,0.2]', k0: 'papercusp' }],
    });
    const row = await pickCanaryRow(sql, 'local');
    expect(row).not.toBeNull();
    expect(row!.body).toBe('hello world');
    expect(row!.storedVectorText).toBe('[0.1,0.2]');
    expect(row!.keyLabel).toBe('harness_shared.harness_escalations#papercusp');
    expect(row!.target.table).toBe('harness_shared.harness_escalations');
  });

  it('skips a table that errors (pre-migration column) and tries the next one', async () => {
    const sql = fakeSql({
      // harness_escalations (first in TARGETS) is intentionally absent → throws.
      'harness_shared.harness_brainstorm': [{ body: 'canary text', vec: '[0.5,0.5]', k0: 'papercusp' }],
    });
    const row = await pickCanaryRow(sql, 'openai');
    expect(row).not.toBeNull();
    expect(row!.target.table).toBe('harness_shared.harness_brainstorm');
  });

  it('returns null when no target has a row in the active space', async () => {
    const sql = fakeSql({});
    const row = await pickCanaryRow(sql, 'openai');
    expect(row).toBeNull();
  });
});

describe('runEmbedSpaceSelfCheckTick', () => {
  function mkCanary(over: Partial<CanaryRow> = {}): CanaryRow {
    return {
      target: {
        table: 'harness_shared.operator_turns',
        embedCol: 'text_embedding',
        bodySql: 'text',
        keyCols: ['id'],
      },
      body: 'the quick brown fox',
      storedVectorText: '[1,0,0]',
      keyLabel: 'harness_shared.operator_turns#42',
      ...over,
    };
  }

  it('embedder disabled → skips cleanly, never calls pickCanary/escalate', async () => {
    let pickCalled = false;
    let escalateCalled = false;
    const result = await runTick({
      resolveEmbedder: async () => ({ mode: 'disabled' }),
      pickCanary: async () => {
        pickCalled = true;
        return null;
      },
      escalate: async () => {
        escalateCalled = true;
      },
    });
    expect(result).toEqual({ ok: true, skipped: 'embedder_disabled' });
    expect(pickCalled).toBe(false);
    expect(escalateCalled).toBe(false);
  });

  it('embedder resolve throws → fails soft (ok:false, skipped), never throws out', async () => {
    const result = await runTick({
      resolveEmbedder: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({ ok: false, skipped: 'embedder_resolve_failed' });
  });

  it('no canary row in the active space → skips, no escalate', async () => {
    let escalateCalled = false;
    const result = await runTick({
      resolveEmbedder: async () => resolved('local', async () => [1, 0, 0]),
      pickCanary: async () => null,
      escalate: async () => {
        escalateCalled = true;
      },
    });
    expect(result).toEqual({ ok: true, skipped: 'no_row_in_active_space', mode: 'local' });
    expect(escalateCalled).toBe(false);
  });

  it('embed() throws → fails soft (ok:false, skipped: embed_failed)', async () => {
    const result = await runTick({
      resolveEmbedder: async () => resolved('local', async () => {
          throw new Error('embed backend down');
        }),
      pickCanary: async () => mkCanary(),
    });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('embed_failed');
  });

  it('fresh vector ~matches stored vector → healthy, no escalate; auto-resolves a stale open escalation', async () => {
    let escalateCalled = false;
    let resolvedMsgId: string | null = null;
    const openRec = { msg_id: 'esc-1', from: 'system:embed-space-self-check', dedupKind: 'embed-space-desync', subjectSignature: 'embed-space-self-check' } as unknown as EscalationRecord;
    const result = await runTick({
      resolveEmbedder: async () => resolved('local', async () => [1, 0, 0]),
      pickCanary: async () => mkCanary({ storedVectorText: '[1,0,0]' }),
      escalate: async () => {
        escalateCalled = true;
      },
      listOpen: async () => [openRec],
      resolveOpen: async (msg_id) => {
        resolvedMsgId = msg_id;
      },
    });
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(0, 10);
    expect(escalateCalled).toBe(false);
    expect(resolvedMsgId).toBe('esc-1');
  });

  it('fresh vector far from stored vector → escalates once with advisory severity + dedup meta', async () => {
    let escalateInput: Record<string, unknown> | null = null;
    const result = await runTick({
      resolveEmbedder: async () => resolved('openai', async () => [0, 1, 0]),
      pickCanary: async () => mkCanary({ storedVectorText: '[1,0,0]' }), // orthogonal → distance 1
      escalate: async (input) => {
        escalateInput = input;
      },
      listOpen: async () => [],
    });
    expect(result.ok).toBe(true);
    expect(result.distance).toBeCloseTo(1, 10);
    expect(escalateInput).not.toBeNull();
    expect(escalateInput!.severity).toBe('advisory');
    expect(escalateInput!.summary).toContain('embed-space-desync');
    expect((escalateInput!.meta as Record<string, unknown>).dedupKind).toBe('embed-space-desync');
    expect((escalateInput!.meta as Record<string, unknown>).subjectSignature).toBe('embed-space-self-check');
  });

  it('distance exactly at the threshold is healthy (boundary is inclusive, <=)', async () => {
    let escalateCalled = false;
    const result = await runTick({
      resolveEmbedder: async () => resolved('local', async () => [1, 0, 0]),
      pickCanary: async () => mkCanary({ storedVectorText: '[1,0,0]' }),
      escalate: async () => {
        escalateCalled = true;
      },
      distanceThreshold: 0, // identical vectors → distance 0 → exactly at threshold
      listOpen: async () => [],
    });
    expect(result.distance).toBeCloseTo(0, 10);
    expect(escalateCalled).toBe(false);
  });

  it('an idle Server: the next tick with the same embedder profile and canary does not embed (WI-10005523)', async () => {
    const memo = createSelfCheckMemo();
    let embedCalls = 0;
    let resolveOpenCalls = 0;
    let profile = SELF_CHECK_PROFILES.local;
    const deps: EmbedSpaceSelfCheckDeps = {
      memo,
      resolveEmbedder: async () => ({
        mode: 'local' as EmbedderMode,
        dims: 3,
        profile,
        embed: async () => {
          embedCalls++;
          return [1, 0, 0];
        },
      }),
      pickCanary: async () => mkCanary({ storedVectorText: '[1,0,0]' }),
      listOpen: async () => [],
      resolveOpen: async () => {
        resolveOpenCalls++;
      },
    };
    expect(await runTick(deps)).toMatchObject({ ok: true, distance: 0, mode: 'local' });
    expect(await runTick(deps)).toEqual({
      ok: true,
      skipped: 'unchanged_since_last_pass',
      table: 'harness_shared.operator_turns',
      keyLabel: 'harness_shared.operator_turns#42',
      distance: 0,
      mode: 'local',
    });
    expect(embedCalls).toBe(1);

    // A new model revision is a different space: the check must run again.
    profile = { ...SELF_CHECK_PROFILES.local, modelRevision: 'test-revision-2' };
    expect(await runTick(deps)).toMatchObject({ ok: true, distance: 0 });
    expect(embedCalls).toBe(2);
    expect(resolveOpenCalls).toBe(0);
  });

  it('default threshold constant is exported and reasonably small (not ~0, not huge)', () => {
    expect(DEFAULT_DISTANCE_ALERT_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_DISTANCE_ALERT_THRESHOLD).toBeLessThan(0.5);
  });
});
