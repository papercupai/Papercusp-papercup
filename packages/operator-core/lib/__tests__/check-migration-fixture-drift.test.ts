/**
 * EI-19359711978838614 — the integration-test inline-schema-fixture drift
 * detector. See scripts/check-migration-fixture-drift.mjs's own header for the
 * full trap writeup; this file pins the parsing primitives + the precise,
 * low-noise trigger condition (a fixture that already names the table, missing
 * only the column the migration just introduced).
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its parsing primitives. Kept on ONE line: @ts-ignore suppresses only the line that follows it, so a multi-line import leaves the module specifier unguarded and TS7016 reds the build (and a multi-line @ts-expect-error additionally reds as an unused directive).
import { changedSqlFilesSince, columnNamesFromClauses, extractIntroducedColumns, findAlterTableAddColumns, findCreateTables, findDrift, findFixtureGaps, formatReport, splitTopLevelClauses } from '../../../../scripts/check-migration-fixture-drift.mjs';

describe('migration selection from a superproject comparison base', () => {
  const sqlRoot = 'libs/papercusp/libs/db/sql';
  function withMigrationRepository(check: (root: string, base: string, sqlDir: string) => void, nested = true) {
    const root = mkdtempSync(join(tmpdir(), 'migration-diff-'));
    const owner = nested ? join(root, 'libs/papercusp') : root;
    const sqlDir = join(root, sqlRoot);
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const init = (cwd: string) => {
      git(cwd, 'init', '-q');
      git(cwd, 'config', 'user.name', 'fixture');
      git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    };
    try {
      mkdirSync(sqlDir, { recursive: true });
      init(root);
      if (nested) init(owner);
      writeFileSync(join(sqlDir, '001.sql'), 'CREATE TABLE harness_shared.example (id bigint);\n');
      git(owner, 'add', '.');
      git(owner, 'commit', '-qm', 'initial schema');
      const ownerBase = git(owner, 'rev-parse', 'HEAD');
      if (nested) {
        git(root, 'update-index', '--add', '--cacheinfo', `160000,${ownerBase},libs/papercusp`);
        git(root, 'commit', '-qm', 'initial gitlink');
      }
      const base = git(root, 'rev-parse', 'HEAD');
      writeFileSync(join(sqlDir, '001.sql'), 'ALTER TABLE harness_shared.example ADD COLUMN value text;\n');
      git(owner, 'add', '.');
      git(owner, 'commit', '-qm', 'changed migration');
      writeFileSync(join(sqlDir, '002.sql'), 'ALTER TABLE harness_shared.example ADD COLUMN other text;\n');
      check(root, base, sqlDir);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('selects committed nested SQL and a new untracked migration against the recorded gitlink', () => {
    withMigrationRepository((root, base) => {
      expect(changedSqlFilesSince(base, { root })).toEqual([`${sqlRoot}/001.sql`, `${sqlRoot}/002.sql`]);
    });
  });

  it('expands an exact forwarded gitlink but does not widen an exact file scope', () => {
    withMigrationRepository((root, base) => {
      expect(changedSqlFilesSince(base, { root, files: ['libs/papercusp'] })).toHaveLength(2);
      expect(changedSqlFilesSince(base, { root, files: [`${sqlRoot}/002.sql`] })).toEqual([`${sqlRoot}/002.sql`]);
      expect(changedSqlFilesSince(base, { root, files: ['packages/unrelated.ts'] })).toEqual([]);
      expect(changedSqlFilesSince(base, { root, files: [] })).toEqual([]);
    });
  });

  it('preserves the expected unavailable-base result without treating it as a pathspec', () => {
    withMigrationRepository((root) => {
      expect(changedSqlFilesSince('missing-base', { root })).toEqual([]);
    });
  });

  it('retains ordinary repository SQL selection when the schema is not in a submodule', () => {
    withMigrationRepository((root, base) => {
      expect(changedSqlFilesSince(base, { root })).toEqual([`${sqlRoot}/001.sql`, `${sqlRoot}/002.sql`]);
    }, false);
  });
});

describe('findCreateTables', () => {
  it('extracts columns from a CREATE TABLE IF NOT EXISTS harness_shared.<table> block', () => {
    const sql = `
CREATE TABLE IF NOT EXISTS harness_shared.event_await_nodes (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     text NOT NULL DEFAULT 'default',
  root_id          bigint NOT NULL,
  parent_id        bigint REFERENCES harness_shared.event_await_nodes (id) ON DELETE CASCADE,
  PRIMARY KEY (id)
);`;
    const tables = findCreateTables(sql);
    expect(tables).toHaveLength(1);
    expect(tables[0].table).toBe('event_await_nodes');
    expect(tables[0].columns).toEqual(['id', 'workspace_id', 'root_id', 'parent_id']);
  });

  it('skips table-level constraint clauses (CONSTRAINT/UNIQUE/CHECK/FOREIGN KEY)', () => {
    const sql = `
CREATE TABLE harness_shared.foo (
  id bigint PRIMARY KEY,
  name text NOT NULL,
  CONSTRAINT foo_name_check CHECK (name <> ''),
  UNIQUE (name),
  FOREIGN KEY (id) REFERENCES harness_shared.bar (id)
);`;
    const [t] = findCreateTables(sql);
    expect(t.columns).toEqual(['id', 'name']);
  });

  it('is a no-op for a table in a different schema', () => {
    expect(findCreateTables('CREATE TABLE public.foo (id bigint);')).toEqual([]);
  });

  it('does not lose a column whose clause is preceded by multi-line `--` comments on their own lines (the store.integration.test.ts shape)', () => {
    // Regression for a real false-positive this detector produced against its
    // OWN motivating file: node_id's clause absorbed the 4 comment lines ahead
    // of it, so its leading identifier match failed and the column vanished.
    const sql = `
CREATE TABLE harness_shared.event_awaits (
  id bigint PRIMARY KEY,
  fired_by text, fired_payload jsonb,
  -- migration 572 (composable-event-awaits): composed-TREE leaf columns. A plain
  -- await leaves them NULL, but store.ts SELECTs root_id unconditionally
  -- (listParkedAwaitsForSubscribers), so omitting them here failed that query with
  -- a missing-column error -- fixture drift from the migration, not a prod bug.
  node_id bigint, root_id bigint, member_fired_at timestamptz, member_payload jsonb
);`;
    const [t] = findCreateTables(sql);
    expect(t.columns).toEqual([
      'id',
      'fired_by',
      'fired_payload',
      'node_id',
      'root_id',
      'member_fired_at',
      'member_payload',
    ]);
  });
});

describe('findAlterTableAddColumns', () => {
  it('extracts every column from a single multi-column ADD COLUMN statement', () => {
    const sql = `
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS node_id         bigint,
  ADD COLUMN IF NOT EXISTS root_id         bigint,
  ADD COLUMN IF NOT EXISTS member_fired_at timestamptz,
  ADD COLUMN IF NOT EXISTS member_payload  jsonb;
`;
    const [alter] = findAlterTableAddColumns(sql);
    expect(alter.table).toBe('event_awaits');
    expect(alter.columns).toEqual(['node_id', 'root_id', 'member_fired_at', 'member_payload']);
  });

  it('extracts a single-column ADD on its own line', () => {
    const sql = `ALTER TABLE harness_shared.memory_recall_stats\n  ADD COLUMN IF NOT EXISTS pools jsonb;`;
    const [alter] = findAlterTableAddColumns(sql);
    expect(alter).toEqual({ table: 'memory_recall_stats', columns: ['pools'] });
  });

  it('does not pick up a same-table statement that adds no column (e.g. DROP CONSTRAINT)', () => {
    const sql = `ALTER TABLE harness_shared.agent_facts\n  DROP CONSTRAINT IF EXISTS agent_facts_kind_check;`;
    expect(findAlterTableAddColumns(sql)).toEqual([]);
  });
});

describe('extractIntroducedColumns', () => {
  it('merges CREATE TABLE columns and ADD COLUMN columns for the same migration file', () => {
    const sql = `
CREATE TABLE IF NOT EXISTS harness_shared.foo (
  id bigint PRIMARY KEY,
  name text
);
ALTER TABLE harness_shared.bar
  ADD COLUMN IF NOT EXISTS extra text;
`;
    const introduced = extractIntroducedColumns(sql);
    expect(introduced).toEqual(
      expect.arrayContaining([
        { table: 'foo', column: 'id' },
        { table: 'foo', column: 'name' },
        { table: 'bar', column: 'extra' },
      ]),
    );
  });
});

describe('findFixtureGaps', () => {
  const migration = `
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS root_id bigint;
`;
  const migrationFile = 'libs/papercusp/libs/db/sql/757-memory-canonical-row-kind-discriminator.sql';

  it('flags a fixture that builds the table with other columns but not the new one', () => {
    const gaps = findFixtureGaps('event_awaits', 'root_id', {
      root: '/repo',
      files: ['packages/x/store.integration.test.ts'],
      readFile: () => `
        await sql\`CREATE TABLE harness_shared.event_awaits (
          id bigint PRIMARY KEY,
          subscriber_id text NOT NULL,
          fired_at timestamptz
        )\`;
      `,
    });
    expect(gaps).toEqual(['packages/x/store.integration.test.ts']);
  });

  it('is silent when applyMigrationsForTest explicitly lists the migration inline', () => {
    const gaps = findFixtureGaps('memory_canonical', 'row_kind', {
      root: '/repo',
      files: ['packages/x/memory-federation-privacy.integration.test.ts'],
      migrationFile,
      readFile: () => `
        await applyMigrationsForTest(db.sql, [
          '756-memory-canonical.sql',
          '757-memory-canonical-row-kind-discriminator.sql',
        ]);
        CREATE TABLE harness_shared.memory_canonical (
          id bigint,
          workspace_id text
        );
      `,
    });
    expect(gaps).toEqual([]);
  });

  it('is silent when applyMigrationsForTest receives a reusable migration list variable', () => {
    const gaps = findFixtureGaps('memory_canonical', 'row_kind', {
      root: '/repo',
      files: ['packages/x/memory-federation-privacy.integration.test.ts'],
      migrationFile,
      readFile: () => `
        const migrationList = [
          '756-memory-canonical.sql',
          '757-memory-canonical-row-kind-discriminator.sql',
        ];
        await applyMigrationsForTest(db.sql, migrationList);
        CREATE TABLE harness_shared.memory_canonical (
          id bigint,
          workspace_id text
        );
      `,
    });
    expect(gaps).toEqual([]);
  });

  it('still flags a fixture when its applyMigrationsForTest list omits the migration', () => {
    const gaps = findFixtureGaps('memory_canonical', 'row_kind', {
      root: '/repo',
      files: ['packages/x/memory-federation-privacy.integration.test.ts'],
      migrationFile,
      readFile: () => `
        await applyMigrationsForTest(db.sql, ['756-memory-canonical.sql']);
        CREATE TABLE harness_shared.memory_canonical (
          id bigint,
          workspace_id text
        );
      `,
    });
    expect(gaps).toEqual(['packages/x/memory-federation-privacy.integration.test.ts']);
  });

  it('is silent when the fixture already names the column', () => {
    const gaps = findFixtureGaps('event_awaits', 'root_id', {
      root: '/repo',
      files: ['packages/x/store.integration.test.ts'],
      readFile: () => `CREATE TABLE harness_shared.event_awaits (id bigint, root_id bigint)`,
    });
    expect(gaps).toEqual([]);
  });

  it('is silent for a fixture that never mentions the table at all (the common case)', () => {
    const gaps = findFixtureGaps('event_awaits', 'root_id', {
      root: '/repo',
      files: ['packages/x/unrelated.integration.test.ts'],
      readFile: () => `CREATE TABLE harness_shared.something_else (id bigint)`,
    });
    expect(gaps).toEqual([]);
  });

  it('is silent for a deliberately-minimal stub that already omitted unrelated columns', () => {
    // The hive-eval shape: a fixture that only ever names the columns its OWN
    // reads use. It never claimed to track the full schema, so it isn't drift —
    // it just also happens not to name this particular new column, same as it
    // never named several pre-existing ones either. The detector can't tell
    // "deliberately partial" from "used to be complete" by inspecting one
    // fixture alone; this case simply documents that a stub is unaffected
    // UNLESS the exact new column happens to be one it's missing (still true
    // here) — the noise-reduction comes from the migration-level trigger, not
    // from per-fixture intent detection.
    const gaps = findFixtureGaps('agent_facts', 'settled_by', {
      root: '/repo',
      files: ['packages/x/minimal-stub.integration.test.ts'],
      readFile: () => `CREATE TABLE harness_shared.agent_facts (id bigint, kind text)`,
    });
    expect(gaps).toEqual(['packages/x/minimal-stub.integration.test.ts']);
  });
});

describe('findDrift', () => {
  it('reports table+column+gapFiles for a migration that stales an existing fixture', () => {
    const migrationText = `
ALTER TABLE harness_shared.event_awaits
  ADD COLUMN IF NOT EXISTS root_id bigint;
`;
    const findings = findDrift(migrationText, {
      root: '/repo',
      files: ['packages/x/store.integration.test.ts'],
      readFile: () => `CREATE TABLE harness_shared.event_awaits (id bigint, subscriber_id text)`,
    });
    expect(findings).toEqual([
      { table: 'event_awaits', column: 'root_id', gapFiles: ['packages/x/store.integration.test.ts'] },
    ]);
  });

  it('is empty when no fixture builds the affected table', () => {
    const migrationText = `ALTER TABLE harness_shared.event_awaits ADD COLUMN IF NOT EXISTS root_id bigint;`;
    const findings = findDrift(migrationText, { root: '/repo', files: [], readFile: () => null });
    expect(findings).toEqual([]);
  });
});

describe('formatReport', () => {
  it('names the migration, table.column, and every stale fixture file', () => {
    const text = formatReport('libs/papercusp/libs/db/sql/572-x.sql', [
      { table: 'event_awaits', column: 'root_id', gapFiles: ['a.integration.test.ts', 'b.integration.test.ts'] },
    ]);
    expect(text).toContain('572-x.sql');
    expect(text).toContain('event_awaits.root_id');
    expect(text).toContain('a.integration.test.ts');
    expect(text).toContain('b.integration.test.ts');
  });

  it('reports a clean verdict when there are no findings', () => {
    expect(formatReport('libs/papercusp/libs/db/sql/572-x.sql', [])).toContain('no fixture drift found');
  });
});

describe('splitTopLevelClauses / columnNamesFromClauses', () => {
  it('does not split inside a nested paren (e.g. a numeric(10,2) type or a default expression)', () => {
    const clauses = splitTopLevelClauses('a numeric(10,2) DEFAULT 0, b text');
    expect(clauses).toHaveLength(2);
    expect(columnNamesFromClauses(clauses)).toEqual(['a', 'b']);
  });

  it('does not split on a comma inside a quoted string default', () => {
    const clauses = splitTopLevelClauses(`a text DEFAULT 'x,y', b text`);
    expect(clauses).toHaveLength(2);
    expect(columnNamesFromClauses(clauses)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Comment masking (WI-37717). These are POSITIVE CONTROLS: each one fails on the
// pre-masking code. The corpus-level check they back up ("does the real sql/ dir
// change?") cannot stand in for them — a no-diff run is equally consistent with
// "the fix works" and "nothing in the corpus exercises it".
// ---------------------------------------------------------------------------
describe('comment masking', () => {
  it('does not mint a phantom column from a COMMENTED-OUT ALTER TABLE', () => {
    // The shape found live in 563-memory-federation-capture-triggers.sql, where a
    // commented-out statement yielded 5 columns no migration ever introduced.
    const sql = `
-- ALTER TABLE harness_shared.memory_canonical
--   ADD COLUMN IF NOT EXISTS harness_slug text,
--   ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE harness_shared.memory_canonical
  ADD COLUMN IF NOT EXISTS real_column text;
`;
    expect(extractIntroducedColumns(sql)).toEqual([{ table: 'memory_canonical', column: 'real_column' }]);
  });

  it('still finds ADD COLUMNs that follow a SEMICOLON INSIDE an interior comment', () => {
    // The false-NEGATIVE direction, and the costlier one: a statement is terminated at
    // the first `;`, and ordinary English prose in a column comment supplies one. Live
    // instance: 299-scheduled-plans-schedule-fields.sql reported 7 of its 14 columns.
    const sql = `
ALTER TABLE harness_shared.harness_plans
  ADD COLUMN IF NOT EXISTS schedule jsonb,
  -- on expiry the schedule deactivates; the plan is NOT deleted.
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS tzid text;
`;
    expect(extractIntroducedColumns(sql)).toEqual([
      { table: 'harness_plans', column: 'schedule' },
      { table: 'harness_plans', column: 'expires_at' },
      { table: 'harness_plans', column: 'tzid' },
    ]);
  });

  it('does not read a COMMENTED-OUT fixture as a live one', () => {
    const gaps = findFixtureGaps('event_awaits', 'root_id', {
      root: '/repo',
      files: ['packages/x/store.integration.test.ts'],
      // The only CREATE TABLE here is commented out, so there is no live fixture to be
      // stale — reporting it would accuse an unrelated agent of drift they did not cause.
      readFile: () => `
        // await sql\`CREATE TABLE harness_shared.event_awaits (
        //   id bigint PRIMARY KEY,
        //   subscriber_id text NOT NULL
        // )\`;
      `,
    });
    expect(gaps).toEqual([]);
  });

  it('still sees a LIVE fixture inside a template literal (masking must not blank strings)', () => {
    // Tripwire: swapping stripCommentsOnly for stripCommentsAndStrings would blank the
    // SQL these fixtures live in and take the guard silently 100% inert.
    const gaps = findFixtureGaps('event_awaits', 'root_id', {
      root: '/repo',
      files: ['packages/x/store.integration.test.ts'],
      readFile: () => `
        // a preceding comment that must not disturb the scan
        await sql\`CREATE TABLE harness_shared.event_awaits (
          id bigint PRIMARY KEY,
          subscriber_id text NOT NULL
        )\`;
      `,
    });
    expect(gaps).toEqual(['packages/x/store.integration.test.ts']);
  });
});
