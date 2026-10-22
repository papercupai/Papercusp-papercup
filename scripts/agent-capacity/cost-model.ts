/**
 * P-012 cost model (plan agent-capacity-and-cost-gcp-2026-09-30, WI-10004388): Google cost per month
 * for ONE workspace with N assigned agents, for each lever combination, graded against the D-003
 * target (50 agents at a Google cost of about 60-80 USD/month; the owner's starting figure was
 * 1000 USD/month, #1064).
 *
 *   npx tsx scripts/agent-capacity/cost-model.ts [--agents 50] [--p532-saved-gib <GiB>]
 *     [--report-month <JSON file with CostReportMonth inputs>] [--json]
 *
 * Every measured input below names the plan Decision it comes from. Machine prices are NOT typed in
 * here: they come from gcp-rails (Cloud Billing Catalog list prices, on-demand and spot), so a price
 * update there re-prices every row. Re-run this after a new measurement instead of hand-editing a table.
 *
 * Model (per month, 730 h):
 *   pooled compute    = N x duty.mean x hostMonth / activeCapacity
 *                       (agents of many workspaces share a pool of hosts, so the pool is sized for
 *                        the MEAN number of busy agents; D-038 measured p99 at 1.3x the mean)
 *   dedicated compute = ceil(N x duty.mean x duty.p99OverMean / (activeCapacity - 1)) x hostMonth
 *                       (one workspace owns its VM, so it must hold its own p99; one agent slot is
 *                        given to the workspace's Server, which costs about one mixed agent's CPU)
 *   server            = dedicated: inside the dedicated VM (0 extra)
 *                       packed:    hostMonth(e2-standard-16 spot) / tenants per host (D-045 as measured)
 *                       floor:     Server cores and RAM at e2 spot list rates (D-022 method); reachable
 *                                  only with near-perfect packing, so it is a lower bound
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costFromTokens, PRICE_TABLE_VERSION, USAGE_LEDGER_PRICING, type TokenUsage } from '@papercusp/model-pricing';
import { hourlyPriceUsd, parseMachineType, SPOT_PRICES_2026_10_01 } from './gcp-rails';
import { decodeChunk, type RecordedExchange } from './record-proxy';
import { sseEvents } from './replay-server';

export const HOURS_PER_MONTH = 730;
/** The measurement VMs were priced with a 120 GB boot disk (capacity-table --disk-gb 120), so the rows here match D-019/D-020. */
export const HOST_DISK_GB = 120;

export const TARGET = { agents: 50, googleUsdMonthMax: 80, googleUsdMonthGoal: 60, source: 'D-003' } as const;
export const OWNER_BASELINE = { agents: 50, usdMonth: 1000, source: 'owner directive #1064' } as const;

/** Share of agents mid-turn at once in the real fleet, and its p99 over the mean. */
export const DUTY = { mean: 0.35, p99OverMean: 1.3, source: 'D-038' } as const;

export type Workload = 'mixed' | 'heavy';

export interface Capacity {
  id: string;
  workload: Workload;
  machineType: string;
  /** Mean agents in flight at the capacity step (achieved concurrency, not slot count; D-020). */
  active: number;
  /** True when the run never saturated, so the real capacity is at least `active`. */
  atLeast?: boolean;
  source: string;
}

/**
 * mixed = 50/50 Claude/Codex planning workload, replayed (D-009 accepted replay for it).
 * heavy = real typecheck/test-heavy Papercusp engineering (P-019 recordings replayed in P-529/WI-5384).
 * Use achieved concurrency, not the requested ramp slots. The original output is retained in
 * fixtures/capacity-ramps.json and checked through the existing capacity-table reducer by the tests.
 * A ramp that stopped without saturation supplies a lower bound, including the lean/Arm rows.
 */
export const CAPACITY: readonly Capacity[] = [
  { id: 'mixed-e2s4', workload: 'mixed', machineType: 'e2-standard-4', active: 7.9, source: 'D-019 (achieved concurrency per D-020)' },
  { id: 'mixed-e2s8', workload: 'mixed', machineType: 'e2-standard-8', active: 31.6, source: 'D-019 (achieved concurrency per D-020)' },
  { id: 'mixed-e2s16', workload: 'mixed', machineType: 'e2-standard-16', active: 60.1, source: 'D-019 (corrected by D-020)' },
  { id: 'mixed-e2c16', workload: 'mixed', machineType: 'e2-custom-16-32768', active: 73.2, atLeast: true, source: 'D-020' },
  { id: 'mixed-c4a16', workload: 'mixed', machineType: 'c4a-standard-16', active: 87.6, source: 'D-024' },
  { id: 'mixed-c4ahc16', workload: 'mixed', machineType: 'c4a-highcpu-16', active: 83.3, atLeast: true, source: 'D-027' },
  { id: 'heavy-e2s16', workload: 'heavy', machineType: 'e2-standard-16', active: 23.9, source: 'D-023 (no admission)' },
  { id: 'heavy-e2s16-adm', workload: 'heavy', machineType: 'e2-standard-16', active: 31.8, source: 'D-023 (heavy-job admission)' },
  {
    id: 'heavy-e2s16-adm-tsc',
    workload: 'heavy',
    machineType: 'e2-standard-16',
    active: 47.9,
    atLeast: true,
    source: 'D-040 (admission + shared tsc-service; n48 held 47.9; slowdown unmeasured)',
  },
];

/**
 * One idle Papercusp Server tenant (D-045, P-011: 16 tenants on a 64 GiB e2-standard-16, embed
 * unload off). ramGiB is the HOST cost per tenant: host MemAvailable fell 61.7 -> 3.9 GiB for 16
 * tenants, 3.61 GiB each (cgroup mean 3.24 plus kernel and page cache). cores is the idle floor
 * (0.16-0.20 measured, upper end taken).
 */
export const SERVER = {
  ramGiB: 3.6,
  cores: 0.2,
  packHost: 'e2-standard-16',
  /** D-045 kept a 10 GiB reserve on the 64 GiB host. */
  reserveGiB: 10,
  /** MemAvailable at start over nominal RAM on that host (61.7 of 64 GiB). */
  usableRamFraction: 61.7 / 64,
  source: 'D-045',
} as const;

export function hostMonthUsd(machineType: string, spot: boolean): number {
  return hourlyPriceUsd(machineType, HOST_DISK_GB, { spot }) * HOURS_PER_MONTH;
}

/** P-544: a stopped workspace keeps its storage, but does not rent running compute. */
export interface OnDemandMonthInput {
  activeHours: number;
  /** Compute only: exclude retained disks and other monthly charges from this rate. */
  computeHourlyUsd: number;
  retainedDiskGiB: number;
  diskGiBMonthUsd: number;
  backupMonthUsd: number;
  controlMonthUsd: number;
  networkMonthUsd: number;
  /** Monthly inference exposure, including customer-direct usage; never assume an omitted cost is zero. */
  inferenceMonthUsd: number;
  /** An ephemeral address released on stop; reserved addresses belong in controlMonthUsd. */
  activeIpv4HourlyUsd: number;
}

/** Provider-neutral arithmetic. Every category needs an explicit input; zero needs supporting
 * evidence from the caller. Arithmetic alone proves neither measured cost nor capacity acceptance. */
export function onDemandMonthUsd(input: OnDemandMonthInput) {
  const required = ['activeHours', 'computeHourlyUsd', 'retainedDiskGiB', 'diskGiBMonthUsd',
    'backupMonthUsd', 'controlMonthUsd', 'networkMonthUsd', 'inferenceMonthUsd',
    'activeIpv4HourlyUsd'] as const satisfies readonly (keyof OnDemandMonthInput)[];
  for (const key of required) {
    const value = input[key];
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be finite and non-negative`);
  }
  if (input.activeHours > HOURS_PER_MONTH) throw new Error('activeHours exceeds the modeled month');
  const computeUsd = input.activeHours * input.computeHourlyUsd;
  const ipv4Usd = input.activeHours * input.activeIpv4HourlyUsd;
  const storageUsd = input.retainedDiskGiB * input.diskGiBMonthUsd;
  const retainedUsd = storageUsd + input.backupMonthUsd + input.controlMonthUsd;
  const totalUsd = computeUsd + ipv4Usd + retainedUsd + input.networkMonthUsd + input.inferenceMonthUsd;
  if (!Number.isFinite(totalUsd)) throw new Error('totalUsd must be finite');
  return { activeHours: input.activeHours, computeUsd, ipv4Usd, storageUsd,
    backupUsd: input.backupMonthUsd, controlUsd: input.controlMonthUsd,
    networkUsd: input.networkMonthUsd, inferenceUsd: input.inferenceMonthUsd, retainedUsd, totalUsd };
}

/** P544/P538 accounting preparation, not a customer charge or a measured price.
 * Reconcile an observed invoice in integer currency micros. The caller must bind
 * the invoice, achieved-capacity observation and tenant usage to the same period.
 * Requested agent slots are deliberately not an allocation input.
 */
export type PoolBillAllocation =
  | { kind: 'compute'; achievedAgentMilliseconds: number; capacityEvidenceRef: string;
      tenants: readonly { tenantId: string; activeAgentMilliseconds: number }[] }
  | { kind: 'weighted'; overheadWeight: number;
      tenants: readonly { tenantId: string; weight: number }[] }
  | { kind: 'unresolved'; reason: string };

export interface PoolBillLine {
  id: string;
  periodRef: string;
  provider: string;
  currency: string;
  category: 'compute' | 'persistent-storage' | 'provisioned-performance' | 'backup'
    | 'object-storage' | 'network' | 'control-plane' | 'warm-capacity' | 'inference';
  kind: 'charge' | 'credit';
  /** Null retains an unpriced exposure, including when the invoice residual is zero. */
  amountMicros: number | null;
  sourceRef: string;
  allocation: PoolBillAllocation;
}

export function allocatePoolBill(input: {
  periodRef: string; currency: string; totalMicros: number; lines: readonly PoolBillLine[];
}) {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const amount = (value: number, name: string, nonnegative = false): bigint => {
    if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) throw new Error(`invalid ${name}`);
    return BigInt(value);
  };
  const safe = (value: bigint): number => {
    if (value < -max || value > max) throw new Error('pool bill amount overflow');
    return Number(value);
  };
  const ref = (value: string): void => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('missing pool bill reference');
  };
  ref(input.periodRef);
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('invalid pool bill currency');
  const total = amount(input.totalMicros, 'invoice total');
  const tenantTotals = new Map<string, bigint>(), seen = new Set<string>();
  const unpricedLineIds: string[] = [], gaps: string[] = [];
  let known = 0n, overhead = 0n, unallocated = 0n, credits = 0n;
  let unpricedCharge = false, unpricedCredit = false;
  const categories = new Set(['compute', 'persistent-storage', 'provisioned-performance', 'backup',
    'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference']);

  const lines = input.lines.map((line) => {
    ref(line.id); ref(line.provider); ref(line.sourceRef);
    if (seen.has(line.id)) throw new Error('duplicate pool bill line');
    seen.add(line.id);
    if (line.periodRef !== input.periodRef) throw new Error('pool bill period mismatch');
    if (line.currency !== input.currency) throw new Error('pool bill currency mismatch');
    if (!categories.has(line.category) || !['charge', 'credit'].includes(line.kind)) {
      throw new Error('invalid pool bill category or kind');
    }
    const value = line.amountMicros === null ? null : amount(line.amountMicros, 'line amount');
    if (value !== null && (line.kind === 'charge' ? value < 0n : value > 0n)) {
      throw new Error('pool bill charge/credit sign mismatch');
    }

    const weights: { tenantId: string | null; weight: bigint; remainder: bigint; share: bigint }[] = [];
    const allocation = line.allocation;
    if (allocation.kind === 'unresolved') {
      ref(allocation.reason);
      gaps.push(`unresolved-allocation:${line.id}`);
    } else {
      if (!['compute', 'weighted'].includes(allocation.kind)) throw new Error('invalid pool bill allocation');
      const tenants = new Set<string>();
      let used = 0n;
      const weightedTenants = allocation.kind === 'compute'
        ? allocation.tenants.map((tenant) => ({ tenantId: tenant.tenantId, weight: tenant.activeAgentMilliseconds }))
        : allocation.tenants;
      for (const tenant of weightedTenants) {
        ref(tenant.tenantId);
        if (tenants.has(tenant.tenantId)) throw new Error('duplicate pool bill tenant');
        tenants.add(tenant.tenantId);
        const weight = amount(tenant.weight, 'tenant allocation weight', true);
        weights.push({ tenantId: tenant.tenantId, weight, remainder: 0n, share: 0n });
        used += weight;
      }
      let shared: bigint;
      if (allocation.kind === 'compute') {
        ref(allocation.capacityEvidenceRef);
        const achieved = amount(allocation.achievedAgentMilliseconds, 'achieved agent milliseconds', true);
        if (used > achieved) throw new Error('tenant activity exceeds achieved capacity');
        shared = achieved - used;
      } else {
        shared = amount(allocation.overheadWeight, 'overhead weight', true);
      }
      // No activity does not erase a warm host, retained disk or control-plane bill.
      if (used + shared === 0n) shared = 1n;
      weights.push({ tenantId: null, weight: shared, remainder: 0n, share: 0n });
    }
    if (value === null) {
      unpricedLineIds.push(line.id);
      if (line.kind === 'charge') unpricedCharge = true;
      else unpricedCredit = true;
      gaps.push(`unpriced:${line.id}`);
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: null, tenants: [], overheadMicros: null, unallocatedMicros: null };
    }
    known += value;
    if (line.kind === 'credit') credits += value;
    if (allocation.kind === 'unresolved') {
      unallocated += value;
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: safe(value), tenants: [], overheadMicros: 0, unallocatedMicros: safe(value) };
    }
    const denominator = weights.reduce((sum, row) => sum + row.weight, 0n);
    const absolute = value < 0n ? -value : value;
    let remainder = absolute;
    for (const row of weights) {
      row.share = absolute * row.weight / denominator;
      row.remainder = absolute * row.weight % denominator;
      remainder -= row.share;
    }
    // Largest remainder, with a stable identifier tie break. Credits use the same
    // split with the opposite sign; neither currency micros nor overhead disappear.
    weights.sort((a, b) => a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1)
      : a.tenantId === null ? (b.tenantId === null ? 0 : 1)
      : b.tenantId === null ? -1 : a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    for (const row of weights) {
      if (remainder > 0n) { row.share++; remainder--; }
      if (value < 0n) row.share = -row.share;
    }
    const shared = weights.find((row) => row.tenantId === null)!.share;
    overhead += shared;
    const tenants = weights.filter((row) => row.tenantId !== null).map((row) => {
      const tenantId = row.tenantId!;
      tenantTotals.set(tenantId, (tenantTotals.get(tenantId) ?? 0n) + row.share);
      return { tenantId, amountMicros: safe(row.share) };
    }).sort((a, b) => a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
      amountMicros: safe(value), tenants, overheadMicros: safe(shared), unallocatedMicros: 0 };
  });
  const unknownRateAllocation = total - known;
  if ((!unpricedLineIds.length && unknownRateAllocation !== 0n)
    || (unknownRateAllocation > 0n && !unpricedCharge) || (unknownRateAllocation < 0n && !unpricedCredit)) {
    throw new Error('pool bill total does not reconcile to its lines');
  }
  unallocated += unknownRateAllocation;
  const tenants = [...tenantTotals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([tenantId, micros]) => ({ tenantId, amountMicros: safe(micros) }));
  const tenantTotal = [...tenantTotals.values()].reduce((sum, value) => sum + value, 0n);
  if (tenantTotal + overhead + unallocated !== total) throw new Error('pool bill allocation lost money');
  return { periodRef: input.periodRef, currency: input.currency, totalMicros: safe(total),
    tenants, tenantTotalMicros: safe(tenantTotal), overheadMicros: safe(overhead),
    unallocatedMicros: safe(unallocated), unknownRateAllocationMicros: safe(unknownRateAllocation),
    creditsMicros: safe(credits), creditsExcludedTotalMicros: unpricedLineIds.length ? null : safe(total - credits),
    complete: gaps.length === 0, unpricedLineIds, gaps, lines };
}

export function capacity(id: string): Capacity {
  const c = CAPACITY.find((x) => x.id === id);
  if (!c) throw new Error(`unknown capacity row '${id}'`);
  return c;
}

/** Server RAM after a lever that frees `savedGiB` per tenant (P-532: embed model in an idle-exiting sidecar). */
export function serverRamGiB(savedGiB = 0): number {
  if (savedGiB < 0 || savedGiB >= SERVER.ramGiB) throw new Error(`savedGiB ${savedGiB} out of range`);
  return SERVER.ramGiB - savedGiB;
}

/** Tenants per packing host: bound by usable RAM after the reserve, and by CPU. */
export function tenantsPerHost(savedGiB = 0): number {
  const { vcpus, ramGb } = parseMachineType(SERVER.packHost);
  const byRam = Math.floor((ramGb * SERVER.usableRamFraction - SERVER.reserveGiB) / serverRamGiB(savedGiB));
  const byCpu = Math.floor(vcpus / SERVER.cores);
  return Math.min(byRam, byCpu);
}

/** Server cost per workspace-month: [floor, packed]. */
export function serverMonthUsd(savedGiB = 0): { floor: number; packed: number } {
  const e2 = SPOT_PRICES_2026_10_01.e2;
  if (!e2) throw new Error('no e2 spot price');
  const floor = (SERVER.cores * e2.vcpuHour + serverRamGiB(savedGiB) * e2.gbRamHour) * HOURS_PER_MONTH;
  const packed = hostMonthUsd(SERVER.packHost, true) / tenantsPerHost(savedGiB);
  return { floor, packed };
}

export function pooledComputeUsd(agents: number, cap: Capacity, spot: boolean): number {
  return (agents * DUTY.mean * hostMonthUsd(cap.machineType, spot)) / cap.active;
}

export function dedicatedHosts(agents: number, cap: Capacity): number {
  const busyAtP99 = agents * DUTY.mean * DUTY.p99OverMean;
  return Math.max(1, Math.ceil(busyAtP99 / (cap.active - 1)));
}

export interface Scenario {
  id: string;
  label: string;
  workload: Workload;
  placement: 'dedicated' | 'pooled';
  spot: boolean;
  capacityId: string;
  /** Apply the P-532 per-tenant saving (only meaningful for pooled placement). */
  p532?: boolean;
}

/** The lever ladder: each row adds one lever to the row above it. */
export const SCENARIOS: readonly Scenario[] = [
  { id: 'M0', label: 'own VM per workspace, right-sized e2, on-demand', workload: 'mixed', placement: 'dedicated', spot: false, capacityId: 'mixed-e2s8' },
  { id: 'M1', label: '+ spot', workload: 'mixed', placement: 'dedicated', spot: true, capacityId: 'mixed-e2s8' },
  { id: 'M2', label: '+ shared pool, Servers packed (e2-standard-16 spot)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2s16' },
  { id: 'M3', label: '+ lean shape e2-custom-16-32768', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-e2c16' },
  { id: 'M4', label: '+ Arm c4a-highcpu-16', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16' },
  { id: 'M5', label: '+ P-532 embed sidecar (Server RAM)', workload: 'mixed', placement: 'pooled', spot: true, capacityId: 'mixed-c4ahc16', p532: true },
  { id: 'H0', label: 'heavy work: shared pool, spot e2-standard-16, no levers', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16' },
  { id: 'H1', label: '+ heavy-job admission', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm' },
  { id: 'H2', label: '+ shared tsc-service', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc' },
  { id: 'H3', label: '+ P-532 embed sidecar (Server RAM)', workload: 'heavy', placement: 'pooled', spot: true, capacityId: 'heavy-e2s16-adm-tsc', p532: true },
];

export interface Row {
  id: string;
  label: string;
  workload: Workload;
  agents: number;
  machineType: string;
  hosts: number | null;
  computeUsd: number;
  serverUsd: { floor: number; packed: number };
  totalUsd: { floor: number; packed: number };
  perAgentUsd: { floor: number; packed: number };
  /** OWNER_BASELINE cost scaled to `agents`, divided by the packed total. */
  reductionVsBaseline: number;
  /** Graded on the packed (as-measured) total; meaningful at TARGET.agents. */
  meetsTarget: boolean;
  /** True when capacity is a lower bound, so the cost is an upper bound. */
  costIsUpperBound: boolean;
  /** True when the row needs a P-532 saving that has not been measured yet. */
  pending: boolean;
  sources: string[];
}

export function evaluate(s: Scenario, agents: number, p532SavedGiB: number | null): Row {
  const cap = capacity(s.capacityId);
  if (cap.workload !== s.workload) throw new Error(`${s.id}: capacity row ${cap.id} is ${cap.workload}, scenario is ${s.workload}`);
  const pending = !!s.p532 && p532SavedGiB === null;
  const saved = s.p532 && p532SavedGiB !== null ? p532SavedGiB : 0;
  let hosts: number | null = null;
  let computeUsd: number;
  let serverUsd: { floor: number; packed: number };
  if (s.placement === 'dedicated') {
    hosts = dedicatedHosts(agents, cap);
    computeUsd = hosts * hostMonthUsd(cap.machineType, s.spot);
    serverUsd = { floor: 0, packed: 0 };
  } else {
    computeUsd = pooledComputeUsd(agents, cap, s.spot);
    serverUsd = serverMonthUsd(saved);
  }
  const totalUsd = { floor: computeUsd + serverUsd.floor, packed: computeUsd + serverUsd.packed };
  const baseline = (OWNER_BASELINE.usdMonth / OWNER_BASELINE.agents) * agents;
  return {
    id: s.id,
    label: s.label,
    workload: s.workload,
    agents,
    machineType: cap.machineType,
    hosts,
    computeUsd,
    serverUsd,
    totalUsd,
    perAgentUsd: { floor: totalUsd.floor / agents, packed: totalUsd.packed / agents },
    reductionVsBaseline: baseline / totalUsd.packed,
    meetsTarget: totalUsd.packed <= (TARGET.googleUsdMonthMax / TARGET.agents) * agents,
    costIsUpperBound: !!cap.atLeast,
    pending,
    sources: [cap.source, DUTY.source, ...(s.placement === 'pooled' ? [SERVER.source, 'D-022'] : [])],
  };
}

export function buildRows(agents: number, p532SavedGiB: number | null): Row[] {
  return SCENARIOS.map((s) => evaluate(s, agents, p532SavedGiB));
}

const usd = (n: number) => n.toFixed(n < 10 ? 2 : 0);

const MONTH_COST_KEYS = ['retainedStorageUsd', 'provisionedPerformanceUsd', 'backupUsd',
  'objectStorageUsd', 'networkUsd', 'controlUsd', 'warmCapacityUsd', 'inferenceUsd'] as const;

/** P544: price recorded model requests, never CLI-reported dollars or response text.
 * Each request selects its own context tier. Failed/truncated/unpriced requests remain
 * in the population and keep the full estimate unknown; priced portions are a floor.
 * Reuses the recorder's byte decoder, replay SSE parser and canonical list-price table.
 */
export function recordedInferenceCost(exchanges: readonly RecordedExchange[]) {
  const rec = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const rows = exchanges.filter((ex) => /\/(messages|responses)(?:\?|$)/.test(ex.path)).map((ex) => {
    const protocol = /\/responses(?:\?|$)/.test(ex.path) ? 'responses' : 'messages';
    let model: string | null = null, complete = false, streamError = false;
    let raw: Record<string, unknown> = {};
    let finalResponse: Record<string, unknown> | null = null;
    const gaps: string[] = [];
    const apply = (v: unknown) => { const u = rec(v); if (u) raw = { ...raw, ...u }; };
    const response = (v: unknown) => {
      const r = rec(v);
      if (!r) return;
      // Duplicate terminal events are snapshots, never additional token charges.
      if (finalResponse && JSON.stringify(finalResponse) !== JSON.stringify(r)) gaps.push('conflicting-terminal');
      finalResponse = r;
      model = typeof r.model === 'string' && r.model.trim() ? r.model : null;
      apply(r.usage);
      complete = r.status === 'completed';
    };
    if (ex.req.stream) {
      for (const event of sseEvents(ex.chunks)) {
        const j = event.data;
        if (!j) continue;
        if (protocol === 'responses') {
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(j.type))) response(j.response);
          if (j.type === 'error' || j.type === 'response.failed') streamError = true;
        } else {
          if (j.type === 'message_start') {
            const message = rec(j.message);
            model = typeof message?.model === 'string' && message.model.trim() ? message.model : null;
            apply(message?.usage);
          } else if (j.type === 'message_delta') apply(j.usage);
          else if (j.type === 'message_stop') complete = true;
          else if (j.type === 'error') streamError = true;
        }
      }
    } else {
      try {
        const j = rec(JSON.parse(Buffer.concat(ex.chunks.map(decodeChunk)).toString('utf8')));
        if (protocol === 'responses') response(j);
        else if (j) {
          model = typeof j.model === 'string' && j.model.trim() ? j.model : null;
          apply(j.usage);
          complete = typeof j.stop_reason === 'string';
        }
      } catch { gaps.push('invalid-json'); }
    }
    if (ex.status < 200 || ex.status >= 300 || ex.error || streamError) gaps.push('request-error');
    if (!complete) gaps.push('incomplete-response');
    if (!model) gaps.push('missing-served-model');
    const usage: TokenUsage = {};
    let valid = true;
    const set = (key: keyof TokenUsage, value: unknown) => {
      if (!count(value)) { valid = false; return; }
      Object.assign(usage, { [key]: value });
    };
    set('inputTokens', raw.input_tokens);
    set('outputTokens', raw.output_tokens);
    if (protocol === 'responses') {
      const details = rec(raw.input_tokens_details);
      set('cacheReadTokens', details?.cached_tokens);
      set('cacheCreationTokens', details?.cache_write_tokens);
      if (valid) {
        usage.requestInputTokens = usage.inputTokens!;
        usage.inputTokens = usage.inputTokens! - usage.cacheReadTokens! - usage.cacheCreationTokens!;
        if (!count(usage.inputTokens)) valid = false;
      }
    } else {
      set('cacheReadTokens', raw.cache_read_input_tokens);
      set('cacheCreationTokens', raw.cache_creation_input_tokens);
      const tiers = rec(raw.cache_creation);
      if (tiers) {
        set('cacheCreation5mTokens', tiers.ephemeral_5m_input_tokens);
        set('cacheCreation1hTokens', tiers.ephemeral_1h_input_tokens);
      } else if (count(raw.cache_creation_input_tokens) && raw.cache_creation_input_tokens > 0) {
        usage.cacheCreationTierUnknown = true;
      }
      if (valid) usage.requestInputTokens = usage.inputTokens! + usage.cacheReadTokens! + usage.cacheCreationTokens!;
    }
    if (!count(usage.requestInputTokens)) valid = false;
    if (!valid) gaps.push('missing-or-invalid-usage');
    const price = valid && model ? costFromTokens(model, usage, USAGE_LEDGER_PRICING) : null;
    if (!price?.priced) gaps.push('unpriced');
    if (price?.bound) gaps.push('price-lower-bound');
    const knownEstimatedUsd = price?.priced ? price.usd : 0;
    return { sessionId: ex.sessionId, seq: ex.seq, startedAt: ex.startedAt,
      protocol, httpStatus: ex.status, requestedModel: ex.req.model, servedModel: model, complete, usage,
      estimatedUsd: gaps.length ? null : knownEstimatedUsd, knownEstimatedUsd, gaps };
  });
  const knownEstimatedInferenceUsd = rows.reduce((sum, row) => sum + row.knownEstimatedUsd, 0);
  if (!Number.isFinite(knownEstimatedInferenceUsd)) throw new Error('recorded inference cost overflow');
  const complete = rows.length > 0 && rows.every((row) => row.estimatedUsd !== null);
  return { priceTableVersion: PRICE_TABLE_VERSION, costSource: 'estimated' as const,
    requests: rows.length, pricedRequests: rows.filter((r) => r.estimatedUsd !== null).length,
    estimatedInferenceUsd: complete ? knownEstimatedInferenceUsd : null,
    knownEstimatedInferenceUsd, estimateIsLowerBound: !complete, billedInferenceUsd: null, rows };
}

/** D-081: coding-task observations, kept separate from VM hours and hash-tool probes.
 * Totals include censored/failed tasks; completedTasks must never silently shrink the denominator.
 * Even an observed billed sample supplies a modeled month, not an observed monthly invoice.
 */
export interface TrialTaskMonthInput {
  assignedAgents: number;
  activeVmHours: number;
  strata: readonly {
    id: string;
    profile: 'light' | 'typical' | 'heavy';
    cli: 'claude' | 'codex';
    model: string | null;
    effort: string | null;
    monthlyTasks: number;
    observedTasks: number;
    completedTasks: number;
    taskWallSeconds: number;
    estimatedInferenceUsd: number | null;
    billedInferenceUsd: number | null;
    sourceRef: string;
  }[];
}

export function trialTaskMonth(input: TrialTaskMonthInput) {
  if (!input || !Array.isArray(input.strata as unknown) || !input.strata.length) throw new Error('task workload requires strata');
  if (!Number.isSafeInteger(input.assignedAgents) || input.assignedAgents < 1) throw new Error('invalid assignedAgents');
  if (!Number.isFinite(input.activeVmHours) || input.activeVmHours < 0 || input.activeVmHours > HOURS_PER_MONTH) {
    throw new Error('invalid activeVmHours');
  }
  const ids = new Set<string>();
  const taskCounts = { light: 0, typical: 0, heavy: 0 };
  let taskSeconds = 0;
  let estimatedInferenceUsd: number | null = 0;
  let billedBasisInferenceUsd: number | null = 0;
  const censoredStrata: string[] = [];
  const unknownBindings: string[] = [];
  for (const s of input.strata) {
    if (!s || typeof s.id !== 'string' || !s.id.trim() || ids.has(s.id)) throw new Error('invalid or duplicate task stratum');
    ids.add(s.id);
    if (!Object.hasOwn(taskCounts, s.profile) || !['claude', 'codex'].includes(s.cli)) throw new Error('invalid task profile or CLI');
    if (typeof s.sourceRef !== 'string' || !s.sourceRef.trim()) throw new Error('task stratum requires sourceRef');
    for (const key of ['model', 'effort'] as const) {
      if (s[key] !== null && (typeof s[key] !== 'string' || !s[key]!.trim())) throw new Error(`invalid task ${key}`);
    }
    for (const key of ['monthlyTasks', 'observedTasks', 'completedTasks'] as const) {
      if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw new Error(`invalid task ${key}`);
    }
    if (!s.observedTasks || s.completedTasks > s.observedTasks) throw new Error('invalid task sample population');
    if (!Number.isFinite(s.taskWallSeconds) || s.taskWallSeconds < 0) throw new Error('invalid taskWallSeconds');
    for (const key of ['estimatedInferenceUsd', 'billedInferenceUsd'] as const) {
      if (s[key] !== null && (!Number.isFinite(s[key]) || s[key]! < 0)) throw new Error(`invalid task ${key}`);
    }
    taskCounts[s.profile] += s.monthlyTasks;
    const scale = s.monthlyTasks / s.observedTasks;
    taskSeconds += s.taskWallSeconds * scale;
    if (!s.monthlyTasks) continue;
    if (s.completedTasks < s.observedTasks) censoredStrata.push(s.id);
    if (s.model === null || s.effort === null) unknownBindings.push(s.id);
    estimatedInferenceUsd = estimatedInferenceUsd === null || s.estimatedInferenceUsd === null
      ? null : estimatedInferenceUsd + s.estimatedInferenceUsd * scale;
    billedBasisInferenceUsd = billedBasisInferenceUsd === null || s.billedInferenceUsd === null
      ? null : billedBasisInferenceUsd + s.billedInferenceUsd * scale;
  }
  const monthlyTasks = taskCounts.light + taskCounts.typical + taskCounts.heavy;
  const busyAgentHours = taskSeconds / 3600;
  if (!Number.isSafeInteger(monthlyTasks) || !Number.isFinite(busyAgentHours)
    || [estimatedInferenceUsd, billedBasisInferenceUsd].some((v) => v !== null && !Number.isFinite(v))) {
    throw new Error('task workload overflow');
  }
  if (busyAgentHours > input.assignedAgents * input.activeVmHours || (monthlyTasks > 0 && input.activeVmHours === 0)) {
    throw new Error('task workload exceeds active VM population hours');
  }
  return { assignedAgents: input.assignedAgents, activeVmHours: input.activeVmHours, monthlyTasks,
    taskCounts, busyAgentHours, busyHoursLowerBound: censoredStrata.length > 0,
    modeledInferenceEstimateUsd: estimatedInferenceUsd, modeledInferenceBilledBasisUsd: billedBasisInferenceUsd,
    censoredStrata, unknownBindings, sourceRefs: input.strata.map((s) => s.sourceRef) };
}

/** Closed D-081 population. These are workspace task counts, never per-agent counts. */
export const TRIAL_MONTH_PROFILES = [
  { id: 'near-idle', activeVmHours: 5, monthlyTasks: 10 },
  { id: '60h', activeVmHours: 60, monthlyTasks: 120 },
  { id: '120h', activeVmHours: 120, monthlyTasks: 240 },
  { id: '240h', activeVmHours: 240, monthlyTasks: 480 },
] as const;
export const TRIAL_COST_CATEGORIES = ['compute', 'retained-disks', 'backups',
  'network', 'control-plane', 'inference'] as const;
export interface TrialMonthlyCostInput {
  profileId: string;
  workload: TrialTaskMonthInput;
  /** USD micros before credits, including this workspace's allocated shared costs.
   * A source reference alone does not authenticate a bill; reviewers must resolve it. */
  costs: Partial<Record<typeof TRIAL_COST_CATEGORIES[number], {
    amountMicros: number | null;
    currency: string;
    basis: 'measured-usage' | 'catalog-only' | 'unknown';
    usageRef: string | null;
    rateRef: string | null;
    allocationRef: string | null;
  }>>;
}

/** Supporting R-14 cost detector. It cannot qualify a VM or authenticate evidence.
 * Reuses task-workload validation; no missing/estimated cost becomes an observed zero.
 * Compare integer micros to the strict $20 bound, retaining incomplete profiles.
 */
export function trialMonthlyCostCoverage(inputs: readonly TrialMonthlyCostInput[]) {
  if (!Array.isArray(inputs)) throw new Error('trial monthly costs must be an array');
  const byId = new Map<string, TrialMonthlyCostInput>();
  for (const input of inputs) {
    if (!input || !TRIAL_MONTH_PROFILES.some((p) => p.id === input.profileId)) throw new Error('unknown trial monthly profile');
    if (byId.has(input.profileId)) throw new Error('duplicate trial monthly profile');
    byId.set(input.profileId, input);
  }
  const profiles = TRIAL_MONTH_PROFILES.map((profile) => {
    const input = byId.get(profile.id);
    const gaps: string[] = [];
    if (!input) return { ...profile, status: 'unknown' as const, totalMicros: null,
      knownMicros: 0, gaps: ['missing-profile'] };
    const workload = trialTaskMonth(input.workload);
    const populationMatches = !(workload.assignedAgents !== 50 || workload.activeVmHours !== profile.activeVmHours
      || workload.monthlyTasks !== profile.monthlyTasks
      || workload.taskCounts.light * 5 !== profile.monthlyTasks * 2
      || workload.taskCounts.typical * 5 !== profile.monthlyTasks * 2
      || workload.taskCounts.heavy * 5 !== profile.monthlyTasks);
    if (!populationMatches) gaps.push('workload-population');
    if (workload.censoredStrata.length) gaps.push('censored-workload');
    if (workload.unknownBindings.length) gaps.push('unknown-model-effort');
    if (!input.costs || typeof input.costs !== 'object' || Array.isArray(input.costs)) throw new Error('invalid trial costs');
    if (Object.keys(input.costs).some((key) => !TRIAL_COST_CATEGORIES.includes(key as typeof TRIAL_COST_CATEGORIES[number]))) {
      throw new Error('unknown trial cost category');
    }
    let known = 0n;
    for (const category of TRIAL_COST_CATEGORIES) {
      const cost = input.costs[category];
      if (cost === undefined) { gaps.push(`${category}:missing`); continue; }
      if (!cost || !['measured-usage', 'catalog-only', 'unknown'].includes(cost.basis)) throw new Error('invalid trial cost basis');
      if (cost.currency !== 'USD') throw new Error('trial cost currency must be USD');
      if (cost.amountMicros !== null && (!Number.isSafeInteger(cost.amountMicros) || cost.amountMicros < 0)) {
        throw new Error('invalid trial cost micros');
      }
      for (const key of ['usageRef', 'rateRef', 'allocationRef'] as const) {
        if (cost[key] !== null && (typeof cost[key] !== 'string' || !cost[key]!.trim())) throw new Error('invalid trial cost reference');
      }
      if (cost.amountMicros === null || cost.basis !== 'measured-usage'
        || !cost.usageRef || !cost.rateRef || !cost.allocationRef) {
        gaps.push(`${category}:unmeasured`);
        continue;
      }
      known += BigInt(cost.amountMicros);
    }
    if (known > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('trial cost total overflow');
    const knownMicros = Number(known);
    // A known subtotal already at the bound disproves under-$20 even with gaps.
    const status = populationMatches && known >= 20_000_000n ? 'over-limit' as const
      : gaps.length ? 'unknown' as const : 'under-limit' as const;
    return { ...profile, status, totalMicros: gaps.length ? null : knownMicros, knownMicros, gaps };
  });
  return { costOnly: true as const, qualification: 'not-evaluated' as const,
    status: profiles.some((p) => p.status === 'over-limit') ? 'over-limit' as const
      : profiles.every((p) => p.status === 'under-limit') ? 'under-limit' as const : 'unknown' as const,
    profiles };
}

/** Supporting comparison inputs, not an activated tariff or a qualified trial profile.
 * Each value is the additional monthly cost beyond the legacy compute/Server row;
 * do not count a disk or a warm Server already included in that row twice.
 * Omitted/null costs stay unknown. Explicit zero, like any supplied value, needs a source.
 */
export type CostReportMonth = Partial<Record<typeof MONTH_COST_KEYS[number], number | null>> & {
  /** Sum of actual busy time across agents, not VM running hours or assigned slots. */
  busyAgentHours?: number;
  /** Optional corpus-based monthly scenario; does not fill inferenceUsd or qualify D-076. */
  taskWorkload?: TrialTaskMonthInput;
  /** Optional complete D-081 census; does not qualify R-15 or activate a price. */
  trialCostProfiles?: readonly TrialMonthlyCostInput[];
  /** Binds the supplied monthly inputs/usage to their evidence; no inference from its presence. */
  sourceRef?: string;
};

export function pricingComparison(rows: Row[], month: CostReportMonth = {}) {
  if (!month || typeof month !== 'object' || Array.isArray(month)) throw new Error('report-month must be an object');
  if (month.busyAgentHours === null) throw new Error('invalid busyAgentHours');
  const workload = month.taskWorkload === undefined ? null : trialTaskMonth(month.taskWorkload);
  if (workload && month.busyAgentHours !== undefined) throw new Error('supply taskWorkload or busyAgentHours, not both');
  const supplied = workload !== null || [...MONTH_COST_KEYS, 'busyAgentHours' as const].some((key) => month[key] != null);
  if (supplied && (typeof month.sourceRef !== 'string' || !month.sourceRef.trim())) {
    throw new Error('monthly comparison inputs require sourceRef');
  }
  for (const key of [...MONTH_COST_KEYS, 'busyAgentHours' as const]) {
    const value = month[key];
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error(`invalid ${key}`);
  }
  const missingCosts = MONTH_COST_KEYS.filter((key) => month[key] == null);
  const infrastructureKeys = MONTH_COST_KEYS.filter((key) => key !== 'inferenceUsd');
  const additionalInfrastructureUsd = infrastructureKeys.some((key) => month[key] == null)
    ? null : infrastructureKeys.reduce((sum, key) => sum + month[key]!, 0);
  const inferenceUsd = month.inferenceUsd ?? null;
  const total = (core: number) => additionalInfrastructureUsd === null || inferenceUsd === null
    ? null : core + additionalInfrastructureUsd + inferenceUsd;
  // Dedicated VM costs are lumpy: dividing them into a metered pool rate would imply
  // packing/reclaim behavior those measurements do not establish.
  return rows.filter((row) => row.hosts === null).map((row) => {
    if (!Number.isSafeInteger(row.agents) || row.agents < 1) throw new Error('invalid assigned agents');
    if (workload && workload.assignedAgents !== row.agents) throw new Error('task workload assigned population mismatch');
    for (const value of [row.serverUsd.packed, row.computeUsd]) {
      if (!Number.isFinite(value) || value < 0) throw new Error('invalid comparison cost');
    }
    const assignedAgentMonthUsd = row.computeUsd / row.agents;
    const busyAgentHourUsd = assignedAgentMonthUsd / (HOURS_PER_MONTH * DUTY.mean);
    const busyAgentHours = workload?.busyAgentHours ?? month.busyAgentHours ?? row.agents * HOURS_PER_MONTH * DUTY.mean;
    if (busyAgentHours > row.agents * HOURS_PER_MONTH) throw new Error('busy agent hours exceed assigned population month');
    const basePlusAgentCoreUsd = row.serverUsd.packed + row.computeUsd;
    const busyHoursCoreUsd = row.serverUsd.packed + busyAgentHours * busyAgentHourUsd;
    const basePlusAgentTotalUsd = total(basePlusAgentCoreUsd);
    const busyHoursTotalUsd = total(busyHoursCoreUsd);
    for (const value of [additionalInfrastructureUsd, basePlusAgentCoreUsd, busyHoursCoreUsd,
      basePlusAgentTotalUsd, busyHoursTotalUsd]) {
      if (value !== null && !Number.isFinite(value)) throw new Error('comparison total overflow');
    }
    return { id: row.id, assignedAgents: row.agents, baseServerUsd: row.serverUsd.packed,
      assignedAgentMonthUsd, busyAgentHourUsd, busyAgentHours,
      busyHoursModeled: month.busyAgentHours === undefined, taskWorkload: workload,
      basePlusAgentCoreUsd, busyHoursCoreUsd, additionalInfrastructureUsd, inferenceUsd,
      basePlusAgentTotalUsd, busyHoursTotalUsd, missingCosts, pending: row.pending,
      costIsUpperBound: row.costIsUpperBound, sources: row.sources, inputSourceRef: month.sourceRef ?? null };
  });
}

export function renderMarkdown(rows: Row[], month: CostReportMonth = {}): string {
  const out = [
    'Historical compute + Server cost basis (USD/month). The target below is D-003, not the all-in trial acceptance gate.',
    '',
    `| id | lever combination | shape | compute | Server (floor-packed) | total (floor-packed) | per agent | x vs ${OWNER_BASELINE.usdMonth}/${OWNER_BASELINE.agents} | target |`,
    '|---|---|---|---|---|---|---|---|---|',
  ];
  if (month.taskWorkload !== undefined) {
    const w = trialTaskMonth(month.taskWorkload);
    out.unshift(`Task scenario: ${w.monthlyTasks} coding tasks (${w.taskCounts.light} light, ${w.taskCounts.typical} typical, ${w.taskCounts.heavy} heavy), ${w.assignedAgents} assigned agents, ${w.activeVmHours} active VM hours; ${w.busyAgentHours.toFixed(3)} modeled busy-agent hours${w.busyHoursLowerBound ? ' (lower bound: censored tasks retained)' : ''}.`,
      `Modeled inference estimate: ${w.modeledInferenceEstimateUsd === null ? 'UNKNOWN' : usd(w.modeledInferenceEstimateUsd)}; billed-sample basis: ${w.modeledInferenceBilledBasisUsd === null ? 'UNKNOWN' : usd(w.modeledInferenceBilledBasisUsd)}. These projections do not populate observed monthly inference or establish D-076 acceptance.`,
      `Unknown model/effort bindings: ${w.unknownBindings.join(', ') || 'none'}; censored strata: ${w.censoredStrata.join(', ') || 'none'}.`, '');
  }
  for (const r of rows) {
    const ub = r.costIsUpperBound ? '<=' : '';
    const tgt = r.pending ? 'PENDING P-532' : r.meetsTarget ? 'yes' : 'no';
    const hosts = r.hosts === null ? '' : ` x${r.hosts}`;
    out.push(
      `| ${r.id} | ${r.label} | ${r.machineType}${hosts} | ${ub}${usd(r.computeUsd)} | ${usd(r.serverUsd.floor)}-${usd(r.serverUsd.packed)} | ${ub}${usd(r.totalUsd.floor)}-${usd(r.totalUsd.packed)} | ${ub}${usd(r.perAgentUsd.floor)}-${usd(r.perAgentUsd.packed)} | ${r.reductionVsBaseline.toFixed(1)}x | ${tgt} |`,
    );
  }
  const comparison = pricingComparison(rows, month);
  if (month.trialCostProfiles !== undefined) {
    const coverage = trialMonthlyCostCoverage(month.trialCostProfiles);
    out.push('', '## Trial monthly cost coverage', '',
      `Cost coverage: ${coverage.status}. VM qualification and evidence authenticity require separate verification.`, '',
      '| profile | tasks | active VM hours | cost status | total USD | gaps |',
      '|---|---|---|---|---|---|');
    for (const p of coverage.profiles) out.push(`| ${p.id} | ${p.monthlyTasks} | ${p.activeVmHours} | ${p.status} | ${p.totalMicros === null ? 'UNKNOWN' : (p.totalMicros / 1e6).toFixed(6)} | ${p.gaps.join(', ') || 'none'} |`);
  }
  const money = (value: number | null) => value === null ? 'UNKNOWN' : value.toFixed(2);
  out.push('', '## Pricing alternatives (cost basis; no customer price activated)', '',
    'Base plus agent = packed Server base + assigned agents × agent-month cost. Busy-hours = the same base + summed busy-agent-hours × busy-agent-hour cost.',
    'Rates reuse achieved capacity and D-038 duty. Default busy hours are modeled at 35% duty, not observed usage. Dedicated VM rows are excluded because their host costs are lumpy.',
    'Additional infrastructure and inference are separate monthly inputs. Missing categories keep both all-in totals UNKNOWN; explicit zero requires a source. PENDING and capacity-bound rows retain their qualification limits.', '',
    '| id | base Server | per assigned agent/month | per busy-agent-hour | busy-agent-hours | base + agent core | busy-hours core | extra infrastructure | inference | base + agent all-in | busy-hours all-in | status |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of comparison) {
    out.push(`| ${r.id} | ${money(r.baseServerUsd)} | ${money(r.assignedAgentMonthUsd)} | ${r.busyAgentHourUsd.toFixed(6)} | ${r.busyAgentHours.toFixed(2)} (${r.busyHoursModeled ? 'modeled' : 'supplied'}) | ${money(r.basePlusAgentCoreUsd)} | ${money(r.busyHoursCoreUsd)} | ${money(r.additionalInfrastructureUsd)} | ${money(r.inferenceUsd)} | ${money(r.basePlusAgentTotalUsd)} | ${money(r.busyHoursTotalUsd)} | ${r.pending ? 'PENDING P-532' : 'supporting model'}${r.costIsUpperBound ? '; capacity lower bound' : ''} |`);
  }
  out.push('');
  for (const r of comparison) {
    out.push(`Inputs ${r.id}: ${r.sources.join('; ')}; monthly inputs: ${r.inputSourceRef ?? 'not supplied'}; unknown: ${r.missingCosts.join(', ') || 'none'}.`);
  }
  return out.join('\n');
}

type TrialEvidenceRef = { path: string; sha256: string };
type TrialNativeIdentity = Record<string, string>;
export interface TrialEconomicOption {
  id: string;
  identity: TrialNativeIdentity;
  warmFloor: number;
  qualification: { directory: string; dossier: string };
  profiles: TrialMonthlyCostInput[];
  /** Purchased capacity, not sparse-file bytes. The supported DB ladder is explicit. */
  storage: { dbGiB: number; purchasedGiB: number; usedGiB: number; economicalDiskRef: string }[];
}
export interface TrialEconomicsDossier {
  schemaVersion: 'p544-economics-v1';
  options: TrialEconomicOption[];
  /** Cost usage/rate/allocation refs resolve to these hashed, retained JSON sources. */
  sources: Record<string, TrialEvidenceRef>;
  selected: Record<string, string>;
  alternatives: {
    backends: { name: string; limits: Record<string, string>; sourceRef: string;
      equivalence: 'not-established' | 'trial-backed'; trialRef?: string }[];
    iac: { foundationScope: string; lifecycleWriter: string; sourceRef: string };
  };
}

/** R-14/R-16 evidence consistency, never provider/billing authenticity or acceptance.
 * The CLI supplies readers that hash retained sources and re-execute the native
 * qualification detector. Pure fixture calls cannot qualify an actual VM.
 */
export function trialEconomicsCoverage(dossier: TrialEconomicsDossier, expectedSha: string, expectedArtifact: string,
  readSource: (ref: string) => Record<string, unknown>,
  qualify: (option: TrialEconomicOption) => { status: string; identity?: TrialNativeIdentity | null }) {
  const gaps: string[] = [];
  const integer = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const sameIdentity = (a: unknown, b: TrialNativeIdentity) => object(a) &&
    Object.keys(a).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => a[k] === v);
  if (!/^[a-f0-9]{40}$/.test(expectedSha) || !/^[a-f0-9]{64}$/.test(expectedArtifact)
    || !dossier || dossier.schemaVersion !== 'p544-economics-v1' || !Array.isArray(dossier.options)
    || !dossier.options.length || dossier.options.length > 16) throw new Error('invalid economics identity/population');
  const ids = new Set<string>();
  const options = dossier.options.map(option => {
    if (!option || !text(option.id) || ids.has(option.id)) throw new Error('duplicate/invalid economic option');
    ids.add(option.id);
    const local: string[] = [];
    const identity = option.identity;
    if (!object(identity) || !['gcp', 'aws'].includes(identity.provider) ||
      !['runId', 'profile', 'projectOrAccount', 'zone', 'instanceId', 'customerWorkspaceId', 'model', 'effort'].every(k => text(identity[k])) ||
      identity.candidateSha !== expectedSha || identity.artifactSha256 !== expectedArtifact ||
      !integer(option.warmFloor)) local.push('admitted-option-identity');
    const native = qualify(option);
    if (native.status !== 'pass' || !sameIdentity(native.identity, identity)) local.push('native-qualification');
    if (!Array.isArray(option.storage) || option.storage.length !== 3 ||
      [4, 8, 16].some(dbGiB => option.storage.filter(s => s.dbGiB === dbGiB).length !== 1) ||
      option.storage.some(s => !integer(s.purchasedGiB) || !integer(s.usedGiB) || s.usedGiB > s.purchasedGiB ||
        s.purchasedGiB < s.dbGiB || !text(s.economicalDiskRef))) local.push('purchased-storage-ladder');
    for (const storage of option.storage ?? []) {
      try {
        const source = readSource(storage.economicalDiskRef);
        if (source.kind !== 'purchased-storage' || !sameIdentity(source.identity, identity) ||
          !text(source.sourceRef) || ['dbGiB', 'purchasedGiB', 'usedGiB'].some(k =>
            source[k] !== storage[k as 'dbGiB' | 'purchasedGiB' | 'usedGiB'])) local.push('storage-source');
      } catch { local.push('storage-source'); }
    }
    const coverage = trialMonthlyCostCoverage(option.profiles);
    for (const profile of option.profiles) {
      const duty = TRIAL_MONTH_PROFILES.find(p => p.id === profile.profileId)!;
      if (profile.workload.strata.some(s => s.model !== identity.model || s.effort !== identity.effort)) local.push('workload-model-effort');
      // Full source amounts are recomputed. An inline passing cost summary is insufficient.
      for (const category of TRIAL_COST_CATEGORIES) {
        const cost = profile.costs[category];
        const label = `${profile.profileId}:${category}`;
        if (!cost?.usageRef || !cost.rateRef || !cost.allocationRef) { local.push(`${label}:sources`); continue; }
        try {
          const usage = readSource(cost.usageRef), rate = readSource(cost.rateRef), allocation = readSource(cost.allocationRef);
          if (usage.kind !== 'usage' || !sameIdentity(usage.identity, identity) || usage.profileId !== profile.profileId ||
            usage.category !== category || !text(usage.sourceRef) || !text(usage.unit) ||
            !integer(usage.observedQuantityMicros) || usage.observedQuantityMicros === 0 ||
            !integer(usage.monthQuantityMicros) || usage.provenance !== 'observed-to-month' ||
            !integer(usage.observedExposureMicros) || usage.observedExposureMicros === 0 ||
            !['active-hours', 'tasks', 'retained-month'].includes(String(usage.projectionBasis)) ||
            !text(usage.windowStart) || !text(usage.windowEnd) ||
            !Number.isFinite(Date.parse(usage.windowStart)) || Date.parse(usage.windowEnd) <= Date.parse(usage.windowStart) ||
            !Number.isFinite(Date.parse(usage.windowEnd)) ||
            rate.kind !== 'rate' || rate.unit !== usage.unit || rate.currency !== 'USD' || !text(rate.sourceRef) ||
            !integer(rate.microsPerUnit) || rate.creditsExcluded !== true ||
            allocation.kind !== 'allocation' || !sameIdentity(allocation.identity, identity) ||
            allocation.profileId !== profile.profileId || allocation.category !== category || !text(allocation.sourceRef) ||
            !integer(allocation.numerator) || !integer(allocation.denominator) || allocation.denominator === 0 ||
            allocation.numerator === 0 || allocation.numerator > allocation.denominator || allocation.includesRetainedAndShared !== true) {
            local.push(`${label}:source-contract`); continue;
          }
          const requiredBasis = category === 'compute' ? 'active-hours' : category === 'inference' ? 'tasks'
            : ['retained-disks', 'backups', 'control-plane'].includes(category) ? 'retained-month' : null;
          if (requiredBasis !== null && usage.projectionBasis !== requiredBasis) { local.push(`${label}:projection-basis`); continue; }
          const exposure = usage.projectionBasis === 'active-hours' ? duty.activeVmHours + 730 * option.warmFloor
            : usage.projectionBasis === 'tasks' ? duty.monthlyTasks : 1;
          if (!Number.isSafeInteger(exposure)) { local.push(`${label}:projection-overflow`); continue; }
          const projected = (BigInt(usage.observedQuantityMicros) * BigInt(exposure) * 1_000_000n
            + BigInt(usage.observedExposureMicros) - 1n) / BigInt(usage.observedExposureMicros);
          if (projected !== BigInt(usage.monthQuantityMicros)) { local.push(`${label}:usage-projection`); continue; }
          const numerator = BigInt(usage.monthQuantityMicros) * BigInt(rate.microsPerUnit) * BigInt(allocation.numerator);
          const denominator = 1_000_000n * BigInt(allocation.denominator);
          const amount = (numerator + denominator - 1n) / denominator;
          if (amount > BigInt(Number.MAX_SAFE_INTEGER) || Number(amount) !== cost.amountMicros) local.push(`${label}:arithmetic`);
        } catch { local.push(`${label}:unreadable-source`); }
      }
    }
    if (coverage.profiles.some(p => p.gaps.length)) local.push('monthly-cost-coverage');
    for (const gap of local) gaps.push(`${option.id}:${gap}`);
    return { id: option.id, provider: identity?.provider, warmFloor: option.warmFloor, coverage, gaps: local };
  });
  // Both providers must have a measured zero-warm-floor alternative; a missing
  // competitor cannot make the available option the economic winner.
  for (const provider of ['gcp', 'aws']) {
    if (!options.some(o => o.provider === provider && o.warmFloor === 0)) gaps.push(`${provider}:zero-warm-floor`);
  }
  if (!object(dossier.selected) || Object.keys(dossier.selected).length !== TRIAL_MONTH_PROFILES.length) gaps.push('selection-population');
  const selected = TRIAL_MONTH_PROFILES.map(profile => {
    const option = options.find(o => o.id === dossier.selected?.[profile.id]);
    const cost = option?.coverage.profiles.find(p => p.id === profile.id);
    const all = options.map(o => o.coverage.profiles.find(p => p.id === profile.id)?.totalMicros);
    if (!option || !cost || all.some(c => c === null || c === undefined) ||
      (cost.totalMicros !== null && all.some(c => c! < cost.totalMicros!))) gaps.push(`${profile.id}:economic-selection`);
    return { profileId: profile.id, optionId: option?.id ?? null, totalMicros: cost?.totalMicros ?? null,
      underLimit: cost?.status === 'under-limit' };
  });
  const alternatives = dossier.alternatives;
  const limits = ['arbitraryCli', 'durableWritableData', 'longLivedSessions', 'extensions', 'isolation'];
  const backendNames = ['cloud-run', 'fargate', 'lambda', 'managed-db'];
  if (!alternatives || !Array.isArray(alternatives.backends) || alternatives.backends.length !== backendNames.length ||
    backendNames.some(name => alternatives.backends.filter(b => b.name === name).length !== 1) ||
    alternatives.backends.some(b => !text(b.sourceRef) || !object(b.limits) || limits.some(k => !text(b.limits[k])) ||
      b.equivalence !== 'not-established') ||
    !alternatives.iac || !text(alternatives.iac.foundationScope) || !text(alternatives.iac.lifecycleWriter) ||
    !text(alternatives.iac.sourceRef)) gaps.push('backend-and-iac-fit');
  for (const backend of alternatives?.backends ?? []) {
    try {
      const source = readSource(backend.sourceRef);
      const observedLimits = source.limits;
      if (source.kind !== 'backend-fit' || source.name !== backend.name || source.equivalence !== 'not-established' ||
        !object(observedLimits) || limits.some(k => observedLimits[k] !== backend.limits[k])) gaps.push('backend-source');
    } catch { gaps.push('backend-source'); }
  }
  if (alternatives?.iac) {
    try {
      const source = readSource(alternatives.iac.sourceRef);
      if (source.kind !== 'iac-fit' || source.foundationScope !== alternatives.iac.foundationScope ||
        source.lifecycleWriter !== alternatives.iac.lifecycleWriter) gaps.push('iac-source');
    } catch { gaps.push('iac-source'); }
  }
  const comparison = gaps.length ? 'unknown' as const : 'pass' as const;
  return { scope: 'P544-composite-economics' as const, qualification: 'independent-review-required' as const,
    comparison, trialCost: comparison === 'unknown' ? 'unknown' as const
      : selected.every(p => p.underLimit) ? 'pass' as const : 'fail' as const,
    gaps: [...new Set(gaps)].sort(), selected, options };
}

/** Read-only route used by the CLI: retained bytes and native measurements, not saved verdicts. */
export function readTrialEconomics(path: string, expectedSha: string, expectedArtifact: string) {
  const root = dirname(resolve(path));
  try {
    const dossier: TrialEconomicsDossier = JSON.parse(readFileSync(path, 'utf8'));
    return trialEconomicsCoverage(dossier, expectedSha, expectedArtifact, ref => {
      const source = dossier.sources[ref];
      if (!source || !/^[a-f0-9]{64}$/.test(source.sha256) || !source.path) throw new Error('missing hashed source');
      const bytes = readFileSync(resolve(root, source.path));
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) throw new Error('source hash mismatch');
      return JSON.parse(bytes.toString('utf8'));
    }, option => {
      const result = spawnSync('python3', [join(dirname(fileURLToPath(import.meta.url)), 'vm/swap-tier.py'),
        'evaluate-workload', '--out', resolve(root, option.qualification.directory),
        '--qualification', resolve(root, option.qualification.dossier), '--expected-sha', expectedSha,
        '--expected-artifact-sha256', expectedArtifact], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      if (result.error || result.signal || result.status !== 0) return { status: 'unknown' };
      return JSON.parse(result.stdout);
    });
  } catch {
    return { scope: 'P544-composite-economics' as const, qualification: 'independent-review-required' as const,
      comparison: 'unknown' as const, trialCost: 'unknown' as const,
      gaps: ['unreadable-or-invalid-economics-evidence'], selected: [], options: [] };
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && /cost-model\.ts$/.test(process.argv[1])) {
  const evidence = arg('qualification-economics');
  if (evidence !== undefined) {
    const result = readTrialEconomics(evidence, arg('expected-sha') ?? '', arg('expected-artifact-sha256') ?? '');
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.comparison === 'unknown' || result.trialCost === 'unknown' ? 2 : result.trialCost === 'fail' ? 1 : 0);
  }
  const agents = Number(arg('agents') ?? TARGET.agents);
  const savedArg = arg('p532-saved-gib');
  const rows = buildRows(agents, savedArg === undefined ? null : Number(savedArg));
  const reportPath = arg('report-month');
  const month: CostReportMonth = reportPath === undefined ? {} : JSON.parse(readFileSync(reportPath, 'utf8'));
  if (!month || typeof month !== 'object' || Array.isArray(month)) throw new Error('report-month must be an object');
  console.log(process.argv.includes('--json')
    ? JSON.stringify(reportPath === undefined ? rows : { rows, pricing: pricingComparison(rows, month),
      trialCostCoverage: month.trialCostProfiles === undefined ? null : trialMonthlyCostCoverage(month.trialCostProfiles) }, null, 2)
    : renderMarkdown(rows, month));
}
