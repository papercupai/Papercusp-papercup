/**
 * linear-asana-task-sync-2026-10-05 P-009 / clause AUTO-BAR-R-9-P-009:
 * "No pre-contract tracker-sync plugin remains installable."
 *
 * The pre-contract @papercupai/linear-sync and @papercupai/jira-sync plugins were
 * retired with no compatibility layer (generalized-integrations D-008). Linear
 * now arrives as a ticket provider on the generalized provider contract (plan
 * D-002). This guard pins the three things that made them installable:
 *
 *   1. the bundled plugin catalog (libs/papercusp/plugins/<dir>/papercusp.json)
 *      — the source every install copies or links from — carries no package
 *      for either plugin, by directory OR by manifest name;
 *   2. migration 1379 drops both plugin schemas and deletes every registry row
 *      (enables, configs, capability grants, kv, reload state, hide list) that
 *      named either plugin;
 *   3. nothing in the migration set (the frozen baseline or any later
 *      migration) recreates either schema, so a fresh install never has them.
 *
 * Each check has a positive control so an empty directory listing or an
 * unreadable file cannot pass vacuously.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'libs/papercusp/plugins');
const SQL_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const RETIREMENT_MIGRATION = '1379-retire-linear-jira-sync-plugins.sql';

const RETIRED_DIRS = ['linear-sync', 'jira-sync'] as const;
const RETIRED_MANIFEST_NAMES = ['@papercupai/linear-sync', '@papercupai/jira-sync'] as const;
const RETIRED_SCHEMAS = ['plugin_linear_sync', 'plugin_jira_sync'] as const;
const REGISTRY_TABLES = [
  'plugin_enables',
  'plugin_configs',
  'plugin_capability_grants',
  'plugin_kv',
  'plugin_reload_state',
  'hidden_plugins',
] as const;

/** Every bundled plugin package: directory name + manifest name. */
function bundledCatalog(): Array<{ dir: string; name: string }> {
  const out: Array<{ dir: string; name: string }> = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const manifestPath = join(PLUGINS_DIR, entry.name, 'papercusp.json');
    let name = '';
    if (existsSync(manifestPath)) {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
      name = typeof parsed.name === 'string' ? parsed.name : '';
    }
    out.push({ dir: entry.name, name });
  }
  return out;
}

/** SQL with `--` line comments removed, so prose about the plugins cannot satisfy or trip a check. */
function sqlStatements(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

/** The DELETE statement that targets `harness_shared.<table>`, or null. */
function deleteStatementFor(sql: string, table: string): string | null {
  const re = new RegExp(`DELETE\\s+FROM\\s+harness_shared\\.${table}\\b[^;]*;`, 'i');
  const m = sql.match(re);
  return m ? m[0] : null;
}

describe('retired pre-contract tracker-sync plugins (P-009, R-9)', () => {
  it('the bundled plugin catalog carries no linear-sync or jira-sync package', () => {
    const catalog = bundledCatalog();
    // Positive control: the reader sees the real catalog, including a ticket
    // provider that sits on the provider contract.
    expect(catalog.length).toBeGreaterThan(10);
    expect(catalog.map((p) => p.name)).toContain('github-issues');

    const retiredDirs = catalog.filter((p) => (RETIRED_DIRS as readonly string[]).includes(p.dir));
    const retiredNames = catalog.filter((p) => (RETIRED_MANIFEST_NAMES as readonly string[]).includes(p.name));
    expect(retiredDirs).toEqual([]);
    expect(retiredNames).toEqual([]);
  });

  it('migration 1379 drops both plugin schemas', () => {
    const path = join(SQL_DIR, RETIREMENT_MIGRATION);
    expect(existsSync(path), `${RETIREMENT_MIGRATION} must be armed (not .DRAFT)`).toBe(true);
    const sql = sqlStatements(path);
    for (const schema of RETIRED_SCHEMAS) {
      expect(sql).toMatch(new RegExp(`DROP\\s+SCHEMA\\s+IF\\s+EXISTS\\s+${schema}\\s+CASCADE\\s*;`, 'i'));
    }
  });

  it('migration 1379 deletes every registry row that named either plugin', () => {
    const sql = sqlStatements(join(SQL_DIR, RETIREMENT_MIGRATION));
    for (const table of REGISTRY_TABLES) {
      const stmt = deleteStatementFor(sql, table);
      expect(stmt, `no DELETE for harness_shared.${table}`).not.toBeNull();
      // Both plugins, in the bare-basename form every table may hold.
      expect(stmt).toContain(`'linear-sync'`);
      expect(stmt).toContain(`'jira-sync'`);
      // Tables keyed by manifest name hold the scoped form too.
      if (table !== 'hidden_plugins') {
        expect(stmt).toContain(`'@papercupai/linear-sync'`);
        expect(stmt).toContain(`'@papercupai/jira-sync'`);
      }
    }
  });

  it('no migration in the set recreates either schema', () => {
    const files = readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql'));
    // Positive control: the reader sees the real migration set, baseline included.
    expect(files).toContain('000-baseline.sql');
    expect(files).toContain(RETIREMENT_MIGRATION);

    const retirementNumber = Number.parseInt(RETIREMENT_MIGRATION, 10);
    const creators: string[] = [];
    for (const f of files) {
      const n = Number.parseInt(f, 10);
      // Migrations before the retirement may have created the schemas; the drop
      // in 1379 supersedes them. Only the baseline (applied on a fresh install
      // in place of the archive) and anything after 1379 could bring them back.
      if (f !== '000-baseline.sql' && !(Number.isFinite(n) && n > retirementNumber)) continue;
      const sql = sqlStatements(join(SQL_DIR, f));
      for (const schema of RETIRED_SCHEMAS) {
        if (new RegExp(`CREATE\\s+(SCHEMA|TABLE)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${schema}\\b`, 'i').test(sql)) {
          creators.push(`${f}: ${schema}`);
        }
      }
    }
    expect(creators).toEqual([]);
  });
});
