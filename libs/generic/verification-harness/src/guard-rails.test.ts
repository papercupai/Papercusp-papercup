import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HarnessContract, validateContract } from './contract.js';
import { type GuardRailProbe, GUARD_RAIL_SOURCE_ENV, runGuardRails, selectGuardRails } from './guard-rails.js';
import { formatSummaryLine, runHarness } from './runner.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-gr-'));
let canonical: string;
beforeEach(() => {
  canonical = tmp();
  vi.stubEnv('VH_EVIDENCE_ROOT_BASE', canonical);
});

const probe = (key: string, command: string, scope: string[], extra: Partial<GuardRailProbe> = {}): GuardRailProbe => ({
  key,
  command,
  expect: { exitCode: 0 },
  scope,
  ...extra,
});

const contract: HarnessContract = {
  name: 'drill',
  scopeTags: ['hive-git', 'physical-drill'],
  phases: [{ id: 'setup' }, { id: 'leg-a', dependsOn: ['setup'] }],
};

afterEach(() => {
  delete process.env[GUARD_RAIL_SOURCE_ENV];
  vi.unstubAllEnvs();
  rmSync(canonical, { recursive: true, force: true });
});

describe('selectGuardRails', () => {
  it('selects probes sharing a tag, in input order; a harness with no tags selects none', () => {
    const probes = [probe('a', 'true', ['hive-git']), probe('b', 'true', ['release']), probe('c', 'true', ['physical-drill', 'x'])];
    expect(selectGuardRails(probes, ['physical-drill', 'hive-git']).map((p) => p.key)).toEqual(['a', 'c']);
    expect(selectGuardRails(probes, [])).toEqual([]);
  });
});

describe('runGuardRails', () => {
  it('runs every probe and names each broken one with a reason', async () => {
    const dir = tmp();
    const run = await runGuardRails(
      [
        probe('held', 'echo ready', ['t'], { expect: { exitCode: 0, stdoutIncludes: 'ready' } }),
        probe('wrong-exit', 'exit 3', ['t'], { lesson: 'bootstrap the daemon after the drill' }),
        probe('missing-text', 'echo nope', ['t'], { expect: { exitCode: 0, stdoutIncludes: 'ready' } }),
        probe('expects-failure', 'exit 1', ['t'], { expect: { exitCode: 1 } }),
        probe('no-scope', 'true', []),
      ],
      { evidenceDir: dir },
    );
    expect(run.results.map((r) => [r.key, r.ok, r.reasonCode])).toEqual([
      ['held', true, null],
      ['wrong-exit', false, 'exit:3'],
      ['missing-text', false, 'stdout-missing'],
      ['expects-failure', true, null],
      ['no-scope', false, 'invalid-probe'],
    ]);
    expect(run.ok).toBe(false);
    expect(run.firstFailure?.key).toBe('wrong-exit');
    expect(run.firstFailure?.lesson).toBe('bootstrap the daemon after the drill');
    expect(JSON.parse(readFileSync(path.join(dir, 'guard-rails.json'), 'utf8')).results).toHaveLength(5);
  });

  it('kills a probe that overruns its budget, forks included', async () => {
    const run = await runGuardRails([probe('slow', 'sleep 30 & wait', ['t'])], { timeoutMs: 1000 });
    expect(run.results[0]).toMatchObject({ ok: false, reasonCode: 'timeout', timedOut: true });
    expect(run.results[0].elapsedMs).toBeLessThan(10_000);
  });
});

describe('runHarness guard rails', () => {
  it('a broken rail fails the preflight and blocks every phase, naming the rail', async () => {
    const root = tmp();
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: root,
      guardRails: [probe('guard-rail:daemon-bootstrapped', 'exit 1', ['hive-git']), probe('unrelated', 'exit 1', ['release'])],
      runPhase: async (ctx) => {
        ran.push(ctx.phase);
        return { ok: true };
      },
    });
    expect(ran).toEqual([]);
    expect(result.verdict).toBe('preflight-failed');
    expect(result.firstFailure).toEqual({ phase: 'preflight', step: 'guard-rails', reasonCode: 'guard-rail:guard-rail:daemon-bootstrapped' });
    expect(result.phases.map((p) => p.status)).toEqual(['blocked', 'blocked']);
    expect(result.guardRails).toMatchObject({ source: 'arg', selected: 1 });
    expect(formatSummaryLine(result)).toContain('guard_rails=0/1');
  });

  it("runs the harness's own preflight AND the rails; the harness's failure names the reason", async () => {
    const result = await runHarness({
      contract,
      evidenceRoot: tmp(),
      preflight: async () => ({ ok: false, reasonCode: 'rig-unreachable', step: 'ssh' }),
      guardRails: [probe('rail', 'exit 1', ['hive-git'])],
      runPhase: async () => ({ ok: true }),
    });
    expect(result.firstFailure).toEqual({ phase: 'preflight', step: 'ssh', reasonCode: 'rig-unreachable' });
    expect(result.guardRails?.results.map((r) => r.ok)).toEqual([false]);
    expect(result.preflight?.detail).toContain('guard rail rail does not hold');
  });

  it('loads probes from VH_GUARD_RAIL_SOURCE, handing it the harness tags', async () => {
    process.env[GUARD_RAIL_SOURCE_ENV] =
      'printf \'[{"key":"tags=%s","command":"true","expect":{"exitCode":0},"scope":["hive-git"]}]\' "$VH_SCOPE_TAGS"';
    const result = await runHarness({ contract, evidenceRoot: tmp(), runPhase: async () => ({ ok: true }) });
    expect(result.verdict).toBe('pass');
    expect(result.guardRails).toMatchObject({ source: 'command', selected: 1 });
    expect(result.guardRails?.results[0].key).toBe('tags=hive-git,physical-drill');
    expect(formatSummaryLine(result)).toContain('guard_rails=1/1');
  });

  it('a source that cannot answer fails the preflight instead of reading as "no rails apply"', async () => {
    process.env[GUARD_RAIL_SOURCE_ENV] = 'echo "db down" >&2; exit 3';
    const result = await runHarness({ contract, evidenceRoot: tmp(), runPhase: async () => ({ ok: true }) });
    expect(result.verdict).toBe('preflight-failed');
    expect(result.firstFailure?.reasonCode).toBe('guard-rail-source-failed');
    expect(result.preflight?.detail).toContain('db down');
  });

  it('declared tags with no source configured are reported, not silently passed over', async () => {
    const result = await runHarness({ contract, evidenceRoot: tmp(), runPhase: async () => ({ ok: true }) });
    expect(result.verdict).toBe('pass');
    expect(result.guardRails).toEqual({ source: 'unconfigured', selected: 0, results: [] });
    expect(formatSummaryLine(result)).toContain('guard_rails=unconfigured');
  });

  it('a harness with no scope tags gets no preflight and no guard-rail report', async () => {
    const result = await runHarness({
      contract: { name: 'plain', phases: [{ id: 'a' }] },
      evidenceRoot: tmp(),
      guardRails: [probe('rail', 'exit 1', ['hive-git'])],
      runPhase: async () => ({ ok: true }),
    });
    expect(result.preflight).toBeNull();
    expect(result.guardRails ?? null).toBeNull();
    expect(formatSummaryLine(result)).not.toContain('guard_rails');
  });

  it('rejects an invalid scope tag in the contract', () => {
    expect(() => validateContract({ name: 'x', scopeTags: ['Has Space'], phases: [{ id: 'a' }] })).toThrow(/invalid scope tag/);
  });
});

describe('bin/vh.sh guard rails', () => {
  const vh = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/vh.sh');
  // No vh_preflight call: with scope tags declared, the first vh_run must run the rails itself.
  const script = (root: string) => `
set -u
source ${JSON.stringify(vh)}
vh_phase setup
vh_phase leg-a setup
vh_scope hive-git
vh_init shell-drill ${JSON.stringify(root)} "$@" || exit 2
vh_run setup :
vh_run leg-a :
vh_finish
`;
  const run = (root: string, source: string): { code: number; out: string } => {
    const file = path.join(root, 'h.sh');
    writeFileSync(file, script(root));
    try {
      return { code: 0, out: execFileSync('bash', [file], { encoding: 'utf8', env: { ...process.env, [GUARD_RAIL_SOURCE_ENV]: source } }) };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  };

  it('runs the matching rails before the first phase and blocks on a broken one', () => {
    const root = tmp();
    const { code, out } = run(
      root,
      'echo \'[{"key":"daemon-up","command":"exit 7","expect":{"exitCode":0},"scope":["hive-git"],"lesson":"bootstrap it"}]\'',
    );
    expect(code).toBe(1);
    expect(out).toContain('VH_GUARD_RAIL key=daemon-up status=broken reason=exit:7');
    expect(out).toMatch(/HARNESS_RESULT harness=shell-drill verdict=preflight-failed .*first_failure=preflight\/guard-rails\/guard-rail:daemon-up .*blocked=2 .*guard_rails=0\/1/);
    const result = JSON.parse(readFileSync(path.join(root, 'latest', 'result.json'), 'utf8'));
    expect(result.guardRails.results[0]).toMatchObject({ key: 'daemon-up', ok: false, lesson: 'bootstrap it' });
    expect(result.preflight.detail).toContain('bootstrap it');
  });

  it('passes through when every rail holds', () => {
    const root = tmp();
    const { code, out } = run(root, 'echo \'[{"key":"ok","command":"true","expect":{"exitCode":0},"scope":["hive-git"]}]\'');
    expect(code).toBe(0);
    expect(out).toMatch(/verdict=pass .*passed=2 .*guard_rails=1\/1/);
  });
});
