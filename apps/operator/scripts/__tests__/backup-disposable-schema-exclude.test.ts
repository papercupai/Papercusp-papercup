import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-10004136 — the host backup must not dump the memory benches' throwaway
 * schemas.
 *
 * Measured 2026-09-30 04:19Z: the hourly pg_dump (application_name pcbackup)
 * held AccessShareLock on every table of bench_memory_2793796 for 9.5 min, so
 * the bench's end-of-run DROP SCHEMA CASCADE hit lock_timeout three times and
 * the schema leaked. The fix passes --exclude-schema="$DISPOSABLE_SCHEMA_PATTERN"
 * to the ONE pg_dump call site, dump_one(), which every dump (whole-database and
 * both tiers) goes through.
 *
 * The pattern's semantics were verified against a real pg_dump on 2026-09-30:
 * with --exclude-schema='bench_memory*' a schema-only dump dropped
 * bench_memory_999 and bench_memory and kept keep_me and benchxmemory_1 (so `_`
 * is literal, not a wildcard).
 */

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const BENCH_HOST = resolve(__dirname, '..', '..', '..', '..', 'packages', 'operator-core', 'lib', 'memory', 'bench', 'bench-host.ts');
const src = readFileSync(SCRIPT, 'utf8');

function patternLine(): string {
  const m = src.match(/^readonly DISPOSABLE_SCHEMA_PATTERN=.*$/m);
  expect(m, 'DISPOSABLE_SCHEMA_PATTERN must be a readonly top-level constant').not.toBeNull();
  return m![0];
}

function patternValue(): string {
  const m = patternLine().match(/^readonly DISPOSABLE_SCHEMA_PATTERN='([^']+)'$/);
  expect(m, 'the pattern must be a single-quoted literal so the shell never globs it').not.toBeNull();
  return m![1];
}

function dumpOneBlock(): string {
  const start = src.indexOf('\ndump_one() {\n');
  expect(start, 'dump_one() must exist').toBeGreaterThan(-1);
  const end = src.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start + 1, end + 3);
}

/** Run the real dump_one() with pg_dump's launcher stubbed; return the argv it received per call. */
function pgDumpArgv(calls: ReadonlyArray<readonly string[]>): string[][] {
  const dir = mkdtempSync(join(tmpdir(), 'backup-exclude-'));
  try {
    const harness = [
      'set -uo pipefail',
      patternLine(),
      `PGOUT='${dir}'; JOBS=4; TIMEOUT_SEC=60; TIMEOUT_MAX_SEC=120; BACKUP_USER=nobody`,
      'PC_BACKUP_SPACE_SAFETY=150; PC_BACKUP_MIN_FREE_GB=5',
      'HOST_BACKUP_APPLICATION_NAME=pcbackup',
      // dump_one records the database identity before launching pg_dump. Keep
      // that real boundary in the fixture without probing the host database.
      'PSQL=backup_fixture_psql',
      'backup_fixture_psql() { printf "123456789\\n"; }',
      'declare -A ARTIFACT_DUMP_START_EPOCHS=() ARTIFACT_DUMP_SYSTEM_IDENTIFIERS=()',
      `log() { printf 'LOG %s\\n' "$*"; }`,
      'rm_tmp() { :; }',
      'fs_avail_gb() { echo 1000; }',
      // Record the launched command's argv, then fail so dump_one takes its failure path.
      `run_bounded_watched() { shift 3; printf 'CALL\\n'; printf 'ARG %s\\n' "$@"; return 3; }`,
      dumpOneBlock(),
      ...calls.map((args) => `dump_one ${args.map((a) => `'${a}'`).join(' ')} || true`),
    ].join('\n');
    const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr).toBe(0);
    return run.stdout
      .split('CALL\n')
      .slice(1)
      .map((chunk) => [...chunk.matchAll(/^ARG (.*)$/gm)].map((m) => m[1]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** psql-style pattern (what pg_dump --exclude-schema takes) as an anchored regex. */
function psqlPatternToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

describe('papercusp-db-backup.sh — disposable bench schemas are excluded from every dump (WI-10004136)', () => {
  it('dump_one passes --exclude-schema with the pattern to pg_dump, for whole-database and tier dumps alike', () => {
    const [whole, tier] = pgDumpArgv([
      ['papercusp', 'papercusp'],
      ['papercusp', 'papercusp-transcript', '--table=harness_shared.session_turns'],
    ]);
    for (const argv of [whole, tier]) {
      expect(argv).toContain('pg_dump');
      expect(argv).toContain(`--exclude-schema=${patternValue()}`);
      const at = argv.indexOf(`--exclude-schema=${patternValue()}`);
      expect(at, 'the exclude must be a pg_dump option, before -f').toBeLessThan(argv.indexOf('-f'));
      expect(at).toBeGreaterThan(argv.indexOf('pg_dump'));
    }
    expect(whole.at(-1)).toBe('papercusp');
    expect(tier, 'caller-supplied tier args still reach pg_dump').toContain('--table=harness_shared.session_turns');
  });

  it('the pattern matches the schema names the memory bench creates, and nothing a restore needs', () => {
    const benchSrc = readFileSync(BENCH_HOST, 'utf8');
    const tmpl = benchSrc.match(/`(bench_memory_)\$\{process\.pid\}`/);
    expect(tmpl, 'bench-host.ts must still name its schema bench_memory_<pid>').not.toBeNull();
    const re = psqlPatternToRegExp(patternValue());
    expect(re.test(`${tmpl![1]}2793796`)).toBe(true);
    expect(re.test('bench_memory'), 'the legacy fixed bench schema').toBe(true);
    for (const kept of ['harness_shared', 'public', 'mem0', 'dbos', 'benchxmemory_1', 'memory_bench']) {
      expect(re.test(kept), kept).toBe(false);
    }
  });
});
