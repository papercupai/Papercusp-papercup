import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sampler runs on the test VMs with stock python3; these tests drive its pure pieces
// through the same interpreter so the class names the summary groups by stay stable.
const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLER = join(HERE, 'sample-footprint.py');

function py(body: string): unknown {
  const script = [
    'import importlib.util, json, os, sys',
    `spec = importlib.util.spec_from_file_location("sf", ${JSON.stringify(SAMPLER)})`,
    'sf = importlib.util.module_from_spec(spec); spec.loader.exec_module(sf)',
    body,
  ].join('\n');
  const r = spawnSync('python3', ['-c', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`python3 failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('sample-footprint.py classify', () => {
  it('names each Papercusp Server process class the way the S7 summary groups them', () => {
    const cases = py(`print(json.dumps([
      sf.classify("MainThread", ["node", "--require", "/s/sidecar-preload.js", "/s/serve.mjs", "--ensure"]),
      sf.classify("MainThread", ["/s/bin/node", "/s/serve.mjs"]),
      sf.classify("MainThread", ["/s/bin/node", "/s/mcp-proxy.mjs"]),
      sf.classify("node", ["node", "-e", "1+1"]),
      sf.classify("postgres", ["postgres: harness_admin papercusp 127.0.0.1(54710) idle"]),
      sf.classify("postgres", ["/x/native/bin/postgres", "-D", "/data"]),
      sf.classify("papercusp-serv", ["/usr/bin/papercusp-server", "--headless-service"]),
      sf.classify("git", ["git", "fetch"]),
      sf.classify("kopia", ["/s/bin/kopia", "snapshot"]),
    ]))`);
    expect(cases).toEqual([
      'node:serve.mjs',
      'node:serve.mjs',
      'node:mcp-proxy.mjs',
      'node:?',
      'postgres',
      'postgres',
      'supervisor',
      'git',
      'kopia',
    ]);
  });
});

describe('sample-footprint.py proc_sample', () => {
  it('parses its own /proc entry, including utime+stime past the comm field', () => {
    const row = py('print(json.dumps(sf.proc_sample(os.getpid())))') as Record<string, unknown>;
    expect(row.comm).toBe('python3');
    expect(row.cls).toBe('python3');
    expect(typeof row.ticks).toBe('number');
    expect(row.rss_kb as number).toBeGreaterThan(1000);
    expect(row.anon_kb as number).toBeGreaterThan(0);
    // P-015: swap and major faults ride on every process row (0 on a box without swap).
    expect(typeof row.swap_kb).toBe('number');
    expect(typeof row.majflt).toBe('number');
  });

  it('returns None for a pid that does not exist rather than raising', () => {
    expect(py('print(json.dumps(sf.proc_sample(2**22 + 12345)))')).toBeNull();
  });
});

// P-015 (swap lever): fixtures, not the test host's own /proc, so the parsers are pinned whether
// or not the machine running the suite has swap, zram or PSI.
const FIXTURES = `
import tempfile
d = tempfile.mkdtemp()
def w(rel, body):
    p = os.path.join(d, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "w").write(body)
PSI = "some avg10=1.50 avg60=0.40 avg300=0.10 total=123456\\nfull avg10=0.80 avg60=0.20 avg300=0.05 total=65432\\n"
`;

describe('sample-footprint.py swap counters (P-015)', () => {
  it('parse_pressure keeps the cumulative some/full totals, not the averages', () => {
    expect(py(`${FIXTURES}\nprint(json.dumps([sf.parse_pressure(PSI), sf.parse_pressure(""), sf.parse_pressure(None)]))`)).toEqual([
      { some_us: 123456, full_us: 65432 },
      {},
      {},
    ]);
  });

  it('cgroup_sample reads swap, major faults, zswap and PSI next to the memory split', () => {
    const cg = py(`${FIXTURES}
w("cg/memory.current", "1000\\n")
w("cg/memory.swap.current", "4096\\n")
w("cg/memory.stat", "anon 600\\nfile 300\\nkernel 50\\nshmem 0\\npgmajfault 77\\nzswap 0\\nworkingset_refault_anon 9\\n")
w("cg/memory.pressure", PSI)
w("cg/cpu.stat", "usage_usec 5000\\nuser_usec 4000\\n")
print(json.dumps(sf.cgroup_sample(os.path.join(d, "cg"))))`);
    expect(cg).toEqual({
      mem: 1000,
      swap: 4096,
      anon: 600,
      file: 300,
      kernel: 50,
      shmem: 0,
      pgmajfault: 77,
      zswap: 0,
      psi: { some_us: 123456, full_us: 65432 },
      cpu_usec: 5000,
    });
  });

  it('cgroup_sample omits swap and PSI on a cgroup without them (no swap controller, PSI off)', () => {
    const cg = py(`${FIXTURES}
w("cg/memory.current", "1000\\n")
print(json.dumps(sf.cgroup_sample(os.path.join(d, "cg"))))`);
    expect(cg).toEqual({ mem: 1000 });
  });

  it('host_sample reads swap traffic, swap space, machine PSI and every zram device', () => {
    const host = py(`${FIXTURES}
w("proc/vmstat", "nr_free_pages 10\\npswpin 11\\npswpout 22\\npgmajfault 33\\npgfault 44\\n")
w("proc/meminfo", "MemTotal:  8000 kB\\nMemAvailable:  3000 kB\\nSwapTotal:  4000 kB\\nSwapFree:  3500 kB\\n")
w("proc/pressure/memory", PSI)
w("block/zram0/mm_stat", "  1048576   262144   300000        0   300000       12        0        0\\n")
w("block/zram1/mm_stat", "short\\n")
w("block/sda/size", "1\\n")
print(json.dumps(sf.host_sample(os.path.join(d, "proc"), os.path.join(d, "block"))))`);
    expect(host).toEqual({
      pswpin: 11,
      pswpout: 22,
      pgmajfault: 33,
      MemAvailable_kb: 3000,
      SwapTotal_kb: 4000,
      SwapFree_kb: 3500,
      psi: { some_us: 123456, full_us: 65432 },
      zram: { zram0: { orig: 1048576, compr: 262144, used: 300000 } },
    });
  });

  it('host_sample is empty rather than raising when /proc and /sys/block are absent', () => {
    expect(py(`${FIXTURES}\nprint(json.dumps(sf.host_sample(os.path.join(d, "nope"), os.path.join(d, "nope2"))))`)).toEqual({});
  });
});
