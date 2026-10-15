/**
 * _create-core.dedup-candidates-stamp.test — P-001 of
 * silent-intake-central-resolution-2026-09-01 (D-001/D-003): a SUCCESSFUL create
 * persists the file-time dup-detection candidates on the created row itself as
 * `payload.dedupCandidates` ({ id, similarity, method }[]), beside the
 * `payload.dedupCoverage` verdict that was already stamped. The filer is never
 * interrupted; the central resolver is the consumer.
 *
 * Also pins the force-path fix: a `force:true` create that rides past the hard
 * semantic refusal used to DROP those hard candidates entirely (they never reached
 * `similarOpen`, the payload, or `dedup_edges`) — the one branch where file-time
 * detection evaporated. They now ride the same persistence rails, tagged
 * 'semantic-hard'.
 *
 * Mock harness mirrors _create-core.fulltext-dupe.test.ts.
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

// See _create-core.fulltext-dupe.test.ts for why goal-context must be mocked to null
// (EI-21872682653374832): unmocked, the authority read fails closed and its console.warn
// fails the suite before these tests assert anything.
vi.mock('../../modes/goal-context', () => ({
  resolveGoalContext: vi.fn(async () => null),
}));

import { createOneWorkItem } from './_create-core';
import { createWorkItem } from '../../work-items';
import { findSemanticDupes } from './semantic-dupe-guard';
import { findRecentLexicalDupes } from './recent-lexical-dupe-guard';
import { findFulltextLexicalDupes } from './fulltext-lexical-dupe-guard';
import type { SemanticDupeCandidate } from './semantic-dupe-guard';

const createM = vi.mocked(createWorkItem);
const semanticM = vi.mocked(findSemanticDupes);
const recentM = vi.mocked(findRecentLexicalDupes);
const fulltextM = vi.mocked(findFulltextLexicalDupes);
const ctx = { ownerId: 'me', workspaceId: 'default', harnessSlug: 'papercusp' };

/** The payload the last successful create actually wrote to the row. */
const lastCreatePayload = (): Record<string, unknown> | undefined =>
  createM.mock.calls.at(-1)?.[0].payload as Record<string, unknown> | undefined;

const cand = (
  id: string,
  similarity: number,
  source?: 'lexical-recent' | 'lexical-fulltext' | 'measurement-overlap',
): SemanticDupeCandidate => ({
  id,
  title: `candidate ${id}`,
  state: 'open',
  harness: 'papercusp',
  similarity,
  ...(source ? { source } : {}),
});

const recentResult = (candidates: SemanticDupeCandidate[]) => ({
  candidates,
  coverage: { scanned: candidates.length, unembedded: 0, truncated: false, complete: true },
});

beforeEach(() => {
  createM.mockClear();
  semanticM.mockReset();
  recentM.mockReset();
  fulltextM.mockReset();
  dedupEdgeMocks.persist.mockClear();
  semanticM.mockResolvedValue(null);
  recentM.mockResolvedValue(null);
  fulltextM.mockResolvedValue([]);
});

describe('createOneWorkItem × P-001 dedupCandidates payload stamp', () => {
  it('soft semantic + fulltext candidates land on payload.dedupCandidates with per-method tags', async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [cand('WI-10', 0.87)],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    fulltextM.mockResolvedValue([cand('EI-11', 0.7, 'lexical-fulltext')]);
    const r = await createOneWorkItem({ kind: 'bug', title: 'a paraphrased refile' }, ctx);
    expect(r.ok).toBe(true);
    const payload = lastCreatePayload();
    expect(payload?.dedupCandidates).toEqual([
      { id: 'WI-10', similarity: 0.87, method: 'semantic-soft' },
      { id: 'EI-11', similarity: 0.7, method: 'lexical-fulltext' },
    ]);
    // The pre-existing decorations still ride beside the stamp.
    expect(payload?.dedupCoverage).toBeDefined();
    expect(payload?.admissionIdentity).toBeDefined();
  });

  it('recent-lexical candidates are stamped lexical-recent', async () => {
    recentM.mockResolvedValue(recentResult([cand('EI-9', 0.8, 'lexical-recent')]));
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    expect(lastCreatePayload()?.dedupCandidates).toEqual([
      { id: 'EI-9', similarity: 0.8, method: 'lexical-recent' },
    ]);
  });

  it('R-4: measurement-overlap candidates are stamped under their own method, the create still succeeds, and the summary reaches the guard', async () => {
    recentM.mockResolvedValue(recentResult([cand('EI-22393887492211068', 0.89, 'measurement-overlap')]));
    const r = await createOneWorkItem(
      { kind: 'bug', title: 'retention scope is stale', summary: 'session_archive_files 22 GB\ntool_invocations 15 GB' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(recentM).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'session_archive_files 22 GB\ntool_invocations 15 GB' }),
    );
    expect(lastCreatePayload()?.dedupCandidates).toEqual([
      { id: 'EI-22393887492211068', similarity: 0.89, method: 'measurement-overlap' },
    ]);
    // Advisory lexical-family evidence, never a cosine edge: the edge writer receives it
    // with its source intact, and dedup-edges skips every sourced candidate.
    const edgeCandidates = dedupEdgeMocks.persist.mock.calls.at(-1)?.[0].candidates as SemanticDupeCandidate[];
    expect(edgeCandidates.map((c) => [c.id, c.source])).toEqual([['EI-22393887492211068', 'measurement-overlap']]);
  });

  it('force past a hard semantic refusal persists the twins as semantic-hard (was: dropped entirely)', async () => {
    semanticM.mockResolvedValue({
      hard: [cand('WI-77', 0.95)],
      soft: [],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    // requireCompleteDedupCoverage keeps the screen running under force (WI-39824:
    // force suppresses the VETO, never the MEASUREMENT).
    const r = await createOneWorkItem(
      { kind: 'bug', title: 't', force: true, requireCompleteDedupCoverage: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(lastCreatePayload()?.dedupCandidates).toEqual([
      { id: 'WI-77', similarity: 0.95, method: 'semantic-hard' },
    ]);
    // ...and they now reach the promoter's substrate too.
    expect(persistedCandidates()?.map((c) => c.id)).toEqual(['WI-77']);
  });

  it('bare force skips the probes entirely — nothing detected, nothing stamped', async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [cand('WI-10', 0.87)],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    const r = await createOneWorkItem({ kind: 'bug', title: 't', force: true }, ctx);
    expect(r.ok).toBe(true);
    expect(semanticM).not.toHaveBeenCalled();
    expect(lastCreatePayload()?.dedupCandidates).toBeUndefined();
  });

  it('no candidates ⇒ no dedupCandidates key — dedupCoverage alone says "checked clean"', async () => {
    const r = await createOneWorkItem({ kind: 'bug', title: 't' }, ctx);
    expect(r.ok).toBe(true);
    const payload = lastCreatePayload();
    expect(payload?.dedupCoverage).toBeDefined();
    expect(payload?.dedupCandidates).toBeUndefined();
  });

  it('feature-family without the goal gate stays unstamped (same policy as dedupCoverage)', async () => {
    semanticM.mockResolvedValue({
      hard: [],
      soft: [cand('WI-10', 0.87)],
      thresholds: { hard: 0.93, soft: 0.85 },
    });
    const r = await createOneWorkItem({ kind: 'feature', title: 't', harness: 'papercusp' }, ctx);
    expect(r.ok).toBe(true);
    expect(lastCreatePayload()?.dedupCandidates).toBeUndefined();
  });
});
