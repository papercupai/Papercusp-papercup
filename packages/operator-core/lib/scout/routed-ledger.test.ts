/**
 * routed-ledger.test.ts — unit pins for gradeRoutedIdea (scout-idea-grading
 * C-2) over a stubbed PG seam: the result-shape mapping (applied /
 * owner-grade-sovereign / not-found), the grade validation, and the
 * fire-and-forget `learning.scout` invalidate firing ONLY on applied writes.
 *
 * The real precedence SQL (the `graded_by IS DISTINCT FROM 'owner'` guard
 * against live rows) is pinned in routed-ledger.integration.test.ts; this file
 * covers the seam's own logic without PG.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GradeRoutedIdeaDiagnostics } from './routed-ledger';

const h = vi.hoisted(() => ({
  /** Rows the UPDATE … RETURNING yields. */
  updateRows: [] as Array<{ idea_id: string }>,
  /** Rows the existence SELECT yields. */
  selectRows: [] as Array<{ idea_id: string }>,
  /** Rows the work-item terminal-facts SELECT yields (WI-10007390). */
  factsRows: [] as Array<{ terminal_owner: string | null; triage_rejected: boolean }>,
  queries: [] as string[],
  /** Interpolated values per query, index-aligned with `queries`. */
  values: [] as unknown[][],
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: Object.assign((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const text = strings.join(' ');
      h.queries.push(text);
      h.values.push(vals);
      if (text.includes('UPDATE harness_shared.scout_routed_ideas')) return Promise.resolve(h.updateRows);
      if (text.includes('SELECT idea_id')) return Promise.resolve(h.selectRows);
      if (text.includes('SELECT w.terminal_owner')) return Promise.resolve(h.factsRows);
      return Promise.resolve([]);
    }, { begin: vi.fn(async function (this: unknown, write: (sql: unknown) => Promise<unknown>) {
      return write(this);
    }) }),
  }),
}));

vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('../experiment/producer-lifecycle-store', async (original) => ({
  ...(await original<typeof import('../experiment/producer-lifecycle-store')>()),
  recordProducerObservation: vi.fn(async () => {}),
}));

const { gradeRoutedIdea, hiveFromPatternRefs, propagatePlanOutcome, propagateWorkItemOutcome, workItemTerminalEntries } = await import('./routed-ledger');
const sse = await import('../sync-sse');
const invalidate = vi.mocked(sse.notifySyncInvalidate);

/** Let the seam's fire-and-forget lazy import + invalidate settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  h.updateRows = [];
  h.selectRows = [];
  h.factsRows = [];
  h.queries = [];
  h.values = [];
  invalidate.mockClear();
});

describe('gradeRoutedIdea (C-2 seam logic)', () => {
  it('rejects non-integer / out-of-range grades before touching PG', async () => {
    for (const grade of [0, 6, 4.5, NaN]) {
      await expect(gradeRoutedIdea({ ideaId: 'i1', grade, gradedBy: 'owner' })).rejects.toThrow(/integer 1–5/);
    }
    expect(h.queries).toHaveLength(0);
  });

  it('applied write → { applied: true } and fires the learning.scout invalidate', async () => {
    h.updateRows = [{ idea_id: 'i1' }];
    const res = await gradeRoutedIdea({ ideaId: 'i1', grade: 4, feedback: 'sharp', gradedBy: 'Queen' });
    expect(res).toEqual({ applied: true });
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('learning.scout'));
  });

  it('emits write, update, and producer-observation phase diagnostics for a committed grade', async () => {
    h.updateRows = [{ idea_id: 'i1' }];
    const snapshots: Array<{ phases: GradeRoutedIdeaDiagnostics['phases'] }> = [];

    const res = await gradeRoutedIdea(
      { ideaId: 'i1', grade: 4, gradedBy: 'su-reviewer' },
      { onDiagnostics: (diagnostics) => snapshots.push({ phases: { ...diagnostics.phases } }) },
    );

    expect(res).toEqual({ applied: true });
    expect(snapshots.find((snapshot) => snapshot.phases.gradeUpdate?.status === 'in-progress')?.phases.gradeUpdate?.startedAt)
      .toEqual(expect.any(String));
    expect(snapshots.find((snapshot) => snapshot.phases.producerObservation?.status === 'in-progress')?.phases.producerObservation?.startedAt)
      .toEqual(expect.any(String));
    expect(snapshots.at(-1)?.phases).toMatchObject({
      writeTransaction: { status: 'ok' },
      gradeUpdate: { status: 'ok' },
      producerObservation: { status: 'ok' },
    });
    expect(snapshots.at(-1)?.phases.producerObservation?.elapsedMs).toEqual(expect.any(Number));
    await vi.waitFor(() => expect(invalidate).toHaveBeenCalledWith('learning.scout'));
    await flush();
    await flush();
  });

  it('guarded UPDATE matching nothing + row exists → owner-grade-sovereign, NO invalidate', async () => {
    h.updateRows = [];
    h.selectRows = [{ idea_id: 'i1' }];
    const res = await gradeRoutedIdea({ ideaId: 'i1', grade: 2, gradedBy: 'Queen' });
    expect(res).toEqual({ applied: false, reason: 'owner-grade-sovereign' });
    await flush();
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('no row at all → not-found, NO invalidate', async () => {
    h.updateRows = [];
    h.selectRows = [];
    const res = await gradeRoutedIdea({ ideaId: 'i-missing', grade: 5, gradedBy: 'owner' });
    expect(res).toEqual({ applied: false, reason: 'not-found' });
    await flush();
    await flush();
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('hiveFromPatternRefs (D-003 target-hive derivation, P-002)', () => {
  it('extracts the @<hive> suffix from a rubric pattern ref', () => {
    expect(hiveFromPatternRefs(['rubric:pot-coordination-health#wake-latency@papercusp'])).toBe('papercusp');
  });
  it('returns the first ref that carries a hive tag', () => {
    expect(
      hiveFromPatternRefs(['wi:F-1', 'rubric:scout-quality#diversity@spreadsheet-hive', 'rubric:x#y@other']),
    ).toBe('spreadsheet-hive');
  });
  it('undefined for non-rubric refs (free-text patterns carry no hive tag)', () => {
    expect(hiveFromPatternRefs(['wi:F-1', 'sig:abc123'])).toBeUndefined();
  });
  it('undefined for a rubric ref with no @hive suffix', () => {
    expect(hiveFromPatternRefs(['rubric:pot-coordination-health#wake-latency'])).toBeUndefined();
  });
  it('undefined / empty inputs', () => {
    expect(hiveFromPatternRefs(undefined)).toBeUndefined();
    expect(hiveFromPatternRefs([])).toBeUndefined();
  });
});

describe('propagateWorkItemOutcome (EI-22414305411561114)', () => {
  it('writes a winning outcome for a terminal success and scopes the routed ref', async () => {
    h.updateRows = [{ idea_id: 'idea-1' }];
    h.factsRows = [{ terminal_owner: 'su-x', triage_rejected: false }];

    await expect(
      propagateWorkItemOutcome({
        workItemId: 'WI-1',
        state: 'done',
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
      }),
    ).resolves.toBe(1);

    expect(h.queries.join(' ')).toContain('UPDATE harness_shared.scout_routed_ideas');
    expect(h.queries.join(' ')).toContain('outcome_checked_at');
    expect(h.queries.join(' ')).toContain('routed_ref');
    expect(h.queries.join(' ')).toContain('harness_slug');
  });

  it('writes a losing outcome for dropped/deprecated terminals and ignores live states', async () => {
    h.updateRows = [{ idea_id: 'idea-2' }];

    await expect(
      propagateWorkItemOutcome({
        workItemId: 'WI-2',
        state: 'dropped',
        workspaceId: 'ws-1',
      }),
    ).resolves.toBe(1);

    h.queries = [];
    await expect(
      propagateWorkItemOutcome({
        workItemId: 'WI-3',
        state: 'open',
        workspaceId: 'ws-1',
      }),
    ).resolves.toBe(0);
    expect(h.queries).toHaveLength(0);
  });

  /** The outcome value interpolated into the UPDATE, or undefined when no UPDATE ran. */
  const writtenOutcome = () => {
    const i = h.queries.findIndex((q) => q.includes('UPDATE harness_shared.scout_routed_ideas'));
    return i < 0 ? undefined : h.values[i]?.[0];
  };

  it('WI-10007390: a hygiene close is a LOSS even though `closed` is a winning status', async () => {
    h.updateRows = [{ idea_id: 'idea-h' }];
    h.factsRows = [{ terminal_owner: 'improvement-hygiene', triage_rejected: true }];

    await expect(
      propagateWorkItemOutcome({ workItemId: 'EI-h', state: 'closed', workspaceId: 'ws-1' }),
    ).resolves.toBe(1);
    expect(writtenOutcome()).toBe('lost');
    const factsQuery = h.queries.find((q) => q.includes('SELECT w.terminal_owner')) ?? '';
    expect(factsQuery).toContain('triageDecision');
  });

  it('WI-10007390: a done close with no terminal pair is still a win', async () => {
    h.updateRows = [{ idea_id: 'idea-d' }];
    h.factsRows = [{ terminal_owner: null, triage_rejected: false }];

    await expect(
      propagateWorkItemOutcome({ workItemId: 'EI-d', state: 'done', workspaceId: 'ws-1' }),
    ).resolves.toBe(1);
    expect(writtenOutcome()).toBe('won');
  });
});

describe('workItemTerminalEntries (WI-10007390)', () => {
  const row = (over: Partial<Parameters<typeof workItemTerminalEntries>[0][number]>) => ({
    feature_id: 'EI-1',
    harness_slug: 'papercusp',
    title: 'Some idea',
    status: 'done',
    updated_ts: '1790000000000',
    terminal_owner: 'su-x',
    triage_rejected: false,
    ...over,
  });

  it('tags each terminal by the shared rule and skips live rows', () => {
    const entries = workItemTerminalEntries([
      row({ feature_id: 'EI-won' }),
      row({ feature_id: 'EI-hyg', status: 'closed', terminal_owner: 'improvement-hygiene' }),
      row({ feature_id: 'EI-drop', status: 'dropped' }),
      row({ feature_id: 'EI-bare', status: 'done', terminal_owner: null }),
      row({ feature_id: 'EI-live', status: 'open' }),
    ]);
    expect(entries.map((e) => [e.ref, e.detail])).toEqual([
      ['wi:EI-won', 'Status: done'],
      ['wi:EI-hyg', 'Status: rejected'],
      ['wi:EI-drop', 'Status: dropped'],
      ['wi:EI-bare', 'Status: done'],
    ]);
  });
});

describe('propagatePlanOutcome (WI-10003894)', () => {
  it('settles a shipped plan route as won, scoped to the plan rail and routed ref', async () => {
    h.updateRows = [{ idea_id: 'goal-plan:x' }];

    await expect(
      propagatePlanOutcome({ planSlug: 'some-plan-2026-09-27', status: 'shipped', workspaceId: 'ws-1' }),
    ).resolves.toBe(1);

    expect(h.queries).toHaveLength(1);
    const [text] = h.queries;
    expect(text).toContain('UPDATE harness_shared.scout_routed_ideas');
    expect(text).toContain("rail = 'plan'");
    expect(text).toContain('outcome IS DISTINCT FROM');
    expect(h.values[0]).toContain('won');
    expect(h.values[0]).toContain('plan:some-plan-2026-09-27');
    expect(h.values[0]).toContain('ws-1');
  });

  it('does not filter by harness: Scout records plan routes under @singleton (EI-10520)', async () => {
    await propagatePlanOutcome({ planSlug: 'p', status: 'shipped', workspaceId: 'ws-1' });
    expect(h.queries[0]).not.toContain('harness_slug');
  });

  it('settles a superseded plan route as lost', async () => {
    h.updateRows = [{ idea_id: 'idea-lost' }];
    await expect(
      propagatePlanOutcome({ planSlug: 'replaced-plan', status: 'Superseded ', workspaceId: 'ws-1' }),
    ).resolves.toBe(1);
    expect(h.values[0]).toContain('lost');
    expect(h.values[0]).not.toContain('won');
  });

  it.each(['draft', 'ready', 'active', 'awaiting-acceptance', '', null, undefined])(
    'is a no-op without a query for non-terminal status %s',
    async (status) => {
      await expect(propagatePlanOutcome({ planSlug: 'p', status, workspaceId: 'ws-1' })).resolves.toBe(0);
      expect(h.queries).toHaveLength(0);
    },
  );

  it('is a no-op for an empty slug', async () => {
    await expect(propagatePlanOutcome({ planSlug: '', status: 'shipped', workspaceId: 'ws-1' })).resolves.toBe(0);
    expect(h.queries).toHaveLength(0);
  });
});
