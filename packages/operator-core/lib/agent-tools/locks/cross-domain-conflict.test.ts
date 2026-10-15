/**
 * cross-domain-conflict.test.ts — the WI-562584 fail-CLOSED acquire guard.
 *
 * What this protects: `resourceLockDomain()` infers ONE coordination domain
 * from the resource NAME, and a wrong inference used to fail OPEN — granting a
 * lock over a live hold the holder could not see (git-sync holds every
 * `extra_lock_resources` name under the workspace domain; those names advertise
 * no family, so an agent's acquire landed in the caller-tree domain and was
 * granted). `ok:true` from `locks:acquire_resource` was therefore not proof of
 * exclusivity. The rules below are what makes it proof again.
 *
 * FALSIFIABILITY (see CLAUDE.md "Proving a guard is falsifiable"): this is an
 * imported module, so the shared-tree mutation probe is the wrong tier. Two
 * deliberately-wrong implementations live PERMANENTLY in this file as controls,
 * plus a calibration run of the real one — a contract that the real
 * implementation passes and both wrong ones also passed would be a contract
 * asserting nothing.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/cross-domain-conflict.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./coordination-domain', () => ({
  candidateResourceLockDomains: vi.fn(() => ['caller-tree', 'papercusp-host-global', 'papercusp-workspace']),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(() => ({ mockPool: true })),
  readResourceQueue: vi.fn(),
  listLiveResourceDomains: vi.fn(async (): Promise<string[]> => []),
}));

import { candidateResourceLockDomains } from './coordination-domain';
import { listLiveResourceDomains, readResourceQueue, type ResourceHolder } from './su-lock-store';
import {
  selectCrossDomainConflicts,
  findCrossDomainResourceConflicts,
  parseHostGlobalResourceExclusionError,
  type DomainHolders,
  type CrossDomainHolder,
  type ResourceAcquireMode,
} from './cross-domain-conflict';

const domainsM = vi.mocked(candidateResourceLockDomains);
const queueM = vi.mocked(readResourceQueue);
const liveDomainsM = vi.mocked(listLiveResourceDomains);
const foreignCoordinationDomain = join(tmpdir(), 'papercusp-release');

const ACQ = new Date('2026-08-28T20:00:00Z');
const EXP = new Date('2026-08-28T21:00:00Z');

/** Complete ResourceHolder with a Partial override seam — no `as never`, so a
 *  new required field on the real type fails HERE instead of at the fleet gate. */
function holder(over: Partial<ResourceHolder> = {}): ResourceHolder {
  return {
    resource: 'libs-papercusp-submodule',
    owner: 'system:git-sync',
    owner_label: 'git-sync',
    mode: 'exclusive',
    status: 'held',
    lock_id: 'L-1',
    reason: 'sweep',
    acquired_ts: ACQ,
    expires_ts: EXP,
    fence_seq: 3,
    ...over,
  };
}

const wsHolds = (h: ResourceHolder = holder()): DomainHolders[] => [
  { coordinationDomain: 'papercusp-host-global', holders: [] },
  { coordinationDomain: 'papercusp-workspace', holders: [h] },
];

beforeEach(() => {
  vi.clearAllMocks();
  domainsM.mockReturnValue(['caller-tree', 'papercusp-host-global', 'papercusp-workspace']);
  liveDomainsM.mockResolvedValue([]);
});

// ───────────────────────── the predicate ─────────────────────────

describe('selectCrossDomainConflicts', () => {
  it('REFUSES a shared acquire over a foreign exclusive, naming the holder AND its domain', () => {
    const c = selectCrossDomainConflicts({
      resource: 'libs-papercusp-submodule',
      requestedMode: 'shared',
      owner: 'su-1',
      foreign: wsHolds(),
    });
    expect(c).toHaveLength(1);
    // The domain is the field a refused caller needs in order to act: without
    // it, "held" is unactionable because locks:list scoped to the caller's own
    // domain reports the resource as free.
    expect(c[0]).toMatchObject({
      coordination_domain: 'papercusp-workspace',
      resource: 'libs-papercusp-submodule',
      owner: 'system:git-sync',
      mode: 'exclusive',
      status: 'held',
      acquired_ts: '2026-08-28T20:00:00.000Z',
      expires_ts: '2026-08-28T21:00:00.000Z',
    });
  });

  it('REFUSES an exclusive acquire over a foreign SHARED holder (no drain protocol reaches another domain)', () => {
    const c = selectCrossDomainConflicts({
      resource: 'libs-papercusp-submodule',
      requestedMode: 'exclusive',
      owner: 'su-1',
      foreign: wsHolds(holder({ mode: 'shared' })),
    });
    expect(c).toHaveLength(1);
    expect(c[0]!.mode).toBe('shared');
  });

  it('blocks on a foreign exclusive that is still DRAINING, matching the in-domain rule', () => {
    const c = selectCrossDomainConflicts({
      resource: 'libs-papercusp-submodule',
      requestedMode: 'shared',
      owner: 'su-1',
      foreign: wsHolds(holder({ status: 'draining' })),
    });
    expect(c).toHaveLength(1);
  });

  // ── the no-false-refusal half: each of these used to grant, and must still ──

  it('ALLOWS a shared acquire alongside a foreign SHARED holder (shared coexists)', () => {
    expect(
      selectCrossDomainConflicts({
        resource: 'libs-papercusp-submodule',
        requestedMode: 'shared',
        owner: 'su-1',
        foreign: wsHolds(holder({ mode: 'shared' })),
      }),
    ).toEqual([]);
  });

  it("ALLOWS an acquire when the only foreign holder is the CALLER's own (re-acquire / refresh)", () => {
    expect(
      selectCrossDomainConflicts({
        resource: 'libs-papercusp-submodule',
        requestedMode: 'exclusive',
        owner: 'su-1',
        foreign: wsHolds(holder({ owner: 'su-1' })),
      }),
    ).toEqual([]);
  });

  it('ALLOWS an acquire when the foreign holder is a DIFFERENT resource (an unfiltered queue cannot manufacture a conflict)', () => {
    expect(
      selectCrossDomainConflicts({
        resource: 'libs-papercusp-submodule',
        requestedMode: 'exclusive',
        owner: 'su-1',
        foreign: wsHolds(holder({ resource: 'git-sync:papercusp' })),
      }),
    ).toEqual([]);
  });

  it('ALLOWS an acquire when no foreign domain holds anything', () => {
    expect(
      selectCrossDomainConflicts({
        resource: 'libs-papercusp-submodule',
        requestedMode: 'exclusive',
        owner: 'su-1',
        foreign: [
          { coordinationDomain: 'papercusp-host-global', holders: [] },
          { coordinationDomain: 'papercusp-workspace', holders: [] },
        ],
      }),
    ).toEqual([]);
  });
});

// ───────────────────────── the read ─────────────────────────

describe('findCrossDomainResourceConflicts', () => {
  it('queries every candidate domain EXCEPT the acquire target, and only that resource', async () => {
    queueM.mockResolvedValue({ holders: [], draining: false });
    await findCrossDomainResourceConflicts({
      resource: 'libs-papercusp-submodule',
      targetDomain: 'caller-tree',
      requestedMode: 'exclusive',
      owner: 'su-1',
    });
    expect(queueM).toHaveBeenCalledTimes(2);
    const domains = queueM.mock.calls.map((c) => c[1].coordinationDomain);
    expect(domains.sort()).toEqual(['papercusp-host-global', 'papercusp-workspace']);
    for (const call of queueM.mock.calls) {
      expect(call[1].resource).toBe('libs-papercusp-submodule');
    }
  });

  it('issues NO queue read when neither the candidates nor any live lease name another domain', async () => {
    domainsM.mockReturnValue(['only-domain']);
    liveDomainsM.mockResolvedValue(['only-domain']);
    const c = await findCrossDomainResourceConflicts({
      resource: 'r',
      targetDomain: 'only-domain',
      requestedMode: 'exclusive',
      owner: 'su-1',
    });
    expect(c).toEqual([]);
    expect(liveDomainsM).toHaveBeenCalledWith({ mockPool: true }, 'r');
    expect(queueM).not.toHaveBeenCalled();
  });

  // EI-24434173247501787: the caller-tree domain is the SERVING operator's
  // checkout. Measured 2026-09-27: `p013-benchmark-rig` was held exclusive in
  // the papercup-release domain (acquired through :3070) while an exclusive
  // acquire routed through :3170 was GRANTED in the staging domain — neither
  // domain is among the other process's three candidates.
  it('REFUSES an exclusive acquire over a live exclusive held through ANOTHER checkout (found by name)', async () => {
    liveDomainsM.mockResolvedValue(['/home/x/papercup-release']);
    const rig = holder({ resource: 'p013-benchmark-rig', owner: 'su-d', owner_label: 'su-d' });
    queueM.mockImplementation(async (_sql, params) =>
      params.coordinationDomain === '/home/x/papercup-release'
        ? { holders: [rig], draining: false }
        : { holders: [], draining: false },
    );
    const c = await findCrossDomainResourceConflicts({
      resource: 'p013-benchmark-rig',
      targetDomain: '/home/x/papercusp-staging',
      requestedMode: 'exclusive',
      owner: 'su-a',
    });
    expect(c).toEqual([
      expect.objectContaining({
        coordination_domain: '/home/x/papercup-release',
        owner: 'su-d',
        resource: 'p013-benchmark-rig',
        mode: 'exclusive',
      }),
    ]);
  });

  it('reads a domain once when it is both a candidate and a live-lease domain', async () => {
    liveDomainsM.mockResolvedValue(['papercusp-workspace', '/other/checkout']);
    queueM.mockResolvedValue({ holders: [], draining: false });
    await findCrossDomainResourceConflicts({
      resource: 'r',
      targetDomain: 'caller-tree',
      requestedMode: 'exclusive',
      owner: 'su-1',
    });
    const domains = queueM.mock.calls.map((c) => c[1].coordinationDomain);
    expect(domains.sort()).toEqual(['/other/checkout', 'papercusp-host-global', 'papercusp-workspace']);
  });

  it('does NOT swallow a failed live-domain discovery — it propagates like a queue-read failure', async () => {
    liveDomainsM.mockRejectedValue(new Error('discovery failed'));
    await expect(
      findCrossDomainResourceConflicts({
        resource: 'r',
        targetDomain: 'caller-tree',
        requestedMode: 'exclusive',
        owner: 'su-1',
      }),
    ).rejects.toThrow('discovery failed');
    expect(queueM).not.toHaveBeenCalled();
  });

  it('stamps the domain the conflicting holder was actually read from', async () => {
    queueM.mockImplementation(async (_sql, params) =>
      params.coordinationDomain === 'papercusp-workspace'
        ? { holders: [holder()], draining: false }
        : { holders: [], draining: false },
    );
    const c = await findCrossDomainResourceConflicts({
      resource: 'libs-papercusp-submodule',
      targetDomain: 'caller-tree',
      requestedMode: 'shared',
      owner: 'su-1',
    });
    expect(c).toHaveLength(1);
    expect(c[0]!.coordination_domain).toBe('papercusp-workspace');
  });

  it('does NOT swallow a read failure — an unanswered exclusivity question must not become a grant', async () => {
    queueM.mockRejectedValue(new Error('connection terminated'));
    await expect(
      findCrossDomainResourceConflicts({
        resource: 'r',
        targetDomain: 'caller-tree',
        requestedMode: 'exclusive',
        owner: 'su-1',
      }),
    ).rejects.toThrow('connection terminated');
  });
});

describe('parseHostGlobalResourceExclusionError', () => {
  const expected = { resource: 'dev-server', targetDomain: 'papercusp-host-global' };
  const detail = {
    resource: 'dev-server',
    requested_domain: 'papercusp-host-global',
    coordination_domain: foreignCoordinationDomain,
    owner: 'su-peer',
    mode: 'exclusive',
    status: 'held',
  };

  it('parses the atomic trigger refusal and preserves the actual conflicting domain', () => {
    const error = Object.assign(new Error('trigger refusal'), {
      code: '23P01',
      constraint_name: 'resource_host_global_exclusion',
      detail: JSON.stringify(detail),
    });

    expect(parseHostGlobalResourceExclusionError(error, expected)).toEqual(detail);
  });

  it('accepts the constraint field alias and rejects unrelated or mismatched errors', () => {
    const aliased = Object.assign(new Error('trigger refusal'), {
      code: '23P01',
      constraint: 'resource_host_global_exclusion',
      detail,
    });
    expect(parseHostGlobalResourceExclusionError(aliased, expected)).toEqual(detail);

    expect(
      parseHostGlobalResourceExclusionError(
        Object.assign(new Error('different constraint'), {
          code: '23P01',
          constraint_name: 'some_other_constraint',
          detail: JSON.stringify(detail),
        }),
        expected,
      ),
    ).toBeNull();
    expect(
      parseHostGlobalResourceExclusionError(
        Object.assign(new Error('wrong resource'), {
          code: '23P01',
          constraint_name: 'resource_host_global_exclusion',
          detail: JSON.stringify({ ...detail, resource: 'release-deploy' }),
        }),
        expected,
      ),
    ).toBeNull();
  });
});

// ───────────────────── falsifiability controls ─────────────────────

type Impl = (params: {
  resource: string;
  requestedMode: ResourceAcquireMode;
  owner: string;
  foreign: DomainHolders[];
}) => CrossDomainHolder[];

/** WRONG #1 — the pre-fix behaviour: never conflicts, so every acquire is granted. */
const failsOpen: Impl = () => [];

/** WRONG #2 — ignores the mode rule: treats every foreign holder as a conflict,
 *  which refuses shared-alongside-shared acquires that must still be granted. */
const ignoresMode: Impl = (p) =>
  p.foreign.flatMap(({ coordinationDomain, holders }) =>
    holders
      .filter((h) => h.resource === p.resource && h.owner !== p.owner)
      .map((h) => ({
        coordination_domain: coordinationDomain,
        resource: h.resource,
        owner: h.owner,
        owner_label: h.owner_label,
        mode: h.mode,
        status: h.status,
        reason: h.reason,
        acquired_ts: h.acquired_ts.toISOString(),
        expires_ts: h.expires_ts.toISOString(),
      })),
  );

/** The contract, as data: [label, mode, foreign holders, must-conflict?]. */
const CONTRACT: Array<[string, ResourceAcquireMode, DomainHolders[], boolean]> = [
  ['shared over a foreign exclusive', 'shared', wsHolds(), true],
  ['exclusive over a foreign exclusive', 'exclusive', wsHolds(), true],
  ['exclusive over a foreign shared', 'exclusive', wsHolds(holder({ mode: 'shared' })), true],
  ['shared alongside a foreign shared', 'shared', wsHolds(holder({ mode: 'shared' })), false],
  ["exclusive over the caller's own hold", 'exclusive', wsHolds(holder({ owner: 'su-1' })), false],
  ['exclusive with a different resource held', 'exclusive', wsHolds(holder({ resource: 'other' })), false],
];

function violations(impl: Impl): string[] {
  return CONTRACT.filter(([, mode, foreign, mustConflict]) => {
    const got = impl({ resource: 'libs-papercusp-submodule', requestedMode: mode, owner: 'su-1', foreign }).length > 0;
    return got !== mustConflict;
  }).map(([label]) => label);
}

describe('falsifiability of the guard contract', () => {
  it('CALIBRATION — the real implementation satisfies every case', () => {
    expect(violations(selectCrossDomainConflicts)).toEqual([]);
  });

  it('CONTROL — a fail-OPEN implementation (the pre-fix behaviour) is CAUGHT', () => {
    // If this ever passes, the contract stopped testing the thing the defect was.
    expect(violations(failsOpen)).toEqual([
      'shared over a foreign exclusive',
      'exclusive over a foreign exclusive',
      'exclusive over a foreign shared',
    ]);
  });

  it('CONTROL — an over-refusing implementation is CAUGHT (the guard must not be a blanket refusal)', () => {
    expect(violations(ignoresMode)).toEqual(['shared alongside a foreign shared']);
  });
});
