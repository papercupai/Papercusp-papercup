import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// tenant-density-analyze.py turns a tenant-density.sh evidence dir (fp-<tenant>.jsonl from
// sample-footprint.py, host.log from host-sampler.sh) into per-tenant footprint lines (WI-10006497).
// The fixture is built in those producers' exact shapes, with values chosen so no expected figure
// sits on a rounding half.
const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated copy (copy-out mode).
const ANALYZER = process.env.TENANT_DENSITY_ANALYZE_PATH ?? join(HERE, 'tenant-density-analyze.py');
const TMP = mkdtempSync(join(tmpdir(), 'tenant-density-analyze-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const GIB = 1024 ** 3;
const MIB_KB = 1024; // anon_kb per MiB
type Proc = { cls: string; anon_kb: number };
type Tenant = { cpuUsec: (t: number) => number; mem: (t: number) => number; anon: number; procs: Proc[] };

// Samples every 300 s over 30 min, as sample-footprint.py --interval would write them.
function fpLines(t: Tenant): string[] {
  const lines = [JSON.stringify({ header: { cgroup: '/sys/fs/cgroup/fake', interval: 300 } }), 'not json'];
  for (let t0 = 0; t0 <= 1800; t0 += 300) {
    lines.push(JSON.stringify({
      t: 1_791_000_000 + t0,
      cg: {
        mem: Math.round(t.mem(t0) * GIB), anon: Math.round(t.anon * GIB), file: Math.round(0.3 * GIB),
        shmem: Math.round(0.1 * GIB), kernel: Math.round(0.1 * GIB), cpu_usec: t.cpuUsec(t0),
      },
      host: {},
      procs: t.procs,
    }));
  }
  return lines;
}

// 3 cores for the first 5 min (boot), then 0.05 cores: settles at minute 5.
const bootThenIdle = (t: number) => (t === 0 ? 0 : 900e6 + ((t - 300) / 300) * 15e6);
const TENANTS: Record<string, Tenant> = {
  pct1: {
    cpuUsec: bootThenIdle, mem: (t) => (t === 300 ? 2 : 1.5), anon: 1,
    procs: [{ cls: 'node:serve.mjs', anon_kb: 512 * MIB_KB }, { cls: 'postgres', anon_kb: 256 * MIB_KB }],
  },
  pct2: {
    cpuUsec: (t) => t * 1e6, mem: () => 2.5, anon: 2,
    procs: [{ cls: 'node:serve.mjs', anon_kb: 1024 * MIB_KB }, { cls: 'claude', anon_kb: 900 * MIB_KB }],
  },
  pct10: {
    cpuUsec: bootThenIdle, mem: () => 1, anon: 0.5,
    procs: [{ cls: 'node:serve.mjs', anon_kb: 400 * MIB_KB }, { cls: 'postgres', anon_kb: 100 * MIB_KB }],
  },
};
const kb = (gib: number) => Math.round((gib * GIB) / 1024);
const HOST_LOG = [
  `2026-10-06T10:00:00Z MemTotal:=${kb(15.6)} MemAvailable:=${kb(10)} SwapTotal:=0 SwapFree:=0 load=0.50,0.40,0.30`,
  'garbage line',
  `2026-10-06T10:00:30Z MemTotal:=${kb(15.6)} MemAvailable:=${kb(5)} SwapTotal:=0 SwapFree:=0 load=3.25,1.00,0.50`,
  `2026-10-06T10:01:00Z MemTotal:=${kb(15.6)} MemAvailable:=${kb(7)} SwapTotal:=0 SwapFree:=0 load=1.00,1.00,0.80`,
];
const RUN_LOG = [
  'STEP_START K=4 2026-10-06T10:00:00Z',
  'STEP_END K=4 memAvailableGiB=9 2026-10-06T10:30:00Z',
  'STEP_END K=8 memAvailableGiB=5 2026-10-06T11:00:00Z',
  'STOP_LOW_MEM avail=5GiB at K=8',
];

let seq = 0;
function evidence(tenants: Record<string, Tenant>, host = HOST_LOG): string {
  const dir = join(TMP, `ev-${seq++}`);
  mkdirSync(dir);
  for (const [name, t] of Object.entries(tenants)) writeFileSync(join(dir, `fp-${name}.jsonl`), fpLines(t).join('\n') + '\n');
  writeFileSync(join(dir, 'host.log'), host.join('\n') + '\n');
  writeFileSync(join(dir, 'unrelated.txt'), 'ignored\n');
  return dir;
}
function analyze(args: string[]): { status: number | null; out: string[]; err: string } {
  const r = spawnSync('python3', [ANALYZER, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim().split('\n'), err: r.stderr };
}

describe('vm/tenant-density-analyze.py', () => {
  it('reports each tenant in numeric order with its memory, CPU, settle point and settled flag', () => {
    const r = analyze([evidence(TENANTS)]);
    expect(r.status).toBe(0);
    expect(r.out.filter((l) => l.startsWith('TENANT '))).toEqual([
      'TENANT name=pct1 life_min=30 mem_gib=1.50 anon_gib=1.00 file_gib=0.30 shmem_gib=0.10 kernel_gib=0.10 peak_gib=2.00 serve_anon_gib=0.50 life_cores=0.54 tail_cores=0.05 settle_min=5 settled=1',
      'TENANT name=pct2 life_min=30 mem_gib=2.50 anon_gib=2.00 file_gib=0.30 shmem_gib=0.10 kernel_gib=0.10 peak_gib=2.50 serve_anon_gib=1.00 life_cores=1.00 tail_cores=1.00 settle_min=none settled=0',
      'TENANT name=pct10 life_min=30 mem_gib=1.00 anon_gib=0.50 file_gib=0.30 shmem_gib=0.10 kernel_gib=0.10 peak_gib=1.00 serve_anon_gib=0.39 life_cores=0.54 tail_cores=0.05 settle_min=5 settled=1',
    ]);
    expect(r.out.at(-1)).toBe('TOTAL tenants=3 mem_gib=5.00');
  });

  it('averages only settled tenants, and ranks process classes over them alone', () => {
    const r = analyze([evidence(TENANTS)]);
    expect(r.out).toContain('SETTLED_MEAN n=2 mem_gib=1.25 anon_gib=0.75 serve_anon_gib=0.45');
    expect(r.out.filter((l) => l.startsWith('CLASS '))).toEqual([
      'CLASS name=node:serve.mjs mean_anon_gib=0.445 n=2',
      'CLASS name=postgres mean_anon_gib=0.174 n=2',
    ]);
  });

  it('summarises host MemAvailable from host.log and the per-step readings from the driver run.log', () => {
    const run = join(TMP, `run-${seq++}.log`);
    writeFileSync(run, RUN_LOG.join('\n') + '\n');
    const r = analyze([evidence(TENANTS), '--run-log', run]);
    expect(r.out).toContain('HOST samples=3 first_avail_gib=10.00 min_avail_gib=5.00 last_avail_gib=7.00 max_load1=3.25');
    expect(r.out.filter((l) => l.startsWith('STEP '))).toEqual(['STEP K=4 memAvailableGiB=9', 'STEP K=8 memAvailableGiB=5']);
  });

  it('a --group compares the named tenants; an unknown member is skipped, not invented', () => {
    const r = analyze([evidence(TENANTS), '--group', 'unload-off=pct2,pct99']);
    expect(r.out).toContain('GROUP_MEAN name=unload-off n=1 mem_gib=2.50 anon_gib=2.00 serve_anon_gib=1.00');
  });

  it('says HOST samples=0 when host.log has no sample line', () => {
    const r = analyze([evidence({ pct1: TENANTS.pct1 }, ['no samples here'])]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('HOST samples=0');
  });

  it('exits 2 when the evidence dir holds no footprint sample, or is not a directory', () => {
    const empty = join(TMP, `empty-${seq++}`);
    mkdirSync(empty);
    writeFileSync(join(empty, 'fp-pct1.jsonl'), JSON.stringify({ header: {} }) + '\n');
    const r = analyze([empty]);
    expect(r.status).toBe(2);
    expect(r.err).toContain('no fp-*.jsonl samples');
    expect(analyze([join(TMP, 'nope')]).status).toBe(2);
    expect(analyze([]).status).toBe(2);
    expect(analyze([empty, '--group']).status).toBe(2);
  });
});
