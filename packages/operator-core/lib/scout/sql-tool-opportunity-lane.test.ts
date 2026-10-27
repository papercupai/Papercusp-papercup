import { afterEach, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/tooldef';
import type { SqlCandidateReadOptions } from '../bash-substitution/sql-tool-candidates';
import type { StateOfHiveDigest } from './corpus-digest';
import { bindSqlCandidateAuthorityResolver } from '../sql-tool-candidate-pull';
import type { SqlCandidateWorklist } from '../sql-tool-candidate-worklist';
import { readSqlToolCandidateWorklist } from '../sql-tool-candidate-worklist';
import { readSqlToolOpportunityLane } from './sql-tool-opportunity-lane';
import { synthesizeStateOfHive } from './corpus-digest';
import { persistDigestSnapshot } from './digest-snapshots';
import tool from '../agent-tools/curation/state-of-pot';

vi.mock('../sql-tool-candidate-worklist', () => ({ readSqlToolCandidateWorklist: vi.fn() }));
vi.mock('./corpus-digest', () => ({ synthesizeStateOfHive: vi.fn() }));
vi.mock('./corpus-digest-deps', () => ({ buildStateOfHiveReaders: vi.fn(() => ({})) }));
vi.mock('./digest-snapshots', () => ({ persistDigestSnapshot: vi.fn() }));
const ctx: UnifiedToolContext = { workspaceId: 'w', harnessSlug: 'h', tx: null, log: () => {},
  signal: new AbortController().signal, progress: () => {}, emit: () => {},
  principal: { kind: 'system', slug: 'fixture', workspaceId: 'w', authMethod: 'process-internal',
    trust: 'trusted', capabilities: new Set(['curation:read']) } };
const opts: SqlCandidateReadOptions = { workspaceId: 'w', harnessSlug: 'h',
  scope: { workspaceId: 'w', sourceBoundary: 'ledger', epoch: 'fixture', key: new Uint8Array(32).fill(73) },
  authorize: async () => true, authorizeSource: async () => true };
const digest: StateOfHiveDigest = { generatedAt: '2026-10-25T00:00:00Z', headline: 'fixture',
  corpus: { completions: 0, reverts: 0, frictionCaptured: 0, deferrals: 0, spendUsd: 0,
    spendBuckets: 0, observations: 0, rubrics: 0 }, recurringFriction: [], timeTokenSinks: [],
  chronicDeferrals: [], capabilityGaps: [], reverts: [], rubricRatings: [], rubricGaps: [] };
afterEach(() => { bindSqlCandidateAuthorityResolver(null); vi.resetAllMocks(); });
// Independent public response contract, not a value produced by the implementation helper.
const unknown: SqlCandidateWorklist = { status: 'UNKNOWN', candidates: [], snapshots: [],
  population: { candidates: 0, returned: 0, omitted: 0, snapshotCap: 120 } };
function body(response: Awaited<ReturnType<typeof tool.handler>>) {
  if (!('content' in response)) throw new Error('expected content response');
  const block = response.content.find(part => part.type === 'text');
  if (!block || block.type !== 'text') throw new Error('expected text response');
  return JSON.parse(block.text);
}

it('keeps allowed scoped SQL demand separate from foreign demand OUTCOME-P-008', async () => {
  bindSqlCandidateAuthorityResolver(async () => opts);
  const allowed = { ...unknown, status: 'ok' as const };
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(allowed);
  expect(await readSqlToolOpportunityLane(ctx, { harness: 'foreign' })).toEqual(unknown);
  expect(readSqlToolCandidateWorklist).toHaveBeenCalledTimes(1);
});
it('re-resolves source authority on each Scout pull instead of caching membership R23-DERIVED-ACL', async () => {
  let current = true;
  const resolver = vi.fn(async () => current ? opts : null);
  bindSqlCandidateAuthorityResolver(resolver);
  const allowed = { ...unknown, status: 'ok' as const,
    population: { candidates: 7, returned: 0, omitted: 7, snapshotCap: 120 as const } };
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(allowed);
  current = false;
  expect(await readSqlToolOpportunityLane(ctx)).toEqual(unknown);
  expect(resolver).toHaveBeenCalledTimes(2);
});
it('leaves the legacy corpus response unchanged without an explicit SQL pull R8', async () => {
  vi.mocked(synthesizeStateOfHive).mockResolvedValue(digest);
  const response = await tool.handler({}, ctx);
  expect(body(response)).toEqual({ ok: true, digest });
  expect(readSqlToolCandidateWorklist).not.toHaveBeenCalled();
});
it('exposes an ephemeral sibling without modifying or persisting digest membership R8', async () => {
  const original = JSON.stringify(digest);
  vi.mocked(synthesizeStateOfHive).mockResolvedValue(digest);
  bindSqlCandidateAuthorityResolver(async () => opts);
  const allowed = { ...unknown, status: 'ok' as const };
  vi.mocked(readSqlToolCandidateWorklist).mockResolvedValue(allowed);
  const response = await tool.handler({ sqlCandidates: true, perCategory: 4 }, ctx);
  expect(body(response)).toEqual({ ok: true, digest, sqlToolOpportunities: allowed });
  expect(JSON.stringify(digest)).toBe(original);
  expect(readSqlToolCandidateWorklist).toHaveBeenCalledWith({ ...opts, limit: 4, ranOn: undefined });
  expect(persistDigestSnapshot).not.toHaveBeenCalled();
});
it('fails closed on absent authority while keeping the existing digest available', async () => {
  vi.mocked(synthesizeStateOfHive).mockResolvedValue(digest);
  const response = await tool.handler({ sqlCandidates: true }, ctx);
  expect(body(response)).toEqual({ ok: true, digest,
    sqlToolOpportunities: unknown });
});
