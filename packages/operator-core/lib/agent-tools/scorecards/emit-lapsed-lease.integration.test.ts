/** WI-10006794: an audit begun under a matching lease can persist after that lease lapses. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(workspace: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
    (h.sql as postgres.Sql).begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${workspace}, true)`;
      return cb(tx as unknown as postgres.Sql);
    }) as Promise<T>,
}));

import { emitScorecard, _closeScorecardEmitMutexForTests } from './emit';
import { recordGradingAudit } from '../../scorecards';
import { createIssue, getIssue, issuesScopeWorkspace } from '../../issues-engineer';
import { getRubricCriteriaHash } from '../../rubrics';
import { OBSERVATION_TOPIC } from '../../harness/improvements/read-items';
import { activeWorkspaceId } from '../../workspace-registry';
import { _resetHarnessAdminUrlCacheForTests } from '../../embedded-pg-discovery';

let pg: DedicatedNativePg;
let org: OrgTestDb;
const savedTestAdmin = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
const savedAdmin = process.env.HARNESS_ADMIN_DATABASE_URL;
const savedMutex = process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST;
const AUDITOR = 'su-lapsed-lease-auditor';
const RUBRIC = 'grading-integrity';

beforeAll(async () => {
  pg = await startDedicatedNativePg();
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
  org = await createOrgTestDb();
  h.sql = org.adminSql;
  process.env.HARNESS_ADMIN_DATABASE_URL = org.adminDsn;
  process.env.PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST = '1';
  _resetHarnessAdminUrlCacheForTests();
  // The rubric read is real. Its authoring workflow is outside this emission acceptance.
  await org.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title,
       status, created, updated, owner, archived, template, template_data, origin)
    VALUES (${activeWorkspaceId()}, 'papercusp', ${RUBRIC}, '', md5(${RUBRIC}), 1,
            'Lease settlement acceptance', 'active', '2026-10-07', '2026-10-07',
            'su-rubric-author', FALSE, 'rubric',
            ${JSON.stringify({ kind: 'standard', characteristic: 'grading-integrity',
              criteria: [{ key: 'lease-settlement', title: 'Lease settlement',
                model: 'An independent audit settles its exact pending subject.',
                method: 'Read the persisted audit and source stamp.', driftMarkers: 'Pending after emit.' }],
              ratingScale: ['pass', 'fail', 'unknown'], description: 'Isolated lease acceptance.' })}::text::jsonb,
            'local')`;
}, 180_000);

afterAll(async () => {
  try {
    await _closeScorecardEmitMutexForTests();
    await org?.cleanup();
  } finally {
    await pg?.stop();
    for (const [key, saved] of [
      ['PAPERCUSP_TEST_PG_ADMIN_URL', savedTestAdmin],
      ['HARNESS_ADMIN_DATABASE_URL', savedAdmin],
      ['PAPERCUSP_SCORECARD_EMIT_MUTEX_TEST', savedMutex],
    ] as const) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    _resetHarnessAdminUrlCacheForTests();
  }
});

describe('scorecard audit emission after lease lapse, real Postgres', () => {
  it('refuses an untracked lease when no active or retained reservation epoch exists', async () => {
    const hash = await getRubricCriteriaHash(RUBRIC);
    expect(hash).toBeTruthy();
    const source = await createIssue({
      title: 'Untracked lapsed audit lease', kind: 'change',
      topics: [OBSERVATION_TOPIC], createdBy: 'su-source-author',
      payload: { observation: {
        rubricRef: 'lease-acceptance-source', sourceHive: 'papercusp',
        ratings: { source: { rating: 'pass', evidence: 'source evidence' } },
        gradingAudit: { state: 'pending', metaRubricRef: RUBRIC,
          stampedAt: '2026-10-07T00:00:00.000Z', rubricRevision: 1, criteriaHash: hash },
      } },
    });
    const result = await emitScorecard({
      rubricRef: RUBRIC,
      terminal: true,
      subject: { kind: 'scorecard', ref: source.id },
      gradingAuditReservation: {
        key: `grading-audit:${source.id}`,
        reservedAt: '2026-10-07T00:01:00.000Z',
      },
      ratings: { 'lease-settlement': { rating: 'pass', evidence: 'No current lease epoch was retained.' } },
    }, { createdBy: AUDITOR, ctxHarness: 'papercusp', workspaceId: activeWorkspaceId() });

    expect(result).toMatchObject({ ok: false, code: 'grading_audit_reservation_unavailable' });
    const persisted = await getIssue(source.id);
    expect((persisted!.payload as { observation: { gradingAudit: unknown } }).observation.gradingAudit)
      .toMatchObject({ state: 'pending' });
  });

  it('retains the original lease in the request and settles the lease-less pending stamp', async () => {
    const hash = await getRubricCriteriaHash(RUBRIC);
    expect(hash).toBeTruthy();
    const source = await createIssue({
      title: 'Exact independent audit subject', kind: 'change',
      topics: [OBSERVATION_TOPIC], createdBy: 'su-source-author',
      payload: { observation: {
        rubricRef: 'lease-acceptance-source', sourceHive: 'papercusp',
        ratings: { source: { rating: 'pass', evidence: 'source evidence' } },
        gradingAudit: { state: 'pending', metaRubricRef: RUBRIC,
          stampedAt: '2026-10-07T00:00:00.000Z', rubricRevision: 1, criteriaHash: hash },
      } },
    });
    const lease = { key: `grading-audit:${source.id}`, reservedAt: '2026-10-07T00:01:00.000Z' };
    const workspace = issuesScopeWorkspace();
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = jsonb_set(
        jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${JSON.stringify(lease)}::text::jsonb),
        '{observation,gradingAudit,lastDispatchReservation}', ${JSON.stringify(lease)}::text::jsonb)
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    const start = await getIssue(source.id);
    expect((start!.payload as { observation: { gradingAudit: unknown } }).observation.gradingAudit)
      .toMatchObject({ state: 'pending', dispatchReservation: lease, lastDispatchReservation: lease });

    const args = { rubricRef: RUBRIC, terminal: true,
      subject: { kind: 'scorecard' as const, ref: source.id }, gradingAuditReservation: lease,
      ratings: { 'lease-settlement': { rating: 'pass', evidence: 'Exact pending stamp read back after lease lapse.' } },
    };
    const input = { createdBy: AUDITOR, ctxHarness: 'papercusp', workspaceId: activeWorkspaceId() };
    // A newer owner wins: the original lease must never settle a replacement lease.
    const replacementLease = { key: lease.key, reservedAt: '2026-10-07T00:02:00.000Z' };
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = jsonb_set(
        jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${JSON.stringify(replacementLease)}::text::jsonb),
        '{observation,gradingAudit,lastDispatchReservation}', ${JSON.stringify(replacementLease)}::text::jsonb)
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    expect(await emitScorecard(args, input)).toMatchObject({ ok: false, code: 'grading_audit_reservation_mismatch' });

    // A dispatcher that restores the original live auditor restores its lease epoch too.
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = jsonb_set(
        jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${JSON.stringify(lease)}::text::jsonb),
        '{observation,gradingAudit,lastDispatchReservation}', ${JSON.stringify(lease)}::text::jsonb)
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    // Simulate expiration after the start read; retain the original request lease epoch.
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = payload #- '{observation,gradingAudit,dispatchReservation}'
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    await org.adminSql`
      INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, state, routing, cascade_cursor)
      VALUES (${workspace}, 'lease-acceptance-consult', 'su-dispatcher', 'active',
        ${JSON.stringify({ cascade: { flavor: 'grading-integrity', issueId: source.id,
          reservationKey: lease.key, reservationReservedAt: lease.reservedAt },
          selection: { selected: [{ answeringOwnerId: AUDITOR }] } })}::text::jsonb, 0)`;
    expect(await emitScorecard(args, { ...input, createdBy: 'su-wrong-auditor' }))
      .toMatchObject({ ok: false, code: 'grading_audit_reservation_unavailable' });

    const emitted = await emitScorecard(args, input);
    expect(emitted).toMatchObject({ ok: true });
    const persisted = await getIssue(source.id);
    const audit = (persisted!.payload as { observation: { gradingAudit: {
      state: string; auditor: string; auditIssueId: string; dispatchReservation?: unknown;
    } } }).observation.gradingAudit;
    expect(audit).toMatchObject({ state: 'passed', auditor: AUDITOR });
    expect(audit).not.toHaveProperty('dispatchReservation');
    expect(audit).toHaveProperty('lastDispatchReservation', lease);
    const auditCard = await getIssue(audit.auditIssueId);
    expect(auditCard).not.toBeNull();
    expect(auditCard!.createdBy).toBe(AUDITOR);
    expect((auditCard!.payload as { observation: unknown }).observation)
      .toMatchObject({ rubricRef: RUBRIC, subject: { kind: 'scorecard', ref: source.id } });
  });

  it('fences a lapsed auditor after a newer lease is released, including a settlement race', async () => {
    const hash = await getRubricCriteriaHash(RUBRIC);
    expect(hash).toBeTruthy();
    const source = await createIssue({
      title: 'Superseded lapsed audit lease', kind: 'change',
      topics: [OBSERVATION_TOPIC], createdBy: 'su-source-author',
      payload: { observation: {
        rubricRef: 'lease-acceptance-source', sourceHive: 'papercusp',
        ratings: { source: { rating: 'pass', evidence: 'source evidence' } },
        gradingAudit: { state: 'pending', metaRubricRef: RUBRIC,
          stampedAt: '2026-10-07T00:00:00.000Z', rubricRevision: 1, criteriaHash: hash },
      } },
    });
    const oldLease = { key: `grading-audit:${source.id}`, reservedAt: '2026-10-07T00:03:00.000Z' };
    const newLease = { key: oldLease.key, reservedAt: '2026-10-07T00:04:00.000Z' };
    const workspace = issuesScopeWorkspace();
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = jsonb_set(
        jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${JSON.stringify(oldLease)}::text::jsonb),
        '{observation,gradingAudit,lastDispatchReservation}', ${JSON.stringify(oldLease)}::text::jsonb)
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    const staleRead = await getIssue(source.id);
    if (!staleRead) throw new Error('expected the grading-audit source to exist');

    // A newer dispatcher claims the card, then releases its active field. The
    // persistent latest epoch must still reject the old auditor.
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = jsonb_set(
        jsonb_set(payload, '{observation,gradingAudit,dispatchReservation}', ${JSON.stringify(newLease)}::text::jsonb),
        '{observation,gradingAudit,lastDispatchReservation}', ${JSON.stringify(newLease)}::text::jsonb)
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;
    await org.adminSql`
      UPDATE harness_shared.work_items SET payload = payload #- '{observation,gradingAudit,dispatchReservation}'
       WHERE workspace_id = ${workspace} AND feature_id = ${source.id}`;

    const args = {
      rubricRef: RUBRIC,
      terminal: true,
      subject: { kind: 'scorecard' as const, ref: source.id },
      gradingAuditReservation: oldLease,
      ratings: { 'lease-settlement': { rating: 'pass', evidence: 'Old lease must not settle after replacement.' } },
    };
    const input = { createdBy: AUDITOR, ctxHarness: 'papercusp', workspaceId: activeWorkspaceId() };
    expect(await emitScorecard(args, input)).toMatchObject({
      ok: false,
      code: 'grading_audit_reservation_mismatch',
    });

    // Simulate the newer dispatch landing after an old auditor's read but before
    // its atomic settle write. The stale snapshot passes recordGradingAudit's
    // read-side lease check; the database CAS must reject the newer epoch.
    const raced = await recordGradingAudit(
      source.id,
      {
        auditIssueId: 'EI-stale-audit-card',
        auditor: AUDITOR,
        verdict: 'passed',
        dispatchReservation: oldLease,
      },
      { getIssue: async () => staleRead },
    );
    expect(raced).toMatchObject({ ok: false, error: expect.stringContaining('failed to record grading audit') });
    const persisted = await getIssue(source.id);
    expect((persisted!.payload as { observation: { gradingAudit: unknown } }).observation.gradingAudit)
      .toMatchObject({ state: 'pending', lastDispatchReservation: newLease });
  });
});
