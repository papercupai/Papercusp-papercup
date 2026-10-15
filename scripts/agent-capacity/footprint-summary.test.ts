import { describe, expect, it } from 'vitest';
import { parseCapture, renderTable, stat, summarize, type Header, type ProcRow, type Sample } from './footprint-summary';

const header: Header = {
  host: 'cap-s7-a',
  label: 'unit',
  cgroup: '/sys/fs/cgroup/x',
  clk_tck: 100,
  nproc: 4,
  mem_total_kb: 16 * 1024 * 1024,
  interval: 10,
  started: 1000,
};

function proc(pid: number, cls: string, ticks: number, rssMb: number, comm = cls): ProcRow {
  return { pid, ppid: 1, comm, cls, rss_kb: rssMb * 1024, anon_kb: (rssMb / 2) * 1024, ticks };
}
function sample(t: number, cpuUsec: number, procs: ProcRow[], memMb = 100): Sample {
  return { t, cg: { cpu_usec: cpuUsec, mem: memMb * 1024 * 1024, anon: (memMb / 2) * 1024 * 1024 }, procs };
}
function jsonl(samples: Sample[], h: Header = header): string {
  return [JSON.stringify({ header: h }), ...samples.map((s) => JSON.stringify(s))].join('\n') + '\n';
}

describe('stat', () => {
  it('returns mean, nearest-rank p95 and max', () => {
    const s = stat(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(s.mean).toBe(10.5);
    expect(s.p95).toBe(19);
    expect(s.max).toBe(20);
  });
  it('is all zero for an empty series', () => {
    expect(stat([])).toEqual({ mean: 0, p95: 0, max: 0 });
  });
});

describe('parseCapture', () => {
  it('reads the header and samples, and stops at a second header from an appended re-run', () => {
    const text = jsonl([sample(0, 0, [])]) + jsonl([sample(50, 0, [])], { ...header, label: 'rerun' });
    const cap = parseCapture(text);
    expect(cap.header.label).toBe('unit');
    expect(cap.samples).toHaveLength(1);
  });
  it('refuses a capture with no header', () => {
    expect(() => parseCapture(JSON.stringify(sample(0, 0, [])))).toThrow(/no header/);
  });
});

describe('summarize', () => {
  it('computes cgroup CPU from usage_usec and per-class CPU from tick deltas, in % of one core', () => {
    // 10 s intervals. Operator burns 50 ticks/10 s = 5 %; postgres 10 ticks = 1 %.
    // The cgroup says 8 %, so 2 % came from processes not seen at both ends.
    const cap = parseCapture(
      jsonl([
        sample(0, 0, [proc(10, 'node:serve.mjs', 0, 300), proc(20, 'postgres', 0, 40)]),
        sample(10, 800_000, [proc(10, 'node:serve.mjs', 50, 300), proc(20, 'postgres', 10, 40)]),
        sample(20, 1_600_000, [proc(10, 'node:serve.mjs', 100, 300), proc(20, 'postgres', 20, 40)]),
      ]),
    );
    const s = summarize(cap);
    expect(s.totalCpuPct.mean).toBeCloseTo(8, 6);
    expect(s.unattributedCpuPct).toBeCloseTo(2, 6);
    const op = s.classes.find((c) => c.cls === 'node:serve.mjs')!;
    expect(op.cpuPct.mean).toBeCloseTo(5, 6);
    expect(op.rssMb.mean).toBe(300);
    expect(s.classes.find((c) => c.cls === 'postgres')!.cpuPct.mean).toBeCloseTo(1, 6);
    // Sorted by memory, heaviest first.
    expect(s.classes[0].cls).toBe('node:serve.mjs');
    expect(s.windowSec).toBe(20);
  });

  it('sums every process of a class (postgres backends) and counts distinct pids', () => {
    const cap = parseCapture(
      jsonl([
        sample(0, 0, [proc(20, 'postgres', 0, 40), proc(21, 'postgres', 0, 10)]),
        sample(10, 0, [proc(20, 'postgres', 0, 40), proc(22, 'postgres', 0, 12)]),
      ]),
    );
    const pg = summarize(cap).classes.find((c) => c.cls === 'postgres')!;
    expect(pg.processes).toBe(3);
    expect(pg.rssMb.mean).toBe(51);
    expect(pg.rssMb.max).toBe(52);
  });

  it('does not credit a recycled pid (different comm) with the old process ticks', () => {
    const cap = parseCapture(
      jsonl([
        sample(0, 0, [proc(30, 'git', 500, 5, 'git')]),
        sample(10, 100_000, [proc(30, 'node:worker.mjs', 510, 50, 'node')]),
      ]),
    );
    const s = summarize(cap);
    expect(s.classes.find((c) => c.cls === 'node:worker.mjs')!.cpuPct.mean).toBe(0);
    expect(s.unattributedCpuPct).toBeCloseTo(1, 6);
  });

  it('counts a short-lived class as 0 MB in the samples where it is absent', () => {
    const cap = parseCapture(
      jsonl([sample(0, 0, [proc(40, 'git', 0, 20)]), sample(10, 0, []), sample(20, 0, []), sample(30, 0, [])]),
    );
    const git = summarize(cap).classes.find((c) => c.cls === 'git')!;
    expect(git.rssMb.mean).toBe(5);
    expect(git.rssMb.max).toBe(20);
  });

  it('restricts to a --from/--to window relative to the first sample', () => {
    const cap = parseCapture(
      jsonl([
        sample(100, 0, [], 500), // boot spike
        sample(110, 5_000_000, [], 500),
        sample(120, 5_100_000, [], 200),
        sample(130, 5_200_000, [], 200),
      ]),
    );
    const steady = summarize(cap, { from: 20 });
    expect(steady.samples).toBe(2);
    expect(steady.totalCpuPct.mean).toBeCloseTo(1, 6);
    expect(steady.cgroupMemMb.mean).toBe(200);
    expect(summarize(cap).totalCpuPct.max).toBeCloseTo(50, 6);
  });

  it('renders a table naming every class', () => {
    const cap = parseCapture(jsonl([sample(0, 0, [proc(10, 'supervisor', 0, 8)]), sample(10, 0, [proc(10, 'supervisor', 1, 8)])]));
    const table = renderTable(summarize(cap));
    expect(table).toContain('supervisor | 1 |');
    expect(table).toContain('host=cap-s7-a');
  });
});

// P-015 swap lever: the sampler's swap/PSI/zram counters are cumulative, so the summary must turn
// them into per-second rates between consecutive samples and keep the levels as levels.
describe('summarize swap counters (P-015)', () => {
  const MiB = 1024 * 1024;
  function swapSample(t: number, i: number, procs: ProcRow[]): Sample {
    return {
      t,
      cg: { cpu_usec: 0, mem: 100 * MiB, swap: i * 10 * MiB, psi: { full_us: i * 50_000 } },
      host: {
        // 10 s apart: 100 pages in and 300 out per interval -> 10/s and 30/s.
        pswpin: 1000 + i * 100,
        pswpout: 2000 + i * 300,
        pgmajfault: 5000 + i * 200,
        MemAvailable_kb: (500 - i * 100) * 1024,
        SwapTotal_kb: 4096 * 1024,
        SwapFree_kb: (4096 - i * 64) * 1024,
        // 1 s of "some" and 0.25 s of "full" stall per 10 s -> 10 % and 2.5 %.
        psi: { some_us: i * 1_000_000, full_us: i * 250_000 },
        zram: { zram0: { orig: i * 400 * MiB, compr: i * 100 * MiB, used: i * 110 * MiB } },
      },
      procs,
    };
  }
  function node(pid: number, cls: string, majflt: number, swapMb: number): ProcRow {
    return { pid, ppid: 1, comm: 'MainThread', cls, rss_kb: 200 * 1024, anon_kb: 150 * 1024, ticks: 0, swap_kb: swapMb * 1024, majflt };
  }

  it('reports swap traffic, PSI and zram as rates and levels, and keeps host rows through parseCapture', () => {
    const samples = [0, 1, 2].map((i) =>
      swapSample(i * 10, i, [node(10, 'node:claude', i * 40, 100 + i * 50), node(11, 'codex', 7, 20)]),
    );
    const cap = parseCapture(jsonl(samples));
    expect(cap.samples[1].host?.pswpin).toBe(1100);
    const s = summarize(cap);
    expect(s.swap).toBeDefined();
    const w = s.swap!;
    expect(w.swapInPerSec).toEqual({ mean: 10, p95: 10, max: 10 });
    expect(w.swapOutPerSec).toEqual({ mean: 30, p95: 30, max: 30 });
    expect(w.hostMajorFaultsPerSec.mean).toBe(20);
    expect(w.hostPsiSomePct.mean).toBeCloseTo(10, 6);
    expect(w.hostPsiFullPct.mean).toBeCloseTo(2.5, 6);
    expect(w.cgroupPsiFullPct.mean).toBeCloseTo(0.5, 6);
    expect(w.hostSwapUsedMb.max).toBe(128);
    expect(w.cgroupSwapMb.max).toBe(20);
    expect(w.memAvailableMinMb).toBe(300);
    expect(w.zramUsedMb.max).toBe(220);
    expect(w.zramStoredMb.max).toBe(800);

    // Per class: claude's heap faults back in at 4/s while codex stays flat; swap is VmSwap.
    const claude = s.classes.find((c) => c.cls === 'node:claude')!;
    const codex = s.classes.find((c) => c.cls === 'codex')!;
    expect(claude.majorFaultsPerSec).toEqual({ mean: 4, p95: 4, max: 4 });
    expect(codex.majorFaultsPerSec).toEqual({ mean: 0, p95: 0, max: 0 });
    expect(claude.swapMb.max).toBe(200);
    expect(codex.swapMb.mean).toBe(20);

    const table = renderTable(s);
    expect(table).toContain('swap pages/s in / out: 10.0 / 10.0 / 10.0  /  30.0 / 30.0 / 30.0');
    expect(table).toContain('MemAvailable min MB: 300');
    expect(table).toMatch(/^node:claude \| 1 \| .* \| 150 \/ 200 \/ 200 \| 4\.0 \/ 4\.0 \/ 4\.0$/m);
  });

  it('skips a counter that went backwards (a reset or a recycled pid) instead of reporting a negative rate', () => {
    const a = swapSample(0, 2, [node(10, 'node:claude', 500, 0)]);
    const b = swapSample(10, 1, [node(10, 'node:claude', 3, 0)]);
    const s = summarize(parseCapture(jsonl([a, b])));
    expect(s.swap!.swapInPerSec).toEqual({ mean: 0, p95: 0, max: 0 });
    expect(s.classes[0].majorFaultsPerSec).toEqual({ mean: 0, p95: 0, max: 0 });
  });

  it('has no swap section for a pre-P-015 capture, and old process rows read as zero swap', () => {
    const s = summarize(parseCapture(jsonl([sample(0, 0, [proc(1, 'git', 0, 10)]), sample(10, 0, [proc(1, 'git', 5, 10)])])));
    expect(s.swap).toBeUndefined();
    expect(s.classes[0].swapMb).toEqual({ mean: 0, p95: 0, max: 0 });
    expect(renderTable(s)).not.toContain('swap pages/s');
  });
});
