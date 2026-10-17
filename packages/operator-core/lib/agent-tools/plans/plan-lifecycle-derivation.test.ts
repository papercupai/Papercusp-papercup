import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildPlanFreshness,
  derivePlanLifecycleForRead,
  gatherPlanLifecycleSignals,
  normalizeActivityTimestamp,
} from './plan-lifecycle-derivation';
import type { ItemStatus, PlanItem } from '@papercusp/plan-parser';

/**
 * plan-lifecycle-derivation.test.ts — P-003 of
 * deterministic-plan-state-derivation-2026-08-31.
 *
 * The pure verdict logic is tested in `@papercusp/plan-parser`'s own
 * `lifecycle.test.ts`. What is tested HERE is the part that can only go wrong
 * at the seam: the timestamp shapes these tables actually store, the
 * measured-vs-unmeasured distinction across a failing lookup, and the two
 * properties a later editor is most likely to "simplify" away.
 */

const item = (id: string, storedStatus: ItemStatus, extra: Partial<PlanItem> = {}): PlanItem => ({
  id,
  text: `${id} body`,
  storedStatus,
  importance: 'normal',
  riskTier: null,
  authority: 'system',
  blockedBy: [],
  decisionRefs: [],
  phase: null,
  lineNumber: 1,
  rawLine: `- **${id}** \`${storedStatus}\` ${id} body`,
  ...extra,
});

const NOW = '2026-08-31T12:00:00.000Z';

describe('normalizeActivityTimestamp — the shapes these tables really store', () => {
  // Derived, never hand-typed: a literal epoch beside a literal ISO string is
  // an arithmetic claim the test cannot check, and getting it wrong makes the
  // TEST look like a code failure (it did, on the first run of this file).
  const INSTANT = '2026-08-31T13:00:00.000Z';
  const EPOCH_MS = Date.parse(INSTANT);

  it('reads an epoch-millisecond bigint returned as a STRING', () => {
    // The trap this exists for: postgres-js returns `bigint` as a string to
    // avoid precision loss, and `Date.parse('1788181200000')` is NaN. Without
    // the all-digit branch, every linked work-item timestamp reads as
    // unmeasurable and the freshness signal silently loses half its sources.
    expect(normalizeActivityTimestamp(String(EPOCH_MS))).toBe(INSTANT);
  });

  it('reads the same instant as a number, a Date and an ISO string', () => {
    expect(normalizeActivityTimestamp(EPOCH_MS)).toBe(INSTANT);
    expect(normalizeActivityTimestamp(new Date(EPOCH_MS))).toBe(INSTANT);
    expect(normalizeActivityTimestamp(INSTANT)).toBe(INSTANT);
  });

  it('returns null for anything unparseable rather than a fallback instant', () => {
    // A bad value must never become evidence of activity: returning 0 or
    // now() would make a broken column the strongest freshness signal there is.
    for (const bad of [null, undefined, '', '   ', 'not-a-date', {}, [], NaN, new Date('x')]) {
      expect(normalizeActivityTimestamp(bad)).toBeNull();
    }
  });
});

describe('buildPlanFreshness', () => {
  it('fuses to the NEWEST source and keeps per-source attribution', () => {
    const f = buildPlanFreshness(
      [
        { source: 'plan-write', at: '2026-08-01T00:00:00.000Z' },
        { source: 'linked-work-item', at: '2026-08-20T00:00:00.000Z' },
      ],
      NOW,
    );
    expect(f.lastActivityAt).toBe('2026-08-20T00:00:00.000Z');
    expect(f.sources).toEqual([
      { source: 'plan-write', at: '2026-08-01T00:00:00.000Z' },
      { source: 'linked-work-item', at: '2026-08-20T00:00:00.000Z' },
    ]);
  });

  it('CONTROL: order does not decide the answer — the newest wins either way', () => {
    const f = buildPlanFreshness(
      [
        { source: 'plan-write', at: '2026-08-20T00:00:00.000Z' },
        { source: 'linked-work-item', at: '2026-08-01T00:00:00.000Z' },
      ],
      NOW,
    );
    expect(f.lastActivityAt).toBe('2026-08-20T00:00:00.000Z');
  });

  it('keeps an unreadable source in the list instead of dropping it', () => {
    // A dropped source is indistinguishable from one that was never checked.
    const f = buildPlanFreshness(
      [
        { source: 'plan-write', at: '2026-08-20T00:00:00.000Z' },
        { source: 'linked-work-item', at: null },
      ],
      NOW,
    );
    expect(f.lastActivityAt).toBe('2026-08-20T00:00:00.000Z');
    expect(f.sources).toContainEqual({ source: 'linked-work-item', at: null });
  });

  it('reports no activity at all when every source is empty', () => {
    const f = buildPlanFreshness([{ source: 'plan-write', at: null }], NOW);
    expect(f.lastActivityAt).toBeNull();
  });
});

describe('gatherPlanLifecycleSignals — measured vs unmeasured', () => {
  const base = { workspaceId: 'ws', planSlug: 'p', now: NOW, planUpdatedAt: NOW };

  it('reports an active rubric when the lookup finds one', async () => {
    const s = await gatherPlanLifecycleSignals({
      ...base,
      readAcceptance: async () => new Map([['p', 'p-acceptance']]),
    });
    expect(s.acceptance).toEqual({ rubricActive: true, rubricRef: 'p-acceptance' });
  });

  it('CONTROL: reports rubricActive false when the lookup succeeds and finds none', async () => {
    const s = await gatherPlanLifecycleSignals({ ...base, readAcceptance: async () => new Map() });
    expect(s.acceptance).toEqual({ rubricActive: false, rubricRef: null });
  });

  it('a FAILED lookup is unmeasured — never silently false', async () => {
    // The whole point of the distinction: `{rubricActive:false}` is a finding,
    // `undefined` is an admission. Collapsing them lets a plan whose acceptance
    // state could not be read present as one that has not started acceptance.
    const s = await gatherPlanLifecycleSignals({
      ...base,
      readAcceptance: async () => {
        throw new Error('pg down');
      },
    });
    expect(s.acceptance).toBeUndefined();
    // …and it still returns freshness rather than failing the whole read.
    expect(s.freshness?.lastActivityAt).toBe(NOW);
  });

  it('skips the query entirely when a batched caller pre-resolved the answer', async () => {
    let called = 0;
    const s = await gatherPlanLifecycleSignals({
      ...base,
      acceptanceRubricRef: null,
      readAcceptance: async () => {
        called += 1;
        return new Map();
      },
    });
    expect(called).toBe(0);
    expect(s.acceptance).toEqual({ rubricActive: false, rubricRef: null });
  });
});

describe('derivePlanLifecycleForRead — composition', () => {
  const signals = (over: Record<string, unknown> = {}) => ({
    workspaceId: 'ws',
    planSlug: 'p',
    now: NOW,
    planUpdatedAt: NOW,
    readAcceptance: async () => new Map<string, string>(),
    ...over,
  });

  it('contradicts a live status over a drained graph', async () => {
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done'), item('P-002', 'done')],
      storedStatus: 'active',
      signals: signals(),
    });
    expect(r.disposition).toBe('contradicted');
    expect(r.derived.verdict).toBe('implementation-complete');
  });

  it('CONTROL: the same status over a live graph agrees', async () => {
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done'), item('P-002', 'todo')],
      storedStatus: 'active',
      signals: signals(),
    });
    expect(r.disposition).toBe('agreed');
    expect(r.derived.verdict).toBe('active');
  });

  it('threads the freshness signal through to a stalled verdict', async () => {
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'todo')],
      storedStatus: 'active',
      // 200 days of no plan write and no linked work-item movement.
      signals: signals({ planUpdatedAt: '2026-02-12T12:00:00.000Z' }),
    });
    expect(r.derived.verdict).toBe('stalled');
    expect(r.derived.idleDays).toBeGreaterThan(180);
  });

  it('threads an unmeasured acceptance signal through to the verdict', async () => {
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done')],
      storedStatus: 'active',
      signals: signals({
        readAcceptance: async () => {
          throw new Error('pg down');
        },
      }),
    });
    expect(r.derived.unmeasured).toContain('acceptance');
    expect(r.derived.verdict).toBe('implementation-complete');
  });

  it('keeps the full lifecycle census but narrows per-item enrichment readers', async () => {
    const iterationItemIds: string[][] = [];
    const grindingItemIds: string[][] = [];
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done'), item('P-002', 'todo'), item('P-003', 'done')],
      storedStatus: 'active',
      signals: signals(),
      enrichmentItemIds: ['P-002'],
      readIterations: async ({ itemIds }) => {
        iterationItemIds.push([...itemIds]);
        return null;
      },
      readGrinding: async ({ itemIds }) => {
        grindingItemIds.push([...itemIds]);
        return null;
      },
    });
    expect(iterationItemIds).toEqual([['P-002']]);
    expect(grindingItemIds).toEqual([['P-002']]);
    expect(r.derived.counts).toMatchObject({ total: 3, done: 2, dropped: 0, nonTerminal: 1 });
  });

  // EI-22078741539479611: an acceptance rubric retires WITH its shipped plan, so a
  // shipped plan's "no active rubric" is a validation that CLOSED. The retired read
  // exists to say so — and runs ONLY where it can change the answer.
  it('a SHIPPED plan with no active rubric names its RETIRED rubric — closed, not unbegun', async () => {
    const retiredCalls: string[][] = [];
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done')],
      storedStatus: 'shipped',
      signals: signals({
        readRetiredAcceptance: async ({ planSlugs }: { planSlugs: readonly string[] }) => {
          retiredCalls.push([...planSlugs]);
          return new Map([['p', 'acceptance-p']]);
        },
      }),
    });
    expect(retiredCalls).toEqual([['p']]);
    expect(r.disposition).toBe('agreed');
    expect(r.derived.acceptance).toMatchObject({ rubricActive: false, retiredRubricRef: 'acceptance-p' });
    expect(r.derived.text).toContain('acceptance-p');
    expect(r.derived.text).not.toMatch(/has not begun/i);
  });

  it('CONTROL: the same drained graph NOT shipped never runs the retired read', async () => {
    let retiredCalls = 0;
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done')],
      storedStatus: 'active',
      signals: signals({
        readRetiredAcceptance: async () => {
          retiredCalls += 1;
          return new Map<string, string>();
        },
      }),
    });
    expect(retiredCalls).toBe(0);
    expect(r.derived.acceptance?.retiredRubricRef).toBeUndefined();
    expect(r.derived.text).toMatch(/has not begun/i);
  });

  it('CONTROL: a shipped plan with an ACTIVE successor rubric skips the retired read', async () => {
    let retiredCalls = 0;
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done')],
      storedStatus: 'shipped',
      signals: signals({
        readAcceptance: async () => new Map([['p', 'acceptance-p-r2']]),
        readRetiredAcceptance: async () => {
          retiredCalls += 1;
          return new Map<string, string>();
        },
      }),
    });
    expect(retiredCalls).toBe(0);
    expect(r.derived.verdict).toBe('awaiting-acceptance');
  });

  it('a FAILED retired read degrades to measured-false — never a fabricated ref', async () => {
    const r = await derivePlanLifecycleForRead({
      items: [item('P-001', 'done')],
      storedStatus: 'shipped',
      signals: signals({
        readRetiredAcceptance: async () => {
          throw new Error('pg down');
        },
      }),
    });
    expect(r.derived.unmeasured).not.toContain('acceptance');
    expect(r.derived.acceptance).toMatchObject({ rubricActive: false });
    expect(r.derived.acceptance?.retiredRubricRef).toBeUndefined();
  });
});

describe('pinned properties a later editor is likely to break', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./plan-lifecycle-derivation.ts', import.meta.url)),
    'utf8',
  );

  it('keeps the NULLIF conjunct that makes the acceptance lookup index-scan', () => {
    // Redundant to a human reader, load-bearing to the planner: it is what lets
    // Postgres prove the query implies the partial unique index's predicate.
    // Measured 2026-08-31 on live data, dropping it turns every plan read into
    // a full table scan of harness_plans (726 buffers / 6.07ms → 8 / 0.12ms).
    expect(source).toContain(`NULLIF(template_data ->> 'subjectPlan', '') IS NOT NULL`);
  });

  it('never reads plan_items.updated_at as an item-transition timestamp', () => {
    // plan-index-rows.ts rebuilds that whole index by DELETE+INSERT on every
    // plan write, so the column holds the PLAN's write time on every row.
    // Reintroducing it here would republish one timestamp under two names, the
    // second promising a granularity nothing measures.
    expect(source).not.toMatch(/FROM\s+harness_shared\.plan_items/);
  });
});
