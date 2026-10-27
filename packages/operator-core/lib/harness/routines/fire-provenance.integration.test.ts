import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { getBuildInfo } from '../../build-info';
import { monitoredRuntimeId, monitoredScheduleDescriptor, readMonitoredFireSnapshot, routineDefinitionHash, routineFireProvenance } from './fire-provenance';

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
const definition = { id: 'provenance-test', workspaceId: 'provenance-workspace', installSlug: 'provenance-harness',
  targetRole: 'system:sql-read-census', triggerConfig: { cron: '17 4 * * *', tzid: 'America/New_York' },
  payloadTemplate: null, rescheduleIntervalSec: null, targetOwnerId: null };
beforeAll(async () => {
  db = await createOrgTestDb();
  await db.adminSql`INSERT INTO harness_shared.routines
    (id,workspace_id,install_slug,name,trigger_kind,target_role,trigger_config,payload_template,reschedule_interval_sec,target_owner_id,active)
    VALUES (${definition.id},${definition.workspaceId},${definition.installSlug},'provenance-test','cron',${definition.targetRole},
      ${JSON.stringify(definition.triggerConfig)}::jsonb,NULL,NULL,NULL,true)`;
}, 120_000);
afterAll(async () => { await db?.cleanup(); });

it('records the claimed due slot separately from manual dispatch without inventing historical origin', () => {
  const due = new Date('2026-10-27T08:17:00Z');
  expect(routineFireProvenance(definition, 'scheduler', due)).toEqual({ version: 1,
    origin: 'scheduler', scheduledAt: due.toISOString(), configHash: routineDefinitionHash(definition) });
  expect(routineFireProvenance(definition, 'manual', due)).toMatchObject({ origin: 'manual', scheduledAt: null });
  expect(routineFireProvenance(definition, 'scheduler')).toMatchObject({ scheduledAt: null });
});

it('observes canonical schedule, scope and runtime and detects retune, pause, deletion and wrong workspace', async () => {
  const read = () => readMonitoredFireSnapshot(db.adminSql, definition.workspaceId, definition.id);
  const before = await read();
  expect(before).toMatchObject({ sha: getBuildInfo().sha, runtime: monitoredRuntimeId,
    routineId: definition.id, workspaceId: definition.workspaceId, harnessSlug: definition.installSlug,
    targetRole: definition.targetRole, active: true, expression: definition.triggerConfig.cron,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, configHash: routineDefinitionHash(definition) });
  expect(Number.isFinite(Date.parse(before!.observedAt))).toBe(true);
  expect(await readMonitoredFireSnapshot(db.adminSql, 'other-workspace', definition.id)).toBeNull();
  await db.adminSql`UPDATE harness_shared.routines SET trigger_config='{"cron":"* * * * *"}'::jsonb,active=false
    WHERE id=${definition.id}`;
  const after = await read();
  expect(after).toMatchObject({ active: false, expression: '* * * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  expect(after!.configHash).not.toBe(before!.configHash);
  await db.adminSql`DELETE FROM harness_shared.routines WHERE id=${definition.id}`;
  expect(await read()).toBeNull();
});

it('hashes equivalent JSON definitions consistently and binds payload, target and scope', () => {
  expect(routineDefinitionHash(Object.assign({}, definition, { nextFireAt: new Date(), name: 'display-name' })))
    .toBe(routineDefinitionHash(definition));
  expect(routineDefinitionHash({ ...definition, triggerConfig: { tzid: 'America/New_York', cron: '17 4 * * *' } }))
    .toBe(routineDefinitionHash(definition));
  for (const changed of [{ ...definition, payloadTemplate: { enabled: false } },
    { ...definition, targetRole: 'system:other' }, { ...definition, workspaceId: 'other' }])
    expect(routineDefinitionHash(changed)).not.toBe(routineDefinitionHash(definition));
});

it('uses scheduler RRULE precedence and host-local cron semantics rather than inventing UTC', () => {
  expect(monitoredScheduleDescriptor({ cron: '17 4 * * *', tzid: 'Pacific/Honolulu' }))
    .toEqual({ expression: '17 4 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  expect(monitoredScheduleDescriptor({ cron: '* * * * *', rrule: 'FREQ=DAILY', tzid: 'Pacific/Honolulu' }))
    .toEqual({ expression: 'FREQ=DAILY', timezone: 'Pacific/Honolulu' });
  expect(monitoredScheduleDescriptor({ rrule: 'FREQ=DAILY' })).toEqual({ expression: 'FREQ=DAILY', timezone: 'UTC' });
});
