import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import {
  describeConflicts,
  findBackupLockConflicts,
  inspectBackupRendezvousForMigration,
  normalizeMigrationSql,
} from './backup-lock-migration-proof';

function fakeSql(options: { acquired: boolean; lockedRelations?: string[] }): { client: Sql; queries: string[] } {
  const queries: string[] = [];
  const respond = (query: string) => {
    queries.push(query);
    if (query.includes('pg_try_advisory_lock')) return Promise.resolve([{ acquired: options.acquired }]);
    if (query.includes('pg_advisory_unlock')) return Promise.resolve([{ released: true }]);
    if (query.includes('WITH RECURSIVE locked AS')) {
      return Promise.resolve((options.lockedRelations ?? []).map((name) => ({ name })));
    }
    throw new Error('unexpected SQL in fake postgres client');
  };
  const client = Object.assign(
    (strings: TemplateStringsArray) => respond(strings.join('')),
    {
      array: (values: unknown[]) => values,
      unsafe: (query: string) => respond(query),
    },
  ) as unknown as Sql;
  return { client, queries };
}

describe('inspectBackupRendezvousForMigration', () => {
  it('releases a successful probe lock and leaves the normal rendezvous path selected', async () => {
    const { client, queries } = fakeSql({ acquired: true });
    await expect(
      inspectBackupRendezvousForMigration(client, { file: '1438-safe.sql', sqlText: 'CREATE TABLE new_table (id int);' }),
    ).resolves.toEqual({ rendezvousBusy: false, conflicts: [] });
    expect(queries.some((query) => query.includes('pg_advisory_unlock'))).toBe(true);
    expect(queries.some((query) => query.includes('WITH RECURSIVE locked AS'))).toBe(false);
  });

  it('proves a busy rendezvous safe when the current backup locks only unrelated relations', async () => {
    const { client } = fakeSql({ acquired: false, lockedRelations: ['session_archive_files'] });
    await expect(
      inspectBackupRendezvousForMigration(client, {
        file: '1438-safe.sql',
        sqlText: 'ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;',
      }),
    ).resolves.toEqual({ rendezvousBusy: true, conflicts: [] });
  });

  it('keeps the blocking path for overlapping and unprovable migrations', async () => {
    const overlap = fakeSql({ acquired: false, lockedRelations: ['trigger_bindings'] });
    const overlapResult = await inspectBackupRendezvousForMigration(overlap.client, {
      file: '1438-overlap.sql',
      sqlText: 'ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;',
    });
    expect(overlapResult.rendezvousBusy).toBe(true);
    expect(overlapResult.conflicts).toEqual([
      { file: '1438-overlap.sql', subject: 'trigger_bindings', reason: 'names-locked-relation' },
    ]);

    const unprovable = fakeSql({ acquired: false });
    const unprovableResult = await inspectBackupRendezvousForMigration(unprovable.client, {
      file: '1438-dynamic.sql',
      sqlText: "DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD c int', t); END $$;",
    });
    expect(unprovableResult.rendezvousBusy).toBe(true);
    expect(unprovableResult.conflicts).toEqual([
      { file: '1438-dynamic.sql', subject: 'EXECUTE (dynamic SQL)', reason: 'unprovable-statement' },
    ]);
  });
});

// WI-10003357 — the relation-scoped proof that lets boot apply pending
// migrations while a backup still holds the migration rendezvous. A false
// "safe" here would let DDL collide with a running pg_dump, so every case
// that must WAIT is pinned explicitly.
describe('findBackupLockConflicts', () => {
  const pending = (sqlText: string) => [{ file: '1228-x.sql', sqlText }];

  it('proves migration 1583 safe beside unrelated backup locks and still detects its new tables', () => {
    const file = '1583-sql-intent-monitored-family-runs.sql';
    const sqlText = readFileSync(
      new URL('../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url),
      'utf8',
    );
    const migration = [{ file, sqlText }];

    expect(findBackupLockConflicts(migration, ['session_archive_files'])).toEqual([]);
    expect(findBackupLockConflicts(migration, ['sql_intent_runs'])).toEqual([
      { file, subject: 'sql_intent_runs', reason: 'names-locked-relation' },
    ]);
  });

  it('keeps an unexpected dynamic statement inside the RLS loop unprovable', () => {
    const file = '1583-sql-intent-monitored-family-runs.sql';
    const sqlText = readFileSync(
      new URL('../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url),
      'utf8',
    ).replace(
      "EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON harness_shared.%I TO harness_app',tab);",
      "EXECUTE format('ALTER TABLE harness_shared.%I ADD COLUMN extra text',tab);",
    );

    expect(findBackupLockConflicts([{ file, sqlText }], []).map((conflict) => conflict.subject))
      .toContain('EXECUTE (dynamic SQL)');
  });

  it('is safe when the migration names no locked relation (the 2026-09-26 incident shape)', () => {
    expect(
      findBackupLockConflicts(
        pending('ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;'),
        ['session_turns', 'session_events'],
      ),
    ).toEqual([]);
  });

  it('conflicts when the migration names a locked table, schema-qualified or quoted', () => {
    for (const sql of [
      'ALTER TABLE harness_shared.trigger_bindings ADD COLUMN note text;',
      'ALTER TABLE "harness_shared"."trigger_bindings" ADD COLUMN note text;',
      'ALTER TABLE Trigger_Bindings ADD COLUMN note text;',
    ]) {
      expect(findBackupLockConflicts(pending(sql), ['trigger_bindings'])).toEqual([
        { file: '1228-x.sql', subject: 'trigger_bindings', reason: 'names-locked-relation' },
      ]);
    }
  });

  it('matches whole identifiers only — a longer name sharing a prefix is not a conflict', () => {
    expect(
      findBackupLockConflicts(pending('CREATE TABLE harness_shared.session_turns_archive (id int);'), ['session_turns']),
    ).toEqual([]);
  });

  it('conflicts on a locked INDEX name (DROP INDEX locks its table without naming it)', () => {
    expect(
      findBackupLockConflicts(pending('DROP INDEX harness_shared.session_turns_owner_idx;'), [
        'session_turns',
        'session_turns_owner_idx',
      ]).map((c) => c.subject),
    ).toEqual(['session_turns_owner_idx']);
  });

  it('ignores a relation mentioned only in a comment', () => {
    expect(
      findBackupLockConflicts(
        pending('-- unlike session_turns, this is tiny\n/* session_turns */ CREATE TABLE a (id int);'),
        ['session_turns'],
      ),
    ).toEqual([]);
  });

  it.each([
    "'Prepared rows and cached receipts grant no authority; EXECUTE and VACUUM are prose.'",
    "'The backup''s rows are described here; DROP SCHEMA is prose.'",
    '$note$Prepared rows; EXECUTE and VACUUM are prose.$note$',
    '$$Prepared rows; DROP SCHEMA is prose.$$',
  ])('ignores table annotation prose while preserving its target: %s', (annotation) => {
    const sql = `CREATE TABLE harness_shared.cupboard_funded_turns (id int);
      COMMENT ON TABLE harness_shared.cupboard_funded_turns IS ${annotation};`;
    expect(findBackupLockConflicts(pending(sql), ['rows'])).toEqual([]);
    expect(findBackupLockConflicts(pending(sql), ['cupboard_funded_turns'])).toEqual([
      { file: '1228-x.sql', subject: 'cupboard_funded_turns', reason: 'names-locked-relation' },
    ]);
  });

  it('preserves a locked annotation target and executable SQL following an annotation', () => {
    const sql = `COMMENT ON TABLE "harness_shared"."rows" IS 'unrelated';
      COMMENT ON TABLE harness_shared.other IS 'rows; EXECUTE is prose';
      DO $$ BEGIN EXECUTE 'ALTER TABLE rows ADD c int'; END $$;`;
    expect(findBackupLockConflicts(pending(sql), ['rows'])).toEqual([
      { file: '1228-x.sql', subject: 'EXECUTE (dynamic SQL)', reason: 'unprovable-statement' },
      { file: '1228-x.sql', subject: 'rows', reason: 'names-locked-relation' },
    ]);
  });

  const ticketTriggers = (action = 'FUNCTION') =>
    ['data_sources', 'admission_rules', 'work_admissions'].map((table) => `
      CREATE OR REPLACE TRIGGER emit_change_notify_trg
        AFTER INSERT OR UPDATE OR DELETE ON harness_shared.${table}
        FOR EACH ROW EXECUTE ${action} harness_shared.emit_change_notify();
    `).join('\n');

  it.each(['FUNCTION', 'PROCEDURE'])('does not call a static CREATE TRIGGER EXECUTE %s action dynamic SQL', (action) => {
    expect(findBackupLockConflicts(pending(ticketTriggers(action)), ['session_turns', 'session_events'])).toEqual([]);
  });

  it.each(['UPDATE OF status', 'INSERT OR UPDATE OF status'])('proves a conditional %s trigger safe without hiding its locked target', (event) => {
    const sql = `CREATE TRIGGER work_item_blocked_names_blocker
      BEFORE ${event} ON harness_shared.work_items
      FOR EACH ROW WHEN (NEW.status = 'blocked')
      EXECUTE FUNCTION harness_shared.work_item_blocked_names_blocker();`;
    expect(findBackupLockConflicts(pending(sql), ['session_turns'])).toEqual([]);
    expect(findBackupLockConflicts(pending(sql), ['work_items'])).toEqual([
      { file: '1228-x.sql', subject: 'work_items', reason: 'names-locked-relation' },
    ]);
    expect(findBackupLockConflicts(pending(sql + 'EXECUTE prepared_change;'), []).map((c) => c.subject))
      .toContain('EXECUTE (dynamic SQL)');
  });

  it('proves migration 1546’s static NOT LIKE trigger predicate without hiding its target', () => {
    const sql = `CREATE OR REPLACE TRIGGER emit_event_await_change_notify_write_trg
      AFTER INSERT OR UPDATE ON harness_shared.event_awaits
      FOR EACH ROW WHEN (NEW.event_key NOT LIKE 'coord:inbox-wake:%')
      EXECUTE FUNCTION harness_shared.emit_event_await_change_notify();`;
    expect(findBackupLockConflicts(pending(sql), ['session_turns', 'tool_invocations'])).toEqual([]);
    expect(findBackupLockConflicts(pending(sql), ['event_awaits'])).toEqual([
      { file: '1228-x.sql', subject: 'event_awaits', reason: 'names-locked-relation' },
    ]);
  });

  it.each(['data_sources', 'admission_rules', 'work_admissions'])('still blocks a static trigger on backup-held %s', (table) => {
    expect(findBackupLockConflicts(pending(ticketTriggers()), [table])).toEqual([
      { file: '1228-x.sql', subject: table, reason: 'names-locked-relation' },
    ]);
  });

  it('does not exempt a prepared EXECUTE named function after a static trigger statement', () => {
    const sql = ticketTriggers() + 'EXECUTE "function"(1);';
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('still refuses dynamic SQL that constructs a trigger', () => {
    const sql = `DO $$ BEGIN EXECUTE 'CREATE TRIGGER t AFTER INSERT ON public.a EXECUTE FUNCTION public.f()'; END $$;`;
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('does not exempt a DO body containing a trigger declaration before another dynamic statement', () => {
    const sql = `DO $$ BEGIN ${ticketTriggers()} EXECUTE format('ALTER TABLE %I ADD c int', t); END $$;`;
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('keeps complex trigger expressions outside the narrow static-action proof', () => {
    const sql = 'CREATE TRIGGER t AFTER INSERT ON public.a WHEN (public.side_effect()) EXECUTE FUNCTION public.f();';
    expect(findBackupLockConflicts(pending(sql), []).map((c) => c.subject)).toContain('EXECUTE (dynamic SQL)');
  });

  it('refuses statements whose lock footprint the text cannot prove, even with nothing locked', () => {
    const cases: Array<[string, string]> = [
      ["DO $$ BEGIN EXECUTE format('ALTER TABLE %I ADD c int', t); END $$;", 'EXECUTE (dynamic SQL)'],
      ['GRANT SELECT ON ALL TABLES IN SCHEMA harness_shared TO r;', 'ALL TABLES IN SCHEMA'],
      ['DROP SCHEMA old_stuff;', 'DROP SCHEMA'],
      ['DROP TYPE foo CASCADE;', 'DROP … CASCADE'],
      ['TRUNCATE a CASCADE;', 'TRUNCATE … CASCADE'],
      ['ALTER DOMAIN d ADD CONSTRAINT c CHECK (VALUE > 0);', 'ALTER DOMAIN'],
      ['REINDEX SCHEMA harness_shared;', 'REINDEX SCHEMA/DATABASE/SYSTEM'],
      ['VACUUM FULL a;', 'VACUUM'],
    ];
    for (const [sql, label] of cases) {
      const conflicts = findBackupLockConflicts(pending(sql), []);
      expect(conflicts.map((c) => c.subject)).toContain(label);
      expect(conflicts.every((c) => c.reason === 'unprovable-statement')).toBe(true);
    }
  });

  it('does not treat ON DELETE CASCADE in a FK definition as unprovable', () => {
    expect(
      findBackupLockConflicts(
        pending('CREATE TABLE a (id int, b_id int REFERENCES b(id) ON DELETE CASCADE);'),
        ['session_turns'],
      ),
    ).toEqual([]);
  });

  it('reports every conflicting file so the boot log names them all', () => {
    const conflicts = findBackupLockConflicts(
      [
        { file: '1.sql', sqlText: 'ALTER TABLE t1 ADD c int;' },
        { file: '2.sql', sqlText: 'ALTER TABLE t2 ADD c int;' },
        { file: '3.sql', sqlText: 'CREATE TABLE t3 (c int);' },
      ],
      ['t1', 't2'],
    );
    expect(conflicts.map((c) => c.file)).toEqual(['1.sql', '2.sql']);
    expect(describeConflicts(conflicts)).toBe(
      '1.sql names backup-locked relation t1; 2.sql names backup-locked relation t2',
    );
  });
});

describe('normalizeMigrationSql', () => {
  it('lowercases, drops double quotes and blanks comments', () => {
    expect(normalizeMigrationSql('ALTER "T" -- c\n/* x */ADD')).toBe('alter t  \n add');
  });
});
