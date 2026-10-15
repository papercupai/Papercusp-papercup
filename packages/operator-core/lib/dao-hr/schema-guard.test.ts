/**
 * dao-hr schema guard (dao-hr-people-2026-10-11 SPEC-P-002-B, R-1): HR keeps no contact store
 * of its own, so a dao-hr migration that adds a contact column to any table other than the
 * shared person record must fail this guard. The real-tree case runs the guard over every
 * dao-hr migration in the repo and is the standing check; the fixture cases prove it bites.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DAO_HR_PERSON_RECORD_TABLE,
  findContactColumns,
  isContactColumnName,
  isDaoHrMigrationFile,
  listDaoHrMigrationFindings,
} from './schema-guard';

const SQL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/papercusp/libs/db/sql');

describe('dao-hr schema guard — the real migration tree', () => {
  it('finds no contact column in any dao-hr migration', () => {
    const { files, findings } = listDaoHrMigrationFindings(SQL_DIR);
    // Positive control: the walk reached the migration directory and saw the work-profile migration.
    expect(files.some((file) => file.startsWith('1456-dao-hr-work-profiles.sql'))).toBe(true);
    expect(findings).toEqual([]);
  });

  it('actually parses the real work-profile migration (a contact column appended to it is caught)', () => {
    const file = listDaoHrMigrationFindings(SQL_DIR).files.find((name) => name.startsWith('1456-dao-hr-work-profiles.sql'))!;
    const real = readFileSync(resolve(SQL_DIR, file), 'utf8');
    expect(findContactColumns(file, real)).toEqual([]);
    const mutated = real.replace(
      'title                 text        NOT NULL',
      'email                 text,\n  title                 text        NOT NULL',
    );
    expect(mutated).not.toBe(real);
    expect(findContactColumns(file, mutated)).toEqual([
      { file, table: 'harness_shared.dao_hr_work_profiles', column: 'email', statement: 'create-table' },
    ]);
  });
});

describe('dao-hr schema guard — required scenarios (SPEC-P-002-B)', () => {
  const scenarios: Array<{ scenario: string; column: string }> = [
    { scenario: 'email-column', column: 'email' },
    { scenario: 'name-column', column: 'full_name' },
    { scenario: 'phone-column', column: 'phone' },
  ];

  for (const { scenario, column } of scenarios) {
    it(`${scenario}: CREATE TABLE with a ${column} column on a non-person table fails`, () => {
      const sql = `CREATE TABLE IF NOT EXISTS harness_shared.dao_hr_offers (
        workspace_id text NOT NULL,
        ${column} text,
        PRIMARY KEY (workspace_id)
      );`;
      expect(findContactColumns('9999-dao-hr-offers.sql', sql)).toEqual([
        { file: '9999-dao-hr-offers.sql', table: 'harness_shared.dao_hr_offers', column, statement: 'create-table' },
      ]);
    });

    it(`${scenario}: ALTER TABLE … ADD COLUMN ${column} on a non-person table fails`, () => {
      const sql = `ALTER TABLE harness_shared.dao_hr_work_profiles ADD COLUMN IF NOT EXISTS ${column} text;`;
      expect(findContactColumns('9999-dao-hr-x.sql', sql)).toEqual([
        { file: '9999-dao-hr-x.sql', table: 'harness_shared.dao_hr_work_profiles', column, statement: 'add-column' },
      ]);
    });
  }

  it('the shared person record may carry contact columns', () => {
    const sql = `ALTER TABLE ${DAO_HR_PERSON_RECORD_TABLE} ADD COLUMN email text;
      ALTER TABLE harness_shared.work_items ADD COLUMN phone text;`;
    expect(findContactColumns('9999-dao-hr-x.sql', sql)).toEqual([]);
  });
});

describe('dao-hr schema guard — reading SQL faithfully', () => {
  it('reads every action of a multi-action ALTER TABLE', () => {
    const sql = `ALTER TABLE harness_shared.dao_hr_x ADD COLUMN team text, ADD email text, ADD CONSTRAINT c CHECK (true);`;
    expect(findContactColumns('f.sql', sql).map((f) => f.column)).toEqual(['email']);
  });

  it('reads DDL wrapped in a DO block', () => {
    const sql = `DO $$ BEGIN
      ALTER TABLE harness_shared.dao_hr_x ADD COLUMN mobile_number text;
    END $$;`;
    expect(findContactColumns('f.sql', sql).map((f) => f.column)).toEqual(['mobile_number']);
  });

  it('catches a rename to a contact column', () => {
    const sql = `ALTER TABLE harness_shared.dao_hr_x RENAME COLUMN label TO contact_email;`;
    expect(findContactColumns('f.sql', sql)).toEqual([
      { file: 'f.sql', table: 'harness_shared.dao_hr_x', column: 'contact_email', statement: 'rename-column' },
    ]);
  });

  it('ignores comments, string literals and table constraints', () => {
    const sql = `-- email text would be wrong here
      /* phone text */
      CREATE TABLE harness_shared.dao_hr_x (
        kind text CHECK (kind IN ('email', 'phone')),
        CONSTRAINT dao_hr_x_name_check CHECK (kind <> 'name'),
        UNIQUE (kind)
      );`;
    expect(findContactColumns('f.sql', sql)).toEqual([]);
  });

  it('treats quoted and unqualified table names consistently', () => {
    const sql = `CREATE TABLE "harness_shared"."dao_hr_x" ("Email" text);`;
    expect(findContactColumns('f.sql', sql)).toEqual([
      { file: 'f.sql', table: 'harness_shared.dao_hr_x', column: 'Email', statement: 'create-table' },
    ]);
    expect(findContactColumns('f.sql', 'CREATE TABLE dao_hr_y (email text);')[0]!.table).toBe('public.dao_hr_y');
  });
});

describe('isContactColumnName', () => {
  it.each(['name', 'full_name', 'legal_name', 'email', 'e_mail', 'work_email', 'phone', 'phone_number', 'mobile', 'contact', 'address', 'home_address', 'postal_address', 'street', 'zip'])(
    '%s is contact data',
    (column) => expect(isContactColumnName(column)).toBe(true),
  );

  it.each(['wallet_address', 'contract_address', 'ip_address', 'title', 'team', 'level', 'jurisdiction', 'person_id', 'dao_slug', 'engagement_type', 'member_github_user_id', 'e_signature'])(
    '%s is not contact data',
    (column) => expect(isContactColumnName(column)).toBe(false),
  );
});

describe('isDaoHrMigrationFile', () => {
  it('selects armed and draft dao-hr migrations only', () => {
    expect(isDaoHrMigrationFile('1456-dao-hr-work-profiles.sql')).toBe(true);
    expect(isDaoHrMigrationFile('1456-dao-hr-work-profiles.sql.DRAFT')).toBe(true);
    expect(isDaoHrMigrationFile('983-personal-vault-import-jobs.sql')).toBe(false);
    expect(isDaoHrMigrationFile('1456-dao-hr-work-profiles.md')).toBe(false);
  });
});
