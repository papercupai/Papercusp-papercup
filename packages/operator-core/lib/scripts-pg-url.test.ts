/**
 * scripts/lib/pg-url.mjs — the ONE Postgres-URL resolver for `scripts/*` CLIs, plus the
 * guard that keeps it the only one.
 *
 * ## The defect this exists to prevent (EI-20081449067583201)
 *
 * Four scripts had each hand-rolled the same resolution chain, and every copy was BROKEN
 * from a fresh shell: they called the GENERIC `@papercusp/embedded-pg-discovery` resolver
 * with NO ARGUMENT. That function takes a required config and returns `{ url, source }`,
 * so it threw `Cannot read properties of undefined (reading 'envVars')` — inside the
 * callee, where the call site's `?.` guards (which only defend against a MISSING export)
 * could not see it. Each script then died with `No database URL. Set
 * HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL)`, naming a variable this repo does not set,
 * while the correctly-configured `getHarnessAdminUrl()` sat one import away and could not
 * have failed at all (its last resort is a fallback URL, not an error).
 *
 * Six MORE scripts carried a second copy — a local `resolvePgUrl()` that read
 * `~/.papercusp/embedded-pg.json` with NO pid/port liveness gate. That is the WI-6733 /
 * WI-7180 stale-discovery-file class, already fixed once in the generic lib and recorded
 * as recurring four times (EI-19295674294851629): a dead writer's file wins forever and
 * every consumer ECONNREFUSEs a port nothing serves. The copies never got the fix, which
 * is the whole argument against copies.
 *
 * So the guard below is not tidiness. Each copy is a place where an already-fixed bug
 * comes back.
 */
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Both are typed by generated sibling .d.mts files (tsconfig.declarations.json).
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  applyEnvLocal,
  describePgUrlResolution,
  OPERATOR_ENV_ROOT,
  parseEnvFile,
  resolveScriptPgUrl,
  PG_ISOLATION_ENV_VARS,
  PG_URL_ENV_VARS,
} from '../../../scripts/lib/pg-url.mjs';
import { formatExportLines, parseArgs, shellSingleQuote } from '../../../scripts/pg-url.mjs';
import { _resetHarnessAdminUrlCacheForTests } from './embedded-pg-discovery';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const HELPER = 'lib/pg-url.mjs';

describe('parseEnvFile', () => {
  it('reads the shapes `set -a; . ./.env.local` reads', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'DATABASE_URL=postgresql://u:p@127.0.0.1:5432/papercusp',
        'export PAPERCUSP_PG_URL="postgresql://q@h:1/d"',
        "QUOTED='single'",
        'not a var line',
      ].join('\n'),
    );
    expect(parsed.get('DATABASE_URL')).toBe('postgresql://u:p@127.0.0.1:5432/papercusp');
    expect(parsed.get('PAPERCUSP_PG_URL')).toBe('postgresql://q@h:1/d');
    expect(parsed.get('QUOTED')).toBe('single');
    expect(parsed.has('not a var line')).toBe(false);
  });

  it('keeps `=` inside a value (a DSN password may contain one)', () => {
    expect(parseEnvFile('DATABASE_URL=postgres://u:a=b@h/d').get('DATABASE_URL')).toBe(
      'postgres://u:a=b@h/d',
    );
  });

  it('does NOT expand $VAR — a value needing a shell belongs in the real environment', () => {
    expect(parseEnvFile('DATABASE_URL=$OTHER').get('DATABASE_URL')).toBe('$OTHER');
  });
});

describe('applyEnvLocal', () => {
  const withEnvLocal = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'pg-url-test-'));
    writeFileSync(join(dir, '.env.local'), body);
    return dir;
  };

  it('supplies a DB url the real environment lacks', () => {
    const env: Record<string, string | undefined> = {};
    const root = withEnvLocal('DATABASE_URL=postgres://from-file/db\n');
    const r = applyEnvLocal({ root, env });
    expect(r.applied).toEqual(['DATABASE_URL']);
    expect(env.DATABASE_URL).toBe('postgres://from-file/db');
  });

  it('never overwrites a value the caller set explicitly', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: 'postgres://explicit/db' };
    const root = withEnvLocal('DATABASE_URL=postgres://from-file/db\n');
    const r = applyEnvLocal({ root, env });
    expect(r.applied).toEqual([]);
    expect(r.present).toEqual(['DATABASE_URL']);
    expect(env.DATABASE_URL).toBe('postgres://explicit/db');
  });

  it('applies ONLY the DB-url names — a script env is not the operator env', () => {
    const env: Record<string, string | undefined> = {};
    const root = withEnvLocal('DATABASE_URL=postgres://from-file/db\nANTHROPIC_API_KEY=sk-secret\n');
    applyEnvLocal({ root, env });
    expect(Object.keys(env)).toEqual(['DATABASE_URL']);
  });

  /**
   * THE ISOLATION RAIL. `scripts/with-test-pg.mjs` runs its child with PAPERCUSP_PG_PORT +
   * PAPERCUSP_SKIP_PG_DISCOVERY and deliberately NO url env var, so the code under test
   * resolves to the throwaway PG. Reading `.env.local` there would hand a test suite the
   * LIVE DEV DSN and let it write to the real database.
   */
  for (const lever of PG_ISOLATION_ENV_VARS as string[]) {
    it(`refuses to read .env.local when ${lever} says this process owns a dedicated PG`, () => {
      const env: Record<string, string | undefined> = { [lever]: '19532' };
      const root = withEnvLocal('DATABASE_URL=postgres://live-dev-database/papercusp\n');
      const r = applyEnvLocal({ root, env });
      expect(r.skipped).toBe(lever);
      expect(r.applied).toEqual([]);
      expect(env.DATABASE_URL).toBeUndefined();
    });
  }

  it('is a no-op, not a throw, when there is no .env.local', () => {
    const env: Record<string, string | undefined> = {};
    const r = applyEnvLocal({ root: mkdtempSync(join(tmpdir(), 'pg-url-empty-')), env });
    expect(r.exists).toBe(false);
    expect(r.applied).toEqual([]);
  });
});

describe('resolveScriptPgUrl', () => {
  it('uses the supplied operator environment root rather than the ambient desktop database', () => {
    // EI-25408245982858894: maintenance must name the managed operator's root.
    // The repository-root file may have no pin while a desktop discovery file
    // points at a different, healthy cluster. Resolve through the real chain.
    const root = mkdtempSync(join(tmpdir(), 'pg-url-operator-root-'));
    const operatorUrl = 'postgresql://operator:fixture@127.0.0.1:22223/operator-store';
    writeFileSync(join(root, '.env.local'), `DATABASE_URL=${operatorUrl}\n`);
    for (const name of [...PG_URL_ENV_VARS, ...PG_ISOLATION_ENV_VARS]) vi.stubEnv(name, undefined);
    _resetHarnessAdminUrlCacheForTests();
    try {
      const resolved = resolveScriptPgUrl({ root });
      expect(resolved.url).toBe(operatorUrl);
      expect(resolved.source).toBe('env');
      expect(resolved.via).toBe('DATABASE_URL');
      expect(resolved.envLocal.applied).toEqual(['DATABASE_URL']);
    } finally {
      vi.unstubAllEnvs();
      _resetHarnessAdminUrlCacheForTests();
    }
  });

  it('DEFAULTS to the operator env file, so a caller cannot reach the sidecar PG by omission', () => {
    // EI-25622462074429450 / EI-25621586767076562: the default root used to be the repo
    // root, whose .env.local no operator unit sources (every unit runs from apps/operator).
    // Under a shell without a DB url (capability:bash strips it) every root-less caller —
    // lint:migrations among them — fell through to the discovery file and judged a desktop
    // sidecar PG: 21 reserved migrations reported unreserved.
    const operatorEnvFile = join(REPO_ROOT, 'apps', 'operator', '.env.local');
    expect(OPERATOR_ENV_ROOT).toBe(join(REPO_ROOT, 'apps', 'operator'));
    expect(applyEnvLocal({ env: {} }).file).toBe(operatorEnvFile);
    for (const name of [...PG_URL_ENV_VARS, ...PG_ISOLATION_ENV_VARS]) vi.stubEnv(name, undefined);
    _resetHarnessAdminUrlCacheForTests();
    try {
      expect(resolveScriptPgUrl({ env: {} }).envLocal.file).toBe(operatorEnvFile);
    } finally {
      vi.unstubAllEnvs();
      _resetHarnessAdminUrlCacheForTests();
    }
  });

  it('resolves PAPERCUSP_PG_PORT to that port instead of falling through to 5432', () => {
    // The divergence from getHarnessAdminUrl() documented on the helper: its native
    // fallback hardcodes 5432, so falling through would send an isolated run at the
    // ambient dev database. connection.ts's adminUrl() builds this identical DSN.
    const r = resolveScriptPgUrl({
      root: mkdtempSync(join(tmpdir(), 'pg-url-iso-')),
      env: { PAPERCUSP_PG_PORT: '19532' },
    });
    expect(r.source).toBe('isolated-pg-port');
    expect(r.url).toBe('postgresql://harness_admin:harness_admin_pwd@localhost:19532/papercusp');
  });

  it('lets an explicit admin DSN outrank the isolated port', () => {
    const r = resolveScriptPgUrl({
      root: mkdtempSync(join(tmpdir(), 'pg-url-iso2-')),
      env: { HARNESS_ADMIN_DATABASE_URL: 'postgres://explicit/db', PAPERCUSP_PG_PORT: '19532' },
    });
    expect(r.url).toBe('postgres://explicit/db');
    expect(r.source).toBe('env');
    expect(r.via).toBe('HARNESS_ADMIN_DATABASE_URL');
  });

  it('resolves a copied environment operator pin without reading or changing the ambient pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'pg-url-copied-env-'));
    const operatorUrl = 'postgresql://operator:fixture@127.0.0.1:22223/copied-operator-store';
    const ambientUrl = 'postgresql://ambient:fixture@127.0.0.1:22224/ambient-store';
    writeFileSync(join(root, '.env.local'), `DATABASE_URL=${operatorUrl}\n`);
    for (const name of [...PG_URL_ENV_VARS, ...PG_ISOLATION_ENV_VARS]) vi.stubEnv(name, undefined);
    vi.stubEnv('DATABASE_URL', ambientUrl);
    _resetHarnessAdminUrlCacheForTests();
    const env: Record<string, string | undefined> = {};
    try {
      const resolved = resolveScriptPgUrl({ root, env });
      expect(resolved.url).toBe(operatorUrl);
      expect(resolved.source).toBe('env');
      expect(resolved.via).toBe('DATABASE_URL');
      expect(env.DATABASE_URL).toBe(operatorUrl);
      expect(process.env.DATABASE_URL).toBe(ambientUrl);
    } finally {
      vi.unstubAllEnvs();
      _resetHarnessAdminUrlCacheForTests();
    }
  });
});

describe.each([
  ['GOAL', 'tauri-surface-verify-goal-report.mts', 'const out ='],
  ['reporter', 'tauri-surface-verify-reporter-status.mts', 'assert.ok(process.env.VERIFY_TAURI_PID)'],
])('isolated %s Tauri driver database prerequisite', (_name, file, endMarker) => {
  const driver = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
  // Execute the real caller's prerequisite before any database or native writes.
  const guard = driver.slice(driver.indexOf('const isolatedPg ='), driver.indexOf(endMarker));
  const check = (root: string) => runInNewContext(guard, {
    pid: 'isolated-test-pid', origin: 'http://isolated-test.invalid', workspaceId: 'isolated-test', assert,
    resolveScriptPgUrl: () => resolveScriptPgUrl({ root, env: process.env }),
  });

  it.each([
    { label: 'explicit admin DSN', admin: 'postgres://explicit.invalid/fixture', port: undefined, file: '', allowed: true },
    { label: 'port alone', admin: undefined, port: '19532', file: '', allowed: false },
    { label: '.env.local admin DSN', admin: undefined, port: undefined,
      file: 'HARNESS_ADMIN_DATABASE_URL=postgres://ambient.invalid/fixture\n', allowed: false },
  ])('accepts only the $label when explicitly supplied', ({ admin, port, file, allowed }) => {
    const root = mkdtempSync(join(tmpdir(), 'pg-url-goal-driver-'));
    if (file) writeFileSync(join(root, '.env.local'), file);
    for (const name of [...PG_URL_ENV_VARS, ...PG_ISOLATION_ENV_VARS]) vi.stubEnv(name, undefined);
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', admin);
    vi.stubEnv('PAPERCUSP_PG_PORT', port);
    try {
      expect(guard).toContain('resolveScriptPgUrl()');
      if (allowed) expect(() => check(root)).not.toThrow();
      else expect(() => check(root)).toThrow('Requires an explicitly supplied isolated admin database URL');
    } finally {
      vi.unstubAllEnvs();
      _resetHarnessAdminUrlCacheForTests();
    }
  });
});

describe('describePgUrlResolution', () => {
  const resolution = {
    url: 'postgresql://harness_admin:hunter2@127.0.0.1:5432/papercusp',
    source: 'env',
    envLocal: { exists: true, applied: ['DATABASE_URL'], skipped: null },
  };

  it('names the source and the host, so ECONNREFUSED is actionable', () => {
    const line = describePgUrlResolution(resolution);
    expect(line).toContain('source=env');
    expect(line).toContain('127.0.0.1:5432/papercusp');
    expect(line).toContain('DATABASE_URL');
  });

  it('names WHICH env var won — "source=env" alone cannot separate explicit from .env.local', () => {
    expect(describePgUrlResolution({ ...resolution, via: 'HARNESS_ADMIN_DATABASE_URL' })).toContain(
      'source=env:HARNESS_ADMIN_DATABASE_URL',
    );
  });

  it('NEVER prints the credentials — this string lands in error output and logs', () => {
    expect(describePgUrlResolution(resolution)).not.toContain('hunter2');
  });

  it('says so out loud when the isolation rail suppressed .env.local', () => {
    expect(
      describePgUrlResolution({
        ...resolution,
        envLocal: { exists: true, applied: [], skipped: 'PAPERCUSP_PG_PORT' },
      }),
    ).toContain('PAPERCUSP_PG_PORT');
  });
});

// ---------------------------------------------------------------------------
// The guard: no script may hand-roll DB-url resolution again
// ---------------------------------------------------------------------------

/** Every .mjs/.mts/.ts under scripts/, repo-relative to SCRIPTS_DIR. */
function scriptFiles(dir = SCRIPTS_DIR, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) out.push(...scriptFiles(abs, rel));
    else if (/\.(mjs|mts|ts)$/.test(entry)) out.push(rel);
  }
  return out.sort();
}

/**
 * Comments are STRIPPED but string literals are KEPT, deliberately: the package specifier
 * `'@papercusp/embedded-pg-discovery'` IS a string literal, so `stripCommentsAndStrings`
 * would blind this guard to the exact call that caused the bug. Comments must go, because
 * this file's own prose (and each converted script's) quotes the pattern it detects.
 */
function maskedSourceOf(rel: string): string {
  return stripCommentsOnly(readFileSync(join(SCRIPTS_DIR, rel), 'utf8'), rel) as string;
}

const HAND_ROLLED: Array<{ id: string; re: RegExp }> = [
  // The admin-DSN env chain. DATABASE_URL alone is deliberately NOT a trigger: it has
  // legitimate non-resolution uses (passing a child's env through), and every copy of the
  // broken block reached for HARNESS_ADMIN_DATABASE_URL first anyway.
  { id: 'env-chain', re: /process\.env\.(HARNESS_ADMIN_DATABASE_URL|PAPERCUSP_PG_URL)/ },
  // The GENERIC resolver: it requires a config and returns an object, so a script reaching
  // for it directly is re-doing the configuration operator-core already did.
  { id: 'generic-resolver', re: /@papercusp\/embedded-pg-discovery/ },
  // A private re-implementation — this is the one that keeps missing the liveness gates.
  { id: 'local-resolver', re: /function resolvePgUrl/ },
];

/** Which hand-rolled forms a (comment-masked) source contains. */
function classify(masked: string): string[] {
  return HAND_ROLLED.filter(({ re }) => re.test(masked)).map(({ id }) => id);
}

// This probe is copied ALONE to the packaged VM; the repository's configured
// resolver is unavailable there. Its database is selected by the caller's
// measured local port, never ambient discovery. Keep this boundary executable:
// a future fallback/discovery/write change re-enrolls the file in the guard.
const PORTABLE_PG_READER = 'agent-capacity/vm/read-routine-metadata.mjs';
function isPortableExplicitPgReader(rel: string, masked: string): boolean {
  if (rel !== PORTABLE_PG_READER) return false;
  const precondition = masked.indexOf('if (!/^[0-9]+$/.test(port ?? \'\') || !slug)');
  const client = masked.indexOf('new Client({ connectionString: url })');
  return precondition >= 0 && client > precondition &&
    masked.includes("process.env.PAPERCUSP_PG_URL ?? `postgres://harness_admin:${'harness_admin_pwd'}@127.0.0.1:${port}/papercusp`") &&
    masked.includes("'SELECT metadata -> $3 AS v FROM harness_shared.routines WHERE install_slug = $1 AND name = $2'") &&
    !/HARNESS_ADMIN_DATABASE_URL|DATABASE_URL|embedded-pg\.json|embedded-pg-discovery|\b(?:INSERT|UPDATE|DELETE)\b/.test(masked) &&
    !/from ['"]\.\.?\//.test(masked);
}

// `with-test-pg.mjs` is the isolation supervisor, not a script consumer. It
// deliberately creates a private Postgres, validates its loopback URL, and
// injects that URL/port into child processes. Those explicit pins are the
// isolation boundary; routing this supervisor through the shared resolver would
// make the test runner select the operator's database instead of its throwaway
// server. Keep the exemption executable so a future rewrite cannot quietly turn
// the supervisor into an ambient-URL consumer.
const TEST_PG_SUPERVISOR = 'with-test-pg.mjs';
function isTestPgSupervisor(rel: string, masked: string): boolean {
  if (rel !== TEST_PG_SUPERVISOR) return false;
  const compact = masked.replace(/\s+/g, ' ');
  const importsPrivatePg = /const \{\s*startEmbeddedPostgresServer\s*\}\s*=\s*await import\(\s*['"]\.\.\/libs\/papercusp\/packages\/embedded-postgres-server\/src\/index\.js['"]\s*\)/.test(compact);
  const startsPrivatePg = /pg\s*=\s*await startEmbeddedPostgresServer\(\s*\{\s*dataDir,\s*port,\s*dbSqlDir:\s*sqlDir/.test(compact);
  const adminUrlAt = compact.indexOf('const testAdminUrl = new URL(pg.urls.admin);');
  const childLaunchAt = compact.indexOf('child = spawn(cmd[0], childArgs');
  if (!importsPrivatePg || !startsPrivatePg || adminUrlAt < 0 || childLaunchAt < adminUrlAt) return false;

  const adminPreflight = compact.slice(adminUrlAt, childLaunchAt);
  const validatesPrivateAdminUrl =
    adminPreflight.includes("!['postgres:', 'postgresql:'].includes(testAdminUrl.protocol)") &&
    adminPreflight.includes("!['localhost', '127.0.0.1', '[::1]'].includes(testAdminUrl.hostname)") &&
    adminPreflight.includes('testAdminUrl.port !== String(port)') &&
    adminPreflight.includes('!testAdminUrl.username') &&
    adminPreflight.includes('!testAdminUrl.pathname.slice(1)');
  if (!validatesPrivateAdminUrl) return false;

  const childLaunch = compact.slice(childLaunchAt);
  const envAt = childLaunch.indexOf('env: {');
  const envEndAt = childLaunch.indexOf('}, detached: isolatedRuntime', envAt);
  if (envAt < 0 || envEndAt < 0) return false;
  const childEnv = childLaunch.slice(envAt, envEndAt);
  return childEnv.includes('PAPERCUSP_PG_PORT: String(port)') &&
    childEnv.includes("PAPERCUSP_SKIP_PG_DISCOVERY: '1'") &&
    childEnv.includes('PAPERCUSP_TEST_PG_ADMIN_URL: testAdminUrl.toString()');
}

function handRolledFiles(): string[] {
  return scriptFiles().filter((rel) => {
    if (rel === HELPER) return false;
    const masked = maskedSourceOf(rel);
    return classify(masked).length > 0 &&
      !isPortableExplicitPgReader(rel, masked) &&
      !isTestPgSupervisor(rel, masked);
  });
}

/**
 * A guard that has never failed is a guard nobody has tested — and the safe way to prove
 * THIS one fires is on synthetic sources, never by mutating a tracked file (git-sync
 * sweeps the whole tree every few minutes and would commit the mutant).
 */
describe('the guard is falsifiable', () => {
  const cases: Array<[string, string, string[]]> = [
    [
      'the exact block that shipped broken',
      `const url = process.env.HARNESS_ADMIN_DATABASE_URL || process.env.DATABASE_URL ||
        (() => { const d = require('@papercusp/embedded-pg-discovery'); return d.resolvePgUrl?.(); })();`,
      ['env-chain', 'generic-resolver'],
    ],
    [
      'a private re-implementation with no liveness gate',
      "function resolvePgUrl() { return 'postgresql://harness_admin@localhost:5432/papercusp'; }",
      ['local-resolver'],
    ],
    [
      'the compliant form',
      "import { connectScriptPg } from './lib/pg-url.mjs';\nconst client = await connectScriptPg();",
      [],
    ],
  ];

  for (const [name, source, expected] of cases) {
    it(`detects: ${name}`, () => {
      expect(classify(stripCommentsOnly(source, 'synthetic.mjs') as string)).toEqual(expected);
    });
  }

  it('does not fire on a COMMENT that quotes the pattern (every converted script has one)', () => {
    const source = [
      '/** Was: process.env.HARNESS_ADMIN_DATABASE_URL + @papercusp/embedded-pg-discovery. */',
      "// function resolvePgUrl() — deleted, see scripts/lib/pg-url.mjs",
      "import { resolveScriptPgUrl } from './lib/pg-url.mjs';",
    ].join('\n');
    expect(classify(stripCommentsOnly(source, 'synthetic.mjs') as string)).toEqual([]);
  });

  it('accepts only the maintained standalone explicit-port read-only contract', () => {
    const masked = maskedSourceOf(PORTABLE_PG_READER);
    expect(isPortableExplicitPgReader(PORTABLE_PG_READER, masked)).toBe(true);
    expect(isPortableExplicitPgReader('another-reader.mjs', masked)).toBe(false);
    for (const mutated of [
      masked.replace('if (!/^[0-9]+$/.test(port ?? \'\') || !slug)', 'if (false)'),
      masked + '\nconst fallback = process.env.DATABASE_URL;',
      masked + '\nreadFileSync("embedded-pg.json");',
      masked.replace('SELECT metadata', 'DELETE metadata'),
      masked + '\nimport x from "../lib/pg-url.mjs";',
    ]) expect(isPortableExplicitPgReader(PORTABLE_PG_READER, mutated)).toBe(false);
  });

  it('accepts only the maintained throwaway-PG isolation supervisor contract', () => {
    const masked = maskedSourceOf(TEST_PG_SUPERVISOR);
    expect(isTestPgSupervisor(TEST_PG_SUPERVISOR, masked)).toBe(true);
    expect(isTestPgSupervisor('another-script.mjs', masked)).toBe(false);
    for (const mutated of [
      masked.replace('await startEmbeddedPostgresServer({', 'await startExternalPostgresServer({'),
      masked.replace('const { startEmbeddedPostgresServer } = await import(', 'const { startExternalPostgresServer } = await import('),
      masked.split("PAPERCUSP_SKIP_PG_DISCOVERY: '1'").join("PAPERCUSP_SKIP_PG_DISCOVERY: '0'"),
      masked.replace("!['localhost', '127.0.0.1', '[::1]'].includes(testAdminUrl.hostname)", 'true'),
      masked.split('PAPERCUSP_PG_PORT: String(port)').join('PAPERCUSP_PG_PORT: String(port + 1)'),
      masked.replace('const testAdminUrl = new URL(pg.urls.admin)', 'const testAdminUrl = new URL(process.env.DATABASE_URL)'),
      masked.replace('PAPERCUSP_TEST_PG_ADMIN_URL: testAdminUrl.toString()', 'PAPERCUSP_TEST_PG_ADMIN_URL: process.env.DATABASE_URL'),
    ]) expect(isTestPgSupervisor(TEST_PG_SUPERVISOR, mutated)).toBe(false);
  });
});

describe('DB-url resolution in scripts/ is SHRINK-ONLY (baseline: empty)', () => {
  /**
   * BASELINE IS EMPTY AND MUST STAY EMPTY. All ten pre-existing copies were converted when
   * this guard landed (2026-08-10), so any file this reports is genuinely new. Fix it by
   * importing from `scripts/lib/pg-url.mjs` — `connectScriptPg()` for a `pg` Client,
   * `resolveScriptPgUrl().url` for a postgres.js / other connection string.
   */
  const BASELINE = new Set<string>([]);

  it('no script hand-rolls its own Postgres-URL resolution', () => {
    const offenders = handRolledFiles().filter((f) => !BASELINE.has(f));
    expect(
      offenders,
      'These scripts resolve a Postgres URL themselves instead of importing ' +
        'scripts/lib/pg-url.mjs. Every previous copy was broken from a fresh shell, or ' +
        'silently carried the stale-discovery-file bug the shared path already fixes ' +
        '(EI-20081449067583201, WI-6733).',
    ).toEqual([]);
  });

  it('the baseline stays honest (no entries for already-converted files)', () => {
    const measured = handRolledFiles();
    expect([...BASELINE].filter((f) => !measured.includes(f))).toEqual([]);
  });

  /**
   * The guard above can be satisfied by DELETING every consumer, so assert the positive
   * too: the shared helper is really the path scripts take. A drop here means a conversion
   * was reverted rather than that the class was fixed.
   */
  it('the converted scripts still import the shared helper', () => {
    const importers = scriptFiles().filter(
      (rel) => rel !== HELPER && /lib\/pg-url\.mjs/.test(maskedSourceOf(rel)),
    );
    expect(importers.length).toBeGreaterThanOrEqual(10);
  });

  it('the helper exports the env-var order operator-core actually checks', () => {
    // A drifted order here would resolve a different database than the operator does.
    expect(PG_URL_ENV_VARS).toEqual([
      'HARNESS_ADMIN_DATABASE_URL',
      'DATABASE_URL',
      'PAPERCUSP_PG_URL',
    ]);
    const wrapper = readFileSync(
      join(REPO_ROOT, 'packages/operator-core/lib/embedded-pg-discovery.ts'),
      'utf8',
    );
    for (const name of PG_URL_ENV_VARS as string[]) expect(wrapper).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// scripts/pg-url.mjs — the SHELL-facing door onto the same resolver
// ---------------------------------------------------------------------------

/**
 * ## What EI-20478658560683440 actually was
 *
 * Not a resolver bug. The gated chain was already correct: presented with a 15-day-stale
 * discovery file (dead pid 1471022, nothing listening on port 19838) it rejected the file
 * and resolved to the native :5432 that was serving. Every JS caller was fine.
 *
 * The defect was that the chain was reachable only from JS. An agent needing to MUTATE the
 * database — which `dev:pg_query` cannot do, it runs read-only — had to use psql, and the
 * only thing a shell could read was the discovery file itself. So it read the raw `url`
 * field, which is precisely the "existence is liveness" mistake the gates exist to prevent,
 * and got ECONNREFUSED against a port nothing had served for two weeks.
 *
 * A guard on the resolver would not have caught this, because the resolver was right. The
 * thing worth pinning is that the shell door EXISTS and that its credential handling holds.
 */
describe('scripts/pg-url.mjs (the shell door)', () => {
  describe('parseArgs', () => {
    it('defaults to printing the url, with verification ON', () => {
      expect(parseArgs([])).toEqual({ mode: 'url', verify: true });
    });

    for (const [flag, mode] of [
      ['--export', 'export'],
      ['--describe', 'describe'],
      ['--help', 'help'],
      ['-h', 'help'],
    ] as const) {
      it(`maps ${flag} to mode=${mode}`, () => {
        expect(parseArgs([flag])).toEqual({ mode, verify: true });
      });
    }

    it('--no-verify composes with a mode rather than being one', () => {
      expect(parseArgs(['--export', '--no-verify'])).toEqual({ mode: 'export', verify: false });
    });

    /**
     * The security-relevant case. A silently-ignored unknown flag falls through to the
     * DEFAULT mode, which prints the DSN — so `--descrbe` would spray credentials into a
     * log the caller believed was redacted. Rejecting is what makes the redaction promise
     * of `--describe` hold under a typo.
     */
    it('REFUSES an unknown flag instead of falling through to the credential-printing default', () => {
      expect(parseArgs(['--descrbe'])).toEqual({ error: 'unknown argument: --descrbe' });
    });

    it('refuses two conflicting modes rather than letting argument order decide', () => {
      expect(parseArgs(['--export', '--describe'])).toEqual({
        error: 'conflicting modes: --export and --describe',
      });
    });

    it('tolerates a mode repeated (it is unambiguous)', () => {
      expect(parseArgs(['--export', '--export'])).toEqual({ mode: 'export', verify: true });
    });

    it('keeps an explicit child command and its arguments out of the resolver flag parser', () => {
      expect(parseArgs(['--root=/operator', '--exec', '--', 'node', '-e', 'process.exit(7)'])).toEqual({
        mode: 'exec', verify: true, root: '/operator', command: ['node', '-e', 'process.exit(7)'],
      });
    });

    it('requires an executable and an explicit separator for child execution', () => {
      expect(parseArgs(['--exec'])).toEqual({ error: '--exec requires -- followed by a command' });
      expect(parseArgs(['--exec', '--'])).toEqual({ error: '--exec requires -- followed by a command' });
      expect(parseArgs(['--exec', 'node'])).toEqual({ error: 'unknown argument: node' });
      expect(parseArgs(['--describe', '--', 'node'])).toEqual({ error: '-- is only accepted with --exec' });
    });
  });

  describe('explicit administrative source child', () => {
    const cli = join(REPO_ROOT, 'scripts/pg-url.mjs');
    const sourceProbe = `
      import { _resolveUrlsForTests } from '@papercusp/db-org/connection';
      const u = new URL(_resolveUrlsForTests().admin);
      _resolveUrlsForTests();
      console.log(JSON.stringify({ host: u.hostname, port: u.port, database: u.pathname,
        inheritedSecret: process.env.UNRELATED_OPERATOR_SECRET ?? null }));
    `;
    const cleanEnv = () => {
      const env = { ...process.env };
      for (const name of [...PG_URL_ENV_VARS, ...PG_ISOLATION_ENV_VARS]) delete env[name];
      delete env.UNRELATED_OPERATOR_SECRET;
      return env;
    };
    const runProbe = (root: string, env: NodeJS.ProcessEnv) => {
      const result = spawnSync(process.execPath,
        [cli, `--root=${root}`, '--no-verify', '--exec', '--', process.execPath, '--import', 'tsx',
          '--input-type=module', '-e', sourceProbe],
        { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 30_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const diagnostics = result.stderr.trim().split('\n').filter(line => line.startsWith('[db]'));
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every(line => /^\[db\] target source=\S+ endpoint=\S+$/.test(line))).toBe(true);
      expect(new Set(diagnostics).size).toBe(diagnostics.length);
      expect(result.stderr).not.toContain('secret');
      return JSON.parse(result.stdout);
    };

    it('binds the real db-org source resolver to the selected operator root in a fresh child', () => {
      const root = mkdtempSync(join(tmpdir(), 'pg-url-source-root-'));
      writeFileSync(join(root, '.env.local'),
        'DATABASE_URL=postgresql://fixture:secret@127.0.0.1:22223/operator-store\n' +
        'UNRELATED_OPERATOR_SECRET=must-not-be-loaded\n');
      expect(runProbe(root, cleanEnv())).toEqual({
        host: '127.0.0.1', port: '22223', database: '/operator-store', inheritedSecret: null,
      });
    }, 35_000);

    it('keeps an isolated PG port ahead of the selected root ambient database', () => {
      const root = mkdtempSync(join(tmpdir(), 'pg-url-source-isolated-'));
      writeFileSync(join(root, '.env.local'), 'DATABASE_URL=postgresql://ambient:secret@127.0.0.1:22223/live\n');
      expect(runProbe(root, { ...cleanEnv(), PAPERCUSP_PG_PORT: '19532', PAPERCUSP_SKIP_PG_DISCOVERY: '1' })).toEqual({
        host: 'localhost', port: '19532', database: '/papercusp', inheritedSecret: null,
      });
    }, 35_000);

    it('propagates a child failure and never invokes a shell for command arguments', () => {
      const root = mkdtempSync(join(tmpdir(), 'pg-url-source-exit-'));
      writeFileSync(join(root, '.env.local'), 'DATABASE_URL=postgresql://fixture:secret@127.0.0.1:22223/operator-store\n');
      const literal = '$(touch SHOULD_NOT_RUN); literal';
      try {
        execFileSync(process.execPath, [cli, `--root=${root}`, '--no-verify', '--exec', '--',
          process.execPath, '-e', 'console.log(process.argv[1]); process.exit(7)', literal],
        { cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
        throw new Error('expected child exit 7');
      } catch (error) {
        const result = error as { status: number; stdout: string };
        expect(result.status).toBe(7);
        expect(result.stdout.trim()).toBe(literal);
      }
    });

    it('refuses an unpinned healthy discovery/fallback before starting a source child', () => {
      const root = mkdtempSync(join(tmpdir(), 'pg-url-source-no-pin-'));
      try {
        execFileSync(process.execPath, [cli, `--root=${root}`, '--no-verify', '--exec', '--',
          process.execPath, '-e', 'console.log("CHILD_MUST_NOT_START")'],
        { cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 10_000 });
        throw new Error('expected unpinned target refusal');
      } catch (error) {
        const result = error as { status: number; stdout: string; stderr: string };
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('CHILD_MUST_NOT_START');
        expect(result.stderr).toContain('--exec requires an explicit database pin');
      }
    });
  });

  describe('shellSingleQuote', () => {
    /**
     * The output of `--export` is consumed by `eval`, so an unquoted password is command
     * injection against whoever ran it. A DSN password is arbitrary bytes and this repo's
     * own generated credentials are not the only ones this runs against.
     */
    it('neutralises shell metacharacters', () => {
      expect(shellSingleQuote('a$(id)b`id`;rm -rf /')).toBe("'a$(id)b`id`;rm -rf /'");
    });

    it('escapes an embedded single quote (the one character quoting cannot contain)', () => {
      expect(shellSingleQuote("pw'; id #")).toBe(`'pw'\\''; id #'`);
    });

    it('round-trips through a real shell, quote included', () => {
      const secret = `p'w$(id)\`x\` ;#`;
      const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellSingleQuote(secret)}`], {
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      expect(out).toBe(secret);
    });
  });

  describe('formatExportLines', () => {
    const URL_WITH_NASTY_PW = 'postgresql://harness_admin:p%27w%24x@localhost:19838/papercusp';

    it('emits the libpq variables psql reads without them appearing in argv', () => {
      expect(formatExportLines('postgresql://u:pw@db.example:6000/mydb').split('\n')).toEqual([
        "export PGHOST='db.example'",
        "export PGPORT='6000'",
        "export PGUSER='u'",
        "export PGPASSWORD='pw'",
        "export PGDATABASE='mydb'",
      ]);
    });

    it('percent-decodes credentials — libpq wants the raw value, not the URL encoding', () => {
      expect(formatExportLines(URL_WITH_NASTY_PW)).toContain(`export PGPASSWORD='p'\\''w$x'`);
    });

    it('defaults a portless url to 5432 rather than emitting an empty PGPORT', () => {
      // An empty PGPORT is worse than a missing one: it overrides libpq's own default.
      expect(formatExportLines('postgresql://u:pw@h/db')).toContain("export PGPORT='5432'");
    });

    /**
     * Fail loudly rather than emit a PARTIAL environment. A half-set libpq environment does
     * not error — it silently completes itself from libpq's defaults (local socket, $USER),
     * so the caller connects somewhere real and wrong.
     */
    it('throws on an unparseable url instead of emitting a partial environment', () => {
      expect(() => formatExportLines('not a url')).toThrow();
    });

    it('the emitted block is evaluable and sets exactly the five variables', () => {
      const probe = `${formatExportLines(URL_WITH_NASTY_PW)}\nprintf '%s|%s|%s|%s|%s' "$PGHOST" "$PGPORT" "$PGUSER" "$PGPASSWORD" "$PGDATABASE"`;
      expect(
        execFileSync('/bin/sh', ['-c', probe], {
          encoding: 'utf8',
          timeout: 10_000,
          killSignal: 'SIGKILL',
        }),
      ).toBe(
        "localhost|19838|harness_admin|p'w$x|papercusp",
      );
    });
  });

  describe('the shell door is wired to the gated chain, not to the discovery file', () => {
    const source = readFileSync(join(SCRIPTS_DIR, 'pg-url.mjs'), 'utf8');
    const masked = stripCommentsOnly(source, 'pg-url.mjs') as string;

    /**
     * The whole point. If this CLI ever grows its own `readFileSync(embedded-pg.json)` it
     * becomes the very bug it was written to close — and it would look like a reasonable
     * optimisation to whoever wrote it.
     */
    it('never reads the discovery file itself', () => {
      expect(masked).not.toMatch(/embedded-pg\.json/);
    });

    it('delegates to the shared helper', () => {
      expect(masked).toMatch(/from '\.\/lib\/pg-url\.mjs'/);
    });

    /** It lives under scripts/, so the shrink-only guard above must already cover it. */
    it('is subject to the hand-rolled-resolver guard and passes it', () => {
      expect(scriptFiles()).toContain('pg-url.mjs');
      expect(classify(masked)).toEqual([]);
    });
  });
});
