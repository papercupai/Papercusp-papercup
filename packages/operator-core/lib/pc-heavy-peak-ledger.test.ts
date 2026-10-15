/**
 * WI-10005184: pc-heavy's per-slot memory reserve was a fixed 14 GiB because an
 * admitted job runs in its CALLER's cgroup, so nothing measured what one job
 * actually used. The preemptible monitor now walks the job's own process tree
 * and appends one peak line per job to a bounded ledger
 * (<PC_HEAVY_DIR>/job-peaks.tsv), which a later slice derives the reserve from.
 *
 * The derive half: with PC_HEAVY_MEM_PER_SLOT_GIB unset, the admission clamp
 * reads the ledger and budgets max-of-recent-peaks + 10% per slot.
 *
 * The property guarded first is that the measurement covers the WHOLE job tree:
 * the allocation happens in a grandchild, and the leader alone holds far less
 * than the asserted floor, so a leader-only (or cgroup-of-the-caller)
 * measurement fails the first test.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTextCollector } from './child-output';
import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pc-heavy-peak-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Peak = {
  at: number; anonMib: number; rssMib: number; samples: number; secs: number; exit: number;
  jobClass: string | undefined; label: string;
};

function readLedger(path: string): Peak[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => {
    // class= (WI-10005334) is present when the admitting wrapper classified the job.
    const m = /^at=(\d+) anon_mib=(\d+) rss_mib=(\d+) samples=(\d+) secs=(\d+) exit=(\d+) (?:class=(\S+) )?label=(.*)$/.exec(line);
    if (!m) throw new Error(`unparseable ledger line: ${line}`);
    return {
      at: Number(m[1]), anonMib: Number(m[2]), rssMib: Number(m[3]), samples: Number(m[4]),
      secs: Number(m[5]), exit: Number(m[6]), jobClass: m[7], label: m[8],
    };
  });
}

/** Drive the real asynchronous monitor directly, outside the host's admission queue. */
function monitored(command: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, '--pc-heavy-internal-preempt-run',
    String(process.pid), join(dir, 'exclusive-intent'), ...command], {
    ...pcHeavyFixtureOptions(dir, {
      PATH: process.env.PATH ?? '',
      PC_HEAVY_NO_SELF_COPY: '1',
      PC_HEAVY_PREEMPT_PID_DIR: dir,
      PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
      PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
      PC_HEAVY_PSI_ADMISSION: '0',
      PC_HEAVY_PEAK_SAMPLE_SEC: '1',
      ...env,
    }), encoding: 'utf8', timeout: 20_000,
  });
}

/** A node leader that spawns a child which holds `mib` of touched memory for `holdMs`. */
function allocatingTree(mib: number, holdMs: number): string[] {
  const grandchild = `const b=Buffer.alloc(${mib}*1024*1024,1);setTimeout(()=>{process.stdout.write(String(b[1]))},${holdMs})`;
  const leader = `const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.exit(r.status??1)`;
  return [process.execPath, '-e', leader];
}

describe.skipIf(process.platform !== 'linux')('pc-heavy per-job peak ledger (WI-10005184)', () => {
  it('records the peak of the whole job tree, not just the leader', () => {
    const run = monitored(allocatingTree(192, 2500), { PC_HEAVY_PEAK_LABEL: 'tree probe' });
    expect(run.status, run.stderr).toBe(0);
    const peaks = readLedger(join(dir, 'job-peaks.tsv'));
    expect(peaks).toHaveLength(1);
    const [peak] = peaks;
    // The leader alone holds well under 150 MiB anonymous; only the grandchild's
    // 192 MiB buffer can lift the sum past this floor.
    expect(peak.anonMib).toBeGreaterThanOrEqual(150);
    expect(peak.rssMib).toBeGreaterThanOrEqual(peak.anonMib);
    expect(peak.samples).toBeGreaterThanOrEqual(2);
    expect(peak.exit).toBe(0);
    expect(peak.label).toBe('tree probe');
  }, 30_000);

  it('records a killed job with its exit status, so an OOM-shaped death still leaves a peak', () => {
    const run = monitored([process.execPath, '-e',
      "const b=Buffer.alloc(64*1024*1024,1);setTimeout(()=>process.kill(process.pid,'SIGKILL'),1500)"]);
    expect(run.status).toBe(137);
    const [peak] = readLedger(join(dir, 'job-peaks.tsv'));
    expect(peak?.exit).toBe(137);
    expect(peak?.anonMib).toBeGreaterThanOrEqual(48);
  }, 30_000);

  it.each([[''], ['0'], ['off']])('writes nothing when PC_HEAVY_PEAK_LEDGER=%j', (value) => {
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'], { PC_HEAVY_PEAK_LEDGER: value });
    expect(run.status, run.stderr).toBe(0);
    expect(existsSync(join(dir, 'job-peaks.tsv'))).toBe(false);
  }, 30_000);

  it('honours an explicit ledger path', () => {
    const ledger = join(dir, 'nested', 'peaks.tsv');
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'], { PC_HEAVY_PEAK_LEDGER: ledger });
    expect(run.status, run.stderr).toBe(0);
    expect(readLedger(ledger)).toHaveLength(1);
  }, 30_000);

  it('trims the ledger back to PC_HEAVY_PEAK_LEDGER_MAX once it reaches twice that', () => {
    const ledger = join(dir, 'job-peaks.tsv');
    const old = [1, 2, 3].map((n) => `at=${n} anon_mib=${n} rss_mib=${n} samples=1 secs=1 exit=0 label=old-${n}`);
    writeFileSync(ledger, `${old.join('\n')}\n`);
    const run = monitored([process.execPath, '-e', 'setTimeout(()=>{},300)'],
      { PC_HEAVY_PEAK_LEDGER_MAX: '2', PC_HEAVY_PEAK_LABEL: 'newest' });
    expect(run.status, run.stderr).toBe(0);
    const peaks = readLedger(ledger);
    expect(peaks.map((p) => p.label)).toEqual(['old-3', 'newest']);
  }, 30_000);

  describe('derived per-class memory reserve (WI-10005334)', () => {
    /**
     * Admission with a fixed 6-slot ask against 28 GiB free; PC_HEAVY_DEBUG prints the decision.
     * `true` ignores its arguments, so `['true', 'tsc']` is a typecheck-classified job that runs nothing.
     */
    function admit(env: Record<string, string> = {}, command: string[] = ['true']) {
      const run = spawnSync('bash', [SCRIPT, '--', ...command], {
        ...pcHeavyFixtureOptions(dir, {
          PATH: process.env.PATH ?? '',
          PC_HEAVY_NO_SELF_COPY: '1',
          PC_HEAVY_DIR: dir,
          PC_HEAVY_DEBUG: '1',
          PC_HEAVY_SLOTS: '6',
          PC_HEAVY_IONICE: '',
          PC_HEAVY_PREEMPTIBLE: '0',
          PC_HEAVY_PSI_ADMISSION: '0',
          PC_HEAVY_MEM_PSI_OVERRIDE: '0',
          PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '28',
          ...env,
        }), encoding: 'utf8', timeout: 20_000,
      });
      expect(run.status, run.stderr).toBe(0);
      const m = new RegExp(String.raw`\[pc-heavy\] slots=(\d+) .* mem_per_slot=(\d+)GiB source=(\S+)`
        + String.raw` mem_admission=(\S+) class=(\S+) reserve_typecheck=(\d+)GiB:(\S+) reserve_other=(\d+)GiB:(\S+)`).exec(run.stderr);
      if (!m) throw new Error(`no debug decision line in:\n${run.stderr}`);
      return {
        slots: Number(m[1]), perSlotGib: Number(m[2]), source: m[3], mode: m[4], jobClass: m[5],
        typecheck: { gib: Number(m[6]), source: m[7] }, other: { gib: Number(m[8]), source: m[9] },
      };
    }
    /** Rows one hour apart by default, so 12 rows span 11 h. `cls` writes the class= field newer rows carry. */
    function seed(rows: Array<{ anon: number; samples?: number; label?: string; cls?: string }>, stepSec = 3600) {
      writeFileSync(join(dir, 'job-peaks.tsv'), rows.map((r, i) =>
        `at=${1_790_000_000 + i * stepSec} anon_mib=${r.anon} rss_mib=${r.anon} samples=${r.samples ?? 5} secs=10 exit=0`
        + `${r.cls ? ` class=${r.cls}` : ''} label=${r.label ?? 'seeded'}`,
      ).join('\n') + '\n');
    }
    // These cases exercise the statistic, so the one-day cold-start span is
    // lowered to what the seeded rows cover; the span itself has its own case.
    const SPAN = { PC_HEAVY_MEM_PER_SLOT_MIN_SPAN_SEC: '3600' };
    const TSC = { label: 'npx tsc operator-core' };
    const VITEST = { label: 'npx vitest run' };

    it('keeps each class at its own constant until the ledger spans a full day (cold-start guard)', () => {
      // 39 installs inside one hour is exactly the dev tower's first ledger (2026-10-02).
      seed(Array.from({ length: 39 }, () => ({ anon: 3595, label: 'npm install' })), 60);
      // Headroom admission does not clamp the slot COUNT by memory, so slots stays at the 6 asked.
      expect(admit()).toEqual({
        slots: 6, perSlotGib: 4, source: 'default', mode: 'headroom', jobClass: 'other',
        typecheck: { gib: 14, source: 'default' }, other: { gib: 4, source: 'default' },
      });
      seed(Array.from({ length: 39 }, () => ({ anon: 3595, label: 'npm install' })), 2400); // ~25 h
      expect(admit()).toMatchObject({
        typecheck: { gib: 14, source: 'default' }, other: { gib: 4, source: 'derived:q100-of-3595MiB' },
      });
      // Too little history to loosen on is still enough to TIGHTEN: a wrapper
      // script that hid a 15 GiB compile as `other` lifts that class above its
      // 4 GiB constant at once. ceil(15000 * 1.1 / 1024) = 17 GiB.
      seed([
        ...Array.from({ length: 3 }, () => ({ anon: 15_000, label: 'bash wrapper.sh' })),
        { anon: 9000, ...TSC },
      ], 60);
      expect(admit()).toMatchObject({
        typecheck: { gib: 14, source: 'default' }, other: { gib: 17, source: 'cold-start-max:15000MiB' },
      });
    }, 30_000);

    it('derives a separate reserve per class from a mixed ledger, and sizes each job by its own class', () => {
      // Interleaved, as a real host runs them: 12 compiles peaking at most 9,300 MiB, 12 test runs at most 900 MiB.
      seed(Array.from({ length: 24 }, (_, i) => (i % 2 === 0
        ? { anon: 8200 + (i / 2) * 100, ...TSC }
        : { anon: 350 + ((i - 1) / 2) * 50, ...VITEST })));
      // ceil(9300 * 1.1 / 1024) = 10 GiB; ceil(900 * 1.1 / 1024) = 1 GiB. Before WI-10005334 both were 10.
      const reserves = {
        typecheck: { gib: 10, source: 'derived:q100-of-9300MiB' }, other: { gib: 1, source: 'derived:q100-of-900MiB' },
      };
      expect(admit(SPAN)).toEqual({
        slots: 6, perSlotGib: 1, source: 'derived:q100-of-900MiB', mode: 'headroom', jobClass: 'other', ...reserves,
      });
      expect(admit(SPAN, ['true', 'tsc'])).toMatchObject({
        perSlotGib: 10, source: 'derived:q100-of-9300MiB', jobClass: 'typecheck', ...reserves,
      });
      // A script handed to `sh -c` is split into words, so a wrapped compile still classifies.
      expect(admit(SPAN, ['bash', '-c', 'npx() { return 0; }; npx tsgo --noEmit -p x'])).toMatchObject({ jobClass: 'typecheck' });
    }, 30_000);

    it('an explicit class= field outranks the label; older rows fall back to the label words', () => {
      seed([
        // A wrapper script whose compile is invisible in its label, recorded by a classifying wrapper.
        ...Array.from({ length: 6 }, () => ({ anon: 9000, cls: 'typecheck', label: 'bash wrapper.sh' })),
        // Rows written before WI-10005334 carry no class; `lint:tsc` in the label marks them as compiles.
        ...Array.from({ length: 6 }, () => ({ anon: 9500, label: 'npm run lint:tsc' })),
        // A tsc word in the label must not reclassify a row that says what it was.
        ...Array.from({ length: 12 }, () => ({ anon: 500, cls: 'other', label: 'npx tsc-looking tsc' })),
      ]);
      expect(admit(SPAN)).toMatchObject({
        typecheck: { gib: 11, source: 'derived:q100-of-9500MiB' }, other: { gib: 1, source: 'derived:q100-of-500MiB' },
      });
    }, 30_000);

    it('keeps a class at its constant below the minimum job count while the other class derives', () => {
      seed([
        ...Array.from({ length: 9 }, () => ({ anon: 9000, ...TSC })),
        ...Array.from({ length: 12 }, () => ({ anon: 1000, ...VITEST })),
      ]);
      expect(admit(SPAN)).toMatchObject({
        typecheck: { gib: 14, source: 'default' }, other: { gib: 2, source: 'derived:q100-of-1000MiB' },
      });
    }, 30_000);

    it('raises a class reserve above its constant when the host really runs bigger jobs', () => {
      seed(Array.from({ length: 12 }, () => ({ anon: 20_000, ...TSC })));
      // ceil(20000 * 1.1 / 1024) = 22 GiB.
      expect(admit(SPAN, ['true', 'tsc'])).toMatchObject({ perSlotGib: 22, typecheck: { gib: 22 } });
    }, 30_000);

    it('ignores single-sample rows and words inside the label', () => {
      seed([
        ...Array.from({ length: 12 }, () => ({ anon: 1000, label: 'tsc anon_mib=900000 samples=9' })),
        { anon: 900_000, samples: 1, label: 'tsc' },
      ]);
      expect(admit(SPAN)).toMatchObject({ typecheck: { gib: 2, source: 'derived:q100-of-1000MiB' } });
    }, 30_000);

    it('an explicit PC_HEAVY_MEM_PER_SLOT_GIB keeps the count clamp at that size for every class', () => {
      seed(Array.from({ length: 12 }, () => ({ anon: 1000, ...VITEST })));
      // 28 / 7 => 4 slots, exactly as before per-class reserves existed (hosted hosts pin this).
      expect(admit({ PC_HEAVY_MEM_PER_SLOT_GIB: '7' })).toEqual({
        slots: 4, perSlotGib: 7, source: 'env', mode: 'count', jobClass: 'other',
        typecheck: { gib: 7, source: 'env' }, other: { gib: 7, source: 'env' },
      });
      expect(admit({ ...SPAN, PC_HEAVY_PEAK_LEDGER: 'off' })).toMatchObject({
        mode: 'headroom', typecheck: { gib: 14, source: 'default' }, other: { gib: 4, source: 'default' },
      });
    }, 30_000);

    it('PC_HEAVY_MEM_ADMISSION=count restores one reserve (the larger class) for every slot; PC_HEAVY_MEM_CLAMP=0 turns memory admission off', () => {
      seed(Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? { anon: 9300, ...TSC } : { anon: 900, ...VITEST })));
      // An `other` job still budgets the compile's 10 GiB: 28 / 10 => 2 slots.
      expect(admit({ ...SPAN, PC_HEAVY_MEM_ADMISSION: 'count' })).toMatchObject({
        slots: 2, perSlotGib: 10, source: 'derived:q100-of-9300MiB', mode: 'count', jobClass: 'other',
      });
      expect(admit({ ...SPAN, PC_HEAVY_MEM_CLAMP: '0' })).toMatchObject({ slots: 6, mode: 'off' });
    }, 30_000);

    it('applies a lower quantile when asked', () => {
      seed(Array.from({ length: 10 }, (_, i) => ({ anon: (i + 1) * 1000, ...VITEST })));
      // q50 of 1000..10000 is the 5th value, 5000 MiB => ceil(5000 * 1.1 / 1024) = 6 GiB.
      expect(admit({ ...SPAN, PC_HEAVY_MEM_PER_SLOT_QUANTILE: '50' })).toMatchObject({
        perSlotGib: 6, source: 'derived:q50-of-5000MiB',
      });
    }, 30_000);
  });

  it('publishes a running job\'s live anonymous memory beside its reserve record, then the record goes stale on exit', async () => {
    const reserves = join(dir, 'reserves');
    const child = spawn('bash', [SCRIPT, '--', ...allocatingTree(192, 4000)], {
      ...pcHeavyFixtureOptions(dir, {
        PATH: process.env.PATH ?? '',
        PC_HEAVY_NO_SELF_COPY: '1',
        PC_HEAVY_DIR: dir,
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_IONICE: '',
        PC_HEAVY_PREEMPTIBLE: '1',
        PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
        PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
        PC_HEAVY_PSI_ADMISSION: '0',
        PC_HEAVY_PEAK_SAMPLE_SEC: '1',
        PC_HEAVY_MEM_PSI_OVERRIDE: '0',
        PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
        PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
        PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '100',
      }), stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderrText = createTextCollector(child.stderr);
    const exited = new Promise<number>((res) => child.on('exit', (code) => res(code ?? -1)));
    let seen: { record: string; anonMib: number } | undefined;
    for (let i = 0; i < 80 && !seen; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (!existsSync(reserves)) continue;
      for (const name of readdirSync(reserves).filter((n) => n.startsWith('anon.'))) {
        const anonMib = Number(readFileSync(join(reserves, name), 'utf8').trim());
        if (anonMib >= 150) {
          seen = { record: readFileSync(join(reserves, `rec.${name.slice('anon.'.length)}`), 'utf8'), anonMib };
        }
      }
    }
    const code = await exited;
    const stderr = stderrText.peek();
    expect(code, stderr).toBe(0);
    // The only allocation is the grandchild's 192 MiB buffer, so the leader alone cannot reach 150.
    expect(seen?.anonMib, stderr).toBeGreaterThanOrEqual(150);
    // An empty ledger: a node command is `other`, sized at the 4 GiB cold-start constant.
    expect(seen?.record).toMatch(/^class=other reserve_mib=4096 pid=\d+$/m);
    const [peak] = readLedger(join(dir, 'job-peaks.tsv'));
    expect(peak?.jobClass).toBe('other');
  }, 30_000);

  it('labels a job from its command words through the ordinary admission route, without leaking the label to the job', () => {
    const job = join(dir, 'probe-job.sh');
    writeFileSync(job, '#!/usr/bin/env bash\necho "LABEL_ENV=${PC_HEAVY_PEAK_LABEL-unset}"\n'
      + 'echo "CLASS_ENV=${PC_HEAVY_PEAK_CLASS-unset} ANON_ENV=${PC_HEAVY_RESERVE_ANON_FILE-unset}"\nsleep 1.2\n');
    const runJob = (args: string[]) => spawnSync('bash', [SCRIPT, '--', 'bash', job, ...args], {
      ...pcHeavyFixtureOptions(dir, {
        PATH: process.env.PATH ?? '',
        PC_HEAVY_NO_SELF_COPY: '1',
        PC_HEAVY_DIR: dir,
        PC_HEAVY_SLOTS: '1',
        PC_HEAVY_IONICE: '',
        PC_HEAVY_PREEMPTIBLE: '1',
        PC_HEAVY_PREEMPT_EXCLUSIVE: '0',
        PC_HEAVY_PREEMPT_POLL_SEC: '0.02',
        PC_HEAVY_PSI_ADMISSION: '0',
        PC_HEAVY_PEAK_SAMPLE_SEC: '1',
        PC_HEAVY_MEM_PSI_OVERRIDE: '0',
        PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
        PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
        PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '100',
      }), encoding: 'utf8', timeout: 20_000,
    });
    const run = runJob(['--verbose', 'first', 'second']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('LABEL_ENV=unset');
    // The monitor's private inputs never reach the workload either.
    expect(run.stdout).toContain('CLASS_ENV=unset ANON_ENV=unset');
    // A `tsc` word anywhere in the argv marks the job as a compile (WI-10005334).
    const compile = runJob(['tsc']);
    expect(compile.status, compile.stderr).toBe(0);
    const [peak, compilePeak] = readLedger(join(dir, 'job-peaks.tsv'));
    // Options are skipped, paths reduced to basenames, and the label capped at three words.
    expect(peak?.label).toBe('bash probe-job.sh first');
    expect(peak?.jobClass).toBe('other');
    expect(compilePeak).toMatchObject({ label: 'bash probe-job.sh tsc', jobClass: 'typecheck' });
  }, 30_000);
});
