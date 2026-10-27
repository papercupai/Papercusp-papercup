import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql, TransactionSql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
const { registerDirectiveRecovery, directiveRecoveryClosureError } = await import('./owner-directive-recovery');
let db: OrgTestDb;
const WS = 'directive-recovery-test';
beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await h.sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
  await h.sql`DELETE FROM harness_shared.owner_directives WHERE workspace_id = ${WS}`;
});
async function directive() {
  const [row] = await h.sql<{ id: string }[]>`INSERT INTO harness_shared.owner_directives
    (workspace_id, owner_id, recorded_by, verbatim_text) VALUES (${WS}, 'owner', 'su-ended', 'Finish the requested work') RETURNING id`;
  return { id: Number(row.id), recordedBy: 'su-ended' };
}
async function recover(d: { id: number; recordedBy: string }) {
  return h.sql.begin((tx) => registerDirectiveRecovery(tx as TransactionSql, { workspaceId: WS, harness: 'papercusp', directive: d }));
}
describe('durable orphan-directive custody', () => {
  it('concurrent/replayed recovery creates one linked task and leaves the directive open', async () => {
    const d = await directive();
    const receipts = await Promise.all([recover(d), recover(d)]);
    expect(receipts.filter((r) => r?.created)).toHaveLength(1);
    expect(receipts[0]?.id).toBe(receipts[1]?.id);
    const rows = await h.sql`SELECT directive_ref, taken_by, status, payload FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].directive_ref)).toBe(d.id);
    expect(rows[0].status).toBe('open');
    const [open] = await h.sql`SELECT dispositioned_at FROM harness_shared.owner_directives WHERE id = ${d.id}`;
    expect(open.dispositioned_at).toBeNull();
    expect(await directiveRecoveryClosureError(rows[0].payload, WS)).toContain('still open');
  });
  it('keeps existing linked work and preserves a later holder/blocker', async () => {
    const d = await directive();
    const first = await recover(d);
    await h.sql`UPDATE harness_shared.work_items SET taken_by = 'su-new-holder', status = 'blocked',
      payload = payload || '{"externalBlockers":[{"status":"active"}]}'::jsonb
      WHERE workspace_id = ${WS} AND feature_id = ${first!.id}`;
    expect(await recover(d)).toEqual({ id: first!.id, created: false });
    const [row] = await h.sql`SELECT taken_by, status, payload FROM harness_shared.work_items WHERE workspace_id = ${WS}`;
    expect(row.taken_by).toBe('su-new-holder');
    expect(row.status).toBe('blocked');
    expect(row.payload.externalBlockers).toHaveLength(1);
  });
  it('a recovery worker dying and losing its lease leaves the same task available', async () => {
    const d = await directive();
    const first = await recover(d);
    await h.sql`UPDATE harness_shared.work_items SET taken_by = 'su-recovery-ended' WHERE workspace_id = ${WS} AND feature_id = ${first!.id}`;
    // Model the existing dead-owner reaper's release; this sweep must not mint a replacement.
    await h.sql`UPDATE harness_shared.work_items SET taken_by = NULL WHERE workspace_id = ${WS} AND feature_id = ${first!.id}`;
    expect(await recover(d)).toEqual({ id: first!.id, created: false });
  });
  it('does not register a directive that closed before its row lock, and allows closure only after disposition', async () => {
    const d = await directive();
    const payload = { ownerDirectiveRecovery: { directiveId: d.id } };
    expect(await directiveRecoveryClosureError(payload, WS)).toContain('orders:disposition');
    await h.sql`UPDATE harness_shared.owner_directives SET dispositioned_at = now(), disposition_status = 'done',
      disposition_note = 'Verified finished work' WHERE id = ${d.id}`;
    expect(await recover(d)).toBeNull();
    expect(await directiveRecoveryClosureError(payload, WS)).toBeNull();
    expect(await directiveRecoveryClosureError(payload, 'another-workspace')).toContain('Cannot verify');
    expect(await directiveRecoveryClosureError({}, WS)).toBeNull();
  });
});
