import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// backfill-split.py separates joined-Server footprint samples taken during an embed-backfill
// drain from those taken between drains (WI-10005107; moved in-tree by WI-10006497).
const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated copy (copy-out mode).
const SCRIPT = process.env.BACKFILL_SPLIT_PATH ?? join(HERE, 'backfill-split.py');
const TMP = mkdtempSync(join(tmpdir(), 'backfill-split-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function py(body: string): unknown {
  const script = [
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("bs", ${JSON.stringify(SCRIPT)})`,
    'bs = importlib.util.module_from_spec(spec); spec.loader.exec_module(bs)',
    body,
  ].join('\n');
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python3 failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// 2026-10-06T10:00:00Z
const END = Date.UTC(2026, 9, 6, 10, 0, 0) / 1000;
const DRAIN_LINE = '[2026-10-06T10:00:00.000Z] [embed-backfill] drain: 3 round(s) in 100s (budget 200s, remaining 41)';
const GiB = 2 ** 30;

/** Samples every 30 s; a pair overlapping the drain burns 1 core, any other pair 0.1 core. */
function samples(): { t: number; cg: { cpu_usec: number; anon: number; mem: number } }[] {
  const out = [];
  let cpu = 0;
  for (let t = END - 300; t <= END + 60; t += 30) {
    out.push({ t, cg: { cpu_usec: cpu, anon: 2 * GiB, mem: 3 * GiB } });
    const next = t + 30;
    const inDrain = t < END + 5 && END - 105 < next;
    cpu += (inDrain ? 1 : 0.1) * 30e6;
  }
  return out;
}

describe('vm/backfill-split.py', () => {
  it('reads each drain line as [end - seconds - 5, end + 5] and ignores every other line', () => {
    const drains = py(
      `print(json.dumps(bs.read_drains(${JSON.stringify([
        DRAIN_LINE,
        '[2026-10-06T10:01:00.000Z] [embed-backfill] queued 12 docs',
        'unrelated',
      ])})))`,
    );
    expect(drains).toEqual([[END - 105, END + 5]]);
  });

  it('puts every pair that overlaps a drain in "drain" and every other pair in "idle"', () => {
    const rows = py(
      `rows = bs.split(${JSON.stringify(samples())}, [(${END - 105}, ${END + 5})])\n` +
        'print(json.dumps({k: [[round(c, 3), a, m] for c, a, m in v] for k, v in rows.items()}))',
    ) as Record<string, [number, number, number][]>;
    // Pairs starting at END-120 .. END overlap the drain; the six before and one after do not.
    expect(rows.drain).toHaveLength(5);
    expect(rows.idle).toHaveLength(7);
    expect(new Set(rows.drain.map((r) => r[0]))).toEqual(new Set([1]));
    expect(new Set(rows.idle.map((r) => r[0]))).toEqual(new Set([0.1]));
    expect(rows.idle[0]?.slice(1)).toEqual([2, 3]);
  });

  it('drops pairs that start before from_epoch and pairs with no elapsed time', () => {
    const s = samples();
    const dup = [...s.slice(0, 2), { ...s[1]! }];
    const rows = py(
      `a = bs.split(${JSON.stringify(s)}, [], ${END})\n` +
        `b = bs.split(${JSON.stringify(dup)}, [])\n` +
        'print(json.dumps([len(a["idle"]), len(b["idle"])]))',
    );
    // From END only the pairs (END, END+30) and (END+30, END+60) remain; the duplicate pair is skipped.
    expect(rows).toEqual([2, 1]);
  });

  it('prints one summary line per bucket and n=0 for an empty bucket', () => {
    const fp = join(TMP, 'fp.jsonl');
    const log = join(TMP, 'serve.log');
    writeFileSync(fp, samples().map((r) => JSON.stringify(r)).join('\n') + '\n{"t": 1, "procs": []}\n');
    writeFileSync(log, `${DRAIN_LINE}\n`);
    const r = spawnSync('python3', [SCRIPT, fp, log], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('drains=1 samples=13 from=0.0');
    expect(r.stdout).toMatch(/^idle: n=7 cores mean=0\.100 median=0\.100 p95=0\.100 anonGiB mean=2\.00 cgroupGiB mean=3\.00$/m);
    expect(r.stdout).toMatch(/^drain: n=5 cores mean=1\.000 /m);

    writeFileSync(log, 'no drains here\n');
    const quiet = spawnSync('python3', [SCRIPT, fp, log], { encoding: 'utf8' });
    expect(quiet.stdout).toMatch(/^drain n=0$/m);
  });

  it('refuses missing arguments with exit 2', () => {
    expect(spawnSync('python3', [SCRIPT], { encoding: 'utf8' }).status).toBe(2);
  });
});
