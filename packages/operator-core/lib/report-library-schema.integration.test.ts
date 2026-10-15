import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const migration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1166-report-library.sql', import.meta.url));

describe('Reports migrated schema (P-001)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(migration, 'utf8')).simple();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('SPEC-P-001-subject-ref-required: rejects unanchored raw rows and accepts a named subject', async () => {
    const workspace = `reports-schema-${randomUUID()}`;
    for (const ref of [null, '', '  ']) {
      const id = `rpt_${randomUUID()}`;
      await expect(db.adminSql`
        INSERT INTO harness_shared.report_library
          (workspace_id, report_id, title, lineage_id, subject_kind, subject_ref)
        VALUES (${workspace}, ${id}, 'Schema control', ${id}, 'plan', ${ref})
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'report_library_subject_ref_present' });
    }
    const id = `rpt_${randomUUID()}`;
    await db.adminSql`
      INSERT INTO harness_shared.report_library
        (workspace_id, report_id, title, lineage_id, subject_kind, subject_ref)
      VALUES (${workspace}, ${id}, 'Named subject', ${id}, 'plan', 'reports-library-2026-09-15')
    `;
    const rows = await db.adminSql`SELECT report_id FROM harness_shared.report_library WHERE workspace_id = ${workspace}`;
    expect(rows.map(row => row.report_id)).toEqual([id]);
  });

  it('SPEC-P-001-visibility-domain: rejects an unknown raw visibility and accepts each declared audience', async () => {
    const workspace = `reports-schema-${randomUUID()}`;
    const badId = `rpt_${randomUUID()}`;
    await expect(db.adminSql`
      INSERT INTO harness_shared.report_library
        (workspace_id, report_id, title, lineage_id, visibility)
      VALUES (${workspace}, ${badId}, 'Invalid audience', ${badId}, 'xyzzy')
    `).rejects.toMatchObject({ code: '23514', constraint_name: 'report_library_visibility_allowed' });
    for (const visibility of ['owner', 'pot', 'workspace']) {
      const id = `rpt_${randomUUID()}`;
      await db.adminSql`
        INSERT INTO harness_shared.report_library
          (workspace_id, report_id, title, lineage_id, visibility)
        VALUES (${workspace}, ${id}, 'Declared audience', ${id}, ${visibility})
      `;
    }
    const rows = await db.adminSql`SELECT visibility FROM harness_shared.report_library WHERE workspace_id = ${workspace} ORDER BY visibility`;
    expect(rows.map(row => row.visibility)).toEqual(['owner', 'pot', 'workspace']);
  });
});
