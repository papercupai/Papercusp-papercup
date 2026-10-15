/**
 * claim-spec-delta.test.ts — agent-epistemics-2026-08-02 P-005.
 *
 * `scheduler:preview_spec_delta` answers "which items would this spec revision drop or pick
 * up". Two properties make that answer trustworthy, and both are invisible to a DB-backed
 * integration test against a quiescent table — which is exactly why they are pinned here:
 *
 *  1. ONE SNAPSHOT. Both sides must be observed in a single REPEATABLE READ transaction. Read
 *     separately, a peer's claim landing between them appears as a row present in the first
 *     read and absent from the second — indistinguishable from "your proposed spec excludes
 *     this item". A preview whose purpose is deciding whether to narrow a lane must not invent
 *     narrowing the FLEET caused. (This is the sibling of WI-5947, which was that same bug in
 *     work_items:claimable, where it produced `claimableCount:1, returned:0` and got an
 *     innocent claim path reported as broken.)
 *
 *  2. ONE FLOOR PASS. The ~13 claim floors do not depend on the filter — only `spec_match`
 *     does — so the population is materialized ONCE and decorated with two match columns.
 *     Materializing twice would be correct but double the cost of the expensive part, and the
 *     measured cost of one such pass against a real wide spec is ~6.2s (EI-18802055183255275),
 *     i.e. two would sit at the per-statement timeout. A regression here is a timeout, not a
 *     wrong answer, so nothing else would catch it.
 *
 * Plus the pure attribution + warning judgments, which are what a reader ACTS on.
 *
 * Run: cd packages/operator-core && npx vitest run lib/scheduler/claim-spec-delta.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  claimSpecDeltaCandidateFilter,
  readClaimSpecDelta,
  projectDeltaRow,
  type ClaimSpecDeltaReading,
  type ClaimSpecDeltaSqlRow,
} from './get-next';
import { deriveSpecDeltaNote, deriveSpecDeltaWarnings } from '../agent-tools/scheduler/preview_spec_delta';
import { DEFAULT_CLAIM_SPEC } from './claim-spec';

type Log = string[];

/** postgres-js-shaped fake (same shape as claimability-snapshot.test.ts): a tagged template
 *  and `.unsafe`/`.json`. Awaiting records the statement and yields no rows; INTERPOLATING a
 *  fragment records nothing — so the log is exactly the set of statements really executed. */
function makeHandle(log: Log, opts: { failAtQuery?: number } = {}) {
  let queries = 0;
  const handle = ((strings: TemplateStringsArray) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    return {
      then(resolve: (rows: unknown[]) => void, reject: (err: unknown) => void) {
        queries += 1;
        log.push(`QUERY:${text}`);
        if (opts.failAtQuery === queries) {
          reject(new Error('delta read failed'));
          return;
        }
        resolve([]);
      },
    };
  }) as unknown as Record<string, unknown> & ((s: TemplateStringsArray) => unknown);
  handle.unsafe = (text: string) => ({
    then(resolve: (rows: unknown[]) => void) {
      log.push(`EXEC:${text}`);
      resolve([]);
    },
  });
  handle.json = (v: unknown) => ({ __json: v });
  return handle;
}

function makePool(opts: { failAtQuery?: number } = {}) {
  const poolLog: Log = [];
  const txLog: Log = [];
  let beginCalls = 0;
  const pool = makeHandle(poolLog) as unknown as Record<string, unknown>;
  pool.begin = async (fn: (tx: unknown) => Promise<unknown>) => {
    beginCalls += 1;
    return fn(makeHandle(txLog, opts));
  };
  return {
    client: pool as never,
    poolLog,
    txLog,
    get beginCalls() {
      return beginCalls;
    },
    get queries() {
      return txLog.filter((l) => l.startsWith('QUERY:'));
    },
  };
}

const CURRENT = { filter: { field: 'kind', op: '=', value: 'bug' } } as const;
const PROPOSED = { filter: { field: 'kind', op: '=', value: 'change' } } as const;
const OPTS = { harness: 'papercup', assignee: 'probe' };
const READ = { limit: 25 };

describe('readClaimSpecDelta — both sides in ONE snapshot (P-005)', () => {
  it('opens exactly one transaction and issues every statement on it', async () => {
    const pool = makePool();
    await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: pool.client }, READ);
    expect(pool.beginCalls).toBe(1);
    // Nothing may leak onto a fresh pool checkout: a statement issued there observes its own
    // snapshot, which is the entire defect this transaction removes.
    expect(pool.poolLog).toEqual([]);
    expect(pool.txLog.length).toBeGreaterThan(0);
  });

  it('sets REPEATABLE READ before the first data statement', async () => {
    const pool = makePool();
    await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: pool.client }, READ);
    // PG rejects SET TRANSACTION once a query has run — and rejects it SILENTLY as far as the
    // caller is concerned, leaving the reads on READ COMMITTED. Order is the whole guarantee.
    const firstQuery = pool.txLog.findIndex((l) => l.startsWith('QUERY:'));
    const isolation = pool.txLog.findIndex((l) => l.includes('REPEATABLE READ'));
    expect(isolation).toBeGreaterThanOrEqual(0);
    expect(isolation).toBeLessThan(firstQuery);
    expect(pool.txLog.some((l) => l.startsWith('EXEC:SET LOCAL statement_timeout'))).toBe(true);
  });

  it('materializes the floor population ONCE, not once per side', async () => {
    const pool = makePool();
    await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: pool.client }, READ);
    const creates = pool.queries.filter((q) => q.includes('CREATE TEMP TABLE'));
    expect(creates).toHaveLength(1);
    // ON COMMIT DROP: a pooled connection must not carry the snapshot into its next checkout.
    expect(creates[0]).toContain('ON COMMIT DROP');
  });

  it('excludes the observation lane from the snapshot it materializes (EI-23748103923712230)', async () => {
    const pool = makePool();
    await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: pool.client }, READ);
    const create = pool.queries.find((q) => q.includes('CREATE TEMP TABLE'))!;
    // The snapshot projects `SELECT c.*` — every base column, including the full payload jsonb —
    // so its ROW COUNT is what decides whether it fits in the 8MB `temp_buffers` default. A
    // WIDENING revision makes `candidateMatch` a broad union over the whole corpus, and without
    // this floor the materialization exhausts local buffers: PG raises its own
    // `no empty local buffer available` and the preview dies. Measured on the live papercusp
    // lane — both sides narrow succeeds, flipping ONLY the proposed filter broad fails, and a
    // narrow call on the SAME backend straight after still succeeds (input-size-driven).
    //
    // Assert the WHERE STRUCTURE, not merely that the text mentions the column: the structural
    // form is what pins the floor as ANDed onto the union predicate. (The rationale lives in a
    // JS comment above the statement rather than a SQL one on purpose — a backtick inside the
    // template literal terminates it, and the SQL comment would also land in this log.)
    expect(create).toMatch(/WHERE\s+\(\?\)\s+AND\s+c\.ok_observation/);
    // WI-10007576 follow-up: EVERY claim floor is ANDed onto the snapshot too (the trailing
    // `(?)` is the ALL_ISSUE_CLAIM_FLOORS_PASS fragment). Once an unfiltered side makes the
    // union unbounded, materializing floor-failing rows (~9.7k of ~10k on the live lane) both
    // overflowed temp_buffers and blew the 15s statement timeout; no count can see them.
    expect(create).toMatch(/WHERE\s+\(\?\)\s+AND\s+c\.ok_observation\s+AND\s+\(\?\)\s*$/);
    // It must be ANDed with the union, never replace it. Restricting the candidate population
    // to one side is the EI-20414245235902773 regression: proposed-only rows then never reach
    // the `proposed_match` projection and a widening revision reports 0 newly admitted.
    expect(create).toContain('FROM (?) c');
  });

  it('reads counts and BOTH row lists off that one materialization', async () => {
    const pool = makePool();
    await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: pool.client }, READ);
    // 1 CREATE + counts + excluded rows + admitted rows.
    expect(pool.queries).toHaveLength(4);
    const [, counts, excluded, admitted] = pool.queries;
    expect(counts).toContain('FILTER (WHERE in_current AND NOT in_proposed)');
    expect(counts).toContain('FILTER (WHERE in_proposed AND NOT in_current)');
    expect(excluded).toContain('WHERE in_current AND NOT in_proposed');
    expect(admitted).toContain('WHERE in_proposed AND NOT in_current');
  });

  it('THROWS on a failed read rather than reporting a zero delta', async () => {
    // A synthesised "no change" is the single most dangerous degraded answer this tool could
    // give: it waves through exactly the starving revision it exists to catch.
    await expect(
      readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: makePool({ failAtQuery: 2 }).client }, READ),
    ).rejects.toThrow(/delta read failed/);
  });

  it('reports an empty reading as all-zero rather than undefined', async () => {
    const reading = await readClaimSpecDelta(CURRENT, PROPOSED, { ...OPTS, client: makePool().client }, READ);
    expect(reading).toMatchObject({
      currentClaimable: 0,
      proposedClaimable: 0,
      retained: 0,
      newlyExcludedCount: 0,
      newlyAdmittedCount: 0,
      newlyExcluded: [],
      newlyAdmitted: [],
      truncated: { newlyExcluded: false, newlyAdmitted: false },
    });
  });

  it('scopes the candidate population to the UNION of both sides\' states', async () => {
    // A revision that changes ONLY `states` must be a first-class delta. Materializing under
    // one side's states alone would make the other side's rows structurally invisible and
    // report "no change" for the single most common starvation cause.
    const pool = makePool();
    await readClaimSpecDelta(
      { ...CURRENT, states: ['open'] },
      { ...PROPOSED, states: ['failing'] },
      { ...OPTS, client: pool.client },
      READ,
    );
    const create = pool.queries.find((q) => q.includes('CREATE TEMP TABLE'));
    expect(create).toBeDefined();
    // Per-side membership is then tested inside the derived projection, not in the WHERE.
    const counts = pool.queries[1];
    expect(counts).toContain('in_current');
    expect(counts).toContain('in_proposed');
  });

  it('orders each side by its OWN spec, so the head of each list is what get_next would serve first', async () => {
    const pool = makePool();
    await readClaimSpecDelta(
      { ...CURRENT, spec: DEFAULT_CLAIM_SPEC },
      { ...PROPOSED, spec: DEFAULT_CLAIM_SPEC },
      { ...OPTS, client: pool.client },
      READ,
    );
    const [, , excluded, admitted] = pool.queries;
    expect(excluded).toContain('ORDER BY');
    expect(admitted).toContain('ORDER BY');
  });
});

describe('claimSpecDeltaCandidateFilter — the snapshot must hold BOTH sides (WI-10007576)', () => {
  const BUG = { field: 'kind', op: '=', value: 'bug' } as const;
  const CHANGE = { field: 'kind', op: '=', value: 'change' } as const;

  it('leaves the population unbounded when the CURRENT lane is unfiltered (narrowing preview)', () => {
    // The live failure: default lane vs `kind = bug` read 423/423 and newlyExcluded 0,
    // because the snapshot held only bug rows. An unfiltered side matches everything.
    expect(claimSpecDeltaCandidateFilter(undefined, BUG)).toBeUndefined();
  });

  it('leaves the population unbounded when the PROPOSED lane is unfiltered (widening preview)', () => {
    expect(claimSpecDeltaCandidateFilter(BUG, undefined)).toBeUndefined();
  });

  it('unions two filtered sides so proposed-only rows still reach the snapshot', () => {
    expect(claimSpecDeltaCandidateFilter(BUG, CHANGE)).toEqual({ any: [BUG, CHANGE] });
  });

  it('never narrows the population to either side alone', () => {
    for (const [c, p] of [[undefined, BUG], [BUG, undefined], [BUG, CHANGE]] as const) {
      const bound = claimSpecDeltaCandidateFilter(c, p);
      expect(bound).not.toEqual(c ?? p);
    }
  });
});

describe('projectDeltaRow — attributing a moved row to filter vs states', () => {
  const base: ClaimSpecDeltaSqlRow = {
    delta_id: 'WI-1',
    delta_kind: 'bug',
    title: 't',
    status: 'open',
    delta_origin: null,
    delta_severity: 'major',
    delta_plan: null,
    feature_order: '3',
    created_ts: '1700000000000',
    spec_match: true,
    proposed_match: true,
    status_in_current: true,
    status_in_proposed: true,
  };

  it('blames the filter when only the filter disagrees', () => {
    expect(projectDeltaRow({ ...base, proposed_match: false }, 'excluded').cause).toBe('filter');
    expect(projectDeltaRow({ ...base, spec_match: false }, 'admitted').cause).toBe('filter');
  });

  it('blames states when only the claimable-status floor moved', () => {
    expect(projectDeltaRow({ ...base, status_in_proposed: false }, 'excluded').cause).toBe('states');
    expect(projectDeltaRow({ ...base, status_in_current: false }, 'admitted').cause).toBe('states');
  });

  it('reports both when the revision changed both dimensions', () => {
    expect(
      projectDeltaRow({ ...base, proposed_match: false, status_in_proposed: false }, 'excluded').cause,
    ).toBe('both');
  });

  it('normalizes the numeric ordering keys postgres returns as strings', () => {
    // feature_order/created_ts arrive as strings from postgres-js; a caller sorting or
    // comparing them as-is gets lexical order, which is the documented severity/risk_tier
    // footgun in a different costume.
    const row = projectDeltaRow({ ...base, proposed_match: false }, 'excluded');
    expect(row.featureOrder).toBe(3);
    expect(row.createdTs).toBe(1700000000000);
    expect(projectDeltaRow({ ...base, proposed_match: false, feature_order: null, created_ts: null }, 'excluded'))
      .toMatchObject({ featureOrder: null, createdTs: null });
  });
});

describe('deriveSpecDeltaWarnings — the judgments a leader must not miss', () => {
  const reading = (over: Partial<Parameters<typeof deriveSpecDeltaWarnings>[0]>) =>
    ({
      currentClaimable: 100,
      proposedClaimable: 100,
      retained: 100,
      newlyExcludedCount: 0,
      newlyAdmittedCount: 0,
      newlyExcluded: [],
      newlyAdmitted: [],
      truncated: { newlyExcluded: false, newlyAdmitted: false },
      ...over,
    }) as Parameters<typeof deriveSpecDeltaWarnings>[0];

  it('is silent on a no-op revision', () => {
    expect(deriveSpecDeltaWarnings(reading({}))).toEqual([]);
  });

  it('shouts STARVATION when the proposal empties a nonempty lane', () => {
    const w = deriveSpecDeltaWarnings(reading({ proposedClaimable: 0, newlyExcludedCount: 100 }));
    expect(w.join(' ')).toMatch(/STARVATION/);
  });

  it('does NOT cry starvation when the lane was already empty', () => {
    // Nothing was lost — the spec is not the reason the lane is empty, and a false alarm here
    // trains the reader to skip the warning that matters.
    expect(deriveSpecDeltaWarnings(reading({ currentClaimable: 0, proposedClaimable: 0 }))).toEqual([]);
  });

  it('flags a collapse short of zero exactly once (never alongside STARVATION)', () => {
    const w = deriveSpecDeltaWarnings(reading({ proposedClaimable: 10, newlyExcludedCount: 90 }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/COLLAPSE/);
    expect(w[0]).toMatch(/90%/);
  });

  it('does not flag a modest narrowing', () => {
    expect(deriveSpecDeltaWarnings(reading({ proposedClaimable: 80, newlyExcludedCount: 20 }))).toEqual([]);
  });

  it('names the issue-family states trap when every drop is a states drop', () => {
    const row = { cause: 'states' as const } as never;
    const w = deriveSpecDeltaWarnings(
      reading({ proposedClaimable: 99, newlyExcludedCount: 1, newlyExcluded: [row] }),
    );
    expect(w.join(' ')).toMatch(/never 'todo'/);
  });

  it('stays silent about the states trap when the row list was truncated', () => {
    // The claim is "EVERY drop is a states drop" — a capped list cannot support it, and
    // overclaiming from a sample is the failure mode this whole plan is about.
    const row = { cause: 'states' as const } as never;
    const w = deriveSpecDeltaWarnings(
      reading({
        proposedClaimable: 99,
        newlyExcludedCount: 500,
        newlyExcluded: [row],
        truncated: { newlyExcluded: true, newlyAdmitted: false },
      }),
    );
    expect(w.join(' ')).not.toMatch(/never 'todo'/);
  });
});

describe('deriveSpecDeltaNote — never hide a count/list contradiction', () => {
  const baseReading = (): ClaimSpecDeltaReading => ({
    currentClaimable: 1,
    proposedClaimable: 1,
    retained: 1,
    newlyExcludedCount: 0,
    newlyAdmittedCount: 0,
    newlyExcluded: [],
    newlyAdmitted: [],
    truncated: { newlyExcluded: false, newlyAdmitted: false },
  });

  it('does not say NO CHANGE when the exact totals show net +1 but the lists are empty', () => {
    const note = deriveSpecDeltaNote({ ...baseReading(), proposedClaimable: 2 });

    expect(note).not.toContain('NO CHANGE');
    expect(note).toContain('INCONSISTENT DELTA');
    expect(note).toContain('net +1');
    expect(note).toContain('could not be fully enumerated');
  });

  it('keeps the no-op wording for a coherent zero delta', () => {
    expect(deriveSpecDeltaNote(baseReading())).toContain('NO CHANGE');
  });

  it('does not call an empty 0/0 snapshot equivalent for future work', () => {
    const note = deriveSpecDeltaNote({
      ...baseReading(),
      currentClaimable: 0,
      proposedClaimable: 0,
      retained: 0,
    });

    expect(note).not.toContain('NO CHANGE');
    expect(note).toContain('UNDETERMINED');
    expect(note).toContain('future work');
  });
});
