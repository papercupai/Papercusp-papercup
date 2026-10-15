/**
 * The relay VM's daemon (plan public-blind-relay-2026-10-01, P-001): argument
 * parsing, and a bundle that needs nothing at runtime but hyperdht +
 * blind-relay (the only deps provision-relay-vm.sh installs on the VM).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type DaemonDeps, DEFAULT_EGRESS_BUDGET_GB, parseDaemonArgs, startDaemon } from './blind-relay-daemon';
// @ts-expect-error — plain .mjs build script, no type declarations
import { buildRelayDaemon, RUNTIME_DEPS } from './build-relay-daemon.mjs';

describe('parseDaemonArgs', () => {
  it('requires --seed-file', () => {
    expect(() => parseDaemonArgs([])).toThrow(/--seed-file/);
  });
  it('parses seed file, port, stats interval and the egress guard flags', () => {
    expect(
      parseDaemonArgs([
        '--seed-file', '/etc/relay/seed.hex',
        '--port', '49737',
        '--stats-sec', '60',
        '--egress-budget-gb', '20',
        '--egress-state', '/var/lib/relay/egress.json',
        '--egress-iface', 'ens4',
        '--egress-check-sec', '10',
      ]),
    ).toEqual({
      seedFile: '/etc/relay/seed.hex',
      port: 49737,
      statsSec: 60,
      egressBudgetGb: 20,
      egressStateFile: '/var/lib/relay/egress.json',
      egressIface: 'ens4',
      egressCheckSec: 10,
    });
  });
  it('defaults the intervals and the budget, keeps state beside the seed, leaves the port unset', () => {
    expect(parseDaemonArgs(['--seed-file', '/opt/relay/seed.hex'])).toEqual({
      seedFile: '/opt/relay/seed.hex',
      statsSec: 300,
      egressBudgetGb: DEFAULT_EGRESS_BUDGET_GB,
      egressStateFile: '/opt/relay/egress-state.json',
      egressCheckSec: 30,
    });
  });
  it('accepts a 0 budget (guard off) but refuses a negative one', () => {
    expect(parseDaemonArgs(['--seed-file', 's', '--egress-budget-gb', '0']).egressBudgetGb).toBe(0);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--egress-budget-gb', '-1'])).toThrow(/--egress-budget-gb/);
  });
  it('refuses a bad port, a bad interval and unknown flags', () => {
    expect(() => parseDaemonArgs(['--seed-file', 's', '--port', '70000'])).toThrow(/--port/);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--stats-sec', '0'])).toThrow(/--stats-sec/);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--egress-check-sec', '0'])).toThrow(/--egress-check-sec/);
    expect(() => parseDaemonArgs(['--seed-file', 's', '--verbose'])).toThrow(/unknown/);
  });
});

/** /proc/net/dev with one real interface whose transmit counter the test drives. */
function procNetDev(txBytes: number): string {
  return [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0',
    `  ens4: 99252917 192856 0 0 0 0 0 0 ${txBytes} 189588 0 0 0 0 0 0`,
    '',
  ].join('\n');
}

describe('startDaemon egress budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-egress-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  let caseNo = 0;

  function harness(opts: { budgetGb: number; tx: number; now: string; stateFile?: string }) {
    const env = { tx: opts.tx, now: new Date(opts.now), created: 0, closed: 0, logs: [] as Array<Record<string, unknown>> };
    const args = parseDaemonArgs([
      '--seed-file', join(dir, 'seed.hex'),
      '--egress-budget-gb', String(opts.budgetGb),
      '--egress-state', opts.stateFile ?? join(dir, `state-${++caseNo}.json`),
      '--stats-sec', '300',
    ]);
    const deps: DaemonDeps = {
      createRelay: async () => {
        env.created++;
        return {
          publicKey: 'ab'.repeat(32),
          stats: () => ({ sessions: { active: 0 } }),
          address: () => ({ host: '203.0.113.7', port: 49737, firewalled: false }),
          close: async () => {
            env.closed++;
          },
        };
      },
      readProcNetDev: () => procNetDev(env.tx),
      now: () => env.now,
      log: (o) => env.logs.push(o),
    };
    return { env, args, deps };
  }
  const GB = 1_000_000_000;
  const evs = (logs: Array<Record<string, unknown>>) => logs.map((l) => l.ev);

  it('serves under budget, suspends (closing the relay) once the month crosses it', async () => {
    const { env, args, deps } = harness({ budgetGb: 2, tx: 10 * GB, now: '2026-10-01T20:00:00Z' });
    const d = await startDaemon(args, deps);
    expect(d.serving()).toBe(true);
    expect(env.created).toBe(1);

    env.tx += 1.5 * GB; // 1.5 of 2 GB
    await d.tick();
    expect(d.serving()).toBe(true);

    env.tx += 0.6 * GB; // 2.1 GB: over
    await d.tick();
    expect(d.serving()).toBe(false);
    expect(env.closed).toBe(1);
    const exhausted = env.logs.find((l) => l.ev === 'egress-budget-exhausted') as { egress: Record<string, number> };
    expect(exhausted.egress.usedBytes).toBe(2.1 * GB);
    expect(exhausted.egress.budgetBytes).toBe(2 * GB);

    env.tx += 5 * GB; // traffic while suspended never re-opens the relay within the month
    await d.tick();
    expect(env.created).toBe(1);
  });

  it('resumes on its own when the UTC month rolls over', async () => {
    const { env, args, deps } = harness({ budgetGb: 1, tx: 0, now: '2026-10-31T23:58:00Z' });
    const d = await startDaemon(args, deps);
    env.tx = 2 * GB;
    await d.tick();
    expect(d.serving()).toBe(false);

    env.now = new Date('2026-11-01T00:00:30Z');
    env.tx += 1000;
    await d.tick();
    expect(d.serving()).toBe(true);
    expect(env.created).toBe(2);
    expect(evs(env.logs)).toContain('egress-budget-reset');
  });

  it('a restart inside an exhausted month starts SUSPENDED (usage persists in the state file)', async () => {
    const stateFile = join(dir, 'persisted.json');
    const first = harness({ budgetGb: 1, tx: 0, now: '2026-10-05T00:00:00Z', stateFile });
    const d1 = await startDaemon(first.args, first.deps);
    first.env.tx = 1.2 * GB;
    await d1.tick();
    await d1.stop();

    // Same month, VM rebooted: the kernel counter restarted near 0.
    const second = harness({ budgetGb: 1, tx: 1000, now: '2026-10-06T00:00:00Z', stateFile });
    const d2 = await startDaemon(second.args, second.deps);
    expect(d2.serving()).toBe(false);
    expect(second.env.created).toBe(0);
    expect(evs(second.env.logs)).toEqual(['egress-budget-exhausted']);
  });

  it('every stats line carries the month usage and whether the relay is serving', async () => {
    const { env, args, deps } = harness({ budgetGb: 50, tx: 0, now: '2026-10-01T20:00:00Z' });
    const d = await startDaemon(args, deps);
    env.tx = 3 * GB;
    env.now = new Date('2026-10-01T20:05:00Z');
    await d.tick();
    const stats = env.logs.find((l) => l.ev === 'stats') as Record<string, unknown> & { egress: Record<string, unknown> };
    expect(stats.serving).toBe(true);
    expect(stats.firewalled).toBe(false);
    expect(stats.egress).toEqual({ month: '2026-10', usedBytes: 3 * GB, budgetBytes: 50 * GB, usedPct: 6 });
  });

  it('refuses to start when the guard is on but the transmit counter cannot be read', async () => {
    const { args, deps } = harness({ budgetGb: 1, tx: 0, now: '2026-10-01T00:00:00Z' });
    deps.readProcNetDev = () => 'Inter-|\n face |\n    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n';
    await expect(startDaemon(args, deps)).rejects.toThrow(/non-loopback/);
  });

  it('a 0 budget turns the guard off: no counter read, always serving', async () => {
    const { env, args, deps } = harness({ budgetGb: 0, tx: 0, now: '2026-10-01T00:00:00Z' });
    deps.readProcNetDev = () => {
      throw new Error('must not be read');
    };
    const d = await startDaemon(args, deps);
    env.tx = 10_000 * GB;
    await d.tick();
    expect(d.serving()).toBe(true);
  });
});

describe('buildRelayDaemon', () => {
  const out = mkdtempSync(join(tmpdir(), 'relay-build-'));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it('emits a bundle whose only non-builtin imports are the pinned runtime deps', async () => {
    const r = (await buildRelayDaemon(out)) as { outfile: string; packageJson: string };
    const bundle = readFileSync(r.outfile, 'utf8');
    const specifiers = new Set(
      [...bundle.matchAll(/(?:from\s+|import\(\s*)["']([^"']+)["']/g)].map((m) => m[1]!),
    );
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    const external = [...specifiers].filter((s) => !builtins.has(s));
    expect(external.sort()).toEqual([...RUNTIME_DEPS].sort());

    const pkg = JSON.parse(readFileSync(r.packageJson, 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...RUNTIME_DEPS].sort());
    for (const v of Object.values(pkg.dependencies)) expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(bundle).toContain('blind relay seed must be');
  }, 60_000);
});
