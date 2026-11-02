import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the flag read + the launch-fire so the doc-steward DISPATCH (P-008) is unit-testable
// without git-sync / the operator. The function dynamic-imports these; vi.mock intercepts the
// module either way.
const mockGetFlag = vi.fn();
const mockFire = vi.fn();
const mockSql = vi.fn();
const policy = vi.hoisted(() => ({ allowed: vi.fn(), observed: vi.fn(async (_scope, invoke) => invoke()) }));
vi.mock('../../device-operator-actions', async original => ({
  ...(await original<object>()), workspaceBackgroundActivityAllowed: policy.allowed,
}));
vi.mock('../../startup-activity', async original => ({
  ...(await original<object>()), runObservedBackgroundActivity: policy.observed,
}));
vi.mock('@papercusp/flags/server', async original => ({ ...(await original<object>()), getFlag: (...a: unknown[]) => mockGetFlag(...a) }));
vi.mock('../../blueprint/launch-blueprint', () => ({
  fireLaunchBlueprintForEvent: (...a: unknown[]) => mockFire(...a),
}));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: mockSql }) }));

import {
  dispatchDocStewardForDrift,
  DOC_STEWARD_MAX_DOCS_PER_DISPATCH,
  type DriftedDoc,
} from './doc-steward-dispatch';
import { startupActivityFeatureId } from '../../schedule-inventory';

const docs: DriftedDoc[] = [
  // P-005: workItems (the change cause) rides along in the batch.
  { docId: 'agent-insights/a.mdx', anchorPaths: ['src/a.ts'], reason: 'src/a.ts changed', source: 'manual', workItems: ['WI-42'] },
  { docId: 'b.mdx', anchorPaths: ['src/b.ts', 'src/c.ts'], reason: 'src/b.ts changed', source: 'generated' },
];

describe('dispatchDocStewardForDrift (doc-steward P-008)', () => {
  beforeEach(() => {
    mockGetFlag.mockReset();
    mockFire.mockReset();
    mockSql.mockReset();
    mockSql.mockResolvedValue([{ n: '0' }]);
    policy.allowed.mockReset().mockResolvedValue(true);
    policy.observed.mockClear();
  });

  it('withholds a newer pause after cooldown lookup and never records an invocation', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockSql.mockImplementationOnce(async () => { policy.allowed.mockResolvedValue(false); return [{ n: '0' }]; });
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toEqual([]);
    expect(policy.allowed).toHaveBeenCalledWith('ws-1', startupActivityFeatureId({
      source: 'in-process', installSlug: null, name: 'doc-steward-dispatch', detail: {},
    }, { workspaceId: 'ws-1' }));
    expect(mockFire).not.toHaveBeenCalled();
    expect(policy.observed).not.toHaveBeenCalled();
  });

  it('records the actual sync invocation in its workspace while preserving the dispatch result', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockResolvedValue({ blueprintId: 'doc-steward' });
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toEqual(docs);
    expect(policy.observed).toHaveBeenCalledWith({ workspaceId: 'ws-1',
      featureId: startupActivityFeatureId({ source: 'in-process', installSlug: null, name: 'doc-steward-dispatch', detail: {} }, { workspaceId: 'ws-1' }),
      source: 'sync', trigger: 'sync',
    }, expect.any(Function));
    expect(mockFire).toHaveBeenCalledOnce();
  });

  it('fires the `docs:drift` launch with the deduped drift batch when the flag is ON', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockResolvedValue({ blueprintId: 'doc-steward' });

    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);

    // WI-2104: returns the batch actually handed to the steward (here: all of it — under the cap).
    expect(dispatched).toEqual(docs);
    expect(mockGetFlag).toHaveBeenCalledWith('papercusp-doc-steward', 'h');
    expect(mockFire).toHaveBeenCalledTimes(1);
    const [event, input] = mockFire.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('docs:drift');
    expect(input.installSlug).toBe('h');
    expect(input.workspaceId).toBe('ws-1');
    // the --doc-drift extra carries the serialized batch the doc-steward parses
    const extra = input.extra as string[];
    expect(extra[0]).toBe('--doc-drift');
    expect(JSON.parse(extra[1])).toEqual({ docs });
    // P-005: the change-cause work-item(s) ride along so the doc-steward knows WHY.
    expect(JSON.parse(extra[1]).docs[0].workItems).toEqual(['WI-42']);
    // the human kickoff names the docs
    expect(input.kickoff as string).toContain('agent-insights/a.mdx');
    expect(input.kickoff as string).toContain('b.mdx');
  });

  it('WI-2104: caps the batch at DOC_STEWARD_MAX_DOCS_PER_DISPATCH and returns ONLY the dispatched subset', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockResolvedValue({ blueprintId: 'doc-steward' });
    const many: DriftedDoc[] = Array.from({ length: DOC_STEWARD_MAX_DOCS_PER_DISPATCH + 4 }, (_, i) => ({
      docId: `doc-${i}.mdx`,
      anchorPaths: [`src/${i}.ts`],
      reason: 'changed',
      source: 'manual',
    }));

    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', many);

    // The first MAX docs (callers order most-deserving first) — never the whole due set: an
    // unbounded batch is what drove 58% of stewards into the 900s timeout (and E2BIG at the
    // extreme), charging give-up attempts to docs no agent ever read.
    expect(dispatched).toEqual(many.slice(0, DOC_STEWARD_MAX_DOCS_PER_DISPATCH));
    const [, input] = mockFire.mock.calls[0] as [string, Record<string, unknown>];
    const payload = JSON.parse((input.extra as string[])[1]) as { docs: DriftedDoc[] };
    expect(payload.docs).toHaveLength(DOC_STEWARD_MAX_DOCS_PER_DISPATCH);
    expect(input.kickoff as string).toContain(`Re-sync ${DOC_STEWARD_MAX_DOCS_PER_DISPATCH} drifted doc(s)`);
    // sliced-out docs are NOT in the batch → the caller won't charge them an attempt
    expect(payload.docs.some((d) => d.docId === `doc-${DOC_STEWARD_MAX_DOCS_PER_DISPATCH}.mdx`)).toBe(false);
  });

  it('P016: carries source-linked rename evidence unchanged to the existing steward review route', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockResolvedValue({ blueprintId: 'doc-steward' });
    const candidate: DriftedDoc = { ...docs[0], sourceChanges: [{ path: 'src/a.ts', status: 'measured',
      before: { commit: '1'.repeat(40), sha256: 'a'.repeat(64) }, after: { commit: '2'.repeat(40), sha256: 'b'.repeat(64) },
      removedSymbols: ['readApi'], addedSymbols: ['readApiV2'], changedSymbols: [], reason: 'documented rename' }] };
    const original = structuredClone(candidate);
    await dispatchDocStewardForDrift('h', 'ws-1', [candidate]);
    const input = mockFire.mock.calls[0][1] as { extra: string[] };
    expect(JSON.parse(input.extra[1]).docs).toEqual([original]);
    expect(candidate).toEqual(original);
  });

  it('does NOT fire while a doc-steward is active OR started within the dispatch cooldown (WI-2104 pacing)', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockSql.mockResolvedValue([{ n: '1' }]);

    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);

    expect(dispatched).toEqual([]);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('does NOT fire when the flag is OFF', async () => {
    mockGetFlag.mockResolvedValue(false);
    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', docs);
    expect(dispatched).toEqual([]);
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('does NOT fire (and never reads the flag) when there are no stale docs', async () => {
    const dispatched = await dispatchDocStewardForDrift('h', 'ws-1', []);
    expect(dispatched).toEqual([]);
    expect(mockGetFlag).not.toHaveBeenCalled();
    expect(mockFire).not.toHaveBeenCalled();
  });

  it('is best-effort: a fire failure returns [] instead of throwing (never wedges git-sync)', async () => {
    mockGetFlag.mockResolvedValue(true);
    mockFire.mockRejectedValue(new Error('invoke route down'));
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toEqual([]);
  });

  it('is best-effort: a flag-read failure returns [] and never fires', async () => {
    mockGetFlag.mockRejectedValue(new Error('flags infra down'));
    await expect(dispatchDocStewardForDrift('h', 'ws-1', docs)).resolves.toEqual([]);
    expect(mockFire).not.toHaveBeenCalled();
  });
});
