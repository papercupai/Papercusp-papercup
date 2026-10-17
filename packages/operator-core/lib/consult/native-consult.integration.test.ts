/** Qualify the default boundary composition, not injected boundary readers.
 * Only the PG connection and maintained session-home root are isolated. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { codexHomeForSessionKey } from '@papercusp/orchestrator/session-launch-dirs';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { mockOrgPgSql } from '../testing/mock-org-pg';
import type { ResumeTarget } from '../agent-launch-core';
import { archiveSession, sha256Hex } from '../session-archive';
import { captureNativeConsultBoundary, type NativeConsultBoundary } from './native-consult';

vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: vi.fn(),
}));

describe('default native consult boundary composition', () => {
  const ws = 'default';
  let db: OrgTestDb;
  let root: string;

  beforeAll(async () => {
    db = await createOrgTestDb();
    mockOrgPgSql(vi.mocked(getOrgPg), db.adminSql);
    root = await mkdtemp(join(tmpdir(), 'native-boundary-pg-'));
    vi.stubEnv('PAPERCUSP_SU_CODEX_HOMES_DIR', root);
  }, 180_000);
  afterAll(async () => {
    try { await db?.cleanup(); }
    finally {
      vi.unstubAllEnvs();
      if (root) await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
  beforeEach(async () => {
    await db.adminSql`DELETE FROM harness_shared.plan_item_claims`;
    await db.adminSql`DELETE FROM harness_shared.work_items`;
    await db.adminSql`DELETE FROM harness_shared.adv_sessions`;
  });

  async function source(live = true) {
    const sessionId = randomUUID();
    const ownerId = `native-boundary-${sessionId}`;
    const endedAt = live ? null : new Date(Date.now() - 60_000).toISOString();
    const [row] = await db.adminSql<Array<{ id: number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, agent, cwd, coord_owner_id, session_id, ended_at)
      VALUES (${ws}, 'console', 'codex', '/repo', ${ownerId}, ${sessionId}, ${endedAt}) RETURNING id`;
    const target: ResumeTarget = { sessionId, ompThreadId: null, resumeId: sessionId,
      ownerId, agent: 'codex', role: null, feature: null, cwd: '/repo', model: null,
      modelSource: null, account: null, endedAt, endedBy: live ? null : 'self',
      live, advSessionId: row.id, binding: null,
      // The seeded row records the workspace; its launch argv names no harness.
      workspaceId: ws, harnessSlug: null };
    const home = codexHomeForSessionKey(row.id);
    const relpath = join('sessions', '2026', '10', '13', `rollout-date-${sessionId}.jsonl`);
    const path = join(home, relpath);
    const bytes = Buffer.from('{"type":"session_meta","payload":{"id":"' + sessionId + '"}}\n');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { target, home, path, relpath, bytes };
  }

  async function claim(owner: string, workspaceId = ws, itemId = 'P-009', harness = 'papercusp') {
    await db.adminSql`
      INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, liveness_mode,
         ttl_sec, acquired_ts, expires_ts, last_activity_ts)
      VALUES (${workspaceId}, ${harness}, 'plan-only', ${itemId}, ${owner}, 'activity', 1800,
        clock_timestamp(), clock_timestamp() + interval '30 minutes', clock_timestamp())`;
  }

  async function work(owner: string, workspaceId = ws, id = 'WI-native-held', status = 'open') {
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status,
         taken_by, created_ts, updated_ts, source_plan_slug, source_plan_item_ids)
      VALUES (${workspaceId}, 'papercusp', ${id}, 'native boundary fixture', '', 'task', ${status},
        ${owner}, ${Date.now()}, ${Date.now()}, 'work-plan', ARRAY['P-002'])`;
  }

  function measured(boundary: NativeConsultBoundary) {
    expect(boundary.status).toBe('measured');
    if (boundary.status !== 'measured') throw new Error(boundary.reason);
    return boundary;
  }

  it('reads the canonical live prefix and both claim populations without mutating PG or source bytes', async () => {
    const s = await source();
    await appendFile(s.path, '{"partial":');
    await claim(s.target.ownerId!);
    await claim(s.target.ownerId!, ws, 'P-008', 'another-harness');
    await claim('peer-owner', ws, 'P-007');
    await claim(s.target.ownerId!, 'foreign-workspace', 'P-006');
    await db.adminSql`UPDATE harness_shared.plan_item_claims SET expires_ts = clock_timestamp() - interval '1 second'
      WHERE workspace_id = ${ws} AND item_id = 'P-009'`;
    await work(s.target.ownerId!);
    await work(s.target.ownerId!, 'foreign-workspace', 'WI-native-foreign');
    await work('peer-owner', ws, 'WI-native-peer');
    await work(s.target.ownerId!, ws, 'WI-native-terminal', 'done');
    const beforeClaims = await db.adminSql`SELECT * FROM harness_shared.plan_item_claims ORDER BY workspace_id, harness_slug, item_id`;
    const beforeWork = await db.adminSql`SELECT * FROM harness_shared.work_items ORDER BY workspace_id, feature_id`;
    const beforeBytes = await readFile(s.path);
    const beforeStat = await stat(s.path);
    const boundary = measured(await captureNativeConsultBoundary(s.target, ws));
    expect(boundary.snapshot).toMatchObject({ kind: 'live-jsonl', completeBytes: s.bytes.length,
      highWaterBytes: beforeBytes.length, sha256: sha256Hex(s.bytes), archiveRelpath: null,
      fileIdentity: { path: s.path, device: beforeStat.dev, inode: beforeStat.ino } });
    expect(boundary.claims.checked).toEqual([{ id: 'WI-native-held', harness: 'papercusp', plan: 'work-plan', items: ['P-002'] }]);
    expect(boundary.planClaims.checked.map(c => [c.harnessSlug, c.itemId, c.expired]))
      .toEqual([['another-harness', 'P-008', false], ['papercusp', 'P-009', true]]);
    expect(boundary.planClaims.checked.every(c => c.owner === s.target.ownerId && c.workspaceId === ws)).toBe(true);
    expect(Date.parse(boundary.completedAt)).toBeGreaterThanOrEqual(Date.parse(boundary.capturedAt));
    expect(boundary.readScope).toContain('not an atomic snapshot');
    expect(boundary.planClaims.scope).toContain('does not exclude mutate-then-revert');
    expect(await readFile(s.path)).toEqual(beforeBytes);
    expect((await stat(s.path)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await db.adminSql`SELECT * FROM harness_shared.plan_item_claims ORDER BY workspace_id, harness_slug, item_id`).toEqual(beforeClaims);
    expect(await db.adminSql`SELECT * FROM harness_shared.work_items ORDER BY workspace_id, feature_id`).toEqual(beforeWork);
  });

  it('observes actual persisted lease and incarnation changes in subsequent endpoint reads', async () => {
    const s = await source();
    await claim(s.target.ownerId!);
    const before = measured(await captureNativeConsultBoundary(s.target, ws));
    await db.adminSql`UPDATE harness_shared.plan_item_claims SET expires_ts = expires_ts + interval '1 hour'
      WHERE workspace_id = ${ws} AND owner = ${s.target.ownerId}`;
    const renewed = measured(await captureNativeConsultBoundary(s.target, ws));
    expect(renewed.planClaims.checked[0].claimId).toBe(before.planClaims.checked[0].claimId);
    expect(Date.parse(renewed.planClaims.checked[0].expiresTs)).toBeGreaterThan(Date.parse(before.planClaims.checked[0].expiresTs));
    await db.adminSql`UPDATE harness_shared.plan_item_claims SET claim_id = gen_random_uuid()
      WHERE workspace_id = ${ws} AND owner = ${s.target.ownerId}`;
    const replaced = measured(await captureNativeConsultBoundary(s.target, ws));
    expect(replaced.planClaims.checked[0].claimId).not.toBe(renewed.planClaims.checked[0].claimId);
    expect(replaced.planClaims.checked[0].owner).toBe(before.planClaims.checked[0].owner);
    expect(replaced.planClaims.checked[0].itemId).toBe(before.planClaims.checked[0].itemId);
  });

  it('reads an ended native archive through the real PG store and refuses it as live-descriptor evidence', async () => {
    const s = await source(false);
    expect(await archiveSession({ sourceKind: 'codex', sessionId: s.target.sessionId!,
      sessionRoot: s.home, owner: s.target.ownerId, harnessSlug: 'papercusp', cwd: '/repo',
      advSessionId: s.target.advSessionId })).toMatchObject({ ok: true, fileCount: 1 });
    await rm(s.path);
    const boundary = measured(await captureNativeConsultBoundary(s.target, ws));
    expect(boundary.snapshot).toMatchObject({ kind: 'archive-manifest', sha256: sha256Hex(s.bytes),
      completeBytes: s.bytes.length, archiveRelpath: s.relpath, fileIdentity: null });
    expect(boundary.claims.checked).toEqual([]);
    expect(boundary.planClaims.checked).toEqual([]);
    await db.adminSql`UPDATE harness_shared.adv_sessions SET ended_at = null WHERE id = ${s.target.advSessionId}`;
    expect(await captureNativeConsultBoundary({ ...s.target, live: true, endedAt: null }, ws))
      .toMatchObject({ status: 'unknown', reason: expect.stringContaining('canonical descriptor') });
  });

  it('refuses wrong workspace/owner and a changed live native incarnation even when the old file exists', async () => {
    const s = await source();
    for (const [target, workspaceId] of [[s.target, 'foreign-workspace'],
      [{ ...s.target, ownerId: 'foreign-owner' }, ws]] as const) {
      expect(await captureNativeConsultBoundary(target, workspaceId)).toMatchObject({ status: 'unknown' });
    }
    await db.adminSql`UPDATE harness_shared.adv_sessions SET session_id = ${randomUUID()} WHERE id = ${s.target.advSessionId}`;
    expect(await captureNativeConsultBoundary(s.target, ws))
      .toMatchObject({ status: 'unknown', reason: expect.stringContaining('live native incarnation changed') });
    expect(await readFile(s.path)).toEqual(s.bytes);
  });

  it.each(['plan-only', 'work-item'] as const)('keeps an overflowing %s census unknown at the default reader boundary', async (kind) => {
    const s = await source();
    if (kind === 'plan-only') {
      await db.adminSql`INSERT INTO harness_shared.plan_item_claims
        (workspace_id, harness_slug, plan_slug, item_id, owner, acquired_ts, expires_ts, last_activity_ts)
        SELECT ${ws}, 'papercusp', 'overflow', 'P-' || n, ${s.target.ownerId},
          clock_timestamp(), clock_timestamp() + interval '30 minutes', clock_timestamp()
        FROM generate_series(1, 202) AS n`;
    } else {
      await db.adminSql`INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, item_kind, status, taken_by, created_ts, updated_ts)
        SELECT ${ws}, 'papercusp', 'WI-overflow-' || n, 'overflow', '', 'task', 'open',
          ${s.target.ownerId}, ${Date.now()}, ${Date.now()} FROM generate_series(1, 202) AS n`;
    }
    expect(await captureNativeConsultBoundary(s.target, ws))
      .toMatchObject({ status: 'unknown', reason: expect.stringContaining('200-item observation bound') });
  });

  it('keeps a failed real plan-claim read unknown rather than certifying an empty population', async () => {
    const s = await source();
    await db.adminSql`ALTER TABLE harness_shared.plan_item_claims RENAME TO boundary_unavailable_claims`;
    try {
      expect(await captureNativeConsultBoundary(s.target, ws)).toMatchObject({ status: 'unknown',
        reason: expect.stringContaining('plan_item_claims') });
    } finally {
      await db.adminSql`ALTER TABLE harness_shared.boundary_unavailable_claims RENAME TO plan_item_claims`;
    }
    expect(measured(await captureNativeConsultBoundary(s.target, ws)).planClaims.checked).toEqual([]);
  });
});
