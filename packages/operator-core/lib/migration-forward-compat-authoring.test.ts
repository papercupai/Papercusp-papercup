/**
 * Authoring-time forward-compat guard — EI-19462877357083817 rung 2.
 *
 * `lint:migration-forward-compat` is a correct detector that speaks LAST: it runs
 * inside green-checkpoint, hours after the author wrote the file and after
 * `db:migrate` already applied the destructive DDL to the live DB. The
 * PostToolUse nudge moves the same rule to the moment of the edit.
 *
 * Two properties are pinned here, both of which have already failed in the wild:
 *
 *  1. THE RUBBER-STAMP HAZARD. `ACK_MARKER` matches ANY non-whitespace after the
 *     colon, so a seeded placeholder (`-- FORWARD-COMPAT: TODO`) SATISFIES it.
 *     The original proposal suggested seeding exactly such a placeholder into new
 *     migrations, which would have silenced the guard permanently and invisibly.
 *     next-migration.mjs's reminder is therefore asserted against the REAL marker.
 *
 *  2. NO RULE DRIFT. The nudge must apply the lint's own exported rule, never a
 *     copy. `check-migration-forward-compat.mjs`'s SQL_DIR_REL comment already
 *     records why: two copies that silently disagree leave the run green while it
 *     no longer checks anything.
 *
 * Every block carries a CALIBRATION case (a known-positive) so the suite cannot
 * pass while asserting nothing — the same non-vacuity discipline the detector
 * applies to itself in its own selfTest().
 */
import { describe, expect, it } from 'vitest';

import {
  addedColumnsFor,
  alteredTablesFor,
  alterTargetsFor,
  ACK_MARKER,
  ENFORCE_FROM,
  findDraftColumnReferences,
  isDraftMigrationFile,
  isEnforcedMigrationFile,
  isMigrationArtifactFile,
  readScannedFiles,
  selectDdlEnforcedArtifacts,
  SOURCE_ROOTS,
  violationsFor,
} from '../../../scripts/check-migration-forward-compat.mjs';
import { buildAllocationResult } from '../../../scripts/next-migration.mjs';
import {
  effectiveMigrationName,
  isCandidateFile,
  nudgeFor,
} from '../../../apps/operator/scripts/hooks/cc/posttooluse-migration-forward-compat-nudge.mjs';

const DROP = 'DROP INDEX IF EXISTS harness_shared.memory_canonical_current;';
const REAL_ACK = '-- FORWARD-COMPAT: non-unique btree, cannot be an ON CONFLICT arbiter';

/** Feed the hook a synthetic file without touching the shared tree. */
function hookDeps(text: string) {
  return {
    exists: () => true,
    sizeOf: () => text.length,
    readFile: () => text,
    // The hook resolves the repo root by locating the detector; short-circuit to
    // the REAL module so these cases exercise the production rule, not a stub.
    loadDetector: async () => ({ ACK_MARKER, violationsFor, isEnforcedMigrationFile }),
  };
}

const P = `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM + 60}-drop-something.sql`;

describe('ACK_MARKER is permissive by design — which is exactly why placeholders are dangerous', () => {
  it('accepts a real, reasoned acknowledgment (calibration: the marker works at all)', () => {
    expect(ACK_MARKER.test(REAL_ACK)).toBe(true);
  });

  // The whole reason next-migration.mjs must not seed an ack line.
  it.each([
    ['-- FORWARD-COMPAT: TODO'],
    ['-- FORWARD-COMPAT: <why the currently-deployed release does not use this>'],
    ['   --   FORWARD-COMPAT: xxx'],
  ])('a placeholder ack SATISFIES the marker and would silence the guard: %s', (placeholder) => {
    expect(ACK_MARKER.test(placeholder)).toBe(true);
  });

  it('rejects an empty acknowledgment (a reason is mandatory)', () => {
    expect(ACK_MARKER.test('-- FORWARD-COMPAT:')).toBe(false);
  });
});

describe("next-migration.mjs's reminder must never itself be a valid acknowledgment", () => {
  const result = buildAllocationResult({
    next: 999,
    filename: '999-example.sql',
    reservedBy: 'test',
    dryRun: false,
  });

  it('emits the reminder', () => {
    expect(result.forward_compat).toContain('FORWARD-COMPAT');
    expect(result.forward_compat).toContain('lint:migration-forward-compat');
  });

  // THE REGRESSION THIS FILE EXISTS FOR. If someone later reformats this string
  // so the token starts a line, every future migration is silently rubber-stamped.
  it('does NOT satisfy ACK_MARKER, so copying it can never rubber-stamp a migration', () => {
    expect(ACK_MARKER.test(result.forward_compat)).toBe(false);
  });

  it('stays non-matching even when embedded in a migration body next to real DDL', () => {
    const body = `-- ${result.forward_compat}\n${DROP}`;
    expect(ACK_MARKER.test(body)).toBe(false);
    expect(violationsFor(body).map((r) => r.id)).toContain('drop-index');
  });
});

describe('the nudge fires on exactly what the gate would red on', () => {
  it('fires on unacknowledged destructive DDL, naming the rule', async () => {
    const msg = await nudgeFor(P, hookDeps(DROP));
    expect(msg).toBeTruthy();
    expect(msg).toContain('[drop-index]');
    expect(msg).toContain('-- FORWARD-COMPAT:');
  });

  it('goes silent once a real acknowledgment is added', async () => {
    expect(await nudgeFor(P, hookDeps(`${REAL_ACK}\n${DROP}`))).toBeNull();
  });

  it('stays silent on non-destructive DDL', async () => {
    expect(await nudgeFor(P, hookDeps('CREATE INDEX foo ON harness_shared.x (id);'))).toBeNull();
  });

  it('stays silent on historical migrations, which are immutable and unfixable', async () => {
    const historical = `/repo/libs/papercusp/libs/db/sql/${ENFORCE_FROM - 1}-old.sql`;
    expect(await nudgeFor(historical, hookDeps(DROP))).toBeNull();
  });

  it('fails OPEN when the detector cannot be resolved — a hook bug must never disturb an edit', async () => {
    const msg = await nudgeFor(P, { ...hookDeps(DROP), loadDetector: async () => null });
    expect(msg).toBeNull();
  });
});

describe('the nudge covers the DRAFT window, which IS the authoring window', () => {
  // scripts/next-migration.mjs tells authors to write + iterate at `<NNN>-<slug>.sql.DRAFT`;
  // the runner only applies `*.sql`. A nudge matching only `.sql` would miss the
  // entire period in which acting on it is cheap.
  it.each([['.DRAFT'], ['.PENDING-CODE-DEPLOY']])('treats a %s file as the migration it will become', (suffix) => {
    expect(isCandidateFile(`libs/papercusp/libs/db/sql/750-x.sql${suffix}`)).toBe(true);
    expect(effectiveMigrationName(`/a/b/750-x.sql${suffix}`)).toBe('750-x.sql');
  });

  it('fires on a .DRAFT carrying unacknowledged destructive DDL', async () => {
    const msg = await nudgeFor(`${P}.DRAFT`, hookDeps(DROP));
    expect(msg).toBeTruthy();
    expect(msg).toContain('[drop-index]');
  });

  it('ignores archived and non-migration paths', () => {
    expect(isCandidateFile('libs/papercusp/libs/db/sql/archive/001-x.sql')).toBe(false);
    expect(isCandidateFile('apps/operator/lib/foo.ts')).toBe(false);
    expect(isCandidateFile('libs/papercusp/libs/db/sql/README.md')).toBe(false);
  });
});

describe('the BLOCKING destructive-DDL scan stops at armed SQL (WI-6554700010008502)', () => {
  // A committed 1451-*.sql.DRAFT with a narrowing unique index failed
  // papercup-staging-sync and pinned :3170 on a stale build. The draft is never
  // applied; the nudge above covers it, and arming makes it an armed .sql that
  // this scan then enforces.
  const n = (k: number) => ENFORCE_FROM + k;

  it('excludes a .sql.DRAFT, keeps armed and .PENDING-CODE-DEPLOY artifacts, in number order', () => {
    const selected = selectDdlEnforcedArtifacts([
      `${n(30)}-later-armed.sql`,
      `${n(10)}-draft.sql.DRAFT`,
      `${n(20)}-parked.sql.PENDING-CODE-DEPLOY`,
      `${n(5)}-armed.sql`,
    ]);
    expect(selected).toEqual([
      { file: `${n(5)}-armed.sql`, num: n(5) },
      { file: `${n(20)}-parked.sql.PENDING-CODE-DEPLOY`, num: n(20) },
      { file: `${n(30)}-later-armed.sql`, num: n(30) },
    ]);
  });

  it('still enforces the same migration once it is armed', () => {
    const draft = `${n(10)}-x.sql.DRAFT`;
    expect(selectDdlEnforcedArtifacts([draft])).toEqual([]);
    expect(selectDdlEnforcedArtifacts([draft.replace('.DRAFT', '')])).toEqual([{ file: `${n(10)}-x.sql`, num: n(10) }]);
    // The draft stays visible to the dependency check, which reads parked artifacts.
    expect(isDraftMigrationFile(draft)).toBe(true);
  });

  it('keeps the historical cutoff for every artifact kind', () => {
    expect(
      selectDdlEnforcedArtifacts([`${ENFORCE_FROM - 1}-old.sql`, `${ENFORCE_FROM - 1}-old.sql.PENDING-CODE-DEPLOY`]),
    ).toEqual([]);
  });
});

describe('the parked-migration dependency guard (EI-20208711931756460)', () => {
  const DRAFT = `${ENFORCE_FROM + 107}-adv-sessions-ended-by-signal.sql.DRAFT`;

  it('skips a parked migration removed between readdir and read, but not an armed migration', () => {
    const missingAfterStat = () => {
      const error = new Error('simulated concurrent reservation rename');
      Object.assign(error, { code: 'ENOENT' });
      throw error;
    };
    const stat = () => undefined;

    expect(
      readScannedFiles('/repo/libs/papercusp/libs/db/sql', [DRAFT], {
        allowMissing: isDraftMigrationFile,
        stat,
        readFile: missingAfterStat,
      }),
    ).toEqual([]);

    expect(() =>
      readScannedFiles('/repo/libs/papercusp/libs/db/sql', [DRAFT.replace('.DRAFT', '')], {
        allowMissing: isDraftMigrationFile,
        stat,
        readFile: missingAfterStat,
      }),
    ).toThrow('simulated concurrent reservation rename');
  });

  it('recognizes armed and parked migration artifacts, but not historical drafts', () => {
    expect(isMigrationArtifactFile(DRAFT)).toBe(true);
    expect(isMigrationArtifactFile(DRAFT.replace('.DRAFT', ''))).toBe(true);
    expect(isDraftMigrationFile(DRAFT)).toBe(true);
    expect(isDraftMigrationFile(`${ENFORCE_FROM - 1}-old.sql.DRAFT`)).toBe(false);
  });

  it('extracts ADD COLUMN identifiers while ignoring migration comments', () => {
    const sql = `
      -- ADD COLUMN IF NOT EXISTS commented_out text;
      ALTER TABLE harness_shared.adv_sessions
        ADD COLUMN IF NOT EXISTS ended_signal text;
      ALTER TABLE harness_shared.adv_sessions ADD COLUMN "quoted_signal" text;
    `;
    expect(addedColumnsFor(sql)).toEqual(['ended_signal', 'quoted_signal']);
  });

  it('finds source consumers and ignores comments in source files', () => {
    const sql = 'ALTER TABLE harness_shared.adv_sessions ADD COLUMN IF NOT EXISTS ended_signal text;';
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/operator-core/lib/adv-sessions.ts',
        text: 'const query = sql`SELECT ended_signal FROM adv_sessions`;\n',
      },
      {
        file: 'packages/operator-core/lib/comment-only.ts',
        text: '// ended_signal is discussed, but never read\nconst value = 1;\n',
      },
      {
        file: 'packages/operator-core/lib/sql-comment-only.sql',
        text: '-- ended_signal is discussed, but never read\nSELECT 1;\n',
      },
    ]);

    expect(result.columns).toEqual(['ended_signal']);
    expect(result.references).toEqual([
      {
        column: 'ended_signal',
        file: 'packages/operator-core/lib/adv-sessions.ts',
        line: 1,
      },
    ]);
  });

  it('ignores SQL projection aliases and their result fields without requiring the projected column', () => {
    const sql = 'ALTER TABLE harness_shared.fc_alias_sessions ADD COLUMN fc_alias_probe text;';
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/operator-core/lib/operation-binding.ts',
        text: [
          'type Row = { fc_alias_probe: string | null };',
          "const query = sql`SELECT s.launch_spec->>'harnessSlug' AS fc_alias_probe FROM harness_shared.fc_alias_sessions s`;",
          'const harness = row.fc_alias_probe;',
        ].join('\n'),
      },
      {
        file: 'packages/operator-core/lib/operation-binding.test.ts',
        text: "const table = 'harness_shared.fc_alias_sessions'; const row = { fc_alias_probe: 'harness-a' };",
      },
    ]);
    expect(result.references).toEqual([]);
  });

  it('still detects a real column read when the same file also projects an alias with that name', () => {
    const sql = 'ALTER TABLE harness_shared.fc_alias_sessions ADD COLUMN fc_alias_probe text;';
    const result = findDraftColumnReferences(sql, [{
      file: 'packages/operator-core/lib/operation-binding.ts',
      text: [
        'type Row = { fc_alias_probe: string | null };',
        "const alias = sql`SELECT s.launch_spec->>'harnessSlug' AS fc_alias_probe FROM fc_alias_sessions s`;",
        'const real = sql`SELECT s.fc_alias_probe FROM fc_alias_sessions s`;',
      ].join('\n'),
    }]);
    expect(result.references).toEqual([{
      column: 'fc_alias_probe', file: 'packages/operator-core/lib/operation-binding.ts', line: 3,
    }]);
  });

  it('extracts the altered table without its schema qualifier', () => {
    expect(
      alteredTablesFor('ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;'),
    ).toEqual(['fc_probe_backends']);
    expect(alteredTablesFor('ALTER TABLE IF EXISTS ONLY "fc_probe_sessions" ADD COLUMN x text;')).toEqual([
      'fc_probe_sessions',
    ]);
  });

  it('qualifies a draft column against its own ALTER target, not another altered table', () => {
    const sql = [
      'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;',
      'ALTER TABLE fc_probe_memory ADD COLUMN fc_probe_count integer;',
    ].join('\n');
    expect(findDraftColumnReferences(sql, [{
      file: 'store.ts',
      text: 'const query = sql`SELECT fc_probe_outcome FROM fc_probe_memory`;',
    }]).references).toEqual([]);
    expect(findDraftColumnReferences(sql, [{
      file: 'store.ts',
      text: 'const query = sql`SELECT fc_probe_outcome FROM fc_probe_sessions`;',
    }]).references).toEqual([{ column: 'fc_probe_outcome', file: 'store.ts', line: 1 }]);
  });

  it('does not combine unrelated queries, prose, or TypeScript fields with a table elsewhere in a file', () => {
    const sql = 'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;';
    const text = [
      'const query = sql`SELECT id FROM fc_probe_sessions`;',
      'const other = sql`SELECT fc_probe_outcome FROM fc_other_sessions`;',
      'const description = "The fc_probe_outcome is recorded separately.";',
      'interface Row { readonly fc_probe_outcome?: string }',
      'const fc_probe_outcome = measure();',
      'const value = row.fc_probe_outcome;',
    ].join('\n');
    expect(findDraftColumnReferences(sql, [{ file: 'store.ts', text }]).references).toEqual([]);
  });

  it('excludes generated bundles while retaining a new production source consumer', () => {
    const sql = 'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;';
    const text = 'const query = sql`SELECT fc_probe_outcome FROM fc_probe_sessions`;';
    expect(findDraftColumnReferences(sql, [
      { file: 'apps/operator/dist-sidecar/worker.mjs', text },
      { file: 'apps/operator/dist-hosted-control-plane/serve.mjs', text },
      { file: 'apps/operator/storybook-static/worker.js', text },
      { file: 'apps/operator/lib/new-store.ts', text },
    ]).references).toEqual([{ column: 'fc_probe_outcome', file: 'apps/operator/lib/new-store.ts', line: 1 }]);
  });

  it('retains genuine reads in ordinary SQL strings and concatenated query arguments', () => {
    const sql = 'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;';
    for (const text of [
      "const query = 'SELECT fc_probe_outcome FROM fc_probe_sessions';",
      "await db.query('SELECT fc_probe_outcome ' + 'FROM fc_probe_sessions');",
      "const query = sql`SELECT ${sql`fc_probe_outcome`} FROM fc_probe_sessions`;",
    ]) {
      expect(findDraftColumnReferences(sql, [{ file: 'store.ts', text }]).references)
        .toEqual([{ column: 'fc_probe_outcome', file: 'store.ts', line: 1 }]);
    }
  });

  it('does not join independent SQL statements or unrelated schema objects', () => {
    const sql = 'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;';
    const sources = [
      { file: 'store.sql', text: 'SELECT id FROM fc_probe_sessions; SELECT fc_probe_outcome FROM fc_other_sessions;' },
      { file: 'schema.ts', text: [
        "const sessions = pgTable('fc_probe_sessions', { id: text() });",
        "const other = pgTable('fc_other_sessions', { fc_probe_outcome: text() }, () => [check('valid', sql`fc_probe_outcome IS NOT NULL`)]);",
      ].join('\n') },
      { file: 'manifest.ts', text: "const tables = [{table:'fc_probe_sessions', definition:'SELECT id FROM fc_probe_sessions'}, {table:'fc_other_sessions', definition:'SELECT fc_probe_outcome FROM fc_other_sessions'}];" },
    ];
    expect(findDraftColumnReferences(sql, sources).references).toEqual([]);
  });

  it('preserves a true schema definition and an unresolved interpolated SQL target', () => {
    const sql = 'ALTER TABLE fc_probe_sessions ADD COLUMN fc_probe_outcome text;';
    for (const text of [
      "const table = pgTable('fc_probe_sessions', { fc_probe_outcome: text() });",
      "const table = 'fc_probe_sessions'; const query = sql`SELECT fc_probe_outcome FROM ${sql(table)}`;",
    ]) {
      expect(findDraftColumnReferences(sql, [{ file: 'store.ts', text }]).references)
        .toEqual([{ column: 'fc_probe_outcome', file: 'store.ts', line: 1 }]);
    }
  });

  // ⚠ The two fixtures below deliberately use FICTIONAL identifiers (`fc_probe_backends`,
  // `fc_probe_mode`) rather than the real pair that motivated them. A test proving this detector
  // must contain the exact shape the detector hunts for, so real names here make the test file
  // itself a hit against any live draft that touches them — which is precisely what happened on
  // the first cut of this test. Comments are masked before matching, so naming the real case in
  // prose (migration 843, `harness_shared.local_backends.lifecycle`) costs nothing.

  it('does not flag a file that uses the column name but never names the table', () => {
    // Regression: migration 843 added a column named `lifecycle`, and the column-name-only scan
    // matched 357 unrelated files (plugin lifecycle, release lifecycle, work-item lifecycle),
    // red-pinning green-checkpoint. A flood that large does not get read as a guard — it gets
    // silenced with the ACK marker, which is how a REAL forward-compat break gets waved through.
    const sql = 'ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;';
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/plugin-loader/src/daemon/supervisor.ts',
        text: 'export type ProbeMode = "starting" | "ready";\nconst fc_probe_mode: ProbeMode = "ready";\n',
      },
    ]);

    expect(result.references).toEqual([]);
  });

  it('skips parser work for files that fail raw relevance before masking', () => {
    const sql = 'ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;';
    const parserStages: string[] = [];
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/plugin-loader/src/daemon/supervisor.ts',
        text: 'const lifecycle = "ready";\n',
      },
      {
        file: 'packages/operator-core/lib/unrelated.ts',
        text: 'const fc_probe_mode = "ready";\n',
      },
      {
        file: 'packages/operator-core/lib/relevant.ts',
        text: 'const query = sql`SELECT fc_probe_mode FROM harness_shared.fc_probe_backends`;\n',
      },
    ], {
      onParserWork: (stage, source) => parserStages.push(`${stage}:${source.file}`),
    });

    expect(result.references).toEqual([
      { column: 'fc_probe_mode', file: 'packages/operator-core/lib/relevant.ts', line: 1 },
    ]);
    expect(parserStages).toEqual([
      'comments:packages/operator-core/lib/relevant.ts',
      'dependency-units:packages/operator-core/lib/relevant.ts',
    ]);
  });

  it('still flags a real read of the new column on the altered table', () => {
    // The falsifiability half of the pair above: narrowing by table must not defang the scan.
    const sql = 'ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;';
    const result = findDraftColumnReferences(sql, [
      {
        file: 'packages/operator-core/lib/some-store.ts',
        text: 'const rows = await sql`SELECT id, fc_probe_mode FROM harness_shared.fc_probe_backends`;\n',
      },
    ]);

    expect(result.references).toEqual([
      {
        column: 'fc_probe_mode',
        file: 'packages/operator-core/lib/some-store.ts',
        line: 1,
      },
    ]);
  });

  it('falls back to the column-only scan when no ALTER TABLE target can be parsed', () => {
    // Fail-safe: an SQL shape the table regex does not understand must stay exactly as strict as
    // it was before table-qualification existed, never weaker.
    const result = findDraftColumnReferences('CREATE TABLE t (x int); ADD COLUMN IF NOT EXISTS ended_signal text;', [
      { file: 'packages/operator-core/lib/adv-sessions.ts', text: 'const v = ended_signal;\n' },
    ]);

    expect(result.references.map((r) => r.column)).toEqual(['ended_signal']);
  });

  it('never returns the SCHEMA as a table when the ALTER TABLE target is dynamic', () => {
    // EI-22144711421464181, measured on migration 1093. The schema-qualifier branch cannot match
    // `.%I` (`%` does not start an identifier), so the capture stopped at the schema and
    // `.split('.').pop()` handed back the literal token `harness_shared`. Nearly every source file
    // in this repo mentions that token, so ONE poisoned entry made the whole table filter vacuous
    // via `tableTokens.some(...)` — reinstating the 357-file flood the filter exists to prevent,
    // while still LOOKING qualified. That is worse than no filter, because it is not visible.
    const dynamic =
      "EXECUTE format('ALTER TABLE harness_shared.%I ADD COLUMN IF NOT EXISTS fc_probe_mode text', t);";

    expect(alteredTablesFor(dynamic)).toEqual([]);
    expect(alterTargetsFor(dynamic).unresolved).toHaveLength(1);
  });

  it('treats %s and an unqualified dynamic target as unresolved as well', () => {
    // The same hole reached through the other two spellings of the idiom.
    expect(alteredTablesFor("EXECUTE format('ALTER TABLE harness_shared.%s ADD COLUMN x int', t);")).toEqual([]);
    expect(alteredTablesFor("EXECUTE format('ALTER TABLE %I ADD COLUMN x int', t);")).toEqual([]);
  });

  it('CALIBRATION: a literal schema-qualified target still resolves to the bare table', () => {
    // Without this, every assertion above would pass just as well if `alteredTablesFor` had been
    // "fixed" by returning [] for everything — which would disable the filter outright.
    expect(alteredTablesFor('ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN x int;')).toEqual([
      'fc_probe_backends',
    ]);
    expect(alterTargetsFor('ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN x int;').unresolved).toEqual([]);
  });

  it('declines to qualify on a PARTIALLY resolved target set, and says so', () => {
    // The safety property behind the fix. A table list is sound as an EXCLUSION filter only when
    // COMPLETE: qualifying on the literal half here would silently exclude a file that reads the
    // DYNAMICALLY altered table — a false negative in a guard whose whole job is catching that
    // read. So a partial parse falls back to the column-only scan and reports the cause.
    const sql = [
      'ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;',
      "EXECUTE format('ALTER TABLE harness_shared.%I ADD COLUMN IF NOT EXISTS fc_probe_mode text', t);",
    ].join('\n');
    const result = findDraftColumnReferences(sql, [
      { file: 'packages/plugin-loader/src/daemon/supervisor.ts', text: 'const fc_probe_mode = "ready";\n' },
    ]);

    expect(result.unresolvedTargets).toHaveLength(1);
    expect(result.references.map((r) => r.file)).toEqual(['packages/plugin-loader/src/daemon/supervisor.ts']);
  });

  it('CALIBRATION: that same file IS excluded once every target resolves', () => {
    // The falsifier for the test above. Identical source file, identical column — only the
    // unresolvable statement is gone. If this did not exclude, the pair would merely be asserting
    // that the scan matches everything, and both halves would pass with the filter deleted.
    const result = findDraftColumnReferences(
      'ALTER TABLE harness_shared.fc_probe_backends ADD COLUMN IF NOT EXISTS fc_probe_mode text;',
      [{ file: 'packages/plugin-loader/src/daemon/supervisor.ts', text: 'const fc_probe_mode = "ready";\n' }],
    );

    expect(result.unresolvedTargets).toEqual([]);
    expect(result.references).toEqual([]);
  });

  it('keeps the source scan domain explicit and production-oriented', () => {
    expect(SOURCE_ROOTS).toEqual([
      'apps',
      'packages',
      'libs/papercusp/packages',
      'libs/papercusp/libs/db/src',
    ]);
  });
});

describe('no rule drift between the gate leg and the nudge', () => {
  // The nudge imports these rather than restating them; if that ever becomes a
  // copy, this is the test that notices.
  it('every rule the lint detects is reachable through the shared export', () => {
    const cases: Array<[string, string]> = [
      ['drop-index', 'DROP INDEX x;'],
      ['drop-constraint', 'ALTER TABLE t DROP CONSTRAINT c;'],
      ['drop-column', 'ALTER TABLE t DROP COLUMN c;'],
      ['drop-table', 'DROP TABLE t;'],
      ['rename', 'ALTER TABLE t RENAME TO u;'],
      ['set-not-null', 'ALTER TABLE t ALTER COLUMN c SET NOT NULL;'],
      ['narrowing-unique-index', 'CREATE UNIQUE INDEX i ON t (a) WHERE b IS NULL;'],
    ];
    for (const [id, sql] of cases) {
      expect(violationsFor(sql).map((r) => r.id), `rule ${id} should fire on: ${sql}`).toContain(id);
    }
  });

  it('ignores DDL keywords that appear only in prose (calibration: comments are stripped)', () => {
    expect(violationsFor('-- we used to DROP INDEX here, and DROP COLUMN too\nSELECT 1;')).toHaveLength(0);
  });

  it('applies the same ENFORCE_FROM cutoff the lint uses', () => {
    expect(isEnforcedMigrationFile(`${ENFORCE_FROM}-x.sql`)).toBe(true);
    expect(isEnforcedMigrationFile(`${ENFORCE_FROM - 1}-x.sql`)).toBe(false);
  });
});
