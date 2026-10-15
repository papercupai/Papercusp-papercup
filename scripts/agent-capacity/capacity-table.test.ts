import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTable, parseRampLog, renderMarkdown } from './capacity-table';
import type { Header, Sample } from './footprint-summary';
import { hourlyPriceUsd } from './gcp-rails';

const MiB = 2 ** 20;
const header: Header = { host: 'cap-p005-s4', label: 'x', cgroup: '/sys/fs/cgroup/capdrv.slice', clk_tck: 100, nproc: 4, mem_total_kb: 16 * 1024 * 1024, interval: 5, started: 0 };

const end = (label: string, n: number, verdict: string) =>
  `RAMP_STEP_END p005-${label}-n${n} n=${n} rc=0 ${verdict} runs=${n} wallSlowdown=1.${n}0 diverged=0 toolDiverged=0 2026-10-01T03:20:00Z`;

/** A capture whose slice burns `cores` cores and holds `anonMb` of anon above a 100 MB t0. */
function capture(cores: number, anonMb: number): string {
  const s = (t: number, anon: number): Sample => ({ t, cg: { cpu_usec: t * cores * 1e6, anon: anon * MiB, mem: anon * 2 * MiB }, procs: [] });
  return [{ header }, s(0, 100), s(5, 100 + anonMb), s(10, 100 + anonMb)].map((r) => JSON.stringify(r)).join('\n') + '\n';
}

describe('capacity-table', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'captable-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function vm(mt: string, label: string, log: string[], at?: { n: number; cores: number; anonMb: number; peaksMiB: number[]; toolDiverged?: number }) {
    const dir = path.join(root, mt);
    mkdirSync(path.join(dir, 'fp'), { recursive: true });
    writeFileSync(path.join(dir, `ramp-${label}.log`), ['RAMP_STEP_START ignored', ...log, `RAMP_DONE ${label}`].join('\n') + '\n');
    if (!at) return;
    const run = `p005-${label}-n${at.n}`;
    writeFileSync(path.join(dir, 'fp', `${run}.jsonl`), capture(at.cores, at.anonMb));
    mkdirSync(path.join(dir, 'runs', run), { recursive: true });
    const rows = at.peaksMiB.map((p, i) => JSON.stringify({ memPeakBytes: p * MiB, cpuUsec: 1, toolDiverged: i < (at.toolDiverged ?? 0) }));
    writeFileSync(path.join(dir, 'runs', run, 'agents.jsonl'), rows.join('\n') + '\n');
  }

  it('includes every machine family gcp-rails can price (t2d, c4a), and skips dirs it cannot', () => {
    for (const mt of ['t2d-standard-16', 'c4a-standard-16', 'e2-standard-16']) vm(mt, 'mixed-normal', [end('mixed-normal', 48, 'OK')]);
    vm('t2a-standard-16', 'mixed-normal', [end('mixed-normal', 48, 'OK')]); // unpriced family
    mkdirSync(path.join(root, 'notes'));
    const types = buildTable(root, 120).map((r) => r.machineType).sort();
    expect(types).toEqual(['c4a-standard-16', 'e2-standard-16', 't2d-standard-16']);
    const c4a = buildTable(root, 120).find((r) => r.machineType === 'c4a-standard-16');
    expect(c4a?.usdPerHour).toBeCloseTo(hourlyPriceUsd('c4a-standard-16', 120), 9);
  });

  it('merges a continuation ramp log into its workload row by step label, not file name, and measures at the merged capacity', () => {
    vm('t2d-standard-16', 'mixed-normal', [end('mixed-normal', 48, 'OK'), end('mixed-normal', 64, 'OK')]);
    const dir = path.join(root, 't2d-standard-16');
    writeFileSync(
      path.join(dir, 'ramp-mixed-normal-x.log'),
      ['RAMP_PREFLIGHT_OK ignored', end('mixed-normal', 128, 'OK'), end('mixed-normal', 160, 'SATURATED reason=failed=3')].join('\n') + '\n',
    );
    const run = 'p005-mixed-normal-n128';
    writeFileSync(path.join(dir, 'fp', `${run}.jsonl`), capture(8, 1280));
    mkdirSync(path.join(dir, 'runs', run), { recursive: true });
    writeFileSync(path.join(dir, 'runs', run, 'agents.jsonl'), JSON.stringify({ memPeakBytes: 1024 * MiB, cpuUsec: 1 }) + '\n');
    // A continuation that never ran (its marker has no step verdict) adds no row.
    vm('c4a-standard-16', 'mixed-normal', [end('mixed-normal', 48, 'OK'), end('mixed-normal', 64, 'SATURATED reason=oom_kill=1')]);
    writeFileSync(path.join(root, 'c4a-standard-16', 'ramp-mixed-normal-x.log'), 'EXT_SKIPPED_SATURATED\n');

    const rows = buildTable(root, 120);
    expect(rows.map((r) => `${r.machineType}/${r.label}`).sort()).toEqual(['c4a-standard-16/mixed-normal', 't2d-standard-16/mixed-normal']);
    const t2d = rows.find((r) => r.machineType === 't2d-standard-16');
    expect(t2d).toMatchObject({ capacity: 128, censored: false, saturatedAt: { n: 160, reason: 'failed=3' } });
    expect(t2d?.coresPerAgent).toBeCloseTo(8 / 128, 9); // measured at the merged capacity step
    expect(rows.find((r) => r.machineType === 'c4a-standard-16')).toMatchObject({ capacity: 48, saturatedAt: { n: 64, reason: 'oom_kill=1' } });
  });

  it('reports the share of tool-diverged replays at the capacity step, so a capacity resting on unfaithful replays is visible', () => {
    vm('e2-standard-8', 'mixed-normal', [end('mixed-normal', 4, 'OK'), end('mixed-normal', 8, 'SATURATED reason=wallSlowdown=1.90')], {
      n: 4,
      cores: 2,
      anonMb: 100,
      peaksMiB: [512, 512, 1024, 1024],
      toolDiverged: 1,
    });
    const [row] = buildTable(root, 120);
    expect(row.toolDivergedShare).toBeCloseTo(0.25, 9);
    expect(renderMarkdown([row])).toMatch(/\| mixed-normal \| 4 \| 8 \(wallSlowdown=1\.90\) \| 1\.40 \| 25 \|/);
    // No sessions captured at the capacity step: unknown, never 0.
    vm('e2-standard-4', 'mixed-normal', [end('mixed-normal', 1, 'OK')]);
    const unknown = buildTable(root, 120).find((r) => r.machineType === 'e2-standard-4');
    expect(unknown?.toolDivergedShare).toBeNull();
  });

  it('takes capacity from the last step that passed before the first SATURATED one, and measures at that step', () => {
    vm('e2-standard-4', 'mixed-normal', [end('mixed-normal', 1, 'OK'), end('mixed-normal', 2, 'OK'), end('mixed-normal', 4, 'SATURATED reason=wallSlowdown=1.80')], {
      n: 2,
      cores: 2,
      anonMb: 200,
      peaksMiB: [1024, 3072],
    });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ machineType: 'e2-standard-4', label: 'mixed-normal', capacity: 2, censored: false, saturatedAt: { n: 4, reason: 'wallSlowdown=1.80' }, wallSlowdown: 1.2 });
    expect(row.coresPerAgent).toBeCloseTo(1, 6); // 2 cores across 2 agents
    expect(row.sliceAnonMbPerAgent).toBeCloseTo(100, 6); // p95 anon net of the 100 MB t0, per agent
    expect(row.sessionPeakMiB).toEqual({ p50: 1024, p95: 3072 });
    expect(row.usdPerAgentMonth).toBeCloseTo((hourlyPriceUsd('e2-standard-4', 120) * 730) / 2, 9);
    // Spot prices the same capacity at the measured spot rate; it never changes the capacity.
    expect(row.usdPerAgentMonthSpot).toBeCloseTo((hourlyPriceUsd('e2-standard-4', 120, { spot: true }) * 730) / 2, 9);
    expect(row.usdPerAgentMonthSpot!).toBeLessThan(row.usdPerAgentMonth!);
    expect(renderMarkdown([row])).toMatch(/\| e2-standard-4 \| mixed-normal \| 2 \| 4 \(wallSlowdown=1\.80\) \|/);
    expect(renderMarkdown([row])).toMatch(/\| spot \$\/agent-month \|/);
  });

  it('marks a ramp that never saturated as censored: capacity is a floor and the cost an upper bound', () => {
    vm('e2-standard-32', 'claude-normal', [end('claude-normal', 1, 'OK'), end('claude-normal', 2, 'OK')], { n: 2, cores: 1, anonMb: 50, peaksMiB: [512] });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 2, censored: true, saturatedAt: null });
    expect(row.usdPerAgentMonth).not.toBeNull();
    const md = renderMarkdown([row]);
    expect(md).toMatch(/\| ≥2 \| never \|/);
    expect(md).toMatch(/\| ≤\d+\.\d{2} \|$/m);
  });

  it('gives capacity 0 and no cost when the first step saturates, and never reads a later OK step', () => {
    vm('e2-standard-4', 'mixed-heavy', [end('mixed-heavy', 1, 'SATURATED reason=oom_kill=1'), end('mixed-heavy', 2, 'OK')]);
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 0, censored: false, saturatedAt: { n: 1, reason: 'oom_kill=1' }, coresPerAgent: null, sessionPeakMiB: null, usdPerAgentMonth: null });
    expect(renderMarkdown([row]).split('\n')[2]).toMatch(/\| — \|$/);
  });

  it('parses only RAMP_STEP_END lines, keeping the saturation reason and slowdown', () => {
    const steps = parseRampLog(['noise', end('a-b', 8, 'OK'), end('a-b', 16, 'SATURATED reason=driver-rc=1,failed=2')].join('\n'));
    expect(steps).toEqual([
      { label: 'a-b', n: 8, ok: true, underdriven: false, reason: null, wallSlowdown: 1.8, achieved: null },
      { label: 'a-b', n: 16, ok: false, underdriven: false, reason: 'driver-rc=1,failed=2', wallSlowdown: 1.16, achieved: null },
    ]);
  });

  // D-020: the lever ramp passed n=96 on e2-custom-16-32768 while only 73.2 sessions were ever in
  // flight and throughput was flat from n=64, and the table priced it at 96 agents. Every
  // per-agent figure now divides by the sessions actually held in flight.
  it('prices by the sessions actually held in flight (achieved), never by idle slots', () => {
    const line = (n: number, achieved: string) =>
      `RAMP_STEP_END p005-mixed-normal-n${n} n=${n} rc=0 OK runs=341 wallSlowdown=0.88 diverged=0 toolDiverged=0 achieved=${achieved} setupMsP50=155 2026-10-01T11:19:11Z`;
    vm('e2-custom-16-32768', 'mixed-normal', [line(64, '63.1/64'), line(96, '73.2/96')], { n: 96, cores: 14.64, anonMb: 7320, peaksMiB: [400] });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 96, censored: true, activeAgents: 73.2, wallSlowdown: 0.88 });
    expect(row.usdPerAgentMonth).toBeCloseTo((hourlyPriceUsd('e2-custom-16-32768', 120) * 730) / 73.2, 9);
    expect(row.usdPerAgentMonthSpot).toBeCloseTo((hourlyPriceUsd('e2-custom-16-32768', 120, { spot: true }) * 730) / 73.2, 9);
    expect(row.coresPerAgent).toBeCloseTo(14.64 / 73.2, 6);
    expect(row.sliceAnonMbPerAgent).toBeCloseTo(7320 / 73.2, 6);
    expect(renderMarkdown([row])).toMatch(/\| 400\/400 \| 73\.2 \|/);
    // A log without the field (older ramps) falls back to N; an achieved above N is capped at N.
    expect(parseRampLog(line(64, '63.1/64'))[0].achieved).toBe(63.1);
    vm('e2-standard-8', 'mixed-normal', [end('mixed-normal', 4, 'OK'), line(8, '8.4/8')], { n: 8, cores: 1, anonMb: 80, peaksMiB: [400] });
    const capped = buildTable(root, 120).find((r) => r.machineType === 'e2-standard-8');
    expect(capped?.activeAgents).toBe(8);
    vm('e2-standard-4', 'mixed-normal', [end('mixed-normal', 2, 'OK')], { n: 2, cores: 1, anonMb: 80, peaksMiB: [400] });
    expect(buildTable(root, 120).find((r) => r.machineType === 'e2-standard-4')?.activeAgents).toBe(2);
  });

  // WI-10004380 (t2d-standard-16): n96 passed the ramp's rule but held fewer sessions than n80 and did
  // less work. The capacity step is the peak, it is measured there, and the ramp is not censored.
  it('takes capacity from the pass that held the most sessions, not the last pass, and marks the peak', () => {
    const line = (n: number, achieved: string) =>
      `RAMP_STEP_END p005-mixed-normal-n${n} n=${n} rc=0 OK runs=400 wallSlowdown=0.72 diverged=0 toolDiverged=0 achieved=${achieved} setupMsP50=84 2026-10-02T00:56:56Z`;
    vm('t2d-standard-16', 'mixed-normal', [line(64, '63.3/64'), line(80, '78.0/80'), line(96, '73.5/96')], { n: 80, cores: 15.1, anonMb: 30000, peaksMiB: [700] });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 80, censored: false, activeAgents: 78, peakedAt: { n: 96, achieved: 73.5 }, saturatedAt: null });
    expect(row.usdPerAgentMonth).toBeCloseTo((hourlyPriceUsd('t2d-standard-16', 120) * 730) / 78, 9);
    expect(row.coresPerAgent).toBeCloseTo(15.1 / 78, 6);
    const md = renderMarkdown([row]).split('\n')[2];
    expect(md).toContain('| 80 | peaked (n96 passed holding 73.5) |');
    expect(md).not.toMatch(/[≥≤]/);
    // Ties keep the smaller N: a later pass holding the same count adds slots, not capacity.
    vm('c4a-standard-16', 'mixed-normal', [line(48, '47.0/48'), line(56, '47.0/56')], { n: 48, cores: 9, anonMb: 9000, peaksMiB: [700] });
    expect(buildTable(root, 120).find((r) => r.machineType === 'c4a-standard-16')).toMatchObject({ capacity: 48, peakedAt: { n: 56, achieved: 47 } });
  });

  // WI-10004672: a step that never held N sessions measured the driver, so it neither passes nor
  // saturates. Capacity stops at the last real pass, as a floor, and the table says why.
  it('treats an UNDERDRIVEN step as unmeasured: capacity is the last pass, censored, never a saturation', () => {
    vm('e2-standard-32', 'mixed-normal', [end('mixed-normal', 8, 'OK'), end('mixed-normal', 16, 'UNDERDRIVEN achieved=12.7/16'), end('mixed-normal', 32, 'OK')], {
      n: 8,
      cores: 1,
      anonMb: 80,
      peaksMiB: [400],
    });
    const [row] = buildTable(root, 120);
    expect(row).toMatchObject({ capacity: 8, censored: true, saturatedAt: null, underdrivenAt: { n: 16, reason: 'achieved=12.7/16' } });
    const md = renderMarkdown([row]);
    expect(md).toMatch(/\| ≥8 \| not measured past 8 \(underdriven at 16, achieved=12\.7\/16\) \|/);
    expect(parseRampLog(end('a', 16, 'UNDERDRIVEN achieved=12.7/16'))).toEqual([
      { label: 'a', n: 16, ok: false, underdriven: true, reason: 'achieved=12.7/16', wallSlowdown: 1.16, achieved: 12.7 },
    ]);
  });
});
