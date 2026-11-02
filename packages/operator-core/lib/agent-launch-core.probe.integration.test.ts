import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
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

const {
  probeFreshLaunchSessions, verifyFreshLaunchStarted, resolveResumeTarget,
  claimAgentLaunch, recordAgentLaunchResult, releaseAgentLaunchClaim,
  AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS,
} = await import('./agent-launch-core');
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
    CREATE TABLE harness_shared.agent_launch_idempotency (
      workspace_id text NOT NULL, idempotency_key text NOT NULL,
      launched_at bigint NOT NULL, launched_by text, summary jsonb NOT NULL,
      PRIMARY KEY (workspace_id, idempotency_key)
    );
    CREATE TABLE harness_shared.adv_sessions (
      id integer PRIMARY KEY, session_id text, coord_owner_id text,
      workspace_id text, first_seen_at timestamptz, launch_spec jsonb, launch_argv jsonb,
      plan_slug text, agent text, role text, feature text, mode text, terminal_bin text,
      pid integer, window_id text, omp_thread_id text, label text, display text, cwd text,
      started_at timestamptz, ended_at timestamptz, exit_code integer, ended_by text
    );
    CREATE TABLE harness_shared.session_turns (
      session_id text, owner text, ingested_at timestamptz
    );
    CREATE TABLE harness_shared.tool_invocations (
      workspace_id text, coord_owner_id text, status text, call_origin text,
      tool_name text, invoked_at timestamptz, metadata_json jsonb
    );
    -- Match the existing production owner-recency access path (migration 427).
    CREATE INDEX tool_invocations_coord_owner_idx
      ON harness_shared.tool_invocations (coord_owner_id, invoked_at DESC)
      WHERE coord_owner_id IS NOT NULL;
    CREATE TABLE harness_shared.coord_presence (workspace_id text, owner_id text, host text, pid integer);
    CREATE TABLE harness_shared.work_items (
      workspace_id text, feature_id text, taken_by text, terminal_owner text,
      worked_by_history jsonb
    );
    CREATE TABLE harness_shared.routines (target_owner_id text, name text, active boolean);
    CREATE TABLE harness_shared.event_awaits (
      subscriber_id text, policy text, event_key text, note text,
      fired_at timestamptz, cancelled_at timestamptz, expires_ts timestamptz,
      timeout_behavior text NOT NULL DEFAULT 'expire'
        CHECK (timeout_behavior IN ('expire', 'wake'))
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

describe('launch claim ownership across progress receipts (real PG)', () => {
  const preSpawn = {
    requestKind: 'capability:launch-agent', launchState: 'spawning',
    spawnAttempted: false, nativeSpawnAttempted: [], memberResults: {},
    processHandles: {}, tasks: [],
  };

  it.each([false, true])('recovers an expired pre-spawn receipt and fences its prior writer (lostToken=%s)', async (lostToken) => {
    const workspaceId = `ws-pre-spawn-${lostToken}`;
    const idempotencyKey = 'recover';
    const now = Date.now();
    await claimAgentLaunch({
      workspaceId, idempotencyKey, now: now - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS - 1,
      initialSummary: { ...preSpawn, claimToken: 'old-token' }, failClosed: true,
    });
    // Reproduce the old progress writer, which replaced the summary and lost
    // its token. Its next token-CAS write must still fail before native spawn.
    if (lostToken) await sql`UPDATE harness_shared.agent_launch_idempotency
      SET summary = summary - 'claimToken'
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}`;

    const contenders = await Promise.all(['retry-a', 'retry-b'].map((claimToken) => claimAgentLaunch({
      workspaceId, idempotencyKey, now, preserveAmbiguousClaims: true, failClosed: true,
      initialSummary: { requestKind: 'capability:launch-agent', launchState: 'claimed', claimToken },
    })));
    expect(contenders.filter((claim) => claim.won)).toHaveLength(1);
    expect(await recordAgentLaunchResult({
      workspaceId, idempotencyKey, claimToken: 'old-token',
      summary: { ...preSpawn, spawnAttempted: true, nativeSpawnAttempted: [0] },
    })).toBe(false);
    expect(await releaseAgentLaunchClaim({ workspaceId, idempotencyKey, claimToken: 'old-token' })).toBe(false);
    const winner = contenders[0].won ? 'retry-a' : 'retry-b';
    expect(await recordAgentLaunchResult({
      workspaceId, idempotencyKey, claimToken: winner,
      summary: { ...preSpawn, spawnAttempted: true, nativeSpawnAttempted: [0] },
    })).toBe(true);
  });

  it.each([
    { launchState: 'completed' }, { spawnAttempted: true },
    { spawnAttempted: undefined }, { nativeSpawnAttempted: [0] },
    { nativeSpawnAttempted: undefined }, { memberResults: { '0': { status: 'starting' } } },
    { memberResults: undefined }, { processHandles: { '0': { pid: 123 } } },
    { processHandles: undefined }, { tasks: [{ taskId: 'existing' }] },
    { tasks: undefined }, { requestKind: undefined },
  ])('keeps an expired ambiguous or attempted receipt fenced: %j', async (change) => {
    const workspaceId = `ws-fenced-${randomBytes(5).toString('hex')}`;
    const now = Date.now();
    const summary = { ...preSpawn, ...change };
    await claimAgentLaunch({
      workspaceId, idempotencyKey: 'fenced', now: now - AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS - 1,
      initialSummary: summary, failClosed: true,
    });
    expect(await claimAgentLaunch({
      workspaceId, idempotencyKey: 'fenced', now, preserveAmbiguousClaims: true, failClosed: true,
      initialSummary: { requestKind: 'capability:launch-agent', launchState: 'claimed', claimToken: 'retry' },
    })).toMatchObject({ won: false });
  });

  it('does not recover a fresh pre-spawn receipt or replace one without a new ownership token', async () => {
    const workspaceId = 'ws-fresh-pre-spawn';
    const now = Date.now();
    await claimAgentLaunch({ workspaceId, idempotencyKey: 'fresh', now, initialSummary: preSpawn, failClosed: true });
    expect(await claimAgentLaunch({
      workspaceId, idempotencyKey: 'fresh', now: now + 1, preserveAmbiguousClaims: true,
      initialSummary: { requestKind: 'capability:launch-agent', launchState: 'claimed', claimToken: 'retry' },
    })).toMatchObject({ won: false });
    expect(await claimAgentLaunch({
      workspaceId, idempotencyKey: 'fresh', now: now + AGENT_LAUNCH_EMPTY_CLAIM_LEASE_MS + 1,
      preserveAmbiguousClaims: true, initialSummary: { requestKind: 'capability:launch-agent', launchState: 'claimed' },
    })).toMatchObject({ won: false });
  });

  it('retains the winning token through repeated writes and refuses stale writers', async () => {
    const workspaceId = 'ws-token-receipts';
    const idempotencyKey = 'progress';
    const claimToken = 'winning-token';
    expect(await claimAgentLaunch({
      workspaceId, idempotencyKey, failClosed: true,
      initialSummary: { claimToken, launchState: 'claimed' },
    })).toMatchObject({ won: true });

    for (const launchState of ['spawning', 'member-starting', 'completed']) {
      expect(await recordAgentLaunchResult({
        workspaceId, idempotencyKey, claimToken,
        summary: { launchState },
      })).toBe(true);
      const [row] = await sql`SELECT summary FROM harness_shared.agent_launch_idempotency
        WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}`;
      expect(row.summary).toEqual({ claimToken, launchState });
      expect(await recordAgentLaunchResult({
        workspaceId, idempotencyKey, claimToken: 'stale-token',
        summary: { launchState: 'stale-write' },
      })).toBe(false);
    }

    expect(await releaseAgentLaunchClaim({
      workspaceId, idempotencyKey, claimToken: 'stale-token',
    })).toBe(false);
    expect(await releaseAgentLaunchClaim({ workspaceId, idempotencyKey, claimToken })).toBe(true);
  });

  it('keeps an existing ownership token when a legacy writer replaces the receipt', async () => {
    const workspaceId = 'ws-legacy-token-receipts';
    const idempotencyKey = 'legacy-progress';
    const claimToken = 'original-token';
    await claimAgentLaunch({
      workspaceId, idempotencyKey, failClosed: true, initialSummary: { claimToken },
    });
    expect(await recordAgentLaunchResult({
      workspaceId, idempotencyKey, summary: { claimToken: 'replacement-token', opened: 1 },
    })).toBe(true);
    const [row] = await sql`SELECT summary FROM harness_shared.agent_launch_idempotency
      WHERE workspace_id = ${workspaceId} AND idempotency_key = ${idempotencyKey}`;
    expect(row.summary).toEqual({ claimToken, opened: 1 });
    expect(await releaseAgentLaunchClaim({ workspaceId, idempotencyKey, claimToken })).toBe(true);
  });
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
              ${JSON.stringify(['psu', '--harness=source-harness'])}::text::jsonb)
    `;

    await expect(resolveResumeTarget({ agentId: owner })).resolves.toMatchObject({
      ok: true,
      ownerId: owner,
      workspaceId: 'source-workspace',
      harnessSlug: 'source-harness',
    });
  });

  it('falls back to the live same-host presence pid for a headless source', async () => {
    const owner = `su-resume-presence-pid-${randomBytes(5).toString('hex')}`;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, workspace_id, agent, pid, started_at, launch_argv)
      VALUES (107, ${owner}, 'presence-pid-source', 'source-workspace', 'codex', NULL, now(),
              ${JSON.stringify(['psu', '--agent=codex', '--headless'])}::text::jsonb)
    `;
    await sql`
      INSERT INTO harness_shared.coord_presence (workspace_id, owner_id, host, pid)
      VALUES ('source-workspace', ${owner}, ${hostname()}, ${process.pid})
    `;

    await expect(resolveResumeTarget({ agentId: owner })).resolves.toMatchObject({
      ok: true,
      pid: process.pid,
      headless: true,
    });
  });

  it('does not infer a missing harness from ambient context', async () => {
    const owner = 'su-resume-unscoped-source';
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, coord_owner_id, session_id, workspace_id, agent, started_at, launch_argv)
      VALUES (106, ${owner}, 'unscoped-source-session', 'source-workspace', 'claude', now(),
              ${JSON.stringify(['psu', '--no-picker'])}::text::jsonb)
    `;

    await expect(resolveResumeTarget({ agentId: owner })).resolves.toMatchObject({
      ok: true,
      workspaceId: 'source-workspace',
      harnessSlug: null,
    });
  });
});

describe('fresh-launch tool-call attribution (real PG)', () => {
  it('selects the expected owner before limiting the launch cohort', async () => {
    const workspaceId = 'ws-cohort';
    const launcherOwnerId = 'su-launcher-cohort';
    const since = Date.now() - 180_000;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      SELECT 1000 + n, 'cohort-native-' || n, 'cohort-owner-' || n, ${workspaceId},
             to_timestamp(${since / 1000}) + n * interval '1 second', '{}'::jsonb,
             ${sql.json(['psu', `--launched-by=${launcherOwnerId}`])}
        FROM generate_series(1, 61) n
    `;
    const args = { workspaceId, launcherOwnerId, since };
    const selected = await probeFreshLaunchSessions({ ...args, expectedOwnerIds: ['cohort-owner-61'] });
    expect(selected.map((row) => row.ownerId)).toEqual(['cohort-owner-61']);
    for (const expectedOwnerIds of [undefined, []]) {
      const unscoped = await probeFreshLaunchSessions({ ...args, expectedOwnerIds });
      expect(unscoped).toHaveLength(50);
      expect(unscoped[0].ownerId).toBe('cohort-owner-1');
      expect(unscoped[49].ownerId).toBe('cohort-owner-50');
    }
  });

  it('preserves mixed call counts, latest scheduler disposition and every-origin last signal', async () => {
    const workspaceId = 'ws-mixed-counts';
    const ownerId = 'su-mixed-counts';
    const launcherOwnerId = 'su-launcher-mixed-counts';
    const since = Date.now() - 180_000;
    const firstSeen = since + 60_000;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (2000, 'mixed-native', ${ownerId}, ${workspaceId}, to_timestamp(${firstSeen / 1000}),
              '{}'::jsonb, ${sql.json(['psu', `--launched-by=${launcherOwnerId}`])})
    `;
    const calls = [
      [workspaceId, ownerId, -1, 'ok', 'agent', 'scheduler:get_next', 'predecessor'],
      [workspaceId, ownerId, 0, 'ok', 'agent', 'coord:orient', null],
      [workspaceId, ownerId, 1, 'ok', 'agent', 'scheduler:get_next', 'earlier'],
      [workspaceId, ownerId, 2, 'error', 'agent', 'scheduler:get_next', 'latest'],
      [workspaceId, ownerId, 3, 'ok', 'hook', 'scheduler:get_next', 'hook'],
      [workspaceId, ownerId, 4, 'ok', 'agent', 'activity:report', null],
      [workspaceId, ownerId, 5, 'ok', 'agent', 'coord:glance', null],
      [workspaceId, ownerId, 6, 'error', 'agent', 'coord:send', null],
      ['other-workspace', ownerId, 7, 'ok', 'agent', 'scheduler:get_next', 'wrong-workspace'],
      [workspaceId, 'other-owner', 8, 'ok', 'agent', 'scheduler:get_next', 'wrong-owner'],
      [workspaceId, ownerId, 90, 'error', 'hook', 'activity:report', null],
    ] as const;
    for (const [workspace, owner, seconds, status, origin, tool, reason] of calls) {
      await sql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at, metadata_json)
        VALUES (${workspace}, ${owner}, ${status}, ${origin}, ${tool},
                to_timestamp(${firstSeen / 1000 + seconds}),
                ${sql.json({ schedulerDisposition: { kind: 'no-claim', reason } })})
      `;
    }
    const [probe] = await probeFreshLaunchSessions({ workspaceId, launcherOwnerId, since });
    expect(probe).toMatchObject({
      successfulCalls: 2,
      workerAttestation: { stages: {
        schedulerPull: { status: 'satisfied', calls: 2, successfulCalls: 1 },
        disposition: { status: 'satisfied', kind: 'no-claim', reason: 'latest' },
      } },
    });
    const [clock] = await sql`SELECT EXTRACT(EPOCH FROM now()) * 1000 AS now_ms`;
    const expectedAge = Number(clock.now_ms) - (firstSeen + 90_000);
    expect(probe.msSinceLastSignal).not.toBeNull();
    expect(Math.abs(probe.msSinceLastSignal! - expectedAge)).toBeLessThan(5_000);
  });

  it('examines owner history once for aggregates plus a bounded latest-scheduler seek', async () => {
    const workspaceId = 'ws-probe-plan';
    const ownerId = 'su-probe-plan';
    const launcherOwnerId = 'su-launcher-plan';
    const since = Date.now() - 180_000;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (id, session_id, coord_owner_id, workspace_id, first_seen_at, launch_spec, launch_argv)
      VALUES (3000, 'plan-native', ${ownerId}, ${workspaceId}, to_timestamp(${since / 1000}),
              '{}'::jsonb, ${sql.json(['psu', `--launched-by=${launcherOwnerId}`])})
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      SELECT ${workspaceId}, ${ownerId}, 'ok', 'agent',
             CASE WHEN n % 4 = 0 THEN 'scheduler:get_next' ELSE 'coord:orient' END,
             to_timestamp(${since / 1000}) + n * interval '1 millisecond'
        FROM generate_series(1, 8000) n
    `;
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, status, call_origin, tool_name, invoked_at)
      VALUES (${workspaceId}, ${ownerId}, 'error', 'agent', 'scheduler:get_next', now())
    `;
    await sql`ANALYZE harness_shared.tool_invocations`;
    type PlanNode = {
      'Relation Name'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      'Rows Removed by Filter'?: number;
      Plans?: PlanNode[];
    };
    let plan: PlanNode | undefined;
    holder.sql = new Proxy(sql, {
      apply(target, thisArg, args) {
        if (!args[0][0].includes('SELECT s.id,')) return Reflect.apply(target, thisArg, args);
        return (async () => {
          const parts = [...args[0] as TemplateStringsArray];
          parts[0] = 'EXPLAIN (ANALYZE, FORMAT JSON) ' + parts[0];
          Object.defineProperty(parts, 'raw', { value: [...parts] });
          const result = await Reflect.apply(target, thisArg, [parts, ...args.slice(1)]);
          plan = result[0]['QUERY PLAN'][0].Plan;
          return Reflect.apply(target, thisArg, args);
        })();
      },
    });
    try {
      const [probe] = await probeFreshLaunchSessions({ workspaceId, launcherOwnerId, since });
      expect(probe).toMatchObject({ successfulCalls: 8000,
        workerAttestation: { stages: { schedulerPull: { calls: 2001, successfulCalls: 2000 } } } });
    } finally {
      holder.sql = sql;
    }
    expect(plan).toBeDefined();
    const examinedRows = (node: PlanNode): number =>
      (node['Relation Name'] === 'tool_invocations'
        ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * (node['Actual Loops'] ?? 1)
        : 0) + (node.Plans ?? []).reduce((sum, child) => sum + examinedRows(child), 0);
    const examined = examinedRows(plan!);
    console.info(`FRESH_LAUNCH_PLAN examinedRows=${examined} retainedOwnerRows=8001`);
    if (examined >= 10_000) console.info(`FRESH_LAUNCH_PLAN_DETAIL ${JSON.stringify(plan)}`);
    expect(examined).toBeLessThan(10_000);
  });

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
              '{}'::jsonb, ${JSON.stringify(['psu', `--launched-by=${launcherOwnerId}`])}::text::jsonb)
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
      // Measure PG above; classify that observation without requiring network
      // IO to finish within the verifier's one-millisecond polling window.
      { probe: async () => silent, timeoutMs: 1, pollMs: 2, silenceMs: 60_000 },
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
      { probe: async () => signalling, timeoutMs: 1, pollMs: 2, silenceMs: 60_000 },
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
    const slowBootObservation = await probeFreshLaunchSessions({ workspaceId, launcherOwnerId, since });
    const slowBoot = await verifyFreshLaunchStarted(
      { workspaceId, launcherOwnerId, since, expected: 1 },
      { probe: async () => slowBootObservation, pollMs: 2, timeoutMs: 1 },
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
