import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const holder = vi.hoisted(() => ({ sql: null as postgres.Sql | null }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: holder.sql }),
}));

vi.mock('./events/await/psu-pty-discovery', () => ({
  findLiveHost: () => null,
  findLiveHostAsync: async () => null,
  injectIntoHost: vi.fn(),
}));

const { probeFreshLaunchSessions, verifyFreshLaunchStarted, resolveResumeTarget } = await import('./agent-launch-core');
let sql: postgres.Sql;
let dbName: string;
let adminUri: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `launch_probe_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(adminUri);
  url.pathname = `/${dbName}`;
  sql = postgres(url.toString(), { max: 1 });
  holder.sql = sql;
  await sql.unsafe(`
    CREATE SCHEMA harness_shared;
    CREATE TABLE harness_shared.adv_sessions (
      id integer PRIMARY KEY, session_id text, coord_owner_id text,
      workspace_id text, first_seen_at timestamptz, launch_spec jsonb, launch_argv jsonb,
      plan_slug text, agent text, role text, feature text, mode text, terminal_bin text,
      pid integer, window_id text, omp_thread_id text, label text, cwd text,
      started_at timestamptz, ended_at timestamptz, exit_code integer, ended_by text
    );
    CREATE TABLE harness_shared.session_turns (
      session_id text, owner text, ingested_at timestamptz
    );
    CREATE TABLE harness_shared.tool_invocations (
      workspace_id text, coord_owner_id text, status text, call_origin text,
      tool_name text, invoked_at timestamptz, metadata_json jsonb
    );
    CREATE TABLE harness_shared.coord_presence (workspace_id text, owner_id text);
    CREATE TABLE harness_shared.work_items (
      workspace_id text, feature_id text, taken_by text, terminal_owner text,
      worked_by_history jsonb
    );
    CREATE TABLE harness_shared.routines (target_owner_id text, name text, active boolean);
    CREATE TABLE harness_shared.event_awaits (
      subscriber_id text, policy text, event_key text, note text,
      fired_at timestamptz, cancelled_at timestamptz, expires_ts timestamptz
    );
  `);
});

afterAll(async () => {
  holder.sql = null;
  if (sql) await sql.end({ timeout: 5 });
  if (adminUri && dbName) {
    const admin = postgres(adminUri, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
});

describe('resume target registration election (real PG)', () => {
  it.each([null, '2026-10-10T02:14:14Z'])('keeps the latest registration after a predecessor timestamp refresh (endedAt=%s)', async (endedAt) => {
    const owner = `su-resume-${randomBytes(5).toString('hex')}`;
    const currentId = endedAt ? 102 : 100;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, agent, started_at, ended_at)
      VALUES (${currentId - 1}, ${owner}, ${owner + '-old'}, 'codex', '2026-10-10T02:04:00Z', '2026-10-09T23:00:00Z'),
             (${currentId}, ${owner}, ${owner + '-current'}, 'codex', '2026-10-10T00:30:00Z', ${endedAt})
    `;
    const exact = await resolveResumeTarget({ sessionId: owner + '-current' });
    const byOwner = await resolveResumeTarget({ agentId: owner });
    expect.soft(exact).toMatchObject({ ok: true, advSessionId: currentId, sessionId: owner + '-current' });
    expect.soft(byOwner).toMatchObject({ ok: true, advSessionId: currentId, sessionId: owner + '-current',
      endedAt: endedAt ? new Date(endedAt).toISOString() : null });
    if (exact.ok && byOwner.ok) expect.soft(byOwner.binding).toEqual(exact.binding);
  });

  it('bridges a historical native pin to the latest owner registration without replacing the pin', async () => {
    const owner = 'su-resume-bridged';
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, agent, started_at)
      VALUES (103, ${owner}, 'bridged-old', 'codex', '2026-10-10T02:04:00Z'),
             (104, ${owner}, 'bridged-current', 'codex', '2026-10-10T00:30:00Z')
    `;
    await sql`INSERT INTO harness_shared.session_turns (session_id, owner, ingested_at)
      VALUES ('bridged-earlier-pin', ${owner}, now())`;
    await expect(resolveResumeTarget({ sessionId: 'bridged-earlier-pin' })).resolves.toMatchObject({
      ok: true, advSessionId: 104, sessionId: 'bridged-earlier-pin',
      binding: { coordOwnerId: owner, sessionId: 'bridged-current' },
    });
    // A pin still selects its actual recorded incarnation rather than the owner's newer row.
    await expect(resolveResumeTarget({ sessionId: 'bridged-old' })).resolves.toMatchObject({
      ok: true, advSessionId: 103, sessionId: 'bridged-old',
    });
  });

  it('returns the exact source workspace and recorded harness for scoped successor dispatch', async () => {
    const owner = 'su-resume-scoped-source';
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, workspace_id, agent, started_at, launch_argv)
      VALUES (105, ${owner}, 'scoped-source-session', 'source-workspace', 'claude', now(),
              ${JSON.stringify(['psu', '--harness=source-harness'])}::jsonb)
    `;

    await expect(resolveResumeTarget({ agentId: owner })).resolves.toMatchObject({
      ok: true,
      ownerId: owner,
      workspaceId: 'source-workspace',
      harnessSlug: 'source-harness',
    });
  });

  it('does not infer a missing harness from ambient context', async () => {
    const owner = 'su-resume-unscoped-source';
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, workspace_id, agent, started_at, launch_argv)
      VALUES (106, ${owner}, 'unscoped-source-session', 'source-workspace', 'claude', now(),
              ${JSON.stringify(['psu', '--no-picker'])}::jsonb)
    `;

    await expect(resolveResumeTarget({ agentId: owner })).resolves.toMatchObject({
      ok: true,
      workspaceId: 'source-workspace',
      harnessSlug: null,
    });
  });
});

describe('fresh-launch tool-call attribution (real PG)', () => {
  it('distinguishes an observed-silent boot from a still-signalling boot', async () => {
    const workspaceId = 'ws-silence';
    const ownerId = 'su-silence';
    const launcherOwnerId = 'su-launcher-silence';
    const since = Date.now() - 180_000;
    const firstSeen = since + 1_500;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (3, 'native-silence', ${ownerId}, ${workspaceId}, to_timestamp(${firstSeen / 1000}),
              '{}'::jsonb, ${JSON.stringify(['psu', `--launched-by=${launcherOwnerId}`])}::jsonb)
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES (${workspaceId}, ${ownerId}, 'ok', 'agent', 'activity:report',
              to_timestamp(${(firstSeen + 100) / 1000}))
    `;

    const probe = () => probeFreshLaunchSessions({ workspaceId, launcherOwnerId, since });
    const silent = await probe();
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ successfulCalls: 0, hasPresence: false });
    expect(silent[0]!.msSinceLastSignal).toBeGreaterThan(60_000);
    const observedSilence = await verifyFreshLaunchStarted(
      { workspaceId, launcherOwnerId, since, expected: 1 },
      { probe, timeoutMs: 1, pollMs: 1, silenceMs: 60_000, sleep: async () => {} },
    );
    expect(observedSilence.agentStarted).toBe(false);
    expect(observedSilence.note).toMatch(/went SILENT/);

    await sql`
      UPDATE harness_shared.tool_invocations SET invoked_at = now()
      WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${ownerId}
    `;
    const signalling = await probe();
    expect(signalling[0]).toMatchObject({ successfulCalls: 0, hasPresence: false });
    expect(signalling[0]!.msSinceLastSignal).toBeLessThan(60_000);
    const stillSignalling = await verifyFreshLaunchStarted(
      { workspaceId, launcherOwnerId, since, expected: 1 },
      { probe, timeoutMs: 1, pollMs: 1, silenceMs: 60_000, sleep: async () => {} },
    );
    expect(stillSignalling.agentStarted).toBeNull();
    expect(stillSignalling.note).toMatch(/still signalling/);
  });

  it('does not credit same-owner predecessor calls to a successor with no native session or first turn', async () => {
    const since = Date.now() - 5_000;
    const firstSeen = since + 1_500;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (1, NULL, 'su-shared-owner', 'ws-launch', to_timestamp(${firstSeen / 1000}),
              '{}'::jsonb, '["psu", "--launched-by=su-launcher"]'::jsonb)
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES ('ws-launch', 'su-shared-owner', 'ok', 'agent', 'coord:orient',
              to_timestamp(${(since - 100) / 1000}))
    `;

    const probe = () => probeFreshLaunchSessions({
      workspaceId: 'ws-launch', launcherOwnerId: 'su-launcher', since,
    });
    const before = await probe();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({
      sessionId: null, successfulCalls: 0,
      workerAttestation: { ready: false, stages: { agentCall: { status: 'missing' } } },
    });
    expect(before[0]?.msSinceLastSignal).toBeNull();

    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES ('ws-launch', 'su-shared-owner', 'ok', 'agent', 'coord:orient',
              to_timestamp(${(firstSeen + 100) / 1000}))
    `;
    const after = await probe();
    expect(after[0]?.successfulCalls).toBe(1);
    expect(after[0]?.workerAttestation.stages.agentCall.status).toBe('satisfied');
  });

  it('requires a real call, scheduler disposition, and durable wake before reporting a member ready', async () => {
    const workspaceId = 'ws-readiness';
    const ownerId = 'su-readiness';
    const launcherOwnerId = 'su-launcher-readiness';
    const since = Date.now() - 5_000;
    const firstSeen = since + 1_500;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (2, 'native-readiness', ${ownerId}, ${workspaceId}, to_timestamp(${firstSeen / 1000}),
              '{}'::jsonb, ${JSON.stringify(['psu', `--launched-by=${launcherOwnerId}`])}::jsonb)
    `;
    await sql`
      INSERT INTO harness_shared.coord_presence (workspace_id, owner_id)
      VALUES (${workspaceId}, ${ownerId})
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES (${workspaceId}, ${ownerId}, 'ok', 'agent', 'activity:report',
              to_timestamp(${(firstSeen + 100) / 1000}))
    `;

    const probe = async () => {
      const sessions = await probeFreshLaunchSessions({ workspaceId, launcherOwnerId, since });
      expect(sessions).toHaveLength(1);
      return sessions[0]!;
    };
    const slowBoot = await verifyFreshLaunchStarted(
      { workspaceId, launcherOwnerId, since, expected: 1 },
      { pollMs: 1, timeoutMs: 1, sleep: async () => {} },
    );
    expect(slowBoot.agentStarted).toBeNull();
    expect(slowBoot.workerReady).toBe(false);
    expect(slowBoot.note).toMatch(/UNVERIFIED/);

    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES (${workspaceId}, ${ownerId}, 'ok', 'agent', 'coord:orient',
              to_timestamp(${(firstSeen + 200) / 1000}))
    `;
    const noScheduler = await probe();
    expect(noScheduler.workerAttestation.stages.agentCall.status).toBe('satisfied');
    expect(noScheduler.workerAttestation.stages.schedulerPull.status).toBe('missing');
    expect(noScheduler.workerAttestation.ready).toBe(false);

    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES (${workspaceId}, ${ownerId}, 'error', 'agent', 'scheduler:get_next',
              to_timestamp(${(firstSeen + 300) / 1000}))
    `;
    const failedPull = await probe();
    expect(failedPull.workerAttestation.stages.schedulerPull.status).toBe('failed');
    expect(failedPull.workerAttestation.failures.map((failure) => failure.code)).toContain('scheduler-pull-failed');

    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at, metadata_json)
      VALUES (${workspaceId}, ${ownerId}, 'ok', 'agent', 'scheduler:get_next',
              to_timestamp(${(firstSeen + 400) / 1000}),
              ${sql.json({ schedulerDisposition: { kind: 'no-claim', reason: 'lane_drained' } })})
    `;
    const noWake = await probe();
    expect(noWake.workerAttestation.stages.schedulerPull.status).toBe('satisfied');
    expect(noWake.workerAttestation.stages.disposition).toEqual({
      status: 'satisfied', kind: 'no-claim', reason: 'lane_drained',
    });
    expect(noWake.workerAttestation.stages.durableWake.status).toBe('missing');
    expect(noWake.workerAttestation.ready).toBe(false);

    await sql`
      INSERT INTO harness_shared.routines (target_owner_id, name, active)
      VALUES (${ownerId}, ${`loop-${ownerId}`}, true)
    `;
    const healthyNoClaim = await probe();
    expect(healthyNoClaim.workerAttestation.stages.durableWake).toEqual({
      status: 'satisfied', wakeSource: 'loop',
    });
    expect(healthyNoClaim.workerAttestation.ready).toBe(true);

    // The successful scheduler call alone cannot stand in for either a
    // structured no-claim result or a canonical work-item claim.
    await sql`
      UPDATE harness_shared.tool_invocations
      SET metadata_json = '{}'::jsonb
      WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${ownerId}
        AND tool_name = 'scheduler:get_next' AND status = 'ok'
    `;
    const missingCustody = await probe();
    expect(missingCustody.workerAttestation.stages.agentCall.status).toBe('satisfied');
    expect(missingCustody.workerAttestation.stages.schedulerPull.status).toBe('satisfied');
    expect(missingCustody.workerAttestation.stages.durableWake.status).toBe('satisfied');
    expect(missingCustody.workerAttestation.stages.disposition).toEqual({
      status: 'missing', kind: 'missing',
    });
    expect(missingCustody.workerAttestation.failures.map((failure) => failure.code)).toEqual([
      'disposition-missing',
    ]);
    expect(missingCustody.workerAttestation.ready).toBe(false);

    await sql`UPDATE harness_shared.routines SET active = false WHERE target_owner_id = ${ownerId}`;
    await sql`
      INSERT INTO harness_shared.work_items (workspace_id, feature_id, taken_by, worked_by_history)
      VALUES (${workspaceId}, 'WI-readiness', ${ownerId}, '[]'::jsonb)
    `;
    const claimedWithoutWake = await probe();
    expect(claimedWithoutWake.workerAttestation.stages.disposition).toEqual({
      status: 'satisfied', kind: 'claimed', workItemId: 'WI-readiness',
    });
    expect(claimedWithoutWake.workerAttestation.ready).toBe(false);

    await sql`
      INSERT INTO harness_shared.event_awaits (subscriber_id, policy, event_key, note)
      VALUES (${ownerId}, 'wake', 'work-item:claimable', 'readiness integration control')
    `;
    const claimedWithEventWake = await probe();
    expect(claimedWithEventWake.workerAttestation.stages.durableWake).toEqual({
      status: 'satisfied', wakeSource: 'event',
    });
    expect(claimedWithEventWake.workerAttestation.ready).toBe(true);
  });
});
