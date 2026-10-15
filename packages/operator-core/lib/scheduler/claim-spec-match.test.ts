/**
 * Regression coverage for WI-5272: the backlog-drain p2p/federation/rig title-glob
 * fence over-fired on unrelated subsystems whose title/file-path merely CONTAINS the
 * word "federation" (WI-5184/WI-5270 — a de-quarantine item naming
 * lib/memory/federation-slug-stamp.integration.test.ts). Two things are pinned here:
 *
 *  1. `claimSpecSubjectFromWorkItem` folds the singular `payload.filePath` (the
 *     testing:flakiness quarantine-family convention) into the plural `paths` array
 *     the spec DSL's `paths` field already reads — without this, a de-quarantine
 *     item carries NO structural (non-title) signal a spec filter can use.
 *  2. A hardened filter tree — the title-glob exclusion ANDed with a NOT of a
 *     known-safe path carve-out — correctly discriminates the false-positive class
 *     from a genuine p2p/federation/rig item, per WI-5272's stated acceptance:
 *     (a) a real p2p/federation/rig item stays fenced, (b) an unrelated item whose
 *     title/path merely mentions the word does NOT get excluded.
 */
import { describe, it, expect, vi } from 'vitest';
import type { WorkItem } from '../work-items';
import type { ClaimSpec, FilterLeaf, FilterNode } from './claim-spec';
import { positiveIdCohortIds, validateClaimSpec } from './claim-spec';
import { claimSpecSubjectFromWorkItem, matchesClaimSpecFilter, matchesWorkItemClaimSpec, planSlugOfWorkItem } from './claim-spec-match';

function issueItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return {
    kind: 'change',
    family: 'issue',
    harness: 'papercusp',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: 'minor',
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

// EI-25503081061868211: compilation cost must depend on filter predicates,
// rather than the size of the complete fleet-metric population.
describe('text predicates over complete census cohorts', () => {
  it('preserves whole-word and path admission beyond 2000 rows without recompiling per row', () => {
    const filter: FilterNode = { all: [
      { not: { field: 'title', op: 'word', value: 'p2p' } },
      { field: 'paths', op: 'glob', value: 'packages/operator-core/**' },
    ] };
    const rows = Array.from({ length: 2101 }, (_, index) => issueItem({
      id: `EI-census-${index}`,
      title: ['ordinary queue repair', 'nonp2p-bug-drain repair', 'P2P_transport repair'][index % 3],
      payload: { paths: ['unrelated/file.ts', 'packages/operator-core/lib/queue.ts'] },
    }));
    const NativeRegExp = globalThis.RegExp;
    const constructors = vi.spyOn(globalThis, 'RegExp').mockImplementation(function (pattern, flags) {
      return new NativeRegExp(pattern, flags);
    });
    try {
      const admitted = rows.filter(row => matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(row), filter));
      expect(admitted).toHaveLength(1401);
      expect(admitted.some(row => row.id === 'EI-census-2100')).toBe(true);
      expect(admitted.every(row => !row.title.startsWith('P2P_'))).toBe(true);
      expect(constructors).toHaveBeenCalledTimes(2);
    } finally {
      constructors.mockRestore();
    }
  });

  it('recompiles edited literals and operators, preserving scalar and array word boundaries', () => {
    const leaf: FilterLeaf = { field: 'title', op: 'word', value: 'p2p' };
    const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'EI-edit', title: 'nonp2p federation_soak' }));
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(false);
    leaf.value = 'federation';
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(true);
    leaf.op = 'glob';
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(false);
    leaf.value = '*federation*';
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(true);
    leaf.op = 'word';
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(false);
    leaf.field = 'paths';
    leaf.value = 'x+y';
    subject.paths = ['notx+y', 'x+y_file'];
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(true);
    subject.paths = ['notx+y', 'xxy_file'];
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(false);
    leaf.value = 'xxy';
    expect(matchesClaimSpecFilter(subject, leaf)).toBe(true);
  });

  it('scans a complete census once per field for a broad word fence', () => {
    const filter: FilterNode = { not: { any: ['p2p', 'replication', 'federation', 'relay', 'x+y']
      .map(value => ({ field: 'summary', op: 'word', value })) } };
    const rows = Array.from({ length: 2101 }, (_, index) => issueItem({
      id: `EI-word-group-${index}`, title: 'ordinary queue repair',
      summary: index === 2100 ? 'replication_soak fails' : 'nonp2p repair with unrelated text',
    }));
    const scans = vi.spyOn(RegExp.prototype, 'test');
    let admitted: WorkItem[];
    let scanCount: number;
    try {
      admitted = rows.filter(row => matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(row), filter));
      scanCount = scans.mock.calls.length;
    } finally {
      scans.mockRestore();
    }
    expect(admitted!).toHaveLength(2100);
    expect(admitted!.some(row => row.id === 'EI-word-group-2099')).toBe(true);
    expect(scanCount!).toBe(2101);
  });

  it('preserves independent-leaf verdicts for grouped words, nulls, arrays and nested booleans', () => {
    const words: FilterLeaf[] = ['p2p', 'federation', 'x+y', 'a', 'ab', '']
      .map(value => ({ field: 'summary', op: 'word', value }));
    const paths: FilterLeaf[] = ['replication', 'relay']
      .map(value => ({ field: 'paths', op: 'word', value }));
    const other: FilterNode = { all: [
      { field: 'title', op: 'contains', value: 'queue' },
      { not: { field: 'id', op: '=', value: 'EI-refused' } },
    ] };
    const children: FilterNode[] = [...words, other, ...paths];
    const corpus = [null, '', 'NONP2P repair', 'P2P_transport', 'federation/repair',
      'x+y_file', 'xxy_file', 'ab', 'a', 'no match', 'federationé'];
    for (const summary of corpus) for (const array of [[], ['relay_file'], ['nonrelay'], ['replication/queue']]) {
      const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'EI-refused', title: 'queue repair', summary: summary ?? undefined }));
      subject.paths = array;
      const independent = children.some(child => matchesClaimSpecFilter(subject, child));
      expect(matchesClaimSpecFilter(subject, { any: children }), JSON.stringify({ summary, array })).toBe(independent);
      expect(matchesClaimSpecFilter(subject, { not: { any: children } })).toBe(!independent);
    }
  });

  it('invalidates word groups when literals, fields, operators or the alternatives change', () => {
    const first: FilterLeaf = { field: 'summary', op: 'word', value: 'p2p' };
    const second: FilterLeaf = { field: 'summary', op: 'word', value: 'relay' };
    const filter: FilterNode = { any: [first, second] };
    const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'EI-group-edit', title: 'federation', summary: 'nonp2p' }));
    expect(matchesClaimSpecFilter(subject, filter)).toBe(false);
    first.value = 'nonp2p';
    expect(matchesClaimSpecFilter(subject, filter)).toBe(true);
    first.value = 'federation';
    first.field = 'title';
    expect(matchesClaimSpecFilter(subject, filter)).toBe(true);
    first.op = 'glob';
    first.value = '*p2p*';
    first.field = 'summary';
    expect(matchesClaimSpecFilter(subject, filter)).toBe(true);
    filter.any.splice(0, 1);
    expect(matchesClaimSpecFilter(subject, filter)).toBe(false);
    filter.any.push({ field: 'summary', op: 'word', value: 'nonp2p' });
    expect(matchesClaimSpecFilter(subject, filter)).toBe(true);
    filter.any[1] = { field: 'summary', op: 'word', value: 'replication' };
    expect(matchesClaimSpecFilter(subject, filter)).toBe(false);
  });
});

/** The live backlog-drain-clean title-glob terms (rev11), verbatim. */
const P2P_TITLE_GLOBS = ['*p2p*', '*P2P*', '*teering lease*', '*hared-hive*', '*federation*', '*Federation*', '*holepunch*'];

/** WI-5272's proposed durable replacement: exclude on the title glob UNLESS the
 *  item's `paths` positively show a known-safe, non-p2p directory (currently just
 *  the proven lib/memory/** false-positive case — extend as new classes surface). */
const HARDENED_FENCE: FilterNode = {
  not: {
    all: [
      { any: P2P_TITLE_GLOBS.map((value) => ({ field: 'title', op: 'glob', value }) as const) },
      // Leading `*` matters: globRegex anchors `^...$` with no implicit path-prefix
      // matching, and real paths.paths entries are repo-relative from the monorepo
      // root (e.g. `packages/operator-core/lib/memory/...`), not bare `lib/memory/...`.
      { not: { any: [{ field: 'paths', op: 'glob', value: '*lib/memory/**' }] } },
    ],
  },
};

// WI-5832 / EI-18666217180294576 follow-up — scheduled-recurring-plans (D-016) mint a
// plan-RUN item with `source_plan_slug` COLUMN = the STABLE template slug while
// `payload.plan_item.plan_slug` carries the run's own (different) slug. The SQL
// admission path (get-next.ts FIELD_MAP.plan) reads the column first and so resolves
// the template slug; this JS evaluator must agree, not fall through to the run slug.
describe('planSlugOfWorkItem — scheduled-recurring plan-run items (D-016) resolve the STABLE template slug, matching the SQL admission path', () => {
  it('prefers payload.plan_run.templateSlug over payload.plan_item.plan_slug when both are present and differ', () => {
    const item = issueItem({
      id: 'WI-9001',
      title: 'scheduled run item',
      payload: {
        plan_item: { plan_slug: 'nightly-sweep-2026-07-26', item_id: 'P-001' },
        plan_run: { runId: 42, templateSlug: 'nightly-sweep' },
      },
    });
    expect(planSlugOfWorkItem(item)).toBe('nightly-sweep');
  });

  it('falls through to payload.plan_item.plan_slug when there is no plan_run (the ordinary case, unaffected)', () => {
    const item = issueItem({
      id: 'WI-9002',
      title: 'ordinary plan item',
      payload: { plan_item: { plan_slug: 'agentic-docs-qa-2026-07-06', item_id: 'P-002' } },
    });
    expect(planSlugOfWorkItem(item)).toBe('agentic-docs-qa-2026-07-06');
  });
});

describe('claimSpecSubjectFromWorkItem folds payload.filePath into paths (WI-5272)', () => {
  it('surfaces the quarantine-family payload.filePath convention as a paths entry', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({
        id: 'WI-5270',
        title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake',
        payload: { filePath: 'packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts' },
      }),
    );
    expect(subject.paths).toEqual(['packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts']);
  });

  it('dedupes against an already-populated payload.paths instead of appending a duplicate', () => {
    const subject = claimSpecSubjectFromWorkItem(
      issueItem({
        id: 'WI-x',
        title: 'x',
        payload: { paths: ['a/b.ts'], filePath: 'a/b.ts' },
      }),
    );
    expect(subject.paths).toEqual(['a/b.ts']);
  });

  it('leaves paths empty when neither payload.paths nor payload.filePath is set (today\'s WI-5270 shape)', () => {
    const subject = claimSpecSubjectFromWorkItem(issueItem({ id: 'WI-5270', title: 'x', payload: {} }));
    expect(subject.paths).toEqual([]);
  });
});

describe('WI-5272 hardened p2p/federation/rig fence — false-positive vs real-leak', () => {
  it('still fences a genuine federation/p2p item that carries no path evidence (no WI-5265 regression)', () => {
    const item = issueItem({ id: 'EI-636', title: 'p2p-perf regression: merge.delta-tick deltaTick1000Ms worse' });
    expect(matchesWorkItemClaimSpec(item, {
      specVersion: '1.0',
      specId: 't',
      revision: 1,
      view: { filter: HARDENED_FENCE },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    })).toBe(false);
  });

  it('still fences a genuine federation item whose paths ARE under a p2p-domain directory', () => {
    const item = issueItem({
      id: 'WI-x',
      title: 'Harden federation swarm re-key handling',
      payload: { paths: ['packages/operator-core/lib/sync/hyperbee/swarm.ts'] },
    });
    expect(matchesClaimSpecFilter(claimSpecSubjectFromWorkItem(item), HARDENED_FENCE)).toBe(false);
  });

  it('admits the WI-5184/WI-5270 false-positive once filePath is folded into paths', () => {
    const item = issueItem({
      id: 'WI-5270',
      title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake (flipRate 0.625)',
      payload: { filePath: 'packages/operator-core/lib/memory/federation-slug-stamp.integration.test.ts' },
    });
    expect(matchesWorkItemClaimSpec(item, {
      specVersion: '1.0',
      specId: 't',
      revision: 1,
      view: { filter: HARDENED_FENCE },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    })).toBe(true);
  });

  it('WITHOUT the fold-in fix, the same item stays wrongly fenced (documents the bug the fix closes)', () => {
    // Simulate the pre-fix mapping by asserting directly against a subject built
    // from payload.paths alone (filePath ignored) — the shape claimSpecSubjectFromWorkItem
    // produced before this change.
    const preFixSubject = {
      id: 'WI-5270',
      title: 'De-quarantine follow-up: lib/memory/federation-slug-stamp.integration.test.ts flake',
      summary: null,
      kind: 'change',
      priority: null,
      tags: [],
      paths: [], // payload.filePath was NOT read pre-fix
      plan: null,
      planItem: [],
      fleet: null,
      triageGate: null,
      itemClass: 'work' as const,
      age: 0,
      riskTier: null,
      redundancy: null,
      estCost: null,
      assignee: null,
      severity: null,
      goal: null,
    };
    expect(matchesClaimSpecFilter(preFixSubject, HARDENED_FENCE)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EI-14231 — a `not:{id in [...]}` exclusion inside an otherwise wide-open drain
// spec must not starve the fleet. This is the exact `backlog-drain-clean@6` live
// incident (2026-07-17): a leader excluded two already-handled ids (WI-5245/WI-5246)
// via `{ not: { field:'id', op:'in', value:[...] } }`, and scheduler:get_next then
// returned ZERO on every call for 7+ hours while hundreds of open bug/change/task
// items sat unclaimed — because the OLD tier-3 gate (the since-removed
// filterHasIdConstraint) saw the `not`-wrapped id leaf, mis-read it as "the spec
// names an explicit id allowlist", and SKIPPED tier 3 (the only path that serves
// issue-family work) entirely. The durable fix has three legs:
//   1. positiveIdCohortIds returns null for a `not`-wrapped id leaf (a negation is
//      NOT a closed-world allowlist), so tier 3 now RUNS unrestricted-by-id
//      (claim-spec.ts; pinned in claim-spec.test.ts);
//   2. negativeIdExclusions threads the excluded ids into tier 3's SQL excludeIds
//      so the exclusion is HONORED (get-next.ts; the SQL leg pinned end-to-end in
//      get-next.integration.test.ts's "NOT-wrapped id EXCLUSION" case);
//   3. getNextForBee's mandatory post-claim `matchesWorkItemClaimSpec` re-check
//      against the FULL filter tree — the SQL narrowing only handles kind/id, so
//      this JS re-check is the safety net that guarantees a `not:{id in}` (and the
//      title-globs the SQL never narrows by) are actually applied before a claim
//      stands (a mismatch releases + retries).
//
// The integration test covers a MINIMAL shape (`all:[kind in [bug], not:{id in}]`).
// This unit block pins the FULL incident composition — the 4-kind list (feature
// included), several `not:{title glob}` fences, AND the `not:{id in}` exclusion all
// ANDed together — against leg 3's evaluator, WITHOUT Postgres: it (a) validates
// (the trap's signature is that it validates then mis-executes) and (b) admits a
// normal open bug while excluding both an excluded-id item and a p2p-titled one.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-14231 — a not:{id in [...]} exclusion in a wide drain spec never starves the lane', () => {
  const EXCLUDED_IDS = ['WI-5245', 'WI-5246'];
  /** The `backlog-drain-clean` fleet's live spec shape (rev 8): 4-kind drain, several
   *  title-glob fences, plus the two-id exclusion that triggered the incident. */
  const DRAIN_FILTER: FilterNode = {
    all: [
      { field: 'kind', op: 'in', value: ['bug', 'change', 'task', 'feature'] },
      { not: { field: 'title', op: 'glob', value: '*p2p*' } },
      { not: { field: 'title', op: 'glob', value: '*federation*' } },
      { not: { field: 'title', op: 'glob', value: '*hared-hive*' } },
      { not: { field: 'title', op: 'glob', value: '*holepunch*' } },
      { not: { field: 'id', op: 'in', value: EXCLUDED_IDS } },
    ],
  };
  const drainSpec: ClaimSpec = {
    specVersion: '1.0',
    specId: 'backlog-drain-clean',
    revision: 8,
    view: { filter: DRAIN_FILTER },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    // work-item-status-full-unify P-004/P-005 (migration 642) rewrote every stored
    // spec's `states` todo→open — 'todo' is no longer a valid claimable token
    // (CLAIM_STATES_ALLOWLIST = ['open', 'failing']); this fixture reflects the
    // spec as it is stored TODAY, not its pre-migration historical shape.
    states: ['open', 'failing'],
  };

  it('the incident spec VALIDATES (the trap is that it validates, then mis-executed)', () => {
    const v = validateClaimSpec(drainSpec);
    expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  });

  it('positiveIdCohortIds is null for the `not:{id in}` shape — so tier 3 runs unrestricted-by-id (the fix)', () => {
    // If this ever regressed to returning a non-null set, the ladder would land on the
    // "spec names an id allowlist" branch again and starve the whole issue lane.
    expect(positiveIdCohortIds(DRAIN_FILTER)).toBeNull();
  });

  it('ADMITS a normal open bug that is neither excluded nor p2p-titled (the item wrongly starved for 7h)', () => {
    const item = issueItem({ id: 'WI-5174', title: 'Fix dashboard pagination off-by-one', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, drainSpec)).toBe(true);
  });

  it('EXCLUDES an item whose id is in the not:{id in} set — the exclusion is honored, not ignored', () => {
    for (const id of EXCLUDED_IDS) {
      const item = issueItem({ id, title: 'GO-gate scratch item', kind: 'change' });
      expect(matchesWorkItemClaimSpec(item, drainSpec), `${id} must be excluded`).toBe(false);
    }
  });

  it('still EXCLUDES a p2p-titled item — the exclusion fix did not widen the title fences into no-ops', () => {
    const item = issueItem({ id: 'WI-9001', title: 'p2p offer-store publish leg', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, drainSpec)).toBe(false);
  });

  it('the evaluator and positiveIdCohortIds agree the lane is non-empty: a non-excluded issue is admissible', () => {
    // The whole point: the spec matches a healthy set of rows (here, one representative),
    // so a get_next miss under it would be a real bug, not "the queue is empty".
    const admissible = [
      issueItem({ id: 'WI-5174', title: 'Fix pagination', kind: 'bug' }),
      issueItem({ id: 'EI-8100', title: 'Tidy the scheduler diagnosis block', kind: 'change' }),
      issueItem({ id: 'WI-7000', title: 'Add a task-runner retry cap', kind: 'task' }),
    ].filter((it) => matchesWorkItemClaimSpec(it, drainSpec));
    expect(admissible.map((it) => it.id)).toEqual(['WI-5174', 'EI-8100', 'WI-7000']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// EI-18690730909662985 — `word` op: a whole-word title exclusion, fixing `glob`'s
// bare-substring false positive. Observed live: fleet "nonp2p-bug-drain-0725"'s
// `not:{ title, op:'glob', value:'*p2p*' }` exclusion refused a member's own
// self-claim of a meta-bug whose TITLE merely mentions the fleet's own name
// ("nonp2p-bug-drain..." contains the substring "p2p"), even though the item is
// precisely the OPPOSITE of P2P/federation work.
// ────────────────────────────────────────────────────────────────────────────
describe('EI-18690730909662985 — `word` op is a whole-word title match, not glob\'s bare substring', () => {
  const wordExcludeP2p: FilterNode = { not: { field: 'title', op: 'word', value: 'p2p' } };
  const globExcludeP2p: FilterNode = { not: { field: 'title', op: 'glob', value: '*p2p*' } };

  it('`word` does NOT exclude a title that merely CONTAINS "p2p" inside a larger word (the false-positive glob hits)', () => {
    // No standalone "p2p" word here — only nested inside "nonp2p" (the fleet's own name),
    // exactly the live collision: fleet "nonp2p-bug-drain-0725"'s title-glob exclusion
    // refused a member's self-claim of a meta-bug ABOUT that fleet.
    const item = issueItem({
      id: 'EI-18690730909662985',
      title: "Fleet nonp2p-bug-drain-0725's own claim-spec can't self-claim a meta-bug naming the fleet",
      kind: 'bug',
    });
    expect(matchesWorkItemClaimSpec(item, specOf(wordExcludeP2p))).toBe(true); // admitted
    expect(matchesWorkItemClaimSpec(item, specOf(globExcludeP2p))).toBe(false); // the bug: wrongly excluded
  });

  it('`word` DOES exclude a title that mentions "p2p" as its own word', () => {
    const item = issueItem({ id: 'WI-9002', title: 'p2p offer-store publish leg is flaky', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, specOf(wordExcludeP2p))).toBe(false);
  });

  it('`word` is case-insensitive, like `glob`', () => {
    const item = issueItem({ id: 'WI-9003', title: 'P2P handshake timeout', kind: 'bug' });
    expect(matchesWorkItemClaimSpec(item, specOf(wordExcludeP2p))).toBe(false);
  });

  it('`word` matches at a non-alnum boundary too (hyphen, slash) — not ONLY whitespace', () => {
    for (const title of ['fix the p2p-gateway retry', 'audit lib/p2p/handshake.ts', '(p2p) connection drop']) {
      const item = issueItem({ id: 'WI-9004', title, kind: 'bug' });
      expect(matchesWorkItemClaimSpec(item, specOf(wordExcludeP2p)), title).toBe(false);
    }
  });

  it('validateClaimSpec accepts the `word` op with a scalar value', () => {
    const v = validateClaimSpec(specOf(wordExcludeP2p));
    expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  });

  it('validateClaimSpec rejects `word` with an array value (it is a SCALAR op, same as glob/contains)', () => {
    const v = validateClaimSpec(specOf({ field: 'title', op: 'word', value: ['p2p', 'federation'] }));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('op "word"'))).toBe(true);
  });

  function specOf(filter: FilterNode): ClaimSpec {
    return {
      specVersion: '1.0',
      specId: 'word-op-test',
      revision: 1,
      view: { filter },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    };
  }
});
