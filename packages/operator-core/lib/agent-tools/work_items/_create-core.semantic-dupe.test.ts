/**
 * _create-core.semantic-dupe.test — the P-008 prescreen's wire-in contract on
 * createOneWorkItem: a hard cosine match refuses with `duplicate_semantic` +
 * the matched OPEN items; force:true skips the prescreen entirely; a soft
 * match creates WITH the `similarOpen` advisory; a null verdict (guard
 * fail-open) creates cleanly with no advisory key. The guard itself is
 * mocked — its internals are covered by semantic-dupe-guard.test.ts. The
 * EI-9940 recent-lexical-dupe-guard sibling check is likewise mocked here
 * (fail-open by default) — its own wire-in + merge-with-similarOpen contract
 * is covered by _create-core.recent-dupe.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P-002 item d: a SUCCESSFUL create persists its candidates instead of returning
 *  them, so the wire-in is observed at the substrate seam. */
const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));

const occurrenceMocks = vi.hoisted(() => ({
  record: vi.fn(async () => null),
  readPressure: vi.fn(async (): Promise<
    import('../../issue-occurrence-ledger').IssueAdmissionPressure | null
  > => null),
}));

const sqlMocks = vi.hoisted(() => ({
  query: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as Array<{ feature_id: string }>),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => false) }));
vi.mock('../../work-items', () => ({
  createWorkItem: vi.fn(async (input: { kind: string; title: string }) => ({
    id: 'WI-NEW',
    kind: input.kind,
    title: input.title,
  })),
  getWorkItem: vi.fn(async () => null),
  linkWorkItem: vi.fn(async () => {}),
  isWorkItemKind: (k: string) => ['feature', 'chunk', 'bug', 'change', 'task'].includes(k),
  isDeprecatedWorkItemKind: (k: string) => k === 'chunk',
  familyOf: (k: string) => (['bug', 'change', 'task'].includes(k) ? 'issue' : 'feature'),
  ensureClaimHoldAttribution: (payload: unknown) => payload,
}));
vi.mock('./mirror-guard', () => ({ findMirroredOpenItem: vi.fn(async () => null) }));
vi.mock('../_pot-scope', () => ({
  resolvePotScope: vi.fn(async () => ({ kind: 'pot', slug: 'papercusp' })),
  POT_REQUIRED_DETAIL: 'hive required',
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlMocks.query }),
}));
vi.mock('../../datatype-registry-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../datatype-registry-store')>()),
  getGenericKindDatatype: vi.fn(async () => null),
  getDatatype: vi.fn(async () => null),
}));
vi.mock('../../datatype-payload-validation', () => ({ validateDatatypePayload: () => ({ ok: true as const }) }));
vi.mock('../../routing-gate-hints', () => ({ matchRoutingGateHint: () => null }));
vi.mock('../../issue-blocks-merge', () => ({ planItemRef: (s: string, i: string) => `${s}#${i}`, PLAN_ITEM_KIND: 'plan_item' }));
vi.mock('./semantic-dupe-guard', () => ({ findSemanticDupes: vi.fn(async () => null) }));
vi.mock('./recent-lexical-dupe-guard', () => ({ findRecentLexicalDupes: vi.fn(async () => null) }));
vi.mock('./fulltext-lexical-dupe-guard', () => ({ findFulltextLexicalDupes: vi.fn(async () => null) }));
vi.mock('../../issue-occurrence-ledger', async () => {
  const actual = await vi.importActual<typeof import('../../issue-occurrence-ledger')>(
    '../../issue-occurrence-ledger',
  );
  return {
    ...actual,
    recordIssueOccurrence: occurrenceMocks.record,
    readIssueAdmissionPressure: occurrenceMocks.readPressure,
  };
});

// EI-21872682653374832 — createOneWorkItem stamps goal provenance (_create-core.ts:1198).
// Unmocked, resolveGoalContext reaches the real authority read, which fails CLOSED with
// `goal_holder_authority_unreadable` (goal-context.ts:54) because no fixture can supply that
// authority. The stamp's catch console.warns by design (EI-20075667133396690) and
// vitest-fail-on-console turns that warn into a failure BEFORE these tests reach their own
// assertions. null is the honest fixture answer: this agent runs under no goal, which is the
// majority production path. Do NOT silence the production warn instead — the warn is the feature.
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
}));

import { createOneWorkItem } from './_create-core';
import { findSemanticDupes, type SemanticDupeResult } from './semantic-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import { createWorkItem, getWorkItem } from '../../work-items';
import { assessIssueAdmissionPressure } from '../../issue-occurrence-ledger';

const guardM = vi.mocked(findSemanticDupes);
const fulltextM = vi.mocked(findFulltextLexicalDupes);
const createM = vi.mocked(createWorkItem);
const getM = vi.mocked(getWorkItem);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const verdict = (hard: number[], soft: number[]): SemanticDupeResult => ({
  hard: hard.map((s, i) => ({ id: `EI-${i + 1}`, title: `open dupe ${i + 1}`, state: 'open', harness: 'papercusp', similarity: s })),
  soft: soft.map((s, i) => ({ id: `WI-${i + 10}`, title: `near ${i}`, state: 'todo', harness: 'papercusp', similarity: s })),
  thresholds: { hard: 0.93, soft: 0.85 },
});

const exactIdentityCandidate = {
  id: 'EI-9',
  title: 'Agents file duplicate drain blockers',
  state: 'open',
  harness: 'papercusp',
  similarity: 1,
  source: 'lexical-fulltext' as const,
};

const repairedItem = {
  id: 'EI-9',
  kind: 'bug',
  family: 'issue',
  harness: 'papercusp',
  title: exactIdentityCandidate.title,
  summary: 'repaired',
  state: 'open',
} as unknown as NonNullable<Awaited<ReturnType<typeof getWorkItem>>>;

beforeEach(() => {
  guardM.mockReset();
  guardM.mockResolvedValue(null);
  fulltextM.mockReset();
  fulltextM.mockResolvedValue([]);
  createM.mockClear();
  getM.mockReset();
  getM.mockResolvedValue(null);
  sqlMocks.query.mockReset();
  sqlMocks.query.mockResolvedValue([]);
  dedupEdgeMocks.persist.mockClear();
  occurrenceMocks.record.mockClear();
  occurrenceMocks.readPressure.mockReset();
  occurrenceMocks.readPressure.mockResolvedValue(null);
});

describe('createOneWorkItem × semantic dupe prescreen (P-008)', () => {
  it('P-002: a hard match CREATES with the semantic-hard stamp (duplicate_semantic veto retired, D-001)', async () => {
    guardM.mockResolvedValue(verdict([0.96], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 'agents keep filing the same bug' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCandidates: [expect.objectContaining({ id: 'EI-1', method: 'semantic-hard' })],
        }),
      }),
    );
    // The 'duplicate' occurrence append is retired with the refusal — the created
    // row is the record the central resolver reads.
    expect(occurrenceMocks.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ reportKind: 'duplicate' }),
    );
  });

  it('force:true skips the prescreen entirely (mirrors the EI-316 override contract)', async () => {
    guardM.mockResolvedValue(verdict([0.99], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(guardM).not.toHaveBeenCalled();
  });

  it('soft match creates and PERSISTS the candidates — the filing agent gets a count, not a to-do list', async () => {
    guardM.mockResolvedValue(verdict([], [0.88, 0.86]));
    const r = await createOneWorkItem({ kind: 'bug', title: 't', summary: 's' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.workItem.id).toBe('WI-NEW');
    expect(createM).toHaveBeenCalledWith(expect.objectContaining({ admission: 'pending', admittedBy: null }));
    // P-002 item d: the soft band no longer comes back as an advisory the caller
    // must triage — it goes to the promoter's substrate.
    expect('similarOpen' in r).toBe(false);
    expect(dedupEdgeMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'WI-NEW',
        harness: 'papercusp',
        workspaceId: 'default',
        candidates: [expect.objectContaining({ id: 'WI-10' }), expect.objectContaining({ id: 'WI-11' })],
      }),
    );
    expect(r.dedupEdges).toBe(2);
    // The guard saw the item's own harness fallback (args.harness ?? ctx.harnessSlug).
    expect(guardM).toHaveBeenCalledWith({ title: 't', summary: 's', harness: 'papercusp' });
  });

  it('P-005 coalesces a soft candidate under concentrated pressure without creating a row', async () => {
    guardM.mockResolvedValue(verdict([], [0.91]));
    occurrenceMocks.readPressure.mockResolvedValue(assessIssueAdmissionPressure({
      rawOccurrences: 455,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
      emitterCounts: [430, 5, 5, 5, 5, 5],
    }));

    const r = await createOneWorkItem({ kind: 'bug', title: 't', summary: 'burst report' }, ctx);
    expect(r).toMatchObject({
      ok: false,
      error: 'coalesced',
      existing: { id: 'WI-10' },
      queueAdmission: { active: true, rawOccurrences: 455, canonicalStock: 2_494 },
    });
    expect(createM).not.toHaveBeenCalled();
    expect(occurrenceMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'WI-10',
        reportKind: 'coalesced',
        evidence: expect.objectContaining({
          queueAdmission: expect.objectContaining({ active: true, rawOccurrences: 455 }),
        }),
      }),
    );
  });

  it('P-005 always passes a critical finding without reading burst pressure', async () => {
    guardM.mockResolvedValue(verdict([], [0.91]));
    const r = await createOneWorkItem({ kind: 'bug', title: 'critical novelty', severity: 'critical' }, ctx);
    expect(r.ok).toBe(true);
    expect(occurrenceMocks.readPressure).not.toHaveBeenCalled();
    expect(createM).toHaveBeenCalledOnce();
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ admission: 'auto', admittedBy: 'bypass:severity-critical' }),
    );
  });

  it('security-topic findings bypass pending with an attributable admission reason', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 'credential disclosure', topics: ['security'] }, ctx);
    expect(r.ok).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({ admission: 'auto', admittedBy: 'bypass:topic-security' }),
    );
  });

  it('preserves an explicit-assignment bypass after the handler parks the requested claim', async () => {
    const r = await createOneWorkItem({
      kind: 'task',
      title: 'fleet-scope downgrade remains admissible',
      admissionBypass: 'bypass:explicit-assignment',
      payload: { _claimHold: true, claim_hold_release: {
        condition: 'fleet scope permits pickup', owner: 'fleet-leader', trigger: 'work-item:unblocked:WI-NEW',
        reachability: 'blocked', evidence: 'requested claim is outside current fleet scope',
      } },
    }, ctx);
    expect(r.ok).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        assignee: undefined,
        admission: 'auto',
        admittedBy: 'bypass:explicit-assignment',
        payload: expect.objectContaining({ _claimHold: true }),
      }),
    );
  });

  it('refuses raw untracked parks before creation and preserves lease-only creation', async () => {
    const refused = await createOneWorkItem({ kind: 'task', title: 'untracked park', payload: { _claimHold: true } }, ctx);
    expect(refused.ok).toBe(false);
    expect(createM).not.toHaveBeenCalled();
    const lease = await createOneWorkItem({ kind: 'task', title: 'independent lease', payload: { _claimHold: true, held_open_by: 'reviewer' } }, ctx);
    expect(lease.ok).toBe(true);
    expect(createM).toHaveBeenCalledOnce();
  });

  it('null verdict (guard fail-open) creates cleanly with no advisory key', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 't', summary: 'fresh evidence' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
    expect(occurrenceMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'WI-NEW',
        reporter: 'me',
        sourceTool: 'work_items:create',
        reportKind: 'canonical-created',
        reportedTitle: 't',
        evidence: expect.objectContaining({ summary: 'fresh evidence' }),
      }),
    );
  });

  it('persists stable identity + achieved coverage on issue admission', async () => {
    guardM.mockResolvedValue(verdict([], []));
    const r = await createOneWorkItem({ kind: 'bug', title: 'Duplicate drain blockers file agents' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.admissionIdentity).toEqual({
      schemaVersion: 'admission-identity-v1',
      titleKey: 'title:agents blockers drain duplicate file',
    });
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          admissionIdentity: r.admissionIdentity,
          dedupCoverage: r.dedupCoverage,
        }),
      }),
    );
  });

  it('P-002: DRAIN bug with unavailable semantic coverage now FILES, degradation stamped (veto retired)', async () => {
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'direct drain blocker', force: true, requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'unavailable', degraded: true });
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCoverage: { lexical: 'ok', semantic: 'unavailable', degraded: true },
        }),
      }),
    );
  });

  // WI-39824 → P-002 (silent-intake-central-resolution-2026-09-01, D-001): the
  // match veto this block used to calibrate is retired outright — every filing is
  // accepted, hard hits are stamped 'semantic-hard' for the central resolver, and
  // DRAIN's surviving contract is MEASUREMENT (the probe runs and its verdict is
  // recorded on the row). The tests below pin that: filing succeeds with and
  // without force, and the stamp survives both paths — without the stamp
  // assertions they would also pass when the prescreen is broken outright.
  it('DRAIN + healthy probe + hard match + force:true → FILES the item (force is the distinctness escape)', async () => {
    guardM.mockResolvedValue(verdict([0.94], []));
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'a genuinely distinct drain finding', force: true, requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    // The probe still RAN and its verdict is still recorded — force suppresses the
    // veto, never the measurement. This is what keeps DRAIN's coverage contract real.
    expect(r.dedupCoverage).toEqual({ lexical: 'ok', semantic: 'ok', degraded: false });
    expect(createM).toHaveBeenCalled();
  });

  it('CONTROL (P-002): DRAIN + healthy probe + hard match + NO force → files with the semantic-hard stamp', async () => {
    guardM.mockResolvedValue(verdict([0.94], []));
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'a reworded drain duplicate', requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCandidates: [expect.objectContaining({ id: 'EI-1', method: 'semantic-hard' })],
        }),
      }),
    );
  });

  it('CONTROL (P-001/P-002): force + DRAIN + hard match still stamps semantic-hard — force suppresses no measurement', async () => {
    guardM.mockResolvedValue(verdict([0.94], []));
    const forced = await createOneWorkItem(
      { kind: 'bug', title: 'a reworded drain duplicate', force: true, requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(forced.ok).toBe(true);
    expect(createM).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          dedupCandidates: [expect.objectContaining({ id: 'EI-1', method: 'semantic-hard' })],
        }),
      }),
    );
  });

  it('rejects an exact normalized identity match in DRAIN even when coverage is healthy', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([
      {
        id: 'EI-9',
        title: 'Agents file duplicate drain blockers',
        state: 'open',
        harness: 'papercusp',
        similarity: 1,
        source: 'lexical-fulltext',
      },
    ]);
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'Duplicate blockers drain agents file', requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, error: 'duplicate_identity', existing: { id: 'EI-9' } });
    expect(createM).not.toHaveBeenCalled();
  });

  it('rejects an exact normalized identity outside DRAIN and preserves the repeat as an occurrence', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([
      {
        id: 'EI-9',
        title: 'Agents file duplicate drain blockers',
        state: 'open',
        harness: 'papercusp',
        similarity: 1,
        source: 'lexical-fulltext',
      },
    ]);

    const r = await createOneWorkItem(
      { kind: 'bug', title: 'Duplicate blockers drain agents file' },
      ctx,
    );

    expect(r).toMatchObject({
      ok: false,
      error: 'duplicate_identity',
      existing: { id: 'EI-9' },
      message: expect.stringContaining('force:true'),
    });
    expect(createM).not.toHaveBeenCalled();
    expect(occurrenceMocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: 'EI-9',
        canonicalHarness: 'papercusp',
        reporter: 'me',
        sourceTool: 'work_items:create',
        reportKind: 'duplicate',
        reportedTitle: 'Duplicate blockers drain agents file',
      }),
    );
  });

  it('repairs a pending exact duplicate and atomically assigns a fresh explicit target', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([exactIdentityCandidate]);
    sqlMocks.query.mockResolvedValue([{ feature_id: 'EI-9' }]);
    getM.mockResolvedValue(repairedItem);

    const r = await createOneWorkItem(
      { kind: 'bug', title: 'Duplicate blockers drain agents file', assign_to: 'bee-7' },
      ctx,
    );

    expect(r).toMatchObject({ ok: true, workItem: { id: 'EI-9' } });
    expect(createM).not.toHaveBeenCalled();
    expect(sqlMocks.query).toHaveBeenCalledOnce();
    const statement = [...sqlMocks.query.mock.calls[0][0]].join(' ');
    expect(statement).toContain("admission = 'pending'");
    expect(statement).toContain('taken_by =');
    expect(statement).toContain("assigned_by");
  });

  it('repairs a server-stamped fleet-scope refile without granting its refused assignment', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([exactIdentityCandidate]);
    sqlMocks.query.mockResolvedValue([{ feature_id: 'EI-9' }]);
    getM.mockResolvedValue(repairedItem);

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'Duplicate blockers drain agents file',
        admissionBypass: 'bypass:explicit-assignment',
        payload: {
          fleetScopeDowngrade: {
            requestedAssignee: 'bee-7',
            reportedBy: 'me',
            fleet: 'fixed-wave',
            code: 'fleet_scope_violation',
            at: '2026-09-08T22:00:00.000Z',
          },
        },
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: true, workItem: { id: 'EI-9' } });
    expect(createM).not.toHaveBeenCalled();
    const statement = [...sqlMocks.query.mock.calls[0][0]].join(' ');
    expect(statement).not.toContain('taken_by =');
    expect(statement).toContain('taken_by IS NULL');
  });

  it('keeps an ordinary exact duplicate refusal unauthorized', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([exactIdentityCandidate]);

    const r = await createOneWorkItem(
      { kind: 'bug', title: 'Duplicate blockers drain agents file' },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'duplicate_identity', existing: { id: 'EI-9' } });
    expect(sqlMocks.query).not.toHaveBeenCalled();
    expect(createM).not.toHaveBeenCalled();
  });

  it('keeps DRAIN refusal ahead of the repair even when assign_to is present', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([exactIdentityCandidate]);

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'Duplicate blockers drain agents file',
        assign_to: 'bee-7',
        requireCompleteDedupCoverage: true,
      },
      ctx,
    );

    expect(r).toMatchObject({ ok: false, error: 'duplicate_identity', existing: { id: 'EI-9' } });
    expect(sqlMocks.query).not.toHaveBeenCalled();
    expect(createM).not.toHaveBeenCalled();
  });

  it('preserves force distinct-work escape when the repair CAS misses', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([exactIdentityCandidate]);

    const r = await createOneWorkItem(
      {
        kind: 'bug',
        title: 'Duplicate blockers drain agents file',
        force: true,
        assign_to: 'bee-7',
        goalDedupGate: true,
      },
      ctx,
    );

    expect(r.ok).toBe(true);
    expect(sqlMocks.query).toHaveBeenCalledOnce();
    expect(createM).toHaveBeenCalledOnce();
  });

  it('P-001 coordination baseline: two retries preserve one known review identity without creating work', async () => {
    guardM.mockResolvedValue(verdict([], []));
    fulltextM.mockResolvedValue([{
      id: 'WI-REVIEW-FIXTURE',
      title: 'Independent metadata fixture review',
      state: 'open',
      harness: 'papercusp',
      similarity: 1,
      source: 'lexical-fulltext',
    }]);
    const request = { kind: 'task', title: 'Independent metadata fixture review' };
    // Count calls to the REAL create core, not network round trips. The fixed
    // existing-row oracle models a retry after the caller already knows the
    // identity; it does not model a concurrent first-create race or screening.
    const attempts = [
      await createOneWorkItem(request, ctx),
      await createOneWorkItem(request, ctx),
    ];
    expect(attempts).toHaveLength(2);
    for (const result of attempts) {
      expect(result).toMatchObject({
        ok: false, error: 'duplicate_identity',
        existing: { id: 'WI-REVIEW-FIXTURE', state: 'open' },
      });
    }
    expect(createM).not.toHaveBeenCalled();
    expect(occurrenceMocks.record).toHaveBeenCalledTimes(2);
    for (const position of [1, 2]) {
      expect(occurrenceMocks.record).toHaveBeenNthCalledWith(position, expect.objectContaining({
        canonicalId: 'WI-REVIEW-FIXTURE',
        canonicalHarness: 'papercusp',
        sourceTool: 'work_items:create',
        reportKind: 'duplicate',
      }));
    }
  });
});
