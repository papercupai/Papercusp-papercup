import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessDurableHeadroomTargets, measureDurableHeadroomTargets, assessDiskHeadroomSoak, measureDiskHeadroomSoakWindow, readDiskHeadroomSoakEvidence, assessQualifiedDerivativeReceipts, assessRetainedStorageInterval, assessRetainedStorageSamples, assessPostgresRetentionEvidence, measurePostgresRetentionEvidence } from './retention-interval-evidence';

describe('native R-8 Postgres retention binding', () => {
  const measuredAt = '2026-10-17T00:01:00.000Z';
  const base = () => ({
    workspaceId: 'workspace', host: 'fixture-host', measuredAt,
    routine: { schemaVersion: 1 as const, kind: 'telemetry-retention-completion' as const,
      workspaceId: 'workspace', host: 'fixture-host', workflowId: 'routine-workflow', routineId: 'routine-id',
      startedAt: '2026-10-16T23:59:00.000Z', finishedAt: '2026-10-17T00:00:00.000Z',
      completedAt: '2026-10-17T00:00:01.000Z', dryRun: false, tableRetentionComplete: true,
      targets: ['route-invocations', 'tool-invocations', 'harness-run-output', 'agent-activity', 'memory-recall-query-text']
        .map(category => ({ category, complete: true, retentionDays: category === 'memory-recall-query-text' ? 3 : 30 })) },
    ages: [
      { category: 'route-invocations', oldestAgeDays: 29, measured: true },
      { category: 'tool-invocations', oldestAgeDays: 29, measured: true },
      { category: 'harness-run-output', oldestAgeDays: 29, measured: true },
      { category: 'agent-activity', oldestAgeDays: 29, measured: true },
      { category: 'memory-recall-query-text', oldestAgeDays: 2, measured: true },
    ],
    coldIntegrity: { verdict: 'pass' as const, detail: 'dual compressed cold archives verified' },
    servingRuntimes: [{ runtime: 'release-operator', applicable: true, containsColdFallback: true }],
  });
  it('requires the production receipt, bounded ages, cold bytes and serving fallback together', () => {
    expect(assessPostgresRetentionEvidence(base()).verdict).toBe('pass');
    const stale = base(); stale.ages[1]!.oldestAgeDays = 31;
    expect(assessPostgresRetentionEvidence(stale).verdict).toBe('fail');
    expect(assessPostgresRetentionEvidence({ ...base(), routine: null }).verdict).toBe('unknown');
    const unbound = base(); Object.assign(unbound.servingRuntimes[0]!, { containsColdFallback: null });
    expect(assessPostgresRetentionEvidence(unbound).verdict).toBe('unknown');
  });
  it.each(['stale', 'future', 'reversed', 'ledger-before-finish', 'dry-run', 'foreign-host', 'foreign-workspace'])(
    'rejects a %s routine receipt despite healthy current tables', kind => {
      const input = base(), receipt = input.routine;
      if (kind === 'stale') input.measuredAt = '2026-10-18T00:00:01.001Z';
      if (kind === 'future') input.measuredAt = '2026-10-16T23:59:59.000Z';
      if (kind === 'reversed') receipt.startedAt = '2026-10-17T00:00:02.000Z';
      if (kind === 'ledger-before-finish') receipt.completedAt = '2026-10-16T23:59:59.000Z';
      if (kind === 'dry-run') receipt.dryRun = true;
      if (kind === 'foreign-host') receipt.host = 'other-host';
      if (kind === 'foreign-workspace') receipt.workspaceId = 'other-workspace';
      expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
    });
  it('accepts the daily freshness boundary and measures freshness from native finish, not delayed ledger persistence', () => {
    const input = base(); input.measuredAt = '2026-10-18T00:00:00.000Z';
    expect(assessPostgresRetentionEvidence(input).verdict).toBe('pass');
    input.measuredAt = '2026-10-18T00:00:00.001Z';
    expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
  });
  it.each(['subset', 'duplicate', 'extra', 'wrong-horizon', 'incomplete'])(
    'rejects %s target coverage', kind => {
      const input = base(), targets = input.routine.targets;
      if (kind === 'subset') targets.pop();
      if (kind === 'duplicate') targets[4] = { ...targets[0]! };
      if (kind === 'extra') targets.push({ category: 'unrelated', retentionDays: 30, complete: true });
      if (kind === 'wrong-horizon') targets[0]!.retentionDays = 90;
      if (kind === 'incomplete') targets[0]!.complete = false;
      expect(assessPostgresRetentionEvidence(input).verdict).toBe('fail');
    });
  it.each([NaN, Infinity, -Infinity, -1, undefined, ''])('rejects malformed measured age %s', age => {
    const input = base(); Object.assign(input.ages[0]!, { oldestAgeDays: age });
    expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
  });
  it('rejects duplicated age observations and accepts explicit measured empty tables', () => {
    const input = base(); input.ages.push({ ...input.ages[0]! });
    expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
    expect(assessPostgresRetentionEvidence({ ...base(), ages: base().ages.map(a => ({ ...a, oldestAgeDays: null })) }).verdict).toBe('pass');
  });
  it.each([undefined, 'true', 1])('requires an explicit boolean serving binding, not %s', binding => {
    const input = base(); Object.assign(input.servingRuntimes[0]!, { containsColdFallback: binding });
    expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
  });
  it.each(['completedAt', 'startedAt', 'finishedAt', 'dryRun', 'host', 'workspaceId', 'schemaVersion', 'kind'])(
    'cannot certify missing or malformed receipt field %s', field => {
      const input = base(); Object.assign(input.routine, { [field]: undefined });
      expect(assessPostgresRetentionEvidence(input).verdict).not.toBe('pass');
    });

  afterEach(() => vi.useRealTimers());
  const native = (options: { wrap?: boolean; receipt?: unknown; rows?: unknown[]; age?: unknown; ledger?: unknown; workflow?: string } = {}) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(measuredAt));
    const receipt = options.receipt === undefined ? base().routine : options.receipt;
    const output = options.wrap ? { json: { diagnostics: { retention: receipt } } } : { diagnostics: { retention: receipt } };
    const unsafe = vi.fn(async (query: string) => query.includes('dbos.operation_outputs')
      ? [{ output: typeof receipt === 'string' ? receipt : JSON.stringify(output),
        workflow_uuid: options.workflow ?? 'routine-workflow',
        completed_at_epoch_ms: options.ledger === undefined ? String(Date.parse(base().routine.completedAt)) : options.ledger }]
      : options.rows ?? [{ oldest_age_days: options.age === undefined ? '2' : options.age, total_rows: '1', dated_rows: '1' }]);
    return { unsafe, measure: () => measurePostgresRetentionEvidence({ unsafe } as never, {
      workspaceId: 'workspace', host: 'fixture-host', coldIntegrity: base().coldIntegrity, servingRuntimes: base().servingRuntimes,
    }) };
  };
  it.each([false, true])('binds native receipt provenance and PostgreSQL numeric ages (wrapped=%s)', async wrap => {
    const { unsafe, measure } = native({ wrap });
    expect((await measure()).verdict).toBe('pass');
    const [query, params] = unsafe.mock.calls.find(call => call[0].includes('dbos.operation_outputs'))! as unknown as [string, string[]];
    expect(query).toContain('workspaceId'); expect(query).toContain('host');
    expect(params).toEqual(['workspace', 'fixture-host']);
    const epochQuery = unsafe.mock.calls.find(call => call[0].includes('FROM harness_shared.harness_run_output'))![0];
    expect(epochQuery).toContain('to_timestamp'); expect(epochQuery).toContain('1000.0');
  });
  it.each(['{bad json', null, [], { tableRetentionComplete: true, targets: [] }])(
    'keeps malformed native output unknown without throwing (%j)', async receipt => {
      expect((await native({ receipt }).measure()).verdict).toBe('unknown');
    });
  it.each(['', 'NaN', 'Infinity', '-1', true, {}, '0x10'])('does not coerce malformed SQL age %j into passing evidence', async age => {
    expect((await native({ age }).measure()).verdict).not.toBe('pass');
  });
  it.each([{ rows: [] }, { rows: [{}] }, { rows: [{ oldest_age_days: null, total_rows: '2', dated_rows: '0' }] }])(
    'distinguishes an empty table from missing aggregate or undated rows ($rows)', async ({ rows }) => {
      expect((await native({ rows }).measure()).verdict).toBe('unknown');
    });
  it('accepts an explicitly empty native table', async () => {
    expect((await native({ rows: [{ oldest_age_days: null, total_rows: '0', dated_rows: '0' }] }).measure()).verdict).toBe('pass');
  });
  it.each(['bad', null, 0])('rejects malformed DBOS completion time %j without throwing', async ledger => {
    expect((await native({ ledger }).measure()).verdict).toBe('unknown');
  });
  it('does not detach receipt identity from the DBOS workflow', async () => {
    expect((await native({ workflow: 'other-workflow' }).measure()).verdict).not.toBe('pass');
  });
});

describe('durable R-10 exact headroom targets', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10) + h * 3_600_000).toISOString();
  const window = { host: 'fixture-host', windowStart: at(0), windowEnd: at(72), measuredAt: at(73) };
  const fixture = () => ({
    censuses: Array.from({ length: 72 }, (_, h) => ['/', '/mnt/data'].map(path => ({
      id: `${path}-${h}`, host: window.host, path, at: at(h + 0.5), complete: true,
      availableBytes: path === '/' ? 400 * 1000 ** 3 : 2 * 1000 ** 4,
    }))).flat(),
    attempts: Array.from({ length: 72 }, (_, h) => ({ id: `run-${h}`, host: window.host, startedAt: at(h + 0.2) })),
    receipts: Array.from({ length: 72 }, (_, h) => ({ id: `run-${h}`, host: window.host, startedAt: at(h + 0.2),
      finishedAt: at(h + 0.3), dryRun: false as const, complete: true, policyExhausted: true,
      errors: [] as string[], entries: [] as Array<{ status: string }>, delegates: [] as Array<{ ok: boolean }> })),
    dispositions: { supersededPlan: 'disk-headroom-standing-reclaim-2026-10-12', successorPlan: 'disk-durable-headroom-2026-10-15',
      planTerminal: true, linkedSuccessor: true, siblingId: 'WI-10007751', siblingTerminal: true },
  });
  it('accepts the exact decimal-byte floors for every hour and complete native run', () => {
    expect(assessDurableHeadroomTargets(fixture(), window).verdict).toBe('pass');
  });
  it.each(['healthy', 'floor-dip', 'incomplete-run'])(
    'keeps unset predecessor linkage unknown without hiding independent evidence (%s)', mode => {
      const original = fixture();
      const input = { ...original, dispositions: { ...original.dispositions, linkedSuccessor: null } };
      if (mode === 'floor-dip') input.censuses[0]!.availableBytes--;
      if (mode === 'incomplete-run') input.receipts[0]!.complete = false;
      const result = assessDurableHeadroomTargets(input, window);
      expect(result.verdict).toBe(mode === 'healthy' ? 'unknown' : 'fail');
      expect(result.checks).toContainEqual(expect.objectContaining({ id: 'superseded-disposition', status: 'unknown' }));
      expect(result.checks.some(check => check.id === 'exact-target:/')).toBe(true);
    });
  it.each(['/', '/mnt/data'])('fails a one-byte middle dip on %s even with healthy endpoints', path => {
    const input = fixture(); input.censuses.find(r => r.path === path && r.id.endsWith('-30'))!.availableBytes--;
    expect(assessDurableHeadroomTargets(input, window).verdict).toBe('fail');
  });
  it('requires full hourly coverage, not the weaker native six-hour policy cadence', () => {
    const input = fixture(); input.censuses = input.censuses.filter(r => r.id !== '/-35');
    expect(assessDurableHeadroomTargets(input, window).verdict).toBe('unknown');
    input.censuses = input.censuses.filter((_, i) => i % 6 === 0);
    expect(assessDurableHeadroomTargets(input, window).verdict).toBe('unknown');
  });
  it('detects incomplete, errored, failed-delegate and non-exhausted receipts', () => {
    for (const change of [{ complete: false }, { errors: ['blocked'] }, { delegates: [{ ok: false }] },
      { entries: [{ status: 'failed' }] }, { policyExhausted: false }]) {
      const input = fixture(); Object.assign(input.receipts[30]!, change);
      expect(assessDurableHeadroomTargets(input, window).verdict).toBe('fail');
    }
  });
  it('keeps vanished or silent runs, missing dispositions and hostless/foreign evidence unknown', () => {
    const missing = fixture(); missing.receipts.splice(30, 1);
    expect(assessDurableHeadroomTargets(missing, window).verdict).toBe('unknown');
    const silent = fixture(); silent.attempts.splice(30, 1); silent.receipts.splice(30, 1);
    expect(assessDurableHeadroomTargets(silent, window).verdict).toBe('unknown');
    const stale = fixture(); stale.dispositions.linkedSuccessor = false;
    expect(assessDurableHeadroomTargets(stale, window).verdict).toBe('unknown');
    for (const host of ['', 'remote']) {
      const foreign = fixture(); foreign.receipts[0]!.host = host;
      expect(assessDurableHeadroomTargets(foreign, window).verdict).toBe('unknown');
    }
  });
  it('does not count duplicate/unsorted samples or borrow future evidence for unfinished windows', () => {
    const duplicate = fixture(); duplicate.censuses.push(duplicate.censuses[0]!);
    expect(assessDurableHeadroomTargets(duplicate, window).verdict).toBe('fail');
    expect(assessDurableHeadroomTargets(fixture(), { ...window, measuredAt: at(71) }).verdict).toBe('unknown');
  });
  it('reads exact native populations and scopes every shared ledger', async () => {
    const unsafe = vi.fn().mockResolvedValue([fixture()]);
    expect((await measureDurableHeadroomTargets({ unsafe } as never, { ...window, workspaceId: 'workspace', harnessSlug: 'harness' })).verdict).toBe('pass');
    expect(unsafe.mock.calls[0]![0]).toContain("actor='system:disk-retention'");
    expect(unsafe.mock.calls[0]![0]).toContain("action IN ('disk-retention:started','disk-retention:receipt')");
    expect(unsafe.mock.calls[0]![1]).toEqual([window.host, at(0), at(72), 'workspace', Date.parse(at(0)), expect.any(Number), 'harness']);
  });
});

const GIB = 1024 ** 3;
describe('disk headroom post-shipment soak assessment', () => {
  const at = (hours: number) => new Date(Date.parse('2026-10-14T00:00:00Z') + hours * 3_600_000).toISOString();
  const requirements = { host: 'fixture-host', artifactRef: 'fixture-shipped-artifact', shippedAt: at(0),
    startAt: at(1), measuredAt: at(73), maxSampleGapMs: 3_600_000, maxAlarmGapMs: 3_600_000 };
  const fixture = () => ({
    censuses: Array.from({ length: 73 }, (_, hour) => ['/', '/mnt/data'].map((path) => ({
      id: `${path}-${hour}`, host: 'fixture-host', path: path as '/' | '/mnt/data', at: at(hour + 1),
      availableBytes: 100 * GIB, complete: true,
    }))).flat(),
    alarms: [] as Array<{ id: string; host: string; at: string; consumers: Record<string, string[]> }>,
  });
  it('accepts a full healthy window and accounts for every emitted check', () => {
    const result = assessDiskHeadroomSoak(fixture(), requirements);
    expect(result.soakStatus).toBe('pass');
    expect([...result.coverage.checked, ...result.coverage.notChecked].sort()).toEqual([...result.coverage.population].sort());
    expect(result.scope).toContain('capacity between samples remains unmeasured');
  });
  it('keeps unfinished, empty or one-device windows unknown', () => {
    expect(assessDiskHeadroomSoak(fixture(), { ...requirements, measuredAt: at(72) }).soakStatus).toBe('unknown');
    expect(assessDiskHeadroomSoak({ censuses: [], alarms: [] }, requirements).soakStatus).toBe('unknown');
    const input = fixture(); input.censuses = input.censuses.filter((x) => x.path === '/');
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('unknown');
  });
  it('detects an unalarmed middle dip despite healthy endpoints', () => {
    const input = fixture(); input.censuses[50]!.availableBytes = 99 * GIB;
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('fail');
    input.alarms.push({ id: 'alarm', host: 'fixture-host', at: input.censuses[50]!.at,
      consumers: { '/': ['postgres'], '/mnt/data': ['scratch'] } });
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('pass');
    input.alarms[0]!.at = at(1);
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('fail');
  });
  it('fails an unnamed alarm even when all samples are healthy', () => {
    const input = fixture(); input.alarms.push({ id: 'unnamed', host: 'fixture-host', at: at(12), consumers: { '/': ['postgres'] } });
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('fail');
  });
  it('does not accept missing samples, incomplete reads or duplicate records', () => {
    const input = fixture(); input.censuses.splice(50, 2);
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('fail');
    const incomplete = fixture(); incomplete.censuses[50]!.complete = false;
    expect(assessDiskHeadroomSoak(incomplete, requirements).soakStatus).toBe('unknown');
    const duplicate = fixture(); duplicate.censuses.push(duplicate.censuses[0]!);
    expect(assessDiskHeadroomSoak(duplicate, requirements).soakStatus).toBe('fail');
  });
  it('rejects pre-shipment-only evidence, foreign hosts and fabricated future samples', () => {
    expect(assessDiskHeadroomSoak(fixture(), { ...requirements, shippedAt: at(2) }).soakStatus).toBe('unknown');
    const foreign = fixture(); foreign.censuses[0]!.host = 'other-host';
    expect(assessDiskHeadroomSoak(foreign, requirements).soakStatus).toBe('unknown');
    const future = fixture(); future.censuses[0]!.at = at(74);
    expect(assessDiskHeadroomSoak(future, requirements).soakStatus).toBe('unknown');
  });
  it('keeps hostless historical alarms unknown rather than assigning them to the target host', () => {
    const input = fixture();
    input.alarms.push({ id: 'legacy', host: null as unknown as string, at: at(12), consumers: { '/': ['postgres'], '/mnt/data': ['scratch'] } });
    expect(assessDiskHeadroomSoak(input, requirements).soakStatus).toBe('unknown');
  });
  it('reads one bounded native snapshot and exposes a census cap hit', async () => {
    const input = fixture();
    const unsafe = vi.fn(async () => [input]);
    const result = await readDiskHeadroomSoakEvidence({ unsafe } as unknown as Pick<import('postgres').Sql, 'unsafe'>, 'fixture-workspace', requirements);
    expect(result.assessment.soakStatus).toBe('pass');
    const [query, parameters] = unsafe.mock.calls[0]! as unknown as [string, string[]];
    expect(query).toContain('WITH censuses');
    expect(query).toContain('workspace_id = $4');
    expect(query).toContain("data->>'host' IS NULL");
    expect(parameters).toEqual(['fixture-host', at(0), at(73), 'fixture-workspace', at(1), at(73)]);
    input.censuses = Array.from({ length: 20_001 }, () => input.censuses[0]!);
    expect((await readDiskHeadroomSoakEvidence({ unsafe } as unknown as Pick<import('postgres').Sql, 'unsafe'>, 'fixture-workspace', requirements)).assessment.soakStatus).toBe('unknown');
  });
});
describe('native shipment provenance for the disk soak instrument', () => {
  const at = (hours: number) => new Date(Date.parse('2026-10-10T00:00:00Z') + hours * 3_600_000).toISOString();
  const request = { workspaceId: 'workspace', installSlug: 'install', host: 'fixture-host', deploymentId: '42',
    windowStart: at(1), windowEnd: at(73), measuredAt: at(74) };
  const shipment = { id: '42', host: 'fixture-host:3070#123', artifactRef: 'a'.repeat(40), shippedAt: at(0) };
  const records = () => ({ censuses: Array.from({ length: 73 }, (_, h) => ['/', '/mnt/data'].map(path => ({
    id: `${path}-${h}`, host: 'fixture-host', path, at: at(h + 1), availableBytes: 101 * GIB, complete: true,
  }))).flat(), alarms: [] });
  const database = (deployment: unknown = shipment, samples = records()) => {
    const unsafe = vi.fn().mockResolvedValueOnce(deployment ? [deployment] : []).mockResolvedValueOnce([samples]);
    return { unsafe, sql: { unsafe } as unknown as Pick<import('postgres').Sql, 'unsafe'> };
  };

  it('derives the artifact, shipment time and cadence from native provenance, then measures both devices', async () => {
    const { sql, unsafe } = database();
    const result = await measureDiskHeadroomSoakWindow(sql, request);
    expect(result).toMatchObject({ verdict: 'pass', shipment, requirements: {
      artifactRef: shipment.artifactRef, shippedAt: shipment.shippedAt,
      maxSampleGapMs: 7 * 3_600_000, maxAlarmGapMs: 6 * 3_600_000,
    } });
    expect(unsafe.mock.calls[0]![0]).toContain("kind = 'deploy' AND status = 'ok'");
    expect(unsafe.mock.calls[0]![0]).toContain('workspace_id = $2 AND install_slug = $3');
    expect(unsafe.mock.calls[0]![1]).toEqual(['42', 'workspace', 'install']);
    expect(unsafe.mock.calls[1]![1]).toEqual(['fixture-host', at(0), at(74), 'workspace', at(1), at(73)]);
  });

  it.each([null, { ...shipment, artifactRef: 'a'.repeat(12) }, { ...shipment, id: '43' },
    { ...shipment, host: 'another-host:3070#123' }, { ...shipment, shippedAt: at(2) }])(
    'keeps missing, legacy, mismatched or pre-shipment evidence unknown', async (badShipment) => {
      const { sql, unsafe } = database(badShipment);
      expect((await measureDiskHeadroomSoakWindow(sql, request)).verdict).toBe('unknown');
      expect(unsafe).toHaveBeenCalledTimes(1);
    });

  it.each([{ windowEnd: at(72) }, { measuredAt: at(72) }, { deploymentId: '42 OR 1=1' }, { host: '' }])(
    'does not query a shortened, unfinished or malformed request', async (change) => {
      const { sql, unsafe } = database();
      expect((await measureDiskHeadroomSoakWindow(sql, { ...request, ...change })).verdict).toBe('unknown');
      expect(unsafe).not.toHaveBeenCalled();
    });

  it('propagates an unalarmed native middle dip, rather than passing healthy boundaries', async () => {
    const samples = records(); samples.censuses[50]!.availableBytes = 99 * GIB;
    const { sql } = database(shipment, samples);
    expect((await measureDiskHeadroomSoakWindow(sql, request)).verdict).toBe('fail');
  });

  it('does not certify an incomplete ledger read', async () => {
    const { sql } = database(shipment, { censuses: [], alarms: [] });
    expect((await measureDiskHeadroomSoakWindow(sql, request)).verdict).toBe('unknown');
  });
});

const generationId = 'v1-' + 'a'.repeat(64);
function fixture() {
  const snapshot = (path: string, dev: number) => ({ path, dev, totalBytes: 500 * GIB, availableBytes: 50 * GIB, reservedBytes: 12 * GIB });
  const store = {
    path: '/store', physical: '/store', device: 2,
    generations: { [generationId]: { device: 2, inode: 11, markerInode: 12, markerSha256: 'b'.repeat(64) } },
    pins: [{ name: 'checkout-1', identity: generationId, checkout: '/protected-checkout', sha256: 'c'.repeat(64) }], leases: [] as unknown[],
  };
  const endpoint = {
    at: '2026-10-11T02:43:18.599Z', nativePid: 123, scriptSha256: 'd'.repeat(64),
    policy: { criticalFreePctMin: 0.02, criticalFreeBytesMin: 2 * GIB, criticalFreeBytesCap: 64 * GIB, freeInodesPctMin: 0.05 },
    snapshots: [snapshot('/', 1), snapshot('/mnt/data', 2), snapshot('/tmp/pcv', 2)], stores: [store],
  };
  return {
    native0250Window: {
      pre: endpoint,
      registeredStep: {
        workflow_uuid: 'sched-.sessionDirGc-fixture', function_name: 'dependency-generation-retention',
        started_at_epoch_ms: String(Date.parse('2026-10-11T02:50:00Z')),
        completed_at_epoch_ms: String(Date.parse('2026-10-11T02:50:10Z')), error: null as unknown,
        receipt: { status: 'complete' as const, errors: [] as unknown[], stores: [
          { generationRoot: '/store', status: 'pruned' as const, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false },
        ] },
      },
    },
    oneHourNativeEndpoint: { receipt: { ...structuredClone(endpoint), at: '2026-10-11T03:43:49.059Z', runtimeStableDuringRead: true } },
  };
}
const check = (input: unknown, id: string) => assessRetainedStorageInterval(input).checks.find((x) => x.id === id);

function sampleFixture() {
  const base = fixture().native0250Window.pre;
  return [0, 30, 60].map((minutes) => ({
    ...structuredClone(base), at: new Date(Date.parse(base.at) + minutes * 60_000).toISOString(),
    runtimeStableDuringRead: true,
    snapshots: base.snapshots.map((s) => ({ ...s, totalInodes: 1000, freeInodes: 100 })),
  }));
}
const sampleRequirements = { startAt: '2026-10-11T02:43:18.599Z', endAt: '2026-10-11T03:43:18.599Z', maxSampleGapMs: 30 * 60_000 };
const sampleCheck = (input: unknown, id: string) => assessRetainedStorageSamples(input, sampleRequirements).checks.find((x) => x.id === id);

describe('retained storage sample coverage assessment', () => {
  it('checks every sample against the evaluator window and retains the limit of discrete observations', () => {
    const result = assessRetainedStorageSamples(sampleFixture(), sampleRequirements);
    expect(result).toMatchObject({ sampleStatus: 'pass', sampledSpanMs: 3_600_000, largestGapMs: 1_800_000, observedSamples: 3 });
    expect(result.scope.join(' ')).toContain('capacity between samples remains unmeasured');
    expect([...result.coverage.checked, ...result.coverage.notChecked, ...result.coverage.notApplicable].sort()).toEqual([...result.coverage.population].sort());
  });

  it('rejects two healthy hour endpoints when the permitted sample gap is shorter', () => {
    const samples = sampleFixture(); samples.splice(1, 1);
    Object.assign(samples, { continuousHeadroom: true, maxSampleGapMs: 3_600_000 });
    expect(sampleCheck(samples, 'sample-gap')?.status).toBe('fail');
  });

  it.each(['bytes', 'inodes'] as const)('detects a middle-sample %s deficit despite healthy endpoints', (kind) => {
    const samples = sampleFixture();
    Object.assign(samples[1]!.snapshots[0]!, kind === 'bytes' ? { reservedBytes: 45 * GIB, meetsCriticalFloor: true } : { freeInodes: 49 });
    expect(sampleCheck(samples, `${kind === 'bytes' ? 'byte' : 'inode'}-headroom:/`)?.status).toBe('fail');
  });

  it('keeps missing inode, reservation and filesystem measurements unknown', () => {
    const samples = sampleFixture();
    delete (samples[1]!.snapshots[0]! as { totalInodes?: number }).totalInodes;
    expect(sampleCheck(samples, 'inode-headroom:/')?.status).toBe('unknown');
    samples[1]!.snapshots.pop();
    expect(sampleCheck(samples, 'byte-headroom:/tmp/pcv')?.status).toBe('unknown');
    delete (samples[1]!.snapshots[0]! as { reservedBytes?: number }).reservedBytes;
    expect(assessRetainedStorageSamples(samples, sampleRequirements).sampleStatus).toBe('unknown');
  });

  it('checks recorded headroom while absent source and stability witnesses remain unknown', () => {
    const samples = sampleFixture().map(({ scriptSha256: _source, runtimeStableDuringRead: _stability, ...sample }) => sample);
    samples[1]!.snapshots[1]!.reservedBytes = 45 * GIB;
    samples[1]!.snapshots[2]!.reservedBytes = 45 * GIB;
    const result = assessRetainedStorageSamples(samples, sampleRequirements);
    expect(result.sampleStatus).toBe('fail');
    expect(result.checks.find((x) => x.id === 'window-coverage')?.status).toBe('pass');
    expect(result.checks.find((x) => x.id === 'runtime-custody')?.status).toBe('unknown');
    expect(result.checks.find((x) => x.id === 'byte-headroom:/mnt/data')?.status).toBe('fail');
    expect(result.checks.find((x) => x.id === 'physical-alias-budget')?.status).toBe('pass');
    expect(result.coverage.notChecked).toContain('runtime-custody');
  });

  it('does not certify custody from stability alone when source was never recorded', () => {
    const samples = sampleFixture().map(({ scriptSha256: _source, ...sample }) => sample);
    expect(assessRetainedStorageSamples(samples, sampleRequirements).checks
      .find((x) => x.id === 'runtime-custody')?.status).toBe('unknown');
    Object.assign(samples[1]!, { scriptSha256: 'malformed' });
    expect(assessRetainedStorageSamples(samples, sampleRequirements).checks
      .find((x) => x.id === 'sample-shape')?.status).toBe('unknown');
  });

  it.each(['duplicate', 'reversed'] as const)('refuses %s timestamps instead of silently repairing the sample sequence', (kind) => {
    const samples = sampleFixture();
    if (kind === 'duplicate') samples[1]!.at = samples[0]!.at;
    else samples.reverse();
    expect(sampleCheck(samples, 'sample-order')?.status).toBe('fail');
  });

  it('requires the actual samples to bracket the requested window and establish a gap', () => {
    expect(sampleCheck(sampleFixture().slice(1), 'window-coverage')?.status).toBe('unknown');
    expect(sampleCheck(sampleFixture().slice(0, 2), 'window-coverage')?.status).toBe('unknown');
    expect(sampleCheck(sampleFixture().slice(0, 1), 'sample-gap')?.status).toBe('unknown');
  });

  it.each(['device', 'runtime', 'source', 'stability', 'aliases', 'derived-bytes'] as const)('rejects middle-sample %s drift', (kind) => {
    const samples = sampleFixture(), middle = samples[1]!;
    if (kind === 'device') middle.snapshots[0]!.dev = 99;
    if (kind === 'runtime') middle.nativePid++;
    if (kind === 'source') middle.scriptSha256 = 'e'.repeat(64);
    if (kind === 'stability') middle.runtimeStableDuringRead = false;
    if (kind === 'aliases') middle.snapshots[2]!.reservedBytes = 0;
    if (kind === 'derived-bytes') Object.assign(middle.snapshots[0]!, { usableAfterReservationsBytes: 50 * GIB });
    const id = kind === 'aliases' ? 'physical-alias-budget' : kind === 'device' || kind === 'derived-bytes' ? 'byte-headroom:/' : 'runtime-custody';
    expect(sampleCheck(samples, id)?.status).toBe('fail');
  });

  it('does not hide impossible inode counts behind the no-inode-reporting policy', () => {
    const samples = sampleFixture();
    for (const sample of samples) Object.assign(sample.snapshots[0]!, { totalInodes: 0, freeInodes: 0 });
    expect(sampleCheck(samples, 'inode-headroom:/')?.status).toBe('pass');
    samples[1]!.snapshots[0]!.freeInodes = 1;
    expect(sampleCheck(samples, 'inode-headroom:/')?.status).toBe('fail');
  });

  it('excludes unrelated old sample gaps while still checking boundary-adjacent samples', () => {
    const samples = sampleFixture();
    const old = { ...structuredClone(samples[0]!), at: '2026-10-10T02:43:18.599Z' };
    expect(assessRetainedStorageSamples([old, ...samples], sampleRequirements).sampleStatus).toBe('pass');
    const crossing = { ...structuredClone(samples[0]!), at: '2026-10-11T02:43:18.598Z' };
    expect(assessRetainedStorageSamples([crossing, ...samples.slice(1)], sampleRequirements).sampleStatus).toBe('fail');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('keeps an invalid evaluator gap %s unknown', (gap) => {
    expect(assessRetainedStorageSamples(sampleFixture(), { ...sampleRequirements, maxSampleGapMs: gap }).sampleStatus).toBe('unknown');
  });
});

describe('retained storage interval assessment', () => {
  it('assesses the captured byte/pin window while retaining unmeasured candidate and inode facts', () => {
    const result = assessRetainedStorageInterval(fixture());
    expect(result.intervalStatus).toBe('pass');
    expect(result.sampledSpanMs).toBe(3_630_460);
    expect(result.coverage.notChecked).toEqual(['inode-headroom', 'final-candidate-demand']);
    expect(result.scope.join(' ')).toContain('no continuous-capacity claim');
    expect([...result.coverage.checked, ...result.coverage.notChecked, ...result.coverage.notApplicable].sort()).toEqual([...result.coverage.population].sort());
  });

  it.each(['nativePid', 'scriptSha256', 'runtimeStableDuringRead'] as const)('rejects a changed %s even if authored comparison booleans claim success', (field) => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt, { [field]: field === 'nativePid' ? 999 : field === 'scriptSha256' ? 'e'.repeat(64) : false, sameNativePidAsBaseline: true });
    expect(check(input, 'runtime-custody')?.status).toBe('fail');
  });

  it('refuses to turn a short endpoint span into a one-hour observation', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.at = '2026-10-11T03:00:00Z';
    expect(check(input, 'sampled-hour-span')?.status).toBe('fail');
  });

  it('uses available bytes after reservations, despite an authored positive floor verdict', () => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt.snapshots[0]!, { reservedBytes: 45 * GIB, meetsCriticalFloor: true });
    expect(check(input, 'byte-headroom:/')?.status).toBe('fail');
  });

  it('rejects a wrong device and contradictory derived byte totals', () => {
    const input = fixture();
    Object.assign(input.oneHourNativeEndpoint.receipt.snapshots[0]!, { dev: 3, usableAfterReservationsBytes: 50 * GIB });
    expect(check(input, 'byte-headroom:/')?.status).toBe('fail');
  });

  it('keeps a missing filesystem endpoint unknown rather than dropping it from the population', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots.pop();
    expect(check(input, 'byte-headroom:/tmp/pcv')?.status).toBe('unknown');
    expect(assessRetainedStorageInterval(input).intervalStatus).toBe('unknown');
  });

  it('detects split alias reservation budgets without double-counting a shared budget', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots[2]!.reservedBytes = 0;
    expect(check(input, 'physical-alias-budget:after')?.status).toBe('fail');
    const control = assessRetainedStorageInterval(fixture());
    expect(control.byteSnapshots.find((x) => x.endpoint === 'after' && x.path === '/mnt/data')?.usableBytes).toBe(38 * GIB);
  });

  it.each(['inode', 'markerInode', 'markerSha256'] as const)('detects protected generation %s drift while its name survives', (field) => {
    const input = fixture(); const g = input.oneHourNativeEndpoint.receipt.stores[0]!.generations[generationId]!;
    Object.assign(g, { [field]: field === 'markerSha256' ? 'f'.repeat(64) : 99 });
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
  });

  it('rejects a missing protected generation or redirected checkout, but permits pin timestamp hash refresh', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.stores[0]!.pins[0]!.sha256 = 'e'.repeat(64);
    expect(check(input, 'protected-pins:/store')?.status).toBe('pass');
    input.oneHourNativeEndpoint.receipt.stores[0]!.pins[0]!.checkout = '/different-checkout';
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
    delete input.oneHourNativeEndpoint.receipt.stores[0]!.generations[generationId];
    expect(check(input, 'protected-pins:/store')?.status).toBe('fail');
  });

  it('requires per-store execution receipts instead of trusting the outer success state', () => {
    const input = fixture(); input.native0250Window.registeredStep.receipt.stores = [];
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
  });

  it('rejects a repeated physical-store sweep or truncated native receipt', () => {
    const input = fixture(); input.native0250Window.registeredStep.receipt.stores.push(structuredClone(input.native0250Window.registeredStep.receipt.stores[0]!));
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
    input.native0250Window.registeredStep.receipt.stores.pop();
    input.native0250Window.registeredStep.receipt.stores[0]!.stdoutTruncated = true;
    expect(check(input, 'native-store-receipt:/store')?.status).toBe('fail');
  });

  it('rejects native failures and a retention step outside the captured time window', () => {
    const input = fixture(); input.native0250Window.registeredStep.error = 'prune failed';
    expect(check(input, 'registered-retention-completion')?.status).toBe('fail');
    input.native0250Window.registeredStep.error = null;
    input.native0250Window.registeredStep.completed_at_epoch_ms = String(Date.parse('2026-10-11T04:00:00Z'));
    expect(check(input, 'registered-retention-completion')?.status).toBe('fail');
  });

  it('keeps nonempty baseline leases unknown without a liveness/expiry witness', () => {
    const input = fixture(); input.native0250Window.pre.stores[0]!.leases.push({ identity: generationId });
    expect(check(input, 'selector-lease-custody:/store')?.status).toBe('unknown');
  });

  it('rejects malformed counters without treating missing or negative reservations as zero', () => {
    const input = fixture(); input.oneHourNativeEndpoint.receipt.snapshots[0]!.reservedBytes = -1;
    const result = assessRetainedStorageInterval(input);
    expect(result.intervalStatus).toBe('unknown');
    expect(result.byteSnapshots).toEqual([]);
    expect(result.checks[0]?.id).toBe('receipt-shape');
  });

  it('keeps missing native completion metadata and unsafe epoch strings unknown', () => {
    const missing = fixture(); Reflect.deleteProperty(missing.native0250Window.registeredStep, 'error');
    expect(assessRetainedStorageInterval(missing).intervalStatus).toBe('unknown');
    const unsafe = fixture(); unsafe.native0250Window.registeredStep.completed_at_epoch_ms = String(Number.MAX_SAFE_INTEGER + 1);
    expect(check(unsafe, 'receipt-shape')?.status).toBe('unknown');
  });

  it('rejects duplicate baseline store identity before it can create duplicate coverage ids', () => {
    const input = fixture(); input.native0250Window.pre.stores.push(structuredClone(input.native0250Window.pre.stores[0]!));
    const result = assessRetainedStorageInterval(input);
    expect(result.intervalStatus).toBe('unknown');
    expect(new Set(result.coverage.population).size).toBe(result.coverage.population.length);
  });
});

function derivativeFixture() {
  return {
    before: {
      candidates: ['/bank/cache-a', '/bank/cache-b', '/bank/cache-c'].map((path) => ({
        path, present: true, directory: true, sameDevice: true, physicalPathUnaliased: true, nestedMounts: [] as unknown[],
      })),
      sources: [{ bank: '/bank', sourcePresent: true }],
      receipts: [{ path: '/bank/receipt.json', bytes: 10, sha256: 'a'.repeat(64), metadataStable: true }], issues: [] as unknown[],
    },
    reconciliation: { removedCandidates: 1, remainingCount: 2, remainingPaths: ['/bank/cache-b', '/bank/cache-c'], checkedReceipts: 1, receiptChanges: [] as unknown[] },
    resumeBefore: { candidateCount: 2, checkedReceipts: 1, sourceMarkers: 1, sourceIdentities: { '/bank/source': [1, 2] }, availableBytesBefore: 30 },
    resumeAfter: {
      guardExit: 0, remainingCandidates: [] as string[], removedCandidateCount: 3, resumedCandidateCount: 2, checkedRetainedReceipts: 1,
      receiptChanges: [] as unknown[], sourceIdentityChanges: [] as unknown[], markerChanges: [] as unknown[],
      symlinkChanges: [] as unknown[], protectedD224ReceiptChanges: [] as unknown[],
      availableBytesBefore: 30, availableBytesAfter: 50, originalAvailableBytesBefore: 10,
      observedNetAvailableIncreaseBytes: 20, observedNetAvailableIncreaseSinceOriginalBytes: 40,
    },
    pathResults: [{ path: '/bank/cache-b', exit: 0 }, { path: '/bank/cache-c', exit: 0 }], resumeTerminalExit: 0,
    audit: { originalRemovedPopulation: 1, originalAdmissionRows: 1, originalCompletionRows: 0, resumePopulation: 2, resumeCompletionRows: 2, resumeFailureRows: 0 },
  };
}
const derivativeCheck = (input: unknown, id: string) => assessQualifiedDerivativeReceipts(input).checks.find((x) => x.id === id);

describe('qualified derivative retained receipt assessment', () => {
  it('checks the reconciled transaction while preserving all unmeasured acceptance requirements', () => {
    const result = assessQualifiedDerivativeReceipts(derivativeFixture());
    expect(result.receiptStatus).toBe('pass');
    expect(result.observedNetAvailableIncreaseBytes).toBe(40);
    expect(result.coverage.checked).toHaveLength(8);
    expect(result.coverage.notChecked).toContain('original-per-path-completion-audit');
    expect(result.coverage.notChecked).toContain('protected-payload-reread');
    expect(result.coverage.notChecked).toContain('continuous-headroom');
    expect([...result.coverage.checked, ...result.coverage.notChecked, ...result.coverage.notApplicable].sort()).toEqual([...result.coverage.population].sort());
  });

  it('refuses empty or duplicated populations instead of accepting vacuous preservation', () => {
    const empty = derivativeFixture(); empty.before.receipts = [];
    expect(assessQualifiedDerivativeReceipts(empty).receiptStatus).toBe('unknown');
    const duplicate = derivativeFixture(); duplicate.before.candidates.push(duplicate.before.candidates[0]!);
    expect(derivativeCheck(duplicate, 'qualified-population')?.status).toBe('fail');
    const receipts = derivativeFixture(); receipts.before.receipts.push(receipts.before.receipts[0]!);
    expect(derivativeCheck(receipts, 'retained-receipt-population')?.status).toBe('fail');
  });

  it('rejects nested mounts and unqualified device/alias witnesses', () => {
    const input = derivativeFixture(); input.before.candidates[0]!.nestedMounts.push('/mounted');
    expect(derivativeCheck(input, 'qualified-population')?.status).toBe('fail');
    input.before.candidates[0]!.nestedMounts = []; input.before.candidates[0]!.sameDevice = false;
    expect(derivativeCheck(input, 'qualified-population')?.status).toBe('fail');
  });

  it('rejects an unrelated remaining path even when the population counts agree', () => {
    const input = derivativeFixture(); input.reconciliation.remainingPaths[0] = '/unrelated/cache';
    expect(derivativeCheck(input, 'interruption-reconciliation')?.status).toBe('fail');
  });

  it('refuses a candidate containing protected source/receipt data or another candidate', () => {
    for (const path of ['/bank', '/bank/source', '/bank/cache-b/nested', '/bank/receipt.json']) {
      const input = derivativeFixture(); input.before.candidates[0]!.path = path;
      expect(derivativeCheck(input, 'protected-path-boundaries')?.status).toBe('fail');
    }
    const alias = derivativeFixture(); alias.before.candidates[0]!.path = '/bank/../source';
    expect(assessQualifiedDerivativeReceipts(alias).receiptStatus).toBe('unknown');
  });

  it('requires the exact remaining path set, not merely an equal result count', () => {
    const input = derivativeFixture(); input.pathResults[0]!.path = input.pathResults[1]!.path;
    expect(derivativeCheck(input, 'resume-path-completion')?.status).toBe('fail');
  });

  it.each(['path', 'terminal', 'survivor'] as const)('rejects %s failure despite an authored successful verdict', (failure) => {
    const input = derivativeFixture(); Object.assign(input, { verdict: 'PASS', terminalCompletedExit0: true });
    if (failure === 'path') input.pathResults[0]!.exit = 23;
    if (failure === 'terminal') input.resumeTerminalExit = 143;
    if (failure === 'survivor') input.resumeAfter.remainingCandidates.push('/bank/cache-c');
    expect(derivativeCheck(input, 'resume-path-completion')?.status).toBe('fail');
  });

  it.each(['receiptChanges', 'sourceIdentityChanges', 'markerChanges', 'symlinkChanges', 'protectedD224ReceiptChanges'] as const)('detects recorded %s drift', (field) => {
    const input = derivativeFixture(); input.resumeAfter[field].push('/changed');
    expect(derivativeCheck(input, 'recorded-preservation-comparisons')?.status).toBe('fail');
  });

  it('refuses underchecked receipts or substituted source identities', () => {
    const input = derivativeFixture(); input.resumeAfter.checkedRetainedReceipts = 0;
    expect(derivativeCheck(input, 'recorded-preservation-comparisons')?.status).toBe('fail');
    input.resumeAfter.checkedRetainedReceipts = 1;
    Reflect.deleteProperty(input.resumeBefore.sourceIdentities, '/bank/source');
    Object.assign(input.resumeBefore.sourceIdentities, { '/other/source': [1, 2] });
    expect(derivativeCheck(input, 'recorded-preservation-comparisons')?.status).toBe('fail');
  });

  it('distinguishes admission from completion and rejects missing resumed audit rows', () => {
    const input = derivativeFixture(); input.audit.resumeCompletionRows = 0;
    expect(derivativeCheck(input, 'resume-deletion-audit')?.status).toBe('fail');
    expect(derivativeCheck(input, 'original-per-path-completion-audit')?.status).toBe('unknown');
  });

  it('recomputes net change, accepts a measured decline, and never infers exclusive reclaimed bytes', () => {
    const input = derivativeFixture(); input.resumeAfter.observedNetAvailableIncreaseSinceOriginalBytes = 999;
    expect(derivativeCheck(input, 'observed-net-available-bytes')?.status).toBe('fail');
    Object.assign(input.resumeAfter, { availableBytesAfter: 5, observedNetAvailableIncreaseBytes: -25, observedNetAvailableIncreaseSinceOriginalBytes: -5 });
    expect(derivativeCheck(input, 'observed-net-available-bytes')?.status).toBe('pass');
    expect(derivativeCheck(input, 'exclusive-reclaim-bytes')?.status).toBe('unknown');
  });

  it('keeps missing native comparison fields and unsafe counters unknown', () => {
    const input = derivativeFixture(); Reflect.deleteProperty(input.resumeAfter, 'receiptChanges');
    expect(assessQualifiedDerivativeReceipts(input).receiptStatus).toBe('unknown');
    const unsafe = derivativeFixture(); unsafe.resumeAfter.availableBytesAfter = Number.MAX_SAFE_INTEGER + 1;
    expect(assessQualifiedDerivativeReceipts(unsafe).observedNetAvailableIncreaseBytes).toBeNull();
    const missingIdentity = derivativeFixture(); Object.assign(missingIdentity.resumeBefore.sourceIdentities, { '/bank/source': null });
    expect(assessQualifiedDerivativeReceipts(missingIdentity).receiptStatus).toBe('unknown');
  });
});
