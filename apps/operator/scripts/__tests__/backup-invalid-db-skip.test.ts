import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-10003455 — INVALID databases must not redden the hourly backup.
 *
 * A DROP DATABASE interrupted mid-flight (PG ≥15) leaves the pg_database row
 * behind with datconnlimit = -2 while datallowconn stays TRUE. The old
 * enumeration (`datistemplate=false AND datallowconn`) admitted those rows, so
 * pg_dump hit "cannot connect to invalid database" and the unit exited 1 on
 * EVERY run (measured 2026-09-27: 18 such leftovers) while the real dumps were
 * fine — a permanent red that masks the real failure it exists to report.
 *
 * The guard below RUNS the script's actual enumeration block (extracted by its
 * markers, not re-typed) against a stub `sudo` that answers like Postgres does
 * for a catalog holding one valid and two invalid databases, and asserts the
 * invalid ones are (a) not dumped, (b) recorded in INVALID_SKIPPED, (c) logged.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) rather than by mutating the shared checkout.
const SCRIPT =
  process.env.BACKUP_INVALID_DB_SCRIPT ??
  resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

const src = readFileSync(SCRIPT, 'utf8');

/** The enumeration block: from DB_SELECT_SQL= through the INVALID_SKIPPED log `fi`. */
function enumerationBlock(): string {
  const start = src.indexOf('DB_SELECT_SQL=');
  expect(start, 'DB_SELECT_SQL assignment must exist').toBeGreaterThan(-1);
  const logIdx = src.indexOf('WARN skipping', start);
  expect(logIdx, 'invalid-db WARN log must follow the enumeration').toBeGreaterThan(-1);
  const fiIdx = src.indexOf('\nfi', logIdx);
  expect(fiIdx).toBeGreaterThan(-1);
  return src.slice(start, fiIdx + 3);
}

/**
 * Stub `sudo` emulating Postgres' answer to whichever query it is handed:
 * catalog = { papercusp: valid, papercusp_it_baseline_abc: invalid, org_x: invalid }
 * (all three have datallowconn = true, exactly as observed live).
 */
const STUB_SUDO = `#!/usr/bin/env bash
sql="\${@: -1}"
rows=$'papercusp\\t1\\t-1\\npapercusp_it_baseline_abc\\t1\\t-2\\norg_x\\t1\\t-2'
while IFS=$'\\t' read -r name allow limit; do
  keep=1
  case "$sql" in
    *"datconnlimit = -2"*) [ "$limit" = "-2" ] || keep=0 ;;
  esac
  case "$sql" in
    *"datconnlimit <> -2"*) [ "$limit" != "-2" ] || keep=0 ;;
  esac
  case "$sql" in
    *datallowconn*) [ "$allow" = 1 ] || keep=0 ;;
  esac
  [ "$keep" = 1 ] && echo "$name"
done <<< "$rows"
exit 0
`;

function runEnumeration() {
  const dir = mkdtempSync(join(tmpdir(), 'backup-invalid-db-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'sudo'), STUB_SUDO);
    chmodSync(join(bin, 'sudo'), 0o755);
    const harness = [
      'set -uo pipefail',
      `EXCLUDE_RE='(_test$|^template)'`,
      `log() { printf 'LOG %s\\n' "$*"; }`,
      enumerationBlock(),
      `printf 'DBS=%s\\n' "$(echo $DBS)"`,
      `printf 'INVALID=%s\\n' "\${INVALID_SKIPPED[*]}"`,
    ].join('\n');
    const out = execFileSync('bash', ['-c', harness], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('papercusp-db-backup.sh — invalid (datconnlimit=-2) databases (WI-10003455)', () => {
  it('does not select invalid databases for dumping', () => {
    const out = runEnumeration();
    expect(out).toMatch(/^DBS=papercusp$/m);
  });

  it('records every invalid database in INVALID_SKIPPED and logs them (skipped, not silent)', () => {
    const out = runEnumeration();
    expect(out).toMatch(/^INVALID=papercusp_it_baseline_abc org_x$/m);
    expect(out).toMatch(/LOG WARN skipping 2 INVALID database\(s\)/);
  });

  it('never folds invalid databases into FAILED — they are reported in STATUS.json invalidSkipped', () => {
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/FAILED\+=\(\s*"\$inv"/);
    expect(code).toMatch(/"invalidSkipped": \[%s\]/);
  });
});

/**
 * Plan papercusp-db-backup-invalid-db-2026-09-27 — clauses AUTO-BAR-R-1 (unit
 * layer) and P-001-VALID-DUMP-FAILURE.
 *
 * Runs the script's REAL enumeration -> per-database dump loop -> OK /
 * STATUS.json / exit tail, each extracted by its markers (never re-typed), with
 * only the two external edges stubbed: `sudo` (the Postgres catalog) and
 * `dump_one` (pg_dump). The dump_one stub fails for every INVALID database,
 * which is what pg_dump really does ("cannot connect to invalid database"), so
 * if the enumeration ever admits one again the exit code turns red HERE.
 *
 * The two cases pull in opposite directions on purpose: skipping must keep an
 * INVALID leftover from reddening the run, and must NOT also swallow a genuine
 * dump failure on a VALID database.
 */
const PIPELINE_CATALOG: ReadonlyArray<readonly [name: string, allow: string, limit: string]> = [
  ['papercusp', '1', '-1'],
  ['oddsdb', '1', '-1'],
  ['papercusp_it_baseline_abc', '1', '-2'],
  ['org_x', '1', '-2'],
];
const INVALID_NAMES = PIPELINE_CATALOG.filter((r) => r[2] === '-2').map((r) => r[0]);

function pipelineStubSudo(): string {
  const rowsLit = PIPELINE_CATALOG.map((r) => r.join('\\t')).join('\\n');
  // Function replacement: in a replacement STRING, `$'` means "text after the
  // match", which would silently corrupt bash's `$'…'` quoting.
  const stub = STUB_SUDO.replace(/^rows=.*$/m, () => `rows=$'${rowsLit}'`);
  expect(stub, 'catalog rows must be substituted into the sudo stub').not.toBe(STUB_SUDO);
  return stub;
}

/** From `is_tiered() {` through the end of the `for db in $DBS; do … done` loop. */
function dumpLoopBlock(): string {
  const start = src.indexOf('is_tiered() {');
  expect(start, 'is_tiered() must exist').toBeGreaterThan(-1);
  const loop = src.indexOf('for db in $DBS; do', start);
  expect(loop, 'the per-database dump loop must follow is_tiered').toBeGreaterThan(-1);
  const end = src.indexOf('\ndone\n', loop);
  expect(end).toBeGreaterThan(-1);
  const block = src.slice(start, end + 5);
  expect(block, 'the loop must route dump_one failures into FAILED').toMatch(/dump_one "\$db" "\$db"/);
  return block;
}

/**
 * `guarded_dump_one() { … }` — what the loop above has called since WI-10008166
 * (2026-10-10). It is defined ABOVE is_tiered(), so dumpLoopBlock() does not carry
 * it. Left out, every dump is `guarded_dump_one: command not found` (exit 127):
 * nothing is attempted and every database lands in FAILED.
 */
function guardedDumpBlock(): string {
  const start = src.indexOf('guarded_dump_one() {');
  expect(start, 'guarded_dump_one() must exist').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(-1);
  return src.slice(start, end + 2);
}

/**
 * guarded_dump_one's third external edge: the migration rendezvous, a Postgres
 * advisory-lock session held around each dump of the migration database. It is
 * stubbed here like `sudo` and `dump_one`; its real behaviour is pinned by
 * backup-migration-rendezvous.test.ts.
 */
const RENDEZVOUS_EDGE_STUB = [
  'BACKUP_MIGRATION_ADVISORY_DATABASE=papercusp',
  'acquire_migration_rendezvous() { return 0; }',
  'release_migration_rendezvous() { :; }',
  'reap_own_stragglers() { :; }',
].join('\n');

/** From the ELAPSED computation to end of file: OK, STATUS.json, and the exit code. */
function tailBlock(): string {
  const start = src.indexOf('ELAPSED=$(( $(date +%s) - START ))');
  expect(start, 'ELAPSED computation must exist').toBeGreaterThan(-1);
  return src.slice(start);
}

/**
 * The tail's recovery broadcast (coord:send through scripts/mcp-call.mjs, reached
 * only on an OK run) is an outward-facing edge that reads BACKUP_REPO_ROOT, which
 * the script sets above the tail. Left unset, nounset aborts the OK path (exit
 * 127). An EMPTY root takes the broadcast's "coord:send unavailable" branch, so
 * this suite can never tell the fleet "BACKUP RECOVERED". Never point it at a
 * real checkout here.
 */
const RECOVERY_EDGE_STUB = "BACKUP_REPO_ROOT=''";

function runPipeline(failDbs: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-pipeline-'));
  try {
    const bin = join(dir, 'bin');
    const dump = join(dir, 'dump');
    execFileSync('mkdir', ['-p', bin, dump]);
    writeFileSync(join(bin, 'sudo'), pipelineStubSudo());
    chmodSync(join(bin, 'sudo'), 0o755);
    const harness = [
      'set -uo pipefail',
      `EXCLUDE_RE='(_test$|^template)'`,
      `log() { printf 'LOG %s\\n' "$*"; }`,
      enumerationBlock(),
      'DUMPED=(); FAILED=(); TIER_DUMPED=(); TIER_FAILED=()',
      'PC_BACKUP_TIERS_ENABLED=0; PC_BACKUP_TIER_DBS=papercusp',
      // pg_dump edge: record the attempt, fail for anything in STUB_FAIL_DBS.
      `dump_one() { printf 'DUMP_ATTEMPT %s\\n' "$1"; case " $STUB_FAIL_DBS " in *" $1 "*) return 1 ;; esac; return 0; }`,
      RENDEZVOUS_EDGE_STUB,
      guardedDumpBlock(),
      dumpLoopBlock(),
      `START=$(date +%s); DUMP='${dump}'; STATUS="$DUMP/STATUS.json"; ODDS_OK=false; ODDS_NOTE=''; PSQL=false`,
      // WI-10004603 state set BETWEEN the dump loop and the tail (neither block
      // carries it). Without these `set -u` aborts before STATUS.json is written.
      'TIER_NOT_DUE=(); PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC=9000',
      RECOVERY_EDGE_STUB,
      tailBlock(),
    ].join('\n');
    const run = spawnSync('bash', ['-c', harness], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_FAIL_DBS: failDbs.join(' ') },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const status = JSON.parse(readFileSync(join(dump, 'STATUS.json'), 'utf8')) as {
      ok: boolean;
      dumped: string[];
      failed: string[];
      invalidSkipped: string[];
    };
    const attempted = [...run.stdout.matchAll(/^DUMP_ATTEMPT (\S+)$/gm)].map((m) => m[1]);
    return { exitCode: run.status, status, attempted, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('papercusp-db-backup.sh — exit code with INVALID leftovers present (plan papercusp-db-backup-invalid-db-2026-09-27)', () => {
  it('AUTO-BAR-R-1: exits 0 and reports ok while INVALID databases exist, dumping only the valid ones', () => {
    // pg_dump fails on every INVALID database, exactly as it does live.
    const r = runPipeline(INVALID_NAMES);
    expect(r.attempted).toEqual(['papercusp', 'oddsdb']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr, 'the recovery broadcast must stay disabled under test').toMatch(/coord:send unavailable/);
    expect(r.status.ok).toBe(true);
    expect(r.status.failed).toEqual([]);
    expect(r.status.dumped).toEqual(['papercusp', 'oddsdb']);
    expect([...r.status.invalidSkipped].sort()).toEqual([...INVALID_NAMES].sort());
  });

  it('P-001-VALID-DUMP-FAILURE: a pg_dump failure on a VALID database exits non-zero and lists it in STATUS.json failed', () => {
    const r = runPipeline([...INVALID_NAMES, 'oddsdb']);
    expect(r.attempted).toEqual(['papercusp', 'oddsdb']);
    expect(r.exitCode).toBe(1);
    expect(r.status.ok).toBe(false);
    expect(r.status.failed).toEqual(['oddsdb']);
    expect(r.status.dumped).toEqual(['papercusp']);
    // The INVALID leftovers stay reported as skipped, never folded into failed.
    expect([...r.status.invalidSkipped].sort()).toEqual([...INVALID_NAMES].sort());
    expect(r.stdout).toMatch(/LOG backup FAILED in \d+s: oddsdb$/m);
  });
});

/**
 * WI-10006723 — a database DROPPED between enumeration and its dump.
 *
 * Measured 2026-10-06: the 06:48 EDT run enumerated three P-011 rehearsal
 * databases that the rehearsal dropped while the run was still working through
 * its list. Each later pg_dump failed with `database "p011_pre" does not exist`
 * and the run ended `backup FAILED ... p011_pre p011_mid p011_post`, although
 * every database that still existed dumped fine.
 *
 * Same real enumeration -> dump loop -> STATUS.json tail as above, but the
 * stubbed catalog lives in a FILE so the dump_one stub can drop a database
 * DURING its dump, exactly as happened live: it is enumerated, then gone when
 * the dump runs, then gone when the loop re-checks. The catalog can also be
 * taken down mid-run, which must never be read as "the database is gone".
 */
const DROP_CATALOG: ReadonlyArray<readonly [name: string, allow: string, limit: string]> = [
  ['papercusp', '1', '-1'],
  ['p011_pre', '1', '-1'],
  ['oddsdb', '1', '-1'],
  ['org_x', '1', '-2'],
];

function runDropPipeline(opts: { drop?: string[]; fail?: string[]; catalogDownOn?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-vanished-'));
  try {
    const bin = join(dir, 'bin');
    const dump = join(dir, 'dump');
    execFileSync('mkdir', ['-p', bin, dump]);
    writeFileSync(join(dir, 'catalog'), `${DROP_CATALOG.map((r) => r.join('\t')).join('\n')}\n`);
    const stub = STUB_SUDO.replace(
      /^rows=.*$/m,
      () => '[ -e "$STUB_DIR/catalog-down" ] && exit 2\nrows=$(cat "$STUB_DIR/catalog")',
    );
    expect(stub, 'the catalog must be read from the file').not.toBe(STUB_SUDO);
    writeFileSync(join(bin, 'sudo'), stub);
    chmodSync(join(bin, 'sudo'), 0o755);
    const harness = [
      'set -uo pipefail',
      `EXCLUDE_RE='(_test$|^template)'`,
      `log() { printf 'LOG %s\\n' "$*"; }`,
      enumerationBlock(),
      'DUMPED=(); FAILED=(); TIER_DUMPED=(); TIER_FAILED=()',
      'PC_BACKUP_TIERS_ENABLED=0; PC_BACKUP_TIER_DBS=papercusp',
      // pg_dump edge. STUB_DOWN_DBS: Postgres goes away during this dump.
      // STUB_DROP_DBS: the database is dropped during its dump (pg_dump then
      // fails with "does not exist"). STUB_FAIL_DBS: a real dump failure on a
      // database that still exists.
      [
        `dump_one() { printf 'DUMP_ATTEMPT %s\\n' "$1";`,
        `case " $STUB_DOWN_DBS " in *" $1 "*) touch "$STUB_DIR/catalog-down"; return 1 ;; esac;`,
        `case " $STUB_DROP_DBS " in *" $1 "*) awk -F'\\t' -v n="$1" '$1 != n' "$STUB_DIR/catalog" > "$STUB_DIR/catalog.next" && mv "$STUB_DIR/catalog.next" "$STUB_DIR/catalog"; return 1 ;; esac;`,
        `case " $STUB_FAIL_DBS " in *" $1 "*) return 1 ;; esac; return 0; }`,
      ].join(' '),
      RENDEZVOUS_EDGE_STUB,
      guardedDumpBlock(),
      dumpLoopBlock(),
      `START=$(date +%s); DUMP='${dump}'; STATUS="$DUMP/STATUS.json"; ODDS_OK=false; ODDS_NOTE=''; PSQL=false`,
      'TIER_NOT_DUE=(); PC_BACKUP_TRANSCRIPT_MIN_AGE_SEC=9000',
      RECOVERY_EDGE_STUB,
      tailBlock(),
    ].join('\n');
    const run = spawnSync('bash', ['-c', harness], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_DIR: dir,
        STUB_DROP_DBS: (opts.drop ?? []).join(' '),
        STUB_FAIL_DBS: (opts.fail ?? []).join(' '),
        STUB_DOWN_DBS: (opts.catalogDownOn ?? []).join(' '),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    const status = JSON.parse(readFileSync(join(dump, 'STATUS.json'), 'utf8')) as {
      ok: boolean;
      dumped: string[];
      failed: string[];
      invalidSkipped: string[];
      vanishedSkipped: string[];
    };
    const attempted = [...run.stdout.matchAll(/^DUMP_ATTEMPT (\S+)$/gm)].map((m) => m[1]);
    return { exitCode: run.status, status, attempted, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('papercusp-db-backup.sh — a database dropped after enumeration (WI-10006723)', () => {
  it('records it as vanished, not failed, and the run stays ok', () => {
    const r = runDropPipeline({ drop: ['p011_pre'] });
    expect(r.attempted, 'p011_pre must have been enumerated and attempted').toEqual(['papercusp', 'p011_pre', 'oddsdb']);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stderr, 'the recovery broadcast must stay disabled under test').toMatch(/coord:send unavailable/);
    expect(r.status.ok).toBe(true);
    expect(r.status.failed).toEqual([]);
    expect(r.status.dumped).toEqual(['papercusp', 'oddsdb']);
    expect(r.status.vanishedSkipped).toEqual(['p011_pre']);
    expect(r.status.invalidSkipped).toEqual(['org_x']);
    expect(r.stdout).toMatch(/^LOG p011_pre VANISHED — dropped after enumeration/m);
    expect(r.stdout).toMatch(/^LOG backup OK in \d+s: papercusp oddsdb \(vanished after enumeration: p011_pre\)$/m);
  });

  it('still fails the run on a real dump failure of a database that exists', () => {
    const r = runDropPipeline({ drop: ['p011_pre'], fail: ['oddsdb'] });
    expect(r.exitCode).toBe(1);
    expect(r.status.ok).toBe(false);
    expect(r.status.failed).toEqual(['oddsdb']);
    expect(r.status.vanishedSkipped).toEqual(['p011_pre']);
    expect(r.stdout).toMatch(/^LOG backup FAILED in \d+s: oddsdb$/m);
  });

  it('never reads an unreachable catalog as "the database is gone"', () => {
    // Postgres goes away during p011_pre's dump: the dump fails AND the
    // presence re-check cannot read pg_database. That must count as FAILED.
    const r = runDropPipeline({ catalogDownOn: ['p011_pre'] });
    expect(r.attempted).toContain('p011_pre');
    expect(r.exitCode).toBe(1);
    expect(r.status.ok).toBe(false);
    expect(r.status.failed).toContain('p011_pre');
    expect(r.status.vanishedSkipped).toEqual([]);
    expect(r.stdout).not.toMatch(/VANISHED/);
  });
});
