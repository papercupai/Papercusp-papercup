import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOREIGN_MAX_AGE_HOURS,
  DEFAULT_KEEP_RUNS,
  FOREIGN_FRESHNESS_CACHE,
  FOREIGN_PRUNE_LEDGER,
  FOREIGN_PRUNE_LEDGER_MAX_BYTES,
  FOREIGN_WALK_BUDGET,
  foreignMaxAgeHoursFromEnv,
  formatForeignPruneLine,
  keepRunsFromEnv,
  linkLatest,
  pruneEvidenceRoot,
  pruneRuns,
  pruneRunsWithReport,
  pruneStaleForeign,
  readForeignPruneLedger,
  runHarness,
  VH_KEEP_MARKER,
  vhDiskReserveBytes,
  writeRunResult,
} from './runner.js';

/**
 * vh.sh BRACKET MODE: a long linear `set -e` script marks section boundaries (vh_begin) instead
 * of wrapping sections in functions, so its own abort semantics are untouched and an abort still
 * yields a structured result naming the phase and step it died in.
 */
const vh = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/vh.sh');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-bracket-'));

function run(body: string, env: Record<string, string> = {}, args: string[] = []) {
  const root = tmp();
  const file = path.join(root, 'h.sh');
  writeFileSync(file, `set -euo pipefail\nsource ${JSON.stringify(vh)}\n${body.replaceAll('$ROOT', root)}`);
  const r = spawnSync('bash', [file, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const result = existsSync(path.join(root, 'ev', 'latest', 'result.json'))
    ? JSON.parse(readFileSync(path.join(root, 'ev', 'latest', 'result.json'), 'utf8'))
    : null;
  const rows = result
    ? (result.phases as { phase: string; status: string; step: string | null; reasonCode: string | null }[]).map((p) => [
        p.phase,
        p.status,
        p.step,
        p.reasonCode,
      ])
    : null;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, result, rows, root };
}

const chain = `
vh_phase prep ""
vh_phase build prep
vh_phase ship build
vh_init linear "$ROOT/ev"
vh_bracket_trap
`;

describe('vh.sh bracket mode', () => {
  it('an abort under set -e fails the open phase at its last step and blocks the rest; the exit code is kept', () => {
    const r = run(`${chain}
vh_begin prep
vh_step fetch
vh_begin build
vh_step compile
false
vh_begin ship
`);
    expect(r.code).toBe(1);
    expect(r.rows).toEqual([
      ['prep', 'passed', 'fetch', null],
      ['build', 'failed', 'compile', 'exit-1'],
      ['ship', 'blocked', null, 'aborted:build:exit-1'],
    ]);
    expect(r.stdout).toMatch(/HARNESS_RESULT harness=linear verdict=fail .*first_failure=build\/compile\/exit-1 passed=1 failed=1 blocked=1/);
  });

  it('chains in front of an EXIT trap the script already had, which still runs with the real status', () => {
    const r = run(`
trap 'echo "own-trap rc=$?" > "$ROOT/own-trap"' EXIT
${chain}
vh_begin prep
vh_begin build
vh_begin ship
exit 0
`);
    expect(r.code).toBe(0);
    expect(r.result.verdict).toBe('pass');
    expect(readFileSync(path.join(r.root, 'own-trap'), 'utf8')).toBe('own-trap rc=0\n');
  });

  it('vh_fail names the reason and an explicit exit code survives', () => {
    const r = run(`${chain}
vh_begin prep
vh_step probe
vh_fail rig-unreachable "ssh timed out"
exit 7
`);
    expect(r.code).toBe(7);
    expect(r.rows?.[0]).toEqual(['prep', 'failed', 'probe', 'rig-unreachable']);
    expect(r.rows?.[1]).toEqual(['build', 'blocked', null, 'aborted:prep:exit-7']);
  });

  it('a deliberate early exit 0 declares the rest skipped; an undeclared one is a failure', () => {
    const declared = run(`${chain}
vh_begin prep
vh_skip_rest precheck-only
exit 0
`);
    expect(declared.result.verdict).toBe('pass');
    expect(declared.rows?.slice(1)).toEqual([
      ['build', 'skipped', null, 'precheck-only'],
      ['ship', 'skipped', null, 'precheck-only'],
    ]);
    const silent = run(`${chain}
vh_begin prep
exit 0
`);
    expect(silent.result.verdict).toBe('fail');
    expect(silent.rows?.[1]).toEqual(['build', 'failed', null, 'not-reported']);
  });

  it('a script with its own EXIT handler finalizes by calling vh_exit from it', () => {
    const r = run(`
vh_phase prep ""
vh_phase build prep
vh_init own-handler "$ROOT/ev"
teardown() { local rc=$?; vh_exit "$rc"; echo "teardown rc=$rc" > "$ROOT/td"; }
trap teardown EXIT
vh_begin prep
vh_begin build
exit 3
`);
    expect(r.code).toBe(3);
    expect(r.rows).toEqual([
      ['prep', 'passed', null, null],
      ['build', 'failed', null, 'exit-3'],
    ]);
    expect(readFileSync(path.join(r.root, 'td'), 'utf8')).toBe('teardown rc=3\n');
  });

  it('VH_LOG_FD=2 keeps the harness stdout free of contract lines', () => {
    const r = run(`${chain}
vh_begin prep
echo payload
vh_begin build
vh_begin ship
`, { VH_LOG_FD: '2' });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('payload\n');
    expect(r.stderr).toMatch(/VH_BEGIN phase=prep/);
    expect(r.stderr).toMatch(/HARNESS_RESULT harness=linear verdict=pass/);
  });

  it('VH_FAIL_OPEN: a contract that cannot start disables itself loudly and the harness still runs', () => {
    const r = run(`
vh_phase prep ""
vh_init linear /proc/definitely-not-writable/ev
vh_bracket_trap
vh_begin prep
echo ran
exit 4
`, { VH_FAIL_OPEN: '1' });
    expect(r.code).toBe(4);
    expect(r.stdout).toBe('ran\n');
    expect(r.stderr).toMatch(/VH_DISABLED harness=linear reason=evidence-root-unwritable/);
  });

  it.each([0, 7])('keeps instrumentation with a long TMPDIR and exit %i', (exitCode) => {
    const parent = tmp();
    const longTmp = path.join(parent, 'x'.repeat(150));
    mkdirSync(longTmp);
    let r: ReturnType<typeof run> | undefined;
    try {
      r = run(`
vh_scope long-tmpdir
${chain}
vh_preflight
vh_begin prep
vh_begin build
${exitCode ? 'exit 7' : 'vh_begin ship'}
`, {
        TMPDIR: longTmp,
        VH_TSX: '',
        VH_FAIL_OPEN: '1',
        VH_GUARD_RAIL_SOURCE: `echo '[{"key":"long-tmpdir-probe","command":"echo probe-executed","expect":{"exitCode":0,"stdoutIncludes":"probe-executed"},"scope":["long-tmpdir"]}]'`,
      });
      expect(r.code).toBe(exitCode);
      expect(r.stderr).not.toContain('VH_DISABLED');
      expect(r.stderr).not.toMatch(/createIpcServer|listen EINVAL/);
      expect(r.stdout).toContain('VH_GUARD_RAIL key=long-tmpdir-probe status=held');
      expect(r.stdout).toMatch(new RegExp(`HARNESS_RESULT harness=linear verdict=${exitCode ? 'fail' : 'pass'}`));
      expect(r.result).not.toBeNull();
      expect(r.result.guardRails).toMatchObject({ selected: 1, results: [{ key: 'long-tmpdir-probe', ok: true }] });
      expect(r.rows).toEqual(exitCode ? [
        ['prep', 'passed', null, null],
        ['build', 'failed', null, 'exit-7'],
        ['ship', 'blocked', null, 'aborted:build:exit-7'],
      ] : [
        ['prep', 'passed', null, null],
        ['build', 'passed', null, null],
        ['ship', 'passed', null, null],
      ]);
    } finally {
      if (r) rmSync(r.root, { recursive: true, force: true });
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  // WI-10004050: cli.ts gated main() on argv[1] === import.meta.url's path. Reached through a
  // symlinked checkout those differ (link vs real file), so the CLI exited 0 printing nothing:
  // an empty plan, then a finalize that never wrote a result.
  it('reached through a symlinked checkout, the CLI still plans and finalizes', () => {
    const libDir = path.resolve(path.dirname(vh), '..');
    let tsx = '';
    for (let d = libDir; d !== path.dirname(d); d = path.dirname(d)) {
      if (existsSync(path.join(d, 'node_modules', '.bin', 'tsx'))) { tsx = path.join(d, 'node_modules', '.bin', 'tsx'); break; }
    }
    expect(tsx, 'repo tsx must be locatable').not.toBe('');
    const root = tmp();
    mkdirSync(path.join(root, 'link'));
    symlinkSync(libDir, path.join(root, 'link', 'verification-harness'));
    const linked = path.join(root, 'link', 'verification-harness', 'bin', 'vh.sh');
    const file = path.join(root, 'h.sh');
    writeFileSync(file, `set -euo pipefail\nsource ${JSON.stringify(linked)}\n${chain.replaceAll('$ROOT', root)}
vh_begin prep
vh_begin build
vh_begin ship
exit 0
`);
    const r = spawnSync('bash', [file], { encoding: 'utf8', env: { ...process.env, VH_TSX: tsx } });
    expect(r.stderr).not.toMatch(/was not declared/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/VH_RUN harness=linear .* plan=prep:run,build:run,ship:run/);
    const result = JSON.parse(readFileSync(path.join(root, 'ev', 'latest', 'result.json'), 'utf8'));
    expect(result.phases.map((p: { phase: string; status: string }) => [p.phase, p.status])).toEqual([
      ['prep', 'passed'],
      ['build', 'passed'],
      ['ship', 'passed'],
    ]);
  });

  it('a plan that leaves a declared phase without an action is refused, never recorded as empty', () => {
    const root = tmp();
    const silent = path.join(root, 'silent-cli');
    writeFileSync(silent, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const closed = run(`${chain}\necho unreachable\n`, { VH_TSX: silent });
    expect(closed.code).toBe(2);
    expect(closed.stderr).toMatch(/vh_init: plan-incomplete:no-action-for-prep/);
    expect(closed.stdout).not.toMatch(/unreachable/);
    const open = run(`${chain}\necho ran\n`, { VH_TSX: silent, VH_FAIL_OPEN: '1' });
    expect(open.code).toBe(0);
    expect(open.stdout).toMatch(/ran/);
    expect(open.stderr).toMatch(/VH_DISABLED harness=linear reason=plan-incomplete:no-action-for-prep/);
  });

  it('without VH_FAIL_OPEN a contract that cannot start is fatal', () => {
    const r = run(`
vh_phase prep ""
vh_init linear /proc/definitely-not-writable/ev
echo unreachable
`);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toMatch(/unreachable/);
  });

  it('VH_DISABLE keeps vh_run harnesses honest: a failing phase still fails vh_finish', () => {
    const r = run(`
vh_phase a ""
vh_phase b ""
vh_init disabled "$ROOT/ev"
vh_run a true
vh_run b false
vh_finish
`, { VH_DISABLE: '1' });
    expect(r.code).toBe(1);
    expect(r.result).toBeNull();
  });
});

describe('pruneRuns (evidence retention)', () => {
  const mkRun = (root: string, name: string, finished = true) => {
    mkdirSync(path.join(root, name), { recursive: true });
    if (finished) {
      writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({
        schemaVersion: 1,
        runId: name,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
        verdict: 'fail',
        phases: [],
      }));
    }
  };

  it('keeps the newest runs, never the one latest points at, never one still in progress', async () => {
    const root = tmp();
    const names = ['20260101T000000Z-1', '20260102T000000Z-2', '20260103T000000Z-3', '20260104T000000Z-4', '20260105T000000Z-5'];
    for (const n of names) mkRun(root, n);
    mkRun(root, '20250101T000000Z-9', false); // unfinished and fresh: in progress
    mkRun(root, '20250101T000000Z-8', false); // unfinished and old: crashed
    const old = new Date('2025-01-01T00:00:00Z');
    utimesSync(path.join(root, '20250101T000000Z-8'), old, old);
    mkdirSync(path.join(root, 'not-a-run'));
    symlinkSync('20260101T000000Z-1', path.join(root, 'latest'));

    const removed = await pruneRuns(root, 2, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }),
      reserveBytes: () => 400,
    });
    expect(removed.sort()).toEqual(['20250101T000000Z-8', '20260102T000000Z-2', '20260103T000000Z-3']);
    for (const kept of ['20260101T000000Z-1', '20260104T000000Z-4', '20260105T000000Z-5', '20250101T000000Z-9', 'not-a-run']) {
      expect(existsSync(path.join(root, kept))).toBe(true);
    }
  });

  it('VH_KEEP_RUNS=0 disables pruning; junk falls back to the default', async () => {
    expect(keepRunsFromEnv({ VH_KEEP_RUNS: '0' })).toBe(0);
    expect(keepRunsFromEnv({ VH_KEEP_RUNS: 'lots' })).toBe(DEFAULT_KEEP_RUNS);
    expect(keepRunsFromEnv({})).toBe(DEFAULT_KEEP_RUNS);
    const root = tmp();
    mkRun(root, '20260101T000000Z-1');
    expect(await pruneRuns(root, 0, Date.now(), {
      measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }),
      reserveBytes: () => 400,
    })).toEqual([]);
  });

  it('reclaims oldest terminal runs below the disk reserve and protects latest, live, and marked runs', async () => {
    const root = tmp();
    const names = [
      '20260101T000000Z-99999999',
      '20260102T000000Z-99999998',
      '20260103T000000Z-' + process.pid,
      '20260104T000000Z-99999997',
      '20260105T000000Z-99999996',
    ];
    for (const name of names) mkRun(root, name, name !== names[2]);
    writeFileSync(path.join(root, names[3], VH_KEEP_MARKER), 'pinned evidence');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(path.join(root, names[2]), old, old);
    symlinkSync(names[4], path.join(root, 'latest'));

    const report = await pruneRunsWithReport(root, 0, Date.now(), {
      measureDisk: async () => {
        const removedCount = names.filter((name) => !existsSync(path.join(root, name))).length;
        return { totalBytes: 1_000, availableBytes: 100 + removedCount * 150 };
      },
      reserveBytes: () => 350,
    });

    expect(report.removed).toEqual(names.slice(0, 2));
    expect(report.disk).toEqual({
      status: 'recovered',
      reserveBytes: 350,
      availableBeforeBytes: 100,
      availableAfterBytes: 400,
    });
    for (const kept of names.slice(2)) expect(existsSync(path.join(root, kept))).toBe(true);
    expect(vhDiskReserveBytes(1_875.7 * 1024 ** 3)).toBeCloseTo(37.514 * 1024 ** 3);
  });

  it('keeps every run when disk headroom cannot be measured', async () => {
    const root = tmp();
    const name = '20260101T000000Z-99999999';
    mkRun(root, name);
    const report = await pruneRunsWithReport(root, 0, Date.now(), {
      measureDisk: async () => null,
    });
    expect(report.disk.status).toBe('unmeasured');
    expect(report.removed).toEqual([]);
    expect(existsSync(path.join(root, name))).toBe(true);
  });
});

describe('completed receipt custody (EI-25507426663280898)', () => {
  it('retains the exact shell completion receipt before a later count sweep removes its run', async () => {
    const r = run(`${chain}\nvh_begin prep\nvh_begin build\nvh_begin ship\nexit 0\n`);
    try {
      expect(r.code).toBe(0);
      const evidenceRoot = path.join(r.root, 'ev');
      const original = readFileSync(path.join(r.result.evidenceDir, 'result.json'));
      const retained = path.join(evidenceRoot, 'retained', r.result.runId, 'result.json');
      expect(readFileSync(retained)).toEqual(original);
      const newer = '99990101T000000Z-1';
      mkdirSync(path.join(evidenceRoot, newer));
      writeFileSync(path.join(evidenceRoot, newer, 'result.json'), '{}');
      await linkLatest(evidenceRoot, path.join(evidenceRoot, newer));
      expect(await pruneRuns(evidenceRoot, 1)).toContain(r.result.runId);
      expect(existsSync(r.result.evidenceDir)).toBe(false);
      expect(readFileSync(retained)).toEqual(original);
      expect(JSON.parse(original.toString()).endedAt).toBe(r.result.endedAt);
    } finally { rmSync(r.root, { recursive: true, force: true }); }
  });

  it('retains the TypeScript runner receipt and refuses to replace its original bytes', async () => {
    const root = tmp();
    try {
      const result = await runHarness({
        contract: { name: 'receipt-custody', phases: [{ id: 'assert' }] },
        evidenceRoot: root,
        runPhase: async () => ({ ok: true }),
      });
      const retained = path.join(root, 'retained', result.runId, 'result.json');
      const original = readFileSync(path.join(result.evidenceDir, 'result.json'));
      expect(readFileSync(retained)).toEqual(original);
      await writeRunResult(result);
      await expect(writeRunResult({ ...result, endedAt: '2099-01-01T00:00:00.000Z' }))
        .rejects.toThrow('retained harness result changed');
      expect(readFileSync(retained)).toEqual(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('does not pin an unfinished checkpoint as a completed receipt', async () => {
    const root = tmp();
    try {
      const result = await runHarness({
        contract: { name: 'receipt-custody', phases: [{ id: 'assert' }] },
        evidenceRoot: root,
        runPhase: async () => ({ ok: true }),
      });
      rmSync(path.join(root, 'retained'), { recursive: true, force: true });
      await writeRunResult({ ...result, endedAt: null });
      expect(existsSync(path.join(root, 'retained'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses a retained-directory symlink outside the evidence root', async () => {
    const root = tmp(), outside = tmp();
    try {
      symlinkSync(outside, path.join(root, 'retained'));
      await expect(runHarness({
        contract: { name: 'receipt-custody', phases: [{ id: 'assert' }] },
        evidenceRoot: root,
        runPhase: async () => ({ ok: true }),
      })).rejects.toThrow('retained harness result outside evidence root');
      expect(existsSync(path.join(root, 'latest'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('pruneStaleForeign (WI-10007424: hand-named entries beside the runs)', () => {
  const OLD = new Date('2025-01-01T00:00:00Z');
  const NOW = Date.parse('2026-10-08T12:00:00Z');
  const age = (p: string) => utimesSync(p, OLD, OLD);
  /** A foreign dir whose every entry is old, with one nested file so the walk has depth. */
  const oldTree = (root: string, name: string) => {
    const dir = path.join(root, name);
    mkdirSync(path.join(dir, 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sub', 'image.raw'), 'x');
    age(path.join(dir, 'sub', 'image.raw'));
    age(path.join(dir, 'sub'));
    age(dir);
    return dir;
  };

  it('removes stale foreign dirs and files, keeps fresh ones and every protected entry', async () => {
    const root = tmp();
    oldTree(root, 'wi1-old-scratch');
    writeFileSync(path.join(root, 'stray.log'), 'x');
    age(path.join(root, 'stray.log'));
    // Fresh deep inside, old at the top: a writer is still using it.
    const live = oldTree(root, 'wi2-deep-live');
    writeFileSync(path.join(live, 'sub', 'image.raw'), 'still being written');
    age(live);
    age(path.join(live, 'sub'));
    mkdirSync(path.join(root, 'fresh-scratch'));
    // Protected, all old: a run dir (count-governed), retained/, a dot-entry, a marked dir, a symlink.
    oldTree(root, '20200101T000000Z-1');
    oldTree(root, 'retained');
    oldTree(root, '.latest-123');
    const marked = oldTree(root, 'pinned-investigation');
    writeFileSync(path.join(marked, VH_KEEP_MARKER), '');
    age(path.join(marked, VH_KEEP_MARKER));
    age(marked);
    symlinkSync('wi1-old-scratch', path.join(root, 'link-to-old'));
    symlinkSync('20200101T000000Z-1', path.join(root, 'latest'));

    const dry = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW, dryRun: true });
    expect(dry.removed.sort()).toEqual(['stray.log', 'wi1-old-scratch']);
    expect(existsSync(path.join(root, 'wi1-old-scratch', 'sub', 'image.raw'))).toBe(true);
    expect(existsSync(path.join(root, 'stray.log'))).toBe(true);

    const r = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW });

    expect(r.removed.sort()).toEqual(['stray.log', 'wi1-old-scratch']);
    expect(r.unjudged).toEqual([]);
    for (const kept of ['wi2-deep-live', 'fresh-scratch', '20200101T000000Z-1', 'retained', '.latest-123', 'pinned-investigation', 'latest']) {
      expect(existsSync(path.join(root, kept)), kept).toBe(true);
    }
    // The symlink itself survives (dangling now): retention never judges or follows links.
    expect(readlinkSync(path.join(root, 'link-to-old'))).toBe('wi1-old-scratch');
  });

  it('records every real removal in a durable tombstone ledger that retention itself never removes (WI-6554700010010390)', async () => {
    const root = tmp();
    oldTree(root, 'release-bank-old');
    writeFileSync(path.join(root, 'stray.log'), 'x');
    age(path.join(root, 'stray.log'));
    mkdirSync(path.join(root, 'fresh-bank'));

    // A dry run judges only: no ledger.
    await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW, dryRun: true });
    expect(existsSync(path.join(root, FOREIGN_PRUNE_LEDGER))).toBe(false);

    const r = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW });
    expect(r.removed.sort()).toEqual(['release-bank-old', 'stray.log']);
    const ledger = await readForeignPruneLedger(root);
    expect(ledger.map((t) => t.name).sort()).toEqual(['release-bank-old', 'stray.log']);
    for (const t of ledger) {
      expect(t.entryMtime).toBe(OLD.toISOString());
      expect(t.maxAgeHours).toBe(72);
      expect(t.pid).toBe(process.pid);
      expect(Number.isNaN(Date.parse(t.at))).toBe(false);
    }

    // The ledger is a dot-entry: even aged past the cutoff, a later sweep keeps it and appends.
    age(path.join(root, FOREIGN_PRUNE_LEDGER));
    oldTree(root, 'second-old');
    const r2 = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW });
    expect(r2.removed).toEqual(['second-old']);
    expect((await readForeignPruneLedger(root)).map((t) => t.name)).toEqual([
      ...ledger.map((t) => t.name),
      'second-old',
    ]);
  });

  it('trims the tombstone ledger to its newest half once it outgrows its cap, keeping the newest removal', async () => {
    const root = tmp();
    const filler = JSON.stringify({ at: '2026-01-01T00:00:00.000Z', name: 'filler', entryMtime: OLD.toISOString(), maxAgeHours: 72, pid: 1, caller: null });
    const lines = Math.ceil(FOREIGN_PRUNE_LEDGER_MAX_BYTES / (filler.length + 1)) + 10;
    writeFileSync(path.join(root, FOREIGN_PRUNE_LEDGER), `${filler}\n`.repeat(lines));
    oldTree(root, 'newest-old');

    await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW });

    const text = readFileSync(path.join(root, FOREIGN_PRUNE_LEDGER), 'utf8');
    expect(text.length).toBeLessThanOrEqual(FOREIGN_PRUNE_LEDGER_MAX_BYTES);
    const rows = await readForeignPruneLedger(root);
    expect(rows.at(-1)?.name).toBe('newest-old');
    expect(rows.length).toBeGreaterThan(lines / 3);
  });

  it('a max age of 0 disables it; the env knob falls back to the default on junk', async () => {
    expect(foreignMaxAgeHoursFromEnv({ VH_FOREIGN_MAX_AGE_HOURS: '0' })).toBe(0);
    expect(foreignMaxAgeHoursFromEnv({ VH_FOREIGN_MAX_AGE_HOURS: '12' })).toBe(12);
    expect(foreignMaxAgeHoursFromEnv({ VH_FOREIGN_MAX_AGE_HOURS: 'soon' })).toBe(DEFAULT_FOREIGN_MAX_AGE_HOURS);
    expect(foreignMaxAgeHoursFromEnv({})).toBe(DEFAULT_FOREIGN_MAX_AGE_HOURS);
    const root = tmp();
    oldTree(root, 'old');
    expect(await pruneStaleForeign(root, { maxAgeHours: 0, now: NOW })).toEqual({ removed: [], unjudged: [] });
    expect(existsSync(path.join(root, 'old'))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('an unreadable subtree is kept and reported as unjudged, never removed', async () => {
    const root = tmp();
    const dir = oldTree(root, 'locked');
    chmodSync(path.join(dir, 'sub'), 0o000);
    try {
      const r = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW });
      expect(r.removed).toEqual([]);
      expect(r.unjudged).toEqual([{ name: 'locked', reason: 'walk-error' }]);
      expect(formatForeignPruneLine(r)).toBe('VH_PRUNED_FOREIGN removed=- unjudged=locked:walk-error');
    } finally {
      chmodSync(path.join(dir, 'sub'), 0o755);
    }
    expect(existsSync(path.join(dir, 'sub', 'image.raw'))).toBe(true);
  });

  it('spends a bounded walk budget on the oldest entries first and reports the rest as unjudged', async () => {
    const root = tmp();
    oldTree(root, 'b-newer-old');
    const later = new Date('2025-06-01T00:00:00Z');
    utimesSync(path.join(root, 'b-newer-old'), later, later);
    oldTree(root, 'a-oldest'); // two readdirs of one entry each: exactly a budget of 2
    const r = await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW, walkBudget: 2 });
    expect(r).toEqual({ removed: ['a-oldest'], unjudged: [{ name: 'b-newer-old', reason: 'walk-budget' }] });
    expect(existsSync(path.join(root, 'b-newer-old', 'sub', 'image.raw'))).toBe(true);
    expect(FOREIGN_WALK_BUDGET).toBeGreaterThanOrEqual(1_000_000);
  });

  it('caches a freshness proof so a deep-fresh entry is walked once, not on every finalize', async () => {
    const root = tmp();
    const live = oldTree(root, 'deep-live');
    const proof = new Date(NOW - 60 * 60 * 1000); // modified an hour before NOW, deep in the tree
    utimesSync(path.join(live, 'sub', 'image.raw'), proof, proof);
    const horizon = proof.getTime() + 72 * 60 * 60 * 1000;

    expect(await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW })).toEqual({ removed: [], unjudged: [] });
    expect(JSON.parse(readFileSync(path.join(root, FOREIGN_FRESHNESS_CACHE), 'utf8'))).toEqual({ 'deep-live': horizon });

    // Within the horizon: a zero budget still judges nothing, because the proof stands.
    expect(await pruneStaleForeign(root, { maxAgeHours: 72, now: NOW + 1000, walkBudget: 0 })).toEqual({ removed: [], unjudged: [] });
    // Past it: the proof has expired, so the entry needs a walk again, which a zero budget cannot afford.
    expect(await pruneStaleForeign(root, { maxAgeHours: 72, now: horizon + 1, walkBudget: 0 })).toEqual({
      removed: [],
      unjudged: [{ name: 'deep-live', reason: 'walk-budget' }],
    });
    expect(existsSync(path.join(live, 'sub', 'image.raw'))).toBe(true);
    // Past it with a budget: nothing changed under it for 72h, so it goes, and the cache forgets it.
    expect(await pruneStaleForeign(root, { maxAgeHours: 72, now: horizon + 1 })).toEqual({ removed: ['deep-live'], unjudged: [] });
    expect(JSON.parse(readFileSync(path.join(root, FOREIGN_FRESHNESS_CACHE), 'utf8'))).toEqual({});
  });

  it('pruneEvidenceRoot applies run-count and foreign-age retention together', async () => {
    const root = tmp();
    for (const n of ['20260101T000000Z-1', '20260102T000000Z-2', '20260103T000000Z-3']) {
      mkdirSync(path.join(root, n));
      writeFileSync(path.join(root, n, 'result.json'), JSON.stringify({
        schemaVersion: 1,
        runId: n,
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
        verdict: 'fail',
        phases: [],
      }));
    }
    oldTree(root, 'old-scratch');
    const r = await pruneEvidenceRoot(
      root,
      { VH_KEEP_RUNS: '1', VH_FOREIGN_MAX_AGE_HOURS: '72' },
      NOW,
      {
        measureDisk: async () => ({ totalBytes: 1_000, availableBytes: 500 }),
        reserveBytes: () => 400,
      },
    );
    expect(r.runs.sort()).toEqual(['20260101T000000Z-1', '20260102T000000Z-2']);
    expect(r.foreign).toEqual({ removed: ['old-scratch'], unjudged: [] });
    expect(formatForeignPruneLine(r.foreign)).toBe('VH_PRUNED_FOREIGN removed=old-scratch unjudged=-');
    expect(formatForeignPruneLine({ removed: [], unjudged: [] })).toBeNull();
  });

  it('vh.sh finalize prunes a stale hand-named dir in its evidence root and says so on stderr', () => {
    const r = run(`
mkdir -p "$ROOT/ev/old-scratch/sub" "$ROOT/ev/new-scratch"
touch -d '2020-01-01T00:00:00Z' "$ROOT/ev/old-scratch/sub" "$ROOT/ev/old-scratch"
${chain}
vh_begin prep
vh_begin build
vh_begin ship
exit 0
`);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('VH_PRUNED_FOREIGN removed=old-scratch unjudged=-');
    expect(existsSync(path.join(r.root, 'ev', 'old-scratch'))).toBe(false);
    expect(existsSync(path.join(r.root, 'ev', 'new-scratch'))).toBe(true);
  });
});
