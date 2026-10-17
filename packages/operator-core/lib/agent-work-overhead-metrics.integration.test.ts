import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { measureWorkOverheadWindow, rateWorkOverhead } from './agent-work-overhead-metrics';

let db: FreshPgDb;
const window = { workspaceId: 'ws', harnessSlug: 'papercusp',
  windowStart: '2026-10-15T10:00:00Z', windowEnd: '2026-10-15T13:00:00Z' };

beforeAll(async () => {
  db = await createFreshPgDb('work-overhead');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL);
    CREATE TABLE harness_shared.adv_sessions (
      workspace_id text NOT NULL, plan_slug text, coord_owner_id text, session_id text,
      started_at timestamptz NOT NULL, ended_at timestamptz);
    CREATE TABLE harness_shared.coord_event_log (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, surface text NOT NULL,
      writer_key text NOT NULL, ts timestamptz NOT NULL, body jsonb NOT NULL);
    CREATE TABLE harness_shared.session_identity_activation_events (
      id bigserial PRIMARY KEY, workspace_id text NOT NULL, owner_id text NOT NULL,
      adv_session_id bigint, native_session_id text, phase text NOT NULL,
      source text NOT NULL, transition_id text NOT NULL, recorded_at timestamptz NOT NULL);
    CREATE TABLE harness_shared.session_turn_parts (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
      owner text, part_idx int NOT NULL, ts timestamptz, speaker text NOT NULL,
      part_kind text NOT NULL, tool_name text, text text NOT NULL,
      PRIMARY KEY(workspace_id,source_kind,session_id,part_idx));
  `);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.session_turn_parts, harness_shared.adv_sessions,
    harness_shared.harness_plans, harness_shared.coord_event_log,
    harness_shared.session_identity_activation_events RESTART IDENTITY`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans VALUES
      ('ws','papercusp','plan'), ('foreign-ws','papercusp','plan'), ('ws','other-harness','other-plan')`;
  await db.sql`
    INSERT INTO harness_shared.adv_sessions VALUES
      ('ws','plan','stable-owner','native-a','2026-10-15T09:00:00Z',NULL),
      ('foreign-ws','plan','foreign-owner','foreign-native','2026-10-15T09:00:00Z',NULL),
      ('ws','other-plan','other-owner','other-native','2026-10-15T09:00:00Z',NULL)`;
  await db.sql`
    INSERT INTO harness_shared.session_turn_parts VALUES
      ('default','codex','native-a','stable-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','capability:read','{}'),
      ('ws','codex','native-a','stable-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-a','stable-owner',1,'2026-10-15T10:01:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-a','stable-owner',2,'2026-10-15T10:50:00Z','assistant','text',NULL,'done'),
      ('default','codex','native-b','stable-owner',0,'2026-10-15T11:00:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-b','stable-owner',1,'2026-10-15T11:01:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','native-b','stable-owner',2,'2026-10-15T12:10:00Z','assistant','text',NULL,'done'),
      ('default','codex','boundary','stable-owner',0,'2026-10-15T09:59:00Z','assistant','text',NULL,'before window'),
      ('default','codex','boundary','stable-owner',1,'2026-10-15T10:10:00Z','assistant','tool_use','capability:read','{}'),
      ('default','codex','foreign-native','foreign-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','plans:audit','{}'),
      ('default','codex','other-native','other-owner',0,'2026-10-15T10:00:00Z','assistant','tool_use','plans:audit','{}')`;
});

describe('work-overhead query against real Postgres', () => {
  async function declare(plan: string | null, at: string, opts: {
    workspace?: string; harness?: string; sender?: string;
  } = {}) {
    await db.sql`INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, ts, body)
      VALUES (${opts.workspace ?? 'ws'}, 'messages', 'stable-owner', ${at},
        ${db.sql.json({ from: opts.sender ?? 'stable-owner', lifecycle: 'intent',
          plan_slug: plan, harness_slug: opts.harness ?? 'papercusp' })})`;
  }

  async function identity(native: string, at: string, opts: {
    workspace?: string; owner?: string; advId?: number; source?: string;
    phase?: string; after?: number;
  } = {}) {
    const [row] = await db.sql`INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id, owner_id, adv_session_id, native_session_id, phase, source, transition_id, recorded_at)
      VALUES (${opts.workspace ?? 'ws'}, ${opts.owner ?? 'stable-owner'}, ${opts.advId ?? 1},
        ${native}, ${opts.phase ?? 'applied'}, ${opts.source ?? 'reanchor'},
        ${`session-activation:fixture:reanchor:${native}:after:${opts.after ?? 0}`}, ${at})
      RETURNING id`;
    return Number(row!.id);
  }

  it('recovers closed predecessors after the launcher overwrites its native id and terminal stamp', async () => {
    await declare('plan', '2026-10-15T09:00:00Z');
    await db.sql`UPDATE harness_shared.adv_sessions SET session_id = 'native-c',
      started_at = '2026-10-15T12:20:00Z', ended_at = NULL WHERE coord_owner_id = 'stable-owner'`;
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    const b = await identity('native-b', '2026-10-15T10:55:00Z', { after: a });
    await identity('native-c', '2026-10-15T12:20:00Z', { after: b });
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.population).toMatchObject({ sessions: 2, toolCalls: 4, censoredSessions: 0 });
    expect(metrics.medianObservedSessionMinutes).toBe(60);
  });

  it('rates short closed contexts as failed while the same ongoing population remains unknown', async () => {
    await db.sql`UPDATE harness_shared.session_turn_parts SET ts =
      CASE session_id WHEN 'native-a' THEN '2026-10-15T10:20:00Z'::timestamptz
        ELSE '2026-10-15T11:30:00Z'::timestamptz END
      WHERE session_id IN ('native-a', 'native-b') AND part_idx = 2`;
    expect(rateWorkOverhead(await measureWorkOverheadWindow(window, db.sql)).sessionMinutes.verdict).toBe('unknown');
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    const b = await identity('native-b', '2026-10-15T10:55:00Z', { after: a });
    await identity('native-c', '2026-10-15T12:20:00Z', { after: b });
    const closed = await measureWorkOverheadWindow(window, db.sql);
    expect(closed.medianObservedSessionMinutes).toBe(25);
    expect(rateWorkOverhead(closed).sessionMinutes.verdict).toBe('fail');
  });

  it.each([
    ['foreign workspace', { workspace: 'foreign-ws' }, '2026-10-15T12:20:00Z'],
    ['foreign owner', { owner: 'foreign-owner' }, '2026-10-15T12:20:00Z'],
    ['different launcher', { advId: 2 }, '2026-10-15T12:20:00Z'],
    ['control change', { source: 'control' }, '2026-10-15T12:20:00Z'],
    ['pending reanchor', { phase: 'prepared' }, '2026-10-15T12:20:00Z'],
    ['after cutoff', {}, '2026-10-15T13:00:01Z'],
    ['unlinked reanchor', { after: 999 }, '2026-10-15T12:20:00Z'],
  ] as const)('keeps contexts censored for %s', async (_name, opts, at) => {
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    await identity('native-c', at, { after: a, ...opts });
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.population.censoredSessions).toBe(2);
  });

  it('does not interpret a same-native reanchor as closure', async () => {
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    await identity('native-a', '2026-10-15T12:20:00Z', { after: a });
    expect((await measureWorkOverheadWindow(window, db.sql)).population.censoredSessions).toBe(2);
  });

  it('ignores a post-cutoff return when resolving closure at the original cutoff', async () => {
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    const b = await identity('native-b', '2026-10-15T10:55:00Z', { after: a });
    await identity('native-a', '2026-10-15T13:00:01Z', { after: b });
    expect((await measureWorkOverheadWindow(window, db.sql)).population.censoredSessions).toBe(1);
  });

  it('keeps a returned-to native context censored and retains its original first event', async () => {
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    const b = await identity('native-b', '2026-10-15T10:55:00Z', { after: a });
    await identity('native-a', '2026-10-15T12:20:00Z', { after: b });
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.population.censoredSessions).toBe(1);
    expect(metrics.medianObservedSessionMinutes).toBe(60);
  });

  it('keeps a predecessor censored when its transcript continues after the reanchor', async () => {
    const a = await identity('native-a', '2026-10-15T09:50:00Z', { source: 'launch' });
    await identity('native-c', '2026-10-15T10:30:00Z', { after: a });
    expect((await measureWorkOverheadWindow(window, db.sql)).population.censoredSessions).toBe(2);
  });

  it('retains historical plan work after a planless launcher resumes beyond the window', async () => {
    await db.sql`UPDATE harness_shared.adv_sessions SET plan_slug = NULL,
      started_at = '2026-10-15T14:00:00Z', session_id = 'resumed-native'
      WHERE coord_owner_id = 'stable-owner'`;
    await declare('plan', '2026-10-15T09:00:00Z');
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.population).toMatchObject({ sessions: 2, boundarySessions: 1, toolCalls: 4 });
    expect(metrics.medianObservedSessionMinutes).toBe(60);
  });

  it.each([
    { plan: null, harness: 'papercusp' },
    { plan: 'other-plan', harness: 'other-harness' },
    { plan: 'plan', harness: 'other-harness' },
  ])('ends historical membership at a clear or harness move: %j', async ({ plan, harness }) => {
    await declare('plan', '2026-10-15T09:00:00Z');
    await declare(plan, '2026-10-15T11:00:00Z', { harness });
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    // The original plan-bound launch must not override a later explicit move.
    expect(metrics.population).toMatchObject({ sessions: 1, boundarySessions: 1, toolCalls: 2 });
    expect(metrics.medianObservedSessionMinutes).toBe(50);
  });

  it('does not reconstruct membership from foreign or differently authored declarations', async () => {
    await db.sql`UPDATE harness_shared.adv_sessions SET plan_slug = NULL WHERE coord_owner_id = 'stable-owner'`;
    await declare('plan', '2026-10-15T09:00:00Z', { workspace: 'foreign-ws' });
    await declare('plan', '2026-10-15T09:00:00Z', { sender: 'another-owner' });
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.population.sessions).toBe(0);
    expect(rateWorkOverhead(metrics).acceptanceShare.verdict).toBe('unknown');
  });

  it('finds a native successor through owner/process membership, separates contexts and deduplicates partitions', async () => {
    const metrics = await measureWorkOverheadWindow(window, db.sql);
    expect(metrics.unavailableReason).toBeNull();
    expect(metrics.population).toMatchObject({ sessions: 2, boundarySessions: 1, toolCalls: 4,
      clients: { codex: 2 }, censoredSessions: 2 });
    expect(metrics.medianObservedSessionMinutes).toBe(60);
    expect(metrics.time).toMatchObject({ activeMs: 120_000, acceptanceMs: 0 });
    expect(rateWorkOverhead(metrics)).toMatchObject({ acceptanceShare: { verdict: 'pass' }, sessionMinutes: { verdict: 'pass' } });
  });
  it('excludes an event at the exclusive end and keeps a missing timestamp unknown', async () => {
    const beforeSuccessor = await measureWorkOverheadWindow({ ...window, windowEnd: '2026-10-15T11:00:00Z' }, db.sql);
    expect(beforeSuccessor.population.sessions).toBe(1);
    expect(beforeSuccessor.medianObservedSessionMinutes).toBe(50);
    await db.sql`
      INSERT INTO harness_shared.session_turn_parts VALUES
      ('default','codex','native-a','stable-owner',3,NULL,'assistant','tool_use','plans:audit','{}')`;
    const missing = await measureWorkOverheadWindow(window, db.sql);
    expect(missing.population.missingTimestampSessions).toBe(1);
    expect(rateWorkOverhead(missing).acceptanceShare.verdict).toBe('unknown');
  });
});
