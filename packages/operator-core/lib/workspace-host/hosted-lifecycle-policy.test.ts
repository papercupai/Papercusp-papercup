import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HOSTED_LIFECYCLE_POLICY,
  classifyHostedLifecycleJob,
  evaluateHostedIdleStop,
  evaluateHostedLifecycleAdmission,
  evaluateHostedPoolResourceAdmission,
  evaluateHostedPoolCapacity,
  HOSTED_POOL_RESOURCE_QUOTAS,
  HOSTED_POOL_TRIAL_DB_GIB,
  type HostedPoolResourceAdmissionInput,
  type HostedPoolResources,
  type HostedPoolCapacityInput,
  type HostedPoolCapacityHost,
  type HostedLifecycleAdmissionRequest,
} from './hosted-lifecycle-policy';
import type { ResolvedHostedEntitlements } from '../auth/hosted-entitlements';

const request: HostedLifecycleAdmissionRequest = {
  action: 'start',
  riskTier: 'moderate',
  approvalStatus: 'not-required',
  estimate: {
    cents: 1_500,
    currency: 'USD',
    source: 'gcp-catalog-v1',
    evidenceRef: 'gcp://catalog/e2-small/2026-08-28',
    estimatedAt: '2026-08-28T00:00:00Z',
  },
  billingOwner: { kind: 'organization', id: 'org-1' },
};

const emptyResources = (): HostedPoolResources => ({ agents: 0, hosts: 0, cpuMillicores: 0, memoryMiB: 0, dbGiB: 0, workspaceGiB: 0 });
function poolInput(): HostedPoolResourceAdmissionInput {
  const entitlements: ResolvedHostedEntitlements = {
    organizationId: 'org-1', assignmentId: 'assignment-1', bundleId: 'trial', bundleVersion: 1,
    appliedOverrides: [], auditReceiptIds: ['receipt-1'], recheckAt: null,
    allowedProviders: ['gcp', 'aws'], limits: { workspaces: 1, members: 1 },
    browserAccess: { pty: true, files: true }, supportTier: 'trial', rolloutFlags: {},
    quotas: { 'pool.agents': 2, 'pool.hosts': 1, 'pool.cpu-millicores': 8000,
      'pool.memory-mib': 32768, 'pool.db-gib': HOSTED_POOL_TRIAL_DB_GIB, 'pool.workspace-gib': 32 },
    budgets: { 'pool.cost.usd.minor': 10000 },
  };
  return { organizationId: 'org-1', entitlements, nowMs: 1000,
    allocated: emptyResources(), pending: emptyResources(),
    requested: { agents: 1, hosts: 1, cpuMillicores: 4000, memoryMiB: 16384, dbGiB: 256, workspaceGiB: 16 },
    budget: { currency: 'USD', usedMinor: 0, pendingMinor: 0, requestedMinor: 1500 },
    capacity: { freeHosts: 2, reservedForOtherCustomers: 0, olderBurstWaiters: 0 } };
}

describe('hosted pool resource policy (P-537)', () => {
  it('admits a fresh 256GiB trial with unit-bearing allowance and audit receipts', () => {
    const decision = evaluateHostedPoolResourceAdmission(poolInput());
    expect(decision).toMatchObject({ allowed: true, guaranteed: false, reasons: [] });
    expect(decision.audit).toHaveLength(7);
    expect(decision.audit.every(row => row.assignmentId === 'assignment-1' && row.organizationId === 'org-1')).toBe(true);
  });

  it.each(Object.keys(HOSTED_POOL_RESOURCE_QUOTAS) as Array<keyof HostedPoolResources>)(
    'counts pending %s before the first reservation starts', resource => {
      const input = poolInput();
      input.pending[resource] = input.entitlements!.quotas[HOSTED_POOL_RESOURCE_QUOTAS[resource]];
      expect(evaluateHostedPoolResourceAdmission(input).reasons)
        .toContain(`${HOSTED_POOL_RESOURCE_QUOTAS[resource]}: quota_exceeded`);
    },
  );

  it('includes pending money and refuses missing or wrong-currency budget authority', () => {
    const input = poolInput();
    input.budget.pendingMinor = 9000;
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('pool cost: budget_exceeded');
    input.budget.currency = 'EUR';
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('pool cost: budget_missing');
  });

  it('refuses absent, foreign, expired or unaudited authority', () => {
    for (const change of [null, { organizationId: 'org-2' }, { recheckAt: new Date(1000) }, { auditReceiptIds: [] }]) {
      const input = poolInput();
      input.entitlements = change === null ? null : { ...input.entitlements!, ...change };
      expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(false);
    }
  });

  it('uses allowances rather than a paid label, and applies upgrades and downgrades to new demand', () => {
    const input = poolInput();
    input.requested.agents = 3;
    input.entitlements = { ...input.entitlements!, bundleId: 'paid', supportTier: 'paid' };
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(false);
    input.entitlements = { ...input.entitlements!, quotas: { ...input.entitlements!.quotas, 'pool.agents': 4 } };
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(true);
    input.allocated.agents = 4;
    input.requested = emptyResources();
    input.budget.requestedMinor = 0;
    input.entitlements = { ...input.entitlements!, quotas: { ...input.entitlements!.quotas, 'pool.agents': 1 } };
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(true);
    input.requested.agents = 1;
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(false);
  });

  it('protects other tenants reservations and admits guaranteed work ahead of burst waiters', () => {
    const input = poolInput();
    input.capacity = { freeHosts: 2, reservedForOtherCustomers: 2, olderBurstWaiters: 0 };
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('pool capacity reserved or exhausted');
    input.capacity = { freeHosts: 2, reservedForOtherCustomers: 1, olderBurstWaiters: 1 };
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('older pool burst requests have priority');
    input.entitlements = { ...input.entitlements!, quotas: { ...input.entitlements!.quotas, 'pool.reserved-hosts': 1 } };
    expect(evaluateHostedPoolResourceAdmission(input)).toMatchObject({ allowed: true, guaranteed: true });
  });

  it('allows provisioning without consuming protected warm inventory, while retaining burst order', () => {
    const input = poolInput();
    Object.assign(input.capacity, { freeHosts: 0, requestedWarmHosts: 0 });
    expect(evaluateHostedPoolResourceAdmission(input)).toMatchObject({ allowed: true, guaranteed: false });
    input.capacity.olderBurstWaiters = 1;
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('older pool burst requests have priority');
  });

  it('lets paid guarantees compete for a short pool without mutually reserving it forever', () => {
    const input = poolInput();
    input.capacity = { freeHosts: 1, reservedForOtherCustomers: 1, olderBurstWaiters: 1 };
    input.entitlements = { ...input.entitlements!, quotas: { ...input.entitlements!.quotas, 'pool.reserved-hosts': 1 } };
    expect(evaluateHostedPoolResourceAdmission(input)).toMatchObject({ allowed: true, guaranteed: true });
    input.capacity.freeHosts = 0;
    input.capacity.reservedForOtherCustomers = 0;
    expect(evaluateHostedPoolResourceAdmission(input).reasons).toContain('pool capacity reserved or exhausted');
  });

  it.each([NaN, null, -1, 0.5, 2])('refuses invalid warm demand %s', requestedWarmHosts => {
    const input = poolInput();
    Object.assign(input.capacity, { requestedWarmHosts });
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(false);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER])('fails closed on malformed or overflowing demand %s', value => {
    const input = poolInput();
    input.pending.agents = value;
    expect(evaluateHostedPoolResourceAdmission(input).allowed).toBe(false);
  });

  it('holds idle scale-in for running or pending work and unknown work counters', () => {
    const base = { state: 'active', observedState: 'running', lastActivityAt: new Date(0).toISOString(),
      idleStopAfterMinutes: 1, activeLifecycleJobs: 0 };
    for (const activeWork of [
      { activeAgents: 1, pendingAgentStarts: 0, activeCommands: 0 },
      { activeAgents: 0, pendingAgentStarts: 1, activeCommands: 0 },
      { activeAgents: 0, pendingAgentStarts: 0, activeCommands: 1 },
      { activeAgents: NaN, pendingAgentStarts: 0, activeCommands: 0 },
      { activeAgents: 0, pendingAgentStarts: 0, activeCommands: undefined as unknown as number },
    ]) expect(evaluateHostedIdleStop({ ...base, activeWork }, 120000))
      .toMatchObject({ due: false, hold: 'active-work' });
    expect(evaluateHostedIdleStop({ ...base, activeWork: { activeAgents: 0, pendingAgentStarts: 0, activeCommands: 0 } }, 120000).due).toBe(true);
  });
});

describe('hosted pool bounded capacity proposals (P-544 preparation)', () => {
  const nowMs = Date.parse('2026-10-17T00:00:00Z');
  function host(hostId: string, state: HostedPoolCapacityHost['state'] = 'ready'): HostedPoolCapacityHost {
    return { hostId, state, generation: 4, controllerFence: 8, observedAtMs: nowMs,
      customerWorkspaceId: null, reservationId: null,
      activity: state === 'ready' ? { state: 'active', observedState: 'running',
        lastActivityAt: new Date(nowMs - 120000).toISOString(), idleStopAfterMinutes: 1,
        activeLifecycleJobs: 0, activeWork: { activeAgents: 0, pendingAgentStarts: 0, activeCommands: 0 },
        desktopViewers: { attachedViewers: 0, lastSeenAt: null, holdSec: 60 } } : null };
  }
  function input(hosts: HostedPoolCapacityHost[] = [], queuedHosts = 1): HostedPoolCapacityInput {
    const admission = poolInput();
    admission.nowMs = nowMs;
    admission.entitlements = { ...admission.entitlements!, quotas: {
      ...admission.entitlements!.quotas, 'pool.hosts': 10,
    } };
    admission.allocated.hosts = hosts.filter(value => value.state === 'ready').length;
    admission.pending.hosts = hosts.filter(value => value.state === 'pending').length;
    admission.capacity.requestedWarmHosts = 0;
    return { nowMs, observedAtMs: nowMs, maxObservationAgeMs: 30000, generation: 11,
      controllerFence: 19, lastChangeAtMs: null, cooldownMs: 60000, queuedHosts,
      minimumSpareHosts: 0, hosts, provision: { profileRef: 'gcp/us-central1/2cpu8g/runtime-1',
        market: 'on-demand', estimate: { ...request.estimate, estimatedAt: new Date(nowMs).toISOString() },
        admission, reclaimRecovery: null } };
  }

  it('proposes only one create for a large deficit with explicit CAS preconditions', () => {
    expect(evaluateHostedPoolCapacity(input([], 50))).toEqual({ kind: 'provision', readyHosts: 0,
      pendingHosts: 0, reasons: [], profileRef: 'gcp/us-central1/2cpu8g/runtime-1',
      market: 'on-demand', generation: 11, controllerFence: 19 });
  });

  it('counts pending creates with ready inventory and supports a zero warm floor', () => {
    expect(evaluateHostedPoolCapacity(input([host('ready'), host('creating', 'pending')], 2)))
      .toMatchObject({ kind: 'hold', readyHosts: 1, pendingHosts: 1 });
    expect(evaluateHostedPoolCapacity(input([], 0))).toMatchObject({ kind: 'hold', reasons: ['pool capacity meets demand'] });
    const floor = input([], 0);
    floor.minimumSpareHosts = 1;
    expect(evaluateHostedPoolCapacity(floor).kind).toBe('provision');
  });

  it('does not count tenant-assigned or reserved hosts as free capacity', () => {
    for (const assignment of [{ customerWorkspaceId: 'tenant-1' }, { reservationId: 'reservation-1' }]) {
      const value = host('occupied');
      Object.assign(value, assignment);
      expect(evaluateHostedPoolCapacity(input([value]))).toMatchObject({ kind: 'provision', readyHosts: 0 });
      expect(evaluateHostedPoolCapacity(input([value], 0)).kind).toBe('hold');
    }
  });

  it.each(['cpuMillicores', 'memoryMiB', 'hosts'] as const)('applies canonical pending %s quota before growth', key => {
    const value = input([host('pending', 'pending')], 2);
    value.provision.admission.pending[key] = value.provision.admission.entitlements!.quotas[HOSTED_POOL_RESOURCE_QUOTAS[key]];
    expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
  });

  it('applies pending spend, missing budget authority and entitlement expiry before growth', () => {
    const value = input();
    value.provision.admission.budget.pendingMinor = 9000;
    expect(evaluateHostedPoolCapacity(value).reasons).toContain('pool cost: budget_exceeded');
    value.provision.admission.budget.pendingMinor = 0;
    value.provision.admission.entitlements = {
      ...value.provision.admission.entitlements!, budgets: {},
    };
    expect(evaluateHostedPoolCapacity(value).reasons).toContain('pool cost: budget_missing');
    value.provision.admission.entitlements = {
      ...value.provision.admission.entitlements!, recheckAt: new Date(nowMs),
    };
    expect(evaluateHostedPoolCapacity(value).reasons).toContain('pool entitlement authority missing, foreign or stale');
  });

  it('binds the one-host proposal to its price, currency, resource and inventory reservation', () => {
    const changes: Array<(value: HostedPoolCapacityInput) => void> = [
      value => { value.provision.admission.requested.hosts = 2; },
      value => { value.provision.admission.requested.memoryMiB = 0; },
      value => { value.provision.admission.capacity.requestedWarmHosts = undefined; },
      value => { value.provision.admission.budget.requestedMinor = 1; },
      value => { value.provision.admission.budget.currency = 'EUR'; },
      value => { value.provision.admission.pending.hosts = 1; },
      value => { value.provision.admission.allocated.hosts = 1; },
      value => { value.provision.admission.nowMs--; },
      value => { value.provision.estimate.evidenceRef = ''; },
      value => { value.provision.estimate.estimatedAt = new Date(nowMs + 1).toISOString(); },
      value => { value.provision.estimate.estimatedAt = new Date(nowMs - 30001).toISOString(); },
      value => { value.provision.estimate.cents = 0; value.provision.admission.budget.requestedMinor = 0; },
    ];
    for (const change of changes) {
      const value = input();
      change(value);
      expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    }
  });

  it('refuses stale/future snapshots, bad fences, duplicate hosts and unknown host state/work', () => {
    const changes: Array<(value: HostedPoolCapacityInput) => void> = [
      value => { value.observedAtMs = nowMs + 1; },
      value => { value.observedAtMs = nowMs - 30001; },
      value => { value.generation = 0; },
      value => { value.controllerFence = NaN; },
      value => { value.queuedHosts = Number.MAX_SAFE_INTEGER; value.minimumSpareHosts = 1; },
      value => { value.hosts[0].observedAtMs = nowMs - 30001; },
      value => { value.hosts[0].state = 'unavailable'; },
      value => { value.hosts[0].state = 'draining'; },
      value => { value.hosts[0].activity = null; },
      value => { value.hosts[0].activity!.activeLifecycleJobs = NaN; },
      value => { value.hosts[0].activity!.activeWork = undefined; },
      value => { value.hosts[0].activity!.activeWork!.activeCommands = NaN; },
      value => { value.hosts = [host('same'), host('same')]; },
    ];
    for (const change of changes) {
      const value = input([host('ready')], 2);
      change(value);
      expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    }
  });

  it('holds both directions during cooldown and allows the exact expiry boundary', () => {
    for (const value of [input(), input([host('idle')], 0)]) {
      value.lastChangeAtMs = nowMs - 59999;
      expect(evaluateHostedPoolCapacity(value).reasons).toContain('pool cooldown active');
      value.lastChangeAtMs = nowMs - 60000;
      expect(evaluateHostedPoolCapacity(value).kind).toBe(value.hosts.length ? 'drain' : 'provision');
      value.lastChangeAtMs = nowMs + 1;
      expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    }
  });

  it('requires passing, fresh, profile-specific reclaim recovery evidence for spot', () => {
    const value = input();
    value.provision.market = 'spot';
    expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    const proof = { profileRef: value.provision.profileRef, result: 'passed' as const,
      evidenceRef: 'reclaim-drill:1', verifiedAtMs: nowMs };
    for (const invalid of [{ result: 'failed' as const }, { result: 'unknown' as const },
      { profileRef: 'other-profile' }, { evidenceRef: '' }, { verifiedAtMs: nowMs + 1 },
      { verifiedAtMs: nowMs - 30001 }]) {
      value.provision.reclaimRecovery = { ...proof, ...invalid };
      expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    }
    value.provision.reclaimRecovery = proof;
    expect(evaluateHostedPoolCapacity(value)).toMatchObject({ kind: 'provision', market: 'spot' });
  });

  it('counts assigned running, retained and pending hosts without offering them as spare compute', () => {
    const owned = { ...host('owned'), customerWorkspaceId: 'customer-a', activity: null };
    const retained: HostedPoolCapacityHost = { ...host('stopped', 'retained'), customerWorkspaceId: 'customer-b' };
    const pending = { ...host('queued', 'pending'), customerWorkspaceId: 'customer-c', controllerFence: 0 };
    const value = input([owned, retained, pending]);
    value.provision.admission.allocated.hosts = 2;
    expect(evaluateHostedPoolCapacity(value)).toMatchObject({ kind: 'provision', readyHosts: 0, pendingHosts: 0 });
    retained.customerWorkspaceId = null;
    expect(evaluateHostedPoolCapacity(value)).toMatchObject({ kind: 'hold', reasons: ['retained pool host owner missing'] });
  });

  it('fences initial demand at controller zero while rejecting negative fences and zero-fence ready hosts', () => {
    const value = input();
    value.controllerFence = 0;
    expect(evaluateHostedPoolCapacity(value)).toMatchObject({ kind: 'provision', controllerFence: 0 });
    value.controllerFence = -1;
    expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
    const ready = host('ready');
    ready.controllerFence = 0;
    expect(evaluateHostedPoolCapacity(input([ready], 2)).kind).toBe('hold');
  });

  it('drains one deterministic idle unassigned host while preserving demand and the warm floor', () => {
    const value = input([host('b'), host('a'), host('c')], 1);
    value.minimumSpareHosts = 1;
    expect(evaluateHostedPoolCapacity(value)).toEqual({ kind: 'drain', readyHosts: 3, pendingHosts: 0,
      reasons: [], hostId: 'a', hostGeneration: 4, hostControllerFence: 8, generation: 11, controllerFence: 19 });
    value.queuedHosts = 2;
    expect(evaluateHostedPoolCapacity(value).kind).toBe('hold');
  });

  it('never drains active, assigned, reserved, recently used or unmeasured hosts', () => {
    const changes: Array<(value: HostedPoolCapacityHost) => void> = [
      value => { value.customerWorkspaceId = 'tenant'; },
      value => { value.reservationId = 'reservation'; },
      value => { value.activity!.activeLifecycleJobs = 1; },
      value => { value.activity!.activeWork!.activeAgents = 1; },
      value => { value.activity!.activeWork!.pendingAgentStarts = 1; },
      value => { value.activity!.activeWork!.activeCommands = 1; },
      value => { value.activity!.lastActivityAt = new Date(nowMs - 59999).toISOString(); },
      value => { value.activity!.lastActivityAt = null; },
      value => { value.activity!.idleStopAfterMinutes = null; },
      value => { value.activity!.desktopViewers = null; },
      value => { value.activity!.desktopViewers!.attachedViewers = 1; },
      value => { value.activity!.desktopViewers!.attachedViewers = NaN; },
    ];
    for (const change of changes) {
      const candidate = host('protected');
      change(candidate);
      expect(evaluateHostedPoolCapacity(input([candidate], 0)).kind).toBe('hold');
    }
    expect(evaluateHostedPoolCapacity(input([host('idle'), host('creating', 'pending')], 0)).kind).toBe('hold');
  });
});

describe('hosted lifecycle policy', () => {
  it('admits a provenance-backed job within tenant, provider, budget, and risk limits', () => {
    expect(evaluateHostedLifecycleAdmission(
      { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, monthlyBudgetCents: 10_000 },
      { activeTenantJobs: 1, activeProviderJobs: 2, committedMonthlyCents: 4_000 },
      request,
    )).toEqual({
      allowed: true,
      reasons: [],
      projectedMonthlyCents: 5_500,
      emergencyBypass: false,
    });
  });

  it('fails closed on every admission boundary and missing estimate provenance', () => {
    const decision = evaluateHostedLifecycleAdmission(
      {
        ...DEFAULT_HOSTED_LIFECYCLE_POLICY,
        tenantConcurrencyLimit: 1,
        providerConcurrencyLimit: 2,
        monthlyBudgetCents: 5_000,
      },
      { activeTenantJobs: 1, activeProviderJobs: 2, committedMonthlyCents: 4_000 },
      {
        ...request,
        riskTier: 'critical',
        approvalStatus: 'pending',
        estimate: { ...request.estimate, evidenceRef: '', cents: 1_500 },
      },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      'estimate.evidenceRef is required',
      'risk tier critical requires approval',
      'tenant concurrency limit reached',
      'provider concurrency limit reached',
      'monthly lifecycle budget exceeded',
    ]));
  });

  it('lets only an attributed, reasoned destroy bypass capacity and budget', () => {
    const decision = evaluateHostedLifecycleAdmission(
      { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, monthlyBudgetCents: 0 },
      { activeTenantJobs: 99, activeProviderJobs: 99, committedMonthlyCents: 99_000 },
      {
        ...request,
        action: 'destroy',
        riskTier: 'high',
        approvalStatus: 'approved',
        emergencyTeardown: true,
        teardownReason: 'provider credential revoked; remove orphaned resources',
      },
    );
    expect(decision).toMatchObject({ allowed: true, reasons: [], emergencyBypass: true });

    expect(evaluateHostedLifecycleAdmission(
      DEFAULT_HOSTED_LIFECYCLE_POLICY,
      { activeTenantJobs: 0, activeProviderJobs: 0, committedMonthlyCents: 0 },
      { ...request, emergencyTeardown: true },
    ).reasons).toEqual(expect.arrayContaining([
      'emergency teardown is valid only for destroy',
      'emergency teardown requires a reason',
    ]));
  });

  it('classifies healthy, stuck, orphaned, exhausted, and terminal jobs from the heartbeat writer', () => {
    const policy = { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, stuckAfterMs: 1_000, orphanAfterMs: 5_000 };
    const now = Date.parse('2026-08-28T00:00:10Z');
    const job = {
      status: 'running' as const,
      heartbeatAt: '2026-08-28T00:00:09.500Z',
      updatedAt: '2026-08-28T00:00:00Z',
      recoveryAttempts: 0,
    };
    expect(classifyHostedLifecycleJob(job, policy, now)).toBe('healthy');
    expect(classifyHostedLifecycleJob({ ...job, heartbeatAt: '2026-08-28T00:00:07Z' }, policy, now)).toBe('stuck');
    expect(classifyHostedLifecycleJob({ ...job, heartbeatAt: '2026-08-28T00:00:04Z' }, policy, now)).toBe('orphaned');
    expect(classifyHostedLifecycleJob({ ...job, recoveryAttempts: policy.maxRecoveryAttempts }, policy, now))
      .toBe('recovery-exhausted');
    expect(classifyHostedLifecycleJob({ ...job, status: 'succeeded' }, policy, now)).toBe('terminal');
  });

  // WI-10001739 link 3b. Every verdict above this point is inferred from ROW RECENCY, which
  // cannot tell "the executor died" from "the executor is busy". These pin the one authoritative
  // signal that outranks it — and, just as importantly, pin that a FAILED probe changes nothing.
  describe('DBOS workflow liveness (link 3b)', () => {
    const policy = { ...DEFAULT_HOSTED_LIFECYCLE_POLICY, stuckAfterMs: 1_000, orphanAfterMs: 5_000 };
    const now = Date.parse('2026-08-28T00:00:10Z');
    /** Old enough to be reaped on recency alone, and already past the recovery budget. */
    const doomedByRecency = {
      status: 'running' as const,
      heartbeatAt: '2026-08-28T00:00:04Z',
      updatedAt: '2026-08-28T00:00:00Z',
      recoveryAttempts: policy.maxRecoveryAttempts,
    };

    it('does not reap a workflow DBOS still holds as runnable, however stale the row looks', () => {
      // The defect: this row was marked failed — and (pre-3a) had a cause fabricated over its
      // real one — while its workflow was still executing. `recovery-exhausted` is checked before
      // age, so it is the branch a live workflow must never reach.
      expect(classifyHostedLifecycleJob(doomedByRecency, policy, now)).toBe('recovery-exhausted');
      expect(classifyHostedLifecycleJob({ ...doomedByRecency, workflowLiveness: 'live' }, policy, now))
        .toBe('healthy');

      const orphanAged = { ...doomedByRecency, recoveryAttempts: 0 };
      expect(classifyHostedLifecycleJob(orphanAged, policy, now)).toBe('orphaned');
      expect(classifyHostedLifecycleJob({ ...orphanAged, workflowLiveness: 'live' }, policy, now))
        .toBe('healthy');
    });

    // The rail that keeps this safe to deploy: `harness_app` cannot read dbos.workflow_status
    // until migration 1172 applies, so on any older deployment EVERY probe returns unknown. That
    // must be byte-identical to the pre-3b classifier, never a licence to reap differently.
    it('treats an unanswered probe as no evidence, falling back to recency unchanged', () => {
      for (const liveness of ['unknown', 'gone'] as const) {
        expect(classifyHostedLifecycleJob({ ...doomedByRecency, workflowLiveness: liveness }, policy, now))
          .toBe('recovery-exhausted');
        expect(
          classifyHostedLifecycleJob(
            { ...doomedByRecency, recoveryAttempts: 0, workflowLiveness: liveness },
            policy,
            now,
          ),
        ).toBe('orphaned');
      }
      // An omitted field is the same no-evidence case, so a caller that never sets it is safe.
      expect(classifyHostedLifecycleJob(doomedByRecency, policy, now)).toBe('recovery-exhausted');
    });

    // `gone` is deliberately NOT more aggressive than `unknown`: absence from the runnable set is
    // not proof of abandonment, so it must not invent a reap that recency would not have made.
    it('never reaps on gone alone that recency would have called healthy', () => {
      const fresh = {
        status: 'running' as const,
        heartbeatAt: '2026-08-28T00:00:09.500Z',
        updatedAt: '2026-08-28T00:00:00Z',
        recoveryAttempts: 0,
      };
      expect(classifyHostedLifecycleJob({ ...fresh, workflowLiveness: 'gone' }, policy, now)).toBe('healthy');
      expect(classifyHostedLifecycleJob({ ...fresh, workflowLiveness: 'unknown' }, policy, now)).toBe('healthy');
    });

    it('still reports a settled row as terminal rather than healthy when the probe says live', () => {
      // Liveness must not resurrect a row the operation itself already settled.
      expect(
        classifyHostedLifecycleJob(
          { ...doomedByRecency, status: 'failed', workflowLiveness: 'live' },
          policy,
          now,
        ),
      ).toBe('terminal');
    });
  });

  it('queues idle stop only for an active running workspace without another lifecycle job', () => {
    const now = Date.parse('2026-08-28T02:00:00Z');
    const active = {
      state: 'active',
      observedState: 'running',
      lastActivityAt: '2026-08-28T00:00:00Z',
      idleStopAfterMinutes: 60,
      activeLifecycleJobs: 0,
    };
    expect(evaluateHostedIdleStop(active, now)).toMatchObject({ due: true, idleForMs: 7_200_000 });
    expect(evaluateHostedIdleStop({ ...active, activeLifecycleJobs: 1 }, now)).toEqual({ due: false, idleForMs: 0 });
    expect(evaluateHostedIdleStop({ ...active, observedState: 'stopped' }, now)).toEqual({ due: false, idleForMs: 0 });
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, undefined])(
    'does not stop a workspace with an unverified lifecycle-job count (%s)', activeLifecycleJobs => {
      const idle = {
        state: 'active', observedState: 'running', lastActivityAt: '2026-08-28T00:00:00Z',
        idleStopAfterMinutes: 60, activeLifecycleJobs: activeLifecycleJobs as number,
      };
      const now = Date.parse('2026-08-28T02:00:00Z');
      expect(evaluateHostedIdleStop(idle, now)).toEqual({ due: false, idleForMs: 0 });
      expect(evaluateHostedIdleStop({ ...idle, activeLifecycleJobs: 0 }, now)).toMatchObject({ due: true });
    },
  );

  describe('desktop viewers hold the idle stop off (P-014)', () => {
    const now = Date.parse('2026-08-28T02:00:00Z');
    const idleWorkspace = {
      state: 'active',
      observedState: 'running',
      lastActivityAt: '2026-08-28T00:00:00Z',
      idleStopAfterMinutes: 60,
      activeLifecycleJobs: 0,
    };
    // Sourced from desktop-lifecycle.VIEWER_HOLD_SEC at the call site; a literal here so this
    // test states the shape rather than re-deriving the number.
    const holdSec = 20 * 60;

    it('refuses to stop a workspace whose desktop a human is currently watching', () => {
      // Without this the control plane would stop the VM out from under a live viewer — the same
      // "indistinguishable from a crash" failure desktop-lifecycle prevents one layer down, with
      // the whole machine as the blast radius instead of one X server.
      expect(evaluateHostedIdleStop({
        ...idleWorkspace,
        desktopViewers: { attachedViewers: 1, lastSeenAt: '2026-08-28T01:55:00Z', holdSec },
      }, now)).toEqual({
        due: false,
        idleForMs: 0,
        hold: 'desktop-viewer',
        desktopViewerSignal: 'observed',
      });
    });

    it('holds on an attached viewer it cannot date, rather than guessing it is gone', () => {
      expect(evaluateHostedIdleStop({
        ...idleWorkspace,
        desktopViewers: { attachedViewers: 1, lastSeenAt: null, holdSec },
      }, now)).toMatchObject({ due: false, hold: 'desktop-viewer' });
    });

    it('stops once the binding is older than the hold, so one stuck flag cannot leak a VM', () => {
      expect(evaluateHostedIdleStop({
        ...idleWorkspace,
        desktopViewers: { attachedViewers: 1, lastSeenAt: '2026-08-28T00:30:00Z', holdSec },
      }, now)).toMatchObject({ due: true, desktopViewerSignal: 'observed' });
    });

    it('does not hold when the signal says no viewer is attached', () => {
      expect(evaluateHostedIdleStop({
        ...idleWorkspace,
        desktopViewers: { attachedViewers: 0, lastSeenAt: '2026-08-28T01:59:00Z', holdSec },
      }, now)).toMatchObject({ due: true, desktopViewerSignal: 'observed' });
    });

    // The distinction this pins is the whole reason the field exists: a verdict reached WITHOUT a
    // viewer signal must not be readable as a verdict that checked and found nobody watching.
    it('reports an unmeasured absence as absent rather than as nobody watching', () => {
      const unmeasured = evaluateHostedIdleStop(idleWorkspace, now);
      expect(unmeasured).toMatchObject({ due: true, desktopViewerSignal: 'absent' });
      expect(unmeasured.hold).toBeUndefined();

      const measuredClear = evaluateHostedIdleStop({
        ...idleWorkspace,
        desktopViewers: { attachedViewers: 0, lastSeenAt: null, holdSec },
      }, now);
      expect(measuredClear.desktopViewerSignal).toBe('observed');
      expect(unmeasured.desktopViewerSignal).not.toBe(measuredClear.desktopViewerSignal);
    });
  });
});
