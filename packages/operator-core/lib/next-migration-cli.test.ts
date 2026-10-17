/**
 * scripts/next-migration.mjs — output-shape unit tests (EI-19366138707071397).
 *
 * The script's pure `buildAllocationResult` is imported directly (same pattern
 * as lint-tsc.test.ts) so this covers the `.DRAFT`-suffix contract WITHOUT a
 * live Postgres connection: the allocator (pg advisory lock + GREATEST math)
 * is already covered end-to-end by
 * packages/operator-core/lib/agent-tools/db/next_migration.integration.test.ts
 * — this file only guards the JSON shape the CLI prints.
 *
 * Why this matters: a freshly reserved migration used to point the caller at
 * the bare `<NNN>-<slug>.sql` path, which the boot-time auto-apply runner
 * treats as ready-to-run the instant it exists on disk — so editing it
 * (including a deliberate temporary both-ways guard-test mutation, per the
 * house rule "a guard you haven't seen fail is not a guard") could race a
 * concurrent operator restart and execute half-finished SQL against the live
 * DB (migration 729 / WI-7057 near-miss). The fix redirects the write target
 * to a `.DRAFT`-suffixed path — invisible to every consumer of the migration
 * runner (`*.filter(f => f.endsWith('.sql'))` in migration-runner.js,
 * lint-migrations.mjs, and migration-drift.ts's `isRunnerMigration`) — and
 * hands back the shared linted no-clobber command to arm it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
// eslint-disable-next-line import/no-relative-packages
import {
  armMigration,
  buildAllocationResult,
  describeReservationTarget,
  main,
  resolveReservationTarget,
  verifyConnectedDatabaseName,
} from '../../../scripts/next-migration.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporarySqlDirs: string[] = [];

/** The resolver `resolveReservationTarget` injects — i.e. `resolveScriptPgUrl`'s shape. */
type PgUrlResolution = ReturnType<NonNullable<Parameters<typeof resolveReservationTarget>[0]>>;

describe('migration reservation target binding (EI-25452541884750444)', () => {
  const discovered: PgUrlResolution = {
    url: 'postgresql://harness_admin:private-secret@127.0.0.1:23325/papercusp',
    source: 'discovery',
    envLocal: { file: join(REPO_ROOT, 'apps/operator/.env.local'), exists: false, present: [], applied: [], skipped: null },
  };

  it('uses the operator env root and refuses discovery-only targets', () => {
    let root: string | undefined;
    expect(() => resolveReservationTarget((opts) => {
      root = opts?.root;
      return discovered;
    })).toThrow(/explicitly configured operator database target/);
    expect(root).toBe(join(REPO_ROOT, 'apps/operator'));
  });

  it('accepts explicit operator env pins and an isolated PG port', () => {
    expect(() => resolveReservationTarget(() => ({
      ...discovered,
      source: 'env',
      via: 'DATABASE_URL',
    }))).not.toThrow();
    expect(() => resolveReservationTarget(() => ({
      ...discovered,
      source: 'isolated-pg-port',
    }))).not.toThrow();
  });

  it('checks the connected database name and reports the redacted endpoint', () => {
    expect(verifyConnectedDatabaseName(discovered.url, 'papercusp')).toBe(true);
    expect(() => verifyConnectedDatabaseName(discovered.url, 'wrong-db')).toThrow(/database mismatch/);
    const line = describeReservationTarget({ ...discovered, source: 'env', via: 'DATABASE_URL' }, {
      db: 'papercusp',
      port: 5432,
    });
    expect(line).toContain('127.0.0.1:23325/papercusp');
    expect(line).toContain('connected db=papercusp port=5432');
    expect(line).not.toContain('private-secret');
  });

  it('runs the target check before the reservation transaction', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/next-migration.mjs'), 'utf8');
    expect(source).toContain('target = resolveReservationTarget();');
    const check = source.indexOf('verifyConnectedDatabaseName(target.url, connected?.db)');
    const reserve = source.indexOf('const allocated = await sql.begin(async (tx) =>');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(reserve);
  });
});

function makeSqlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'next-migration-arm-'));
  temporarySqlDirs.push(dir);
  return dir;
}

async function bundleAllocator(sourceOverride?: string): Promise<string> {
  const scriptPath = join(REPO_ROOT, 'scripts/next-migration.mjs');
  const result = await build({
    stdin: {
      contents: `import { buildAllocationResult } from ${JSON.stringify(scriptPath)};
        console.log(buildAllocationResult({ next: 1, filename: '001-test.sql', reservedBy: 'test' }).path);`,
      resolveDir: REPO_ROOT,
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
    logLevel: 'silent',
    plugins: [{
      name: 'allocator-entry-guard-fixture',
      setup(builder) {
        // Inline the real entry helper, as bundle-host does. Keep unrelated
        // allocation/lint dependencies at their source paths for this small fixture.
        builder.onResolve({ filter: /^@papercusp\/operator-core\/lib\/util\/cli-entry$/ }, () => ({
          path: join(REPO_ROOT, 'packages/operator-core/lib/util/cli-entry.ts'),
        }));
        builder.onResolve({ filter: /^\.\/lib\/|^\.\.\/packages\/operator-core\/lib\/migration-preapply-lint\.ts$/ }, args => ({
          path: resolve(args.resolveDir, args.path),
          external: true,
        }));
        if (sourceOverride !== undefined) {
          builder.onLoad({ filter: /\/scripts\/next-migration\.mjs$/ }, () => ({
            contents: sourceOverride,
            loader: 'js',
            resolveDir: dirname(scriptPath),
          }));
        }
      },
    }],
  });
  const bundlePath = join(makeSqlDir(), 'allocator-bundle.mjs');
  writeFileSync(bundlePath, result.outputFiles[0].text);
  return bundlePath;
}

describe('next-migration CLI entry (WI-10004484)', () => {
  it('imports the allocator in a host bundle without running its CLI main', async () => {
    const bundlePath = await bundleAllocator();
    // Invalid argv makes accidental CLI execution fail before any PG access.
    const result = spawnSync(process.execPath, [bundlePath, '--name', '!!!'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('libs/papercusp/libs/db/sql/001-test.sql.DRAFT');
  });

  it('detects the original raw entry guard after bundling', async () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/next-migration.mjs'), 'utf8');
    const unsafeSource = source.replace(
      'if (isCliEntry(import.meta.url)) {',
      'if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {',
    );
    expect(unsafeSource).not.toBe(source);
    const bundlePath = await bundleAllocator(unsafeSource);
    const result = spawnSync(process.execPath, [bundlePath, '--name', '!!!'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--name is required and must contain at least one letter or digit/);
  });

  // WI-10004497: the host bundle imports this file, so a top-level await here
  // turns it and every importer into async esbuild inits. Across an import
  // cycle those inits waited on each other and the operator host never
  // listened (:3170 and every verify-tauri-headless rig, 2026-10-01). esbuild
  // refuses top-level await for CommonJS output, so this transform fails on
  // exactly that construct anywhere in the file.
  it('has no top-level await, so bundling it cannot make its importers async', async () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/next-migration.mjs'), 'utf8');
    await expect(transform(source, { format: 'cjs', loader: 'js', logLevel: 'silent' })).resolves.toBeDefined();
    // Positive control: the same check rejects the pre-fix spelling.
    const withTopLevelAwait = `${source}\nif (globalThis.__never__) await main();\n`;
    await expect(transform(withTopLevelAwait, { format: 'cjs', loader: 'js', logLevel: 'silent' }))
      .rejects.toThrow(/Top-level await/);
  });
});

afterEach(() => {
  for (const dir of temporarySqlDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildAllocationResult (EI-19366138707071397 — DRAFT-suffix contract)', () => {
  it('rejects a slug-empty name before opening Postgres', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/next-migration.mjs', '--name', '!!!'],
      // A sync spawn blocks the pure-lane worker's event loop, so vitest cannot time it
      // out; bound it here or a hang wedges the whole shared fork (WI-41180 ratchet).
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--name is required and must contain at least one letter or digit/);
  });

  it('points `path` at a `.DRAFT`-suffixed write target, never the bare `.sql` name', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT');
    // The draft path must NOT be a bare `.sql` file — that is exactly the
    // filename the migration runner auto-applies. Guard against a future edit
    // reverting `path` back to the armed name.
    expect(r.path.endsWith('.sql')).toBe(false);
    expect(r.path.endsWith('.sql.DRAFT')).toBe(true);
  });

  it('`arm_path` is the bare, eventual `.sql` name the runner will apply once armed', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.arm_path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql');
  });

  it('arm_command uses the shared linted no-clobber CLI executor', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.arm_command).toBe(
      "npx tsx scripts/next-migration.mjs --arm 'libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT'",
    );
  });

  it('the reserved `filename` (ledger record) stays the bare armed name — only the write target gets the suffix', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.filename).toBe('740-add-foo-index.sql');
  });

  it('a dry run still returns the DRAFT-suffixed path/arm_command shape, with `reserved: false` and a dry-run note', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: true,
    });
    expect(r.reserved).toBe(false);
    expect(r.path).toBe('libs/papercusp/libs/db/sql/740-add-foo-index.sql.DRAFT');
    expect(r.note).toMatch(/DRY RUN/);
  });

  it('the printed note names both the DRAFT invisibility guarantee and the arm command, for a non-dry-run', () => {
    const r = buildAllocationResult({
      next: 740,
      filename: '740-add-foo-index.sql',
      reservedBy: 'su-test',
      dryRun: false,
    });
    expect(r.note).toMatch(/INVISIBLE to boot auto-apply/);
    expect(r.note).toContain(r.arm_command);
  });

  it('respects a caller-supplied canonicalDir (used only by tests — production always uses the real sql dir)', () => {
    const r = buildAllocationResult({
      next: 1,
      filename: '001-x.sql',
      reservedBy: 'su-test',
      dryRun: false,
      canonicalDir: 'some/other/dir',
    });
    expect(r.path).toBe('some/other/dir/001-x.sql.DRAFT');
    expect(r.arm_path).toBe('some/other/dir/001-x.sql');
  });

  it('routes --arm before allocation so a missing draft path does not try to open Postgres', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/next-migration.mjs', '--arm'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('db:next-migration ARM FAILED — A .sql.DRAFT path is required.');
    expect(result.stderr).not.toContain('could not reach the reservation ledger');
  });

  it('refuses --dry-run with --arm before calling the mutating arm path', async () => {
    const sqlDir = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');
    const draftPath = join(sqlDir, `${Date.now()}-dry-run-arm-preview.sql.DRAFT`);
    const armPath = draftPath.slice(0, -'.DRAFT'.length);
    expect(existsSync(draftPath)).toBe(false);
    expect(existsSync(armPath)).toBe(false);

    const originalExitCode = process.exitCode;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const arm = vi.fn<typeof armMigration>();
    let result: { status: typeof process.exitCode; stderr: string } = { status: undefined, stderr: '' };
    try {
      await main(['--arm', draftPath, '--dry-run'], arm);
      result = { status: process.exitCode, stderr: error.mock.calls.flat().join('\n') };
    } finally {
      process.exitCode = originalExitCode;
      error.mockRestore();
    }
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'db:next-migration REFUSED — --dry-run cannot be combined with --arm; no migration file was changed.',
    );
    expect(result.stderr).not.toContain('could not reach the reservation ledger');
    expect(existsSync(draftPath)).toBe(false);
    expect(existsSync(armPath)).toBe(false);
  });

  it('refuses to arm a draft that fails the boot pre-apply lint and leaves it unchanged', async () => {
    const sqlDir = makeSqlDir();
    const draftPath = join(sqlDir, '1300-unsafe-index-swap.sql.DRAFT');
    const armPath = join(sqlDir, '1300-unsafe-index-swap.sql');
    const unsafeSql = [
      '-- FORWARD-COMPAT: replacement is not consumed by the serving release',
      'CREATE UNIQUE INDEX IF NOT EXISTS agent_facts_identity_current',
      '  ON harness_shared.agent_facts',
      "     (workspace_id, scope, COALESCE(scope_ref, ''::text), key)",
      '  WHERE superseded_at IS NULL;',
      'DROP INDEX IF EXISTS harness_shared.agent_facts_identity;',
    ].join('\n');
    writeFileSync(draftPath, unsafeSql);

    await expect(armMigration({ draftPath, sqlDir })).rejects.toThrow(
      'same-migration unique-index shape swap',
    );
    expect(existsSync(draftPath)).toBe(true);
    expect(readFileSync(draftPath, 'utf8')).toBe(unsafeSql);
    expect(existsSync(armPath)).toBe(false);
  });

  it('arms safe SQL as a separate no-clobber file and removes the unchanged draft', async () => {
    const sqlDir = makeSqlDir();
    const draftPath = join(sqlDir, '1301-safe-addition.sql.DRAFT');
    const armPath = join(sqlDir, '1301-safe-addition.sql');
    const safeSql = 'ALTER TABLE harness_shared.example ADD COLUMN value text;';
    writeFileSync(draftPath, safeSql);

    await expect(armMigration({ draftPath, sqlDir })).resolves.toMatchObject({
      ok: true,
      draft_path: draftPath,
      arm_path: armPath,
      draft_removed: true,
    });
    expect(readFileSync(armPath, 'utf8')).toBe(safeSql);
    expect(existsSync(draftPath)).toBe(false);
  });

  it('never overwrites an existing armed migration', async () => {
    const sqlDir = makeSqlDir();
    const draftPath = join(sqlDir, '1302-no-clobber.sql.DRAFT');
    const armPath = join(sqlDir, '1302-no-clobber.sql');
    const draftSql = 'ALTER TABLE harness_shared.example ADD COLUMN draft_value text;';
    const existingSql = 'ALTER TABLE harness_shared.example ADD COLUMN existing_value text;';
    writeFileSync(draftPath, draftSql);
    writeFileSync(armPath, existingSql);

    await expect(armMigration({ draftPath, sqlDir })).rejects.toThrow('target already exists');
    expect(readFileSync(draftPath, 'utf8')).toBe(draftSql);
    expect(readFileSync(armPath, 'utf8')).toBe(existingSql);
  });
});
