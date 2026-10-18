import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { createRosterAudit, auditKnown, pageRosterAudit, type AuditScope } from './roster-audit';
import { buildRosterAudit, loadRosterAudit, saveRosterAudit } from './roster-audit-store';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';

const fixture = vi.hoisted(() => ({ workspaceId: 'audit-test-ws', sql: null as unknown }));
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../../../workspace-registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../../workspace-registry')>(), activeWorkspaceId: () => fixture.workspaceId,
}));
vi.mock('../log', () => ({ coordScopeReady: async () => {}, coordWorkspaceId: () => fixture.workspaceId }));

describe('roster frozen audit PG persistence', () => {
  let db: OrgTestDb;
  const harness = 'audit-test-' + randomUUID();
  const scope: AuditScope = { workspaceId: 'audit-test-ws', scope: 'workspace', potId: null, owner: null, readerId: 'reader-a' };
  beforeAll(async () => { db = await createOrgTestDb(); fixture.sql = db.adminSql; }, 120_000);
  afterAll(async () => { await db?.cleanup(); });
  const build = () => createRosterAudit({ asOf: '2026-10-18T00:00:00.000Z', scope, population: ['a', 'b'], expectedPopulation: 2,
    records: ['a', 'b'].map(ownerId => ({ id: 'agent:' + ownerId, ownerId, kind: 'agent' as const,
      fields: { state: auditKnown('parked', 'oracle', '2026-10-18T00:00:00.000Z') } })),
    provenance: { status: 'unknown', directiveId: null, sourceRef: null, turnOrigin: null, quote: null, reason: 'not requested' },
    previous: { status: 'known', auditId: null, asOf: null, total: null, corrections: [] },
  });
  it('persists one immutable snapshot and continues exactly after a fresh read', async () => {
    const snapshot = build();
    await saveRosterAudit(harness, snapshot);
    await saveRosterAudit(harness, snapshot);
    const page = pageRosterAudit(snapshot, scope, { pageSize: 1 });
    const restored = await loadRosterAudit(harness, snapshot.auditId, scope);
    expect(restored).toEqual(snapshot);
    const end = pageRosterAudit(restored!, scope, { cursor: page.nextCursor! });
    expect(end.records.map(row => row.ownerId)).toEqual(['b']);
    expect(end.coverage).toMatchObject({ total: 2, covered: 2, complete: true });
  });
  it('refuses another reader or workspace, including with the exact known audit id', async () => {
    const snapshot = build();
    await saveRosterAudit(harness, snapshot);
    await expect(loadRosterAudit(harness, snapshot.auditId, { ...scope, readerId: 'reader-b' })).rejects.toThrow(/content|scope/);
    await expect(loadRosterAudit(harness, snapshot.auditId, { ...scope, workspaceId: 'other-workspace' })).rejects.toThrow(/workspace/);
  });
  it('does not recapture an absent snapshot or accept modified stored evidence', async () => {
    expect(await loadRosterAudit(harness, 'f'.repeat(64), scope)).toBeNull();
    const snapshot = createRosterAudit({ ...build(), asOf: '2026-10-19T00:00:00.000Z' });
    await saveRosterAudit(harness, snapshot);
    await db.adminSql`UPDATE harness_shared.harness_text_artifacts SET content = ${JSON.stringify({ ...snapshot, population: ['a', 'a'] })}
      WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${harness} AND rel_path LIKE ${'%' + snapshot.auditId + '.json'}`;
    await expect(loadRosterAudit(harness, snapshot.auditId, scope)).rejects.toThrow(/content|population/);
  });

  it('assembles measured modes, no-work owners and exact message pickup from PG', async () => {
    const asOf = '2026-10-18T01:00:00.000Z';
    await db.adminSql`INSERT INTO harness_shared.agent_modes (workspace_id, owner_id, axis_key, mode, set_by)
      VALUES (${scope.workspaceId}, 'audit-agent-a', 'autonomy', 'auto', 'audit-agent-a')`;
    await db.adminSql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      VALUES (${scope.workspaceId}, 'messages', 'audit-request', ${db.adminSql.json({ from: 'requester', to: ['audit-agent-a'], wake: 'required' })}, ${asOf}::timestamptz),
      (${scope.workspaceId}, 'messages', 'audit-reply', ${db.adminSql.json({ from: 'audit-agent-a', to: ['requester'], related_msg_id: 'audit-request' })}, ${asOf}::timestamptz)`;
    await db.adminSql`INSERT INTO harness_shared.event_wake_deliveries
      (workspace_id, await_id, subscriber_id, event_key, payload, status, turn_proof, turn_started_at, created_at)
      VALUES (${DEFAULT_COORD_WORKSPACE}, 1, 'audit-agent-a', 'coord:inbox-wake:audit-agent-a',
        ${db.adminSql.json({ msg_id: 'audit-request' })}, 'delivered', 'observed', ${asOf}::timestamptz, ${asOf}::timestamptz)`;
    const snapshot = await buildRosterAudit({ harness, scope, asOf, expectedPopulation: 2, viewer: { ownerId: 'reader-a' }, agents: [
      { ownerId: 'audit-agent-a', sessionState: 'parked', awaitingEventKey: 'coord:inbox-wake:audit-agent-a' },
      { ownerId: 'audit-agent-b', sessionState: 'parked', awaitingEventKey: 'work-item:done:WI-DEP', wakeMode: 'auto' },
    ] });
    const a = snapshot.records.find(row => row.id === 'agent:audit-agent-a')!;
    const b = snapshot.records.find(row => row.id === 'agent:audit-agent-b')!;
    expect(a.fields.ownedWorkCount).toMatchObject({ status: 'known', value: 0 });
    expect(a.fields.registeredAuto).toMatchObject({ status: 'known', value: true });
    expect(a.fields.wait.value).toMatchObject({ kind: 'listener' });
    expect(b.fields.registeredAuto).toMatchObject({ status: 'known', value: false });
    expect(b.fields.wait.value).toMatchObject({ kind: 'substantive' });
    const wake = snapshot.records.find(row => row.id === 'wake:audit-agent-a:audit-request')!;
    for (const field of ['queued', 'delivered', 'turnStarted', 'replied']) expect(wake.fields[field]).toMatchObject({ status: 'known', value: true });
    expect(snapshot.population).toEqual(['audit-agent-a', 'audit-agent-b']);
    await saveRosterAudit(harness, snapshot);
    expect(await loadRosterAudit(harness, snapshot.auditId, scope)).toEqual(snapshot);
  });

  it('retains harness-qualified feature claims with unknown missing checkpoints', async () => {
    const asOf = '2026-10-18T02:00:00.000Z';
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by)
      VALUES (${scope.workspaceId}, ${harness}, 'F-1', 'feature', 'First harness', 'wip', 'audit-agent-work'),
        (${scope.workspaceId}, ${harness + '-second'}, 'F-2', 'feature', 'Second harness', 'wip', 'audit-agent-work')`;
    const snapshot = await buildRosterAudit({ harness, scope, asOf, expectedPopulation: 1,
      viewer: { ownerId: 'reader-a' }, agents: [{ ownerId: 'audit-agent-work', sessionState: 'parked', awaitingEvent: false }] });
    const work = snapshot.records.filter(row => row.kind === 'work');
    expect(work).toHaveLength(2);
    expect(work.map(row => (row.fields.identity.value as { harness: string }).harness).sort()).toEqual([harness, harness + '-second'].sort());
    expect(work.map(row => row.fields.next.status)).toEqual(['unknown', 'unknown']);
  });
});
