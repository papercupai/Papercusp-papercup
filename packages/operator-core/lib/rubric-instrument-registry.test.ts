/**
 * test-rubric-unification-2026-10-12 P-005 (R-5, plan D-006): the rubric instrument registry —
 * parsers, the seed set (pinned to the performance audit's own keys), the argv evaluator, and
 * the authoring audit that refuses new/changed unregistered bindings and grandfathers carried ones.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import * as nativeAdoption from './code-intelligence/native-adoption';
import { HOLDER_BEHAVIOR_INSTRUMENT_KEYS } from './goal-holder-behavior-metrics';
import { GOAL_MODE_INSTRUMENT_KEYS } from './goal-mode-computed-instruments';
import { GATE_REUSE_AUDIT_INSTRUMENT_KEY } from './release/gate-fire-ledger';
import { RATCHET_METRICS_INSTRUMENT_KEY } from './release/ratchet-metrics';
import { SILENT_HALT_STRANDED_INSTRUMENT_KEY } from './system-health/silent-halt-instrument';
import { PG_TABLE_GROWTH_INSTRUMENT_KEY } from './storage/pg-table-growth';
import { WORK_OVERHEAD_INSTRUMENT_KEYS } from './agent-work-overhead-metrics';
import { PROVIDER_PACKAGE_INSTRUMENT_KEYS } from './integrations/provider-package-acceptance';
import { TOOL_DELIVERY_INSTRUMENTS } from './tool-delivery-acceptance';
import { COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY } from './storage/cold-tier-evidence';
import { DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY, POSTGRES_RETENTION_INSTRUMENT_KEY } from './storage/retention-interval-evidence';
import {
  BM25_LATENCY_INSTRUMENT_KEY,
  NATIVE_DISK_HEADROOM_ALARM_INSTRUMENT_KEY,
  GATE_SENTINEL_HEALTH_COMMAND,
  GATE_SENTINEL_HEALTH_INSTRUMENT_KEY,
  parseGateSentinelHealth,
  auditInstrumentBindings,
  budgetUtilisationPct,
  getRegisteredInstrument,
  instrumentRegistry,
  isManualInstrumentKey,
  memoryPagingBudgetPct,
  parseAnonBudgetPct,
  parseCgroupUsageUsec,
  parseDfMaxPercent,
  parseDfPercent,
  parseHttpTimesP95Ms,
  defaultExec,
  parseLoadavg1,
  parseLoopProfileBudgetPct,
  parseMaxPsiAvg,
  parseOldestDockerAgeSec,
  parsePsiAvg,
  parsePsiAvg10,
  parseSpaInitialJsBudgetPct,
  platformComputedInstrumentKeys,
  registeredInstrumentKeys,
  runInstrument,
  unregisteredInstrumentRefusal,
} from './rubric-instrument-registry';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const AUDIT_EVIDENCE = join(REPO_ROOT, 'docs/audits/application-performance-reliability-audit-2026-10-01-evidence.json');

const PSI_SAMPLE = [
  'some avg10=12.50 avg60=8.25 avg300=3.00 total=123456789',
  'full avg10=1.75 avg60=0.50 avg300=0.10 total=2345678',
].join('\n');

describe('instrument parsers read the real output formats', () => {
  it('reads PSI avg10 for the some and full lines, null for a missing line', () => {
    expect(parsePsiAvg10(PSI_SAMPLE, 'some')).toBe(12.5);
    expect(parsePsiAvg10(PSI_SAMPLE, 'full')).toBe(1.75);
    // /proc/pressure/cpu on older kernels carries only the `some` line.
    expect(parsePsiAvg10(PSI_SAMPLE.split('\n')[0], 'full')).toBeNull();
    // avg100=… must not satisfy avg10=.
    expect(parsePsiAvg10('some avg100=9.00 avg60=1.00', 'some')).toBeNull();
  });

  it('reads cgroup usage_usec, df pcent, and the 1-minute loadavg', () => {
    expect(parseCgroupUsageUsec('usage_usec 987654321\nuser_usec 1\nsystem_usec 2\n')).toBe(987654321);
    expect(parseCgroupUsageUsec('user_usec 1\n')).toBeNull();
    expect(parseDfPercent('Use%\n 42%\n')).toBe(42);
    expect(parseDfPercent('Use%\n')).toBeNull();
    expect(parseLoadavg1('3.21 2.10 1.05 4/1234 56789\n')).toBe(3.21);
    expect(parseLoadavg1('')).toBeNull();
  });

  it('reads the oldest docker container age; 0 for none; null on an unknown format', () => {
    const now = Date.parse('2026-10-12T22:00:00-04:00');
    const stdout = ['2026-10-12 21:00:00 -0400 EDT', '2026-10-12 20:00:00 -0400 EDT'].join('\n');
    expect(parseOldestDockerAgeSec(stdout, { now })).toBe(7200);
    expect(parseOldestDockerAgeSec('\n', { now })).toBe(0);
    expect(parseOldestDockerAgeSec('About an hour ago', { now })).toBeNull();
  });
});

describe('live sentinel deployment instrument (R-3)', () => {
  const snapshot = () => ({
    schemaVersion: 1, monotonicUs: 2_000_000_000, linger: 'yes',
    timer: { Id: 'papercusp-gate-liveness-sentinel.timer', LoadState: 'loaded', ActiveState: 'active', UnitFileState: 'enabled',
      Triggers: 'papercusp-gate-liveness-sentinel.service', WantedBy: 'timers.target',
      TimersMonotonic: '{ OnStartupUSec=5min } { OnUnitActiveUSec=10min }',
      LastTriggerUSecMonotonic: '1900000000', NextElapseUSecMonotonic: '2500000000' },
    service: { Id: 'papercusp-gate-liveness-sentinel.service', LoadState: 'loaded', ActiveState: 'inactive', Result: 'success',
      ExecMainStatus: '0', ExecMainStartTimestampMonotonic: '1900000000', ExecMainExitTimestampMonotonic: '1910000000',
      ExecStart: '{ path=/repo/node_modules/.bin/tsx ; argv[]=/repo/scripts/gate-liveness-sentinel.mts ; }',
      Requires: 'sysinit.target', Wants: '', BindsTo: '', PartOf: '' },
  });
  it('accepts a recent successful inactive oneshot with an enabled reboot-starting timer', () => {
    expect(parseGateSentinelHealth(JSON.stringify(snapshot()))).toBe(1);
    expect(auditInstrumentBindings({ prior: [], next: [{ key: 'r-3', check: { kind: 'instrument', instrumentKey: GATE_SENTINEL_HEALTH_INSTRUMENT_KEY } }] }).refused).toEqual([]);
  });
  it('reads systemctl timer spans without mistaking healthy inventory for a broken deployment', () => {
    const s = snapshot();
    s.timer.LastTriggerUSecMonotonic = '31min 40s';
    s.timer.NextElapseUSecMonotonic = '41min 40s';
    expect(parseGateSentinelHealth(JSON.stringify(s))).toBe(1);
    s.timer.NextElapseUSecMonotonic = '41min unknown';
    expect(parseGateSentinelHealth(JSON.stringify(s))).toBeNull();
  });
  it.each(['absent', 'disabled', 'stopped', 'failed', 'wrong-script', 'no-linger', 'no-startup', 'stale', 'no-next', 'operator-dependency'])('detects %s instead of passing a unit fixture', defect => {
    const s = snapshot();
    if (defect === 'absent') s.timer.LoadState = 'not-found';
    if (defect === 'disabled') s.timer.UnitFileState = 'disabled';
    if (defect === 'stopped') s.timer.ActiveState = 'inactive';
    if (defect === 'failed') s.service.Result = 'exit-code';
    if (defect === 'wrong-script') s.service.ExecStart = '/repo/operator';
    if (defect === 'no-linger') s.linger = 'no';
    if (defect === 'no-startup') s.timer.TimersMonotonic = '{ OnUnitActiveUSec=10min }';
    if (defect === 'stale') s.monotonicUs += 900_000_000;
    if (defect === 'no-next') s.timer.NextElapseUSecMonotonic = '0';
    if (defect === 'operator-dependency') s.service.Requires = 'papercusp-dev-api.service';
    expect(parseGateSentinelHealth(JSON.stringify(s))).toBe(0);
  });
  it('keeps missing, malformed, first-run and in-progress execution evidence unknown', async () => {
    for (const raw of ['', 'null', '{}', JSON.stringify({ ...snapshot(), monotonicUs: 'unreadable' })]) expect(parseGateSentinelHealth(raw)).toBeNull();
    const s: any = snapshot();
    delete s.service.ExecMainExitTimestampMonotonic;
    expect(parseGateSentinelHealth(JSON.stringify(s))).toBeNull();
    s.service.ExecMainExitTimestampMonotonic = '0';
    expect(parseGateSentinelHealth(JSON.stringify(s))).toBeNull();
    expect(await runInstrument(GATE_SENTINEL_HEALTH_INSTRUMENT_KEY, { exec: async () => { throw new Error('no user bus'); } })).toMatchObject({ value: null, error: 'no user bus' });
  });
  it('collects only bounded read-only systemd fields and feeds the native instrument executor', async () => {
    const s = snapshot(), calls: unknown[][] = []; let stdout = '';
    runInNewContext(GATE_SENTINEL_HEALTH_COMMAND, {
      require: (name: string) => name === 'node:os' ? { userInfo: () => ({ uid: 1000 }) } : { execFileSync: (command: string, args: string[], options: unknown) => {
        calls.push([command, args, options]);
        if (command === 'loginctl') return 'yes\n';
        const row = args.includes(s.timer.Id) ? s.timer : s.service;
        return Object.entries(row).flatMap(([k, v]) => k === 'TimersMonotonic'
          ? ['TimersMonotonic={ OnUnitActiveUSec=10min }', 'TimersMonotonic={ OnStartupUSec=5min }']
          : [`${k}=${v}`]).join('\n');
      } },
      process: { stdout: { write: (v: string) => { stdout += v; } }, hrtime: { bigint: () => BigInt(s.monotonicUs) * 1000n } },
    });
    expect(parseGateSentinelHealth(stdout)).toBe(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject(['systemctl', expect.arrayContaining(['--user', 'show', s.timer.Id]), { timeout: 2000 }]);
    expect(calls[1][1]).not.toContain('Environment');
    expect(calls[2]).toMatchObject(['loginctl', ['show-user', '1000', '-p', 'Linger', '--value'], { timeout: 2000 }]);
    expect(await runInstrument(GATE_SENTINEL_HEALTH_INSTRUMENT_KEY, { exec: async () => stdout })).toMatchObject({ value: 1, unit: 'count' });
  });
});

describe('the registry seed set', () => {
  it('registers the operational BM25 artifact without claiming a platform measurement', async () => {
    expect(getRegisteredInstrument(BM25_LATENCY_INSTRUMENT_KEY)?.evaluator).toBe('artifact');
    expect(platformComputedInstrumentKeys()).not.toContain(BM25_LATENCY_INSTRUMENT_KEY);
    await expect(runInstrument(BM25_LATENCY_INSTRUMENT_KEY)).rejects.toThrow('retained artifact evidence');
    expect(auditInstrumentBindings({ prior: [], next: [{ key: 'r-2',
      check: { kind: 'instrument', instrumentKey: BM25_LATENCY_INSTRUMENT_KEY } }] }).refused).toEqual([]);
  });
  it('registers every host instrument key the performance audit recorded, verbatim (derived, not hand-copied)', () => {
    const audit = readFileSync(AUDIT_EVIDENCE, 'utf8');
    const auditKeys = new Set(
      [...audit.matchAll(/"key":\s*"(host:[^"]+)"/g)].map((m) => m[1].replace(/:(start|end)$/, '')),
    );
    // Positive control: the census must actually find keys, or the pin is vacuous.
    expect(auditKeys.size).toBeGreaterThanOrEqual(3);
    for (const key of auditKeys) expect(getRegisteredInstrument(key), key).not.toBeNull();
  });

  it('seeds runnable command instruments for PSI, cgroup CPU delta, df and docker age', () => {
    for (const key of [
      'host:psi-cpu-some-avg10-pct',
      'host:psi-cpu-full-avg10-pct',
      'host:psi-io-some-avg10-pct',
      'host:psi-memory-full-avg10-pct',
      'host:cgroup-cpu-delta-cores',
      'host:df-root-used-pct',
      'host:docker-test-container-max-age-s',
    ]) {
      const instrument = getRegisteredInstrument(key);
      expect(instrument?.evaluator, key).toBe('command');
      if (instrument?.evaluator === 'command') {
        expect(instrument.argv.length, key).toBeGreaterThan(0);
        expect(instrument.unit, key).toBeTruthy();
      }
    }
  });

  it('registers exactly the keys scorecards resolves as platform-computed', () => {
    const expected = [
      'woe.goal-mode-base-scorecard',
      ...TOOL_DELIVERY_INSTRUMENTS,
      ...Object.values(PROVIDER_PACKAGE_INSTRUMENT_KEYS),
      GATE_REUSE_AUDIT_INSTRUMENT_KEY,
      'storage:disk-headroom-post-shipment-72h',
      DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY,
      COLD_MOUNTS_INSTRUMENT_KEY,
      COLD_MOVES_INSTRUMENT_KEY,
      NATIVE_DISK_HEADROOM_ALARM_INSTRUMENT_KEY,
      PG_TABLE_GROWTH_INSTRUMENT_KEY,
      ...Object.values(WORK_OVERHEAD_INSTRUMENT_KEYS),
      ...Object.values(HOLDER_BEHAVIOR_INSTRUMENT_KEYS),
      ...Object.values(GOAL_MODE_INSTRUMENT_KEYS),
      ...Object.values(nativeAdoption.NATIVE_ADOPTION_INSTRUMENT_KEYS),
      ...Object.values(nativeAdoption.NATIVE_PUSH_INSTRUMENT_KEYS),
      RATCHET_METRICS_INSTRUMENT_KEY,
      POSTGRES_RETENTION_INSTRUMENT_KEY,
      SILENT_HALT_STRANDED_INSTRUMENT_KEY,
    ];
    expect(platformComputedInstrumentKeys().sort()).toEqual([...expected].sort());
    for (const key of expected) expect(instrumentRegistry().get(key)?.evaluator, key).toBe('platform');
  });

  it('only registered scheduled families opt into windows and adoption uses its real rater', async () => {
    const window = { workspaceId: 'ws-native', windowStart: '2026-10-10T04:00:00.000Z', windowEnd: '2026-10-13T04:00:00.000Z' };
    const metrics = nativeAdoption.summarizeNativeAdoption({ window, invocations: [], shellCommands: [] });
    const measure = vi.spyOn(nativeAdoption, 'measureNativeAdoptionWindow').mockResolvedValue(metrics);
    try {
      for (const key of platformComputedInstrumentKeys()) {
        const instrument = getRegisteredInstrument(key);
        expect(instrument?.evaluator).toBe('platform');
        if (instrument?.evaluator !== 'platform') throw new Error('expected platform instrument');
        const criterion = nativeAdoption.nativeAdoptionCriterionForInstrument(key);
        if (!criterion) {
          const harnessFamilies = [COLD_MOUNTS_INSTRUMENT_KEY, COLD_MOVES_INSTRUMENT_KEY, NATIVE_DISK_HEADROOM_ALARM_INSTRUMENT_KEY,
            DURABLE_HEADROOM_TARGETS_INSTRUMENT_KEY, ...Object.values(WORK_OVERHEAD_INSTRUMENT_KEYS), RATCHET_METRICS_INSTRUMENT_KEY,
            POSTGRES_RETENTION_INSTRUMENT_KEY];
          if (harnessFamilies.includes(key) || Object.values(nativeAdoption.NATIVE_PUSH_INSTRUMENT_KEYS).some(k => k === key)) {
            expect(instrument.rescore?.windowMs).toBe(key === NATIVE_DISK_HEADROOM_ALARM_INSTRUMENT_KEY ? 90 * 60_000
              : key === POSTGRES_RETENTION_INSTRUMENT_KEY ? 30 * 24 * 60 * 60_000
              : Object.values(WORK_OVERHEAD_INSTRUMENT_KEYS).some(k => k === key) || key === RATCHET_METRICS_INSTRUMENT_KEY
                ? 24 * 60 * 60_000 : 72 * 60 * 60_000);
            expect(instrument.rescore?.unit).toBe('count');
            if (harnessFamilies.includes(key)) expect(instrument.rescore?.scope).toBe('harness');
          } else if (key === SILENT_HALT_STRANDED_INSTRUMENT_KEY) {
            expect(instrument.rescore?.windowMs).toBe(60 * 60_000);
            expect(instrument.rescore?.unit).toBe('count');
            expect(instrument.rescore?.scope).toBe('workspace');
          } else expect(instrument.rescore).toBeUndefined();
          continue;
        }
        expect(instrument.rescore?.windowMs).toBe(72 * 60 * 60_000);
        expect(await instrument.rescore!.resolve(window)).toMatchObject({
          verdict: nativeAdoption.rateNativeAdoption(metrics)[criterion].verdict,
        });
      }
      expect(measure).toHaveBeenCalledTimes(2);
      expect(measure).toHaveBeenCalledWith(window);
    } finally { measure.mockRestore(); }
  });

  it("never registers the manual key, and treats 'none' case-insensitively as manual", () => {
    expect(registeredInstrumentKeys()).not.toContain('none');
    expect(isManualInstrumentKey('none')).toBe(true);
    expect(isManualInstrumentKey(' NONE ')).toBe(true);
    expect(isManualInstrumentKey('host:df-root-used-pct')).toBe(false);
  });
});

describe('runInstrument', () => {
  it('runs the registered argv without a shell and parses one value', async () => {
    const calls: Array<readonly string[]> = [];
    const reading = await runInstrument('host:psi-cpu-some-avg10-pct', {
      exec: async (argv) => {
        calls.push(argv);
        return PSI_SAMPLE;
      },
      now: () => Date.parse('2026-10-13T00:00:00Z'),
    });
    expect(calls).toEqual([['cat', '/proc/pressure/cpu']]);
    expect(reading).toMatchObject({ key: 'host:psi-cpu-some-avg10-pct', unit: '%', value: 12.5 });
    expect(reading.measuredAt).toBe('2026-10-13T00:00:00.000Z');
    expect(reading.error).toBeUndefined();
  });

  it('computes a two-sample instrument as a rate, never a single lifetime counter', async () => {
    const samples = ['usage_usec 1000000\n', 'usage_usec 5000000\n'];
    const times = [0, 2000];
    const slept: number[] = [];
    const reading = await runInstrument('host:cgroup-cpu-delta-cores', {
      exec: async () => samples.shift() as string,
      now: () => times.shift() ?? 2000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([2000]);
    // 4,000,000 µs of CPU over 2,000 ms of wall = 2 cores.
    expect(reading.value).toBe(2);
    expect(reading.unit).toBe('cores');
  });

  it('reports an unparseable or failed command as value null with an error, never 0', async () => {
    const unparsed = await runInstrument('host:df-root-used-pct', { exec: async () => 'garbage' });
    expect(unparsed.value).toBeNull();
    expect(unparsed.error).toMatch(/did not parse/);
    const failed = await runInstrument('host:df-root-used-pct', {
      exec: async () => {
        throw new Error('spawn df ENOENT');
      },
    });
    expect(failed.value).toBeNull();
    expect(failed.error).toMatch(/ENOENT/);
  });

  it('refuses to run an unregistered key or a platform-computed key', async () => {
    await expect(runInstrument('testing:run')).rejects.toThrow(/unregistered instrument 'testing:run'/);
    await expect(runInstrument(GATE_REUSE_AUDIT_INSTRUMENT_KEY)).rejects.toThrow(/platform-computed/);
  });

  it.skipIf(!existsSync('/proc/pressure/cpu'))('measures real host CPU pressure through the default executor', async () => {
    const reading = await runInstrument('host:psi-cpu-some-avg10-pct');
    expect(reading.error).toBeUndefined();
    expect(reading.value).not.toBeNull();
    expect(reading.value as number).toBeGreaterThanOrEqual(0);
    expect(reading.value as number).toBeLessThanOrEqual(100);
  });
});

describe('auditInstrumentBindings (the authoring guard)', () => {
  const manual = { key: 'm', check: { kind: 'instrument' as const, instrumentKey: 'NONE' } };
  const registered = { key: 'r', check: { kind: 'instrument' as const, instrumentKey: 'host:df-root-used-pct' } };
  const unbound = { key: 'u', model: 'Prose only.' };

  it('accepts manual, registered and unbound criteria on a new rubric', () => {
    expect(auditInstrumentBindings({ prior: [], next: [manual, registered, unbound] })).toEqual({
      refused: [],
      grandfathered: [],
    });
  });

  it('refuses a NEW unregistered binding in every binding form', () => {
    const audit = auditInstrumentBindings({
      prior: [],
      next: [
        { key: 'a', check: { kind: 'instrument', instrumentKey: 'parked-agent-census' } },
        { key: 'b', instrumentKey: 'testing:run' },
        { key: 'c', model: 'Rates the thing. [instrumentKey: reaper-vitest]' },
      ],
    });
    expect(audit.refused).toEqual([
      { criterion: 'a', instrumentKey: 'parked-agent-census', priorInstrumentKey: null },
      { criterion: 'b', instrumentKey: 'testing:run', priorInstrumentKey: null },
      { criterion: 'c', instrumentKey: 'reaper-vitest', priorInstrumentKey: null },
    ]);
  });

  it('grandfathers a carried unchanged legacy key and refuses a changed one', () => {
    const audit = auditInstrumentBindings({
      prior: [
        { key: 'carried', instrumentKey: 'pot-throughput-ticks' },
        { key: 'changed', instrumentKey: 'legacy-a' },
      ],
      next: [
        // Same key moved from the legacy field into the structured check: still carried.
        { key: 'carried', check: { kind: 'instrument', instrumentKey: 'pot-throughput-ticks' } },
        { key: 'changed', instrumentKey: 'legacy-b' },
      ],
    });
    expect(audit.grandfathered).toEqual([{ criterion: 'carried', instrumentKey: 'pot-throughput-ticks' }]);
    expect(audit.refused).toEqual([{ criterion: 'changed', instrumentKey: 'legacy-b', priorInstrumentKey: 'legacy-a' }]);
  });

  it('a legacy key moved onto a DIFFERENT criterion is not carried', () => {
    const audit = auditInstrumentBindings({
      prior: [{ key: 'old', instrumentKey: 'legacy-a' }],
      next: [{ key: 'new', instrumentKey: 'legacy-a' }],
    });
    expect(audit.refused).toEqual([{ criterion: 'new', instrumentKey: 'legacy-a', priorInstrumentKey: null }]);
  });

  it('renders a refusal naming each binding and the registered keys, or null when nothing is refused', () => {
    expect(unregisteredInstrumentRefusal({ refused: [], grandfathered: [] })).toBeNull();
    const refusal = unregisteredInstrumentRefusal({
      refused: [{ criterion: 'b', instrumentKey: 'testing:run', priorInstrumentKey: null }],
      grandfathered: [],
    });
    expect(refusal).toMatchObject({ ok: false, code: 'unregistered_instrument' });
    expect(refusal?.error).toContain("b → 'testing:run'");
    expect(refusal?.registeredKeys).toContain('host:psi-cpu-some-avg10-pct');
    expect(refusal?.next).toContain("instrumentKey:'none'");
  });
});

// test-rubric-unification-2026-10-12 P-010 (R-10, plan D-009): the papercusp-app-performance
// instruments. Each parser is pinned in BOTH directions — a budget breach reads above 100 and a
// reshaped/missing input reads null (an error row), never a low value that would rate "meets".
describe('papercusp-app-performance instruments (P-010)', () => {
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const CG_PSI = (some60: number) => `some avg10=0.00 avg60=${some60.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n`;

  it('reads PSI at any window, and the worst serving cgroup only when every file parsed', () => {
    expect(parsePsiAvg(PSI_SAMPLE, 'some', 'avg300')).not.toBeNull();
    expect(parsePsiAvg('some avg10=1.00 total=3', 'some', 'avg60')).toBeNull();
    expect(parseMaxPsiAvg(CG_PSI(0.5) + CG_PSI(7.25) + CG_PSI(1), 'some', 'avg60', 3)).toBe(7.25);
    // A stopped service contributes no file: two lines where three were expected is not "low".
    expect(parseMaxPsiAvg(CG_PSI(0.5) + CG_PSI(1), 'some', 'avg60', 3)).toBeNull();
  });

  it('takes the fullest filesystem from a multi-row df', () => {
    expect(parseDfMaxPercent('Use%\n 95%\n 91%\n  1%\n')).toBe(95);
    expect(parseDfMaxPercent('Use%\n')).toBeNull();
  });

  it('computes nearest-rank p95 of curl http_code + time_total in ms; a malformed line is null', () => {
    const samples = [...Array.from({ length: 14 }, () => '200 0.002'), '200 0.419'].join('\n');
    expect(parseHttpTimesP95Ms(samples)).toBe(419);
    expect(parseHttpTimesP95Ms('200 0.004\n200 0.003\n')).toBe(4);
    expect(parseHttpTimesP95Ms('200 0.004\ncurl: (7) Failed to connect\n')).toBeNull();
    expect(parseHttpTimesP95Ms('0.004\n')).toBeNull();
    expect(parseHttpTimesP95Ms('')).toBeNull();
  });

  // WI-6554700010009926: one refused or timed-out request blanked the whole reading (status error,
  // value null), so a health endpoint that never answered was rated unknown instead of a miss.
  it('counts a refused, timed-out or non-2xx request as a sample at the cap', () => {
    const oneDown = [...Array.from({ length: 14 }, () => '200 0.002'), '000 0.001'].join('\n');
    expect(parseHttpTimesP95Ms(oneDown, 5)).toBe(5000);
    expect(parseHttpTimesP95Ms('503 0.010\n', 5)).toBe(5000);
    expect(parseHttpTimesP95Ms('000 5.002\n', 5)).toBe(5002);
  });

  it('the health instrument keeps sampling past a failed request and judges it in the parser', async () => {
    const health = getRegisteredInstrument('host:http-health-p95-ms');
    if (!health || health.evaluator !== 'command') throw new Error('host:http-health-p95-ms is not a command instrument');
    expect(health.acceptNonZeroExit).toBe(true);
    expect(health.argv).not.toContain('--fail-early');
    expect(health.argv).not.toContain('-f');
    const calls: unknown[][] = [];
    const reading = await runInstrument('host:http-health-p95-ms', {
      exec: async (...args) => {
        calls.push(args);
        return [...Array.from({ length: 14 }, () => '200 0.002'), '000 0.001'].join('\n');
      },
    });
    expect(calls[0]?.[2]).toEqual({ acceptNonZeroExit: true });
    expect(reading).toMatchObject({ value: 5000 });
  });

  it('defaultExec keeps stdout on a non-zero exit only when the instrument opts in', async () => {
    const argv = ['sh', '-c', 'echo 200 0.001; exit 7'] as const;
    await expect(defaultExec(argv, 5_000, { acceptNonZeroExit: true })).resolves.toBe('200 0.001\n');
    await expect(defaultExec(argv, 5_000)).rejects.toThrow();
  });

  it('budget utilisation is the WORST sub-target in percent; a non-positive budget is null', () => {
    expect(budgetUtilisationPct([{ value: 765, budget: 500 }, { value: 30, budget: 60 }])).toBe(153);
    expect(budgetUtilisationPct([{ value: 10, budget: 0 }])).toBeNull();
    expect(budgetUtilisationPct([])).toBeNull();
  });

  it('counts only last-24h saturation profiles and reads the worst p95 lag', () => {
    const name = (agoH: number, p95: number) => `loop-saturation-${NOW - agoH * 3600_000}-pid1-p95_${p95}ms.cpuprofile`;
    const listing = ['stalls', name(1, 30), name(2, 989), name(30, 5000)].join('\n');
    // 2 in window (40% of 5/day), worst 989 ms (197.8% of 500 ms) → 197.8
    expect(parseLoopProfileBudgetPct(listing, { now: NOW }, { maxPerDay: 5, maxP95Ms: 500 })).toBe(197.8);
    expect(parseLoopProfileBudgetPct('stalls\n', { now: NOW }, { maxPerDay: 5, maxP95Ms: 500 })).toBe(0);
  });

  it('reads anon (never anon_thp or file) per service in argv order; a missing service is null', () => {
    const stat = (anon: number) => `anon ${anon}\nfile 99999999999\nanon_thp 5\n`;
    expect(parseAnonBudgetPct(stat(12.9e9) + stat(3.4e9), [6e9, 4e9])).toBe(215);
    expect(parseAnonBudgetPct(stat(3e9) + stat(2e9), [6e9, 4e9])).toBe(50);
    expect(parseAnonBudgetPct(stat(3e9), [6e9, 4e9])).toBeNull();
  });

  it('memory paging takes the worse of PSI avg60 and the swap-in rate between two samples', () => {
    const sample = (psi60: number, pswpin: number) =>
      `some avg10=0.00 avg60=${psi60.toFixed(2)} avg300=0.00 total=1\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\nnr_free_pages 1\npswpin ${pswpin}\n`;
    // 6,103 pages × 4096 B over 5 s = 5.0 MB/s → 500% of 1 MB/s; PSI 1% → 20% of 5%.
    expect(memoryPagingBudgetPct(sample(1, 1000), sample(1, 7103), 5000, { maxPsiPct: 5, maxSwapInMBps: 1 })).toBe(500);
    expect(memoryPagingBudgetPct(sample(2.5, 1000), sample(2.5, 1000), 5000, { maxPsiPct: 5, maxSwapInMBps: 1 })).toBe(50);
    expect(memoryPagingBudgetPct(sample(1, 1000), 'nonsense', 5000, { maxPsiPct: 5, maxSwapInMBps: 1 })).toBeNull();
  });

  it('reads the SPA script output as the worse of gzip KB and file count', () => {
    expect(parseSpaInitialJsBudgetPct('{"files":183,"rawBytes":2376000,"gzipBytes":765000}', { maxGzipKB: 500, maxFiles: 60 })).toBe(305);
    expect(parseSpaInitialJsBudgetPct('{"files":20,"gzipBytes":250000}', { maxGzipKB: 500, maxFiles: 60 })).toBe(50);
    expect(parseSpaInitialJsBudgetPct('not json', { maxGzipKB: 500, maxFiles: 60 })).toBeNull();
  });

  it('registers every key D-009 binds, each as a runnable command instrument', () => {
    for (const key of [
      'host:psi-cpu-some-avg300-pct',
      'host:psi-io-some-avg60-pct',
      'host:cgroup-serving-cpu-pressure-some-avg60-max-pct',
      'host:memory-paging-budget-pct',
      'host:df-max-used-pct',
      'host:http-health-p95-ms',
      'host:loop-profile-budget-pct',
      'host:serving-anon-budget-pct',
      'static:spa-initial-js-budget-pct',
    ]) {
      expect(getRegisteredInstrument(key)?.evaluator, key).toBe('command');
    }
  });

  it('a raw two-sample instrument hands BOTH stdouts to combine after the interval', async () => {
    const outputs = [
      'some avg10=0.00 avg60=1.00 avg300=0.00 total=1\npswpin 1000\n',
      'some avg10=0.00 avg60=1.00 avg300=0.00 total=1\npswpin 7103\n',
    ];
    const times = [NOW, NOW + 5000];
    const slept: number[] = [];
    const reading = await runInstrument('host:memory-paging-budget-pct', {
      exec: async () => outputs.shift()!,
      now: () => times.shift()!,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([5000]);
    expect(reading).toMatchObject({ key: 'host:memory-paging-budget-pct', unit: '%', value: 500 });
    expect(reading.error).toBeUndefined();
  });

  it('a raw two-sample instrument whose second sample is reshaped reads null with an error', async () => {
    const outputs = ['some avg10=0.00 avg60=1.00 avg300=0.00 total=1\npswpin 1000\n', 'garbage'];
    const reading = await runInstrument('host:memory-paging-budget-pct', {
      exec: async () => outputs.shift()!,
      now: () => NOW,
      sleep: async () => {},
    });
    expect(reading.value).toBeNull();
    expect(reading.error).toBe('second sample did not parse');
  });
});
