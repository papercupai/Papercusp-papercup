/**
 * verify-tauri-headless-dev-env-file.test.ts — recurrence guard for WI-10007640.
 *
 * A verifier source snapshot (VERIFY_TAURI_SOURCE_REF, or the frozen working
 * tree) never contains the gitignored apps/operator/.env.local. The desktop
 * launcher used to source `./.env.local` from the snapshot's operator dir, found
 * nothing, and left DATABASE_URL unset — so the operator resolved
 * ~/.papercusp/embedded-pg.json (on the dev box: the INSTALLED Papercusp
 * Server's embedded PG, migrations behind the live DB), boot-migrate withheld
 * request startup, and the verifier's devUrl never served. Meanwhile
 * shared_schema_readiness_preflight had probed the live DB (it sources the
 * working tree's .env.local) and reported it ready.
 *
 * These tests run the launcher's REAL env-file block and its REAL source
 * fragment under bash, plus the verifier's REAL env-line block, so the probed
 * database and the launched one cannot silently diverge again.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const LAUNCHER = readFileSync(join(ROOT, 'papercusp-desktop/bin/dev-operator-ifneeded.sh'), 'utf8');
const VERIFIER = readFileSync(join(ROOT, 'scripts/verify-tauri-headless.sh'), 'utf8');

function sliceLines(src: string, startLine: string, endLine: string): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l === startLine);
  expect(start, `launcher/verifier no longer contains the line: ${startLine}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l === endLine);
  expect(end, `no closing line ${endLine} after ${startLine}`).toBeGreaterThan(start);
  return lines.slice(start, end + 1).join('\n');
}

/** The launcher block that resolves DEV_ENV_FILE / DEV_ENV_FILE_Q. */
const ENV_FILE_BLOCK = sliceLines(
  LAUNCHER,
  'DEV_ENV_FILE="./.env.local"',
  `printf -v DEV_ENV_FILE_Q '%q' "$DEV_ENV_FILE"`,
);

/** The env-file source fragment exactly as DEFAULT_DEV_CMD embeds it. */
const DEFAULT_DEV_CMD_LINE = LAUNCHER.split('\n').find((l) => l.startsWith('DEFAULT_DEV_CMD='));
const SOURCE_FRAGMENT = /set -a && (if \[ -f \$DEV_ENV_FILE_Q \]; then \. \$DEV_ENV_FILE_Q; fi) && set \+a/.exec(
  DEFAULT_DEV_CMD_LINE ?? '',
)?.[1];

let tmp: string;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Run the real block, then the real fragment the way DEFAULT_DEV_CMD runs it:
 *  expanded inside a double-quoted assignment, then re-parsed by bash. */
function launch(opts: { sourceRoot: string; operatorDir: string; envFile?: string }) {
  const script = [
    ENV_FILE_BLOCK,
    'eval "CMD=\\"$FRAG\\""',
    'cd "$DEV_OPERATOR_DIR" || exit 9',
    'set -a; eval "$CMD"; set +a',
    `printf 'DB=%s\\n' "\${DATABASE_URL:-}"`,
  ].join('\n');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    FRAG: SOURCE_FRAGMENT ?? '',
    DEV_SOURCE_ROOT: opts.sourceRoot,
    DEV_OPERATOR_DIR: opts.operatorDir,
  };
  if (opts.envFile !== undefined) env.PAPERCUSP_DEV_ENV_FILE = opts.envFile;
  const r = spawnSync('bash', ['-c', `DEV_SOURCE_ROOT="$DEV_SOURCE_ROOT"; DEV_OPERATOR_DIR="$DEV_OPERATOR_DIR"\n${script}`], {
    env,
    encoding: 'utf8',
  });
  return { status: r.status, db: /DB=(.*)/.exec(r.stdout)?.[1] ?? null, stderr: r.stderr, stdout: r.stdout };
}

function layout() {
  tmp = mkdtempSync(join(tmpdir(), 'wi-10007640-'));
  // A space in the canonical path exercises the %q quoting end to end.
  const canonicalOperator = join(tmp, 'canonical tree', 'apps', 'operator');
  const snapshotOperator = join(tmp, 'snapshot', 'apps', 'operator');
  mkdirSync(canonicalOperator, { recursive: true });
  mkdirSync(snapshotOperator, { recursive: true });
  const canonicalEnv = join(canonicalOperator, '.env.local');
  writeFileSync(canonicalEnv, 'DATABASE_URL=postgresql://live-canonical:5432/papercusp\n');
  return { canonicalOperator, canonicalEnv, snapshotRoot: join(tmp, 'snapshot'), snapshotOperator };
}

describe('WI-10007640 — a verifier snapshot launches against the same DB the preflight probed', () => {
  it('found the real source fragment inside DEFAULT_DEV_CMD', () => {
    expect(DEFAULT_DEV_CMD_LINE).toBeTruthy();
    expect(SOURCE_FRAGMENT).toBeTruthy();
  });

  it('sources PAPERCUSP_DEV_ENV_FILE when the snapshot has no .env.local', () => {
    const l = layout();
    const r = launch({ sourceRoot: l.snapshotRoot, operatorDir: l.snapshotOperator, envFile: l.canonicalEnv });
    expect(r.status, r.stderr).toBe(0);
    expect(r.db).toBe('postgresql://live-canonical:5432/papercusp');
  });

  it('keeps the ordinary launch contract: ./.env.local from the operator dir', () => {
    const l = layout();
    const r = launch({ sourceRoot: '', operatorDir: l.canonicalOperator });
    expect(r.status, r.stderr).toBe(0);
    expect(r.db).toBe('postgresql://live-canonical:5432/papercusp');
  });

  it('warns loudly, naming the discovery fallback, when a snapshot has no env file at all', () => {
    const l = layout();
    const r = launch({ sourceRoot: l.snapshotRoot, operatorDir: l.snapshotOperator });
    expect(r.status, r.stderr).toBe(0);
    expect(r.db).toBe('');
    expect(r.stderr).toContain('embedded-pg.json discovery fallback');
    expect(r.stderr).toContain('WI-10007640');
  });

  it('refuses a relative or unreadable PAPERCUSP_DEV_ENV_FILE instead of silently falling back', () => {
    const l = layout();
    const rel = launch({ sourceRoot: l.snapshotRoot, operatorDir: l.snapshotOperator, envFile: '.env.local' });
    expect(rel.status).toBe(1);
    expect(rel.stderr).toContain('must be an absolute path');
    const missing = launch({
      sourceRoot: l.snapshotRoot,
      operatorDir: l.snapshotOperator,
      envFile: join(tmp, 'nope', '.env.local'),
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('not a readable file');
  });

  it('leaves no launcher site sourcing a hard-coded ./.env.local', () => {
    expect(LAUNCHER).not.toMatch(/\.\s+\.\/\.env\.local/);
    // The PG probe also checks that DEV_ENV_FILE is nonempty before sourcing it.
    const sites = LAUNCHER.split('\n').filter((l) => /set -a && if .*DEV_ENV_FILE/.test(l));
    expect(sites.length).toBe(3);
  });
});

describe('live verifier authenticated runtime precondition', () => {
  it.each([0, 1])('retains server/caller paths without credentials when the authenticated read exits %s', async (exitCode) => {
    tmp = mkdtempSync(join(tmpdir(), 'verifier-runtime-auth-'));
    const scripts = join(tmp, 'scripts'); mkdirSync(scripts);
    const serverHome = join(tmp, 'server'); mkdirSync(serverHome);
    const callerHome = join(tmp, 'caller'); mkdirSync(callerHome);
    const NEVER_EMIT_MARKER = 'never-emit-me';
    writeFileSync(join(serverHome, 'superuser-token'), NEVER_EMIT_MARKER);
    writeFileSync(join(callerHome, 'superuser-token'), NEVER_EMIT_MARKER);
    // Execute the captured helper bytes, as the other verifier fixtures do;
    // the managed child loader substitutes HEAD for a dirty repository entry.
    const helper = join(tmp, 'verify-tauri-assertion-env.mjs');
    writeFileSync(helper, readFileSync(join(ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs')));
    writeFileSync(join(scripts, 'mcp-call.mjs'), `
      export const superuserTokenPaths = () => [process.env.PAPERCUSP_HOME + '/superuser-token'];
      export const resolveMcpWorkspace = () => process.env.PAPERCUSP_WORKSPACE;
      if (process.argv[2] === 'coord:whoami') {
        if (${exitCode}) { console.error('superuser_invalid_bearer'); process.exit(1); }
        console.log(JSON.stringify({ownerId:process.env.PAPERCUSP_SID,workspaceId:process.env.PAPERCUSP_WORKSPACE}));
      }
    `);
    const server = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      env: { ...process.env, PAPERCUSP_HOME: serverHome, OPERATOR_DEV_PORT: '45911' }, stdio: 'ignore',
    });
    await new Promise<void>((resolve, reject) => { server.once('spawn', resolve); server.once('error', reject); });
    try {
      const evidence = join(tmp, 'auth.json');
      const result = spawnSync(process.execPath, [helper,
        '--runtime-mcp', String(server.pid), '45911', evidence], { encoding: 'utf8',
        env: { ...process.env, PAPERCUSP_REPO_DIR: tmp, PAPERCUSP_HOME: callerHome,
          PAPERCUSP_SID: 'test-runtime-auth', PAPERCUSP_WORKSPACE: 'test-auth-workspace' } });
      expect(result.status, result.stderr).toBe(exitCode ? 2 : 0);
      const raw = readFileSync(evidence, 'utf8');
      const report = JSON.parse(raw);
      expect(report).toMatchObject({ ok: !exitCode, server: { path: join(serverHome, 'superuser-token'), present: true },
        caller: [{ path: join(callerHome, 'superuser-token'), present: true }],
        call: { exitStatus: exitCode, invalidBearer: !!exitCode } });
      expect(raw + result.stdout + result.stderr).not.toContain(NEVER_EMIT_MARKER);
    } finally { server.kill(); await new Promise<void>(resolve => server.once('exit', () => resolve())); }
  });

  it('checks authentication after isolated assertion exports and before running assertions', () => {
    const auth = VERIFIER.indexOf(' --runtime-mcp');
    expect(auth).toBeGreaterThan(VERIFIER.indexOf('export PAPERCUSP_HOME="$ISOLATED_HOME"'));
    expect(auth).toBeLessThan(VERIFIER.indexOf('preflight_verifier_task_deadline assert || exit $?'));
  });
});

describe('WI-10007640 — the verifier hands the launcher the preflight env file', () => {
  const BLOCK = sliceLines(
    VERIFIER,
    'if [ "${ISOLATED_DB:-0}" != "1" ] && [ -n "$OPERATOR_SOURCE_ROOT" ] && [ -f "$REPO_DIR/apps/operator/.env.local" ]; then',
    'fi',
  );

  function envLine(opts: { isolated: string; sourceRoot: string; repoDir: string }) {
    const r = spawnSync('bash', ['-c', `OPERATOR_SOURCE_ENV_LINE=BASE\n${BLOCK}\nprintf '%s\\n' "$OPERATOR_SOURCE_ENV_LINE"`], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        ISOLATED_DB: opts.isolated,
        OPERATOR_SOURCE_ROOT: opts.sourceRoot,
        REPO_DIR: opts.repoDir,
      },
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  }

  it('adds PAPERCUSP_DEV_ENV_FILE for a shared-DB snapshot run', () => {
    const l = layout();
    const repoDir = join(tmp, 'canonical tree');
    expect(envLine({ isolated: '0', sourceRoot: l.snapshotRoot, repoDir })).toBe(
      `BASE PAPERCUSP_DEV_ENV_FILE="${l.canonicalEnv}"`,
    );
  });

  it('adds nothing for an isolated run or a non-snapshot run', () => {
    const l = layout();
    const repoDir = join(tmp, 'canonical tree');
    expect(envLine({ isolated: '1', sourceRoot: l.snapshotRoot, repoDir })).toBe('BASE');
    expect(envLine({ isolated: '0', sourceRoot: '', repoDir })).toBe('BASE');
  });

  it('names the same file shared_schema_readiness_preflight probes', () => {
    const preflight = sliceLines(VERIFIER, 'shared_schema_readiness_preflight() {', '}');
    expect(preflight).toContain('cd "$REPO_DIR/apps/operator"');
    expect(preflight).toMatch(/if \[ -f \.env\.local \]; then \. \.\/\.env\.local/);
    expect(BLOCK).toContain('PAPERCUSP_DEV_ENV_FILE=\\"$REPO_DIR/apps/operator/.env.local\\"');
  });

  function sharedAssertionPreflight(probeExit = 0) {
    tmp = mkdtempSync(join(tmpdir(), 'verifier-shared-assertion-env-'));
    const operator = join(tmp, 'apps/operator');
    const desktop = join(tmp, 'desktop');
    const work = join(tmp, 'private-run');
    mkdirSync(operator, { recursive: true });
    mkdirSync(join(desktop, 'bin'), { recursive: true });
    mkdirSync(work);
    const url = 'postgresql://fixture:private-password@localhost:5432/fixture';
    writeFileSync(join(operator, '.env.local'), `DATABASE_URL='${url}'\n`);
    writeFileSync(join(desktop, 'bin/dev-operator-pg-probe.mjs'), `
      export function resolveDevPgUrl() { return { url: process.env.DATABASE_URL }; }
      if (process.argv.includes('--require-applied-schema')) {
        console.log('schema-ready');
        process.exit(${probeExit});
      }
    `);
    const preflight = sliceLines(VERIFIER, 'shared_schema_readiness_preflight() {', '}');
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      // This preflight runs before the verifier allocates its bulk WORK dir.
      'unset WORK DATABASE_URL HARNESS_ADMIN_DATABASE_URL; VERIFY_TAURI_ISOLATED_DB=0',
      preflight,
      'shared_schema_readiness_preflight',
      'test "$HARNESS_ADMIN_DATABASE_URL" = "$EXPECTED_URL"',
      'node -e "if (process.env.HARNESS_ADMIN_DATABASE_URL !== process.env.EXPECTED_URL) process.exit(1)"',
    ].join('\n')], { encoding: 'utf8', env: { ...process.env,
      REPO_DIR: tmp, DESKTOP_DIR: desktop, TMPDIR: work, EXPECTED_URL: url,
    } });
    return { result, work };
  }

  it('passes the probed shared connection before WORK exists without exposing credentials', () => {
    const { result, work } = sharedAssertionPreflight();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('schema-ready\n');
    expect(result.stdout + result.stderr).not.toContain('private-password');
    expect(readdirSync(work)).toEqual([]);
  });

  it('leaves no private assertion context when the shared schema probe fails', () => {
    const { result, work } = sharedAssertionPreflight(79);
    expect(result.status, result.stderr).toBe(79);
    expect(result.stderr).toContain('VERIFY_TAURI_SHARED_SCHEMA_NOT_READY probe_exit=79');
    expect(result.stdout + result.stderr).not.toContain('private-password');
    expect(readdirSync(work)).toEqual([]);
  });
});
