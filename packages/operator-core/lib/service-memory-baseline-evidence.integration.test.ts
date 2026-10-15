/** Independent raw-row acceptance for a bounded P-011 current-build baseline.
 * No sampler import, inventory total, reduction headline or owner label is an oracle.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { serializeIdentitySafeJson } from '../../../scripts/lib/identity-leak-patterns.mjs';

const root = resolve(__dirname, '../../..');
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const check = (value: unknown, reason: string) => { if (!value) throw Error('P011 baseline: ' + reason); };
const positive = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
const nonnegative = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const sha = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const time = (x: string | number) => typeof x === 'number' ? x : Date.parse(x);
const identity = (x: any) => [x.pid, x.startTicks, x.executableSha256].join(':');

// Reconstruct the selected-worker proof from persisted rows, independently of
// the collector. A terminal diagnostic ring is deliberately not a query census.
function auditRequestWorkerWindows(r: any) {
  const requireWorker = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 worker windows: ' + reason);
  };
  const pid = (x: unknown) => Number.isSafeInteger(x) && (x as number) > 0;
  const uuid = (x: unknown) => typeof x === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
  const selected: number[] = r.counterPids;
  requireWorker(Array.isArray(selected) && selected.length > 0 && selected.length <= 8 &&
    selected.every(pid) && new Set(selected).size === selected.length && selected[0] === r.counterPid,
    'bounded distinct selection');
  requireWorker(Array.isArray(r.requestWorkerWindows) && r.requestWorkerWindows.length === r.windows.length &&
    r.requestWorkerWindows.length > 0 && r.requestWorkerWindows.length <= 3 &&
    r.requestWorkerAssignments?.length === r.requestWorkerWindows.length &&
    r.requestWorkerWindows.every((w: any, i: number) => w.window === r.windows[i].window),
    'exact window population');
  const bundles = new Map<number, any>((r.targetBundles ?? []).map((x: any) => [x.pid, x]));
  const inspectors = new Map<number, any>((r.inspectors ?? []).map((x: any) => [x.pid, x]));
  const cleanup = new Map<number, any>((r.cleanup?.inspectors ?? []).map((x: any) => [x.pid, x]));
  requireWorker([bundles, inspectors, cleanup].every(m => m.size === selected.length &&
    selected.every(id => m.has(id))) && r.targetBundles.length === selected.length &&
    r.inspectors.length === selected.length && r.cleanup.inspectors.length === selected.length,
    'complete per-target artifact and inspector coverage');
  for (const id of selected) {
    const b = bundles.get(id), i = inspectors.get(id), c = cleanup.get(id);
    requireWorker(sha(b.diskSha256) && b.diskSha256After === b.diskSha256 &&
      typeof i.openedByProbe === 'boolean' && c.openedByProbe === i.openedByProbe && !c.error &&
      (i.openedByProbe ? c.result?.closed === true : c.result?.preservedPreexisting === true),
      'per-target artifact and cleanup fence');
  }
  const roleFromRaw = (facts: any) => {
    requireWorker(typeof facts?.cluster?.isPrimary === 'boolean' &&
      typeof facts.cluster.isWorker === 'boolean' && facts.cluster.isPrimary !== facts.cluster.isWorker &&
      ['unset', 'enabled', 'disabled'].includes(facts.backgroundWorkersOverride) &&
      typeof facts.stagingPort === 'boolean' &&
      ['substrate', 'spawner', 'gateway', 'embed', 'resourceHealth'].every(k =>
        facts.sidecarFlags?.[k] === false), 'raw request-only host facts');
    const requestOnly = facts.backgroundWorkersOverride === 'disabled' ||
      (facts.backgroundWorkersOverride === 'unset' && facts.stagingPort);
    requireWorker(requestOnly, 'raw request-only configuration');
    return { clusterRole: facts.cluster.isWorker ? 'worker' : 'primary', requestOnly: true,
      configuredSidecar: null, requestAssignment: 'unknown', allocationOwner: 'unknown' };
  };
  const pin = (row: any) => [identity(row), row.parentPid, row.command?.sha256, row.command?.script];
  const rawOs = (row: any) => row && pid(row.pid) && /^\d+$/.test(row.startTicks) &&
    sha(row.executableSha256) && sha(row.command?.sha256) &&
    (row.command.script === null || typeof row.command.script === 'string') &&
    Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 &&
    positive(row.pssBytes) && positive(row.rssBytes) && row.pssBytes <= row.rssBytes &&
    nonnegative(row.anonymousBytes);
  const hasCensus = r.requestWorkerWindows.some((w: any) =>
    w.before?.census !== undefined || w.after?.census !== undefined);
  const ancestryPins = new Map<number, any>();
  const lifetimes = new Map<number, any>();
  const loadedIdentities = new Map<number, any>();
  const previousCounters = new Map<number, number>();
  const previousRingTotals = new Map<string, number>();
  let lastEnd = time(r.startedAt);
  return r.requestWorkerWindows.map((w: any, index: number) => {
    const outer = r.windows[index], requests = r.requests.filter((q: any) => q.window === w.window);
    const census = r.samples[index * 3 + 1];
    const censusRows = new Map<number, any>([census.os, ...census.descendants].map((x: any) => [x.pid, x]));
    const requestIds = requests.map((q: any) => q.requestId);
    requireWorker(requests.length === r.limits.requestsPerWindow && requests.every((q: any) => q.status === 200) &&
      requestIds.every((id: unknown) => id === null || uuid(id)) &&
      new Set(requestIds.filter(uuid)).size === requestIds.filter(uuid).length, 'exact server HTTP identities');
    requireWorker(positive(w.before?.startedAt) && w.before.startedAt >= time(outer.startedAt) &&
      w.before.startedAt >= lastEnd && w.before.endedAt >= w.before.startedAt &&
      w.after?.startedAt >= w.before.endedAt && w.after.endedAt >= w.after.startedAt &&
      w.after.endedAt <= time(outer.endedAt), 'ordered unforced window brackets');
    lastEnd = w.after.endedAt;
    const during: any[] = w.during ?? [];
    requireWorker(Array.isArray(during) && during.length <= 32, 'bounded response checkpoints');
    let priorCheckpoint = w.before.endedAt, priorRequestIds: string[] = [];
    for (const point of during) {
      requireWorker(positive(point.startedAt) && point.startedAt >= priorCheckpoint &&
        point.endedAt >= point.startedAt && point.endedAt <= w.after.startedAt &&
        Array.isArray(point.requestIds) && point.requestIds.length > priorRequestIds.length &&
        point.requestIds.length <= 32 && point.requestIds.every((id: string) => uuid(id) && requestIds.includes(id)) &&
        new Set(point.requestIds).size === point.requestIds.length &&
        priorRequestIds.every(id => point.requestIds.includes(id)), 'ordered checkpoint HTTP population');
      priorCheckpoint = point.endedAt; priorRequestIds = point.requestIds;
    }
    if (during.length) requireWorker(isDeepStrictEqual([...priorRequestIds].sort(),
      requestIds.filter(uuid).sort()), 'complete final checkpoint HTTP population');
    const gaps: any[] = [];
    const ancestry: any[] = [];
    const ringSamples: any[] = [];
    const points = [{ phase: 'before', sample: w.before }, ...during.map((sample, i) =>
      ({ phase: 'during-' + i, sample })), { phase: 'after', sample: w.after }];
    for (const { phase, sample } of points) {
      const coverage = sample.coverage;
      requireWorker(Array.isArray(sample.observations) && sample.observations.length === selected.length &&
        isDeepStrictEqual(sample.observations.map((x: any) => x.after?.pid), selected), 'selected observation population');
      requireWorker(isDeepStrictEqual(coverage?.selectedPids, selected) &&
        Array.isArray(coverage.unsampledPids) && coverage.unsampledPids.every((id: unknown) => pid(id) &&
          !selected.includes(id as number)) && new Set(coverage.unsampledPids).size === coverage.unsampledPids.length,
        'explicit unsampled coverage');
      for (const name of ['notCheckedBefore', 'notCheckedAfter']) {
        requireWorker(Array.isArray(coverage[name]) && coverage[name].every((x: any) => pid(x.pid) &&
          Number.isSafeInteger(x.parentPid) && x.parentPid >= 0 && typeof x.reason === 'string' && x.reason.length > 0),
          'explicit census residue');
      }
      gaps.push({ phase, unsampledPids: coverage.unsampledPids,
        notCheckedBefore: coverage.notCheckedBefore, notCheckedAfter: coverage.notCheckedAfter });
      const brackets = new Map<string, Map<number, any>>();
      if (hasCensus) {
        for (const bracket of ['before', 'after']) {
          const raw = sample.census?.[bracket];
          requireWorker(raw && Array.isArray(raw.descendants) && raw.descendants.length <= 64 &&
            Array.isArray(raw.notChecked), 'complete bounded raw census brackets');
          const rows = [raw.main, ...raw.descendants];
          requireWorker(rows.every(rawOs) && new Set(rows.map((x: any) => x.pid)).size === rows.length &&
            raw.main.pid === r.pid && isDeepStrictEqual(pin(raw.main), pin(census.os)),
            'raw census lifetime population');
          const byPid = new Map<number, any>(rows.map((x: any) => [x.pid, x]));
          for (const row of raw.descendants) {
            const seen = new Set<number>(); let ancestor = row;
            while (ancestor.pid !== r.pid) {
              requireWorker(!seen.has(ancestor.pid) && byPid.has(ancestor.parentPid), 'raw census ancestry');
              seen.add(ancestor.pid); ancestor = byPid.get(ancestor.parentPid);
            }
          }
          requireWorker(isDeepStrictEqual(raw.notChecked, coverage[bracket === 'before' ?
            'notCheckedBefore' : 'notCheckedAfter']), 'raw census residue conservation');
          if (bracket === 'after') requireWorker(isDeepStrictEqual(
            rows.filter((x: any) => !selected.includes(x.pid)).map((x: any) => x.pid),
            coverage.unsampledPids), 'raw unsampled population conservation');
          brackets.set(bracket, byPid);
        }
      }
      const instances = new Set<string>();
      for (const observation of sample.observations) {
        const id = observation.after.pid, bundle = bundles.get(id);
        if (hasCensus) for (const bracket of ['before', 'after']) {
          const byPid = brackets.get(bracket)!;
          requireWorker(byPid.has(id) && isDeepStrictEqual(observation[bracket], byPid.get(id)),
            'exact selected raw bracket correspondence');
          const chain = []; let ancestor = byPid.get(id);
          while (true) {
            const saved = pin(ancestor);
            requireWorker(!ancestryPins.has(ancestor.pid) ||
              isDeepStrictEqual(saved, ancestryPins.get(ancestor.pid)), 'stable selected ancestor lifetime/entry');
            ancestryPins.set(ancestor.pid, saved);
            chain.push({ pid: ancestor.pid, startTicks: ancestor.startTicks,
              executableSha256: ancestor.executableSha256, parentPid: ancestor.parentPid,
              command: { sha256: ancestor.command.sha256, script: ancestor.command.script } });
            if (ancestor.pid === r.pid) break;
            ancestor = byPid.get(ancestor.parentPid);
          }
          ancestry.push({ phase, bracket, pid: id, chain });
        }
        for (const os of [observation.before, observation.after]) {
          requireWorker(pid(os.pid) && /^\d+$/.test(os.startTicks) && sha(os.executableSha256) &&
            sha(os.command?.sha256) && os.command.script === r.bundle.argvEntry &&
            positive(os.pssBytes) && positive(os.rssBytes) && os.pssBytes <= os.rssBytes &&
            nonnegative(os.anonymousBytes) && Number.isSafeInteger(os.parentPid) && os.parentPid >= 0,
            'raw OS lifetime and PSS');
          requireWorker(os.startTicks === bundle.startTicks && os.executableSha256 === bundle.executableSha256 &&
            os.command.script === bundle.path && isDeepStrictEqual(pin(os), pin(observation.before)) &&
            (!lifetimes.has(id) || isDeepStrictEqual(pin(os), lifetimes.get(id))), 'stable selected lifetime/entry');
          requireWorker(censusRows.has(id) && isDeepStrictEqual(pin(os), pin(censusRows.get(id))) &&
            os.executableSha256 === census.os.executableSha256, 'selected census correspondence');
          const seen = new Set<number>(); let ancestor = os;
          while (ancestor.pid !== r.pid) {
            requireWorker(!seen.has(ancestor.pid) && censusRows.has(ancestor.parentPid), 'selected ancestry');
            seen.add(ancestor.pid); ancestor = censusRows.get(ancestor.parentPid);
          }
        }
        lifetimes.set(id, pin(observation.after));
        const counters = observation.counters, snapshot = observation.snapshot;
        requireWorker(counters?.pid === id && nonnegative(counters.heap?.total_allocated_bytes) &&
          counters.heap.total_allocated_bytes >= (previousCounters.get(id) ?? 0) &&
          positive(counters.memory?.heapUsed) && positive(counters.memory.heapTotal) &&
          counters.memory.heapUsed <= counters.memory.heapTotal &&
          nonnegative(counters.memory.external) && nonnegative(counters.memory.arrayBuffers) &&
          counters.memory.arrayBuffers <= counters.memory.external, 'PID-bound cumulative allocation');
        previousCounters.set(id, counters.heap.total_allocated_bytes);
        requireWorker(isDeepStrictEqual(roleFromRaw(counters.hostFacts), observation.role), 'raw role correspondence');
        requireWorker(snapshot?.status === 'observed' && snapshot.pid === id && snapshot.buildSha === r.buildSha &&
          uuid(snapshot.processInstanceId) && !instances.has(snapshot.processInstanceId) &&
          Array.isArray(snapshot.results) && snapshot.results.length <= 64, 'loaded process/build identity');
        instances.add(snapshot.processInstanceId);
        if (snapshot.pools !== undefined) {
          requireWorker(Array.isArray(snapshot.pools) && snapshot.pools.length <= 64 &&
            new Set(snapshot.pools.map((p: any) => p.pool)).size === snapshot.pools.length,
            'bounded diagnostic ring population');
          for (const pool of snapshot.pools) {
            const key = JSON.stringify([id, snapshot.processInstanceId, pool.pool]);
            requireWorker(typeof pool.pool === 'string' && pool.pool.length > 0 && pool.capacity === 32 &&
              [pool.retained, pool.totalRecorded, pool.dropped].every((n: unknown) =>
                Number.isSafeInteger(n) && (n as number) >= 0) &&
              pool.retained === Math.min(pool.totalRecorded, pool.capacity) &&
              pool.dropped === pool.totalRecorded - pool.retained &&
              pool.totalRecorded >= (previousRingTotals.get(key) ?? 0), 'diagnostic ring accounting');
            previousRingTotals.set(key, pool.totalRecorded);
            ringSamples.push({ phase, pid: id, ...pool });
          }
          requireWorker(snapshot.results.every((q: any) => snapshot.pools.some((p: any) => p.pool === q.pool)),
            'selected queries belong to observed rings');
        }
        const loaded = { processInstanceId: snapshot.processInstanceId, role: observation.role };
        requireWorker(!loadedIdentities.has(id) || isDeepStrictEqual(loadedIdentities.get(id), loaded),
          'cross-window loaded process and role fence');
        loadedIdentities.set(id, loaded);
        if (phase === 'before') requireWorker(snapshot.results.length === 0, 'empty pre-request selection');
      }
    }
    requireWorker(Array.isArray(w.resources) && w.resources.length === selected.length &&
      isDeepStrictEqual(w.resources.map((x: any) => x.pid), selected), 'resource population');
    const assignments = new Map<string, any>(), tuples = new Map<string, any>();
    const resources = w.after.observations.map((after: any, i: number) => {
      const before = w.before.observations[i], raw = w.resources[i];
      requireWorker(before.snapshot.processInstanceId === after.snapshot.processInstanceId &&
        isDeepStrictEqual(before.role, after.role), 'stable process instance and role');
      const derived = { pid: after.after.pid, startTicks: after.after.startTicks,
        executableSha256: after.after.executableSha256, processInstanceId: after.snapshot.processInstanceId,
        buildSha: r.buildSha, role: after.role, pssBytesBefore: before.after.pssBytes,
        pssBytesAfter: after.after.pssBytes, pssChangeBytes: after.after.pssBytes - before.after.pssBytes,
        allocatedBytes: after.counters.heap.total_allocated_bytes - before.counters.heap.total_allocated_bytes,
        countersBefore: before.counters, countersAfter: after.counters };
      requireWorker(isDeepStrictEqual(raw, derived) && nonnegative(derived.allocatedBytes), 'raw resource delta correspondence');
      return derived;
    });
    for (const point of [...during, w.after]) for (const after of point.observations) {
      const pointTuples = new Set<string>();
      for (const q of after.snapshot.results) {
        requireWorker(requestIds.includes(q.correlation?.requestId) && uuid(q.correlation.requestId) &&
          (!point.requestIds || point.requestIds.includes(q.correlation.requestId)) &&
          q.correlation.operation === 'workItems.byHarness' && q.status === 'ok' &&
          q.source?.processInstanceId === after.snapshot.processInstanceId &&
          q.correlation.processInstanceId === after.snapshot.processInstanceId &&
          q.source.buildSha === r.buildSha && q.correlation.buildSha === r.buildSha && uuid(q.source.poolInstanceId) &&
          typeof q.pool === 'string' && q.pool.length > 0 && Number.isSafeInteger(q.connectionId) &&
          q.connectionId >= 0 && Number.isSafeInteger(q.queryId) && q.queryId >= 0, 'exact query identity');
        const tuple = JSON.stringify([q.correlation.requestId, q.pool, q.source.processInstanceId,
          q.source.buildSha, q.source.poolInstanceId, q.connectionId, q.queryId]);
        requireWorker(!pointTuples.has(tuple), 'duplicate query tuple'); pointTuples.add(tuple);
        if (tuples.has(tuple)) {
          requireWorker(isDeepStrictEqual(tuples.get(tuple), q), 'checkpoint query tuple changed');
          continue;
        }
        tuples.set(tuple, q);
        const prior = assignments.get(q.correlation.requestId);
        requireWorker(!prior || prior.pid === after.after.pid, 'cross-worker HTTP assignment');
        const value = prior ?? { requestId: q.correlation.requestId, pid: after.after.pid,
          startTicks: after.after.startTicks, processInstanceId: after.snapshot.processInstanceId, queryTuples: [] };
        value.queryTuples.push(tuple); assignments.set(q.correlation.requestId, value);
      }
    }
    const missingHttp = requestIds.some((id: unknown) => id === null);
    const unresolvedRequestIds = missingHttp ? requestIds : requestIds.filter((id: string) => !assignments.has(id));
    const assignment = { status: missingHttp ? 'unknown' : unresolvedRequestIds.length ? 'partial' : 'observed',
      requested: requestIds.length,
      assignments: missingHttp ? [] : requestIds.flatMap((id: string) => assignments.has(id) ? [assignments.get(id)] : []),
      unresolvedRequestIds };
    const projectedAssignment = (a: any) => ({ status: a?.status, requested: a?.requested,
      assignments: a?.assignments, unresolvedRequestIds: a?.unresolvedRequestIds });
    requireWorker(isDeepStrictEqual(projectedAssignment(w.assignment), assignment) &&
      isDeepStrictEqual(projectedAssignment(r.requestWorkerAssignments?.[index]), assignment) &&
      r.requestWorkerAssignments[index].window === w.window, 'conserved one-to-many request tuples');
    return { window: w.window, resources, assignment, coverage: gaps,
      selectedAncestry: hasCensus ? { status: 'observed', brackets: ancestry,
        definition: 'Exact selected ancestor lifetime pins across serial bounded census brackets; no atomic or complete service census' } :
        { status: 'unknown', reason: 'Historical raw window has no saved ancestry census brackets' },
      servingWorkerPopulation: 'unknown', queryPopulation: 'bounded observed rings; unseen queries remain unknown',
      queryObservation: during.length ? 'response checkpoints and terminal ring' : 'historical terminal ring only',
      diagnosticRings: ringSamples.length ? { status: 'observed', samples: ringSamples,
        definition: 'Per-pool all-query FIFO counters; they do not identify an unseen request or prove its eviction' } :
        { status: 'unknown', reason: 'Historical raw snapshots omit ring counters' },
      unsampledAncestorLifetimes: 'unknown', allocationOwner: 'unknown', physicalSavings: 'unmeasured' };
  });
}

function auditBaseline(r: any) {
  check(r.schemaVersion === 1 && r.plane === 'live-current-build-operator-api' &&
    r.incomplete === false && !r.error, 'complete current-build run');
  check(Number.isInteger(r.pid) && r.pid > 0 && Number.isInteger(r.counterPid) && r.counterPid > 0,
    'target PIDs');
  check(/^[a-f0-9]{7,40}$/.test(r.buildSha) && r.healthBefore.sha === r.buildSha &&
    r.healthAfter.sha === r.buildSha, 'loaded health build');
  check(sha(r.bundle.diskSha256) && r.bundle.diskSha256After === r.bundle.diskSha256 &&
    sha(r.counterBundle.diskSha256) && r.counterBundle.diskSha256After === r.counterBundle.diskSha256,
    'disk artifact fence');
  check(r.bundle.argvEntry.endsWith('/hono-host.mjs') && r.bundle.path === r.bundle.argvEntry,
    'main exact entry');
  const sibling = r.counterPid !== r.pid;
  const spawner = sibling && r.counterBundle.argvEntry === join(dirname(r.bundle.argvEntry), 'spawner-sidecar.mjs');
  const entry = spawner ? join(dirname(r.bundle.argvEntry), 'spawner-sidecar.mjs') : r.bundle.argvEntry;
  check(r.counterBundle.argvEntry === entry && r.counterBundle.path === entry, 'counter exact entry');
  check(!sibling || spawner || Array.isArray(r.requestWorkerWindows), 'request-worker evidence required');
  check(r.counterPids === undefined || spawner || Array.isArray(r.requestWorkerWindows), 'selected worker windows required');
  if (spawner) {
    const a = r.counterBundle.loadedBuild, b = r.counterBundle.loadedBuildAfter;
    check(a?.status === 'known' && b?.status === 'known' && a.pid === r.counterPid && b.pid === r.counterPid &&
      typeof a.buildInfo?.sha === 'string' && /^[a-f0-9]{7,40}$/.test(a.buildInfo.sha) &&
      JSON.stringify(a.buildInfo) === JSON.stringify(b.buildInfo) &&
      typeof a.serverGeneration === 'string' && a.serverGeneration.length > 0 &&
      a.serverGeneration === b.serverGeneration && typeof a.connectionId === 'string' &&
      a.connectionId.length > 0 && a.connectionId === b.connectionId, 'loaded sibling socket fence');
    check(nonnegative(r.counterBundle.socketBefore?.dev) && positive(r.counterBundle.socketBefore?.ino) &&
      JSON.stringify(r.counterBundle.socketBefore) === JSON.stringify(r.counterBundle.socketAfter), 'socket inode fence');
  }
  check(r.limits.windows === 3 && r.limits.idleMs === 2000 && r.limits.requestsPerWindow === 8 &&
    r.limits.concurrency === 2 && r.limits.descendantsPerSample === 64, 'fixed workload bounds');
  const phases = Array.from({ length: 3 }, (_, w) =>
    ['idle-' + w + '-start', 'idle-' + w + '-end', 'ordinary-' + w + '-end']).flat();
  check(r.samples.length === 9 && r.samples.map((s: any) => s.label).join(',') === phases.join(','), 'sample population');
  check(r.requests.length === 24 && r.windows.length === 3, 'request/window population');
  check(r.operations.length === 0 && r.cleanup.processIdentityPreserved === true &&
    r.cleanup.counterIdentityPreserved === true && !r.cleanup.error &&
    (r.inspector.openedByProbe ? r.cleanup.inspector.closed === true :
      r.cleanup.inspector.preservedPreexisting === true), 'unforced cleanup');
  let priorAt = time(r.startedAt), priorAllocation = 0;
  const mainIdentity = identity(r.samples[0].os), counterIdentity = identity(r.samples[0].counterOs);
  const data: any[] = [];
  for (const s of r.samples) {
    check(positive(time(s.at)) && time(s.at) > priorAt, 'sample ordering');
    priorAt = time(s.at);
    check(s.os.pid === r.pid && s.counterOs.pid === r.counterPid && s.pid === r.counterPid &&
      identity(s.os) === mainIdentity && identity(s.counterOs) === counterIdentity, 'stable sample identity');
    const rows = [s.os, ...s.descendants];
    check(s.descendants.length <= 64 && new Set(rows.map((x: any) => x.pid)).size === rows.length,
      'bounded unique census');
    const byPid = new Map<number, any>(rows.map((x: any) => [x.pid, x]));
    for (const row of rows) {
      check(Number.isInteger(row.pid) && row.pid > 0 && /^\d+$/.test(row.startTicks) &&
        sha(row.executableSha256) && positive(row.pssBytes) && positive(row.rssBytes) &&
        row.pssBytes <= row.rssBytes && nonnegative(row.anonymousBytes) &&
        sha(row.command.sha256), 'raw process measurement');
      if (row.pid === r.pid) continue;
      const seen = new Set([row.pid]); let parent = row.parentPid;
      while (parent !== r.pid) {
        check(!seen.has(parent) && byPid.has(parent), 'descendant ancestry');
        seen.add(parent); parent = byPid.get(parent).parentPid;
      }
    }
    check(s.os.command.script === r.bundle.argvEntry && s.counterOs.command.script === entry &&
      byPid.has(r.counterPid) && identity(byPid.get(r.counterPid)) === counterIdentity &&
      byPid.get(r.counterPid).pssBytes === s.counterOs.pssBytes &&
      s.counterOs.executableSha256 === s.os.executableSha256, 'counter raw-row correspondence');
    check(positive(s.memory.heapUsed) && positive(s.memory.heapTotal) && s.memory.heapUsed <= s.memory.heapTotal &&
      nonnegative(s.memory.external) && nonnegative(s.memory.arrayBuffers) &&
      s.memory.arrayBuffers <= s.memory.external && positive(s.heap.total_allocated_bytes) &&
      s.heap.total_allocated_bytes >= priorAllocation, 'V8 allocation measurement');
    priorAllocation = s.heap.total_allocated_bytes;
    check(s.heapSpaces.length > 0 && s.heapSpaces.every((x: any) => typeof x.space_name === 'string' &&
      nonnegative(x.space_used_size)) && nonnegative(s.heapCode.code_and_metadata_size), 'V8 component measurement');
    const f = s.hostFacts;
    check((r.requestWorkerWindows ? typeof f.cluster.isPrimary === 'boolean' &&
      typeof f.cluster.isWorker === 'boolean' && f.cluster.isPrimary !== f.cluster.isWorker :
      f.cluster.isPrimary === true && f.cluster.isWorker === false) &&
      (r.requestWorkerWindows ? f.backgroundWorkersOverride === 'disabled' ||
        (f.backgroundWorkersOverride === 'unset' && f.stagingPort === true) :
        f.backgroundWorkersOverride === 'disabled') && f.sidecarFlags.spawner === spawner &&
      ['substrate', 'gateway', 'embed', 'resourceHealth'].every(key => f.sidecarFlags[key] === false), 'raw runtime role');
    data.push({ label: s.label, pssBytes: s.counterOs.pssBytes, allocatedBytes: s.heap.total_allocated_bytes,
      observedPssBytes: rows.reduce((sum, x) => sum + x.pssBytes, 0),
      checkedProcesses: rows.length, notChecked: s.inventory.notChecked });
  }
  check(time(r.endedAt) >= priorAt, 'end fence');
  for (let w = 0; w < 3; w++) {
    const [a, b, c] = r.samples.slice(w * 3, w * 3 + 3), window = r.windows[w];
    check(window.window === w && time(b.at) - time(a.at) >= 2000 &&
      time(window.startedAt) >= time(b.at) && time(window.endedAt) >= time(c.at), 'idle/ordinary window timing');
    const requests = r.requests.filter((q: any) => q.window === w);
    check(requests.length === 8 && new Set(requests.map((q: any) => q.pair + ':' + q.index)).size === 8 &&
      requests.every((q: any) => Number.isInteger(q.pair) && q.pair >= 0 && q.pair < 4 &&
        (q.index === 0 || q.index === 1) && q.status === 200 && Number.isInteger(q.rows) &&
        q.rows >= 0 && q.rows <= 32 && positive(q.responseBytes) && sha(q.responseSha256) &&
        nonnegative(q.elapsedMs)), 'ordinary request coverage');
  }
  const requestWorkerWindows = r.requestWorkerWindows === undefined ? undefined : auditRequestWorkerWindows(r);
  return { target: spawner ? 'maintained-spawner' : sibling ? 'selected-request-worker' : 'main', mainIdentity, counterIdentity, buildSha: r.buildSha,
    samples: data, windows: Array.from({ length: 3 }, (_, w) => ({ window: w,
      idlePssDeltaBytes: data[w * 3 + 1].pssBytes - data[w * 3].pssBytes,
      ordinaryPssDeltaBytes: data[w * 3 + 2].pssBytes - data[w * 3 + 1].pssBytes,
      idleAllocatedBytes: data[w * 3 + 1].allocatedBytes - data[w * 3].allocatedBytes,
      ordinaryAllocatedBytes: data[w * 3 + 2].allocatedBytes - data[w * 3 + 1].allocatedBytes })),
    ...(requestWorkerWindows ? { requestWorkerWindows } : {}),
    allocationOwner: 'unknown', requestAssignment: requestWorkerWindows ? 'bounded selected-worker observations' : 'unknown', physicalSavings: 'unmeasured',
    definition: 'Serial bounded raw PSS and cumulative V8 allocation observations; ambient workload uncontrolled.' };
}

// Inspect raw expiry phases independently of the cache sampler and its headlines.
function auditExpiryResources(r: any) {
  const requireExpiry = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 expiry resources: ' + reason);
  };
  requireExpiry(r.schemaVersion === 'p011-expiry-unforced-resources-v1' &&
    r.plane === 'isolated-current-source-cache' && r.incomplete === false && !r.error,
    'complete private cache run');
  requireExpiry(isDeepStrictEqual(r.workload, { expiredEntries: 438, rowsPerExpiredEntry: 948,
    bodyCodeUnits: 256, usefulEntries: 604, usefulBodyCodeUnits: 256, reads: 32, idleMs: 200 }),
    'equivalent workload');
  requireExpiry(sha(r.testSource?.sha256) && r.testSource.afterSha256 === r.testSource.sha256,
    'test source fence');
  requireExpiry(r.cohorts?.length === 4 && isDeepStrictEqual(r.cohorts.map((a: any) => a.mode),
    ['baseline', 'pruned', 'pruned', 'baseline']), 'order-reversed arm population');
  const usefulHash = createHash('sha256');
  for (let index = 0; index < 604; index++) usefulHash.update(JSON.stringify({ useful: index,
    body: ('useful:' + index + ':').padEnd(256, 'u') }));
  const expectedUseful = { entries: 604, sha256: usefulHash.digest('hex') };
  const labels = ['empty', 'populated', 'idle-before-end', 'ordinary-end', 'idle-after-end'];
  const seen = new Set<string>();
  const arms = r.cohorts.map((arm: any) => {
    const baseline = arm.mode === 'baseline', who = arm.processIdentity;
    requireExpiry(Number.isInteger(who?.pid) && who.pid > 0 && /^\d+$/.test(who.startTicks) &&
      sha(who.executableSha256) && typeof who.node === 'string' && who.node.startsWith('v25.'),
      'executable process identity');
    const key = identity(who);
    requireExpiry(!seen.has(key), 'independent process population'); seen.add(key);
    requireExpiry(who.executableSha256 === r.cohorts[0].processIdentity.executableSha256 &&
      who.node === r.cohorts[0].processIdentity.node, 'matched executable');
    const hashes = arm.sourceHashes;
    requireExpiry(hashes && isDeepStrictEqual(Object.keys(hashes).sort(), ['cache', 'generationStore', 'l1']) &&
      Object.values(hashes).every(sha) && isDeepStrictEqual(hashes, r.cohorts[0].sourceHashes) &&
      isDeepStrictEqual(hashes, r.sourceHashesAfter), 'named source fence');
    requireExpiry(arm.controlKind === (baseline ? 'current-with-pruning-removed' : 'current') &&
      sha(arm.effectiveCacheHash) && (baseline ? arm.effectiveCacheHash !== hashes.cache :
        arm.effectiveCacheHash === hashes.cache) && sha(arm.moduleSha256) && sha(arm.runtimeScriptSha256),
      'single current-source intervention');
    const matching = r.cohorts.filter((a: any) => a.mode === arm.mode);
    requireExpiry(matching.every((a: any) => a.effectiveCacheHash === arm.effectiveCacheHash &&
      a.moduleSha256 === arm.moduleSha256 && a.runtimeScriptSha256 === arm.runtimeScriptSha256),
      'stable paired runtime code');
    requireExpiry(arm.terminalExitCode === 0 && arm.signal === null && arm.reaped === true &&
      arm.unforcedWindowGcCalls === 0 && arm.diagnosticGcCalls === 6 &&
      isDeepStrictEqual(arm.profilerOperations, []), 'unforced window and terminal cleanup');
    requireExpiry(arm.idleMs === 200 && arm.samples?.length === 5 &&
      isDeepStrictEqual(arm.samples.map((s: any) => s.label), labels), 'phase population');
    let previousMonotonic = -1, previousAt = -1, previousAllocated = 0;
    for (const sample of [...arm.samples, arm.diagnostic?.sample, arm.cleanup?.sample]) {
      requireExpiry(sample && identity(sample) === key && sample.node === who.node &&
        positive(sample.monotonicMs) && sample.monotonicMs > previousMonotonic &&
        positive(sample.at) && sample.at >= previousAt, 'ordered PID-bound samples');
      requireExpiry(positive(sample.pssBytes) && positive(sample.memory?.rss) &&
        sample.pssBytes <= sample.memory.rss && positive(sample.memory.heapUsed) &&
        sample.memory.heapUsed <= sample.memory.heapTotal && nonnegative(sample.memory.external) &&
        nonnegative(sample.memory.arrayBuffers) && sample.memory.arrayBuffers <= sample.memory.external &&
        positive(sample.allocatedBytes) && sample.allocatedBytes >= previousAllocated &&
        isDeepStrictEqual(sample.descendants, []), 'PSS and cumulative allocation');
      previousMonotonic = sample.monotonicMs; previousAt = sample.at; previousAllocated = sample.allocatedBytes;
    }
    const [, populated, idle, ordinary, after] = arm.samples;
    requireExpiry(idle.monotonicMs - populated.monotonicMs >= 200 &&
      after.monotonicMs - ordinary.monotonicMs >= 200, 'matched idle intervals');
    requireExpiry(arm.entriesBefore === 1042 && arm.entriesAfter === (baseline ? 1042 : 604) &&
      arm.diagnostic.entries === arm.entriesAfter && arm.diagnostic.expiredReachable === (baseline ? 438 : 0),
      'expired-root disposition');
    requireExpiry(isDeepStrictEqual(arm.usefulBefore, expectedUseful) &&
      isDeepStrictEqual(arm.usefulAfter, expectedUseful), 'every useful body preserved');
    requireExpiry(arm.reads?.count === 32 && nonnegative(arm.reads.wallMs) && nonnegative(arm.reads.cpuMs) &&
      arm.cleanup.entries === 0 && arm.cleanup.expiredReachable === 0 &&
      isDeepStrictEqual(arm.cleanup.descendants, []) && arm.cleanup.finalStats?.builds === 1042 &&
      arm.cleanup.finalStats.singleFlightJoins === 0, 'useful reads and root cleanup');
    return { mode: arm.mode, identity: key,
      idleBefore: { pssDeltaBytes: idle.pssBytes - populated.pssBytes,
        allocatedBytes: idle.allocatedBytes - populated.allocatedBytes },
      ordinary: { pssDeltaBytes: ordinary.pssBytes - idle.pssBytes,
        allocatedBytes: ordinary.allocatedBytes - idle.allocatedBytes },
      idleAfter: { pssDeltaBytes: after.pssBytes - ordinary.pssBytes,
        allocatedBytes: after.allocatedBytes - ordinary.allocatedBytes },
      diagnosticHeapUsedBytes: arm.diagnostic.sample.memory.heapUsed,
      diagnosticPssBytes: arm.diagnostic.sample.pssBytes, expiredReachable: arm.diagnostic.expiredReachable };
  });
  const pairs = [[0, 1], [3, 2]].map(([baseline, candidate]) => ({ baselineArm: baseline, candidateArm: candidate,
    ordinaryPssGrowthDifferenceBytes: arms[baseline].ordinary.pssDeltaBytes - arms[candidate].ordinary.pssDeltaBytes,
    ordinaryAllocatedDifferenceBytes: arms[baseline].ordinary.allocatedBytes - arms[candidate].ordinary.allocatedBytes,
    diagnosticHeapDifferenceBytes: arms[baseline].diagnosticHeapUsedBytes - arms[candidate].diagnosticHeapUsedBytes,
    diagnosticPssDifferenceBytes: arms[baseline].diagnosticPssBytes - arms[candidate].diagnosticPssBytes }));
  return { arms, pairs, usefulEntries: 604, usefulSha256: expectedUseful.sha256,
    disposition: 'Expired roots reclaimed with complete useful content; unforced resource costs observed independently.',
    nativePhysicalOwnership: 'unknown', productionSavings: 'unmeasured', fullExecutedOperatorGraph: 'unknown' };
}

// Check the persisted request relation against the raw terminal pool samples.
// The emitter's projected counts, SQL family labels and timing are not identity.
function auditRequestQueries(r: any) {
  const requireRequest = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 request query: ' + reason);
  };
  const uuid = (x: unknown) => typeof x === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);
  const natural = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
  const queryIdentity = (q: any) => JSON.stringify([q.source?.processInstanceId,
    q.source?.buildSha, q.source?.poolInstanceId, q.connectionId, q.queryId]);
  const snapshotMode = r.mode === 'retainers';
  requireRequest(r.schemaVersion === 1 && (r.mode === 'ordinary' || snapshotMode) &&
    r.plane === 'isolated-current-build-operator-api' && r.incomplete === false &&
    !r.error && r.runner?.status === 0 && r.runner.signal === null, 'complete ordinary run');
  requireRequest(sha(r.bundleHash) && /^[a-f0-9]{7,40}$/.test(r.buildSha), 'artifact identity');
  const operations = snapshotMode ? ['HeapProfiler.enable (object IDs)',
    'v8.writeHeapSnapshot (forced GC/synchronous pause)', 'HeapProfiler.disable (object IDs)'] : [];
  requireRequest(isDeepStrictEqual(r.profilerOperations, operations) && r.retainedContainers.length === 0 &&
    r.pauses === 0 && r.hostReaped === true, 'unprofiled cleanup');
  requireRequest(r.workload.population === 1024 && r.workload.pageLimit === 128 &&
    r.workload.windows === 3 && r.workload.requestsPerWindow === 8 &&
    r.workload.concurrency === 8 && r.windows.length === 3, 'workload bounds');
  const labels = ['query-preflight', ...Array.from({ length: 3 }, (_, w) =>
    ['idle-' + w + '-start', 'idle-' + w + '-end', 'ordinary-' + w + '-start', 'ordinary-' + w + '-end']).flat(),
    ...(snapshotMode ? ['post-snapshot'] : [])];
  requireRequest(r.samples.length === labels.length && isDeepStrictEqual(r.samples.map((s: any) => s.label), labels),
    'raw sample population');
  const target = r.samples[0].processes[0], processIdentity = identity(target);
  requireRequest(target.pid === r.pid && r.inspector.pid === r.pid && /^\d+$/.test(target.startTicks) &&
    sha(target.executableSha256), 'process identity');
  let priorAt = time(r.startedAt), priorAllocated = 0;
  for (const s of r.samples) {
    requireRequest(s.pid === r.pid && time(s.at) > priorAt &&
      s.processes.filter((p: any) => p.pid === r.pid).length === 1 &&
      identity(s.processes.find((p: any) => p.pid === r.pid)) === processIdentity, 'stable raw process');
    requireRequest(s.processes.every((p: any) => positive(p.pssBytes) && positive(p.rssBytes) &&
      p.pssBytes <= p.rssBytes && nonnegative(p.anonymousBytes)) &&
      positive(s.memory.heapUsed) && s.memory.heapUsed <= s.memory.heapTotal &&
      nonnegative(s.memory.external) && nonnegative(s.memory.arrayBuffers) &&
      s.memory.arrayBuffers <= s.memory.external && positive(s.heap.total_allocated_bytes) &&
      s.heap.total_allocated_bytes >= priorAllocated, 'raw OS and V8 resources');
    priorAt = time(s.at); priorAllocated = s.heap.total_allocated_bytes;
  }
  requireRequest(time(r.finishedAt) >= priorAt, 'terminal time fence');
  const processInstances = new Set<string>(), poolInstances = new Map<string, string>();
  const seenRequests = new Set<string>(), seenQueries = new Set<string>();
  function joinRequests(requestIds: string[], projected: any[], sample: any, start: number) {
    requireRequest(requestIds.every(uuid) && new Set(requestIds).size === requestIds.length &&
      requestIds.every(id => !seenRequests.has(id)), 'unique HTTP request IDs');
    requestIds.forEach(id => seenRequests.add(id));
    const ids = new Set(requestIds);
    const raw = sample.pools.flatMap((p: any) => p.results
      .filter((q: any) => ids.has(q.correlation?.requestId)).map((q: any) => ({ ...q, pool: p.pool })));
    requireRequest(raw.length > 0 && raw.length === projected.length &&
      projected.every(q => raw.filter((x: any) => isDeepStrictEqual(q, x)).length === 1) &&
      raw.every((q: any) => projected.filter(x => isDeepStrictEqual(q, x)).length === 1),
      'projection equals raw terminal relation');
    const counts = new Map(requestIds.map(id => [id, 0]));
    for (const q of raw) {
      const c = q.correlation, source = q.source, key = queryIdentity(q);
      requireRequest(q.correlationState === 'linked' && c.operation === 'workItems.byHarness' &&
        c.attemptId === c.requestId && uuid(source.processInstanceId) && uuid(source.poolInstanceId) &&
        c.processInstanceId === source.processInstanceId, 'request and process correlation');
      requireRequest(typeof c.buildSha === 'string' && /^[a-f0-9]{7,40}$/.test(c.buildSha) &&
        r.buildSha.startsWith(c.buildSha) && (source.buildSha === null || source.buildSha === c.buildSha),
        'query build correspondence');
      requireRequest(typeof q.pool === 'string' && q.pool.length > 0 &&
        natural(q.connectionId) && natural(q.queryId) && positive(q.backendPid) &&
        q.status === 'ok' && q.errorCode === null && q.command === 'select' &&
        natural(q.rowCount) && natural(q.wireBytes) && nonnegative(q.elapsedMs) &&
        q.recordedAt >= start && q.recordedAt <= time(sample.at), 'completed query bounds');
      requireRequest(!seenQueries.has(key), 'unique exact query tuple');
      seenQueries.add(key); processInstances.add(source.processInstanceId);
      requireRequest(!poolInstances.has(q.pool) || poolInstances.get(q.pool) === source.poolInstanceId,
        'stable pool instance');
      poolInstances.set(q.pool, source.poolInstanceId);
      counts.set(c.requestId, counts.get(c.requestId)! + 1);
    }
    requireRequest(processInstances.size === 1 && requestIds.every(id => counts.get(id)! > 0),
      'one-to-many request coverage');
    return [...requestIds].sort().map(requestId => ({ requestId, queries: raw.filter((q: any) =>
      q.correlation.requestId === requestId).map((q: any) => queryIdentity(q)).sort() }));
  }
  requireRequest(r.namedQuery.httpRows === 128 && r.namedQuery.expectedDbRows === 129,
    'warm route functionality');
  const warm = joinRequests([r.namedQuery.requestId], r.namedQuery.results, r.samples[0], r.namedQuery.startedAt);
  const windows = r.windows.map((w: any, index: number) => {
    const [idleStart, idleEnd, start, end] = r.samples.slice(1 + index * 4, 5 + index * 4);
    requireRequest(w.window === index && w.idleMs === 2000 &&
      time(idleEnd.at) - time(idleStart.at) >= 2000 && w.startAt === start.at && w.endAt === end.at &&
      w.idleAllocation === null && w.ordinaryAllocation === null, 'matched unforced window');
    requireRequest(w.responses.length === 8 && sha(r.rowFingerprint) &&
      w.responses.every((h: any) => h.rows === 128 && positive(h.bytes) && h.rowFingerprint === r.rowFingerprint),
      'unchanged useful HTTP rows');
    return { window: index, requests: joinRequests(w.responses.map((h: any) => h.requestId),
      w.completedPageResults, end, time(start.at)),
    idlePssDeltaBytes: idleEnd.processes[0].pssBytes - idleStart.processes[0].pssBytes,
    ordinaryPssDeltaBytes: end.processes[0].pssBytes - start.processes[0].pssBytes,
    ordinaryAllocatedBytes: end.heap.total_allocated_bytes - start.heap.total_allocated_bytes };
  });
  return { processIdentity, warm, windows, requestCount: seenRequests.size - 1,
    queryCount: windows.reduce((n: number, w: any) => n + w.requests.reduce((m: number, h: any) => m + h.queries.length, 0), 0),
    retainedOwner: 'unobserved', workerCloneIdentity: 'unobserved', nativePhysicalOwnership: 'unknown',
    fullExecutedSourceGraph: 'unknown', physicalSavings: 'unmeasured' };
}

// Join the CDP singleton IDs to the native graph from the SAME captured input.
// Direct parents are incoming edges, not dominators; neither parent nor class
// retained sizes may be summed to infer physical/native ownership.
const exactOwners = [
  '@papercusp/memory:host', '@papercusp/memory.local-embedder-worker',
  '@papercusp/operator-core.harnessCoreCaches', '@papercusp/operator-core.operatorCache',
  '@papercusp/operator-core.snapshot-fold-slots', '@papercusp/lexicon:host',
  '@papercusp/operator-core.repoCitationTrackingCache',
  '@papercusp/operator-core.agentsAcrossWorkspaceCache',
  '@papercusp/operator-core.midTurnMemoryAdmission',
];

function auditExactOwners(r: any, additionalIds: number[] = [], ownerPopulation = exactOwners,
  planePopulation = ['isolated-current-build-operator-api']) {
  const requireOwner = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 exact owner: ' + reason);
  };
  const natural = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
  const id = (x: unknown) => natural(x) && Number(x) > 0;
  const snapshot = r.heapSnapshot, graph = r.heapRetainers, binding = r.heapOwnerBinding;
  requireOwner(r.schemaVersion === 1 && r.mode === 'retainers' &&
    planePopulation.includes(r.plane) && r.incomplete === false &&
    r.runner?.status === 0 && r.runner.signal === null && !r.error, 'complete private run');
  requireOwner(id(r.pid) && [snapshot?.pid, graph?.pid, binding?.pid, r.inspector?.pid]
    .every(pid => pid === r.pid), 'PID correspondence');
  requireOwner(/^[a-f0-9]{7,40}$/.test(r.buildSha) && sha(r.bundleHash), 'recorded artifact identity');
  requireOwner(Array.isArray(r.samples) && r.samples.length > 1, 'process samples');
  let processIdentity = '';
  for (const sample of r.samples) {
    const rows = sample.processes?.filter((row: any) => row.pid === r.pid);
    requireOwner(sample.pid === r.pid && rows?.length === 1, 'unique sampled main');
    const row = rows[0];
    requireOwner(/^\d+$/.test(row.startTicks) && sha(row.executableSha256) &&
      positive(row.pssBytes) && positive(row.rssBytes) && row.pssBytes <= row.rssBytes, 'raw process identity');
    if (!processIdentity) processIdentity = identity(row);
    requireOwner(identity(row) === processIdentity, 'process reuse');
  }
  requireOwner(sha(snapshot.sha256) && id(snapshot.bytes) &&
    graph.native?.inputSha256 === snapshot.sha256 && graph.native.inputBytes === snapshot.bytes,
  'snapshot input correspondence');
  requireOwner(sha(graph.native.executableSha256) &&
    graph.native.executableSha256 === r.nativeAdapterPreflight?.sha256 &&
    r.nativeAdapterPreflight.version === 'papercusp-heap-retainers 0.1.0' &&
    graph.native.status === 0 && graph.native.signal === null &&
    graph.native.errorCode === null && graph.native.stderrBytes === 0 &&
    graph.upstreamRevision === '05edd8131a77790ab0e7bce2eedf5770d6bb83ae', 'native execution receipt');
  const census = snapshot.census;
  requireOwner(id(census?.nodeCount) && id(census.totalSelfSizeBytes) &&
    natural(graph.rootIndex) && graph.rootIndex < census.nodeCount, 'snapshot census bounds');
  const roots = binding.roots, nodes = graph.requestedNodes, limits = graph.limits;
  requireOwner(Array.isArray(roots) && roots.length === ownerPopulation.length &&
    new Set(roots.map((x: any) => x.owner)).size === ownerPopulation.length &&
    ownerPopulation.every(owner => roots.some((x: any) => x.owner === owner)), 'exact owner population');
  requireOwner(roots.every((x: any) => x.status === 'found' && id(x.id)) &&
    new Set(roots.map((x: any) => x.id)).size === roots.length, 'unique captured owner IDs');
  const requestedIds = [...roots.map((x: any) => x.id), ...additionalIds];
  requireOwner(additionalIds.every(id) && new Set(requestedIds).size === requestedIds.length &&
    Array.isArray(nodes) && nodes.length === requestedIds.length &&
    new Set(nodes.map((x: any) => x.id)).size === requestedIds.length &&
    Array.isArray(limits?.objectIds) && isDeepStrictEqual([...limits.objectIds].sort((a, b) => a - b),
      [...requestedIds].sort((a, b) => a - b)) &&
    nodes.every((x: any) => requestedIds.includes(x.id)), 'requested ID population');
  requireOwner(limits.retainerDepth === 1 && id(limits.maxRetainers) && limits.maxRetainers <= 100,
    'bounded direct parents');
  const nodeIndexes = new Set<number>();
  const validNode = (n: any) => n && id(n.id) && natural(n.index) && n.index < census.nodeCount &&
    natural(n.selfSizeBytes) && natural(n.retainedSizeBytes) &&
    n.retainedSizeBytes >= n.selfSizeBytes && n.retainedSizeBytes <= census.totalSelfSizeBytes;
  const verifiedNodes = nodes.map((requested: any) => {
    const n = requested.node;
    requireOwner(requested.status === 'found' && n?.id === requested.id && validNode(n) &&
      !nodeIndexes.has(n.index), 'exact graph node join');
    nodeIndexes.add(n.index);
    requireOwner(Array.isArray(n.retainers) && natural(n.retainerCount) &&
      n.retainerCount >= n.retainers.length && n.retainers.length <= limits.maxRetainers &&
      typeof n.retainersTruncated === 'boolean' &&
      n.retainersTruncated === (n.retainerCount > n.retainers.length), 'retainer coverage');
    requireOwner(new Set(n.retainers.map((p: any) => p.index)).size === n.retainers.length &&
      n.retainers.every((p: any) => validNode(p) && p.index !== n.index &&
        p.index !== graph.rootIndex && p.retainsIndex === n.index &&
        ['Context', 'Property', 'Internal', 'Hidden', 'Element'].includes(p.edgeType)), 'essential incoming edges');
    return { id: n.id, index: n.index, selfSizeBytes: n.selfSizeBytes,
      dominatorRetainedV8Bytes: n.retainedSizeBytes, observedDirectParentIndexes: n.retainers.map((p: any) => p.index),
      directParentsNotChecked: n.retainerCount - n.retainers.length };
  });
  const owners = roots.map((owner: any) => ({ owner: owner.owner,
    ...verifiedNodes.find((n: any) => n.id === owner.id) }));
  // Historical captures report remote profiler operations. Atomic captures
  // declare one synchronous file/ID job and teardown after the saved IDs.
  // A malformed atomic declaration cannot fall back to the historical path.
  const qualifiedProfiler = Object.hasOwn(binding, 'identityBoundary')
    ? binding.identityBoundary === 'snapshot and IDs in one target job; synchronous inspector callbacks only' &&
      isDeepStrictEqual(r.profilerOperations, [
        'local HeapProfiler.enable + v8.writeHeapSnapshot + exact IDs in one target job',
        'local Session.disconnect after exact IDs captured',
      ])
    : Array.isArray(r.profilerOperations) &&
      r.profilerOperations.includes('v8.writeHeapSnapshot (forced GC/synchronous pause)') &&
      r.profilerOperations.includes('HeapProfiler.enable (object IDs)') &&
      r.profilerOperations.includes('HeapProfiler.disable (object IDs)');
  requireOwner(r.hostReaped === true && r.snapshotRemoved === true &&
    r.postSnapshotRowsPreserved === true && qualifiedProfiler, 'qualified intervention and cleanup');
  return { processIdentity, recordedBuildSha: r.buildSha, snapshotSha256: snapshot.sha256, owners,
    verifiedNodes: verifiedNodes.sort((a: any, b: any) => a.id - b.id),
    scope: 'Historical private snapshot; no new runtime measurement.',
    definition: 'Per-node dominator-owned V8 self_size; incoming parents are not dominators. Never sum overlapping retained sizes.',
    nativePhysicalOwnership: 'unknown', productionSavings: 'unmeasured', loadedBuildIdentity: 'unknown' };
}

// Independent conservation of the named raw relation through weak selection,
// the captured snapshot and the native graph. Collected objects are explicit
// gaps, not zero-byte owners; no producer or inspector helper is imported.
function auditRequestRetainers(r: any) {
  const requireHeap = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 request heap: ' + reason);
  };
  requireHeap(r.mode === 'retainers', 'retainer mode');
  const requests = auditRequestQueries(r);
  const q = r.heapOwnerBinding?.queries, before = r.heapQueryRegistryBeforeSnapshot;
  const natural = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
  const tuple = (x: any) => JSON.stringify([x.pool, x.source?.processInstanceId,
    x.source?.buildSha, x.source?.poolInstanceId, x.connectionId, x.queryId, x.requestId]);
  const identity = ({ weakPhasePresence, ...row }: any) => row;
  const phases = ['decodedResult', 'resolvedRows', 'responseValue'];
  const final = r.windows[2].completedPageResults.map((x: any) => ({ pool: x.pool,
    source: x.source, connectionId: x.connectionId, queryId: x.queryId, requestId: x.correlation.requestId }));
  function metadata(m: any) {
    requireHeap(m?.status === 'observed' && Array.isArray(m.records) && m.records.length <= 32 &&
      m.matched === m.records.length && m.omitted === 0 && m.omittedPools === 0 && m.omittedRows === 0 &&
      natural(m.inspectedPools) && m.inspectedPools > 0 && m.inspectedPools <= 64 &&
      new Set(m.records.map(tuple)).size === m.records.length, 'bounded registry metadata');
    requireHeap(Array.isArray(m.poolSummaries) && m.poolSummaries.length <= m.inspectedPools &&
      new Set(m.poolSummaries.map((p: any) => p.pool)).size === m.poolSummaries.length &&
      m.poolSummaries.every((p: any) => natural(p.retained) && p.retained <= 32 &&
        natural(p.totalRecorded) && p.totalRecorded >= p.retained), 'raw FIFO counters');
    requireHeap(m.records.every((row: any) => row.weakPhasePresence === undefined ||
      (row.weakPhasePresence && typeof row.weakPhasePresence === 'object' &&
        isDeepStrictEqual(Object.keys(row.weakPhasePresence).sort(), [...phases].sort()) &&
        phases.every(phase => typeof row.weakPhasePresence[phase] === 'boolean'))), 'weak phase registration metadata');
  }
  metadata(before);
  const registrationMeasured = before.records.some((row: any) => row.weakPhasePresence !== undefined);
  if (registrationMeasured) requireHeap(before.records.every((row: any) =>
    phases.every(phase => row.weakPhasePresence?.[phase] === true)), 'complete pre-snapshot weak phase registration');
  requireHeap(q?.selection === 'pre-snapshot-metadata-and-weakrefs' && q.status === 'observed' &&
    isDeepStrictEqual(q.registryBeforeSnapshot, before) &&
    isDeepStrictEqual(q.unobservedRequestIds, []) && q.omitted === 0 && q.omittedRows === 0 && q.omittedPools === 0 &&
    q.matched === before.matched && q.inspectedPools === before.inspectedPools &&
    Array.isArray(q.records) && q.records.length === final.length, 'complete selected relation');
  const samePopulation = (a: any[], b: any[]) => a.length === b.length &&
    new Set(a.map(tuple)).size === a.length && new Set(b.map(tuple)).size === b.length &&
    a.every(x => b.filter(y => isDeepStrictEqual(x, y)).length === 1);
  requireHeap(samePopulation(before.records.map(identity), final), 'pre-snapshot raw relation');
  requireHeap(q.records.every((row: any) => isDeepStrictEqual(row.weakPhasePresence,
    before.records.find((selected: any) => tuple(selected) === tuple(row))?.weakPhasePresence)),
  'selected weak phase registration');
  const identities = q.records.map(({ objects, weakPhasePresence, ...row }: any) => row);
  requireHeap(samePopulation(identities, final), 'selected exact query tuples');
  metadata(q.registryAfterSnapshot);
  requireHeap(q.registryAfterSnapshot.records.every((x: any) => final.some((y: any) => isDeepStrictEqual(identity(x), y))),
    'post-snapshot named subset');
  for (const p of before.poolSummaries) {
    const after = q.registryAfterSnapshot.poolSummaries.find((x: any) => x.pool === p.pool);
    requireHeap(after && after.totalRecorded >= p.totalRecorded, 'FIFO counter continuity');
  }
  const found: number[] = [], gaps: any[] = [];
  for (const row of q.records) {
    requireHeap(Array.isArray(row.objects) && isDeepStrictEqual(row.objects.map((o: any) => o.phase),
      ['decodedResult', 'resolvedRows', 'responseValue']), 'exact object phases');
    for (const object of row.objects) {
      if (object.status === 'found') {
        requireHeap(Number.isSafeInteger(object.id) && object.id > 0, 'numeric captured object ID');
        found.push(object.id);
      } else {
        requireHeap(['collected', 'not-in-snapshot', 'unobserved'].includes(object.status) && object.id === undefined,
          'explicit weak object gap');
        gaps.push({ tuple: tuple(row), phase: object.phase, status: object.status });
      }
    }
  }
  const rootIds = r.heapOwnerBinding.roots.map((x: any) => x.id);
  const additional = [...new Set(found)].filter(id => !rootIds.includes(id));
  const owners = auditExactOwners(r, additional);
  requireHeap(sha(r.nativeDecoderPreflight?.sha256) &&
    r.nativeDecoderPreflight.version === 'v8-heap-cli 0.1.0', 'decoder receipt');
  requireHeap(nonnegative(r.heapSnapshot.writeMs) && nonnegative(r.heapSnapshot.summaryMs) &&
    r.heapSnapshotWriteMs === r.heapSnapshot.writeMs &&
    r.heapSnapshot.durationMs >= r.heapSnapshot.writeMs + r.heapSnapshot.summaryMs,
  'separate snapshot write and summary timing');
  return { requests, owners, weakPhaseRegistration: registrationMeasured ? 'observed-complete' : 'unmeasured',
    foundQueryObjectIds: [...new Set(found)].sort((a, b) => a - b),
    weakObjectGaps: gaps.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    missingLiveRegistryTuples: final.filter((x: any) => !q.registryAfterSnapshot.records.some((y: any) =>
      isDeepStrictEqual(x, identity(y)))).map(tuple).sort(),
    timing: { writeMs: r.heapSnapshot.writeMs, summaryMs: r.heapSnapshot.summaryMs },
    workerCloneIdentity: 'unobserved', nativePhysicalOwnership: 'unknown', physicalSavings: 'unmeasured' };
}

function ownerFixture(): any {
  const process = { pid: 7, startTicks: '10', executableSha256: 'a'.repeat(64), pssBytes: 100, rssBytes: 200 };
  const roots = exactOwners.map((owner, i) => ({ owner, status: 'found', id: 10 + i }));
  return { schemaVersion: 1, mode: 'retainers', plane: 'isolated-current-build-operator-api',
    incomplete: false, runner: { status: 0, signal: null }, pid: 7, buildSha: '12345678', bundleHash: 'b'.repeat(64),
    inspector: { pid: 7 }, samples: [0, 1].map(() => ({ pid: 7, processes: [structuredClone(process)] })),
    heapSnapshot: { pid: 7, bytes: 1000, sha256: 'c'.repeat(64), census: { nodeCount: 32, totalSelfSizeBytes: 1024 } },
    heapOwnerBinding: { pid: 7, roots },
    nativeAdapterPreflight: { sha256: 'd'.repeat(64), version: 'papercusp-heap-retainers 0.1.0' },
    heapRetainers: { pid: 7, rootIndex: 0, upstreamRevision: '05edd8131a77790ab0e7bce2eedf5770d6bb83ae',
      native: { executableSha256: 'd'.repeat(64), inputSha256: 'c'.repeat(64), inputBytes: 1000,
        status: 0, signal: null, errorCode: null, stderrBytes: 0 },
      limits: { objectIds: roots.map(x => x.id), retainerDepth: 1, maxRetainers: 32 },
      requestedNodes: roots.map((x, i) => ({ id: x.id, status: 'found', node: {
        id: x.id, index: i + 1, selfSizeBytes: 8, retainedSizeBytes: 16, retainerCount: 1,
        retainersTruncated: false, retainers: [{ id: 99, index: 20, selfSizeBytes: 64,
          retainedSizeBytes: 400, retainsIndex: i + 1, edgeType: 'Context' }] } })) },
    hostReaped: true, snapshotRemoved: true, postSnapshotRowsPreserved: true,
    profilerOperations: ['v8.writeHeapSnapshot (forced GC/synchronous pause)',
      'HeapProfiler.enable (object IDs)', 'HeapProfiler.disable (object IDs)'] };
}

// Reuse the exact-node/native-input validator, while independently conserving
// digest -> entry/value relations. Distinct entries may share a value ID; even
// distinct value nodes can have overlapping dominator subtrees, so never sum them.
function auditCacheRetainers(r: any, expectedDigests: string[]) {
  const requireCache = (value: unknown, reason: string) => {
    if (!value) throw Error('P011 cache heap: ' + reason);
  };
  const natural = (x: unknown) => Number.isSafeInteger(x) && Number(x) >= 0;
  const id = (x: unknown) => natural(x) && Number(x) > 0;
  const sameDigests = (a: string[], b: string[]) => isDeepStrictEqual([...a].sort(), [...b].sort());
  requireCache(Array.isArray(expectedDigests) && expectedDigests.length > 0 && expectedDigests.length <= 32 &&
    expectedDigests.every(sha) && new Set(expectedDigests).size === expectedDigests.length, 'expected digest population');
  const q = r.heapOwnerBinding?.cacheEntries, before = r.cacheBeforeSnapshot;
  const metadata = (m: any) => {
    requireCache(m?.owner === '@papercusp/operator-core.operatorCache' && m.path === 'cache.l1.map' &&
      natural(m.population) && m.population > 0 && m.population <= 8192 &&
      m.scanned === m.population && m.scanComplete === true && m.undigestibleKeys === 0 &&
      m.limits?.maxScanned === 8192 && m.limits.maxKeyCodeUnits === 16384 &&
      Array.isArray(m.records) && m.records.length === expectedDigests.length &&
      new Set(m.records.map((row: any) => row.keyDigest)).size === expectedDigests.length &&
      sameDigests(m.records.map((row: any) => row.keyDigest), expectedDigests), 'complete bounded digest selection');
  };
  metadata(before); metadata(q);
  requireCache(before.status === 'selected' && before.records.every((row: any) => row.status === 'selected' &&
    isDeepStrictEqual(Object.keys(row).sort(), ['keyDigest', 'status'])), 'safe pre-snapshot selection');
  requireCache(q.selectionStatus === 'selected' && ['observed', 'partial'].includes(q.status) &&
    ['owner', 'path', 'population', 'scanned', 'scanComplete', 'undigestibleKeys', 'limits']
      .every(key => isDeepStrictEqual(q[key], before[key])), 'selection identity continuity');
  const gapStatuses = ['collected', 'not-in-snapshot', 'unobserved', 'evicted', 'entry-changed', 'value-changed',
    'map-changed', 'unsafe-map', 'registry-unavailable', 'proxy-skipped', 'accessor-skipped', 'missing', 'nonobject', 'unavailable'];
  const found: number[] = [], gaps: any[] = [];
  for (const row of q.records) {
    requireCache(isDeepStrictEqual(Object.keys(row).sort(), ['keyDigest', 'objects', 'status']) &&
      (row.status === 'selected' || gapStatuses.includes(row.status)) && Array.isArray(row.objects) &&
      isDeepStrictEqual(row.objects.map((object: any) => object.phase), ['entry', 'value']), 'exact entry/value phases');
    for (const object of row.objects) {
      if (object.status === 'found') {
        requireCache(row.status === 'selected' && id(object.id) &&
          isDeepStrictEqual(Object.keys(object).sort(), ['id', 'phase', 'status']), 'found identity and membership');
        found.push(object.id);
      } else {
        requireCache(gapStatuses.includes(object.status) &&
          (row.status === 'selected' || row.status === object.status) &&
          isDeepStrictEqual(Object.keys(object).sort(), ['phase', 'status']), 'explicit identity gap');
        gaps.push({ keyDigest: row.keyDigest, phase: object.phase, status: object.status });
      }
    }
  }
  requireCache((q.status === 'observed') === (gaps.length === 0), 'observed/partial correspondence');
  const rootIds = r.heapOwnerBinding.roots.map((row: any) => row.id);
  const owners = auditExactOwners(r, [...new Set(found)].filter(value => !rootIds.includes(value)),
    ['@papercusp/operator-core.operatorCache'],
    ['isolated-current-build-operator-api', 'isolated-serving-generation-operator-api']);
  requireCache(sha(r.nativeDecoderPreflight?.sha256) && r.nativeDecoderPreflight.version === 'v8-heap-cli 0.1.0',
    'decoder preflight');
  requireCache(nonnegative(r.heapSnapshot.writeMs) && nonnegative(r.heapSnapshot.summaryMs) &&
    r.heapSnapshotWriteMs === r.heapSnapshot.writeMs &&
    r.heapSnapshot.durationMs >= r.heapSnapshot.writeMs + r.heapSnapshot.summaryMs, 'separate snapshot timing');
  const nodes = new Map<number, any>(r.heapRetainers.requestedNodes.map((row: any) => [row.id, row.node]));
  const relations = q.records.map((row: any) => {
    const entry = row.objects[0], value = row.objects[1];
    if (entry.status !== 'found' || value.status !== 'found') return { keyDigest: row.keyDigest, status: 'unobserved' };
    const entryNode = nodes.get(entry.id), valueNode = nodes.get(value.id);
    const direct = valueNode.retainers.some((parent: any) => parent.id === entry.id && parent.index === entryNode.index &&
      parent.retainsIndex === valueNode.index && parent.edgeType === 'Property');
    requireCache(direct || valueNode.retainersTruncated, 'entry-to-value incoming edge');
    return { keyDigest: row.keyDigest, entryId: entry.id, valueId: value.id,
      status: direct ? 'observed-direct-property' : 'unobserved-truncated-parents' };
  }).sort((a: any, b: any) => a.keyDigest.localeCompare(b.keyDigest));
  const uniqueValueIds = [...new Set<number>(q.records.flatMap((row: any) =>
    row.objects.filter((object: any) => object.phase === 'value' && object.status === 'found')
      .map((object: any) => object.id)))].sort((a, b) => a - b);
  return { owners, relations, uniquePayloadNodes: uniqueValueIds.map(value =>
    owners.verifiedNodes.find((node: any) => node.id === value)),
    aliasGroups: uniqueValueIds.map(value => ({ valueId: value,
      keyDigests: relations.filter((row: any) => row.valueId === value).map((row: any) => row.keyDigest) })),
    gaps: gaps.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    definition: 'Distinct snapshot IDs only; per-node dominator sizes may overlap and are never summed.',
    nativePhysicalOwnership: 'unknown', physicalSavings: 'unmeasured' };
}

function auditInboxCacheRetainers(report: any) {
  check(report.schemaVersion === 2 && report.incomplete === false && report.runner?.status === 0 &&
    report.runner.signal === null && !report.error && !report.verificationError &&
    Array.isArray(report.cohorts) && report.cohorts.length === 4 &&
    report.cohorts.map((c: any) => c.mode).join(',') === 'baseline,shared,shared,baseline', 'cache paired run');
  check(new Set(report.cohorts.map((c: any) => c.pid)).size === 4 &&
    isDeepStrictEqual(report.sources.before, report.sources.after) && Object.keys(report.sources.before).length > 0,
  'cache process/source fence');
  const expected = Array.from({ length: 256 }, (_, i) => ({ id: 'p011-' + (i + 1),
    body: ('useful-context-' + (i + 1) + ' ').repeat(32768).slice(0, 32768) }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash('sha256');
  for (const row of expected) hash.update(JSON.stringify([row.id, row.body]));
  const contentSha256 = hash.digest('hex');
  return report.cohorts.map((c: any, arm: number) => {
    const count = c.mode === 'baseline' ? 8 : 1, final = c.samples.at(-1);
    check(c.arm === arm && c.pid === c.identity.pid && /^\d+$/.test(c.identity.startTicks) &&
      c.reaped === true && c.forcedCleanup === false && c.unreaped.length === 0 && c.pauses === 0 &&
      c.samples.every((s: any) => s.os.startTicks === c.identity.startTicks) &&
      final.phase === 'completion-idle' && final.cache.entries === count &&
      final.cache.rows.length === count && final.cache.rows.every((rows: any) => rows === 256) &&
      final.cache.keyDigests.length === count && c.content.length === count &&
      c.content.every((row: any) => row.rows === 256 && row.stringCodeUnits === 8388608 &&
        row.sha256 === contentSha256 && sha(row.keyDigest)) &&
      isDeepStrictEqual(c.content.map((row: any) => row.keyDigest).sort(), [...final.cache.keyDigests].sort()),
    'cache digest/content correspondence');
    check(positive(c.cacheHeap?.snapshotStartedAt) && c.samples.every((s: any) =>
      positive(s.at) && c.cacheHeap.snapshotStartedAt >= s.at), 'snapshot follows resource windows');
    const evidence = { ...c.cacheHeap, schemaVersion: 1, mode: 'retainers', plane: report.plane,
      pid: c.pid, buildSha: c.loadedHealth.sha, bundleHash: c.bundleSha256,
      incomplete: report.incomplete, runner: report.runner, error: report.error, hostReaped: c.reaped,
      samples: c.samples.map((s: any) => ({ pid: s.pid, processes: [s.os] })) };
    return { arm, mode: c.mode, result: auditCacheRetainers(evidence, final.cache.keyDigests) };
  });
}

function cacheHeapFixture(count = 2, shared = true): any {
  const r = ownerFixture(), root = r.heapOwnerBinding.roots.find((row: any) => row.owner.endsWith('.operatorCache'));
  r.heapOwnerBinding.roots = [root];
  r.heapRetainers.requestedNodes = r.heapRetainers.requestedNodes.filter((row: any) => row.id === root.id);
  r.heapSnapshot.census.nodeCount = 100;
  const records = Array.from({ length: count }, (_, i) => ({ keyDigest: digest('key-' + i), status: 'selected',
    objects: [{ phase: 'entry', status: 'found', id: 30 + i },
      { phase: 'value', status: 'found', id: shared ? 80 : 80 + i }] }));
  const meta = { owner: root.owner, path: 'cache.l1.map', status: 'selected', population: count,
    scanned: count, scanComplete: true, undigestibleKeys: 0, limits: { maxScanned: 8192, maxKeyCodeUnits: 16384 },
    records: records.map(({ objects, ...row }) => row) };
  r.cacheBeforeSnapshot = structuredClone(meta);
  r.heapOwnerBinding.cacheEntries = { ...meta, selectionStatus: 'selected', status: 'observed', records };
  const node = (id: number, index: number, parents: any[]) => ({ id, status: 'found', node: {
    id, index, selfSizeBytes: 8, retainedSizeBytes: 16, retainerCount: parents.length,
    retainersTruncated: false, retainers: parents } });
  records.forEach((row, i) => r.heapRetainers.requestedNodes.push(node(row.objects[0].id, 10 + i, [])));
  for (const valueId of new Set(records.map(row => row.objects[1].id)))
    r.heapRetainers.requestedNodes.push(node(valueId, 30 + valueId - 80,
      records.filter(row => row.objects[1].id === valueId).map(row => ({ id: row.objects[0].id,
        index: 10 + row.objects[0].id - 30, selfSizeBytes: 8, retainedSizeBytes: 16,
        retainsIndex: 30 + valueId - 80, edgeType: 'Property' }))));
  r.heapRetainers.limits.objectIds = r.heapRetainers.requestedNodes.map((row: any) => row.id);
  r.nativeDecoderPreflight = { sha256: 'e'.repeat(64), version: 'v8-heap-cli 0.1.0' };
  r.heapSnapshotWriteMs = r.heapSnapshot.writeMs = 5;
  r.heapSnapshot.summaryMs = 10; r.heapSnapshot.durationMs = 15;
  return r;
}

// A tracked, deterministic fixture independently constructed from the reader contract.
function fixture(sibling = false): any {
  const main = { pid: 7, startTicks: '10', parentPid: 1, executableSha256: 'a'.repeat(64),
    pssBytes: 100, rssBytes: 200, anonymousBytes: 80,
    command: { sha256: 'b'.repeat(64), script: '/runtime/hono-host.mjs' } };
  const child = { ...structuredClone(main), pid: 8, startTicks: '11', parentPid: 7,
    command: { sha256: 'c'.repeat(64), script: '/runtime/spawner-sidecar.mjs' } };
  const loaded = { status: 'known', pid: 8, buildInfo: { sha: '12345678', version: '1' },
    serverGeneration: 'server', connectionId: 'connection' };
  const r: any = { schemaVersion: 1, plane: 'live-current-build-operator-api', incomplete: false,
    pid: 7, counterPid: sibling ? 8 : 7, buildSha: '12345678', startedAt: 1, endedAt: 10000,
    healthBefore: { sha: '12345678' }, healthAfter: { sha: '12345678' },
    bundle: { path: main.command.script, argvEntry: main.command.script,
      diskSha256: 'd'.repeat(64), diskSha256After: 'd'.repeat(64) },
    counterBundle: { path: sibling ? child.command.script : main.command.script,
      argvEntry: sibling ? child.command.script : main.command.script,
      diskSha256: 'e'.repeat(64), diskSha256After: 'e'.repeat(64),
      loadedBuild: loaded, loadedBuildAfter: structuredClone(loaded),
      socketBefore: { dev: 1, ino: 2 }, socketAfter: { dev: 1, ino: 2 } },
    limits: { windows: 3, idleMs: 2000, requestsPerWindow: 8, concurrency: 2, descendantsPerSample: 64 },
    operations: [], inspector: { openedByProbe: true },
    cleanup: { processIdentityPreserved: true, counterIdentityPreserved: true, inspector: { closed: true } },
    samples: [], windows: [], requests: [] };
  for (let w = 0; w < 3; w++) {
    for (let p = 0; p < 3; p++) r.samples.push({ label: ['idle-' + w + '-start', 'idle-' + w + '-end', 'ordinary-' + w + '-end'][p],
      at: 100 + w * 3000 + [0, 2000, 2500][p], pid: r.counterPid,
      os: structuredClone(main), counterOs: structuredClone(sibling ? child : main),
      descendants: sibling ? [structuredClone(child)] : [], inventory: { notChecked: [] },
      memory: { heapUsed: 50, heapTotal: 100, external: 10, arrayBuffers: 2 },
      heap: { total_allocated_bytes: 1000 + w * 300 + p * 100 },
      heapSpaces: [{ space_name: 'old_space', space_used_size: 50 }], heapCode: { code_and_metadata_size: 5 },
      hostFacts: { cluster: { isPrimary: true, isWorker: false }, backgroundWorkersOverride: 'disabled',
        sidecarFlags: { spawner: sibling, substrate: false, gateway: false, embed: false, resourceHealth: false } } });
    r.windows.push({ window: w, startedAt: 2200 + w * 3000, endedAt: 2700 + w * 3000 });
    for (let pair = 0; pair < 4; pair++) for (let index = 0; index < 2; index++) r.requests.push({ window: w, pair, index,
      status: 200, rows: 32, responseBytes: 100, responseSha256: 'f'.repeat(64), elapsedMs: 1 });
  }
  return r;
}

describe('P011 independent selected-worker resource windows', () => {
  const uuid = (n: number) => '00000000-0000-4000-8000-' + n.toString(16).padStart(12, '0');
  // Construct the raw report independently; no collector or inspector import.
  function workerFixture(): any {
    const r = fixture(), main = structuredClone(r.samples[0].os);
    const child = { ...structuredClone(main), pid: 8, parentPid: 7, startTicks: '11' };
    r.counterPids = [7, 8];
    for (const s of r.samples) s.descendants = [structuredClone(child)];
    r.targetBundles = [main, child].map(os => ({ pid: os.pid, startTicks: os.startTicks,
      executableSha256: os.executableSha256, path: os.command.script,
      diskSha256: 'e'.repeat(64), diskSha256After: 'e'.repeat(64) }));
    r.inspectors = [{ pid: 7, openedByProbe: true }, { pid: 8, openedByProbe: false }];
    r.cleanup.inspectors = [{ pid: 8, openedByProbe: false, result: { preservedPreexisting: true } },
      { pid: 7, openedByProbe: true, result: { closed: true } }];
    r.requestWorkerWindows = []; r.requestWorkerAssignments = [];
    for (let window = 0; window < 3; window++) {
      const requests = r.requests.filter((q: any) => q.window === window);
      requests.forEach((q: any, i: number) => { q.requestId = uuid(100 + window * 8 + i); });
      const observations = (after: boolean) => [main, child].map((os, i) => {
        const processInstanceId = uuid(i + 1), poolInstanceId = uuid(i + 10);
        const facts = { cluster: { isPrimary: true, isWorker: false }, stagingPort: true,
          backgroundWorkersOverride: 'disabled', sidecarFlags: { spawner: false, substrate: false,
            gateway: false, embed: false, resourceHealth: false } };
        const results = after ? requests.flatMap((q: any, n: number) => n % 2 === i ?
          Array.from({ length: n === 0 ? 2 : 1 }, (_, j) => ({ pool: j ? 'secondary' : 'main',
            source: { processInstanceId, poolInstanceId, buildSha: r.buildSha },
            correlation: { processInstanceId, buildSha: r.buildSha, requestId: q.requestId,
              operation: 'workItems.byHarness' }, status: 'ok', connectionId: 1, queryId: n * 2 + j })) : []) : [];
        return { before: { ...structuredClone(os), pssBytes: after ? 80 : 100 },
          after: { ...structuredClone(os), pssBytes: after ? 80 : 100 },
          counters: { pid: os.pid, heap: { total_allocated_bytes: 1000 + window * 1000 + (after ? 200 : 0) },
            memory: { heapUsed: 50, heapTotal: 100, external: 10, arrayBuffers: 2 }, hostFacts: facts },
          role: { clusterRole: 'primary', requestOnly: true, configuredSidecar: null,
            requestAssignment: 'unknown', allocationOwner: 'unknown' },
          snapshot: { status: 'observed', pid: os.pid, buildSha: r.buildSha, processInstanceId, results } };
      });
      const coverage = { selectedPids: [7, 8], unsampledPids: [9], notCheckedBefore: [],
        notCheckedAfter: [{ pid: 10, parentPid: 7, reason: 'census cap' }], population: 'bounded' };
      const before = { startedAt: 2200 + window * 3000, endedAt: 2210 + window * 3000,
        observations: observations(false), coverage: structuredClone(coverage) };
      const after = { startedAt: 2300 + window * 3000, endedAt: 2310 + window * 3000,
        observations: observations(true), coverage: structuredClone(coverage) };
      for (const sample of [before, after] as any[]) {
        const census = (bracket: string) => ({ main: structuredClone(sample.observations[0][bracket]),
          descendants: [structuredClone(sample.observations[1][bracket]),
            { ...structuredClone(main), pid: 9, parentPid: 7, startTicks: '12' }],
          notChecked: structuredClone(sample.coverage[bracket === 'before' ? 'notCheckedBefore' : 'notCheckedAfter']) });
        sample.census = { before: census('before'), after: census('after') };
      }
      const resources = after.observations.map((row: any, i: number) => ({ pid: row.after.pid,
        startTicks: row.after.startTicks, executableSha256: row.after.executableSha256,
        processInstanceId: row.snapshot.processInstanceId, buildSha: r.buildSha, role: row.role,
        pssBytesBefore: 100, pssBytesAfter: 80, pssChangeBytes: -20, allocatedBytes: 200,
        countersBefore: before.observations[i].counters, countersAfter: row.counters }));
      const assignments = requests.map((q: any) => {
        const row = after.observations.find((o: any) => o.snapshot.results.some((v: any) =>
          v.correlation.requestId === q.requestId))!;
        return { requestId: q.requestId, pid: row.after.pid, startTicks: row.after.startTicks,
          processInstanceId: row.snapshot.processInstanceId,
          queryTuples: row.snapshot.results.filter((v: any) => v.correlation.requestId === q.requestId).map((v: any) =>
            JSON.stringify([q.requestId, v.pool, v.source.processInstanceId, v.source.buildSha,
              v.source.poolInstanceId, v.connectionId, v.queryId])) };
      });
      const assignment = { status: 'observed', requested: 8, assignments, unresolvedRequestIds: [] };
      r.requestWorkerWindows.push({ window, before, after, resources, assignment });
      r.requestWorkerAssignments.push({ window, ...structuredClone(assignment) });
    }
    return r;
  }
  it('accepts one-to-many exact tuples, negative PSS changes and explicit unknown coverage', () => {
    const r = workerFixture(), frozen = structuredClone(r), result = auditBaseline(r);
    expect(r).toEqual(frozen);
    const w = result.requestWorkerWindows![0];
    expect(w.assignment.assignments[0].queryTuples).toHaveLength(2);
    expect(w.resources.map((x: any) => [x.pssChangeBytes, x.allocatedBytes])).toEqual([[-20, 200], [-20, 200]]);
    expect(w.coverage[0].unsampledPids).toEqual([9]);
    expect(w.coverage[1].notCheckedAfter).toHaveLength(1);
    expect(w.servingWorkerPopulation).toBe('unknown');
    expect(w.selectedAncestry.status).toBe('observed');
    expect(w.selectedAncestry.brackets).toHaveLength(8);
    expect(w.physicalSavings).toBe('unmeasured');
  });
  it('leaves legacy missing census ancestry explicitly unknown without modifying saved input', () => {
    const r = workerFixture();
    for (const w of r.requestWorkerWindows) { delete w.before.census; delete w.after.census; }
    const frozen = structuredClone(r), result = auditBaseline(r);
    expect(result.requestWorkerWindows!.every((w: any) => w.selectedAncestry.status === 'unknown')).toBe(true);
    expect(r).toEqual(frozen);
  });
  function checkpointFixture() {
    const r = workerFixture();
    for (const w of r.requestWorkerWindows) {
      const point = structuredClone(w.after);
      point.startedAt = w.before.endedAt + 1; point.endedAt = point.startedAt + 1;
      point.requestIds = r.requests.filter((q: any) => q.window === w.window).map((q: any) => q.requestId);
      for (let i = 0; i < point.observations.length; i++) {
        point.observations[i].counters.heap.total_allocated_bytes =
          w.before.observations[i].counters.heap.total_allocated_bytes + 100;
        for (const sample of [w.before, point, w.after]) {
          // All-query counters are separate from selected metadata. A later
          // overwrite is visible without inventing a tuple for a missing ID.
          const total = w.window * 100 + (sample === w.before ? 0 : sample === point ? 10 : 50);
          sample.observations[i].snapshot.pools = ['main', 'secondary'].map(pool => ({ pool,
            capacity: 32, totalRecorded: total, retained: Math.min(total, 32), dropped: Math.max(0, total - 32) }));
        }
        w.after.observations[i].snapshot.results = [];
      }
      w.during = [point];
    }
    return r;
  }
  it('independently conserves observed checkpoint tuples after terminal ring turnover', () => {
    const r = checkpointFixture(), frozen = structuredClone(r), result = auditBaseline(r);
    expect(r).toEqual(frozen);
    expect(result.requestWorkerWindows!.every((w: any) => w.assignment.status === 'observed')).toBe(true);
    expect(result.requestWorkerWindows![0].diagnosticRings.status).toBe('observed');
    expect(result.requestWorkerWindows![0].diagnosticRings.samples.some((p: any) => p.dropped > 0)).toBe(true);
    expect(result.requestWorkerWindows![0].queryObservation).toBe('response checkpoints and terminal ring');
  });
  it('deduplicates identical checkpoint tuples without duplicating query assignments', () => {
    const r = checkpointFixture();
    for (const w of r.requestWorkerWindows) for (let i = 0; i < w.after.observations.length; i++)
      w.after.observations[i].snapshot.results = structuredClone(w.during[0].observations[i].snapshot.results);
    expect(auditBaseline(r).requestWorkerWindows![0].assignment.assignments[0].queryTuples).toHaveLength(2);
  });
  it.each(['time', 'request omission', 'foreign request', 'PID reuse', 'build', 'allocation',
    'pool accounting', 'pool omission', 'duplicate tuple', 'conflicting tuple'])(
    'rejects response-checkpoint corruption: %s', kind => {
      const r = checkpointFixture(), w = r.requestWorkerWindows[0], point = w.during[0], row = point.observations[0];
      if (kind === 'time') point.endedAt = w.after.startedAt + 1;
      if (kind === 'request omission') point.requestIds.pop();
      if (kind === 'foreign request') point.requestIds[0] = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      if (kind === 'PID reuse') row.after.startTicks = 'reused';
      if (kind === 'build') row.snapshot.buildSha = 'abcdef12';
      if (kind === 'allocation') row.counters.heap.total_allocated_bytes = 999;
      if (kind === 'pool accounting') row.snapshot.pools[0].dropped++;
      if (kind === 'pool omission') row.snapshot.pools = [];
      if (kind === 'duplicate tuple') row.snapshot.results.push(structuredClone(row.snapshot.results[0]));
      if (kind === 'conflicting tuple') {
        w.after.observations[0].snapshot.results = structuredClone(row.snapshot.results);
        w.after.observations[0].snapshot.results[0].metadataDrift = true;
      }
      expect(() => auditBaseline(r)).toThrow(/P011 worker windows:/);
    });
  function intermediateAncestorFixture() {
    const r = workerFixture();
    for (const s of r.samples) {
      s.descendants[0].parentPid = 9;
      s.descendants.push({ ...structuredClone(s.os), pid: 9, parentPid: 7, startTicks: '12',
        command: { ...s.os.command, script: '/runtime/wrapper.mjs' } });
    }
    for (const w of r.requestWorkerWindows) for (const sample of [w.before, w.after]) {
      sample.observations[1].before.parentPid = sample.observations[1].after.parentPid = 9;
      for (const bracket of ['before', 'after']) {
        sample.census[bracket].descendants[0].parentPid = 9;
        sample.census[bracket].descendants[1].command.script = '/runtime/wrapper.mjs';
      }
    }
    return r;
  }
  it('joins an unsampled intermediate ancestor using the exact raw brackets', () => {
    const result = auditBaseline(intermediateAncestorFixture()).requestWorkerWindows![0];
    expect(result.selectedAncestry.brackets!.find((x: any) => x.pid === 8).chain.map((x: any) => x.pid))
      .toEqual([8, 9, 7]);
    expect(result.servingWorkerPopulation).toBe('unknown');
    expect(result.unsampledAncestorLifetimes).toBe('unknown');
  });
  it.each(['startTicks', 'executable', 'command', 'entry', 'parent', 'missing', 'later window'] as const)(
    'rejects unsampled ancestor corruption: %s', kind => {
      const r = intermediateAncestorFixture();
      const census = r.requestWorkerWindows[kind === 'later window' ? 1 : 0].after.census.after;
      const ancestor = census.descendants[1];
      if (kind === 'startTicks' || kind === 'later window') ancestor.startTicks = '99';
      if (kind === 'executable') ancestor.executableSha256 = 'f'.repeat(64);
      if (kind === 'command') ancestor.command.sha256 = 'f'.repeat(64);
      if (kind === 'entry') ancestor.command.script = '/other/wrapper.mjs';
      if (kind === 'parent') ancestor.parentPid = 8;
      if (kind === 'missing') census.descendants.pop();
      expect(() => auditBaseline(r)).toThrow(/P011 worker windows:/);
    });
  it('preserves evicted-ring requests as partial and missing HTTP identities as unknown', () => {
    const r = workerFixture(), w = r.requestWorkerWindows[0], id = r.requests[0].requestId;
    w.after.observations[0].snapshot.results = w.after.observations[0].snapshot.results.filter((q: any) =>
      q.correlation.requestId !== id);
    for (const a of [w.assignment, r.requestWorkerAssignments[0]]) {
      a.status = 'partial'; a.assignments = a.assignments.filter((q: any) => q.requestId !== id);
      a.unresolvedRequestIds = [id];
    }
    expect(auditBaseline(r).requestWorkerWindows![0].assignment.unresolvedRequestIds).toEqual([id]);
    r.requests[0].requestId = null;
    for (const a of [w.assignment, r.requestWorkerAssignments[0]]) {
      a.status = 'unknown'; a.assignments = []; a.unresolvedRequestIds = r.requests.slice(0, 8).map((q: any) => q.requestId);
    }
    expect(auditBaseline(r).requestWorkerWindows![0].assignment.status).toBe('unknown');
  });
  it('accepts exact same-entry descendant counters without applying a sidecar role', () => {
    const r = workerFixture(); r.counterPids = [8, 7]; r.counterPid = 8;
    for (const s of r.samples) { s.pid = 8; s.counterOs = structuredClone(s.descendants[0]); }
    for (const w of r.requestWorkerWindows) {
      w.resources.reverse();
      for (const phase of [w.before, w.after]) { phase.observations.reverse(); phase.coverage.selectedPids = [8, 7]; }
    }
    expect(auditBaseline(r).target).toBe('selected-request-worker');
  });
  it('accepts raw cluster-worker and staging-default request roles', () => {
    const r = workerFixture();
    for (const s of r.samples) {
      s.hostFacts.cluster = { isPrimary: false, isWorker: true };
      s.hostFacts.backgroundWorkersOverride = 'unset'; s.hostFacts.stagingPort = true;
    }
    for (const w of r.requestWorkerWindows) {
      for (const sample of [w.before, w.after]) for (const o of sample.observations) {
        o.counters.hostFacts.cluster = { isPrimary: false, isWorker: true };
        o.counters.hostFacts.backgroundWorkersOverride = 'unset'; o.role.clusterRole = 'worker';
      }
    }
    expect(auditBaseline(r).requestWorkerWindows![0].resources[0].role.clusterRole).toBe('worker');
  });
  const corruptions: [string, (r: any, w: any) => void][] = [
    ['duplicate selection', r => { r.counterPids = [7, 7]; }],
    ['missing windows', r => { delete r.requestWorkerWindows; }],
    ['missing window', r => { r.requestWorkerWindows.pop(); }],
    ['duplicated window', r => { r.requestWorkerWindows[1].window = 0; }],
    ['missing inspector', r => { r.inspectors.pop(); }],
    ['artifact drift', r => { r.targetBundles[1].diskSha256After = 'a'.repeat(64); }],
    ['cleanup failure', r => { r.cleanup.inspectors[0].result.preservedPreexisting = false; }],
    ['duplicate HTTP identity', r => { r.requests[1].requestId = r.requests[0].requestId; }],
    ['invalid HTTP identity', r => { r.requests[0].requestId = 'a'.repeat(36); }],
    ['missing selected observation', (_r, w) => { w.after.observations.pop(); }],
    ['selected PID reuse', (_r, w) => { w.after.observations[0].after.startTicks = '99'; }],
    ['entry drift', (_r, w) => { w.after.observations[0].before.command.script = '/other/hono-host.mjs'; }],
    ['foreign ancestry', (_r, w) => { w.after.observations[1].after.parentPid = 99; }],
    ['OS executable drift', (_r, w) => { w.after.observations[0].after.executableSha256 = 'f'.repeat(64); }],
    ['RSS substituted', (_r, w) => { w.after.observations[0].after.pssBytes = 201; }],
    ['counter PID mismatch', (_r, w) => { w.after.observations[0].counters.pid = 8; }],
    ['allocation regression', (_r, w) => { w.after.observations[0].counters.heap.total_allocated_bytes = 1; }],
    ['nonfinite allocation', (_r, w) => { w.after.observations[0].counters.heap.total_allocated_bytes = Infinity; }],
    ['background role', (_r, w) => { w.after.observations[0].counters.hostFacts.backgroundWorkersOverride = 'enabled'; }],
    ['sidecar role', (_r, w) => { w.after.observations[0].counters.hostFacts.sidecarFlags.spawner = true; }],
    ['forged role', (_r, w) => { w.after.observations[0].role.clusterRole = 'worker'; }],
    ['inspector snapshot PID mismatch', (_r, w) => { w.after.observations[0].snapshot.pid = 8; }],
    ['loaded build drift', (_r, w) => { w.after.observations[0].snapshot.buildSha = 'ffffffff'; }],
    ['process instance drift', (_r, w) => { w.after.observations[0].snapshot.processInstanceId = uuid(99); }],
    ['pre-request query', (_r, w) => { w.before.observations[0].snapshot.results = w.after.observations[0].snapshot.results; }],
    ['query build drift', (_r, w) => { w.after.observations[0].snapshot.results[0].source.buildSha = 'ffffffff'; }],
    ['query process drift', (_r, w) => { w.after.observations[0].snapshot.results[0].correlation.processInstanceId = uuid(99); }],
    ['query failed', (_r, w) => { w.after.observations[0].snapshot.results[0].status = 'error'; }],
    ['query duplicate', (_r, w) => { w.after.observations[0].snapshot.results.push(w.after.observations[0].snapshot.results[0]); }],
    ['query ring cap', (_r, w) => { w.after.observations[0].snapshot.results = Array(65).fill(w.after.observations[0].snapshot.results[0]); }],
    ['invalid pool instance', (_r, w) => { w.after.observations[0].snapshot.results[0].source.poolInstanceId = 'a'.repeat(36); }],
    ['negative connection', (_r, w) => { w.after.observations[0].snapshot.results[0].connectionId = -1; }],
    ['foreign operation', (_r, w) => { w.after.observations[0].snapshot.results[0].correlation.operation = 'other'; }],
    ['cross-worker request', (_r, w) => {
      w.after.observations[1].snapshot.results[0].correlation.requestId = w.after.observations[0].snapshot.results[0].correlation.requestId;
    }],
    ['cross-window process', r => {
      r.requestWorkerWindows[1].before.observations[0].snapshot.processInstanceId = uuid(99);
    }],
    ['query missing from assignment', (_r, w) => { w.assignment.assignments[0].queryTuples.pop(); }],
    ['extra assignment', r => { r.requestWorkerAssignments.push(r.requestWorkerAssignments[0]); }],
    ['forged resource saving', (_r, w) => { w.resources[0].pssChangeBytes = -99; }],
    ['missing unknown coverage', (_r, w) => { delete w.after.coverage.notCheckedAfter; }],
    ['selected as unsampled', (_r, w) => { w.after.coverage.unsampledPids.push(7); }],
    ['unordered brackets', (_r, w) => { w.after.startedAt = w.before.startedAt - 1; }],
    ['missing raw census phase', (_r, w) => { delete w.after.census; }],
    ['missing raw census bracket', (_r, w) => { delete w.before.census.after; }],
    ['duplicate raw census PID', (_r, w) => { w.before.census.before.descendants.push(w.before.census.before.main); }],
    ['raw census cap', (_r, w) => { w.before.census.before.descendants = Array(65).fill(w.before.census.before.descendants[0]); }],
    ['raw census root reuse', (_r, w) => { w.before.census.before.main.startTicks = '99'; }],
    ['raw selected census PSS', (_r, w) => { w.before.census.before.descendants[0].pssBytes++; }],
    ['raw selected census lifetime', (_r, w) => { w.after.census.after.descendants[0].startTicks = '99'; }],
    ['raw ancestor cycle', (_r, w) => { w.before.census.before.descendants[0].parentPid = 8; }],
    ['raw unknown ancestor', (_r, w) => { w.before.census.before.descendants[0].parentPid = 99; }],
    ['raw capped residue dropped', (_r, w) => { w.after.census.after.notChecked = []; }],
    ['raw unsampled coverage forged', (_r, w) => { w.after.coverage.unsampledPids = []; }],
    ['raw unselected row invalid', (_r, w) => { w.after.census.after.descendants[1].executableSha256 = 'invalid'; }],
  ];
  it.each(corruptions)('rejects saved worker-window corruption: %s', (_name, corrupt) => {
    const r = workerFixture(); corrupt(r, r.requestWorkerWindows[0]);
    expect(() => auditBaseline(r)).toThrow(/P011 (worker windows|baseline):/);
  });
});

describe('P011 independent unforced expiry resource evidence', () => {
  const fixture = () => {
    const hashes = { cache: 'b'.repeat(64), l1: 'c'.repeat(64), generationStore: 'd'.repeat(64) };
    const h = createHash('sha256');
    for (let i = 0; i < 604; i++) h.update(JSON.stringify({ useful: i,
      body: ('useful:' + i + ':').padEnd(256, 'u') }));
    const useful = { entries: 604, sha256: h.digest('hex') };
    return { schemaVersion: 'p011-expiry-unforced-resources-v1', plane: 'isolated-current-source-cache',
      incomplete: false, workload: { expiredEntries: 438, rowsPerExpiredEntry: 948, bodyCodeUnits: 256,
        usefulEntries: 604, usefulBodyCodeUnits: 256, reads: 32, idleMs: 200 },
      testSource: { sha256: 'e'.repeat(64), afterSha256: 'e'.repeat(64) }, sourceHashesAfter: hashes,
      cohorts: ['baseline', 'pruned', 'pruned', 'baseline'].map((mode, arm) => {
        const baseline = mode === 'baseline', processIdentity = { pid: arm + 10, startTicks: String(arm + 100),
          executableSha256: 'f'.repeat(64), node: 'v25.9.0' };
        const sample = (label: string, index: number) => ({ label, ...processIdentity,
          at: 1800000000000 + arm * 10000 + index * 250, monotonicMs: 1000 + arm * 10000 + index * 250,
          memory: { rss: 16384, heapUsed: 6000, heapTotal: 12288, external: 100, arrayBuffers: 50 },
          pssBytes: 8000, allocatedBytes: 10000 + index * 300, descendants: [] });
        return { mode, processIdentity, sourceHashes: structuredClone(hashes),
          effectiveCacheHash: baseline ? 'a'.repeat(64) : hashes.cache,
          controlKind: baseline ? 'current-with-pruning-removed' : 'current',
          moduleSha256: (baseline ? 'a' : 'b').repeat(64), runtimeScriptSha256: (baseline ? 'c' : 'd').repeat(64),
          terminalExitCode: 0, signal: null, reaped: true, unforcedWindowGcCalls: 0,
          diagnosticGcCalls: 6, profilerOperations: [], idleMs: 200, entriesBefore: 1042,
          entriesAfter: baseline ? 1042 : 604, usefulBefore: structuredClone(useful), usefulAfter: structuredClone(useful),
          reads: { count: 32, wallMs: 1, cpuMs: 1 },
          samples: ['empty', 'populated', 'idle-before-end', 'ordinary-end', 'idle-after-end'].map(sample),
          diagnostic: { sample: sample('diagnostic-after-collection', 5), entries: baseline ? 1042 : 604,
            expiredReachable: baseline ? 438 : 0 },
          cleanup: { sample: sample('cleared-after-collection', 6), entries: 0, expiredReachable: 0,
            descendants: [], finalStats: { builds: 1042, singleFlightJoins: 0 } } };
      }) };
  };
  it('keeps unfavorable PSS observations separate from verified useful-root reclamation', () => {
    const r = fixture();
    for (const arm of r.cohorts.filter(a => a.mode === 'pruned')) arm.diagnostic.sample.pssBytes = 9000;
    const result = auditExpiryResources(r);
    expect(result.pairs.every((p: any) => p.diagnosticPssDifferenceBytes === -1000)).toBe(true);
    expect(result.usefulEntries).toBe(604);
    expect(result.nativePhysicalOwnership).toBe('unknown');
    expect(result.productionSavings).toBe('unmeasured');
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['live-plane promotion', r => { r.plane = 'live-current-build-operator-api'; }],
    ['incomplete capture', r => { r.incomplete = true; }],
    ['missing arm', r => { r.cohorts.pop(); }],
    ['wrong order', r => { r.cohorts.reverse(); r.cohorts[1].mode = 'baseline'; }],
    ['workload mismatch', r => { r.workload.reads++; }],
    ['test drift', r => { r.testSource.afterSha256 = 'a'.repeat(64); }],
    ['source drift', r => { r.sourceHashesAfter.cache = 'a'.repeat(64); }],
    ['extra source label', r => { r.cohorts[0].sourceHashes.unknown = 'a'.repeat(64); }],
    ['missing intervention', r => { r.cohorts[0].effectiveCacheHash = r.cohorts[0].sourceHashes.cache; }],
    ['paired code drift', r => { r.cohorts[3].moduleSha256 = 'f'.repeat(64); }],
    ['reused process', r => { r.cohorts[1].processIdentity = r.cohorts[0].processIdentity; }],
    ['sample process reuse', r => { r.cohorts[0].samples[3].startTicks = '0'; }],
    ['executable mismatch', r => { r.cohorts[1].processIdentity.executableSha256 = 'a'.repeat(64); }],
    ['RSS alone', r => { delete r.cohorts[0].samples[3].pssBytes; }],
    ['allocation omitted', r => { delete r.cohorts[0].samples[3].allocatedBytes; }],
    ['allocation reset', r => { r.cohorts[0].samples[3].allocatedBytes = 1; }],
    ['short idle', r => { r.cohorts[0].samples[2].monotonicMs = r.cohorts[0].samples[1].monotonicMs + 199; }],
    ['GC during window', r => { r.cohorts[0].unforcedWindowGcCalls++; }],
    ['profiler during window', r => { r.cohorts[0].profilerOperations.push('HeapProfiler.enable'); }],
    ['diagnostic before resources', r => { r.cohorts[0].diagnostic.sample.monotonicMs = 1; }],
    ['expired root retained', r => { r.cohorts[1].diagnostic.expiredReachable++; }],
    ['useful entry missing', r => { r.cohorts[1].usefulAfter.entries--; }],
    ['both arms lose useful content', r => { for (const arm of r.cohorts) {
      arm.usefulBefore.sha256 = arm.usefulAfter.sha256 = 'a'.repeat(64);
    } }],
    ['useful factory rebuilt', r => { r.cohorts[1].cleanup.finalStats.builds++; }],
    ['unreaped process', r => { r.cohorts[0].reaped = false; }],
    ['descendant omitted', r => { r.cohorts[0].samples[3].descendants.push({ pid: 99 }); }],
    ['cleanup root remains', r => { r.cohorts[0].cleanup.expiredReachable++; }],
  ];
  it.each(corruptions)('rejects corrupted %s expiry evidence', (_name, corrupt) => {
    const r = fixture(); corrupt(r);
    expect(() => auditExpiryResources(r)).toThrow('P011 expiry resources:');
  });
  it('ignores fabricated native and reduction headlines', () => {
    const r: any = fixture(), before = auditExpiryResources(r);
    r.nativeBytes = r.productionSavingsBytes = r.pssSavingsBytes = 1e12;
    expect(auditExpiryResources(r)).toEqual(before);
  });
  it.runIf(Boolean(process.env.PAPERCUSP_P011_EXPIRY_ORACLE_INPUT))(
    'audits the specified saved unforced expiry resource windows', () => {
      const input = process.env.PAPERCUSP_P011_EXPIRY_ORACLE_INPUT!, bytes = readFileSync(resolve(root, input));
      const result = auditExpiryResources(JSON.parse(bytes.toString()));
      const destination = process.env.PAPERCUSP_P011_EXPIRY_ORACLE_REPORT;
      if (!destination) throw Error('Canonical expiry resource oracle report required');
      writeFileSync(resolve(root, destination), serializeIdentitySafeJson({ schemaVersion: 'p011-expiry-resources-independent-v1',
        proof: { path: input, bytes: bytes.length, sha256: digest(bytes), result },
        independentOf: 'No sampler import or headline; raw PID/source/workload/counter phases and independently regenerated useful contents.',
        limitations: ['Private cache evidence only; full P011, live operator, native physical ownership and shipment remain open.',
          'Diagnostic GC and root observations occur after unforced resource phases; unfavorable PSS deltas are retained.'] }));
    });
});

describe('independent P011 baseline raw evidence', () => {
  it.each([false, true])('derives bounded resources from raw rows (sibling=%s)', sibling => {
    const result = auditBaseline(fixture(sibling));
    expect(result.samples).toHaveLength(9);
    expect(result.samples[0].observedPssBytes).toBe(sibling ? 200 : 100);
    expect(result.windows[0].ordinaryAllocatedBytes).toBe(100);
    expect(result.physicalSavings).toBe('unmeasured');
  });
  const corruptions: [string, (r: any) => void][] = [
    ['incomplete', r => { r.incomplete = true; }],
    ['health generation', r => { r.healthAfter.sha = 'ffffffff'; }],
    ['counter artifact', r => { r.counterBundle.diskSha256After = 'f'.repeat(64); }],
    ['sibling generation', r => { r.counterBundle.loadedBuildAfter.serverGeneration = 'replaced'; }],
    ['connection replaced', r => { r.counterBundle.loadedBuildAfter.connectionId = 'reconnected'; }],
    ['socket replaced', r => { r.counterBundle.socketAfter.ino++; }],
    ['PID reuse', r => { r.samples[1].counterOs.startTicks = '99'; }],
    ['ancestry', r => { r.samples[1].descendants[0].parentPid = 99; }],
    ['PSS missing', r => { delete r.samples[1].os.pssBytes; }],
    ['RSS substituted', r => { r.samples[1].os.pssBytes = r.samples[1].os.rssBytes + 1; }],
    ['allocation decreases', r => { r.samples[1].heap.total_allocated_bytes = 1; }],
    ['sample missing', r => { r.samples.pop(); }],
    ['short idle', r => { r.samples[1].at = 2000; }],
    ['ordinary missing', r => { r.requests.pop(); }],
    ['duplicate request', r => { r.requests[1] = structuredClone(r.requests[0]); }],
    ['failed HTTP', r => { r.requests[0].status = 500; }],
    ['forced operation', r => { r.operations.push('gc'); }],
    ['cleanup failure', r => { r.cleanup.inspector.closed = false; }],
    ['wrong runtime role', r => { r.samples[0].hostFacts.sidecarFlags.spawner = false; }],
  ];
  it.each(corruptions)('rejects corrupted %s evidence', (_name, corrupt) => {
    const r = fixture(true); corrupt(r); expect(() => auditBaseline(r)).toThrow('P011 baseline:');
  });
  it('ignores forged inventory totals and reduction headlines', () => {
    const r = fixture(true), before = auditBaseline(r);
    r.reductionPercent = 99;
    for (const s of r.samples) { s.inventory.observedPssBytes = 1; s.configuredHostRole = { allocationOwner: 'proven' }; }
    expect(auditBaseline(r)).toEqual(before);
  });
  it.runIf(Boolean(process.env.PAPERCUSP_P011_BASELINE_ORACLE_INPUTS))('audits frozen scalar or selected-worker reports', () => {
    const paths: string[] = JSON.parse(process.env.PAPERCUSP_P011_BASELINE_ORACLE_INPUTS!);
    expect(paths.length).toBeGreaterThan(0); expect(paths.length).toBeLessThanOrEqual(8);
    expect(new Set(paths).size).toBe(paths.length);
    const proofs = paths.map(path => {
      const bytes = readFileSync(resolve(root, path));
      return { path, sha256: digest(bytes), bytes: bytes.length, result: auditBaseline(JSON.parse(bytes.toString())) };
    });
    const workers = proofs.some(x => x.result.requestWorkerWindows !== undefined);
    if (!workers) expect(proofs.map(x => x.result.target)).toEqual(['main', 'maintained-spawner']);
    for (const proof of proofs) {
      expect(proof.result.mainIdentity).toBe(proofs[0].result.mainIdentity);
      expect(proof.result.buildSha).toBe(proofs[0].result.buildSha);
    }
    const destination = process.env.PAPERCUSP_P011_BASELINE_ORACLE_REPORT;
    if (!destination) throw Error('Canonical oracle report required');
    writeFileSync(resolve(root, destination), serializeIdentitySafeJson({ schemaVersion: 'p011-baseline-independent-v1',
      proofs, independentOf: 'No emitter import or headline totals; raw OS/V8 rows, HTTP records and identity fences.',
      physicalSavings: 'unmeasured', allocationOwner: 'unknown',
      requestAssignment: workers ? 'bounded selected-worker observations' : 'unknown' }));
  });
});

describe('P011 independent request heap evidence', () => {
  const path = 'docs/evidence/papercusp-oct1-p011-request-retainers-r2-2026-10-03.json';
  const saved = () => JSON.parse(readFileSync(resolve(root, path)).toString());
  function registeredFixture() {
    const r = saved();
    for (const rows of [r.heapQueryRegistryBeforeSnapshot.records, r.heapOwnerBinding.queries.records,
      r.heapOwnerBinding.queries.registryBeforeSnapshot.records, r.heapOwnerBinding.queries.registryAfterSnapshot.records])
      for (const row of rows) row.weakPhasePresence = { decodedResult: true, resolvedRows: true, responseValue: true };
    for (const row of r.heapOwnerBinding.queries.records)
      for (const object of row.objects) if (object.status === 'unobserved') object.status = 'collected';
    return r;
  }
  it('audits registered weak phases while preserving collected object gaps and historical scope', () => {
    expect(auditRequestRetainers(saved()).weakPhaseRegistration).toBe('unmeasured');
    const result = auditRequestRetainers(registeredFixture());
    expect(result.weakPhaseRegistration).toBe('observed-complete');
    expect(result.foundQueryObjectIds).toEqual([]);
    expect(result.weakObjectGaps).toHaveLength(48);
    expect(result.weakObjectGaps.every((gap: any) => gap.status === 'collected')).toBe(true);
  });
  it.each(['missing', 'false', 'nonboolean', 'null', 'extra', 'selected-drift', 'identity-extra'] as const)(
    'rejects %s registration or identity evidence', defect => {
      const r = registeredFixture(), before = r.heapQueryRegistryBeforeSnapshot.records[0];
      if (defect === 'missing') delete before.weakPhasePresence;
      if (defect === 'false') before.weakPhasePresence.resolvedRows = false;
      if (defect === 'nonboolean') before.weakPhasePresence.resolvedRows = 'true';
      if (defect === 'null') before.weakPhasePresence = null;
      if (defect === 'extra') before.weakPhasePresence.unmeasured = true;
      if (defect === 'selected-drift') delete r.heapOwnerBinding.queries.records[0].weakPhasePresence;
      if (defect === 'identity-extra') before.unmeasuredIdentity = 'unknown';
      expect(() => auditRequestRetainers(r)).toThrow(/P011 /);
    });
  it.runIf(Boolean(process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_INPUT))(
    'audits the specified saved request heap report without a new resource cohort', () => {
      const input = process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_INPUT!;
      const bytes = readFileSync(resolve(root, input)), result = auditRequestRetainers(JSON.parse(bytes.toString()));
      expect(result.weakPhaseRegistration).toBe('observed-complete');
      const destination = process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_REPORT;
      if (destination) writeFileSync(resolve(root, destination), serializeIdentitySafeJson({
        schemaVersion: 'p011-request-heap-independent-v1',
        proof: { path: input, sha256: digest(bytes), bytes: bytes.length, result },
        independentOf: 'No producer/inspector import; exact raw HTTP/query/weak metadata/graph conservation.',
        limitations: ['Saved private snapshot with forced GC and synchronous write; no new runtime measurement.',
          'Registered WeakRefs do not prove target liveness; collected targets remain explicit gaps.',
          'Worker-clone/native physical ownership, full executed graph, full P011 acceptance and shipment remain open.'],
      }));
    });
  afterAll(() => {
    const input = process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_INPUT;
    const destination = process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_REPORT;
    if (!input || !destination) return;
    // Check the artifact after EVERY writer has run, not just after its own write.
    const artifact = JSON.parse(readFileSync(resolve(root, destination)).toString());
    expect(artifact.proof.path).toBe(input);
    expect(artifact.proof.sha256).toBe(digest(readFileSync(resolve(root, input))));
  });
  it('audits preserved raw weak selection with explicit unobserved response links', () => {
    const result = auditRequestRetainers(saved());
    expect(result.requests.requestCount).toBe(24);
    expect(result.requests.queryCount).toBeGreaterThanOrEqual(24);
    expect(result.owners.owners).toHaveLength(9);
    expect(result.weakObjectGaps.filter((x: any) => x.status === 'unobserved')).toHaveLength(32);
    const destination = !process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_INPUT &&
      process.env.PAPERCUSP_P011_REQUEST_HEAP_ORACLE_REPORT;
    if (destination) {
      const bytes = readFileSync(resolve(root, path));
      writeFileSync(resolve(root, destination), serializeIdentitySafeJson({
        schemaVersion: 'p011-request-heap-independent-v1',
        proof: { path, sha256: digest(bytes), bytes: bytes.length, result },
        independentOf: 'No producer/inspector import; exact raw HTTP/query/weak metadata/graph conservation.',
        limitations: ['Saved private snapshot with forced GC and synchronous write; no new runtime measurement.',
          'Collected targets remain explicit gaps; worker-clone and native physical ownership unobserved.',
          'Producer assertion FAILED on unobserved response links; its harness tag was omitted. This scoped raw audit repairs neither.',
          'Full executed source graph, full P011 acceptance and production savings remain unmeasured.'],
      }));
    }
  });
  it('accepts reordered exact query and weak metadata relations', () => {
    const r = saved(), a = auditRequestRetainers(r);
    r.heapOwnerBinding.queries.records.reverse();
    r.heapOwnerBinding.queries.registryBeforeSnapshot.records.reverse();
    r.heapQueryRegistryBeforeSnapshot.records.reverse();
    r.heapOwnerBinding.queries.registryAfterSnapshot.records.reverse();
    const b = auditRequestRetainers(r);
    expect(b.requests).toEqual(a.requests);
    expect(b.foundQueryObjectIds).toEqual(a.foundQueryObjectIds);
    expect(b.weakObjectGaps).toEqual(a.weakObjectGaps);
    expect(b.missingLiveRegistryTuples).toEqual(a.missingLiveRegistryTuples);
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['wrong mode', r => { r.mode = 'ordinary'; }],
    ['missing snapshot operation', r => { r.profilerOperations.splice(1, 1); }],
    ['post snapshot sample missing', r => { r.samples.pop(); }],
    ['weak selection not frozen', r => { r.heapOwnerBinding.queries.selection = 'current-registry'; }],
    ['unobserved request', r => { r.heapOwnerBinding.queries.unobservedRequestIds.push(r.windows[2].responses[0].requestId); }],
    ['omitted selected tuple', r => { r.heapOwnerBinding.queries.omitted = 1; }],
    ['missing dependency tuple', r => { r.heapOwnerBinding.queries.records.pop(); }],
    ['duplicate selected tuple', r => { r.heapOwnerBinding.queries.records[1] = r.heapOwnerBinding.queries.records[0]; }],
    ['wrong selected process', r => { r.heapOwnerBinding.queries.records[0].source.processInstanceId = '00000000-0000-4000-8000-000000000000'; }],
    ['wrong selected pool', r => { r.heapOwnerBinding.queries.records[0].source.poolInstanceId = '00000000-0000-4000-8000-000000000000'; }],
    ['wrong selected connection', r => { r.heapOwnerBinding.queries.records[0].connectionId++; }],
    ['wrong selected query', r => { r.heapOwnerBinding.queries.records[0].queryId++; }],
    ['wrong selected request', r => { r.heapOwnerBinding.queries.records[0].requestId = r.windows[0].responses[0].requestId; }],
    ['wrong pre capture relation', r => { r.heapQueryRegistryBeforeSnapshot.records[0].queryId++; }],
    ['raw pre capture mismatch conserved in both copies', r => {
      r.heapQueryRegistryBeforeSnapshot.records[0].queryId++;
      r.heapOwnerBinding.queries.registryBeforeSnapshot.records[0].queryId++;
    }],
    ['incomplete post capture registry', r => { r.heapOwnerBinding.queries.registryAfterSnapshot.omittedRows = 1; }],
    ['FIFO counter rewind', r => { r.heapOwnerBinding.queries.registryAfterSnapshot.poolSummaries[0].totalRecorded = 0; }],
    ['wrong object phase', r => { r.heapOwnerBinding.queries.records[0].objects[0].phase = 'workerClone'; }],
    ['ambiguous weak target', r => { r.heapOwnerBinding.queries.records[0].objects[0].status = 'ambiguous'; }],
    ['collected object carries an ID', r => {
      Object.assign(r.heapOwnerBinding.queries.records[0].objects[0], { status: 'collected', id: 10 });
    }],
    ['invalid found ID', r => {
      Object.assign(r.heapOwnerBinding.queries.records[0].objects[0], { status: 'found', id: 0 });
    }],
    ['claimed found ID absent from graph', r => {
      Object.assign(r.heapOwnerBinding.queries.records[0].objects[0], { status: 'found', id: Number.MAX_SAFE_INTEGER });
    }],
    ['missing native requested node', r => { r.heapRetainers.requestedNodes.pop(); }],
    ['wrong native input', r => { r.heapRetainers.native.inputSha256 = '0'.repeat(64); }],
    ['decoder receipt missing', r => { delete r.nativeDecoderPreflight; }],
    ['write timing mismatch', r => { r.heapSnapshotWriteMs++; }],
    ['summary timing missing', r => { delete r.heapSnapshot.summaryMs; }],
    ['summary exceeds combined duration', r => { r.heapSnapshot.summaryMs = r.heapSnapshot.durationMs + 1; }],
  ];
  for (const [name, mutate] of corruptions) it('rejects ' + name, () => {
    const r = saved(); mutate(r); expect(() => auditRequestRetainers(r)).toThrow(/P011 /);
  });
});

describe('P011 independent named HTTP query evidence', () => {
  const path = 'docs/evidence/papercusp-oct1-p011-request-ordinary-r4-2026-10-03.json';
  function savedRequestRun() {
    const bytes = readFileSync(resolve(root, path));
    expect(digest(bytes)).toBe('75d53593c9533426a1c2dbfb4c0f30cc90318a7402b00d0f22d80bf691ebb830');
    return JSON.parse(bytes.toString());
  }
  function changeBoth(r: any, change: (q: any) => void) {
    const projected = r.windows[0].completedPageResults[0];
    const pool = r.samples[4].pools.find((p: any) => p.pool === projected.pool);
    const raw = pool.results.find((q: any) => q.connectionId === projected.connectionId && q.queryId === projected.queryId);
    change(raw); change(projected);
  }
  it('audits saved ordinary request relations without replaying the producer', () => {
    const result = auditRequestQueries(savedRequestRun());
    expect(result.requestCount).toBe(24); expect(result.queryCount).toBe(48);
    expect(result.windows.every((w: any) => w.requests.every((h: any) => h.queries.length === 2))).toBe(true);
    const destination = process.env.PAPERCUSP_P011_REQUEST_ORACLE_REPORT;
    if (destination) {
      const bytes = readFileSync(resolve(root, path));
      writeFileSync(resolve(root, destination), serializeIdentitySafeJson({
        schemaVersion: 'p011-request-query-independent-v1', proof: { path, sha256: digest(bytes), bytes: bytes.length, result },
        independentOf: 'No emitter/helper import; exact UUID and query tuples conserved against terminal raw pool rows.',
        limitations: ['Saved private ordinary process only; no new runtime or snapshot.',
          'No raw snapshot, decoded-object heap IDs, worker-clone identity or retained-owner acceptance.',
          'Build-recorded artifact; full executed source graph and production savings remain unmeasured.'],
      }));
    }
  });
  it('preserves one-to-many joins when request and query completion order is reversed', () => {
    const r = savedRequestRun(), before = auditRequestQueries(r);
    r.namedQuery.results.reverse();
    for (const w of r.windows) { w.responses.reverse(); w.completedPageResults.reverse(); }
    for (const s of r.samples) { s.pools.reverse(); for (const p of s.pools) p.results.reverse(); }
    expect(auditRequestQueries(r)).toEqual(before);
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['incomplete run', r => { r.incomplete = true; }],
    ['wrong evidence plane', r => { r.plane = 'live-current-build-operator-api'; }],
    ['runner failure', r => { r.runner.status = 1; }],
    ['profiler operation', r => { r.profilerOperations.push({ method: 'HeapProfiler.collectGarbage' }); }],
    ['unreaped host', r => { r.hostReaped = false; }],
    ['sample missing', r => { r.samples.pop(); }],
    ['process reuse', r => { r.samples[4].processes[0].startTicks += '1'; }],
    ['duplicate sampled PID', r => { r.samples[4].processes.push(r.samples[4].processes[0]); }],
    ['RSS-only resources', r => { delete r.samples[4].processes[0].pssBytes; }],
    ['negative allocation delta', r => { r.samples[4].heap.total_allocated_bytes = 0; }],
    ['window time substitution', r => { r.windows[0].endAt = r.windows[1].endAt; }],
    ['useful row drift', r => { r.windows[0].responses[0].rowFingerprint = 'e'.repeat(64); }],
    ['missing HTTP UUID', r => { delete r.windows[0].responses[0].requestId; }],
    ['duplicated HTTP UUID', r => { r.windows[0].responses[1].requestId = r.windows[0].responses[0].requestId; }],
    ['cross-window UUID reuse', r => { r.windows[1].responses[0].requestId = r.windows[0].responses[0].requestId; }],
    ['dropped secondary query', r => { r.windows[0].completedPageResults.pop(); }],
    ['duplicated projected query', r => { r.windows[0].completedPageResults[1] = r.windows[0].completedPageResults[0]; }],
    ['count/time-only join', r => { r.windows[0].completedPageResults[0].correlation.requestId = r.windows[0].responses[0].requestId; }],
    ['wrong operation on both sides', r => { changeBoth(r, q => { q.correlation.operation = 'other.byHarness'; }); }],
    ['foreign process on both sides', r => { changeBoth(r, q => { q.correlation.processInstanceId = 'foreign'; }); }],
    ['foreign build on both sides', r => { changeBoth(r, q => { q.correlation.buildSha = 'e'.repeat(10); }); }],
    ['inconsistent source build', r => { changeBoth(r, q => { q.source.buildSha = 'e'.repeat(10); }); }],
    ['pool instance drift', r => { changeBoth(r, q => { q.source.poolInstanceId = '00000000-0000-0000-0000-000000000001'; }); }],
    ['unobserved request on both sides', r => { changeBoth(r, q => { q.correlationState = 'unobserved'; }); }],
    ['failed query on both sides', r => { changeBoth(r, q => { q.status = 'error'; }); }],
    ['query outside window', r => { changeBoth(r, q => { q.recordedAt = Date.parse(r.startedAt); }); }],
    ['query numeric identifier absent', r => { changeBoth(r, q => { delete q.queryId; }); }],
  ];
  it.each(corruptions)('rejects %s', (_name, corrupt) => {
    const r = savedRequestRun(); corrupt(r);
    expect(() => auditRequestQueries(r)).toThrow('P011 request query:');
  });
});

describe('P011 independent cache retained-owner evidence', () => {
  const expected = (r: any) => r.cacheBeforeSnapshot.records.map((row: any) => row.keyDigest);
  function pairFixture(): any {
    const rows = Array.from({ length: 256 }, (_, i) => ({ id: 'p011-' + (i + 1),
      body: ('useful-context-' + (i + 1) + ' ').repeat(32768).slice(0, 32768) }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const hash = createHash('sha256');
    for (const row of rows) hash.update(JSON.stringify([row.id, row.body]));
    const contentHash = hash.digest('hex');
    return { schemaVersion: 2, plane: 'isolated-current-build-operator-api', incomplete: false,
      runner: { status: 0, signal: null }, sources: { before: { source: 'a'.repeat(64) }, after: { source: 'a'.repeat(64) } },
      cohorts: ['baseline', 'shared', 'shared', 'baseline'].map((mode, arm) => {
        const count = mode === 'baseline' ? 8 : 1, heap = cacheHeapFixture(count, false), pid = 7 + arm;
        heap.pid = heap.inspector.pid = heap.heapOwnerBinding.pid = heap.heapSnapshot.pid = heap.heapRetainers.pid = pid;
        const digests: string[] = expected(heap), os = { ...heap.samples[0].processes[0], pid };
        return { arm, mode, pid, identity: { pid, startTicks: os.startTicks }, reaped: true, forcedCleanup: false,
          unreaped: [], pauses: 0, bundleSha256: 'b'.repeat(64), loadedHealth: { sha: '12345678' },
          samples: [1, 2].map(at => ({ at, pid, os: structuredClone(os), phase: at === 2 ? 'completion-idle' : 'before',
            cache: { entries: count, rows: Array(count).fill(256), keyDigests: digests } })),
          content: digests.map(keyDigest => ({ keyDigest, rows: 256, stringCodeUnits: 8388608, sha256: contentHash })),
          cacheHeap: { ...heap, snapshotStartedAt: 3 } };
      }) };
  }
  it('joins each order-reversed host to its own digest, content and captured graph', () => {
    const r = pairFixture(), result = auditInboxCacheRetainers(r);
    expect(result.map((row: any) => row.result.uniquePayloadNodes.length)).toEqual([8, 1, 1, 8]);
    r.cohorts[0].content.reverse();
    expect(auditInboxCacheRetainers(r)).toEqual(result);
  });
  function atomicPairFixture(): any {
    const r = pairFixture();
    for (const c of r.cohorts) {
      c.cacheHeap.heapOwnerBinding.identityBoundary =
        'snapshot and IDs in one target job; synchronous inspector callbacks only';
      c.cacheHeap.profilerOperations = [
        'local HeapProfiler.enable + v8.writeHeapSnapshot + exact IDs in one target job',
        'local Session.disconnect after exact IDs captured',
      ];
    }
    return r;
  }
  it('qualifies atomic snapshot receipts while preserving the historical owner result', () => {
    expect(auditInboxCacheRetainers(atomicPairFixture())).toEqual(auditInboxCacheRetainers(pairFixture()));
  });
  const atomicCorruptions: Array<[string, (heap: any) => void]> = [
    ['missing job boundary', h => { delete h.heapOwnerBinding.identityBoundary; }],
    ['asynchronous job boundary', h => { h.heapOwnerBinding.identityBoundary = 'snapshot and IDs across awaited jobs'; }],
    ['missing file and ID operation', h => { h.profilerOperations.shift(); }],
    ['missing teardown', h => { h.profilerOperations.pop(); }],
    ['teardown before capture', h => { h.profilerOperations.reverse(); }],
    ['duplicate capture', h => { h.profilerOperations.unshift(h.profilerOperations[0]); }],
    ['unrecorded profiler intervention', h => { h.profilerOperations.push('HeapProfiler.collectGarbage'); }],
    ['legacy operations under atomic declaration', h => {
      h.profilerOperations = ['v8.writeHeapSnapshot (forced GC/synchronous pause)',
        'HeapProfiler.enable (object IDs)', 'HeapProfiler.disable (object IDs)'];
    }],
    ['missing snapshot cleanup', h => { h.snapshotRemoved = false; }],
    ['missing useful output after snapshot', h => { h.postSnapshotRowsPreserved = false; }],
  ];
  it.each(atomicCorruptions)('rejects %s in atomic cache graph evidence', (_name, corrupt) => {
    const r = atomicPairFixture(); corrupt(r.cohorts[0].cacheHeap);
    expect(() => auditInboxCacheRetainers(r)).toThrow('qualified intervention and cleanup');
  });
  it.each(['foreign-host', 'source-drift', 'before-windows', 'content-drift', 'digest-drift', 'forced-cleanup'])(
    'rejects %s paired cache graph evidence', defect => {
      const r = pairFixture(), c = r.cohorts[0];
      if (defect === 'foreign-host') c.cacheHeap.heapSnapshot.pid++;
      if (defect === 'source-drift') r.sources.after.source = 'f'.repeat(64);
      if (defect === 'before-windows') c.cacheHeap.snapshotStartedAt = 1;
      if (defect === 'content-drift') c.content[0].sha256 = 'f'.repeat(64);
      if (defect === 'digest-drift') c.samples.at(-1).cache.keyDigests = ['f'.repeat(64)];
      if (defect === 'forced-cleanup') c.forcedCleanup = true;
      expect(() => auditInboxCacheRetainers(r)).toThrow(/P011 /);
    });
  it('deduplicates shared payload nodes while preserving both entry identities and relations', () => {
    const r = cacheHeapFixture(), result = auditCacheRetainers(r, expected(r));
    expect(result.relations.map((row: any) => row.status)).toEqual(['observed-direct-property', 'observed-direct-property']);
    expect(result.uniquePayloadNodes).toHaveLength(1);
    expect(result.aliasGroups[0].keyDigests).toHaveLength(2);
    expect(result).not.toHaveProperty('totalRetainedBytes');
    expect(result.physicalSavings).toBe('unmeasured');
    r.heapRetainers.requestedNodes.reverse(); r.heapOwnerBinding.cacheEntries.records.reverse();
    expect(auditCacheRetainers(r, expected(r))).toEqual(result);
  });
  it('preserves changed membership as two gaps rather than zero-byte retained objects', () => {
    const r = cacheHeapFixture(), q = r.heapOwnerBinding.cacheEntries;
    q.status = 'partial'; q.records[0].status = 'evicted';
    q.records[0].objects = ['entry', 'value'].map(phase => ({ phase, status: 'evicted' }));
    r.heapRetainers.requestedNodes = r.heapRetainers.requestedNodes.filter((row: any) => row.id !== 30);
    r.heapRetainers.limits.objectIds = r.heapRetainers.requestedNodes.map((row: any) => row.id);
    expect(auditCacheRetainers(r, expected(r)).gaps).toHaveLength(2);
  });
  it('keeps an incomplete incoming-edge census explicit', () => {
    const r = cacheHeapFixture(), n = r.heapRetainers.requestedNodes.find((row: any) => row.id === 80).node;
    n.retainers.pop(); n.retainersTruncated = true;
    const result = auditCacheRetainers(r, expected(r));
    expect(result.relations.some((row: any) => row.status === 'unobserved-truncated-parents')).toBe(true);
    expect(result.uniquePayloadNodes[0]?.directParentsNotChecked).toBe(1);
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['digest omitted', r => { r.heapOwnerBinding.cacheEntries.records.pop(); }],
    ['digest duplicated', r => { r.heapOwnerBinding.cacheEntries.records[1].keyDigest = r.heapOwnerBinding.cacheEntries.records[0].keyDigest; }],
    ['foreign digest', r => { r.heapOwnerBinding.cacheEntries.records[0].keyDigest = 'f'.repeat(64); }],
    ['wrong owner', r => { r.heapOwnerBinding.cacheEntries.owner = 'foreign'; }],
    ['wrong path', r => { r.heapOwnerBinding.cacheEntries.path = 'cache.other'; }],
    ['incomplete scan', r => { r.cacheBeforeSnapshot.scanComplete = false; }],
    ['undigestible key', r => { r.cacheBeforeSnapshot.undigestibleKeys++; }],
    ['scan limit', r => { r.cacheBeforeSnapshot.limits.maxScanned++; }],
    ['pre-snapshot unsafe entry', r => { r.cacheBeforeSnapshot.records[0].status = 'accessor-skipped'; }],
    ['population drift', r => { r.heapOwnerBinding.cacheEntries.population++; r.heapOwnerBinding.cacheEntries.scanned++; }],
    ['missing value phase', r => { r.heapOwnerBinding.cacheEntries.records[0].objects.pop(); }],
    ['reversed phases', r => { r.heapOwnerBinding.cacheEntries.records[0].objects.reverse(); }],
    ['raw key leak', r => { r.heapOwnerBinding.cacheEntries.records[0].rawKey = 'private'; }],
    ['remote handle leak', r => { r.heapOwnerBinding.cacheEntries.records[0].objects[0].objectId = 'handle'; }],
    ['unsafe ID', r => { r.heapOwnerBinding.cacheEntries.records[0].objects[0].id = Number.MAX_SAFE_INTEGER + 1; }],
    ['gap with retained ID', r => { r.heapOwnerBinding.cacheEntries.records[0].objects[0].status = 'collected'; }],
    ['changed entry with stale IDs', r => { r.heapOwnerBinding.cacheEntries.records[0].status = 'entry-changed'; }],
    ['false complete claim', r => { r.heapOwnerBinding.cacheEntries.status = 'partial'; }],
    ['native node omitted', r => { r.heapRetainers.requestedNodes.pop(); }],
    ['duplicate native ID', r => { r.heapRetainers.limits.objectIds.push(80); }],
    ['foreign snapshot', r => { r.heapRetainers.native.inputSha256 = 'f'.repeat(64); }],
    ['wrong adapter', r => { r.nativeAdapterPreflight.sha256 = 'f'.repeat(64); }],
    ['decoder absent', r => { delete r.nativeDecoderPreflight; }],
    ['combined timing substituted', r => { r.heapSnapshot.durationMs = 1; }],
    ['entry edge omitted without truncation', r => { const n = r.heapRetainers.requestedNodes.find((row: any) => row.id === 80).node; n.retainers.pop(); n.retainerCount--; }],
    ['constructor-only edge join', r => { r.heapRetainers.requestedNodes.find((row: any) => row.id === 80).node.retainers[0].id++; }],
    ['weak entry edge', r => { r.heapRetainers.requestedNodes.find((row: any) => row.id === 80).node.retainers[0].edgeType = 'Weak'; }],
  ];
  it.each(corruptions)('rejects corrupted %s cache evidence', (_name, corrupt) => {
    const r = cacheHeapFixture(); corrupt(r);
    expect(() => auditCacheRetainers(r, expected(r))).toThrow(/P011 /);
  });
  it('ignores retained/native/reduction headlines and keeps distinct payloads distinct', () => {
    const r = cacheHeapFixture(2, false), before = auditCacheRetainers(r, expected(r));
    r.totalRetainedBytes = r.nativePhysicalSavings = 999999;
    r.heapRetainers.groups = [{ retainedSizeBytes: 999999 }];
    expect(auditCacheRetainers(r, expected(r))).toEqual(before);
    expect(before.uniquePayloadNodes).toHaveLength(2);
  });
  it('rejects the preserved incomplete inbox cohort with live membership but missing snapshot IDs', () => {
    const path = 'docs/evidence/papercusp-oct5-p011-inbox-cache-retainers-r1-2026-10-05.json';
    const bytes = readFileSync(resolve(root, path));
    expect(digest(bytes)).toBe('0b1f180bb4239f3dab4826c12f3675211cb3c1a2f7b0ff246841b38d97484ab6');
    const r = JSON.parse(bytes.toString()), binding = r.cohorts[2].cacheHeap.heapOwnerBinding;
    expect(r.cohorts).toHaveLength(3);
    expect(binding.roots[0].status).toBe('not-in-snapshot');
    expect(binding.cacheEntries.records[0].status).toBe('selected');
    expect(binding.cacheEntries.records[0].objects.map((object: any) => object.status))
      .toEqual(['not-in-snapshot', 'not-in-snapshot']);
    expect(() => auditInboxCacheRetainers(r)).toThrow('cache paired run');
  });
  it.runIf(Boolean(process.env.PAPERCUSP_P011_INBOX_HEAP_ORACLE_INPUT))('audits the specified saved inbox cache graphs', () => {
    const input = process.env.PAPERCUSP_P011_INBOX_HEAP_ORACLE_INPUT!;
    const bytes = readFileSync(resolve(root, input)), result = auditInboxCacheRetainers(JSON.parse(bytes.toString()));
    const destination = process.env.PAPERCUSP_P011_INBOX_HEAP_ORACLE_REPORT;
    if (!destination) throw Error('Canonical inbox cache oracle report required');
    writeFileSync(resolve(root, destination), serializeIdentitySafeJson({ schemaVersion: 'p011-inbox-cache-heap-independent-v1',
      proof: { path: input, bytes: bytes.length, sha256: digest(bytes), result },
      independentOf: 'No producer or inspector import; raw digest/content/process/snapshot/native-node correspondence.',
      limitations: ['Snapshots forced GC after resource windows; selected V8 nodes may have overlapping dominator subtrees.',
        'Native physical ownership, worker clones, full executed graph, full P011 acceptance and shipment remain open.'] }));
    // Verify only an artifact this assertion actually produced. A rejected raw
    // graph keeps its primary error instead of a second ENOENT in afterAll.
    const report = JSON.parse(readFileSync(resolve(root, destination)).toString());
    expect(report.schemaVersion).toBe('p011-inbox-cache-heap-independent-v1');
    expect(report.proof.path).toBe(input);
    expect(report.proof.sha256).toBe(digest(readFileSync(resolve(root, input))));
  });
});

describe('P011 independent exact singleton retained-owner evidence', () => {
  it('joins numeric object IDs rather than constructor labels or array position', () => {
    const r = ownerFixture(), before = auditExactOwners(r);
    r.heapRetainers.requestedNodes.reverse();
    expect(auditExactOwners(r)).toEqual(before);
    expect(before.owners).toHaveLength(9);
    expect(before.nativePhysicalOwnership).toBe('unknown');
    expect(before.loadedBuildIdentity).toBe('unknown');
  });
  const corruptions: Array<[string, (r: any) => void]> = [
    ['foreign plane', r => { r.plane = 'live-current-build-operator-api'; }],
    ['binding PID', r => { r.heapOwnerBinding.pid++; }],
    ['snapshot PID', r => { r.heapSnapshot.pid++; }],
    ['graph PID', r => { r.heapRetainers.pid++; }],
    ['process reuse', r => { r.samples[1].processes[0].startTicks = '11'; }],
    ['duplicate sampled PID', r => { r.samples[0].processes.push(r.samples[0].processes[0]); }],
    ['RSS without PSS', r => { delete r.samples[0].processes[0].pssBytes; }],
    ['snapshot hash', r => { r.heapRetainers.native.inputSha256 = 'e'.repeat(64); }],
    ['snapshot bytes', r => { r.heapRetainers.native.inputBytes++; }],
    ['adapter bytes', r => { r.nativeAdapterPreflight.sha256 = 'e'.repeat(64); }],
    ['native failure', r => { r.heapRetainers.native.status = 1; }],
    ['unknown upstream', r => { r.heapRetainers.upstreamRevision = 'unknown'; }],
    ['missing owner', r => { r.heapOwnerBinding.roots.pop(); }],
    ['duplicate owner name', r => { r.heapOwnerBinding.roots[1].owner = r.heapOwnerBinding.roots[0].owner; }],
    ['missing captured ID', r => { r.heapOwnerBinding.roots[0].status = 'not-in-snapshot'; }],
    ['duplicate captured ID', r => { r.heapOwnerBinding.roots[1].id = r.heapOwnerBinding.roots[0].id; }],
    ['wrong requested IDs', r => { r.heapRetainers.limits.objectIds[0]++; }],
    ['missing requested node', r => { r.heapRetainers.requestedNodes.pop(); }],
    ['duplicate requested node', r => { r.heapRetainers.requestedNodes[1] = r.heapRetainers.requestedNodes[0]; }],
    ['constructor-only join', r => { r.heapRetainers.requestedNodes[0].node.id++; }],
    ['duplicate graph index', r => { r.heapRetainers.requestedNodes[1].node.index = 1; }],
    ['out-of-range index', r => { r.heapRetainers.requestedNodes[0].node.index = 32; }],
    ['unsafe bytes', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = Number.MAX_SAFE_INTEGER + 1; }],
    ['retained below self', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = 1; }],
    ['retained above snapshot', r => { r.heapRetainers.requestedNodes[0].node.retainedSizeBytes = 2048; }],
    ['wrong incoming target', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].retainsIndex++; }],
    ['weak edge', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].edgeType = 'Weak'; }],
    ['root parent', r => { r.heapRetainers.requestedNodes[0].node.retainers[0].index = 0; }],
    ['duplicate incoming parent', r => { const n = r.heapRetainers.requestedNodes[0].node; n.retainers.push(n.retainers[0]); n.retainerCount++; }],
    ['hidden truncated parents', r => { r.heapRetainers.requestedNodes[0].node.retainerCount++; }],
    ['snapshot left behind', r => { r.snapshotRemoved = false; }],
    ['useful rows changed', r => { r.postSnapshotRowsPreserved = false; }],
    ['profiler intervention omitted', r => { r.profilerOperations = []; }],
  ];
  it.each(corruptions)('rejects corrupted %s evidence', (_name, corrupt) => {
    const r = ownerFixture(); corrupt(r);
    expect(() => auditExactOwners(r)).toThrow('P011 exact owner:');
  });
  it('does not sum shared parents or trust retained/native total headlines', () => {
    const r = ownerFixture(), before = auditExactOwners(r);
    r.nativeBytes = 999999; r.heapRetainers.retainedSizeBytes = 999999;
    r.heapRetainers.groups = [{ class: 'Object', retainedSizeBytes: 999999 }];
    expect(auditExactOwners(r)).toEqual(before);
    expect(before).not.toHaveProperty('totalRetainedBytes');
    expect(before.owners.every((x: any) => x.observedDirectParentIndexes[0] === 20)).toBe(true);
  });
  it('preserves an explicitly bounded incomplete direct-parent census', () => {
    const r = ownerFixture(), n = r.heapRetainers.requestedNodes[0].node;
    n.retainerCount = 2; n.retainersTruncated = true;
    expect(auditExactOwners(r).owners[0].directParentsNotChecked).toBe(1);
  });
  it('audits the tracked historical exact-owner artifact without replaying its producer', () => {
    const path = 'docs/evidence/papercusp-oct1-p011-exact-owner-retainers-r1-2026-10-02.json';
    const bytes = readFileSync(resolve(root, path));
    expect(digest(bytes)).toBe('283cd13234d20676fc29a85bf883c21b607f099da449c404ca3c1ece7f4bd235');
    const result = auditExactOwners(JSON.parse(bytes.toString()));
    expect(result.owners.map((x: any) => x.owner)).toEqual(exactOwners);
    expect(result.owners.find((x: any) => x.owner.endsWith('.operatorCache'))?.dominatorRetainedV8Bytes).toBe(1328);
    const destination = process.env.PAPERCUSP_P011_OWNER_ORACLE_REPORT;
    if (destination) writeFileSync(resolve(root, destination), serializeIdentitySafeJson({
      schemaVersion: 'p011-exact-owner-independent-v1',
      proof: { path, sha256: digest(bytes), bytes: bytes.length, result },
      independentOf: 'No producer import, constructor-label join or class/parent aggregate retained total.',
      limitations: ['Saved private snapshot forced GC and pause; no new live acceptance.',
        'Exact singleton IDs identify graph nodes, not historical PostgreSQL initiating calls.',
        'Dominator-owned V8 bytes do not establish native physical allocation or production savings.'],
    }));
  });
});
