/**
 * _create-core.recent-dupe.test — EI-9940's recent-lexical-dupe-guard wire-in
 * contract on createOneWorkItem: NEVER blocks (advisory-only, unlike the P-008
 * hard band); merges into the candidate set alongside anything the semantic guard
 * already found, deduped by id; skipped entirely under force:true; a null
 * verdict (fail-open) leaves the set untouched. The guard's own scoring
 * logic is covered by recent-lexical-dupe-guard.test.ts.
 *
 * The merged set is observed where it now GOES (work-queue-admission-and-bulk-dedup
 * P-002, item d): a successful create persists it for the promoter via
 * `persistDedupEdges` rather than returning it to the filing agent as `similarOpen`.
 * Which candidates that writer keeps (cosine-only) is dedup-edges.ts's own contract,
 * tested there — mocked here, so this file still sees the FULL merged set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dedupEdgeMocks = vi.hoisted(() => ({
  persist: vi.fn(async (input: { candidates?: readonly { id: string }[] }) => input.candidates?.length ?? 0),
}));
vi.mock('./dedup-edges', () => ({ persistDedupEdges: dedupEdgeMocks.persist }));

/** The candidate set the last successful create handed to the promoter's substrate. */
const persistedCandidates = (): readonly { id: string; source?: string }[] | undefined =>
  dedupEdgeMocks.persist.mock.calls.at(-1)?.[0].candidates as
    | readonly { id: string; source?: string }[]
    | undefined;

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
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: {} }) }));
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
import { findSemanticDupes } from './semantic-dupe-guard';
import { findRecentLexicalDupes } from './recent-lexical-dupe-guard';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

const semanticM = vi.mocked(findSemanticDupes);
const recentM = vi.mocked(findRecentLexicalDupes);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

const recentCand = (id: string, similarity = 0.6): SemanticDupeCandidate => ({
  id,
  title: `recent dupe ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
  source: 'lexical-recent',
});

const recentResult = (candidates: SemanticDupeCandidate[]) => ({
  candidates,
  coverage: { scanned: candidates.length, unembedded: 0, truncated: false, complete: true },
});

beforeEach(() => {
  semanticM.mockReset();
  recentM.mockReset();
  dedupEdgeMocks.persist.mockClear();
  semanticM.mockResolvedValue(null);
  recentM.mockResolvedValue(recentResult([]));
});

describe('createOneWorkItem × recent-lexical dupe guard (EI-9940)', () => {
  it('NEVER blocks — a recent lexical match still creates the item (advisory only)', async () => {
    recentM.mockResolvedValue(recentResult([recentCand('WI-4241')]));
    const r = await createOneWorkItem({ kind: 'bug', title: 'a fresh near-duplicate title' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.workItem.id).toBe('WI-NEW');
    expect('similarOpen' in r).toBe(false);
    expect(persistedCandidates()?.map((c) => c.id)).toEqual(['WI-4241']);
    expect(persistedCandidates()?.[0].source).toBe('lexical-recent');
  });

  it('merges with the semantic guard\'s soft matches, deduped by id', async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [{ id: 'WI-10', title: 'semantic soft dupe', state: 'todo', harness: 'papercusp', similarity: 0.87 }],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    // WI-10 also shows up in the recent-lexical pass (same id) — must not duplicate;
    // WI-11 is a genuinely new recent-only match and must be appended.
    recentM.mockResolvedValue(recentResult([recentCand('WI-10'), recentCand('WI-11')]));
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(persistedCandidates()?.map((c) => c.id)).toEqual(['WI-10', 'WI-11']);
    // The original semantic candidate (no `source` tag) must survive un-clobbered.
    expect(persistedCandidates()?.[0].source).toBeUndefined();
  });

  it('force:true skips the recent-lexical prescreen entirely too', async () => {
    recentM.mockResolvedValue(recentResult([recentCand('WI-9')]));
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(recentM).not.toHaveBeenCalled();
  });

  it('null verdict (fail-open) leaves the candidate set untouched — nothing to persist', async () => {
    recentM.mockResolvedValue(null);
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect('similarOpen' in r).toBe(false);
    expect(persistedCandidates()).toBeUndefined();
    expect('dedupEdges' in r).toBe(false);
  });

  it('passes the resolved harness through (args.harness ?? ctx.harnessSlug)', async () => {
    await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(recentM).toHaveBeenCalledWith({ title: 't', harness: 'papercusp' });
  });
});
