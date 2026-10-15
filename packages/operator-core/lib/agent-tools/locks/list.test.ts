/**
 * list.test.ts — locks:list HANDLER domain-resolution behavior
 * (EI-18674647773291145 Defect 2). `readResourceQueue` / `getResource` /
 * `listResources` are mocked; this catches a regression where the tool
 * silently reports `holders: []` for a host-global resource (e.g.
 * 'release-deploy') because it only ever queried the caller's own
 * tree-scoped coordination domain instead of following the resource into
 * the fixed `hostGlobalLockDomain()` it actually acquires under — the exact
 * failure observed live (`locks:list { resource: 'release-deploy' }`
 * returning `holders: []` for a lock provably held elsewhere).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/locks/list.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
import { shapeLocksList } from './list-shape';

vi.mock('./identity', () => ({
  readIdentity: vi.fn(() => ({ ownerId: 'me', ownerLabel: 'Me', coordinationDomain: '/caller/tree' })),
}));
vi.mock('./coordination-domain', () => ({
  hostGlobalLockDomain: vi.fn(() => 'papercusp-host-global'),
  HOST_GLOBAL_RESOURCES: new Set(['release-deploy']),
  // WI-5960: a `git-sync:<slug>` (or any workspace-scoped) resource's system-side
  // acquirer keys itself by workspace, not by the caller's tree — a distinct
  // domain from BOTH the caller domain and hostGlobalLockDomain so the merge/
  // routing tests below can tell the three apart.
  isWorkspaceScopedResource: vi.fn((r: string) => r.startsWith('git-sync:')),
  workspaceScopedLockDomain: vi.fn(() => 'ws-scoped-domain'),
}));
vi.mock('./su-lock-store', () => ({
  getTxPool: vi.fn(() => ({})),
  getResource: vi.fn(),
  listResources: vi.fn(),
  readResourceQueue: vi.fn(),
  // EI-24434173247501787: domains holding a live lease, discovered by name.
  // Default: none beyond the three the process computes.
  listLiveResourceDomains: vi.fn(async (): Promise<string[]> => []),
  // EI-20192110087737961: the handler now also measures the FILE plane.
  readQueue: vi.fn(async () => ({ active_locks: [], waiting: [] })),
}));

import {
  getResource,
  listResources,
  listLiveResourceDomains,
  readResourceQueue,
  readQueue,
  type ActiveLockRow,
  type WaiterRow,
} from './su-lock-store';
const liveDomainsM = vi.mocked(listLiveResourceDomains);
const getResourceM = vi.mocked(getResource);
const listResourcesM = vi.mocked(listResources);
const queueM = vi.mocked(readResourceQueue);
const fileQueueM = vi.mocked(readQueue);

const tool = (await import('./list')).default;
type Out = {
  data: {
    ok: boolean;
    // EI-22073686775053989: `resources[]` rows are DENORMALIZED with their own
    // `holders` + `held`. This local mirror of the handler's `{data}` envelope
    // must carry it — omitting it is not a lax annotation but a false one: the
    // describe block below reads `b.data.resources`, so a missing key here is a
    // TS2339 that reads as "the tool does not return resources" when the tool
    // very much does (list.ts builds `resourcesWithHolders`).
    resources: Array<{
      resource: string;
      description: string;
      rule_text: string;
      enforcement: string;
      holders: unknown[];
      held: boolean;
    }>;
    holders: unknown[];
    draining: boolean;
    plane: string;
    fileLockHint: string;
    // EI-20197228449443651: the narrowing is reported ON the aggregate, so a
    // bounded read can never be mistaken for a complete census.
    registryCount: {
      total: number;
      matched: number;
      returned: number;
      truncatedByLimit: boolean;
      qApplied: boolean;
      qIgnoredResourceScoped: boolean;
    };
    // EI-20192110087737961: the measured FILE plane, returned beside the
    // named-resource one.
    fileLocks: {
      plane: string;
      activeCount: number | null;
      waitingCount: number | null;
      distinctHolders: number | null;
      holders: Array<{ owner: string; pathCount: number; paths: string[] }>;
      unreadable?: string;
      readVia: string;
    };
  };
};
const call = (args: Record<string, unknown>) => tool.handler(args as never, {} as never) as Promise<Out>;

const holder = (owner: string, resource = 'dev-server') => ({
  resource,
  owner,
  owner_label: owner,
  mode: 'exclusive' as const,
  status: 'held' as const,
  reason: '',
  lock_id: owner,
  acquired_ts: new Date('2026-01-01T00:00:00Z'),
  expires_ts: new Date('2026-01-01T00:20:00Z'),
  fence_seq: 1,
});

beforeEach(() => vi.clearAllMocks());

/** Resolve the queue mock per-domain: holders only from `heldBy`. Module-scoped
 * so both describe blocks below can share it. */
const heldOnlyIn = (heldBy: string, rows: ReturnType<typeof holder>[], draining = false) =>
  mockImplementationTyped(queueM, async (_pool, params) =>
    params.coordinationDomain === heldBy ? { holders: rows, draining } : { holders: [], draining: false },
  );

describe('locks:list — host-global domain resolution (EI-18674647773291145)', () => {
  it('makes the workspace-global scope and resource-only filter explicit', () => {
    expect(tool.name).toBe('locks:list');
    expect(tool.capability).toBe('locks:read');
    expect(tool.description).toContain('workspace-global lock diagnostic: omit workspace/harness');
    expect(tool.guidance?.chaining).toContain('omit workspace/harness');
    expect(tool.args.safeParse({}).success).toBe(true);
    expect(tool.args.safeParse({ resource: 'dev-server' }).success).toBe(true);
    expect(tool.args.safeParse({ workspace: 'papercusp-workspace' }).success).toBe(false);
  });

  it('returns a lock_id only for the caller and preserves it in flat and nested default-shaped holder rows', async () => {
    mockResolvedTyped(listResourcesM, [
      {
        resource: 'dev-server',
        description: '',
        rule_text: 'rule text',
        enforcement: 'advisory',
        match_patterns: [],
        max_holders: null,
      },
    ]);
    heldOnlyIn('/caller/tree', [
      { ...holder('me'), lock_id: 'self-lock-id' },
      { ...holder('peer-agent'), lock_id: 'peer-lock-id' },
    ]);

    const b = await call({});
    const shaped = shapeLocksList(b.data, 'trimmed') as {
      holders: Array<{ owner: string; lock_id: string | null }>;
      resources: Array<{ holders: Array<{ owner: string; lock_id: string | null }> }>;
    };
    const expected = expect.arrayContaining([
      expect.objectContaining({ owner: 'me', lock_id: 'self-lock-id' }),
      expect.objectContaining({ owner: 'peer-agent', lock_id: null }),
    ]);

    expect(shaped.holders).toEqual(expected);
    expect(shaped.resources[0]?.holders).toEqual(expected);
    expect(JSON.stringify(shaped)).not.toContain('peer-lock-id');
  });

  // EI-21733256625452096: these three assert a SCOPED query reaches the domain
  // the resource is really acquired under. They used to also assert it queried
  // ONLY that one domain (`toHaveBeenCalledTimes(1)`), inferring the domain from
  // the resource NAME. That exclusivity was the defect: a name that matches
  // neither HOST_GLOBAL_RESOURCES nor isWorkspaceScopedResource() resolved to the
  // caller's tree and reported a false `holders: []` for a lock held elsewhere.
  // The contract is now "query every candidate domain and merge", so each test
  // supplies the holder from ONLY the domain that genuinely holds it — which
  // proves the merge attributes it correctly rather than just counting calls.
  const ALL_DOMAINS = ['/caller/tree', 'papercusp-host-global', 'ws-scoped-domain'];

  const domainsQueried = () =>
    queueM.mock.calls.map((c) => (c[1] as { coordinationDomain: string }).coordinationDomain);

  it('scoped to a host-global resource: reaches hostGlobalLockDomain', async () => {
    getResourceM.mockResolvedValue({ resource: 'release-deploy', description: '', rule_text: '', enforcement: 'enforced' } as never);
    heldOnlyIn('papercusp-host-global', [holder('release-deploy:123:uuid', 'release-deploy')]);

    const b = await call({ resource: 'release-deploy' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: 'papercusp-host-global',
      resource: 'release-deploy',
    });
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: 'papercusp-host-global' });
  });

  it('scoped to an ordinary resource: reaches the caller domain', async () => {
    getResourceM.mockResolvedValue({ resource: 'dev-server', description: '', rule_text: '', enforcement: 'enforced' } as never);
    heldOnlyIn('/caller/tree', [holder('some-agent')]);

    const b = await call({ resource: 'dev-server' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(queueM).toHaveBeenCalledWith(expect.anything(), {
      coordinationDomain: '/caller/tree',
      resource: 'dev-server',
    });
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: '/caller/tree' });
  });

  // WI-5960: the exact live incident — an agent held `exclusive(git-sync:papercusp)`
  // (correctly landing in workspaceScopedLockDomain()) and `locks:list` reported
  // it as unheld because it only ever queried the caller's tree-scoped domain.
  it('scoped to a workspace-scoped resource (git-sync:<slug>): reaches workspaceScopedLockDomain', async () => {
    getResourceM.mockResolvedValue({ resource: 'git-sync:papercusp', description: '', rule_text: '', enforcement: 'advisory' } as never);
    heldOnlyIn('ws-scoped-domain', [holder('system:git-sync', 'git-sync:papercusp')]);

    const b = await call({ resource: 'git-sync:papercusp' });

    expect(domainsQueried()).toEqual(expect.arrayContaining(ALL_DOMAINS));
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ coordination_domain: 'ws-scoped-domain' });
  });

  // EI-21733256625452096 — THE REGRESSION GUARD. `libs-papercusp-submodule` is a
  // human-registered `trigger_config.extra_lock_resources` name. git-sync acquires
  // every lock in its set, extras included, under one `cd = workspaceId || '*'`
  // (git-sync-action.ts `handleGitSync`), but the name matches neither
  // HOST_GLOBAL_RESOURCES nor isWorkspaceScopedResource() — so the old
  // name-inferring branch looked in the caller's tree and returned `holders: []`
  // for a lock that was held, exclusive and unexpired, in the workspace domain
  // (falsified against agent_resource_locks 21:20:11Z, reproduced 8 min apart).
  // A false `holders: []` is not a missing answer, it reads as permission to
  // proceed on a resource a peer holds, and enforcement here is `advisory`.
  it('scoped to a name that advertises NO domain but is held in the workspace domain: still reports the holder', async () => {
    mockResolvedTyped(getResourceM, {
      resource: 'libs-papercusp-submodule',
      description: '',
      rule_text: '',
      enforcement: 'advisory',
      match_patterns: [],
      max_holders: null,
    });
    heldOnlyIn('ws-scoped-domain', [holder('system:git-sync:1856221:ff20faa8', 'libs-papercusp-submodule')]);

    const b = await call({ resource: 'libs-papercusp-submodule' });

    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({
      resource: 'libs-papercusp-submodule',
      owner: 'system:git-sync:1856221:ff20faa8',
      coordination_domain: 'ws-scoped-domain',
    });
  });

  // EI-24434173247501787: the caller-tree domain is the SERVING operator's
  // checkout. A lease taken through the other operator (:3070 papercup-release
  // vs :3170 papercusp-staging) lives in a domain none of the three computed
  // domains names; measured 2026-09-27, this read reported `holders: []` for a
  // benchmark rig held exclusive through the other operator.
  it('scoped to an undeclared resource held through ANOTHER checkout: reports the holder and its domain', async () => {
    mockResolvedTyped(getResourceM, {
      resource: 'p013-benchmark-rig',
      description: '',
      rule_text: '',
      enforcement: 'advisory',
      match_patterns: [],
      max_holders: null,
    });
    liveDomainsM.mockResolvedValueOnce(['/other/checkout']);
    heldOnlyIn('/other/checkout', [holder('su-rig-holder', 'p013-benchmark-rig')]);

    const b = await call({ resource: 'p013-benchmark-rig' });

    expect(liveDomainsM).toHaveBeenCalledWith(expect.anything(), 'p013-benchmark-rig');
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({
      owner: 'su-rig-holder',
      coordination_domain: '/other/checkout',
    });
    expect(b.data.resources[0]).toMatchObject({ resource: 'p013-benchmark-rig', held: true });
  });

  it('unscoped listing also reads every domain that holds a live lease, not only the three computed ones', async () => {
    listResourcesM.mockResolvedValue([]);
    liveDomainsM.mockResolvedValueOnce(['/other/checkout', 'papercusp-host-global']);
    heldOnlyIn('/other/checkout', [holder('su-rig-holder', 'p013-benchmark-rig')]);

    const b = await call({});

    expect(liveDomainsM).toHaveBeenCalledWith(expect.anything(), undefined);
    const domains = queueM.mock.calls.map((c) => c[1].coordinationDomain);
    // de-duplicated: host-global is both computed and live, read once
    expect(domains.sort()).toEqual(['/caller/tree', '/other/checkout', 'papercusp-host-global', 'ws-scoped-domain']);
    expect(b.data.holders).toEqual([expect.objectContaining({ owner: 'su-rig-holder', coordination_domain: '/other/checkout' })]);
  });

  it('unscoped listing merges the caller domain, host-global domain, AND workspace-scoped domain, OR-ing draining', async () => {
    listResourcesM.mockResolvedValue([]);
    queueM
      .mockResolvedValueOnce({ holders: [holder('caller-owner')], draining: false })
      .mockResolvedValueOnce({ holders: [holder('release-deploy:999:uuid', 'release-deploy')], draining: true })
      .mockResolvedValueOnce({ holders: [holder('system:git-sync', 'git-sync:papercusp')], draining: false });

    const b = await call({});

    expect(queueM).toHaveBeenCalledTimes(3);
    expect(queueM).toHaveBeenNthCalledWith(1, expect.anything(), { coordinationDomain: '/caller/tree', resource: undefined });
    expect(queueM).toHaveBeenNthCalledWith(2, expect.anything(), { coordinationDomain: 'papercusp-host-global', resource: undefined });
    expect(queueM).toHaveBeenNthCalledWith(3, expect.anything(), { coordinationDomain: 'ws-scoped-domain', resource: undefined });
    expect(b.data.holders).toHaveLength(3);
    expect(b.data.draining).toBe(true);
    expect(b.data.holders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ owner: 'caller-owner', resource: 'dev-server' }),
        expect.objectContaining({ owner: 'release-deploy:999:uuid', resource: 'release-deploy' }),
        expect.objectContaining({ owner: 'system:git-sync', resource: 'git-sync:papercusp' }),
      ]),
    );
  });

  it('marks the resource plane and routes file-holder checks to locks:queue', async () => {
    listResourcesM.mockResolvedValue([]);
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({});

    expect(b.data.plane).toBe('resource');
    expect(b.data.fileLockHint).toContain('locks:queue { paths: [...] }');
    expect(b.data.fileLockHint).not.toContain('locks:list { paths');
  });
});

// EI-22073686775053989: `resources[]` used to carry no `owner`/`holders` field
// at all — `holders` was ONLY a top-level sibling array — so both natural-
// looking reads (`r.owner`, `r.holders ?? []`) silently produced a confident,
// well-formed "free" for a resource that was actually held. These assert the
// fix: each resources[] row is denormalized with its OWN `holders` array
// (in sync with the flat top-level one) and a `held` boolean.
describe('locks:list — resources[] denormalized with holders (EI-22073686775053989)', () => {
  const registryRow = (resource: string) =>
    ({ resource, description: '', rule_text: 'rule text', enforcement: 'enforced' as const });

  it('a HELD registered resource carries its holder nested under resources[].holders, and held:true', async () => {
    listResourcesM.mockResolvedValue([registryRow('git-sync:portal') as never]);
    mockImplementationTyped(queueM, async (_pool, params) =>
      params.coordinationDomain === '/caller/tree'
        ? { holders: [holder('su-202a8f71', 'git-sync:portal')], draining: false }
        : { holders: [], draining: false },
    );

    const b = await call({});

    const [resourceRow] = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    expect(resourceRow.resource).toBe('git-sync:portal');
    expect(resourceRow.held).toBe(true);
    expect(resourceRow.holders).toHaveLength(1);
    expect(resourceRow.holders[0]).toMatchObject({ resource: 'git-sync:portal', owner: 'su-202a8f71' });
    // The nested view and the flat top-level view must never disagree.
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ resource: 'git-sync:portal', owner: 'su-202a8f71' });
  });

  it('a FREE registered resource reports a MEASURED empty: holders:[] and held:false (never a missing key)', async () => {
    listResourcesM.mockResolvedValue([registryRow('dev-server') as never]);
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({});

    const [resourceRow] = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    expect(resourceRow.resource).toBe('dev-server');
    expect(resourceRow.held).toBe(false);
    expect(resourceRow.holders).toEqual([]);
  });

  it('two registered resources, one held one free: each gets ONLY its own holders, not the other’s', async () => {
    listResourcesM.mockResolvedValue([registryRow('dev-server') as never, registryRow('release-deploy') as never]);
    heldOnlyIn('papercusp-host-global', [holder('release-deploy:1:uuid', 'release-deploy')]);

    const b = await call({});

    const rows = b.data.resources as Array<{ resource: string; holders: unknown[]; held: boolean }>;
    const devServer = rows.find((r) => r.resource === 'dev-server')!;
    const releaseDeploy = rows.find((r) => r.resource === 'release-deploy')!;
    expect(devServer.held).toBe(false);
    expect(devServer.holders).toEqual([]);
    expect(releaseDeploy.held).toBe(true);
    expect(releaseDeploy.holders).toHaveLength(1);
  });
});

/**
 * EI-20192110087737961 — the primary lock read surface must MEASURE the file
 * plane, not merely point at it.
 *
 * The pointer these tests supersede (`fileLockHint`, EI-19400582907190258) is
 * still asserted above and still correct; what it could not do was survive
 * contact with a reader. It shipped 2026-08-03; this item was filed 2026-08-11
 * by an agent who read `locks:list`, concluded it "did not show repository file
 * locks", and went and found `locks:queue` themselves.
 */
describe('locks:list — the FILE plane is measured, not just pointed at (EI-20192110087737961)', () => {
  /** A COMPLETE ActiveLockRow with a narrow override seam, so the fixture is
   * genuinely typechecked against the store signature rather than cast past it
   * (lint:mock-cast-escape is shrink-only). If ActiveLockRow gains a required
   * field, this factory fails to compile — which is the point. */
  const activeRow = (over: Partial<ActiveLockRow> = {}): ActiveLockRow => ({
    lock_id: 'LOCK-1',
    path: 'packages/x.ts',
    owner: 'peer-1',
    owner_label: 'Peer One',
    intent: 'rewriting the guard',
    goal_ref: null,
    acquired_ts: new Date('2026-01-01T00:00:00Z'),
    expires_ts: new Date('2026-01-01T00:20:00Z'),
    coordination_domain: '/some/tree',
    ...over,
  });
  /** No `Partial` override seam here, deliberately: WaiterRow carries OPTIONAL
   * fields, and spreading a Partial over them republishes each as
   * `T | undefined`, which is not assignable back to the optional property.
   * Nothing in this block needs to vary a waiter, so the seam would buy a type
   * error and no coverage. */
  const waiterRow = (): WaiterRow => ({
    ticket_id: 'T-1',
    owner: 'peer-2',
    owner_label: 'Peer Two',
    paths: ['packages/x.ts'],
    intent: 'waiting to edit',
    goal_ref: null,
    queued_ts: new Date('2026-01-01T00:01:00Z'),
    wait_until: new Date('2026-01-01T00:21:00Z'),
    status: 'waiting',
    coordination_domain: '/some/tree',
  });
  const fileQueue = (active: ActiveLockRow[], waiting: WaiterRow[] = []) =>
    mockResolvedTyped(fileQueueM, { active_locks: active, waiting });

  /** Local + typed: the sibling describe's `registryRow` is scoped to that
   * block, and deriving the row type from the store signature keeps this
   * fixture honest without another `as never`. */
  type RegistryRow = Awaited<ReturnType<typeof listResources>>[number];
  const registryRow = (resource: string): RegistryRow =>
    ({ resource, description: '', rule_text: 'rule text', enforcement: 'enforced' }) as RegistryRow;

  beforeEach(() => {
    mockResolvedTyped(listResourcesM, [registryRow('dev-server')]);
    heldOnlyIn('/caller/tree', []);
  });

  it('returns a measured file-lock count beside the named-resource holders', async () => {
    fileQueue(
      [
        activeRow({ path: 'packages/x.ts' }),
        activeRow({ path: 'packages/y.ts', lock_id: 'LOCK-2' }),
      ],
      [waiterRow()],
    );

    const b = await call({});

    // The named-resource plane is empty here — which is exactly the reading the
    // item says gets mistaken for "nothing is locked". The measured block sits
    // beside it and contradicts that reading with a number.
    expect(b.data.holders).toEqual([]);
    expect(b.data.fileLocks.activeCount).toBe(2);
    expect(b.data.fileLocks.waitingCount).toBe(1);
    expect(b.data.fileLocks.distinctHolders).toBe(1);
    expect(b.data.fileLocks.holders[0]).toMatchObject({ owner: 'peer-1', pathCount: 2 });
  });

  it('measures the file plane on a {resource}-SCOPED call too', async () => {
    // A caller who narrowed to one resource is if anything MORE likely to read
    // the resulting empty holders[] as a verdict about their own file.
    mockResolvedTyped(getResourceM, registryRow('dev-server'));
    fileQueue([activeRow({ path: 'a.ts' })]);

    const b = await call({ resource: 'dev-server' });
    expect(b.data.fileLocks.activeCount).toBe(1);
  });

  it('reads across EVERY coordination domain, not the caller’s', async () => {
    // readIdentity is mocked to '/caller/tree'; a domain-scoped read reports a
    // genuinely-held lock as absent when the serving operator and the edited
    // checkout differ (:3070 vs :3170, WI-5979).
    fileQueue([]);
    await call({});
    expect(fileQueueM).toHaveBeenCalledWith(expect.anything(), { coordinationDomain: null });
  });

  it('does NOT report zero file locks when the file-lock read fails', async () => {
    // The regression this guards is a silent downgrade of the failure path to
    // `activeCount: 0` — which would be strictly worse than the empty array it
    // replaced, because a confident wrong number outranks a hint just as
    // reliably as a right one.
    fileQueueM.mockRejectedValue(new Error('lock plane unreachable'));

    const b = await call({});

    expect(b.data.fileLocks.activeCount).toBeNull();
    expect(b.data.fileLocks.activeCount).not.toBe(0);
    expect(b.data.fileLocks.unreadable).toContain('lock plane unreachable');
    // …and the rest of the tool still answers: a file-plane failure must not
    // take the named-resource answer down with it.
    expect(b.data.ok).toBe(true);
    expect(b.data.resources).toHaveLength(1);
  });

  it('routes the hint at the measured block rather than standing in for one', async () => {
    fileQueue([]);
    const b = await call({});
    expect(b.data.fileLockHint).toContain('fileLocks');
    expect(b.data.fileLockHint).toContain('locks:queue { paths: [...] }');
  });
});

// EI-20197228449443651: the registry is 518 rows live, and the only expressible
// reads were ONE exact `resource` or the whole firehose — so `{limit:100}` was
// rejected as unsupported. `q`/`limit` make a bounded browse statable. The load-
// bearing constraint is that they narrow the REGISTRY view ONLY: every prior fix
// in list.ts (EI-18674647773291145, WI-5960, EI-21733256625452096,
// EI-22073686775053989) was an under-reported holder reading as "free", so a
// browse filter that could narrow holders[] would reintroduce that whole class.
describe('locks:list — bounded registry browse via q/limit (EI-20197228449443651)', () => {
  /** Derived from the store signature and spelled out in FULL — no `as never`,
   * and no inner cast either, so a row type that gains a required field fails
   * here at typecheck instead of rotting into a runtime failure at the fleet
   * green-checkpoint (which is exactly what the cast the ratchet counts buys). */
  type RegistryRow = Awaited<ReturnType<typeof listResources>>[number];
  const registryRow = (resource: string): RegistryRow => ({
    resource,
    description: '',
    rule_text: 'rule text',
    enforcement: 'advisory',
    match_patterns: [],
    max_holders: null,
  });

  const registry = (...names: string[]) =>
    mockResolvedTyped(listResourcesM, names.map((n) => registryRow(n)));

  it('accepts q/limit and still rejects unknown args and out-of-range limits', () => {
    expect(tool.args.safeParse({ q: 'git-sync' }).success).toBe(true);
    expect(tool.args.safeParse({ limit: 100 }).success).toBe(true);
    expect(tool.args.safeParse({ q: 'git-sync', limit: 5 }).success).toBe(true);
    // The rejection that filed this item must stay a rejection for genuinely
    // unsupported shapes — widening `limit` is not licence to accept anything.
    expect(tool.args.safeParse({ workspace: 'papercusp-workspace' }).success).toBe(false);
    expect(tool.args.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ limit: 501 }).success).toBe(false);
    expect(tool.args.safeParse({ limit: 2.5 }).success).toBe(false);
  });

  it('q filters resources[] by name, case-insensitively', async () => {
    registry('git-sync:portal', 'GIT-SYNC:calendar', 'dev-server', 'db-schema');
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({ q: 'git-sync' });

    expect(b.data.resources.map((r) => r.resource)).toEqual(['git-sync:portal', 'GIT-SYNC:calendar']);
    expect(b.data.registryCount).toMatchObject({ total: 4, matched: 2, returned: 2, qApplied: true });
  });

  it('limit bounds resources[] AFTER q, and the aggregate says the read was bounded', async () => {
    registry('git-sync:a', 'git-sync:b', 'git-sync:c', 'dev-server');
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({ q: 'git-sync', limit: 2 });

    expect(b.data.resources.map((r) => r.resource)).toEqual(['git-sync:a', 'git-sync:b']);
    expect(b.data.registryCount).toMatchObject({
      total: 4,
      matched: 3,
      returned: 2,
      truncatedByLimit: true,
    });
  });

  it('an unbounded read reports truncatedByLimit:false — a complete census is distinguishable', async () => {
    registry('dev-server', 'db-schema');
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({});

    expect(b.data.registryCount).toMatchObject({
      total: 2,
      matched: 2,
      returned: 2,
      truncatedByLimit: false,
      qApplied: false,
    });
  });

  // THE INVARIANT THIS FEATURE MUST NOT BREAK. A filter that narrowed holders[]
  // would let a caller browse the registry and read a MISSING holder as "free"
  // — the exact false-empty that EI-18674647773291145 / WI-5960 /
  // EI-21733256625452096 / EI-22073686775053989 each fixed. Over-reporting a
  // holder is safe (a reader waits); under-reporting reads as permission to
  // write on a resource a peer holds, on rows whose enforcement is `advisory`.
  it('neither q nor limit may narrow holders[]: a holder OUTSIDE the filter is still reported', async () => {
    registry('git-sync:portal', 'dev-server');
    heldOnlyIn('/caller/tree', [holder('peer-agent', 'dev-server')]);

    const b = await call({ q: 'git-sync', limit: 1 });

    // dev-server is filtered OUT of the registry view...
    expect(b.data.resources.map((r) => r.resource)).toEqual(['git-sync:portal']);
    // ...but its holder is still on the holder plane, un-narrowed.
    expect(b.data.holders).toHaveLength(1);
    expect(b.data.holders[0]).toMatchObject({ resource: 'dev-server', owner: 'peer-agent' });
  });

  it('a q that matches nothing is a MEASURED empty, not an empty registry', async () => {
    registry('dev-server', 'db-schema');
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({ q: 'no-such-resource' });

    expect(b.data.resources).toEqual([]);
    // total > 0 beside matched === 0 is what tells the two apart.
    expect(b.data.registryCount).toMatchObject({ total: 2, matched: 0, returned: 0, qApplied: true });
  });

  it('q alongside the exact `resource` selector is IGNORED — and says so rather than silently', async () => {
    mockResolvedTyped(getResourceM, registryRow('dev-server'));
    queueM.mockResolvedValue({ holders: [], draining: false });

    const b = await call({ resource: 'dev-server', q: 'git-sync' });

    // The exact selector wins; the filter that would have excluded it does not
    // silently empty the result.
    expect(b.data.resources.map((r) => r.resource)).toEqual(['dev-server']);
    expect(b.data.registryCount).toMatchObject({
      qApplied: false,
      qIgnoredResourceScoped: true,
    });
  });
});

describe('locks:list — transient PostgreSQL connection retry', () => {
  type RegistryRow = Awaited<ReturnType<typeof listResources>>[number];

  it('retries CONNECT_TIMEOUT on the exact resource read and returns the measured holder result', async () => {
    const resource = 'git-sync:papercusp';
    const row: RegistryRow = {
      resource,
      description: '',
      rule_text: 'rule text',
      enforcement: 'advisory',
      match_patterns: [],
      max_holders: null,
    };
    const connectTimeout = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
      code: 'CONNECT_TIMEOUT' as const,
    });

    getResourceM.mockRejectedValueOnce(connectTimeout).mockResolvedValueOnce(row);
    liveDomainsM.mockResolvedValue(['ws-scoped-domain']);
    queueM.mockResolvedValue({ holders: [], draining: false });

    const result = await call({ resource });

    expect(getResourceM).toHaveBeenCalledTimes(2);
    expect(result.data.resources).toMatchObject([{ resource, holders: [], held: false }]);
    expect(result.data.ok).toBe(true);
  });
});
