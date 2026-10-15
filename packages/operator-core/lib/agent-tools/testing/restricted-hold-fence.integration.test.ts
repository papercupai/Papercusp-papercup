/**
 * WI-10005634 acceptance falsifier — an UNRESTRICTED session runs a test file a RESTRICTED session
 * wrote inside its disclosure window, and the run is refused. Real Postgres (the disclosure
 * ledger + edit-attribution ledger), a real git checkout, and the PRODUCTION census reader
 * (`restrictedHoldingsFor` = git-sync's two restricted halves), so "held from commit" and
 * "refused from execution" are proven to read the same thing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  runRestrictedHoldPreflight,
} from '../../../../../scripts/lib/restricted-hold-preflight.mjs';

/** The real papercusp checkout this suite lives in (the raw router's own REPO_ROOT). */
const REPO = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..'));
/** A real repo test file the raw-router falsifier marks as a restricted write. */
const HELD_REPO_TEST = 'packages/operator-core/lib/__tests__/restricted-hold-preflight.test.ts';
/** A real test in a standalone package that cannot import @papercusp/test-config (WI-10005765). */
const STANDALONE_PKG = 'libs/generic/git-graph';
const HELD_STANDALONE_TEST = `${STANDALONE_PKG}/src/cache.test.ts`;
/** A real node:test suite (papercusp-desktop's shell tests, WI-10005765). */
const HELD_NODE_TEST = 'papercusp-desktop/test/cargo-target-root.test.js';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { restrictedHoldRefusal } = await import('./restricted-hold-fence');
type OrgTestDb = import('../../../test/_org-test-db').OrgTestDb;

const WS = 'restricted-hold-fence-test';
const RESTRICTED = 'su-fence-restricted';
const UNRESTRICTED = 'su-fence-unrestricted';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;
let root: string;

function put(rel: string, text: string): void {
  putAt(root, rel, text);
}

function putAt(repoRoot: string, rel: string, text: string): void {
  mkdirSync(dirname(join(repoRoot, rel)), { recursive: true });
  writeFileSync(join(repoRoot, rel), text);
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

/**
 * An UNRESTRICTED caller's env pointed at this suite's database. The vitest markers and the
 * testing:run admission marker are removed: either would (correctly) skip the router's preflight,
 * and the point of the falsifier is a top-level raw invocation.
 */
function routerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_ADMIN_DATABASE_URL: org.adminDsn,
    DATABASE_URL: org.adminDsn,
    HARNESS_DATABASE_URL: org.appDsn,
    PAPERCUSP_TEST_RUN_HARNESS: 'papercusp',
  };
  for (const key of Object.keys(env)) if (key === 'VITEST' || key.startsWith('VITEST_')) delete env[key];
  delete env[RESTRICTED_HOLD_PREFLIGHT_ENV];
  return env;
}

async function ledger(agent: string, file: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.edit_attribution_ledger (repo_root, file, agent_id, work_item_id, ts)
    VALUES (${root}, ${file}, ${agent}, ${null}, now())`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  holder.sql = sql;
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'restricted-hold-fence-' + Date.now()}, 'restricted hold fence')
    RETURNING id`;
  userId = user.id;

  root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-hold-fence-int-')));
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'), 'dir');
  git('init', '-q');
  git('config', 'user.email', 'fence@example.com');
  git('config', 'user.name', 'fence');
  put('src/base.ts', 'export const base = 1;\n');
  put('tests/base.test.ts', "import { base } from '../src/base';\nexport const value = base;\n");
  put('package.json', JSON.stringify({ name: 'restricted-hold-node-test-fixture', private: true }));
  const nodeTestHostPreflight = pathToFileURL(join(REPO, 'scripts/lib/node-test-host-preflight.mjs')).href;
  put(
    'test/monorepo-host-preflight.mjs',
    [
      "import { runNodeTestHostPreflight } from '" + nodeTestHostPreflight + "';",
      'await runNodeTestHostPreflight({ repoRoot: process.env.PAPERCUSP_RESTRICTED_HOLD_TEST_ROOT });',
      '',
    ].join('\n'),
  );
  put(
    HELD_NODE_TEST,
    "const { test } = require('node:test');\ntest('fixture test runs after admission', () => {});\n",
  );
  git('add', '-A');
  git('commit', '-q', '-m', 'base');

  // The restricted session's window opens a minute ago, so every write below falls inside it.
  await sql`
    INSERT INTO harness_shared.personal_disclosures
      (workspace_id, user_id, agent_owner_id, document_id, source, level, reader_set, delivered_via, delivered_at)
    VALUES (${WS}, ${userId}, ${RESTRICTED}, gen_random_uuid(), 'email', 'participants',
            ${['alice@example.com']}::text[], 'personal:search', now() - interval '1 minute')`;

  // 1. A test file the restricted session wrote with a native (ledgered) edit.
  put('tests/planted.test.ts', "import { base } from '../src/base';\nexport const value = base;\n");
  await ledger(RESTRICTED, 'tests/planted.test.ts');

  // 2. A source written inside the window with NO ledger row (e.g. a shell redirect), imported by
  //    a test an unrestricted session wrote natively — only the window half of the census sees it.
  put('src/unattributed.ts', 'export const planted = 2;\n');
  put('tests/uses-unattributed.test.ts', "import { planted } from '../src/unattributed';\nexport const value = planted;\n");
  await ledger(UNRESTRICTED, 'tests/uses-unattributed.test.ts');

  // 3. REAL repo test files, ledgered to the restricted session, for the process-level falsifiers.
  for (const file of [HELD_REPO_TEST, HELD_STANDALONE_TEST]) {
    await sql`
      INSERT INTO harness_shared.edit_attribution_ledger (repo_root, file, agent_id, work_item_id, ts)
      VALUES (${REPO}, ${file}, ${RESTRICTED}, ${null}, now())`;
  }
  await ledger(RESTRICTED, HELD_NODE_TEST);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    await org.adminSql`DELETE FROM harness_shared.personal_disclosures WHERE workspace_id = ${WS}`.catch(() => {});
    await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  holder.sql = null;
  await org?.cleanup();
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('restricted-write fence on the production census (real Postgres + git)', () => {
  it('refuses to run a test file the restricted session wrote inside its window', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/planted.test.ts']);
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toContain('tests/planted.test.ts is itself a held restricted write');
  });

  it('refuses a test whose closure imports an unattributed write made inside the window', async () => {
    const refusal = await restrictedHoldRefusal(root, ['tests/uses-unattributed.test.ts']);
    expect(refusal).toMatchObject({ error: 'restricted_write_held' });
    expect(refusal?.hint).toMatch(/imports .*src\/unattributed\.ts/);
  });

  it('admits an unrelated committed test while the hold stands (calibration)', async () => {
    expect(await restrictedHoldRefusal(root, ['tests/base.test.ts'])).toBeNull();
  });

  // WI-10005713 acceptance falsifier: the RAW router (`npm run test:file` = scripts/test-files.mjs),
  // spawned as a real unrestricted process, refuses a held restricted write BEFORE any test group
  // launches. The held file is a real repo test, ledgered to the restricted session in this
  // throwaway database, which the router's census child reaches through the env DSNs.
  it('the raw test:file router refuses a held restricted write before vitest starts', () => {
    const result = spawnSync(process.execPath, [join(REPO, 'scripts/test-files.mjs'), HELD_REPO_TEST], {
      cwd: REPO,
      env: routerEnv(),
      encoding: 'utf8',
      timeout: 110_000,
    });
    expect(result.stderr).toContain('TEST_FILE_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none');
    expect(result.status).toBe(2); // TEST_FILE_EXIT_NOT_MEASURED
    // Every test group prints `ROUTE cwd=` before it starts a test process; none may appear.
    expect(result.stdout).not.toContain('ROUTE cwd=');
  }, 120_000);

  // WI-10005724 acceptance falsifier: vitest invoked DIRECTLY (what `npx vitest` and every
  // per-workspace task of `npm run test:affected` do) reaches no router. The libs/test-config
  // host-preflight globalSetup must refuse the held file before any test executes. Baseline before
  // the fix (measured 2026-10-02 23:30Z): this exact command ran it, 17 passed, exit 0.
  it('direct vitest refuses a held restricted write before any test executes', () => {
    const result = directVitest();
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain('VITEST_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none');
    expect(result.status).not.toBe(0);
    expect(output).not.toMatch(/Tests\s+\d+ passed/);
  }, 120_000);

  // WI-10005745 acceptance falsifier: bg-host's ExecStartPre bundles the LIVE tree and runs it with
  // the network. The real gate helper bundle-host.sh calls (snapshot → build → gate) must refuse a
  // bundle whose esbuild metafile lists the held repo file, and put the last-known-good bytes back.
  it('the host-bundle gate refuses a bundle that consumed a held restricted write and restores last-known-good', () => {
    const result = bundleGate([HELD_REPO_TEST, 'packages/operator-core/lib/agent-tools/testing/restricted-hold-fence.ts']);
    expect(result.output).toContain('BUNDLE_RESTRICTED_HOLD_REFUSED error=restricted_write_held published=last-known-good');
    expect(result.output).toContain(`${HELD_REPO_TEST} is a bundle input and a held restricted write`);
    expect(result.status).toBe(3);
    expect(result.host).toBe('last-known-good host');
  }, 120_000);

  // WI-10005765 falsifiers: two runner shapes that pass none of the three doors above. A standalone
  // package's own vitest config (it cannot import @papercusp/test-config) and a `node --test` suite
  // each reach the census through a walk-up to a monorepo convention module.
  it('direct vitest in a standalone exempt package refuses a held restricted write before any test executes', () => {
    const output = joined(standaloneVitest());
    expect(output).toContain('VITEST_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none');
    expect(output).toContain(`${HELD_STANDALONE_TEST} is itself a held restricted write`);
    expect(output).not.toMatch(/Tests\s+\d+ passed/);
  }, 120_000);

  it('a node:test suite refuses a held restricted write in its runner before any test file starts', () => {
    const result = desktopNodeTest();
    const output = joined(result);
    expect(output, 'node:test runner output:\n' + output).toContain('NODE_TEST_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none');
    expect(output).toContain(`${HELD_NODE_TEST} is itself a held restricted write`);
    expect(result.status).not.toBe(0);
    expect(output).not.toMatch(/^ℹ pass [1-9]/m);
  }, 120_000);

  it('admits both once the disclosure is released', async () => {
    await sql`
      UPDATE harness_shared.personal_disclosures
         SET released_at = now(), released_by = 'owner', release_ref = 'fixture-release'
       WHERE workspace_id = ${WS} AND agent_owner_id = ${RESTRICTED}`;
    expect(await restrictedHoldRefusal(root, ['tests/planted.test.ts'])).toBeNull();
    expect(await restrictedHoldRefusal(root, ['tests/uses-unattributed.test.ts'])).toBeNull();
    expect(await restrictedHoldRefusal(root, [HELD_NODE_TEST])).toBeNull();
  });

  // Calibration for the router falsifier: the SAME census child, same env, admits once released —
  // so the refusal above was the hold, not a broken spawn, tsx load, or DSN.
  it('the raw-router preflight admits the same repo test once the disclosure is released', () => {
    expect(runRestrictedHoldPreflight({ repoRoot: REPO, files: [join(REPO, HELD_REPO_TEST)], env: routerEnv() })).toEqual({
      verdict: 'admit',
    });
  }, 120_000);

  // Calibration for the direct-vitest falsifier: the same command runs the file once released, so
  // the refusal above was the hold, not a config that can no longer load.
  it('direct vitest runs the same file once the disclosure is released', () => {
    const result = directVitest();
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Tests\s+\d+ passed/);
    expect(result.status).toBe(0);
  }, 120_000);

  // Calibrations for the WI-10005765 falsifiers: the same commands run their tests once released.
  it('direct vitest in the standalone package runs the same file once the disclosure is released', () => {
    const result = standaloneVitest();
    expect(joined(result)).toMatch(/Tests\s+\d+ passed/);
    expect(result.status).toBe(0);
  }, 120_000);

  it('the node:test suite runs the same file once the disclosure is released', () => {
    const result = desktopNodeTest();
    expect(joined(result), 'node:test runner output:\n' + joined(result)).toMatch(/^ℹ pass [1-9]/m);
    expect(joined(result), 'node:test runner output:\n' + joined(result)).toMatch(/^ℹ fail 0$/m);
    expect(result.status).toBe(0);
  }, 120_000);

  // Calibration for the bundle-gate falsifier: the identical inputs publish once released.
  it('the host-bundle gate admits the same bundle once the disclosure is released', () => {
    const result = bundleGate([HELD_REPO_TEST, 'packages/operator-core/lib/agent-tools/testing/restricted-hold-fence.ts']);
    expect(result.output).toContain('none is a held restricted write');
    expect(result.status).toBe(0);
    expect(result.host).toBe('fresh host');
  }, 120_000);
});

/**
 * Run bin/bundle-restricted-hold-gate.mjs exactly as bundle-host.sh does: snapshot the published
 * artifact, "build" over it (tmp + rename), then gate with a metafile naming `inputs` (repo-relative,
 * the way esbuild records them against its working dir).
 */
function bundleGate(inputs: string[]): { status: number | null; output: string; host: string } {
  const gateHelper = join(REPO, 'apps/operator/bin/bundle-restricted-hold-gate.mjs');
  const work = mkdtempSync(join(tmpdir(), 'bundle-gate-int-'));
  try {
    const outdir = join(work, 'dist-host');
    const snapshotDir = join(outdir, '.restricted-lkg.test');
    mkdirSync(outdir, { recursive: true });
    writeFileSync(join(outdir, 'hono-host.mjs'), 'last-known-good host');
    const snap = spawnSync(process.execPath, [gateHelper, 'snapshot', '--outdir', outdir, '--snapshot-dir', snapshotDir, '--artifact', 'hono-host.mjs'], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(snap.status).toBe(0);
    writeFileSync(join(outdir, 'hono-host.mjs.tmp'), 'fresh host');
    renameSync(join(outdir, 'hono-host.mjs.tmp'), join(outdir, 'hono-host.mjs'));
    const metafile = join(work, 'hono-host.mjs.meta.json');
    writeFileSync(metafile, JSON.stringify({ inputs: Object.fromEntries(inputs.map((input) => [input, { bytes: 1, imports: [] }])) }));
    const result = spawnSync(
      process.execPath,
      [gateHelper, 'gate', '--root', REPO, '--base-dir', REPO, '--outdir', outdir, '--snapshot-dir', snapshotDir, '--metafile', metafile],
      { cwd: REPO, env: routerEnv(), encoding: 'utf8', timeout: 110_000 },
    );
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, host: readFileSync(join(outdir, 'hono-host.mjs'), 'utf8') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function joined(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}

/** `vitest run <held test>` from the standalone package, through its own (non-test-config) config. */
function standaloneVitest() {
  return spawnSync(process.execPath, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', HELD_STANDALONE_TEST.slice(STANDALONE_PKG.length + 1)], {
    cwd: join(REPO, STANDALONE_PKG),
    env: { ...routerEnv(), NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 110_000,
  });
}

/** papercusp-desktop's node:test invocation (its package.json shape) on the held suite. */
function desktopNodeTest() {
  const env: NodeJS.ProcessEnv = { ...routerEnv(), NO_COLOR: '1', FORCE_COLOR: '0' };
  delete env.NODE_TEST_CONTEXT;
  env.PAPERCUSP_RESTRICTED_HOLD_TEST_ROOT = root;
  return spawnSync(
    process.execPath,
    ['--test', '--test-global-setup=test/monorepo-host-preflight.mjs', HELD_NODE_TEST],
    { cwd: root, env, encoding: 'utf8', timeout: 110_000 },
  );
}

/** `vitest run <held test>` from its own workspace, as an unrestricted top-level caller. */
function directVitest() {
  return spawnSync(process.execPath, [join(REPO, 'node_modules/vitest/vitest.mjs'), 'run', HELD_REPO_TEST.replace('packages/operator-core/', '')], {
    cwd: join(REPO, 'packages/operator-core'),
    env: { ...routerEnv(), NO_COLOR: '1', FORCE_COLOR: '0' },
    encoding: 'utf8',
    timeout: 110_000,
  });
}
