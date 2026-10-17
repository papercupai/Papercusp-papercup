/**
 * Pure policy for hosted workspace lifecycle admission and reconciliation (P-040 / D-146).
 *
 * Persistence lives in hosted-lifecycle-store.ts. Keeping the decision layer pure makes quota,
 * budget, approval, idle-stop, and recovery behavior deterministic and cheap to falsify.
 */
import { checkHostedEntitlement, type ResolvedHostedEntitlements } from '../auth/hosted-entitlements';

/** Unit-bearing keys in the existing hosted entitlement quota map (P-537/D-067). */
export const HOSTED_POOL_RESOURCE_QUOTAS = {
  agents: 'pool.agents',
  hosts: 'pool.hosts',
  cpuMillicores: 'pool.cpu-millicores',
  memoryMiB: 'pool.memory-mib',
  dbGiB: 'pool.db-gib',
  workspaceGiB: 'pool.workspace-gib',
} as const;
export const HOSTED_POOL_TRIAL_DB_GIB = 256;
export type HostedPoolResources = Record<keyof typeof HOSTED_POOL_RESOURCE_QUOTAS, number>;

/** Read canonical allowances and these counters under the existing tenant/provider locks.
 * Allocated and pending are DISJOINT: a started reservation moves from one to the other.
 * No tier/model label, subscription claim or browser counter is an authority input.
 */
export interface HostedPoolResourceAdmissionInput {
  organizationId: string;
  entitlements: ResolvedHostedEntitlements | null;
  nowMs: number;
  allocated: HostedPoolResources;
  pending: HostedPoolResources;
  requested: HostedPoolResources;
  budget: { currency: string; usedMinor: number; pendingMinor: number; requestedMinor: number };
  capacity: { freeHosts: number; reservedForOtherCustomers: number; olderBurstWaiters: number;
    /** Provisioning consumes allowance, but no existing warm VM. Defaults to requested.hosts. */
    requestedWarmHosts?: number };
}

/** Pure resource half of admission; the caller persists its receipt atomically with reservation.
 * Downgrade blocks NEW demand without terminating work or deleting retained data.
 */
export function evaluateHostedPoolResourceAdmission(input: HostedPoolResourceAdmissionInput): {
  allowed: boolean;
  reasons: string[];
  guaranteed: boolean;
  audit: ReturnType<typeof checkHostedEntitlement>['audit'][];
} {
  const reasons: string[] = [];
  const audit: ReturnType<typeof checkHostedEntitlement>['audit'][] = [];
  const entitlement = input.entitlements;
  if (!entitlement || entitlement.organizationId !== input.organizationId || !input.organizationId.trim() ||
      !entitlement.auditReceiptIds.length || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0 ||
      (entitlement.recheckAt !== null &&
        (!Number.isFinite(entitlement.recheckAt.getTime()) || entitlement.recheckAt.getTime() <= input.nowMs))) {
    return { allowed: false, reasons: ['pool entitlement authority missing, foreign or stale'], guaranteed: false, audit };
  }
  for (const resource of Object.keys(HOSTED_POOL_RESOURCE_QUOTAS) as Array<keyof HostedPoolResources>) {
    const values = [input.allocated[resource], input.pending[resource], input.requested[resource]];
    if (!values.every(finiteInteger) || !Number.isSafeInteger(values.reduce((a, b) => a + b, 0))) {
      reasons.push(`invalid pool resource counters: ${resource}`);
      continue;
    }
    // Reconnect and a downgrade must preserve existing data/work. An additive zero requests
    // no new allowance; positive demand must include both allocated and queued reservations.
    if (input.requested[resource] === 0) continue;
    const decision = checkHostedEntitlement(entitlement, { kind: 'quota', key: HOSTED_POOL_RESOURCE_QUOTAS[resource],
      used: input.allocated[resource] + input.pending[resource], requested: input.requested[resource] });
    audit.push(decision.audit);
    if (!decision.allowed) reasons.push(`${HOSTED_POOL_RESOURCE_QUOTAS[resource]}: ${decision.reason}`);
  }
  const budget = input.budget;
  if (!/^[A-Z]{3}$/.test(budget.currency) ||
      ![budget.usedMinor, budget.pendingMinor, budget.requestedMinor].every(finiteInteger) ||
      !Number.isSafeInteger(budget.usedMinor + budget.pendingMinor + budget.requestedMinor)) {
    reasons.push('invalid pool currency or budget counters');
  } else if (budget.requestedMinor > 0) {
    const decision = checkHostedEntitlement(entitlement, { kind: 'budget',
      key: `pool.cost.${budget.currency.toLowerCase()}.minor`,
      used: budget.usedMinor + budget.pendingMinor, requested: budget.requestedMinor });
    audit.push(decision.audit);
    if (!decision.allowed) reasons.push(`pool cost: ${decision.reason}`);
  }
  const capacity = input.capacity;
  const warmDemand = capacity.requestedWarmHosts === undefined ? input.requested.hosts : capacity.requestedWarmHosts;
  const reservedHosts = entitlement.quotas['pool.reserved-hosts'] ?? 0;
  const guaranteed = finiteInteger(reservedHosts) && input.requested.hosts > 0 &&
    input.allocated.hosts + input.pending.hosts + input.requested.hosts <= reservedHosts;
  if (![capacity.freeHosts, capacity.reservedForOtherCustomers, capacity.olderBurstWaiters, warmDemand].every(finiteInteger) ||
      capacity.reservedForOtherCustomers > capacity.freeHosts || warmDemand > input.requested.hosts) {
    reasons.push('invalid pool capacity snapshot');
  } else if (input.requested.hosts > 0) {
    // Paid guarantees compete atomically for actual inventory. Subtracting all
    // other guarantees from each paid request would deadlock a short pool.
    if (warmDemand > capacity.freeHosts - (guaranteed ? 0 : capacity.reservedForOtherCustomers)) {
      reasons.push('pool capacity reserved or exhausted');
    }
    if (!guaranteed && capacity.olderBurstWaiters > 0) reasons.push('older pool burst requests have priority');
  }
  return { allowed: reasons.length === 0, reasons, guaranteed, audit };
}

export type HostedLifecycleRiskTier = 'low' | 'moderate' | 'high' | 'critical';
export type HostedLifecycleApprovalStatus = 'not-required' | 'pending' | 'approved' | 'rejected';
export type HostedLifecycleAction =
  | 'provision'
  | 'start'
  | 'stop'
  | 'restart'
  | 'snapshot'
  | 'restore'
  | 'upgrade'
  | 'repair'
  | 'destroy';

export interface HostedLifecyclePolicy {
  tenantConcurrencyLimit: number;
  providerConcurrencyLimit: number;
  monthlyBudgetCents: number | null;
  idleStopAfterMinutes: number | null;
  approvalRequiredAt: HostedLifecycleRiskTier;
  stuckAfterMs: number;
  orphanAfterMs: number;
  maxRecoveryAttempts: number;
}

export const DEFAULT_HOSTED_LIFECYCLE_POLICY: HostedLifecyclePolicy = {
  tenantConcurrencyLimit: 2,
  providerConcurrencyLimit: 8,
  monthlyBudgetCents: null,
  idleStopAfterMinutes: 60,
  approvalRequiredAt: 'high',
  stuckAfterMs: 5 * 60_000,
  orphanAfterMs: 20 * 60_000,
  maxRecoveryAttempts: 3,
};

export interface HostedCostEstimate {
  cents: number;
  currency: string;
  source: string;
  evidenceRef: string;
  estimatedAt: string;
}

export interface HostedBillingOwner {
  kind: 'organization' | 'customer' | 'platform';
  id: string;
}

export interface HostedLifecycleAdmissionRequest {
  action: HostedLifecycleAction;
  riskTier: HostedLifecycleRiskTier;
  approvalStatus: HostedLifecycleApprovalStatus;
  estimate: HostedCostEstimate;
  billingOwner: HostedBillingOwner;
  emergencyTeardown?: boolean;
  teardownReason?: string;
}

export interface HostedLifecycleAdmissionSnapshot {
  activeTenantJobs: number;
  activeProviderJobs: number;
  committedMonthlyCents: number;
}

export interface HostedLifecycleAdmissionDecision {
  allowed: boolean;
  reasons: string[];
  projectedMonthlyCents: number;
  emergencyBypass: boolean;
}

const RISK_WEIGHT: Record<HostedLifecycleRiskTier, number> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function validIso(value: string): boolean {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateHostedLifecyclePolicy(policy: HostedLifecyclePolicy): string[] {
  const problems: string[] = [];
  if (!Number.isSafeInteger(policy.tenantConcurrencyLimit) || policy.tenantConcurrencyLimit < 1) {
    problems.push('tenantConcurrencyLimit must be a positive integer');
  }
  if (!Number.isSafeInteger(policy.providerConcurrencyLimit) || policy.providerConcurrencyLimit < 1) {
    problems.push('providerConcurrencyLimit must be a positive integer');
  }
  if (policy.monthlyBudgetCents !== null && !finiteInteger(policy.monthlyBudgetCents)) {
    problems.push('monthlyBudgetCents must be a non-negative safe integer or null');
  }
  if (policy.idleStopAfterMinutes !== null &&
      (!Number.isSafeInteger(policy.idleStopAfterMinutes) || policy.idleStopAfterMinutes < 1)) {
    problems.push('idleStopAfterMinutes must be a positive integer or null');
  }
  if (!finiteInteger(policy.stuckAfterMs) || policy.stuckAfterMs < 1_000) {
    problems.push('stuckAfterMs must be at least 1000');
  }
  if (!finiteInteger(policy.orphanAfterMs) || policy.orphanAfterMs <= policy.stuckAfterMs) {
    problems.push('orphanAfterMs must be greater than stuckAfterMs');
  }
  if (!Number.isSafeInteger(policy.maxRecoveryAttempts) || policy.maxRecoveryAttempts < 0) {
    problems.push('maxRecoveryAttempts must be a non-negative integer');
  }
  return problems;
}

export function validateHostedCostEstimate(estimate: HostedCostEstimate): string[] {
  const problems: string[] = [];
  if (!finiteInteger(estimate.cents)) problems.push('estimate.cents must be a non-negative safe integer');
  if (!/^[A-Z]{3}$/.test(estimate.currency)) problems.push('estimate.currency must be an ISO-4217 code');
  if (!nonEmpty(estimate.source)) problems.push('estimate.source is required');
  if (!nonEmpty(estimate.evidenceRef)) problems.push('estimate.evidenceRef is required');
  if (!validIso(estimate.estimatedAt)) problems.push('estimate.estimatedAt must be an ISO timestamp');
  return problems;
}

export function evaluateHostedLifecycleAdmission(
  policy: HostedLifecyclePolicy,
  snapshot: HostedLifecycleAdmissionSnapshot,
  request: HostedLifecycleAdmissionRequest,
): HostedLifecycleAdmissionDecision {
  const reasons = [
    ...validateHostedLifecyclePolicy(policy),
    ...validateHostedCostEstimate(request.estimate),
  ];
  if (!nonEmpty(request.billingOwner.id)) reasons.push('billingOwner.id is required');
  if (![snapshot.activeTenantJobs, snapshot.activeProviderJobs, snapshot.committedMonthlyCents]
    .every(finiteInteger)) {
    reasons.push('admission snapshot counters must be non-negative safe integers');
  }

  const emergencyBypass = request.emergencyTeardown === true;
  if (emergencyBypass) {
    if (request.action !== 'destroy') reasons.push('emergency teardown is valid only for destroy');
    if (!nonEmpty(request.teardownReason ?? '')) reasons.push('emergency teardown requires a reason');
  }

  const requiresApproval = RISK_WEIGHT[request.riskTier] >= RISK_WEIGHT[policy.approvalRequiredAt];
  if (request.approvalStatus === 'rejected') reasons.push('lifecycle request was rejected');
  if (requiresApproval && request.approvalStatus !== 'approved') {
    reasons.push(`risk tier ${request.riskTier} requires approval`);
  }

  const projectedMonthlyCents = snapshot.committedMonthlyCents + request.estimate.cents;
  if (!emergencyBypass) {
    if (snapshot.activeTenantJobs >= policy.tenantConcurrencyLimit) {
      reasons.push('tenant concurrency limit reached');
    }
    if (snapshot.activeProviderJobs >= policy.providerConcurrencyLimit) {
      reasons.push('provider concurrency limit reached');
    }
    if (policy.monthlyBudgetCents !== null && projectedMonthlyCents > policy.monthlyBudgetCents) {
      reasons.push('monthly lifecycle budget exceeded');
    }
  }

  return { allowed: reasons.length === 0, reasons, projectedMonthlyCents, emergencyBypass };
}

export type HostedLifecycleJobHealth = 'healthy' | 'stuck' | 'orphaned' | 'recovery-exhausted' | 'terminal';

/**
 * Whether DBOS still owns this operation's workflow as runnable (WI-10001739 link 3b).
 *
 * `unknown` means THE PROBE DID NOT ANSWER — the reconciler could not read
 * `dbos.workflow_status` (no grant, schema absent, query failed). It is a failed measurement,
 * never evidence that a workflow is dead, and it must behave exactly like the pre-3b code.
 */
export type HostedLifecycleWorkflowLiveness = 'live' | 'gone' | 'unknown';

export interface HostedLifecycleJobObservation {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  heartbeatAt?: string | null;
  updatedAt: string;
  recoveryAttempts: number;
  /** Omitted is treated as `unknown`; see `HostedLifecycleWorkflowLiveness`. */
  workflowLiveness?: HostedLifecycleWorkflowLiveness;
}

export function classifyHostedLifecycleJob(
  job: HostedLifecycleJobObservation,
  policy: HostedLifecyclePolicy,
  now = Date.now(),
): HostedLifecycleJobHealth {
  if (job.status === 'succeeded' || job.status === 'failed') return 'terminal';
  // WI-10001739 link 3b. Everything below this line infers abandonment from ROW RECENCY, which
  // cannot distinguish "the executor died" from "the executor is busy and has not checkpointed
  // lately". A workflow DBOS still holds as runnable is BY DEFINITION not abandoned, however old
  // its row looks, so an authoritative `live` outranks every recency signal.
  //
  // This check sits ahead of the `recoveryAttempts` test on purpose: that is the branch that
  // marks an operation failed and (pre-3a) fabricated a cause over the real one, so it is exactly
  // the branch a live workflow must never reach. Measured 2026-09-17: a row reaches it after ~3
  // sweeps (stuck at 5min, +1 attempt per sweep), which is what produced the 20-29min reap band.
  //
  // ONLY `live` changes behaviour. `gone` and `unknown` both fall through to the original
  // recency path, so an unavailable or failed probe degrades to exactly the pre-3b classifier
  // rather than reaping more aggressively on evidence it does not have.
  if (job.workflowLiveness === 'live') return 'healthy';
  if (job.recoveryAttempts >= policy.maxRecoveryAttempts) return 'recovery-exhausted';
  const heartbeat = Date.parse(job.heartbeatAt || job.updatedAt);
  if (!Number.isFinite(heartbeat)) return 'orphaned';
  const age = Math.max(0, now - heartbeat);
  if (age >= policy.orphanAfterMs) return 'orphaned';
  if (age >= policy.stuckAfterMs) return 'stuck';
  return 'healthy';
}

/**
 * A live desktop viewer bound to one of this workspace's desktop sessions (P-014).
 *
 * WHY THIS EXISTS. `desktop-lifecycle` already refuses to freeze a desktop somebody is watching,
 * because freezing a live picture is indistinguishable from a crash to the person looking at it.
 * The control-plane idle-stop sweep is the SAME failure one layer up and with a bigger blast
 * radius: it stops the whole VM. Before this input existed the sweep had no way to know a human
 * was attached, so the two layers disagreed by construction.
 *
 * `holdSec` is passed in rather than imported so this module stays pure policy with no dependency
 * on the desktop registry. It is not a number to invent at the call site: source it from
 * `desktop-lifecycle.VIEWER_HOLD_SEC`, which is itself derived from the two viewer lanes' teardown
 * ceiling, so the hold cannot drift away from the lanes it is covering.
 */
export interface HostedDesktopViewerSignal {
  /** Viewers currently bound in `watch` or `takeover` mode. */
  attachedViewers: number;
  /** When a bound viewer was last observed live. */
  lastSeenAt: string | null;
  /** How long a binding defers governance — `desktop-lifecycle.VIEWER_HOLD_SEC`. */
  holdSec: number;
}

export interface HostedWorkspaceActivity {
  state: string;
  observedState: string;
  lastActivityAt?: string | null;
  idleStopAfterMinutes?: number | null;
  activeLifecycleJobs: number;
  /** Controller observation, including admitted starts that have not spawned yet. */
  activeWork?: { activeAgents: number; pendingAgentStarts: number; activeCommands: number };
  /**
   * Desktop viewers attached to this workspace. OMITTING it is a valid state and means the caller
   * had no viewer signal to offer — which is reported back as `desktopViewerSignal: 'absent'`
   * rather than silently treated as "nobody is watching". See that field.
   */
  desktopViewers?: HostedDesktopViewerSignal | null;
}

export interface HostedIdleStopDecision {
  due: boolean;
  idleForMs: number;
  reason?: string;
  /** Present only when something actively held the stop off. */
  hold?: 'desktop-viewer' | 'active-work';
  /**
   * Whether this verdict actually consulted a desktop-viewer signal.
   *
   * `'absent'` means the caller supplied none — so a `due: true` alongside it is NOT evidence
   * that nobody is watching, only that nobody asked. Reported rather than defaulted because an
   * unmeasured absence reads exactly like a measured one, and that mistake here queues a STOP on
   * a machine somebody is using.
   *
   * Emitted only on verdicts that reached the idle computation; the earlier guards
   * (not active, not running, jobs in flight) are refusals to judge, not idle verdicts.
   */
  desktopViewerSignal?: 'absent' | 'observed';
}

export function evaluateHostedIdleStop(
  workspace: HostedWorkspaceActivity,
  now = Date.now(),
): HostedIdleStopDecision {
  if (workspace.state !== 'active') return { due: false, idleForMs: 0 };
  if (workspace.observedState !== 'running') return { due: false, idleForMs: 0 };
  if (workspace.activeLifecycleJobs > 0) return { due: false, idleForMs: 0 };
  if (workspace.activeWork && [workspace.activeWork.activeAgents, workspace.activeWork.pendingAgentStarts,
    workspace.activeWork.activeCommands].some(value => !finiteInteger(value) || value > 0)) {
    return { due: false, idleForMs: 0, hold: 'active-work' };
  }
  const minutes = workspace.idleStopAfterMinutes;
  if (minutes == null || !Number.isSafeInteger(minutes) || minutes < 1) {
    return { due: false, idleForMs: 0 };
  }

  const viewers = workspace.desktopViewers ?? null;
  const desktopViewerSignal: 'absent' | 'observed' = viewers ? 'observed' : 'absent';
  if (viewers && viewers.attachedViewers > 0) {
    const lastSeen = Date.parse(viewers.lastSeenAt ?? '');
    const holdMs = Math.max(0, viewers.holdSec) * 1000;
    // An unparseable timestamp on an attached viewer holds. A viewer we know is bound but cannot
    // date is the case where guessing costs the most, and the hold is bounded anyway.
    if (!Number.isFinite(lastSeen) || now - lastSeen < holdMs) {
      return {
        due: false,
        idleForMs: 0,
        hold: 'desktop-viewer',
        desktopViewerSignal,
      };
    }
  }

  const lastActivity = Date.parse(workspace.lastActivityAt ?? '');
  if (!Number.isFinite(lastActivity)) return { due: false, idleForMs: 0, desktopViewerSignal };
  const idleForMs = Math.max(0, now - lastActivity);
  const due = idleForMs >= minutes * 60_000;
  return {
    due,
    idleForMs,
    ...(due ? { reason: `workspace idle for ${Math.floor(idleForMs / 60_000)} minutes` } : {}),
    desktopViewerSignal,
  };
}

/** Inventory for one authoritative pool scope, read with its generation/fence.
 * Pending hosts are disjoint from ready hosts and include admitted, unstarted creates.
 * queuedHosts is exclusive-VM demand after placement, not a count of assigned agents.
 */
export interface HostedPoolCapacityHost {
  hostId: string;
  generation: number;
  controllerFence: number;
  state: 'ready' | 'pending' | 'draining' | 'unavailable';
  observedAtMs: number;
  customerWorkspaceId: string | null;
  reservationId: string | null;
  activity: HostedWorkspaceActivity | null;
}

export interface HostedPoolCapacityInput {
  nowMs: number;
  observedAtMs: number;
  maxObservationAgeMs: number;
  generation: number;
  controllerFence: number;
  lastChangeAtMs: number | null;
  cooldownMs: number;
  queuedHosts: number;
  /** Zero permits a pool with no always-on spare VM (D-074). */
  minimumSpareHosts: number;
  hosts: readonly HostedPoolCapacityHost[];
  provision: {
    profileRef: string;
    market: 'on-demand' | 'spot';
    estimate: HostedCostEstimate;
    /** Canonical allowances and disjoint allocated/pending counters, read under locks. */
    admission: HostedPoolResourceAdmissionInput;
    reclaimRecovery: null | {
      profileRef: string;
      result: 'passed' | 'failed' | 'unknown';
      evidenceRef: string;
      verifiedAtMs: number;
    };
  };
}

export type HostedPoolCapacityDecision = {
  readyHosts: number;
  pendingHosts: number;
  reasons: string[];
} & (
  | { kind: 'hold' }
  | {
      kind: 'provision';
      profileRef: string;
      market: 'on-demand' | 'spot';
      generation: number;
      controllerFence: number;
    }
  | {
      kind: 'drain';
      hostId: string;
      hostGeneration: number;
      hostControllerFence: number;
      generation: number;
      controllerFence: number;
    }
);

/** Proposes ONE ordinary-VM change; never acquires a lease or executes it.
 * The existing durable lifecycle executor must CAS/increment the pool generation,
 * reserve quota/budget, and recheck host assignment/activity under the same fence.
 * A replay of this pure decision is not permission to launch another operation.
 */
export function evaluateHostedPoolCapacity(input: HostedPoolCapacityInput): HostedPoolCapacityDecision {
  const hold = (reason: string, readyHosts = 0, pendingHosts = 0): HostedPoolCapacityDecision =>
    ({ kind: 'hold', readyHosts, pendingHosts, reasons: [reason] });
  const positive = (value: number): boolean => finiteInteger(value) && value > 0;
  const validRef = (value: string): boolean => typeof value === 'string' && nonEmpty(value);
  const fresh = (at: number): boolean => finiteInteger(at) && at <= input.nowMs &&
    input.nowMs - at <= input.maxObservationAgeMs;
  if (![input.nowMs, input.cooldownMs, input.queuedHosts, input.minimumSpareHosts].every(finiteInteger) ||
      !positive(input.maxObservationAgeMs) || !positive(input.generation) || !positive(input.controllerFence) ||
      !Number.isSafeInteger(input.queuedHosts + input.minimumSpareHosts)) {
    return hold('invalid pool capacity controls');
  }
  if (!fresh(input.observedAtMs)) return hold('pool observation missing, stale or future');
  if (input.lastChangeAtMs !== null &&
      (!finiteInteger(input.lastChangeAtMs) || input.lastChangeAtMs > input.nowMs)) {
    return hold('invalid pool last-change observation');
  }
  const ids = new Set<string>();
  for (const host of input.hosts) {
    if (!validRef(host.hostId) || ids.has(host.hostId) || !positive(host.generation) ||
        !positive(host.controllerFence) || !fresh(host.observedAtMs) ||
        ![host.customerWorkspaceId, host.reservationId].every(value => value === null || validRef(value))) {
      return hold('invalid, duplicate or stale pool host observation');
    }
    ids.add(host.hostId);
    if (host.state !== 'ready' && host.state !== 'pending') return hold('pool host needs reconciliation');
    if (host.state === 'ready' && (!host.activity || host.activity.state !== 'active' ||
        host.activity.observedState !== 'running' || !finiteInteger(host.activity.activeLifecycleJobs) ||
        !host.activity.activeWork ||
        ![host.activity.activeWork.activeAgents, host.activity.activeWork.pendingAgentStarts,
          host.activity.activeWork.activeCommands].every(finiteInteger))) {
      return hold('pool host work observation missing or invalid');
    }
  }
  const unassigned = (host: HostedPoolCapacityHost): boolean =>
    host.customerWorkspaceId === null && host.reservationId === null;
  const ready = input.hosts.filter(host => host.state === 'ready' && unassigned(host) &&
    host.activity!.activeLifecycleJobs === 0 &&
    Object.values(host.activity!.activeWork!).every(value => value === 0));
  const pendingHosts = input.hosts.filter(host => host.state === 'pending' && unassigned(host)).length;
  const readyHosts = ready.length;
  const pause = (reason: string): HostedPoolCapacityDecision => hold(reason, readyHosts, pendingHosts);
  if (input.lastChangeAtMs !== null && input.nowMs - input.lastChangeAtMs < input.cooldownMs) {
    return pause('pool cooldown active');
  }
  const target = input.queuedHosts + input.minimumSpareHosts;
  const preconditions = { generation: input.generation, controllerFence: input.controllerFence };
  if (readyHosts + pendingHosts < target) {
    const { provision } = input;
    const { admission, estimate } = provision;
    if (!validRef(provision.profileRef) || !['on-demand', 'spot'].includes(provision.market) ||
        validateHostedCostEstimate(estimate).length || !fresh(Date.parse(estimate.estimatedAt)) ||
        !positive(estimate.cents) ||
        admission.nowMs !== input.nowMs || admission.requested.hosts !== 1 ||
        admission.capacity.requestedWarmHosts !== 0 || admission.budget.requestedMinor !== estimate.cents ||
        admission.budget.currency !== estimate.currency ||
        admission.allocated.hosts !== input.hosts.filter(host => host.state === 'ready').length ||
        admission.pending.hosts !== input.hosts.filter(host => host.state === 'pending').length ||
        !positive(admission.requested.cpuMillicores) || !positive(admission.requested.memoryMiB)) {
      return pause('invalid pool provision estimate or reservation snapshot');
    }
    const allowed = evaluateHostedPoolResourceAdmission(admission);
    if (!allowed.allowed) return { kind: 'hold', readyHosts, pendingHosts, reasons: allowed.reasons };
    if (provision.market === 'spot') {
      const proof = provision.reclaimRecovery;
      if (!proof || proof.result !== 'passed' || proof.profileRef !== provision.profileRef ||
          !validRef(proof.evidenceRef) || !fresh(proof.verifiedAtMs)) {
        return pause('spot reclaim recovery not verified for this profile');
      }
    }
    return { kind: 'provision', readyHosts, pendingHosts, reasons: [], ...preconditions,
      profileRef: provision.profileRef, market: provision.market };
  }
  // Do not shrink around an admitted create, including one already reserved to a tenant.
  if (input.hosts.some(host => host.state === 'pending')) return pause('pool creates still pending');
  if (readyHosts <= target) return pause('pool capacity meets demand');
  const drainable = ready.filter(host => {
    const activity = host.activity!;
    const viewers = activity.desktopViewers;
    // The general idle helper permits absent viewer telemetry; pool scale-in requires
    // an explicit measured absence as well as the existing idle/activity protections.
    return viewers != null && viewers.attachedViewers === 0 &&
      finiteInteger(viewers.holdSec) && evaluateHostedIdleStop(activity, input.nowMs).due;
  }).sort((a, b) => a.hostId < b.hostId ? -1 : a.hostId > b.hostId ? 1 : 0);
  const host = drainable[0];
  if (!host) return pause('no verified idle unassigned pool host');
  return { kind: 'drain', readyHosts, pendingHosts, reasons: [], ...preconditions,
    hostId: host.hostId, hostGeneration: host.generation, hostControllerFence: host.controllerFence };
}

