/**
 * Real-Postgres semantic guard for the GOAL owner-report watchdog's three-rail
 * evidence union. The unit suite pins the generated SQL shape; this fixture
 * executes that SQL so JSONB containment, legacy POSIX regexes, attribution,
 * and GREATEST/null behavior cannot drift behind a mocked template tag.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GOAL_OWNER_REPORT_FIELD,
  GOAL_OWNER_REPORT_SCHEMA_VERSION,
  type GoalOwnerReportStamp,
} from '../goal-owner-report';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { readGoalOwnerReportObligation, runGoalOwnerReportSweepOnce, goalOwnerReportConditionKey } from './goal-owner-report-watchdog';

const WS = 'goal-owner-report-pg';
const OTHER_WS = 'goal-owner-report-other';
const GOAL = 'work-on-everything-pg';
const OTHER_GOAL = 'other-goal-pg';
const OWNER = 'su-goal-owner-pg';
const OTHER_OWNER = 'su-other-owner-pg';
const BASELINE = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-01T00:10:00.000Z';
const T2 = '2026-09-01T00:20:00.000Z';
const T3 = '2026-09-01T00:30:00.000Z';
const T4 = '2026-09-01T00:40:00.000Z';
const NOW = Date.parse('2026-09-01T01:00:00.000Z');

let db: FreshPgDb;

function reportStamp(goalId = GOAL): GoalOwnerReportStamp {
  return {
    schemaVersion: GOAL_OWNER_REPORT_SCHEMA_VERSION,
    goalId,
    moved: 'P-006 verification advanced',
    cost: '12 cents measured',
    ownerWalled: 'none',
    killed: 'one stale test process',
  };
}

function legacyReport(goalId = GOAL): string {
  return [
    `GOAL: ${goalId}`,
    'MOVED — P-006 verification advanced',
    'COST — 12 cents measured',
    'OWNER-WALLED — none',
    'KILLED — one stale test process',
  ].join('\n');
}

async function insertCoord(
  surface: 'messages' | 'escalations',
  msgId: string,
  at: string,
  body: Record<string, unknown>,
  workspaceId = WS,
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.coord_event_log
      (workspace_id, surface, msg_id, body, ts)
    VALUES
      (${workspaceId}, ${surface}, ${msgId}, ${db.sql.json(body as unknown as Parameters<typeof db.sql.json>[0])}, ${at}::timestamptz)`;
}

async function insertAttention(id: string, at: string, data: Record<string, unknown>, workspaceId = WS): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.attention_notifications
      (workspace_id, kind, title, body, data, created_at)
    VALUES
      (${workspaceId}, 'goal-report', ${id}, ${id}, ${db.sql.json(data as unknown as Parameters<typeof db.sql.json>[0])}, ${at}::timestamptz)`;
}

async function lastReportAt(): Promise<string | null> {
  const obligation = await readGoalOwnerReportObligation(
    db.sql,
    { workspaceId: WS, ownerId: OWNER, goalId: GOAL },
    NOW,
  );
  expect(obligation).not.toBeNull();
  return obligation!.lastReportAt;
}

beforeAll(async () => {
  db = await createFreshPgDb('goal-owner-report');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.goals (
      id text NOT NULL,
      workspace_id text NOT NULL,
      status text NOT NULL,
      standing boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE TABLE harness_shared.agent_modes (
      workspace_id text NOT NULL,
      owner_id text NOT NULL,
      mode text NOT NULL,
      subject text,
      set_at timestamptz NOT NULL
    );
    CREATE TABLE harness_shared.coord_event_log (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      surface text NOT NULL,
      msg_id text NOT NULL,
      body jsonb NOT NULL,
      ts timestamptz NOT NULL
    );
    CREATE TABLE harness_shared.attention_notifications (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      kind text NOT NULL,
      title text NOT NULL,
      body text NOT NULL,
      data jsonb,
      created_at timestamptz NOT NULL
    );
  `);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`
    TRUNCATE harness_shared.agent_modes,
             harness_shared.goals,
             harness_shared.coord_event_log,
             harness_shared.attention_notifications
    RESTART IDENTITY`;
  await db.sql`
    INSERT INTO harness_shared.goals
      (id, workspace_id, status, standing, created_at)
    VALUES
      (${GOAL}, ${WS}, 'active', true, ${BASELINE}::timestamptz),
      (${OTHER_GOAL}, ${WS}, 'active', true, ${BASELINE}::timestamptz)`;
  await db.sql`
    INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, mode, subject, set_at)
    VALUES
      (${WS}, ${OWNER}, 'goal', ${GOAL}, ${BASELINE}::timestamptz)`;
});

describe('GOAL owner-report evidence union (real PostgreSQL)', () => {
  it('opens the original detector and recovers from exact real-PG report evidence beyond candidate absence', async () => {
    const now = NOW + 3600_000;
    const key = goalOwnerReportConditionKey({ workspaceId: WS, goalId: GOAL, agentId: OWNER });
    const broadcast = vi.fn(async () => true), resolve = vi.fn(async () => true);
    const deps = { now: () => now, flagEnabled: async () => true, readOpenConditionKeys: async () => [] as string[],
      resolveLiveness: async () => new Map([[OWNER, { ownerId: OWNER, sessionState: 'live' as const,
        wakeable: true, liveTurn: true, confirmLiveness: null, heartbeatFresh: true }]]),
      escalate: async () => ({ coalesced: true }), nudge: async () => {}, rail: { broadcast, resolve } };
    await runGoalOwnerReportSweepOnce(db.sql, deps);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key, oneShot: true }));
    const restart = { ...deps, readGoalModeOwners: async () => [], readOpenConditionKeys: async () => [key] };
    const freshAt = '2026-09-01T01:50:00.000Z';
    await insertCoord('messages', 'foreign-owner', freshAt, { from: OTHER_OWNER, to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp() });
    await insertCoord('messages', 'foreign-goal', freshAt, { from: OWNER, to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(OTHER_GOAL) });
    await insertCoord('messages', 'foreign-workspace', freshAt, { from: OWNER, to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp() }, OTHER_WS);
    await runGoalOwnerReportSweepOnce(db.sql, restart);
    expect(resolve).not.toHaveBeenCalled();
    await insertCoord('messages', 'measured-exact-report', freshAt, { from: OWNER, to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp() });
    await runGoalOwnerReportSweepOnce(db.sql, restart);
    expect(resolve).toHaveBeenCalledWith({ conditionKey: key, summary: 'goal-owner-report-watchdog recovered' });
    resolve.mockClear();
    await db.sql`UPDATE harness_shared.goals SET status = 'paused' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    await runGoalOwnerReportSweepOnce(db.sql, restart);
    expect(resolve).not.toHaveBeenCalled();
    await db.sql`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    await runGoalOwnerReportSweepOnce(db.sql, restart);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the newest complete exact-goal stamp from escalation, human-send, or attributed attention', async () => {
    expect(await lastReportAt()).toBeNull();

    await insertCoord('escalations', 'valid-escalation', T1, {
      from: OWNER,
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    expect(await lastReportAt()).toBe(T1);

    await insertCoord('messages', 'valid-human-send', T2, {
      from: OWNER,
      to: ['peer', 'human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    expect(await lastReportAt()).toBe(T2);

    await insertAttention('valid-attention', T3, {
      ownerId: OWNER,
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    expect(await lastReportAt()).toBe(T3);

    // A newer ordinary ping cannot displace the last valid report.
    await insertCoord('messages', 'newer-ping', T4, {
      from: OWNER,
      to: ['human'],
      body: `Routine FYI about ${GOAL}; MOVED / COST / OWNER-WALLED / KILLED`,
    });
    expect(await lastReportAt()).toBe(T3);
  });

  it('rejects arbitrary, partial, wrong-subject, wrong-owner, wrong-workspace, and non-human rows', async () => {
    await insertCoord('messages', 'arbitrary-human-ping', T1, {
      from: OWNER,
      to: ['human'],
      body: `Routine FYI about ${GOAL}`,
    });
    await insertCoord('messages', 'partial-stamp', T2, {
      from: OWNER,
      to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: { ...reportStamp(), killed: '' },
    });
    await insertCoord('escalations', 'wrong-goal', T3, {
      from: OWNER,
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(OTHER_GOAL),
    });
    await insertCoord('messages', 'wrong-owner', T4, {
      from: OTHER_OWNER,
      to: ['human'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    await insertCoord(
      'messages',
      'wrong-workspace',
      T4,
      {
        from: OWNER,
        to: ['human'],
        [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
      },
      OTHER_WS,
    );
    await insertCoord('messages', 'not-to-human', T4, {
      from: OWNER,
      to: ['peer'],
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    await insertAttention('unattributed-attention', T4, {
      [GOAL_OWNER_REPORT_FIELD]: reportStamp(),
    });
    await insertCoord('messages', 'partial-legacy', T4, {
      from: OWNER,
      to: ['human'],
      body: legacyReport().replace('KILLED — one stale test process', 'KILLED —'),
    });

    expect(await lastReportAt()).toBeNull();
  });

  it('keeps complete exact-goal legacy reports on coord rails, never on unattributed attention', async () => {
    await insertCoord('messages', 'legacy-human', T1, {
      from: OWNER,
      to: ['human'],
      body: legacyReport(),
    });
    expect(await lastReportAt()).toBe(T1);

    await insertCoord('escalations', 'legacy-escalation', T2, {
      from: OWNER,
      body: legacyReport(),
    });
    expect(await lastReportAt()).toBe(T2);

    await insertAttention('legacy-attention-is-not-attributed-evidence', T3, {
      ownerId: OWNER,
      body: legacyReport(),
    });
    expect(await lastReportAt()).toBe(T2);
  });
});
