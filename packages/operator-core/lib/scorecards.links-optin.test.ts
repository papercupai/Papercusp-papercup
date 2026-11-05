/**
 * scorecards.links-optin.test.ts — WI-6124: `listScorecards` resolves outbound links
 * ONLY when a caller opts in, and the reads that actually SURFACE links still do.
 *
 * Why this exists. Resolving `linkedItems` costs one join-heavy query per call
 * (`issuesOutLinksMany`, LEFT JOINing engineer_issues AND features over up to `limit`
 * issue refs). It used to be eager, so every caller paid it — and measured on
 * 2026-08-02 (pg_stat_statements) that statement was the MOST-CALLED query on the box:
 * 1,209,724 calls / 64,865s, reachable only from here, for a field that no server-side
 * caller reads at all. It grew that large silently: `scorecardTrend` and the
 * derived-reads producer both arrived later and both inherited the cost.
 *
 * Neither default is compile-enforceable — both surfacing sites pass rows straight
 * through (`as unknown[]` / a wholesale tool return), so TypeScript cannot see the read.
 * That is exactly why these are TESTS: they are the only mechanical thing standing
 * between the opt-in default and a silent regression, in BOTH directions.
 *
 *   - forget the opt-OUT (pre-WI-6124 default) → ~1.2M pointless heavy joins, invisible
 *   - forget the opt-IN  (post-WI-6124 default) → the ScorecardDetail panel silently
 *     renders no linked items, and agents see every scorecard as unlinked
 *
 * The second failure is the one the new default introduces, so it is pinned here at the
 * REAL call sites (the `scorecards.list` sync-resolver entry and the `scorecards:list`
 * agent tool) rather than by asserting on a flag in isolation — a test that only checked
 * `includeLinks: true` behaves correctly would still pass if a call site dropped it.
 *
 * P-010 then gave `scorecardTrend` a legitimate reason to read edges after all: it drops
 * scorecards a later filing REVISED, so a correction stops moving the trend twice. That is
 * the same pressure that produced the original regression — a later feature needs one fact
 * about links and reaches for the general resolver — so the trend's edge read is pinned by
 * SHAPE (one batched `rel:'revises'` in-edge call over every row), not merely permitted.
 * `listScorecards` stays supersession-blind on purpose: a superseded scorecard is still a
 * real, auditable filing and must keep appearing in listings; only the aggregate that would
 * double-count it excludes it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dbOrg from '@papercusp/db-org';
import * as issuesEngineer from './issues-engineer';
import * as rubrics from './rubrics';

/** One scorecard row as the engineer_issues SELECT returns it. */
const DB_ROWS = [
  {
    issue_id: 'EI-1',
    created_by: 'agent-a',
    created_at: '2026-08-01T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'healthy', evidence: 'e' } },
      },
    },
  },
  {
    issue_id: 'EI-2',
    created_by: 'agent-b',
    created_at: '2026-08-02T00:00:00.000Z',
    payload: {
      observation: {
        rubricRef: 'test-rubric',
        ratings: { alpha: { rating: 'degraded', evidence: 'e' } },
      },
    },
  },
];

/**
 * `sql` is used BOTH as the outer query tag and for inline fragments (sql`TRUE`), so the
 * mock discriminates on the template text: the real SELECT resolves rows, a fragment
 * returns an opaque marker.
 */
const scorecardQueries: string[] = [];
const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.reduce((query, part, index) => {
    const value = values[index - 1];
    const fragment = value && typeof value === 'object' && '__sqlFragment' in value
      ? String(value.__sqlFragment) : '?';
    return query + (index ? fragment : '') + part;
  }, '');
  if (text.includes('SELECT scorecard.issue_id, scorecard.created_by')) {
    scorecardQueries.push(text);
    return Promise.resolve(DB_ROWS.map(row => ({ ...row, payload: { observation: {
      ...row.payload.observation, rubricRevision: 1, criteriaHash: 'criteria-v1',
      gradingAudit: { state: 'passed', metaRubricRef: 'grading-integrity', stampedAt: row.created_at,
        rubricRevision: 1, criteriaHash: 'criteria-v1', auditor: 'independent-agent',
        auditedAt: row.created_at, auditIssueId: 'EI-independent-audit' },
    } } }))) as unknown as Promise<unknown[]>;
  }
  return { __sqlFragment: text } as unknown as Promise<unknown[]>;
};

// scorecards.ts runs the SELECT through boundedPgReadTxn. Keep this unit seam
// transaction-shaped: execute the callback against the same tagged client and
// absorb the transaction setup statements instead of leaving sql.begin as an
// empty mock (which makes the production read resolve to undefined).
const sqlMock = Object.assign(sqlTag, {
  begin: vi.fn(async <T>(transaction: (tx: unknown) => Promise<T>) => transaction(sqlMock)),
  unsafe: vi.fn(async () => []),
});

// Load the real graph before replacing these call-time seams. An async partial
// mock can wait for importOriginal while another module in that graph waits for
// the mock, leaving the first scorecards import pending until the test deadline.
// Spies preserve every unrelated export without recursively loading a mock factory.
vi.spyOn(dbOrg, 'getOrgPg').mockReturnValue({ sql: sqlMock } as unknown as ReturnType<typeof dbOrg.getOrgPg>);

const issuesOutLinksMany = vi.fn(
  async (_ids: readonly string[]): Promise<Map<string, issuesEngineer.IssueOutLink[]>> =>
    new Map([['EI-1', [{ rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } }]]]),
);

/** P-010: scorecardTrend's supersession check — a rel-filtered in-edge read, NOT the join. */
const issuesSupersededByRevision = vi.fn(async (_ids: readonly string[]) => new Set<string>());

vi.spyOn(issuesEngineer, 'issuesScopeWorkspace').mockReturnValue('test-workspace');
vi.spyOn(issuesEngineer, 'issuesOutLinksMany').mockImplementation(issuesOutLinksMany);
vi.spyOn(issuesEngineer, 'issuesSupersededByRevision').mockImplementation(issuesSupersededByRevision);

vi.spyOn(rubrics, 'getRubric').mockResolvedValue({
  rubricId: 'test-rubric', kind: 'standard', revision: 1,
  criteriaHash: 'criteria-v1', criteria: [{ key: 'alpha' }],
} as Awaited<ReturnType<typeof rubrics.getRubric>>);
vi.spyOn(rubrics, 'getRubricWithoutSeeding').mockImplementation(async (ref: string) => ({
  rubricId: ref, kind: 'standard', revision: 1,
  criteriaHash: 'criteria-v1', criteria: [{ key: 'alpha' }],
} as Awaited<ReturnType<typeof rubrics.getRubricWithoutSeeding>>));
vi.spyOn(rubrics, 'rubricInstrumentContract').mockReturnValue({
  valid: true, bindings: { alpha: null }, criteriaWithoutInstrument: [], duplicateInstrumentKeys: [],
});

beforeEach(() => {
  scorecardQueries.length = 0;
  issuesOutLinksMany.mockClear();
  issuesSupersededByRevision.mockClear();
});

describe('listScorecards — outbound links are OPT-IN (WI-6124)', () => {
  it('does NOT run the links query by default', async () => {
    const { listScorecards } = await import('./scorecards');
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100 });

    expect(issuesOutLinksMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
    // The field stays present and well-typed — absent links read as "none", never undefined.
    expect(rows.every((r) => Array.isArray(r.linkedItems) && r.linkedItems.length === 0)).toBe(true);
  });

  it('runs it exactly once, batched over every row, when includeLinks is true', async () => {
    const { listScorecards } = await import('./scorecards');
    const rows = await listScorecards({ rubricRef: 'test-rubric', limit: 100, includeLinks: true });

    // WI-3594's batching invariant: ONE call carrying all ids, never one per row.
    expect(issuesOutLinksMany).toHaveBeenCalledTimes(1);
    expect(issuesOutLinksMany).toHaveBeenCalledWith(['EI-1', 'EI-2']);

    expect(rows.find((r) => r.issueId === 'EI-1')?.linkedItems).toEqual([
      { rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } },
    ]);
    // A row with no edges still gets [] rather than undefined.
    expect(rows.find((r) => r.issueId === 'EI-2')?.linkedItems).toEqual([]);
  });

  it('explicit false is equivalent to the default', async () => {
    const { listScorecards } = await import('./scorecards');
    await listScorecards({ rubricRef: 'test-rubric', includeLinks: false });
    expect(issuesOutLinksMany).not.toHaveBeenCalled();
  });
});

describe('the aggregate readers stay cheap (WI-6124)', () => {
  it.each([undefined, false])('omits redundant superseder projection with includeSuperseded=%s', async (includeSuperseded) => {
    const { listScorecards } = await import('./scorecards');
    const rows = await listScorecards({ rubricRef: 'test-rubric', includeSuperseded });
    expect(rows).toHaveLength(2);
    expect(scorecardQueries).toHaveLength(1);
    const [projection, filters] = scorecardQueries[0].split('FROM harness_shared.engineer_issues AS scorecard');
    expect(projection).toContain('NULL::text AS superseded_by');
    expect(projection).not.toContain('SELECT relation.issue_id');
    expect(projection).not.toContain('explicit_superseder');
    expect(projection).not.toContain('spec_superseder');
    expect(filters).toContain('NOT EXISTS');
    expect(filters).toContain("superseder.payload -> 'observation' ->> 'supersedes' = scorecard.issue_id");
    expect(filters).toContain('NOT EXISTS (');
    expect(filters).toContain('spec_superseder');
    expect(rows.every(row => row.supersededBy === undefined)).toBe(true);
  });

  it('retains superseder projection when superseded cards are requested', async () => {
    const { listScorecards } = await import('./scorecards');
    await listScorecards({ rubricRef: 'test-rubric', includeSuperseded: true });
    expect(scorecardQueries).toHaveLength(1);
    const [projection, filters] = scorecardQueries[0].split('FROM harness_shared.engineer_issues AS scorecard');
    expect(projection).toContain('SELECT relation.issue_id');
    expect(projection).toContain('explicit_superseder');
    expect(projection).toContain('spec_superseder');
    expect(projection).not.toContain('NULL::text AS superseded_by');
    expect(filters).not.toContain('NOT EXISTS');
  });

  it('can project required card evidence without waiting for an unused generation probe', async () => {
    const { listScorecards } = await import('./scorecards');
    const observation = DB_ROWS[0].payload.observation as Record<string, unknown>;
    observation.gradedGeneration = { sha: 'abc1234', hostStartedAt: '2026-07-14T18:08:24.000Z' };
    const readBgHostActiveEnterMs = vi.fn(() => new Promise<number | null>(() => {}));
    try {
      const rows = await listScorecards({ rubricRef: 'test-rubric', includeGeneration: false,
        deps: { readBgHostActiveEnterMs } });

      expect(readBgHostActiveEnterMs).not.toHaveBeenCalled();
      expect(rows).toHaveLength(2);
      expect(rows[0].gradedGeneration?.hostStartedAt).toBe('2026-07-14T18:08:24.000Z');
      expect(rows[0].generationFreshness).toBeUndefined();
      // Rubric identity can be current while generation freshness is deliberately unmeasured.
      expect(rows[0].rubricCurrentness?.state).toBe('current');
      expect(rows[0].ratings.alpha.rating).toBe('healthy');
    } finally {
      delete observation.gradedGeneration;
    }
  });

  it('keeps live generation freshness enabled by default for stamped cards', async () => {
    const { listScorecards } = await import('./scorecards');
    const observation = DB_ROWS[0].payload.observation as Record<string, unknown>;
    observation.gradedGeneration = { sha: 'abc1234', hostStartedAt: '2026-07-14T18:08:24.000Z' };
    const readBgHostActiveEnterMs = vi.fn(async () => Date.parse('2026-07-15T18:08:24.000Z'));
    try {
      const rows = await listScorecards({ rubricRef: 'test-rubric', deps: { readBgHostActiveEnterMs } });

      expect(readBgHostActiveEnterMs).toHaveBeenCalledTimes(1);
      expect(rows[0].generationFreshness?.status).toBe('stale');
    } finally {
      delete observation.gradedGeneration;
    }
  });

  it('scorecardTrend rolls up ratings without ever resolving links', async () => {
    const { scorecardTrend } = await import('./scorecards');
    const trend = await scorecardTrend({ rubricRef: 'test-rubric' });

    // The regression this pins: scorecardTrend reads ONLY ratings + createdAt, but for a
    // long time paid a links join on every call for up to 500 refs.
    expect(issuesOutLinksMany).not.toHaveBeenCalled();
    expect(trend).toBeTruthy();
  });

  // P-010 gave scorecardTrend a REASON to read edges (dropping revision-superseded
  // scorecards), which is exactly the pressure that produced the WI-6124 regression in
  // the first place: a later feature arrives, needs one fact about links, and reaches
  // for the general resolver. So the guard above is no longer sufficient on its own —
  // "does not call the join" would also pass if the supersession read were itself
  // per-row. Pin the SHAPE of the read that is allowed to exist.
  it('scorecardTrend checks supersession with ONE batched rel-filtered read, not a per-row walk', async () => {
    const { scorecardTrend } = await import('./scorecards');
    await scorecardTrend({ rubricRef: 'test-rubric' });

    expect(issuesSupersededByRevision).toHaveBeenCalledTimes(1);
    expect(issuesSupersededByRevision).toHaveBeenCalledWith(['EI-1', 'EI-2']);
    expect(issuesOutLinksMany).not.toHaveBeenCalled(); // still never the join
  });

  it('listScorecards does NOT pay the supersession read — it is a trend-only cost', async () => {
    const { listScorecards } = await import('./scorecards');
    await listScorecards({ rubricRef: 'test-rubric', limit: 100 });

    // The read surface stays supersession-BLIND on purpose: a superseded scorecard is
    // still a real, auditable filing, so it must keep appearing in listings. Only the
    // aggregate that would double-count it excludes it.
    expect(issuesSupersededByRevision).not.toHaveBeenCalled();
  });
});

describe('the surfacing readers still opt IN (WI-6124 — guards the new default)', () => {
  it("the 'scorecards.list' sync-resolver resolves links (it feeds the ScorecardDetail panel)", async () => {
    const { getRegistryEntryV2 } = await import('./sync-resolver/index');
    const entry = getRegistryEntryV2('scorecards.list');
    expect(entry, "the 'scorecards.list' sync query must exist").toBeTruthy();

    // `resolve` takes exactly ONE argument (sync-resolver/index.ts: `resolve: (args: TArgs)`),
    // so the second `{} as any` this used to pass was silently discarded at runtime and only
    // ever served to red the typecheck.
    const rows = (await entry!.resolve!({ rubricRef: 'test-rubric', limit: 100 } as never)) as {
      linkedItems?: unknown[];
    }[];

    // If this fails, the UI panel silently shows no linked items — the exact cost of the
    // opt-in default, and invisible to types because the resolver returns `as unknown[]`.
    expect(issuesOutLinksMany).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => (r as { issueId?: string }).issueId === 'EI-1')?.linkedItems).toEqual([
      { rel: 'grades', dst: { kind: 'work_item', ref: 'WI-1' } },
    ]);
  });
});
