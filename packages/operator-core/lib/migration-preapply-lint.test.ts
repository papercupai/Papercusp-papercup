import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { transformSync } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';

const dirs: string[] = [];

function sqlDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migration-preapply-lint-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('migration pre-apply lint', () => {
  it('keeps the imported migration predicate module compatible with CJS dev-host transforms', () => {
    const source = readFileSync(resolve(__dirname, '../../../scripts/lint-migrations.mjs'), 'utf8');
    expect(() => transformSync(source, { format: 'cjs', loader: 'js', platform: 'node' })).not.toThrow();
  });

  it('refuses top-level transaction control before apply', () => {
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '999-bad-transaction.sql',
        sqlText: 'BEGIN;\nALTER TABLE example ADD COLUMN value text;\nCOMMIT;',
        sqlDir: sqlDir(),
      }),
    ).toThrow(/top-level transaction control/);
  });

  it('refuses unacknowledged destructive DDL before apply', () => {
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '999-breaking-drop.sql',
        sqlText: 'ALTER TABLE harness_shared.example DROP COLUMN value;',
        sqlDir: sqlDir(),
      }),
    ).toThrow(/destructive DDL without an accepted FORWARD-COMPAT acknowledgement/);
  });

  it('accepts safe SQL and the gate lint acknowledgement shape', () => {
    const dir = sqlDir();
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '999-safe.sql',
        sqlText: 'ALTER TABLE harness_shared.example ADD COLUMN value text;',
        sqlDir: dir,
      }),
    ).not.toThrow();
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '1000-reviewed-drop.sql',
        sqlText: '-- FORWARD-COMPAT: deployed readers do not use this column\nALTER TABLE harness_shared.example DROP COLUMN value;',
        sqlDir: dir,
      }),
    ).not.toThrow();
  });

  it('accepts migration 1188 additive partial uniqueness only with its forward-compat acknowledgement', () => {
    const migrationPath = resolve(__dirname, '../../../libs/papercusp/libs/db/sql/1188-hosted-self-signup.sql');
    const migrationText = readFileSync(migrationPath, 'utf8');
    const migrationSqlDir = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
    const lint = (sqlText: string) =>
      assertMigrationPassesPreApplyLints({
        filename: '1188-hosted-self-signup.sql',
        sqlText,
        sqlDir: migrationSqlDir,
      });

    expect(() => lint(migrationText)).not.toThrow();

    const withoutAcknowledgement = migrationText.replace(
      /^[ \t]*--[ \t]*FORWARD-COMPAT:[^\r\n]*(?:\r?\n|$)/m,
      '',
    );
    expect(withoutAcknowledgement).not.toBe(migrationText);
    expect(() => lint(withoutAcknowledgement)).toThrow(/narrowing-unique-index/);
  });

  it('accepts the benchmark archive status migration through the actual boot safety checks', () => {
    const filename = '1434-benchmark-ungraded-archive-state.sql';
    const migrationSqlDir = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
    const migrationText = readFileSync(join(migrationSqlDir, filename), 'utf8');
    const lint = (sqlText: string) =>
      assertMigrationPassesPreApplyLints({ filename, sqlText, sqlDir: migrationSqlDir });

    expect(() => lint(migrationText)).not.toThrow();

    // Raw-SQL fixtures strip transaction wrappers and miss boot refusals. Keep
    // both refusal controls on the unmodified file's production lint path.
    expect(() => lint(`BEGIN;\n${migrationText}\nCOMMIT;`)).toThrow(/top-level transaction control/);
    const withoutAcknowledgement = migrationText.replace(
      /^[ \t]*--[ \t]*FORWARD-COMPAT:[^\r\n]*(?:\r?\n|$)/m,
      '',
    );
    expect(withoutAcknowledgement).not.toBe(migrationText);
    expect(() => lint(withoutAcknowledgement)).toThrow(/drop-constraint/);
  });

  it('does not grandfather a newly pending file through frozen exemptions', () => {
    const dir = sqlDir();
    writeFileSync(join(dir, '972-completion-authority-content-identity-floor.sql'), 'BEGIN; SELECT 1; COMMIT;');
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '972-completion-authority-content-identity-floor.sql',
        sqlText: 'BEGIN; SELECT 1; COMMIT;',
        sqlDir: dir,
      }),
    ).toThrow(/top-level transaction control/);
  });

  it('refuses a view lock-order inversion before the migration can be applied', () => {
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '1172-new-view-lock-order.sql',
        sqlText: [
          'ALTER TABLE harness_shared.work_items ADD COLUMN lane text;',
          'CREATE OR REPLACE VIEW harness_shared.engineer_issues AS',
          '  SELECT lane FROM harness_shared.work_items;',
        ].join('\n'),
        sqlDir: sqlDir(),
      }),
    ).toThrow(/view lock-order inversion/);
  });

  it('refuses an unaccounted view drop before the migration can be applied', () => {
    expect(() =>
      assertMigrationPassesPreApplyLints({
        filename: '1040-new-view-drop.sql',
        sqlText: 'DROP VIEW harness_shared.engineer_issues;',
        sqlDir: sqlDir(),
      }),
    ).toThrow(/unguarded view drop/);
  });
});
