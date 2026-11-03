import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  BAR_CRITIQUE_POLICY,
  barCritiqueThreshold,
  buildBarCritiqueRecord,
  clauseSemanticHash,
  evaluateBarCritiqueGate,
  loadBarCritiqueEvidence,
  type BarCritiqueClause,
  type BarCritiqueEvidence,
} from './plan-start-critique-gate';
import type { listSpecClauses } from './spec-clauses-store';

const PLAN = 'demo-plan';
const BAR_SET_A = 'a'.repeat(64);
const BAR_SET_B = 'b'.repeat(64);

function clause(specId: string, over: Partial<BarCritiqueClause> = {}): BarCritiqueClause {
  return {
    specId,
    revision: 1,
    behavior: `${specId} does the thing`,
    behaviorClass: 'happy-path',
    requiredEvidence: ['tree'],
    requiredTestLayers: ['unit'],
    mutationRequired: false,
    exemption: null,
    falsifier: { observation: `${specId} does not do the thing` },
    lifecycleStatus: 'draft',
    createdAt: '2026-10-01T00:00:00.000Z',
    sourceBar: null,
    ...over,
  };
}

function bar(specId: string, barSetHash: string, rubricRevision: number, over: Partial<BarCritiqueClause> = {}) {
  return clause(specId, {
    sourceBar: { barKey: specId, barHash: 'h', barSetHash, rubricSlug: 'r', rubricRevision, evidencePlane: 'tree' },
    ...over,
  });
}

function critique(
  consultId: string,
  partyKey: string,
  clauses: BarCritiqueClause[],
  closedAt = '2026-10-02T00:00:00.000Z',
): BarCritiqueEvidence {
  return {
    consultId,
    criticId: partyKey,
    partyKey,
    record: buildBarCritiqueRecord({ planSlug: PLAN, closedAt, answeredAt: null, clausesAsOfClose: clauses, history: clauses }),
  };
}

const NO_AUTHOR = new Set<string>(['su-author']);

describe('plan-start bar-critique gate (P-007)', () => {
  it('passes when every current clause is covered by the required number of outside critiques', () => {
    const cs = [clause('S-1'), clause('S-2')];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: cs, critiques: [critique('c1', 'su-x', cs)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.satisfied).toBe(true);
    expect(v.consultIds).toEqual(['c1']);
  });

  it('SPEC-P-007-CLAUSE-COVERAGE: refuses critique_missing for a current clause no critique covered', () => {
    const critiqued = [clause('S-1')];
    const current = [clause('S-1'), clause('S-2')];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', critiqued)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('critique_missing');
    expect(v.clauseShortfalls).toEqual([{ specId: 'S-2', revision: 1, coveredBy: 0, reason: 'missing' }]);
  });

  it('SPEC-P-007-CLAUSE-COVERAGE: refuses with no critiques at all', () => {
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: [clause('S-1')], critiques: [], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.code).toBe('critique_missing');
  });

  it('SPEC-P-007-START-CRITIQUE: refuses critique_stale when behavior changed after the critique closed', () => {
    const old = [clause('S-1')];
    const current = [clause('S-1', { revision: 2, behavior: 'S-1 does a different thing' })];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', old)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.code).toBe('critique_stale');
    expect(v.clauseShortfalls[0]).toMatchObject({ specId: 'S-1', reason: 'stale' });
  });

  it('SPEC-P-007-START-CRITIQUE: refuses critique_stale when only the falsifier changed', () => {
    const old = [clause('S-1')];
    const current = [clause('S-1', { revision: 2, falsifier: { observation: 'a weaker observation' } })];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', old)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.code).toBe('critique_stale');
  });

  it('SPEC-P-007-ACTIVATION-STABLE: a lifecycle/revision/acceptance-only change keeps the critique current', () => {
    const before = [clause('S-1')];
    const activated = [
      clause('S-1', { revision: 2, lifecycleStatus: 'active', createdAt: '2026-10-03T00:00:00.000Z' }),
    ];
    expect(clauseSemanticHash(before[0]!)).toBe(clauseSemanticHash(activated[0]!));
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: activated, critiques: [critique('c1', 'su-x', before)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.satisfied).toBe(true);
  });

  it('SPEC-P-007-DISTINCT-LINEAGE: two answers from one lineage count once when two are required', () => {
    const cs = [clause('S-1')];
    const v = evaluateBarCritiqueGate({
      planSlug: PLAN,
      currentClauses: cs,
      critiques: [critique('c1', 'su-expert', cs), critique('c2', 'su-expert', cs)],
      authorPartyKeys: NO_AUTHOR,
      threshold: 2,
    });
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('critique_missing');
    expect(v.critics).toEqual(['su-expert']);
    expect(v.clauseShortfalls[0]).toMatchObject({ coveredBy: 1 });
  });

  it('SPEC-P-007-DISTINCT-LINEAGE: two distinct lineages satisfy a threshold of two', () => {
    const cs = [clause('S-1')];
    const v = evaluateBarCritiqueGate({
      planSlug: PLAN,
      currentClauses: cs,
      critiques: [critique('c1', 'su-a', cs), critique('c2', 'su-b', cs)],
      authorPartyKeys: NO_AUTHOR,
      threshold: 2,
    });
    expect(v.satisfied).toBe(true);
  });

  it("SPEC-P-007-AUTHOR-LINEAGE: a critique answered from the author's lineage counts zero", () => {
    const cs = [clause('S-1')];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: cs, critiques: [critique('c1', 'su-author', cs)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('critique_missing');
    expect(v.authorLineageConsultIds).toEqual(['c1']);
    expect(v.consultIds).toEqual([]);
  });

  it('SPEC-P-007-REMOVED-CLAUSE: superseding a critiqued clause after the close is stale until a later critique covers it', () => {
    const critiqued = [clause('S-1'), clause('S-2')];
    const current = [clause('S-1'), clause('S-2', { revision: 2, lifecycleStatus: 'superseded' })];
    const before = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', critiqued)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(before.code).toBe('critique_stale');
    expect(before.clauseShortfalls).toEqual([{ specId: 'S-2', coveredBy: 0, reason: 'removed' }]);

    const delta = critique('c2', 'su-y', current, '2026-10-05T00:00:00.000Z');
    const after = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', critiqued), delta], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(after.satisfied).toBe(true);
  });

  it('SPEC-P-007-REMOVED-CLAUSE: a clause deleted from the contract (absent, not superseded) is also stale', () => {
    const critiqued = [clause('S-1'), clause('S-2')];
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: [clause('S-1')], critiques: [critique('c1', 'su-x', critiqued)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.code).toBe('critique_stale');
  });

  it('SPEC-P-007-BAR-SET-CHANGE: a bar-set hash change after the close is stale without a later critique', () => {
    const critiqued = [bar('R-1', BAR_SET_A, 2)];
    const current = [bar('R-1', BAR_SET_B, 3)];
    expect(clauseSemanticHash(critiqued[0]!)).toBe(clauseSemanticHash(current[0]!));
    const v = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', critiqued)], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('critique_stale');
    expect(v.barSetShortfall).toEqual({ coveredBy: 0, reason: 'stale' });
    expect(v.clauseShortfalls).toEqual([]);

    const delta = critique('c2', 'su-y', current, '2026-10-05T00:00:00.000Z');
    const after = evaluateBarCritiqueGate({ planSlug: PLAN, currentClauses: current, critiques: [critique('c1', 'su-x', critiqued), delta], authorPartyKeys: NO_AUTHOR, threshold: 1 });
    expect(after.satisfied).toBe(true);
  });

  it('SPEC-P-007-DISPOSITION-REVISIONS: revisions created between answer and close are listed; pins are the close snapshot', () => {
    const answered = clause('S-1', { createdAt: '2026-10-01T00:00:00.000Z' });
    const disposed = clause('S-1', { revision: 2, behavior: 'tightened', createdAt: '2026-10-02T12:00:00.000Z' });
    const afterClose = clause('S-2', { createdAt: '2026-10-04T00:00:00.000Z' });
    const record = buildBarCritiqueRecord({
      planSlug: PLAN,
      answeredAt: '2026-10-02T00:00:00.000Z',
      closedAt: '2026-10-03T00:00:00.000Z',
      clausesAsOfClose: [disposed],
      history: [answered, disposed, afterClose],
    });
    expect(record.dispositionRevisions).toEqual([{ specId: 'S-1', revision: 2, createdAt: '2026-10-02T12:00:00.000Z' }]);
    expect(record.pins).toEqual([{ specId: 'S-1', revision: 2, semanticHash: clauseSemanticHash(disposed) }]);
  });

  it('D-003 threshold: two critiques above 8 items or 3 mandatory outcome bars', () => {
    expect(barCritiqueThreshold({ nonDroppedItemCount: 8, mandatoryOutcomeBarCount: 3 })).toBe(1);
    expect(barCritiqueThreshold({ nonDroppedItemCount: 9, mandatoryOutcomeBarCount: 0 })).toBe(2);
    expect(barCritiqueThreshold({ nonDroppedItemCount: 1, mandatoryOutcomeBarCount: 4 })).toBe(2);
  });
});

describe('loadBarCritiqueEvidence (P-007 reader)', () => {
  type Row = {
    conversation_id: string;
    closed_at: string;
    responder_id: string | null;
    author_id: string | null;
    answered_at: string | null;
  };

  function fakeSql(rows: Row[]) {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve(rows);
    }) as unknown as Sql;
    return { sql, calls };
  }

  const S1 = clause('S-1');

  it('bounds independent snapshot reads and preserves close-order pins when reads finish out of order', async () => {
    const rows: Row[] = Array.from({ length: 6 }, (_, index) => ({
      conversation_id: `c-${index}`,
      closed_at: new Date(Date.UTC(2026, 9, 3 + index)).toISOString(),
      responder_id: `critic-${index}`, author_id: null, answered_at: null,
    }));
    const { sql } = fakeSql(rows);
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;
    const listClauses = (async (opts: { asOf?: string; includeHistory?: boolean }) => {
      if (opts.includeHistory) return [S1];
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.set(opts.asOf!, resolve));
      active -= 1;
      return [{ ...S1, revision: rows.findIndex((row) => row.closed_at === opts.asOf) + 1 }];
    }) as unknown as typeof listSpecClauses;
    const result = loadBarCritiqueEvidence(
      { workspaceId: 'ws', harnessSlug: 'h', planSlug: PLAN, authorIds: [] },
      { sql, listClauses, partyKeys: async () => new Map() },
    );

    await vi.waitFor(() => expect(releases.size).toBe(4));
    releases.get(rows[3].closed_at)!();
    await Promise.resolve();
    expect(releases.size).toBe(4);
    for (const index of [2, 1, 0]) releases.get(rows[index].closed_at)!();
    await vi.waitFor(() => expect(releases.size).toBe(6));
    for (const index of [5, 4]) releases.get(rows[index].closed_at)!();

    const out = await result;
    expect(maxActive).toBe(4);
    expect(out.critiques.map((critique) => critique.consultId)).toEqual(rows.map((row) => row.conversation_id));
    expect(out.critiques.map((critique) => critique.record.pins[0].revision)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('propagates a snapshot read failure instead of returning partial critique evidence', async () => {
    const { sql } = fakeSql([
      { conversation_id: 'c-ok', closed_at: '2026-10-03T00:00:00.000Z', responder_id: 'a', author_id: null, answered_at: null },
      { conversation_id: 'c-failed', closed_at: '2026-10-04T00:00:00.000Z', responder_id: 'b', author_id: null, answered_at: null },
    ]);
    const listClauses = (async (opts: { asOf?: string; includeHistory?: boolean }) => {
      if (opts.asOf === '2026-10-04T00:00:00.000Z') throw new Error('snapshot unavailable');
      return [S1];
    }) as unknown as typeof listSpecClauses;
    await expect(loadBarCritiqueEvidence(
      { workspaceId: 'ws', harnessSlug: 'h', planSlug: PLAN, authorIds: [] },
      { sql, listClauses, partyKeys: async () => new Map() },
    )).rejects.toThrow('snapshot unavailable');
  });

  it("SPEC-P-007-AUTHOR-LINEAGE: the critic is the answer author, not the routed consult's source expert", async () => {
    const { sql, calls } = fakeSql([
      // Routed: responder_id is the source expert whose transcript was forked; the fork answered.
      { conversation_id: 'c-routed', closed_at: '2026-10-03T00:00:00.000Z', responder_id: 'su-expert', author_id: 'su-fork', answered_at: '2026-10-02T00:00:00.000Z' },
      // No answer post recorded: fall back to responder_id.
      { conversation_id: 'c-direct', closed_at: '2026-10-04T00:00:00.000Z', responder_id: 'su-direct', author_id: null, answered_at: null },
    ]);
    const asOfCalls: Array<string | undefined> = [];
    let historyCalls = 0;
    const listClauses = (async (opts: { asOf?: string; includeHistory?: boolean }) => {
      if (opts.includeHistory) historyCalls += 1;
      else asOfCalls.push(opts.asOf);
      return [S1];
    }) as unknown as typeof listSpecClauses;
    const partyKeys = async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, id === 'su-fork' || id === 'su-author' ? 'L:author' : `L:${id}`]));

    const out = await loadBarCritiqueEvidence(
      { workspaceId: 'ws', harnessSlug: 'h', planSlug: PLAN, authorIds: [' su-author '] },
      { sql, listClauses, partyKeys },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual(expect.arrayContaining(['ws', PLAN, BAR_CRITIQUE_POLICY]));
    expect(out.critiques.map((c) => [c.consultId, c.criticId, c.partyKey])).toEqual([
      ['c-routed', 'su-fork', 'L:author'],
      ['c-direct', 'su-direct', 'L:su-direct'],
    ]);
    expect([...out.authorPartyKeys]).toEqual(['L:author']);
    // Each record is rebuilt as of its own close; history is read once.
    expect(asOfCalls).toEqual(['2026-10-03T00:00:00.000Z', '2026-10-04T00:00:00.000Z']);
    expect(historyCalls).toBe(1);
    expect(out.critiques[0].record.answeredAt).toBe('2026-10-02T00:00:00.000Z');
    expect(out.critiques[0].record.pins).toEqual([{ specId: 'S-1', revision: 1, semanticHash: clauseSemanticHash(S1) }]);

    // The fork answered from the author's lineage, so only the direct critique counts.
    const verdict = evaluateBarCritiqueGate({
      planSlug: PLAN,
      currentClauses: [S1],
      critiques: out.critiques,
      authorPartyKeys: out.authorPartyKeys,
      threshold: 1,
    });
    expect(verdict.satisfied).toBe(true);
    expect(verdict.consultIds).toEqual(['c-direct']);
    expect(verdict.authorLineageConsultIds).toEqual(['c-routed']);
  });

  it('reads no clauses when the plan has no closed bar critiques, but still resolves the author lineage', async () => {
    const { sql } = fakeSql([]);
    let clauseReads = 0;
    const listClauses = (async () => {
      clauseReads += 1;
      return [];
    }) as unknown as typeof listSpecClauses;
    const out = await loadBarCritiqueEvidence(
      { workspaceId: 'ws', harnessSlug: 'h', planSlug: PLAN, authorIds: ['su-author'] },
      { sql, listClauses, partyKeys: async (ids) => new Map(ids.map((id) => [id, `L:${id}`])) },
    );
    expect(out.critiques).toEqual([]);
    expect([...out.authorPartyKeys]).toEqual(['L:su-author']);
    expect(clauseReads).toBe(0);
  });
});
