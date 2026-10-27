import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const migration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1166-report-library.sql', import.meta.url));
const publicDefaultMigration = fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/1580-report-library-workspace-default.sql', import.meta.url));
const publicDefaultSql = () => readFileSync(existsSync(publicDefaultMigration) ? publicDefaultMigration : `${publicDefaultMigration}.DRAFT`, 'utf8');

describe('Reports migrated schema (P-001)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(migration, 'utf8')).simple();
    await db.adminSql.unsafe(publicDefaultSql()).simple();
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

  it('defaults raw inserts to workspace-public and honors an explicit private audience', async () => {
    const workspace = `reports-default-${randomUUID()}`;
    const id = `rpt_${randomUUID()}`;
    const [row] = await db.adminSql`
      INSERT INTO harness_shared.report_library (workspace_id, report_id, title, lineage_id)
      VALUES (${workspace}, ${id}, 'Public by default', ${id}) RETURNING visibility`;
    expect(row.visibility).toBe('workspace');
    const privateId = `rpt_${randomUUID()}`;
    const [privateRow] = await db.adminSql`
      INSERT INTO harness_shared.report_library (workspace_id, report_id, title, lineage_id, visibility)
      VALUES (${workspace}, ${privateId}, 'Explicit private report', ${privateId}, 'owner') RETURNING visibility`;
    expect(privateRow.visibility).toBe('owner');
  });

  it('publicizes existing editions including retired reports, preserves content and skips other workspaces and future privacy', async () => {
    const ids = Array.from({ length: 5 }, () => `rpt_${randomUUID()}`);
    for (let i = 0; i < ids.length; i++) {
      await db.adminSql`
        INSERT INTO harness_shared.report_library
          (workspace_id, report_id, title, lineage_id, body_md, author_owner_id, visibility, retired_at, published_at)
        VALUES (${i === 3 ? 'another-workspace' : 'papercusp-workspace'}, ${ids[i]}, 'Preserved title', ${ids[i]},
          'Preserved body', 'original-author', ${i === 1 ? 'pot' : 'owner'},
          ${i === 2 ? '2026-10-25T00:00:00Z' : null}::timestamptz,
          ${i === 4 ? '2026-10-26T04:14:00Z' : '2026-10-25T00:00:00Z'}::timestamptz)`;
    }
    await db.adminSql.unsafe(publicDefaultSql()).simple();
    await db.adminSql.unsafe(publicDefaultSql()).simple();
    const rows = await db.adminSql`
      SELECT report_id, title, body_md, author_owner_id, visibility, retired_at
      FROM harness_shared.report_library WHERE report_id IN ${db.adminSql(ids)}`;
    for (const [i, id] of ids.entries()) {
      const row = rows.find(r => r.report_id === id)!;
      expect(row).toMatchObject({ title: 'Preserved title', body_md: 'Preserved body', author_owner_id: 'original-author',
        visibility: i < 3 ? 'workspace' : 'owner' });
      expect(row.retired_at !== null).toBe(i === 2);
    }
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
