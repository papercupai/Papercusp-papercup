/**
 * The stranded app-task READ against a real Postgres (P-005 of
 * app-agent-tasks-durable-execution-2026-10-06). The unit suite fakes the read;
 * this one proves the SQL selects exactly the population the guard is about —
 * open, never-claimed, app-created (trigger binding OR blueprint-operation root),
 * past the bound — and nothing else that looks like it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { fetchStrandedAppTaskGroups } from './stranded-app-tasks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const WS = 'stranded-ws';
const OTHER_WS = 'other-ws';
const NOW = new Date('2026-10-06T12:00:00Z');
const HOUR = 3_600_000;
const HEX = 'a'.repeat(64);

let db: FreshPgDb;

async function seed(row: {
  id: string;
  ws?: string;
  harness?: string;
  kind?: string;
  status?: string;
  ageHours: number;
  payload?: Record<string, unknown>;
  takenBy?: string | null;
  firstClaimed?: boolean;
  conditionKey?: string | null;
}): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, title, status, item_kind, payload, created_ts,
       taken_by, first_claimed_at, condition_key)
    VALUES (${row.id}, ${row.ws ?? WS}, ${row.harness ?? 'email'}, ${`task ${row.id}`},
            ${row.status ?? 'open'}, ${row.kind ?? 'email-draft-proposal'},
            ${db.sql.json((row.payload ?? {}) as never)}, ${NOW.getTime() - row.ageHours * HOUR},
            ${row.takenBy ?? null}, ${row.firstClaimed ? NOW.toISOString() : null}, ${row.conditionKey ?? null})`;
}

async function invocation(targetRef: string, ws = WS): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.blueprint_operation_invocations
      (workspace_id, harness_slug, caller_id, operation_id, request_key, request_fingerprint,
       specification_revision, target_kind, target_ref)
    VALUES (${ws}, 'calendar', 'calendar-app', 'meeting-prep', ${`key-${targetRef}`}, ${HEX}, ${HEX},
            'work-item', ${targetRef})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('stranded-app-tasks');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  // The shared fixture predates migration 1037's first-claim stamp; the guard reads it.
  await db.sql.unsafe('ALTER TABLE harness_shared.work_items ADD COLUMN IF NOT EXISTS first_claimed_at timestamptz');
  await db.sql.unsafe(readFileSync(resolve(SQL_DIR, '1219-blueprint-operation-invocations.sql'), 'utf8')).simple();

  const trigger = { triggerRef: 'binding:gmail-to-draft' };
  // ── The population the guard is about ──
  await seed({ id: 'WI-T1', ageHours: 24 * 30, payload: trigger }); // trigger-minted, weeks old
  await seed({ id: 'WI-T2', ageHours: 24 * 3, payload: trigger });
  await seed({ id: 'WI-O1', harness: 'calendar', kind: 'meeting-prep', ageHours: 12 }); // operation root
  await invocation('WI-O1');
  // ── Look-alikes that must NOT be counted ──
  await seed({ id: 'WI-YOUNG', ageHours: 2, payload: trigger }); // inside the bound
  await seed({ id: 'WI-CLAIMED', ageHours: 48, payload: trigger, firstClaimed: true }); // was claimed once
  await seed({ id: 'WI-HELD', ageHours: 48, payload: trigger, takenBy: 'su-1' }); // held now
  await seed({ id: 'WI-DONE', ageHours: 48, payload: trigger, status: 'done' });
  await seed({ id: 'WI-DROPPED', ageHours: 48, payload: trigger, status: 'dropped' });
  await seed({ id: 'WI-HAND', harness: 'papercusp', kind: 'feature', ageHours: 48 }); // hand-filed, not app work
  await seed({ id: 'WI-OBS', ageHours: 48, payload: { ...trigger, lane: 'observation' } });
  await seed({ id: 'WI-FLAG', harness: 'papercusp', kind: 'task', ageHours: 48, payload: trigger,
    conditionKey: 'app-task-no-executor:stranded-ws/email/email-draft-proposal' }); // the guard's own flag
  await seed({ id: 'WI-ELSEWHERE', ws: OTHER_WS, ageHours: 48, payload: trigger });
  await seed({ id: 'WI-O2', ws: OTHER_WS, harness: 'calendar', kind: 'meeting-prep', ageHours: 12 });
  await invocation('WI-O2', OTHER_WS);
  // An invocation in ANOTHER workspace naming a same-id row here must not make it app work.
  await seed({ id: 'WI-XWS', harness: 'papercusp', kind: 'feature', ageHours: 48 });
  await invocation('WI-XWS', OTHER_WS);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('fetchStrandedAppTaskGroups', () => {
  it('selects exactly the open, never-claimed, app-created rows past the bound, grouped per (harness, kind)', async () => {
    const groups = await fetchStrandedAppTaskGroups({ workspaceId: WS, boundHours: 6, now: NOW });
    expect(groups).toEqual([
      {
        workspaceId: WS,
        harnessSlug: 'calendar',
        itemKind: 'meeting-prep',
        count: 1,
        oldestId: 'WI-O1',
        oldestCreatedAt: new Date(NOW.getTime() - 12 * HOUR).toISOString(),
        sampleIds: ['WI-O1'],
        fromTrigger: 0,
        fromOperation: 1,
      },
      {
        workspaceId: WS,
        harnessSlug: 'email',
        itemKind: 'email-draft-proposal',
        count: 2,
        oldestId: 'WI-T1',
        oldestCreatedAt: new Date(NOW.getTime() - 24 * 30 * HOUR).toISOString(),
        sampleIds: ['WI-T1', 'WI-T2'],
        fromTrigger: 2,
        fromOperation: 0,
      },
    ]);
  });

  it('the bound is the only age rule: widening it drops the 12h operation root', async () => {
    const groups = await fetchStrandedAppTaskGroups({ workspaceId: WS, boundHours: 24, now: NOW });
    expect(groups.map((g) => [g.harnessSlug, g.count])).toEqual([['email', 2]]);
  });

  it('a workspace with nothing stranded reads empty, and workspaces never leak', async () => {
    const other = await fetchStrandedAppTaskGroups({ workspaceId: OTHER_WS, boundHours: 6, now: NOW });
    expect(other.map((g) => [g.harnessSlug, g.oldestId])).toEqual([
      ['calendar', 'WI-O2'],
      ['email', 'WI-ELSEWHERE'],
    ]);
    expect(await fetchStrandedAppTaskGroups({ workspaceId: 'empty-ws', boundHours: 6, now: NOW })).toEqual([]);
  });
});
