/**
 * EI-20042650315152947 — the PRODUCTION reader's source wiring.
 *
 * `holds-a-lock-on` was wired on the `coord:presence` path (11 calls ever) and
 * NOT on the `coord:send` divergence path — the only coupling path that runs at
 * volume. Result: 0 edges in 14 days. The cause was not a bad value but a
 * MISSING ARGUMENT: `couplingSourcesFor` omits the `heldFiles` source entirely
 * when `coordinationDomain` is absent (coupling-sources.ts:201-206), so the
 * relation was structurally underivable rather than merely empty.
 *
 * That distinction is why this file exists at all. An "is the relation ever
 * produced?" test passes vacuously against the broken code — no lock fixture
 * means no edge either way — so the only non-vacuous assertion is on the CALL
 * ITSELF: did the reader hand `couplingSourcesFor` a domain?
 *
 * These tests live in their own file rather than in
 * `coupling-divergence-stamp.test.ts` deliberately: that suite exercises the
 * INJECTED `PeerRelationsReader` and declares no module mocks, and adding
 * hoisted `vi.mock` calls to it would silently re-scope all four of its existing
 * describes (the mock-ordering trap this repo has been bitten by before).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The subset of `couplingSourcesFor`'s options these tests assert on. */
type SourcesOpts = {
  selfOwnerId: string;
  rosterOwnerIds: string[];
  coordinationDomain?: string;
  harnessSlug?: string;
  workspaceId?: string;
};

// NOTE: the parameter is declared even though the body ignores it. A bare
// `vi.fn(() => ({}))` types `mock.calls` as an EMPTY tuple, so `calls[0][0]`
// is a compile error (TS2493) — invisible to vitest, which is type-blind.
const couplingSourcesFor = vi.fn((_opts: SourcesOpts) => ({}));
// WI-38252 moved the subject from `lockCoordinationDomain` (the tree whose code
// this process loaded) to `fileLockCoordinationDomain` (the tree agents EDIT).
// The spy must name the function the subject ACTUALLY calls: spying on the old
// one does not fail loudly, it just stops observing anything.
const fileLockCoordinationDomain = vi.fn(() => '/repo/root');

vi.mock('./coupling-sources', () => ({
  couplingSourcesFor: (opts: SourcesOpts) => couplingSourcesFor(opts),
}));
// PARTIAL mock (WI-38278). A whole-module literal factory silently strands the
// moment production imports an export it does not declare — vitest then throws
// `No "<name>" export is defined on the mock` from inside the subject, which
// reads as a subject failure rather than a stale test. Spreading the real module
// means only the ONE function under control is overridden and the factory cannot
// fall behind `coordination-domain` again.
vi.mock('../locks/coordination-domain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../locks/coordination-domain')>()),
  fileLockCoordinationDomain: () => fileLockCoordinationDomain(),
}));
vi.mock('./presence-snapshot', () => ({
  resolvePresenceScope: async () => ({}),
  assemblePresenceSnapshot: async () => ({ active: [{ ownerId: 'peer-1' }] }),
}));
vi.mock('../../coord/coupling-derivation', () => ({
  deriveCouplings: async () => [],
}));
vi.mock('../../coord/couplings', () => ({
  listCouplingsFor: async () => [],
  resolveCoupledPeers: () => [],
}));

const { readPeerRelations } = await import('./coupling-divergence-stamp');

const firstCallOpts = (): SourcesOpts | undefined => couplingSourcesFor.mock.calls[0]?.[0];

describe('EI-20042650315152947 — the send path must request the lock-hold source', () => {
  beforeEach(() => {
    couplingSourcesFor.mockClear();
    fileLockCoordinationDomain.mockClear();
    fileLockCoordinationDomain.mockReturnValue('/repo/root');
  });

  it('passes a coordinationDomain, so heldFiles is actually built', async () => {
    await readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' });

    // The whole bug in one assertion: pre-fix this key was absent, which made
    // `holds-a-lock-on` impossible to derive on the only path that runs.
    expect(couplingSourcesFor).toHaveBeenCalledTimes(1);
    expect(firstCallOpts()?.coordinationDomain).toBe('/repo/root');
  });

  it('still passes the scope it already passed (no regression in the fix)', async () => {
    await readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' });

    expect(firstCallOpts()).toMatchObject({
      selfOwnerId: 'self-owner',
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      rosterOwnerIds: ['peer-1'],
    });
  });

  it('degrades fail-soft when the domain cannot be resolved — never fails a send', async () => {
    fileLockCoordinationDomain.mockImplementation(() => {
      throw new Error('no repo root');
    });

    // Must RESOLVE, not reject: this runs inside coord:send, where a thrown
    // measurement would eat a message.
    await expect(
      readPeerRelations('self-owner', { workspaceId: 'ws', harnessSlug: 'papercusp' }),
    ).resolves.toBeInstanceOf(Map);

    // ...and it degrades to the OLD behaviour (no lock signal) rather than
    // passing a bogus domain that would key the lock read to the wrong tree.
    expect(firstCallOpts()?.coordinationDomain).toBeUndefined();
  });

  it('reports each production reader boundary without letting the timing sink affect the result', async () => {
    const timings: Array<{ name: string; elapsedMs: number; status: 'ok' | 'error' }> = [];
    const result = await readPeerRelations('self-owner', {
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      onStageTiming: (timing) => timings.push(timing),
    });

    expect(result).toBeInstanceOf(Map);
    expect(timings.map(({ name }) => name)).toEqual([
      'load-dependencies',
      'coordination-domain',
      'resolve-presence-scope',
      'assemble-presence-snapshot',
      'derive-couplings',
      'list-coupling-edges',
      'resolve-coupled-peers',
    ]);
    expect(timings).toEqual(timings.map((timing) => ({
      ...timing,
      elapsedMs: expect.any(Number),
      status: 'ok',
    })));
    await expect(readPeerRelations('self-owner', {
      onStageTiming: () => { throw new Error('diagnostic sink failed'); },
    })).resolves.toBeInstanceOf(Map);
  });
});
