/**
 * search:query — PURE unit tests for the post-query shaping/sorting logic,
 * exercised directly.
 *
 * Focus (no live PG; the BM25 branch is covered by query.integration.test.ts):
 *   - cross-kind merge by in-kind position (RRF), not raw score (plan D-006).
 *   - `slice(limit)` truncation across kinds.
 *   - `degraded` present ONLY when ≥1 kind fell back to ILIKE.
 *   - `wantKind` filter (args.kinds restricts which kinds run).
 *   - per-kind FTS-throws → ILIKE-fallback branch (and the
 *     `<kind>_using_ilike_fallback` reason it pushes).
 *
 * The `ctx.tx` tagged-template mock dispatches by inspecting the SQL text:
 *   - contains `plainto_tsquery` → an FTS query (may be scripted to throw).
 *   - contains `ILIKE`          → the catch-block fallback query.
 * Each is keyed by the table name in the SQL so a per-kind script can target it.
 */

import { describe, expect, it, vi } from 'vitest';
import tool from './query';

type Rows = unknown[];

interface KindScript {
  /** FTS result; if `'throw'`, the FTS query rejects → ILIKE fallback runs. */
  fts: Rows | 'throw';
  /** ILIKE fallback rows (used only when fts==='throw'); `'throw'` makes
   *  the fallback fail too → the kind degrades alone (audit P-048). */
  ilike?: Rows | 'throw';
}

/** table-name fragment → kind, so the mock can route a query to its script. */
const TABLE_KIND: Array<[string, string]> = [
  ['harness_features_consolidated', 'tasks'],
  ['goals', 'goals'],
  ['projects', 'projects'],
  ['audit_log', 'audit'],
];

function kindForSql(sql: string): string | null {
  for (const [frag, kind] of TABLE_KIND) {
    if (sql.includes(frag)) return kind;
  }
  return null;
}

function makeTx(scripts: Record<string, KindScript>) {
  const tx = (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const sql = strings.join(' ');
    const kind = kindForSql(sql);
    const script = kind ? scripts[kind] : undefined;
    if (!script) return Promise.resolve([]);
    const isFts = sql.includes('plainto_tsquery');
    if (isFts) {
      if (script.fts === 'throw') return Promise.reject(new Error('column "_search" does not exist'));
      return Promise.resolve(script.fts);
    }
    // ILIKE fallback
    if (script.ilike === 'throw') return Promise.reject(new Error('relation does not exist'));
    return Promise.resolve(script.ilike ?? []);
  };
  return tx;
}

const CTX = (tx: unknown) => ({
  principal: { slug: 'op', workspaceId: 'default' } as never,
  tx: tx as never,
  log: vi.fn(),
});

type Hit = { kind: string; id: string; score: number; kindScore: number; kindRank: number; snippet: string };

/** The handler's declared return is the generic ToolResponse|ToolResult union; these tests
 *  read search:query's own envelope fields, so narrow once here instead of at every read. */
interface QueryResponse {
  data: unknown;
  degraded?: boolean;
  degradedReasons?: string[];
  engines?: Record<string, string>;
}
const asResponse = (res: unknown): QueryResponse => res as QueryResponse;

describe('search:query — cross-kind merge by position (plan D-006)', () => {
  it('interleaves kinds by in-kind position, whatever their score scales', async () => {
    // goals carry BM25-sized scores, projects ts_rank-sized ones. A raw-score sort would
    // hand every top slot to goals; position fusion alternates the two kinds.
    const tx = makeTx({
      goals: { fts: [12, 11, 10].map((rank, i) => ({ id: `g${i}`, title: `goal ${i}`, rank })) },
      projects: { fts: [0.09, 0.08].map((rank, i) => ({ id: `p${i}`, slug: `proj${i}`, name: `project ${i}`, rank })) },
    });
    const res = asResponse(await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never));
    const data = res.data as Hit[];
    expect(data.map((h) => h.id)).toEqual(['g0', 'proj0', 'g1', 'proj1', 'g2']);
    const scores = data.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(data[0]).toMatchObject({ kind: 'goals', kindScore: 12, kindRank: 1, score: 1 / 61 });
    expect(data[1]).toMatchObject({ kind: 'projects', kindScore: 0.09, kindRank: 1, score: 1 / 61 });
    expect(res.degraded).toBeUndefined();
  });

  it('breaks equal positions by kind order and reports each kind engine', async () => {
    const tx = makeTx({
      tasks: { fts: [{ harness_slug: 'h', feature_id: 'F-1', title: 'low task', summary: '', rank: 0.1 }] },
      goals: { fts: [{ id: 'g1', title: 'high goal', rank: 0.9 }] },
      projects: { fts: [{ id: 'p1', slug: 'proj', name: 'mid project', rank: 0.5 }] },
      audit: { fts: [{ id: 'a1', subject: 'subj', action: 'act', rank: 0.3 }] },
    });
    const res = asResponse(await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never));
    expect((res.data as Hit[]).map((h) => h.kind)).toEqual(['tasks', 'goals', 'projects', 'audit']);
    // The mock database has no BM25 index, so every kind ranks with ts_rank.
    expect(res.engines).toEqual({ tasks: 'fts', goals: 'fts', projects: 'fts', audit: 'fts' });
  });

  it('keeps hits of different kinds that share an id', async () => {
    const tx = makeTx({
      goals: { fts: [{ id: 'same', title: 'goal', rank: 0.5 }] },
      audit: { fts: [{ id: 'same', subject: 's', action: 'a', rank: 0.5 }] },
    });
    const res = asResponse(await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never));
    expect((res.data as Hit[]).map((h) => `${h.kind}:${h.id}`)).toEqual(['goals:same', 'audit:same']);
  });
});

describe('search:query — slice(limit) truncation', () => {
  it('truncates the merged hit list to args.limit', async () => {
    const goalRows = Array.from({ length: 5 }, (_, i) => ({ id: `g${i}`, title: `g${i}`, rank: 1 - i * 0.1 }));
    const taskRows = Array.from({ length: 5 }, (_, i) => ({
      harness_slug: 'h',
      feature_id: `F-${i}`,
      title: `t${i}`,
      summary: '',
      rank: 0.5 - i * 0.05,
    }));
    const tx = makeTx({ goals: { fts: goalRows }, tasks: { fts: taskRows } });
    const res = asResponse(await tool.handler({ query: 'x', limit: 3 } as never, CTX(tx) as never));
    expect((res.data as unknown[]).length).toBe(3);
    // The 3 best positions survive: each kind's first hit, then the tasks' second.
    expect((res.data as Array<{ id: string }>).map((h) => h.id)).toEqual(['h/F-0', 'g0', 'h/F-1']);
  });
});

describe('search:query — wantKind filter', () => {
  it('only runs the kinds named in args.kinds', async () => {
    const visited: string[] = [];
    const tx = (strings: TemplateStringsArray) => {
      const k = kindForSql(strings.join(' '));
      if (k) visited.push(k);
      // return a hit so we also confirm only goals appears in data
      if (k === 'goals') return Promise.resolve([{ id: 'g1', title: 'g', rank: 0.4 }]);
      return Promise.resolve([]);
    };
    const res = asResponse(await tool.handler({ query: 'x', kinds: ['goals'], limit: 25 } as never, CTX(tx) as never));
    expect(new Set(visited)).toEqual(new Set(['goals']));
    expect((res.data as Array<{ kind: string }>).every((h) => h.kind === 'goals')).toBe(true);
  });
});

describe('search:query — FTS throws → ILIKE fallback per kind', () => {
  it('falls back to ILIKE for the failing kind and records a degraded reason', async () => {
    const tx = makeTx({
      // tasks FTS throws → fallback rows w/ score 1
      tasks: {
        fts: 'throw',
        ilike: [{ harness_slug: 'h', feature_id: 'F-9', title: 'fallback task', summary: '' }],
      },
      // goals FTS succeeds → no degraded reason for goals
      goals: { fts: [{ id: 'g1', title: 'ok goal', rank: 0.2 }] },
    });
    const res = asResponse(await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never));
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('tasks_using_ilike_fallback');
    expect(res.degradedReasons).not.toContain('goals_using_ilike_fallback');
    // ILIKE has no relevance: the fallback hit carries kindScore 1 and keeps its position.
    const taskHit = (res.data as Hit[]).find((h) => h.kind === 'tasks');
    expect(taskHit).toMatchObject({ id: 'h/F-9', kindScore: 1, kindRank: 1 });
    expect(res.engines).toEqual({ tasks: 'ilike', goals: 'fts', projects: 'fts', audit: 'fts' });
  });

  it('degraded is absent when every kind uses FTS successfully', async () => {
    const tx = makeTx({ goals: { fts: [{ id: 'g1', title: 'g', rank: 0.5 }] } });
    const res = asResponse(await tool.handler({ query: 'x', kinds: ['goals'], limit: 25 } as never, CTX(tx) as never));
    expect(res.degraded).toBeUndefined();
    expect((res as { degradedReasons?: unknown }).degradedReasons).toBeUndefined();
  });

  it('audit fallback answers through ILIKE with its action: subject snippet', async () => {
    const tx = makeTx({
      audit: { fts: 'throw', ilike: [{ id: 'a1', subject: 's', action: 'act' }] },
    });
    const res = asResponse(await tool.handler({ query: 'x', kinds: ['audit'], limit: 25 } as never, CTX(tx) as never));
    const auditHit = (res.data as Hit[])[0];
    expect(auditHit).toMatchObject({ kind: 'audit', kindScore: 1, kindRank: 1, score: 1 / 61, snippet: 'act: s' });
    expect(res.degradedReasons).toContain('audit_using_ilike_fallback');
    expect(res.engines).toEqual({ audit: 'ilike' });
  });
});

describe('search:query — per-kind isolation when BOTH legs fail (audit P-048)', () => {
  it('a kind whose FTS and ILIKE both throw degrades alone; other kinds still answer', async () => {
    const tx = makeTx({
      tasks: { fts: 'throw', ilike: 'throw' }, // dead kind
      goals: { fts: [{ id: 'g1', title: 'still here', rank: 0.7 }] },
    });
    // Pre-fix this REJECTED the whole handler (the fallback was unwrapped).
    const res = asResponse(await tool.handler({ query: 'x', limit: 25 } as never, CTX(tx) as never));
    expect(res.degraded).toBe(true);
    expect(res.degradedReasons).toContain('tasks_unavailable');
    const kinds = (res.data as Array<{ kind: string }>).map((h) => h.kind);
    expect(kinds).toContain('goals');
    expect(kinds).not.toContain('tasks');
    expect((res.engines as Record<string, string>).tasks).toBe('unavailable');
  });

});

// 'messages' kind (EI-282, over messages_consolidated) retired here — see
// retire-work-item-mail-surface-2026-07-26 P-004 / _retired/work-item-mail/RESTORE.md.
