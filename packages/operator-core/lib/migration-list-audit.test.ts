/**
 * EI-18808675015292160 — the fixture migration-list auditor.
 *
 * Pure tests (no Docker, no PG): every case below is a real shape taken from
 * libs/papercusp/libs/db/sql, because the two narrowings this auditor makes were
 * each forced by a specific migration that broke the naive rule.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripCommentsOnly } from '../../../scripts/lib/strip-comments-and-strings.mjs';
import {
  auditMigrationList,
  COORD_SUBSCRIPTION_SUBSTRATE,
  EVENT_SUBSTRATE_MIGRATIONS,
  EVENT_SUBSTRATE_RUNTIME_TABLES,
  formatStaleMigrationList,
  mergeMigrationLists,
  migrationNumber,
  objectsTouchedBySql,
  readAllMigrations,
  stripSqlComments,
  tablesCreatedBySql,
  tablesTouchedBySql,
} from '../test/_pg-helpers';

describe('tablesTouchedBySql', () => {
  it('picks up CREATE TABLE and ALTER TABLE, with or without IF [NOT] EXISTS', () => {
    expect(tablesTouchedBySql('CREATE TABLE harness_shared.agent_facts (id int);')).toEqual(
      new Set(['harness_shared.agent_facts']),
    );
    expect(tablesTouchedBySql('CREATE TABLE IF NOT EXISTS harness_shared.a (id int);')).toEqual(
      new Set(['harness_shared.a']),
    );
    expect(tablesTouchedBySql('ALTER TABLE IF EXISTS harness_shared.b ADD COLUMN c text;')).toEqual(
      new Set(['harness_shared.b']),
    );
  });

  it('ignores a table named only in a comment — the naive "scan for the name" rule', () => {
    const sql = `
      -- this migration relates to harness_shared.agent_facts but does not touch it
      /* nor does harness_shared.carry_notes appear outside prose */
      CREATE TABLE harness_shared.something_else (id int);
    `;
    expect(tablesTouchedBySql(sql)).toEqual(new Set(['harness_shared.something_else']));
  });

  it('ignores a passing reference that is not a CREATE/ALTER TABLE — the 214 trap', () => {
    // 214 attaches triggers to tables a partial fixture does not have. Matching
    // mere mentions pulled it in, and applying it failed wholesale.
    const sql = `CREATE TRIGGER t BEFORE INSERT ON harness_shared.harness_plans
                 FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();`;
    expect(tablesTouchedBySql(sql)).toEqual(new Set());
  });

  it('SEES a CREATE TABLE that follows a `--` sitting inside a STRING LITERAL', () => {
    /*
     * MASK CONTRACT (EI-20073035509369492) — a falsifying control, not coverage padding.
     * The private `--[^\n]*` mask stripSqlComments used until 2026-08-10 was not quote-aware:
     * that `--` is inside a string literal, so it blanked the rest of the line and this table
     * vanished from the result. A table the audit cannot SEE is a gap it cannot THROW on, so
     * the defect was a silent false negative in a gap-detecting audit. Fails on any mask that
     * is not quote-aware.
     */
    const sql = `INSERT INTO t(note) VALUES ('see -- below'); CREATE TABLE harness_shared.hidden_one (id text);`;
    expect(tablesTouchedBySql(sql)).toEqual(new Set(['harness_shared.hidden_one']));
  });

  it('SEES a CREATE TABLE issued inside a dollar-quoted body', () => {
    // Fails under stripSqlCommentsAndStrings, which seals `$tag$` bodies wholesale.
    const sql = `DO $$ BEGIN\n  CREATE TABLE harness_shared.in_body (id text);\nEND $$;`;
    expect(tablesTouchedBySql(sql)).toEqual(new Set(['harness_shared.in_body']));
  });

  it('ignores a CREATE TABLE commented out INSIDE a dollar-quoted body', () => {
    // Fails under a mask that SKIPS `$tag$` bodies instead of recursing into them.
    const sql = `DO $$ BEGIN\n  -- CREATE TABLE harness_shared.not_real (id text);\n  PERFORM 1;\nEND $$;`;
    expect(tablesTouchedBySql(sql)).toEqual(new Set());
  });
});

describe('tablesCreatedBySql', () => {
  it('distinguishes the creating migration from a later ALTER', () => {
    expect(
      tablesCreatedBySql(`
        CREATE TABLE IF NOT EXISTS harness_shared.event_key_fires (event_key text);
        ALTER TABLE harness_shared.event_key_fires ADD COLUMN fire_count bigint;
      `),
    ).toEqual(new Set(['harness_shared.event_key_fires']));
  });
});

describe('objectsTouchedBySql', () => {
  it('tracks function replacements and trigger creation without treating table references as declarations', () => {
    const sql = `
      CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p text)
      RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE TRIGGER wir_status_sync_dependents_trg AFTER UPDATE ON harness_shared.work_items
      FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();
    `;
    expect(objectsTouchedBySql(sql)).toEqual(
      new Set([
        'function:harness_shared.work_item_is_blocked',
        'trigger:wir_status_sync_dependents_trg',
      ]),
    );
  });
});

describe('stripSqlComments / migrationNumber', () => {
  it('strips both comment forms', () => {
    expect(stripSqlComments('a -- b\nc /* d */ e').replace(/\s+/g, ' ').trim()).toBe('a c e');
  });
  it('reads the leading migration number, and refuses a non-numbered file', () => {
    expect(migrationNumber('689-agent-facts-append-versioning.sql')).toBe(689);
    expect(migrationNumber('000-baseline.sql')).toBe(0);
    expect(migrationNumber('no-number.sql')).toBeNull();
  });
});

/** The real shape: a fixture builds agent_facts from an old list. */
const MIGRATIONS: [string, string][] = [
  ['444-agent-facts.sql', 'CREATE TABLE harness_shared.agent_facts (key text);'],
  ['505-agent-facts-surrogate-pk.sql', 'ALTER TABLE harness_shared.agent_facts ADD COLUMN id bigserial;'],
  ['488-federated-rls-backstop.sql',
    `ALTER TABLE harness_shared.agent_facts ENABLE ROW LEVEL SECURITY;
     ALTER TABLE harness_shared.bee_claim_specs ENABLE ROW LEVEL SECURITY;`],
  ['498-agent-facts-replica-identity.sql', 'ALTER TABLE harness_shared.agent_facts REPLICA IDENTITY FULL;'],
  ['689-agent-facts-append-versioning.sql', 'ALTER TABLE harness_shared.agent_facts ADD COLUMN superseded_at timestamptz;'],
  ['610-push-delivery.sql', 'CREATE TABLE harness_shared.push_delivery (id int);'],
  ['650-push-delivery-extra.sql', 'ALTER TABLE harness_shared.push_delivery ADD COLUMN extra text;'],
];

describe('auditMigrationList', () => {
  it('catches the exact rot that cost 9 red tests: a list stopping before later columns', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const files = audit.missing.map((m) => m.file);
    expect(files).toContain('505-agent-facts-surrogate-pk.sql');
    expect(files).toContain('689-agent-facts-append-versioning.sql');
    expect(audit.tables).toEqual(['harness_shared.agent_facts']);
  });

  it('does NOT demand a WIDE migration a partial fixture could never apply', () => {
    // 488 touches agent_facts AND bee_claim_specs. A fixture that only builds
    // agent_facts cannot apply it, so requiring it would be an unfixable error.
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('488-federated-rls-backstop.sql');
    expect(audit.wider.map((m) => m.file)).toContain('488-federated-rls-backstop.sql');
  });

  it('is silent when the list is complete', () => {
    const audit = auditMigrationList(
      [
        '444-agent-facts.sql',
        '498-agent-facts-replica-identity.sql',
        '505-agent-facts-surrogate-pk.sql',
        '689-agent-facts-append-versioning.sql',
      ],
      MIGRATIONS,
    );
    expect(audit.missing).toEqual([]);
  });

  it('ignores migrations for tables the fixture does not build', () => {
    const audit = auditMigrationList(['444-agent-facts.sql', '689-agent-facts-append-versioning.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('610-push-delivery.sql');
  });

  it('does not flag OLDER omissions — deliberately skipping an earlier migration is a choice, not rot', () => {
    // 498 is older than the newest declared (689) and omitted on purpose.
    const audit = auditMigrationList(['444-agent-facts.sql', '689-agent-facts-append-versioning.sql'], MIGRATIONS);
    expect(audit.missing.map((m) => m.file)).not.toContain('498-agent-facts-replica-identity.sql');
  });

  it('uses a PER-TABLE watermark, so a gap cannot hide behind a newer unrelated migration', () => {
    // The list carries 689 (agent_facts) and 610 (push_delivery). 650 alters
    // push_delivery. A single GLOBAL "newest declared" watermark would be 689
    // and would silently skip 650 — the exact silent rot this exists to stop.
    const audit = auditMigrationList(
      ['444-agent-facts.sql', '689-agent-facts-append-versioning.sql', '610-push-delivery.sql'],
      MIGRATIONS,
    );
    expect(audit.missing.map((m) => m.file)).toContain('650-push-delivery-extra.sql');
    expect(audit.missing.find((m) => m.file === '650-push-delivery-extra.sql')?.tables).toEqual([
      'harness_shared.push_delivery',
    ]);
  });

  it('catches a later function/trigger-only migration such as 640', () => {
    const migrations: [string, string][] = [
      [
        '379-maintained-ready-column.sql',
        `CREATE TABLE harness_shared.work_items (id text);
         CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p text)
         RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
         CREATE TRIGGER wir_status_sync_dependents_trg AFTER UPDATE ON harness_shared.work_items
         FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();`,
      ],
      [
        '640-unify-workitem-readiness-triggers.sql',
        `CREATE OR REPLACE FUNCTION harness_shared.work_item_is_blocked(p text)
         RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
         CREATE TRIGGER wir_status_sync_dependents_trg AFTER UPDATE ON harness_shared.work_items
         FOR EACH ROW EXECUTE FUNCTION harness_shared.wir_status_sync_dependents();`,
      ],
    ];
    const audit = auditMigrationList(['379-maintained-ready-column.sql'], migrations);
    expect(audit.missing).toEqual([
      {
        file: '640-unify-workitem-readiness-triggers.sql',
        tables: [],
        objects: [
          'function:harness_shared.work_item_is_blocked',
          'trigger:wir_status_sync_dependents_trg',
        ],
      },
    ]);
  });

  it('catches a runtime-used table when its creating migration is absent from the list', () => {
    const migrations: [string, string][] = [
      [
        '632-event-key-fire-latch.sql',
        'CREATE TABLE harness_shared.event_key_fires (event_key text);',
      ],
      [
        '700-unrelated.sql',
        'CREATE TABLE harness_shared.unrelated (id int);',
      ],
    ];
    const audit = auditMigrationList([], migrations, ['harness_shared.event_key_fires']);
    expect(audit.runtimeMissing).toEqual([
      { table: 'harness_shared.event_key_fires', migration: '632-event-key-fire-latch.sql' },
    ]);
  });

  it('accepts a runtime-used table when its creating migration is declared', () => {
    const audit = auditMigrationList(
      ['632-event-key-fire-latch.sql'],
      [['632-event-key-fire-latch.sql', 'CREATE TABLE harness_shared.event_key_fires (event_key text);']],
      ['harness_shared.event_key_fires'],
    );
    expect(audit.runtimeMissing).toEqual([]);
  });

  it('catches a later runtime-table ALTER even when the migration is wider', () => {
    const migrations: [string, string][] = [
      [
        '163-await-event-subscriptions.sql',
        'CREATE TABLE harness_shared.event_awaits (event_key text);',
      ],
      [
        '541-predicate-watches.sql',
        'CREATE TABLE harness_shared.predicate_watches (id text);',
      ],
      [
        '871-lifecycle-bound-watches.sql',
        `ALTER TABLE harness_shared.event_awaits ADD COLUMN bound_to text;
         ALTER TABLE harness_shared.predicate_watches ADD COLUMN condition_key text;`,
      ],
    ];
    const audit = auditMigrationList(
      ['163-await-event-subscriptions.sql'],
      migrations,
      ['harness_shared.event_awaits'],
    );

    expect(audit.wider.map((m) => m.file)).toContain('871-lifecycle-bound-watches.sql');
    expect(audit.runtimeStale).toEqual([
      {
        table: 'harness_shared.event_awaits',
        migration: '871-lifecycle-bound-watches.sql',
      },
    ]);
  });

  // WI-10004700. The runtime check used to measure from the per-table watermark,
  // so declaring a NEWER migration on a runtime table hid every older gap beneath
  // it. Observed: a fixture with event_awaits' 1216 but not 953 passed the audit,
  // and every key-fire latch write then failed on the missing superseded_at.
  it('catches a runtime-table gap BELOW a newer declared migration on that table', () => {
    const migrations: [string, string][] = [
      ['163-await-event-subscriptions.sql', 'CREATE TABLE harness_shared.event_awaits (event_key text);'],
      ['953-event-announcement-logical-gate.sql', 'ALTER TABLE harness_shared.event_awaits ADD COLUMN superseded_at timestamptz;'],
      ['1216-fired-delivery-intent.sql', 'ALTER TABLE harness_shared.event_awaits ADD COLUMN fired_delivery_intent_at timestamptz;'],
    ];
    const runtime = ['harness_shared.event_awaits'];

    const gapped = auditMigrationList(
      ['163-await-event-subscriptions.sql', '1216-fired-delivery-intent.sql'],
      migrations,
      runtime,
    );
    expect(gapped.runtimeStale).toEqual([
      { table: 'harness_shared.event_awaits', migration: '953-event-announcement-logical-gate.sql' },
    ]);
    // The plain `missing` check keeps its watermark semantics: below the newest
    // declared migration, an omission on a NON-runtime table is a deliberate choice.
    expect(auditMigrationList(
      ['163-await-event-subscriptions.sql', '1216-fired-delivery-intent.sql'],
      migrations,
    ).missing).toEqual([]);

    const complete = auditMigrationList(migrations.map(([file]) => file), migrations, runtime);
    expect(complete.runtimeStale).toEqual([]);
    expect(complete.runtimeMissing).toEqual([]);
  });

  it('reports missing files in numeric order', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const nums = audit.missing.map((m) => migrationNumber(m.file));
    expect(nums).toEqual([...nums].sort((a, b) => (a ?? 0) - (b ?? 0)));
  });
});

// WI-10004700. The shared event-substrate list is audited against the REAL sql/
// directory here, so a new migration on an event table fails this fast unit test
// by name instead of silently breaking emits in every fixture that uses the list.
describe('EVENT_SUBSTRATE_MIGRATIONS', () => {
  it('covers every structural migration on the event runtime tables since creation', () => {
    const all = readAllMigrations();
    const files = new Set(all.map(([file]) => file));
    for (const file of EVENT_SUBSTRATE_MIGRATIONS) expect(files.has(file), file).toBe(true);

    const audit = auditMigrationList([...EVENT_SUBSTRATE_MIGRATIONS], all, EVENT_SUBSTRATE_RUNTIME_TABLES);
    expect(formatStaleMigrationList(audit, 'EVENT_SUBSTRATE_MIGRATIONS')).not.toContain('  ! ');
    expect(audit.runtimeMissing).toEqual([]);
    expect(audit.runtimeStale).toEqual([]);
    expect(audit.missing).toEqual([]);
  });

  it('is already in apply order', () => {
    expect(mergeMigrationLists(EVENT_SUBSTRATE_MIGRATIONS)).toEqual([...EVENT_SUBSTRATE_MIGRATIONS]);
  });
});

// WI-10004742. The coordination-subscription preset is audited the same way, with
// the event substrate it is always applied on top of: a new migration widening
// coord_entity_subscriptions fails here by name instead of in three fixtures.
describe('COORD_SUBSCRIPTION_SUBSTRATE', () => {
  it('covers every structural migration on its runtime table, with only acknowledged gaps', () => {
    const all = readAllMigrations();
    const files = new Set(all.map(([file]) => file));
    const declared = mergeMigrationLists(EVENT_SUBSTRATE_MIGRATIONS, COORD_SUBSCRIPTION_SUBSTRATE.extra);
    for (const file of declared) expect(files.has(file), file).toBe(true);
    for (const { file } of COORD_SUBSCRIPTION_SUBSTRATE.knownInapplicable) expect(files.has(file), file).toBe(true);

    const audit = auditMigrationList(declared, all, [
      ...EVENT_SUBSTRATE_RUNTIME_TABLES,
      ...COORD_SUBSCRIPTION_SUBSTRATE.runtimeTables,
    ]);
    const acknowledged = new Set(COORD_SUBSCRIPTION_SUBSTRATE.knownInapplicable.map((k) => k.file));
    expect(audit.runtimeMissing).toEqual([]);
    expect(audit.runtimeStale.filter((m) => !acknowledged.has(m.migration))).toEqual([]);
    expect(audit.missing.filter((m) => !acknowledged.has(m.file))).toEqual([]);
  });

  it('acknowledges only migrations the audit actually reports, so a stale waiver cannot accumulate', () => {
    const declared = mergeMigrationLists(EVENT_SUBSTRATE_MIGRATIONS, COORD_SUBSCRIPTION_SUBSTRATE.extra);
    const audit = auditMigrationList(declared, readAllMigrations(), [
      ...EVENT_SUBSTRATE_RUNTIME_TABLES,
      ...COORD_SUBSCRIPTION_SUBSTRATE.runtimeTables,
    ]);
    const reported = new Set([...audit.missing.map((m) => m.file), ...audit.runtimeStale.map((m) => m.migration)]);
    for (const { file } of COORD_SUBSCRIPTION_SUBSTRATE.knownInapplicable) expect(reported.has(file), file).toBe(true);
  });
});

// WI-10004700 step 4 — the list above is only one list if fixtures USE it. A fixture
// that names an event-substrate migration itself is hand-rolling a prefix of the
// list, which is exactly how nine fixtures fell behind on 953 and 1216 with every
// emit failing silently. New fixtures must call applyEventSubstrateMigrationsForTest.
const OPERATOR_CORE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVENT_MIGRATION_STEMS = EVENT_SUBSTRATE_MIGRATIONS.map((f) => f.replace(/\.sql$/, ''));

/**
 * Pre-existing holdouts, SHRINK-ONLY: an entry must still match (the last case
 * fails otherwise), so converting a file forces its removal here. Never add one
 * for a new fixture; call applyEventSubstrateMigrationsForTest instead.
 */
const HAND_APPLIED_EVENT_MIGRATION_HOLDOUTS: Readonly<Record<string, string>> = {
  'lib/agent-tools/coordination/presence-reaper.integration.test.ts':
    'applies 871 by file path (with a .DRAFT fallback) on top of the baseline coord fixture',
  'lib/events/await/predicate-watch.integration.test.ts':
    'applies 871 by file path (with a .DRAFT fallback) on top of createOrgTestDb',
  'lib/pot/soak-report.integration.test.ts': 'applies 163 + 387 only; reads event_wake_deliveries alone',
  'lib/verification-attempts/attempt-ledger.integration.test.ts': 'applies 632 only, for event_key_fires',
};

/** Files that are fixtures (paths relative to operator-core): tests, test/ helpers, *-rig.ts. */
function isFixtureSource(rel: string): boolean {
  // The extension check also drops directories, which a recursive readdir lists too.
  if (!/\.m?ts$/.test(rel)) return false;
  return /\.test\.m?ts$/.test(rel) || rel.startsWith('test/') || /-rig\.ts$/.test(rel);
}

/** PURE — the event-substrate migration stems a fixture source names in code. */
function handAppliedEventMigrations(src: string): string[] {
  // A migration named only in prose is not an apply; the shared stripper keeps string contents.
  const code = stripCommentsOnly(src, 'fixture.ts');
  return EVENT_MIGRATION_STEMS.filter((stem) => code.includes(stem));
}

function scanFixtureSources(): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const root of ['lib', 'test']) {
    for (const entry of readdirSync(join(OPERATOR_CORE, root), { recursive: true }) as string[]) {
      const rel = `${root}/${entry.split('\\').join('/')}`;
      if (rel.includes('/node_modules/') || !isFixtureSource(rel)) continue;
      // The canonical list and this file (its auditor cases are fixtures) are the two legitimate homes.
      if (rel === 'test/_pg-helpers.ts' || rel === 'lib/migration-list-audit.test.ts') continue;
      const stems = handAppliedEventMigrations(readFileSync(join(OPERATOR_CORE, rel), 'utf8'));
      if (stems.length) hits.set(rel, stems);
    }
  }
  return hits;
}

describe('no fixture hand-applies an event-substrate migration (WI-10004700)', () => {
  it('detects a hand-applied stem in code but not in a comment', () => {
    const stem = '1216-event-await-fired-delivery-intent-marker';
    expect(handAppliedEventMigrations(`await sql.unsafe(readMigration('${stem}.sql'));`)).toEqual([stem]);
    expect(handAppliedEventMigrations(`for (const m of ['${stem}.sql']) await apply(m);`)).toEqual([stem]);
    expect(handAppliedEventMigrations(`// fell behind on ${stem}.sql\nawait applyEventSubstrateMigrationsForTest(sql);`)).toEqual([]);
    expect(handAppliedEventMigrations(`/* ${stem}.sql */ const url = 'http://x';`)).toEqual([]);
  });

  it('classifies tests, test helpers and rigs as fixtures, and production code as not', () => {
    expect(isFixtureSource('lib/scheduler/get-next.integration.test.ts')).toBe(true);
    expect(isFixtureSource('test/_work-items-schema.ts')).toBe(true);
    expect(isFixtureSource('lib/shared-pot-loop/composition-rig.ts')).toBe(true);
    expect(isFixtureSource('lib/pg-read-query.ts')).toBe(false);
    expect(isFixtureSource('test/fixtures')).toBe(false);
  });

  const hits = scanFixtureSources();

  it('every other fixture applies the substrate through applyEventSubstrateMigrationsForTest', () => {
    const offenders = [...hits]
      .filter(([rel]) => !(rel in HAND_APPLIED_EVENT_MIGRATION_HOLDOUTS))
      .map(([rel, stems]) => `${rel}: ${stems.join(', ')}`);
    expect(
      offenders,
      'These fixtures name event-substrate migrations directly. Replace the hand-rolled list with ' +
        'applyEventSubstrateMigrationsForTest(sql, { extra: [...] }) from test/_pg-helpers.ts.',
    ).toEqual([]);
  });

  it('the holdout list is shrink-only: every entry still hand-applies', () => {
    const stale = Object.keys(HAND_APPLIED_EVENT_MIGRATION_HOLDOUTS).filter((rel) => !hits.has(rel));
    expect(stale, 'Converted or deleted: remove these from HAND_APPLIED_EVENT_MIGRATION_HOLDOUTS').toEqual([]);
  });
});

describe('mergeMigrationLists', () => {
  it('merges extras into numeric order and drops duplicates', () => {
    expect(mergeMigrationLists(
      ['163-a.sql', '1216-b.sql'],
      ['123-c.sql', '602-d.sql', '163-a.sql'],
    )).toEqual(['123-c.sql', '163-a.sql', '602-d.sql', '1216-b.sql']);
  });
});

describe('formatStaleMigrationList', () => {
  it('names the FILE and the TABLE — the thing the column-level error never did', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const msg = formatStaleMigrationList(audit, 'dead-end-matcher-io');
    expect(msg).toContain('dead-end-matcher-io');
    expect(msg).toContain('STALE');
    expect(msg).toContain('689-agent-facts-append-versioning.sql');
    expect(msg).toContain('harness_shared.agent_facts');
    // the wide one appears as advisory context, clearly not as the fix
    expect(msg).toContain('488-federated-rls-backstop.sql');
    expect(msg).toContain('FYI only');
  });

  it('names the creating migration for a runtime-used table missing from the list', () => {
    const audit = auditMigrationList(
      [],
      [['632-event-key-fire-latch.sql', 'CREATE TABLE harness_shared.event_key_fires (event_key text);']],
      ['harness_shared.event_key_fires'],
    );
    const msg = formatStaleMigrationList(audit, 'runtime-fixture');
    expect(msg).toContain('harness_shared.event_key_fires');
    expect(msg).toContain('632-event-key-fire-latch.sql');
    expect(msg).toContain('Runtime-used tables');
  });

  it('names a later runtime-table migration even when it is wider', () => {
    const audit = auditMigrationList(
      ['163-await-event-subscriptions.sql'],
      [
        [
          '163-await-event-subscriptions.sql',
          'CREATE TABLE harness_shared.event_awaits (event_key text);',
        ],
        [
          '871-lifecycle-bound-watches.sql',
          `ALTER TABLE harness_shared.event_awaits ADD COLUMN bound_to text;
           ALTER TABLE harness_shared.predicate_watches ADD COLUMN condition_key text;`,
        ],
      ],
      ['harness_shared.event_awaits'],
    );
    const msg = formatStaleMigrationList(audit, 'runtime-fixture');
    expect(msg).toContain('871-lifecycle-bound-watches.sql');
    expect(msg).toContain('extends runtime-used table');
  });

  // WI-1413193. The remedy used to say ONLY "add them (in numeric order) to fix
  // this". For a migration the fixture structurally CANNOT apply, following that
  // literally does not fix anything — it satisfies the audit, which then stops
  // short-circuiting, and the run fails again underneath with a Postgres DDL
  // error that names a view or a column and never mentions the migration list.
  // That is what happened to work-items-terminal-attribution-preserve: 721's
  // CREATE OR REPLACE VIEW re-declared the canonical fixture's views at their
  // older, narrower select list ("cannot drop columns from view"), so all 7 of
  // its assertions were collected and never run. `knownInapplicable` was already
  // the designed escape and was already documented on applyMigrationsForTest —
  // it was simply absent from the message a failing agent actually reads.
  it('points at knownInapplicable — a stale-list remedy that only ever says "add it" is wrong for a migration the fixture cannot apply', () => {
    const audit = auditMigrationList(['444-agent-facts.sql'], MIGRATIONS);
    const msg = formatStaleMigrationList(audit, 'dead-end-matcher-io');

    // the escape hatch is NAMED, so it is discoverable from the failure alone
    expect(msg).toContain('knownInapplicable');
    // ...with the shape needed to actually use it, not just the noun
    expect(msg).toContain('reason');
    // ...and the symptom that should send you there, in the words Postgres uses
    expect(msg).toContain('cannot drop columns from');
    // the two wrong turns are called out explicitly
    expect(msg).toContain('audit:false');
    // and the non-obvious ordering fact that makes the second failure surprising
    expect(msg).toContain('BEFORE applying anything');
  });
});

describe('the REAL migration directory', () => {
  it('audits a real fixture list against the real sql/ dir without throwing', async () => {
    // Guards the parsing against the actual corpus (565 files): a regex that
    // blew up or matched nothing would surface here, not in a fixture months on.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../libs/papercusp/libs/db/sql',
    );
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')] as [string, string]);
    expect(all.length).toBeGreaterThan(100);

    const audit = auditMigrationList(['444-agent-facts.sql'], all);
    // The real corpus must yield a non-empty table set and find real later work.
    expect(audit.tables).toContain('harness_shared.agent_facts');
    expect(audit.missing.length + audit.wider.length).toBeGreaterThan(0);
  });
});
