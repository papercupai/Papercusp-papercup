import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * EI-22634893804237362 — the host `pcbackup` producer must participate in the
 * same Postgres advisory rendezvous as db:migrate and boot-migrate.
 *
 * The per-workspace backup path already held this key, but the systemd host
 * script only tagged its pg_dump backend. A long host dump could therefore
 * acquire AccessShareLock while a migration was retrying ACCESS EXCLUSIVE and
 * exhaust every short lock-timeout attempt. These tests pin the producer-side
 * contract and execute the real lock helper against a fake psql session.
 */

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this suite at an out-of-tree
// mutant copy (copy-out mode) instead of mutating the shared tree.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function stripCommentLines(shell: string): string {
  return shell
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function extractFunction(name: string, endMarker: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start);
  if (end < 0) return '';
  return source.slice(start, end + 2);
}

describe('papercusp-db-backup.sh migration rendezvous (EI-22634893804237362)', () => {
  it('is valid shell and holds the shared lock around each migration-database dump only', () => {
    expect(execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).toBe('');
    const stripped = stripCommentLines(source);
    expect(stripped).toContain("readonly BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'");
    expect(stripped).toContain("readonly BACKUP_MIGRATION_ADVISORY_DATABASE='papercusp'");
    expect(stripped).toContain('coproc BACKUP_MIGRATION_LOCK_PSQL');
    expect(stripped).toContain('-d "$BACKUP_MIGRATION_ADVISORY_DATABASE"');
    expect(stripped).toContain("'SET lock_timeout = 0;'");
    expect(stripped).toContain("'SET statement_timeout = 0;'");
    expect(stripped).toContain("pg_advisory_lock(hashtext('$BACKUP_MIGRATION_ADVISORY_LOCK_KEY'))");
    // The EXIT trap must still release the rendezvous. Since the IN_PROGRESS
    // progress-marker cleanup joined it, the trap is the quoted two-command form,
    // so accept either shape rather than one literal spelling.
    expect(stripped).toMatch(/^trap (?:release_migration_rendezvous|'[^']*\brelease_migration_rendezvous\b[^']*') EXIT$/m);

    // WI-10008166: the rendezvous used to be acquired once before the first dump
    // and released only after the transcript tier, so it covered every other
    // database on the cluster and the oddsmith dump on ANOTHER server (~3.4 h on
    // 2026-10-10) while armed migrations waited. Advisory and relation locks are
    // per-database, so only a dump of the migration database can collide. The
    // ONLY acquire call site is now inside guarded_dump_one.
    expect(stripped, 'no whole-run acquire may come back').not.toContain('acquire_migration_rendezvous || exit 1');
    const guarded = extractFunction('guarded_dump_one', '\n}\n');
    expect(guarded, 'expected the guarded_dump_one helper').not.toBe('');
    const acquireCalls = stripped
      .split('\n')
      .filter((line) => /\bacquire_migration_rendezvous\b/.test(line) && !line.includes('acquire_migration_rendezvous() {'));
    expect(acquireCalls).toEqual(['  if ! acquire_migration_rendezvous "$label"; then']);
    expect(guarded).toContain('if [ "$db" != "$BACKUP_MIGRATION_ADVISORY_DATABASE" ]; then');

    // Every dump of the migration database goes through the guard: the state and
    // transcript tiers, and the undifferentiated fallback used when tiers are off.
    expect(stripped).toContain('guarded_dump_one "$db" "$db-state" "${ex[@]}"');
    expect(stripped).toContain('guarded_dump_one "$db" "$db-transcript" --compress=zstd:level=1 "${inc[@]}"');
    expect(stripped).toContain('if guarded_dump_one "$db" "$db"; then');
    expect(stripped).not.toMatch(/(?<!guarded_)dump_one "\$db" "\$db(-state|-transcript)?"/);

    // The backstop release before oddsmith is UNCONDITIONAL (top level, not
    // inside a TRANSCRIPT_DUE branch), and the transcript phase still runs after
    // oddsmith — re-acquiring through the guard for exactly that dump.
    const oddsmith = stripped.indexOf('ODDSMITH_DISCOVERY=');
    const backstop = stripped.indexOf('\nrelease_migration_rendezvous\nreap_own_stragglers');
    expect(backstop, 'expected the unconditional pre-oddsmith release').toBeGreaterThan(0);
    expect(oddsmith).toBeGreaterThan(backstop);
    expect(stripped).not.toContain('if [ ${#TRANSCRIPT_DUE[@]} -eq 0 ]; then\n  release_migration_rendezvous');
    expect(stripped.indexOf('if [ ${#TRANSCRIPT_DUE[@]} -gt 0 ]; then')).toBeGreaterThan(oddsmith);
  });

  it('holds the lock only while a migration-database leg dumps, and re-acquires per leg', () => {
    const acquire = extractFunction('acquire_migration_rendezvous', '\n}\n\n# guarded_dump_one');
    const release = extractFunction('release_migration_rendezvous', '\n}\n');
    const guarded = extractFunction('guarded_dump_one', '\n}\n');
    expect(acquire).not.toBe('');
    expect(release).not.toBe('');
    expect(guarded).not.toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'backup-rendezvous-guard-'));
    try {
      const fakeSudo = join(dir, 'sudo');
      const fakePsql = join(dir, 'psql');
      const trace = join(dir, 'trace');
      // FAIL_RENDEZVOUS=1 makes the lock session die before granting, the
      // "could not acquire" path. It consumes the request first so the helper's
      // write cannot race the reader's exit (SIGPIPE).
      writeFileSync(
        fakeSudo,
        '#!/usr/bin/env bash\n' +
          'if [ "${FAIL_RENDEZVOUS:-0}" = 1 ]; then read -r _; exit 1; fi\n' +
          'while [ "$#" -gt 0 ] && [ "$1" != env ]; do shift; done\n' +
          '[ "$1" = env ] && shift\n' +
          'shift\n' +
          'exec "$@"\n',
      );
      writeFileSync(
        fakePsql,
        '#!/usr/bin/env bash\n' +
          `echo session >>${JSON.stringify(trace)}\n` +
          'while IFS= read -r line; do\n' +
          '  case "$line" in\n' +
          '    "\\\\echo "*) printf "%s\\n" "${line#\\\\echo }" ;;\n' +
          '    "\\\\q") exit 0 ;;\n' +
          '  esac\n' +
          'done\n',
      );
      chmodSync(fakeSudo, 0o755);
      chmodSync(fakePsql, 0o755);

      const harness = [
        'set -uo pipefail',
        `PATH=${JSON.stringify(dir)}:$PATH`,
        `TRACE=${JSON.stringify(trace)}`,
        `HOST_BACKUP_APPLICATION_NAME=pcbackup`,
        `BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'`,
        `BACKUP_MIGRATION_ADVISORY_DATABASE=papercusp`,
        `BACKUP_MIGRATION_LOCK_READY='papercusp_backup_migration_lock_acquired'`,
        `BACKUP_MIGRATION_LOCK_PID=''`,
        `BACKUP_MIGRATION_LOCK_IN_FD=''`,
        `BACKUP_MIGRATION_LOCK_OUT_FD=''`,
        `BACKUP_MIGRATION_LOCK_HELD=false`,
        'log() { :; }',
        'reap_own_stragglers() { :; }',
        // The stub records whether the rendezvous is held DURING each dump.
        'dump_one() { echo "dump $2 held=$BACKUP_MIGRATION_LOCK_HELD" >>"$TRACE"; [ "$2" != papercusp-broken ]; }',
        release,
        acquire,
        guarded,
        'guarded_dump_one email_app email_app',
        'guarded_dump_one papercusp papercusp-state --exclude-table-data=x',
        'echo "between held=$BACKUP_MIGRATION_LOCK_HELD" >>"$TRACE"',
        'guarded_dump_one oddsmith oddsmith',
        'guarded_dump_one papercusp papercusp-transcript --table=x',
        'guarded_dump_one papercusp papercusp-broken; echo "broken rc=$? held=$BACKUP_MIGRATION_LOCK_HELD" >>"$TRACE"',
        'FAIL_RENDEZVOUS=1 guarded_dump_one papercusp papercusp-unguarded; echo "unacquired rc=$?" >>"$TRACE"',
        'echo "end held=$BACKUP_MIGRATION_LOCK_HELD" >>"$TRACE"',
      ].join('\n');

      execFileSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 20_000 });
      expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
        'dump email_app held=false',
        'session',
        'dump papercusp-state held=true',
        'between held=false',
        'dump oddsmith held=false',
        'session',
        'dump papercusp-transcript held=true',
        'session',
        'dump papercusp-broken held=true',
        'broken rc=1 held=false',
        // The lock session never granted, so the leg is NOT dumped unguarded.
        'unacquired rc=1',
        'end held=false',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the dedicated lock session open until the real release helper closes it', () => {
    const acquire = extractFunction('acquire_migration_rendezvous', '\n}\n\n# guarded_dump_one');
    const release = extractFunction('release_migration_rendezvous', '\n}\n');
    expect(acquire).not.toBe('');
    expect(release).not.toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'backup-rendezvous-'));
    try {
      const fakeSudo = join(dir, 'sudo');
      const fakePsql = join(dir, 'psql');
      const state = join(dir, 'state');
      writeFileSync(
        fakeSudo,
        '#!/usr/bin/env bash\n' +
          'set -e\n' +
          'while [ "$#" -gt 0 ] && [ "$1" != env ]; do shift; done\n' +
          '[ "$1" = env ] && shift\n' +
          'shift\n' +
          'exec "$@"\n',
      );
      writeFileSync(
        fakePsql,
        '#!/usr/bin/env bash\n' +
          'set -eu\n' +
          `state=${JSON.stringify(state)}\n` +
          'printf "%s\\n" "$@" >"$state.args"\n' +
          ': >"$state.started"\n' +
          'while IFS= read -r line; do\n' +
          '  case "$line" in\n' +
          '    "\\\\echo "*) printf "%s\\n" "${line#\\\\echo }" ;;\n' +
          '    "\\\\q") : >"$state.released"; exit 0 ;;\n' +
          '  esac\n' +
          'done\n',
      );
      chmodSync(fakeSudo, 0o755);
      chmodSync(fakePsql, 0o755);

      const harness = [
        'set -euo pipefail',
        `PATH=${JSON.stringify(dir)}:$PATH`,
        `HOST_BACKUP_APPLICATION_NAME=pcbackup`,
        `BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'`,
        `BACKUP_MIGRATION_ADVISORY_DATABASE=papercusp`,
        `BACKUP_MIGRATION_LOCK_READY='papercusp_backup_migration_lock_acquired'`,
        `BACKUP_MIGRATION_LOCK_PID=''`,
        `BACKUP_MIGRATION_LOCK_IN_FD=''`,
        `BACKUP_MIGRATION_LOCK_OUT_FD=''`,
        `BACKUP_MIGRATION_LOCK_HELD=false`,
        'log() { :; }',
        release,
        acquire,
        'acquire_migration_rendezvous',
        'test "$BACKUP_MIGRATION_LOCK_HELD" = true',
        `test -e ${JSON.stringify(state + '.started')}`,
        'release_migration_rendezvous',
        `test -e ${JSON.stringify(state + '.released')}`,
      ].join('\n');

      execFileSync('bash', ['-c', harness], { encoding: 'utf8' });
      const args = readFileSync(state + '.args', 'utf8').trim().split('\n');
      const databaseArg = args.indexOf('-d');
      expect(databaseArg).toBeGreaterThanOrEqual(0);
      expect(args[databaseArg + 1]).toBe('papercusp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
