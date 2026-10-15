import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// sidecar-idle-analyze.py turns a sidecar-idle-soak.sh run.log into PASS / FAIL / NOT_OBSERVED
// verdicts. These tests feed it synthetic logs in the exact line shapes the driver and
// sidecar-idle-probe.sh print, and read its ANALYZE_VERDICT lines (WI-10006497).
const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable so scripts/mutation-probe.sh can point the suite at a mutated copy (copy-out mode).
const ANALYZER = process.env.SIDECAR_IDLE_ANALYZE_PATH ?? join(HERE, 'sidecar-idle-analyze.py');
const TMP = mkdtempSync(join(tmpdir(), 'sidecar-idle-analyze-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
function analyze(lines: string[]): { status: number | null; out: string; verdicts: Record<string, string> } {
  const log = join(TMP, `run-${seq++}.log`);
  writeFileSync(log, lines.join('\n') + '\n');
  const r = spawnSync('python3', [ANALYZER, log], { encoding: 'utf8' });
  const verdicts: Record<string, string> = {};
  for (const m of r.stdout.matchAll(/^ANALYZE_VERDICT key=(\S+) verdict=(\S+)/gm)) verdicts[m[1] ?? ''] = m[2] ?? '';
  return { status: r.status, out: r.stdout + r.stderr, verdicts };
}

const TENANTS = [
  ['pc1', 1001],
  ['pc2', 1002],
] as const;

/** A PORTS block where every tenant holds its first-choice port for every fixed service. */
function ports(label = 'p1', opts: { sharedGateway?: boolean } = {}): string[] {
  const out = [`#### PORTS ${label} 2026-10-06T10:00:00Z`];
  for (const [t, uid] of TENANTS) out.push(`UID ${t}=${uid}`);
  for (const [, uid] of TENANTS) {
    for (const base of [23800, 24800, 25800, 26800]) {
      const port = opts.sharedGateway && base === 23800 ? 23801 : base + (uid % 1000);
      out.push(`127.0.0.1:${port} MainThread pid=${uid * 10 + base / 100} uid=${uid}`);
    }
  }
  // A tenant's embedded postgres can land inside the gateway range; it is not a service listener.
  out.push('127.0.0.1:23988 postgres pid=777 uid=1001');
  return out;
}

type Row = { sc: number; ie: number; real: number; lastReal?: string; cur?: number };
function census(label: string, hhmm: string, row: Row): string[] {
  const out = [`#### CENSUS ${label} 2026-10-06T${hhmm}:00Z`];
  for (const [t, uid] of TENANTS) {
    out.push(
      `TENANT ${t} uid=${uid} anonG=1.90 curG=${(row.cur ?? (row.sc ? 3.5 : 2.4)).toFixed(2)} ` +
        `sidecarProcs=${row.sc} sidecarPids=none sidecarRss=none idleExits=${row.ie} died=0 ` +
        `realEmbeds=${row.real} probes=0 lastReal=${row.lastReal ?? '09:58:00'} startTimeouts=0 mainOnnxMaps=0 mainMaxAnonM=900`,
    );
  }
  return out;
}

const UP: Row = { sc: 1, ie: 0, real: 1 };
const DOWN: Row = { sc: 0, ie: 1, real: 1 };

function healthyRun(extra: { envops?: string; censuses?: string[][]; early?: string } = {}): string[] {
  return [
    'CREATE_START 2026-10-06T09:50:00Z',
    'SSH_READY 2026-10-06T09:52:00Z',
    'TENANT_RESULT pc1 rc=0 cg=/user.slice port=3270 T_BOOT_TO_HEALTH=41 2026-10-06T09:55:00Z',
    'TENANT_RESULT pc2 rc=0 cg=/user.slice port=3271 T_BOOT_TO_HEALTH=44 2026-10-06T09:56:00Z',
    ...ports(),
    '#### ENVOPS e1 2026-10-06T10:00:00Z',
    'ENV_OPERATORS_TOTAL listeners=0',
    extra.envops ?? 'ENV_OPERATORS_VERDICT label=e1 total=0 verdict=none',
    'OBSERVE_START 2026-10-06T10:00:00Z',
    ...(extra.censuses ?? [
      census('c1', '10:00', UP),
      census('c2', '10:10', DOWN),
      census('c3', '10:15', DOWN),
      census('c4', '10:20', DOWN),
    ]).flat(),
    'STABLE_IDLE 3/3 2026-10-06T10:20:00Z',
    extra.early ?? 'EARLY_STOP all tenants idle-exited and down for 3 censuses 2026-10-06T10:20:00Z',
    'OBSERVE_END 2026-10-06T10:20:00Z',
    'TEARDOWN_START 2026-10-06T10:20:05Z',
    'SOAK_DONE rc=0 2026-10-06T10:21:00Z',
  ];
}

describe('vm/sidecar-idle-analyze.py', () => {
  it('reads a clean run as PASS on every check and computes the saved GiB vs the P-011 control', () => {
    const r = analyze(healthyRun());
    expect(r.status).toBe(0);
    expect(r.verdicts).toMatchObject({
      'run-finished': 'PASS',
      'WI-10005630.sidecar-idle-exit': 'PASS',
      'WI-10006479.deferred-resolve': 'PASS',
      'WI-10006420.env-operators': 'PASS',
      'WI-10005481.gateway': 'PASS',
      'WI-10005481.mcp-proxy': 'PASS',
      'WI-10005586.mobile-voice': 'PASS',
      'WI-10005586.desktop-voice': 'PASS',
    });
    // 3.24 GiB control minus the 2.40 GiB mean with the sidecar down.
    expect(r.out).toMatch(/^P532_SAVED_GIB 0\.84$/m);
  });

  it('fails WI-10006479 and the idle-exit check when a sidecar comes back with no real embed', () => {
    const r = analyze(
      healthyRun({
        censuses: [census('c1', '10:00', UP), census('c2', '10:10', DOWN), census('c3', '10:15', { sc: 1, ie: 1, real: 1 })],
        early: 'EARLY_STOP stop-file reason=[manual] 2026-10-06T10:15:00Z',
      }),
    );
    expect(r.verdicts['WI-10005630.sidecar-idle-exit']).toBe('FAIL');
    expect(r.verdicts['WI-10006479.deferred-resolve']).toBe('FAIL');
    expect(r.out).toContain('c3(NO-REAL-EMBED)');
  });

  it('accepts a respawn caused by a real embed once the sidecar idle-exits again', () => {
    const r = analyze(
      healthyRun({
        censuses: [
          census('c1', '10:00', UP),
          census('c2', '10:10', DOWN),
          census('c3', '10:15', { sc: 1, ie: 1, real: 2, lastReal: '10:14:00' }),
          census('c4', '10:25', { sc: 0, ie: 2, real: 2, lastReal: '10:14:00' }),
          census('c5', '10:30', { sc: 0, ie: 2, real: 2, lastReal: '10:14:00' }),
        ],
      }),
    );
    expect(r.out).toContain('c3(real-embed)');
    expect(r.verdicts['WI-10005630.sidecar-idle-exit']).toBe('PASS');
    expect(r.verdicts['WI-10006479.deferred-resolve']).toBe('PASS');
  });

  it('fails the idle-exit check when a sidecar is still up well past the idle window', () => {
    const r = analyze(healthyRun({ censuses: [census('c1', '10:00', UP), census('c2', '10:10', UP)], early: '' }));
    expect(r.verdicts['WI-10005630.sidecar-idle-exit']).toBe('FAIL');
    expect(r.verdicts['WI-10006479.deferred-resolve']).toBe('FAIL');
  });

  it('a run stopped before every tenant idle-exited is NOT_OBSERVED for WI-10006479, never PASS', () => {
    const r = analyze(
      healthyRun({
        censuses: [census('c1', '10:00', { ...UP, lastReal: '09:59:00' }), census('c2', '10:04', { ...UP, lastReal: '09:59:00' })],
        early: 'EARLY_STOP stop-file reason=[manual] 2026-10-06T10:04:00Z',
      }),
    );
    expect(r.verdicts['WI-10005630.sidecar-idle-exit']).toBe('NOT_OBSERVED');
    expect(r.verdicts['WI-10006479.deferred-resolve']).toBe('NOT_OBSERVED');
  });

  it('fails WI-10006420 when any env-switcher operator listens, and is NOT_OBSERVED when unreadable', () => {
    expect(
      analyze(healthyRun({ envops: 'ENV_OPERATORS_VERDICT label=e1 total=2 verdict=present' })).verdicts[
        'WI-10006420.env-operators'
      ],
    ).toBe('FAIL');
    expect(
      analyze(healthyRun({ envops: 'ENV_OPERATORS_VERDICT label=e1 verdict=unreadable' })).verdicts[
        'WI-10006420.env-operators'
      ],
    ).toBe('NOT_OBSERVED');
  });

  it('fails a fixed service when two tenants share one port (the postgres listener in range is ignored)', () => {
    const lines = healthyRun().map((l) => l);
    const start = lines.findIndex((l) => l.startsWith('#### PORTS'));
    lines.splice(start, ports().length, ...ports('p1', { sharedGateway: true }));
    const r = analyze(lines);
    expect(r.verdicts['WI-10005481.gateway']).toBe('FAIL');
    expect(r.verdicts['WI-10005481.mcp-proxy']).toBe('PASS');
    expect(r.out).toContain('shared ports');
  });

  it('never prints PASS when the inputs are absent, and marks an unfinished run provisional', () => {
    const r = analyze(['CREATE_START 2026-10-06T09:50:00Z', 'SSH_READY 2026-10-06T09:52:00Z']);
    expect(r.status).toBe(0);
    expect(Object.values(r.verdicts)).not.toContain('PASS');
    expect(Object.keys(r.verdicts)).toHaveLength(8);
    expect(r.out).toContain('RUN NOT FINISHED: provisional');
    expect(r.out).toMatch(/^P532_SAVED_GIB none$/m);
  });

  it('refuses a missing log or a missing argument with exit 2', () => {
    expect(spawnSync('python3', [ANALYZER, join(TMP, 'absent.log')], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync('python3', [ANALYZER], { encoding: 'utf8' }).status).toBe(2);
  });
});
