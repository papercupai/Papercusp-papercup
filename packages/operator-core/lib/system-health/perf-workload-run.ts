/** Executable collection for the existing D-012 perf evidence, never acceptance. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import {
  normalizePerfWorkloadObservation, perfProtocolHash, verifyPerfWorkloadPrerequisites,
  type PerfProtocolEvidence, type PerfWorkloadProtocol, type PerfWorkloadStratum,
} from './perf-workload-protocol';

export type PerfWorkloadArm = 'a' | 'b';
/** Full JSON snapshots, not caller-authored labels for a supposed environment. */
export interface PerfWorkloadManifest {
  source: Record<string, unknown>;
  configuration: Record<string, unknown>;
  runtime: Record<string, unknown>;
  host: Record<string, unknown>;
  workload: Record<string, unknown>;
  fixture: Record<string, unknown>;
}
export interface PerfScheduledRequest {
  id: string;
  /** Relative fixture; method/body and the full response oracle are preregistered. */
  path: string;
  method?: 'GET' | 'POST';
  /** Fixture bytes only. Credentials belong in runtime-only transportHeaders. */
  body?: string;
  contentType?: 'application/json';
  accept?: 'application/json' | 'text/event-stream' | 'application/json, text/event-stream';
  atMs: number;
  timeoutMs: number;
  maximumResponseBytes: number;
  expectedStatus: number;
  expectedBodySha256: string;
  /** Media type without parameters, e.g. text/event-stream. */
  expectedContentType?: string;
}
export interface PerfWorkloadRunPlan {
  independentRepeatId: string;
  phase: 'baseline' | 'candidate';
  origins: Record<PerfWorkloadArm, string>;
  expectedManifestHashes: Record<PerfWorkloadArm, string>;
  groups: Array<{
    journey: string; stratum: PerfWorkloadStratum;
    armOrder: [PerfWorkloadArm, PerfWorkloadArm];
    concurrency: number;
    /** Same fixed observation window for both arms, including terminal responses. */
    exposureMs: number;
    maximumStartLatenessMs: number;
    requests: PerfScheduledRequest[];
  }>;
}
export interface PerfCollectedRequest {
  id: string;
  scheduledAtMs: number;
  startedAtMs: number | null;
  elapsedMs: number | null;
  outcome: 'success' | 'timeout' | 'error' | 'disconnect' | 'not-dispatched';
  censored: boolean;
  responseStatus: number | null;
  responseBytes: number;
  responseSha256: string | null;
  responseContentType?: string | null;
  oracleMatched: boolean;
  diagnostic: string | null;
  /** Cold preparation is per request; warm/burst preparation is per arm. */
  preparation: Record<string, unknown> | null;
}
export interface PerfWorkloadRun {
  schemaVersion: 1;
  plan: PerfWorkloadRunPlan;
  planHash: string;
  startedAtMs: number;
  endedAtMs: number;
  /** Collection integrity only. Even complete data can fail every acceptance bar. */
  status: 'collected' | 'unknown';
  reasons: string[];
  groups: Array<{
    journey: string; stratum: PerfWorkloadStratum;
    arms: Array<{
      arm: PerfWorkloadArm;
      before: PerfWorkloadManifest | null;
      after: PerfWorkloadManifest | null;
      preparation: Record<string, unknown> | null;
      elapsedMs: number;
      requests: PerfCollectedRequest[];
    }>;
  }>;
  hash: string;
}
export interface PerfWorkloadRunDependencies {
  /** Authentication/session headers, frozen at start and NEVER retained in a run. */
  transportHeaders?: Partial<Record<PerfWorkloadArm, Readonly<Record<string, string>>>>;
  /** Must capture actual loaded runtime, config, host, fixtures and source bytes. */
  captureManifest: (arm: PerfWorkloadArm) => Promise<PerfWorkloadManifest>;
  /** Retain reset/warmup evidence. A label alone does not prove a cold/warm state. */
  prepare: (context: { arm: PerfWorkloadArm; journey: string; stratum: PerfWorkloadStratum; requestId: string | null }) => Promise<Record<string, unknown>>;
  candidate?: {
    protocol: PerfWorkloadProtocol;
    registrationRef: string;
    readEvidence: (ref: string) => Promise<PerfProtocolEvidence | null>;
  };
}

function validatePlan(plan: PerfWorkloadRunPlan): void {
  const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
  const finite = (value: number) => Number.isFinite(value) && value >= 0;
  if (!plan.independentRepeatId.trim() || !['baseline', 'candidate'].includes(plan.phase) || !plan.groups.length) throw new Error('invalid workload run plan');
  for (const arm of ['a', 'b'] as const) {
    const origin = new URL(plan.origins[arm]);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin !== plan.origins[arm] ||
        !sha(plan.expectedManifestHashes[arm])) throw new Error('invalid workload origin or manifest pin');
  }
  const groups = new Set<string>();
  for (const group of plan.groups) {
    const identity = JSON.stringify([group.journey, group.stratum]);
    if (!group.journey.trim() || !['cold', 'warm', 'burst'].includes(group.stratum) || groups.has(identity) ||
        group.armOrder.length !== 2 || new Set(group.armOrder).size !== 2 || group.armOrder.some(arm => !['a', 'b'].includes(arm)) ||
        !Number.isSafeInteger(group.concurrency) || group.concurrency < 1 || !finite(group.exposureMs) || group.exposureMs <= 0 ||
        !finite(group.maximumStartLatenessMs) || !group.requests.length || new Set(group.requests.map(row => row.id)).size !== group.requests.length) throw new Error('invalid workload group');
    groups.add(identity);
    for (const request of group.requests) {
      const url = new URL(request.path, plan.origins.a);
      if (!request.id.trim() || !request.path.startsWith('/') || request.path.startsWith('//') || url.origin !== plan.origins.a || url.hash ||
          !['GET', 'POST'].includes(request.method ?? 'GET') ||
          (request.body !== undefined && (request.method !== 'POST' || typeof request.body !== 'string')) ||
          (request.contentType !== undefined && (request.method !== 'POST' || request.contentType !== 'application/json')) ||
          (request.accept !== undefined && !['application/json', 'text/event-stream', 'application/json, text/event-stream'].includes(request.accept)) ||
          (request.expectedContentType !== undefined && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(request.expectedContentType)) ||
          !finite(request.atMs) || !finite(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > 2_147_483_647 ||
          request.atMs + request.timeoutMs > group.exposureMs || !Number.isSafeInteger(request.maximumResponseBytes) || request.maximumResponseBytes < 1 ||
          !Number.isSafeInteger(request.expectedStatus) || request.expectedStatus < 100 || request.expectedStatus > 599 || !sha(request.expectedBodySha256)) throw new Error('invalid workload request');
    }
    // Requests are retained in schedule order. Never silently re-sort pairs.
    if (group.requests.some((request, i) => i > 0 && request.atMs < group.requests[i - 1].atMs)) throw new Error('unordered workload schedule');
  }
}

function validManifest(manifest: PerfWorkloadManifest): boolean {
  return ['source', 'configuration', 'runtime', 'host', 'workload', 'fixture'].every(key => {
    const part = manifest[key as keyof PerfWorkloadManifest];
    return part && !Array.isArray(part) && typeof part === 'object' && Object.keys(part).length > 0;
  });
}

async function executeRequest(origin: string, request: PerfScheduledRequest, startedAtMs: number,
  transportHeaders?: Readonly<Record<string, string>>): Promise<PerfCollectedRequest> {
  const start = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs);
  const row: PerfCollectedRequest = { id: request.id, scheduledAtMs: request.atMs, startedAtMs,
    elapsedMs: null, outcome: 'error', censored: false, responseStatus: null, responseBytes: 0,
    responseSha256: null, oracleMatched: false, diagnostic: null, preparation: null };
  try {
    const headers = new Headers(transportHeaders);
    // Fixture headers take precedence over runtime credentials/session headers.
    if (request.contentType) headers.set('content-type', request.contentType);
    if (request.accept) headers.set('accept', request.accept);
    const response = await fetch(new URL(request.path, origin), { signal: controller.signal, redirect: 'error',
      method: request.method ?? 'GET', body: request.body, headers });
    row.responseStatus = response.status;
    row.responseContentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null;
    const hash = createHash('sha256');
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          row.responseBytes += chunk.value.byteLength;
          if (row.responseBytes > request.maximumResponseBytes) {
            await reader.cancel();
            throw new Error('response-byte-limit');
          }
          hash.update(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    row.responseSha256 = hash.digest('hex');
    row.oracleMatched = response.status === request.expectedStatus && row.responseSha256 === request.expectedBodySha256 &&
      (request.expectedContentType === undefined || request.expectedContentType === row.responseContentType);
    row.outcome = row.oracleMatched ? 'success' : 'error';
    row.diagnostic = row.oracleMatched ? null : 'response-oracle-mismatch';
  } catch (error) {
    row.outcome = timedOut ? 'timeout' : row.responseStatus === null ? 'error' : 'disconnect';
    row.censored = true;
    row.diagnostic = timedOut ? 'request-timeout' : error instanceof Error && error.message === 'response-byte-limit' ? 'response-byte-limit' : 'request-or-response-failed';
  } finally {
    clearTimeout(timeout);
    row.elapsedMs = performance.now() - start;
  }
  return row;
}

/**
 * Execute BOTH arms of an immutable schedule. This does not certify manifest
 * completeness, repeat independence, preparation semantics, power or savings.
 * Candidate collection is refused until the retained preregistration replays.
 */
export async function collectPerfWorkloadRun(plan: PerfWorkloadRunPlan, deps: PerfWorkloadRunDependencies): Promise<PerfWorkloadRun> {
  const pinned = structuredClone(plan);
  const transportHeaders = structuredClone(deps.transportHeaders ?? {});
  validatePlan(pinned);
  const startedAtMs = Date.now();
  if (pinned.phase === 'candidate') {
    if (!deps.candidate) throw new Error('candidate requires retained preregistration');
    const prerequisites = await verifyPerfWorkloadPrerequisites(deps.candidate.protocol, deps.candidate.registrationRef, startedAtMs, deps.candidate.readEvidence);
    if (prerequisites.status !== 'ready-for-trial') throw new Error(`candidate prerequisites unknown: ${prerequisites.reasons.join(',')}`);
    const workloads = deps.candidate.protocol.input.workload;
    for (const group of pinned.groups) {
      const workload = workloads.find(row => row.journey === group.journey);
      if (!workload || workload.concurrency !== group.concurrency || group.requests.some(row => row.timeoutMs !== workload.timeoutMs)) throw new Error('candidate workload differs from preregistration');
    }
    // The complete executable schedule must be one of the registered fixture bytes.
    if (perfProtocolHash({ groups: pinned.groups }) !== deps.candidate.protocol.input.fixtureHash) throw new Error('candidate schedule differs from preregistration');
  }
  const reasons = new Set<string>();
  const groups: PerfWorkloadRun['groups'] = [];
  const capture = async (arm: PerfWorkloadArm) => {
    try {
      const manifest = structuredClone(await deps.captureManifest(arm));
      if (!validManifest(manifest) || perfProtocolHash(manifest) !== pinned.expectedManifestHashes[arm]) reasons.add(`manifest-mismatch:${arm}`);
      return manifest;
    } catch { reasons.add(`manifest-unavailable:${arm}`); return null; }
  };
  const prepare = async (arm: PerfWorkloadArm, group: PerfWorkloadRunPlan['groups'][number], requestId: string | null) => {
    try {
      const receipt = structuredClone(await deps.prepare({ arm, journey: group.journey, stratum: group.stratum, requestId }));
      if (!receipt || !Object.keys(receipt).length) throw new Error('empty preparation');
      perfProtocolHash(receipt);
      return receipt;
    } catch { reasons.add(`preparation-unavailable:${group.journey}:${group.stratum}:${arm}`); return null; }
  };
  for (const group of pinned.groups) {
    const retained: PerfWorkloadRun['groups'][number] = { journey: group.journey, stratum: group.stratum, arms: [] };
    groups.push(retained);
    for (const arm of group.armOrder) {
      const preparation = group.stratum === 'cold' ? null : await prepare(arm, group, null);
      const before = await capture(arm);
      const start = performance.now();
      let active = 0;
      const requests = await Promise.all(group.requests.map(async request => {
        // Node rounds fractional timer delays down. Re-check the monotonic
        // deadline so a positive scheduled offset can never dispatch early.
        while (performance.now() - start < request.atMs) {
          await delay(Math.max(1, request.atMs - (performance.now() - start)));
        }
        const cold = group.stratum === 'cold' ? await prepare(arm, group, request.id) : null;
        const actualStart = performance.now() - start;
        if (actualStart - request.atMs > group.maximumStartLatenessMs) reasons.add(`late-dispatch:${group.journey}:${group.stratum}:${arm}`);
        if (!before || !validManifest(before) || perfProtocolHash(before) !== pinned.expectedManifestHashes[arm] ||
            !(group.stratum === 'cold' ? cold : preparation) || active >= group.concurrency || actualStart >= group.exposureMs) {
          reasons.add(`not-dispatched:${group.journey}:${group.stratum}:${arm}`);
          return { id: request.id, scheduledAtMs: request.atMs, startedAtMs: null, elapsedMs: null, outcome: 'not-dispatched' as const,
            censored: true, responseStatus: null, responseBytes: 0, responseSha256: null, oracleMatched: false,
            diagnostic: 'precondition-or-concurrency-or-exposure', preparation: cold };
        }
        active++;
        try {
          const row = await executeRequest(pinned.origins[arm], request, actualStart, transportHeaders[arm]);
          row.preparation = cold;
          if (actualStart + row.elapsedMs! > group.exposureMs) reasons.add(`response-outside-exposure:${group.journey}:${group.stratum}:${arm}`);
          return row;
        } finally { active--; }
      }));
      const remaining = group.exposureMs - (performance.now() - start);
      if (remaining > 0) await delay(remaining);
      const elapsedMs = performance.now() - start;
      if (elapsedMs - group.exposureMs > group.maximumStartLatenessMs) reasons.add(`exposure-clock-overrun:${group.journey}:${group.stratum}:${arm}`);
      const after = await capture(arm);
      retained.arms.push({ arm, before, after, preparation, elapsedMs, requests });
    }
  }
  const body = { schemaVersion: 1 as const, plan: pinned, planHash: perfProtocolHash(pinned), startedAtMs, endedAtMs: Date.now(),
    status: reasons.size ? 'unknown' as const : 'collected' as const, reasons: [...reasons].sort(), groups };
  return { ...body, hash: perfProtocolHash(body) };
}

/** Integrity only: unknown runs are retained too. This does not validate acceptance. */
export function intactPerfWorkloadRun(value: unknown): value is PerfWorkloadRun {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const run = value as PerfWorkloadRun;
    const { hash, ...body } = run;
    return run.schemaVersion === 1 && ['collected', 'unknown'].includes(run.status) && Array.isArray(run.groups) &&
      Array.isArray(run.reasons) && Number.isFinite(run.startedAtMs) && Number.isFinite(run.endedAtMs) &&
      run.endedAtMs >= run.startedAtMs && perfProtocolHash(body) === hash && run.planHash === perfProtocolHash(run.plan);
  } catch { return false; }
}

/** Paired input to the existing exact bootstrap. All failures remain in both metrics. */
export function perfWorkloadRunSeries(run: PerfWorkloadRun) {
  try {
  if (!intactPerfWorkloadRun(run) || run.status !== 'collected' || run.reasons.length) return null;
  validatePlan(run.plan);
  if (run.groups.length !== run.plan.groups.length || new Set(run.groups.map(group => JSON.stringify([group.journey, group.stratum]))).size !== run.groups.length) return null;
  return run.groups.map(group => {
    const plan = run.plan.groups.find(row => row.journey === group.journey && row.stratum === group.stratum)!;
    if (!plan || group.arms.length !== 2 || new Set(group.arms.map(row => row.arm)).size !== 2) throw new Error('incomplete arms');
    const arm = (name: PerfWorkloadArm) => {
      const capture = group.arms.find(row => row.arm === name)!;
      if (!capture || !capture.before || !capture.after || !validManifest(capture.before) || !validManifest(capture.after) ||
          perfProtocolHash(capture.before) !== run.plan.expectedManifestHashes[name] || perfProtocolHash(capture.after) !== run.plan.expectedManifestHashes[name]) throw new Error('unmatched manifests');
      const rows = capture.requests;
      if (rows.length !== plan.requests.length || rows.some((row, i) => row.id !== plan.requests[i].id || row.scheduledAtMs !== plan.requests[i].atMs ||
          row.outcome === 'not-dispatched' || row.startedAtMs === null || !Number.isFinite(row.startedAtMs) ||
          row.startedAtMs < row.scheduledAtMs || row.startedAtMs - row.scheduledAtMs > plan.maximumStartLatenessMs ||
          row.elapsedMs === null || row.startedAtMs + row.elapsedMs > plan.exposureMs)) throw new Error('incomplete paired workload');
      const normalized = rows.map((row, i) => normalizePerfWorkloadObservation({
        outcome: row.outcome as 'success' | 'timeout' | 'error' | 'disconnect', elapsedMs: row.elapsedMs,
        timeoutMs: plan.requests[i].timeoutMs, censored: row.censored,
      }));
      if (normalized.some(row => row.status !== 'measured')) throw new Error('invalid paired workload observation');
      return { latencyMs: normalized.map(row => row.status === 'measured' ? row.latencyMs : 0),
        // Equal fixed exposure, same scheduled count: mean(contributions) equals
        // successful completions / exposure seconds. Failed requests contribute 0.
        throughput: rows.map(row => row.outcome === 'success' ? rows.length * 1000 / plan.exposureMs : 0),
        failures: rows.filter(row => row.outcome !== 'success').length };
    };
    return { journey: group.journey, stratum: group.stratum, a: arm('a'), b: arm('b') };
  });
  } catch { return null; }
}
