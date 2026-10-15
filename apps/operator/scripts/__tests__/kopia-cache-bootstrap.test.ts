import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SYSTEMD_DIR = resolve(__dirname, '..', 'systemd');
const HELPER = join(SYSTEMD_DIR, 'kopia-cache-bootstrap.sh');
const CONSUMERS = [
  'kopia-snapshot-all.sh',
  'kopia-home-snapshot.sh',
  'kopia-healthcheck.sh',
];
const ROOT_KOPIA_CALLERS = [...CONSUMERS, 'kopia-protected-snapshot.sh'];
const MOUNTED_SERVICES: Record<string, string> = {
  'kopia-home-snapshot.service': '/mnt/backup',
  'kopia-healthcheck.service': '/mnt/cold-a/Backup/db-dumps',
};

function runBootstrap(cacheDir: string) {
  return spawnSync(
    'bash',
    ['-c', 'source "$1"; ensure_kopia_cache_dir "$2"', 'kopia-cache-bootstrap-test', HELPER, cacheDir],
    { encoding: 'utf8' },
  );
}

function holdFixture(state: 't' | 'f' | 'unreadable', command: string, prepare?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'kopia-hold-lease-'));
  const trace = join(root, 'trace');
  const sudo = join(root, 'sudo');
  const psql = join(root, 'psql');
  try {
    writeFileSync(sudo, '#!/usr/bin/env bash\nwhile [ "$1" = -n ] || [ "$1" = -- ]; do shift; done\nif [ "$1" = -u ]; then shift 2; fi\nexec "$@"\n');
    writeFileSync(psql, '#!/usr/bin/env bash\nwhile IFS= read -r line; do\n printf "%s\\n" "$line" >>"$LEASE_TRACE"\n case "$line" in\n  SELECT*) [ "$LEASE_STATE" != unreadable ] || exit 1; printf "%s\\n" "$LEASE_STATE" ;;\n  *PAPERCUSP_HOLD_READY*) echo PAPERCUSP_HOLD_READY ;;\n esac\ndone\necho released >>"$LEASE_TRACE"\n');
    chmodSync(sudo, 0o755);
    chmodSync(psql, 0o755);
    prepare?.(root);
    const result = spawnSync('bash', ['-c', 'source "$1"; ' + command, 'hold-test', HELPER], {
      encoding: 'utf8', env: { ...process.env, LEASE_STATE: state, LEASE_TRACE: trace, TEST_ROOT: root,
        KOPIA_LOG_DIR: join(root, 'logs'), KOPIA_HOLD_SUDO_BIN: sudo, KOPIA_HOLD_PSQL_BIN: psql },
    });
    return { ...result, trace: existsSync(trace) ? readFileSync(trace, 'utf8') : '',
      current: existsSync(join(root, 'dump', 'body')) ? readFileSync(join(root, 'dump', 'body'), 'utf8') : null,
      archived: existsSync(join(root, 'saved')) ? readFileSync(join(root, 'saved'), 'utf8') : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('shared host backup legal-hold lease', () => {
  it.each(['t', 'f'] as const)('passes fresh %s state only after locking, and closes its session', (state) => {
    const r = holdFixture(state, 'callback() { echo "callback:$1" >>"$LEASE_TRACE"; }; kopia_with_hold_lease papercusp callback');
    expect(r.status, r.stderr).toBe(0);
    expect(r.trace.indexOf('LOCK TABLE')).toBeLessThan(r.trace.indexOf('SELECT EXISTS'));
    expect(r.trace.indexOf('SELECT EXISTS')).toBeLessThan(r.trace.indexOf(`callback:${state}`));
    expect(r.trace.trim().endsWith('released')).toBe(true);
  });

  it('refuses unreadable holds without calling the destructive callback', () => {
    const r = holdFixture('unreadable', 'callback() { echo DESTROYED >>"$LEASE_TRACE"; }; kopia_with_hold_lease papercusp callback');
    expect(r.status).not.toBe(0);
    expect(r.trace).not.toContain('DESTROYED');
  });

  it('preserves the previous directory dump while installing a new one under a hold', () => {
    const r = holdFixture('t', 'kopia_with_hold_lease papercusp kopia_install_dump_if_held "$TEST_ROOT/dump"; rc=$?; for old in "$TEST_ROOT"/dump.legal-hold/held.*/dump/body; do cat "$old" >"$TEST_ROOT/saved"; done; exit "$rc"', (root) => {
      mkdirSync(join(root, 'dump')); writeFileSync(join(root, 'dump', 'body'), 'previous');
      mkdirSync(join(root, 'dump.tmp')); writeFileSync(join(root, 'dump.tmp', 'body'), 'new');
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.current).toBe('new');
    expect(r.archived).toBe('previous');
  });

  it('keeps the old directory when its hold lease cannot be read', () => {
    const r = holdFixture('unreadable', 'kopia_with_hold_lease papercusp kopia_install_dump_if_held "$TEST_ROOT/dump"', (root) => {
      mkdirSync(join(root, 'dump')); writeFileSync(join(root, 'dump', 'body'), 'previous');
      mkdirSync(join(root, 'dump.tmp')); writeFileSync(join(root, 'dump.tmp', 'body'), 'new');
    });
    expect(r.status).not.toBe(0);
    expect(r.current).toBe('previous');
  });
});

describe('shared Kopia cache bootstrap', () => {
  it('passes the selected CLI log directory through sudo and creates it first', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-cli-log-dir-'));
    const logDir = join(root, 'kopia-logs');
    const sudoStub = join(root, 'sudo');
    const command = join(root, 'kopia-probe');
    const capture = join(root, 'captured-log-dir');
    try {
      writeFileSync(
        sudoStub,
        '#!/usr/bin/env bash\nwhile [ "$1" = "-n" ] || [ "$1" = "--" ]; do shift; done\nexec "$@"\n',
      );
      writeFileSync(
        command,
        '#!/usr/bin/env bash\nprintf "%s\\n" "$KOPIA_LOG_DIR" >"$KOPIA_TEST_CAPTURE"\n',
      );
      chmodSync(sudoStub, 0o755);
      chmodSync(command, 0o755);

      const result = spawnSync(
        'bash',
        ['-c', 'source "$1"; KOPIA_LOG_DIR="$2"; kopia_as_root "$3" "$4"', 'kopia-cache-bootstrap-test', HELPER, logDir, sudoStub, command],
        { encoding: 'utf8', env: { ...process.env, KOPIA_TEST_CAPTURE: capture } },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(logDir)).toBe(true);
      expect(readFileSync(capture, 'utf8').trim()).toBe(logDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing target behind a dangling symlink without replacing the symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-cache-bootstrap-'));
    const link = join(root, 'home', '.cache', 'kopia');
    const target = join(root, 'relocated', 'builds', 'kopia-cache');
    try {
      mkdirSync(join(root, 'home', '.cache'), { recursive: true });
      symlinkSync(target, link);

      const result = runBootstrap(link);

      expect(result.status).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(lstatSync(target).isDirectory()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink whose target is a file and preserves both paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-cache-bootstrap-'));
    const link = join(root, 'cache');
    const target = join(root, 'not-a-directory');
    try {
      writeFileSync(target, 'sentinel');
      symlinkSync(target, link);

      const result = runBootstrap(link);

      expect(result.status).not.toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(readFileSync(target, 'utf8')).toBe('sentinel');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an ordinary file instead of replacing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-cache-bootstrap-'));
    const cache = join(root, 'cache');
    try {
      writeFileSync(cache, 'sentinel');

      const result = runBootstrap(cache);

      expect(result.status).not.toBe(0);
      expect(lstatSync(cache).isFile()).toBe(true);
      expect(readFileSync(cache, 'utf8')).toBe('sentinel');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sources the helper and bootstraps before each cache/log consumer runs', () => {
    for (const consumer of CONSUMERS) {
      const source = readFileSync(join(SYSTEMD_DIR, consumer), 'utf8');
      expect(source).toContain('source "$script_dir/kopia-cache-bootstrap.sh"');
      expect(source).toContain('ensure_kopia_cache_dir "$LOG_DIR"');
      expect(() => execFileSync('bash', ['-n', join(SYSTEMD_DIR, consumer)])).not.toThrow();
    }
    expect(existsSync(HELPER)).toBe(true);
  });

  it('routes every root-run Kopia caller through the shared log-directory wrapper', () => {
    for (const caller of ROOT_KOPIA_CALLERS) {
      const source = readFileSync(join(SYSTEMD_DIR, caller), 'utf8');
      expect(source, caller).toContain('kopia_as_root');
      expect(source, caller).not.toMatch(/sudo[^\n]*\/usr\/bin\/kopia/);
      expect(() => execFileSync('bash', ['-n', join(SYSTEMD_DIR, caller)])).not.toThrow();
    }

    for (const [service, mount] of Object.entries(MOUNTED_SERVICES)) {
      expect(readFileSync(join(SYSTEMD_DIR, service), 'utf8')).toContain(`RequiresMountsFor=${mount}`);
    }
  });
});
