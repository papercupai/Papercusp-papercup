/**
 * set_blocker.hold.integration.test.ts — `work_items:set_blocker { kind:'hold' }` against real
 * Postgres. Plan one-work-graph-structured-holds-2026-10-26, P-010 (R-4), shaped by #D-014.
 *
 * R-4: a hold names a target that resolves, a forbidden action from the fixed vocabulary, a
 * reason, and a review date within the agent cap; the placer is the caller and never an
 * argument. Each refusal leaves the carrier's blocker record untouched. A valid hold is stored as
 * one 'hold' row (capability 'restriction-hold') whose recheckAt is the hold's reviewAt.
 *
 * Fixture: the column-faithful work-items schema from work-items-tools.integration.test.ts. The
 * hold target here is a work-item, whose registry (harness_shared.work_items) is real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEventSubstrateMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { DISCLOSURE_LEDGER_FIXTURE_DDL } from '../../../test/_disclosure-ledger-fixture';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ADMISSIONS_MIN_DDL,
  WORK_ITEM_DEPS_DDL,
  applyClaimPathReadDeps,
} from '../../../test/_work-items-schema';
import { ensureCoordCapabilityTables } from '@papercusp/coordination/capabilities';
import { HOLD_ACTIONS, HOLD_AGENT_MAX_REVIEW_DAYS } from '../../restriction-holds';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../../harness-core')>('../../harness-core');
  return { ...actual, resolveProject: async (slug: string) => ({ slug, path: `/tmp/${slug}` }) };
});
vi.mock('../../hive-federation', async () => {
  const actual = await vi.importActual<typeof import('../../hive-federation')>('../../hive-federation');
  return { ...actual, potHomeSlugForHarness: async (_ws: string, slug: string) => slug };
});
vi.mock('../../memory/recall-stats', async () => {
  const actual = await vi.importActual<typeof import('../../memory/recall-stats')>('../../memory/recall-stats');
  return { ...actual, recordRecallStats: async () => {} };
});
vi.mock('../../blueprint/operation-worker-binding', async (orig) => ({
  ...(await orig<typeof import('../../blueprint/operation-worker-binding')>()),
  readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' as const }),
}));

const { default: createTool } = await import('./create');
const { default: setBlockerTool } = await import('./set_blocker');
const { getWorkItem } = await import('../../work-items');

// resolveAgentIdentity reads uiClientId as the caller's ownerId.
const CALLER = 'su-hold-placer';
const CTX = { isSuperuser: true, uiClientId: CALLER, workspaceId: 'default' } as never;
const DAY_MS = 86_400_000;

async function call(tool: { handler: (a: never, c: never) => Promise<unknown> }, args: Record<string, unknown>) {
  const res = (await tool.handler(args as never, CTX)) as { data?: Record<string, unknown>; content?: { text: string }[] };
  if (res.data !== undefined) return res.data;
  if (res.content?.[0]?.text) return JSON.parse(res.content[0].text) as Record<string, unknown>;
  return res as Record<string, unknown>;
}

async function createFeature(title: string): Promise<string> {
  const env = await call(createTool, { kind: 'feature', title, harness: 'papercup' });
  const first = (env.results as Record<string, unknown>[])[0]!;
  return (first.workItem as Record<string, unknown>).id as string;
}

async function setBlocker(args: Record<string, unknown>) {
  const env = await call(setBlockerTool, args);
  return (env.results as Record<string, unknown>[])[0]!;
}

async function blockerRows(id: string): Promise<Record<string, unknown>[]> {
  const item = await getWorkItem(id);
  const payload = (item?.payload ?? {}) as { externalBlockers?: Record<string, unknown>[] };
  return payload.externalBlockers ?? [];
}

const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('set-blocker-hold');
  h.sql = db.sql;
  await ensureCoordCapabilityTables(db.sql);
  await db.sql.unsafe(readMigration('500-agent-modes.sql')).simple();
  await db.sql.unsafe(readMigration('767-agent-modes-subject.sql')).simple();
  await db.sql.unsafe(readMigration('1032-agent-mode-goal-holder-election.sql')).simple();
  await applyEventSubstrateMigrationsForTest(db.sql, {
    label: 'agent-tools/work_items/set_blocker.hold.integration.test.ts',
  });
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(readMigration('831-issue-occurrence-ledger.sql')).simple();
  await db.sql.unsafe(WORK_ADMISSIONS_MIN_DDL);
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await applyClaimPathReadDeps((ddl) => db.sql.unsafe(ddl).simple());
  await db.sql.unsafe(DISCLOSURE_LEDGER_FIXTURE_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps RESTART IDENTITY CASCADE`;
});

describe('work_items:set_blocker kind:hold (R-4)', () => {
  it('stores a valid hold as one restriction-hold row placed by the caller, reviewed at reviewAt', async () => {
    const carrier = await createFeature('carrier for a hold');
    const target = await createFeature('the held work-item');
    const reviewAt = inDays(7);

    const res = await setBlocker({
      id: carrier,
      kind: 'hold',
      hold: { target: { kind: 'work-item', id: target }, forbids: 'reset', reviewAt },
      summary: 'reset would discard the in-flight migration draft',
    });

    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const rows = await blockerRows(carrier);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'hold',
      capability: 'restriction-hold',
      ref: `hold:work-item:${target}:reset`,
      status: 'active',
      summary: 'reset would discard the in-flight migration draft',
    });
    expect(new Date(rows[0]!.recheckAt as string).toISOString()).toBe(new Date(reviewAt).toISOString());
    expect(rows[0]!.hold).toMatchObject({
      target: { kind: 'work-item', id: target },
      forbids: 'reset',
      placedBy: 'agent',
      placedById: CALLER,
      reason: 'reset would discard the in-flight migration draft',
    });

    // Re-asserting the same target + action upserts the same row.
    const again = await setBlocker({
      id: carrier,
      kind: 'hold',
      hold: { target: { kind: 'work-item', id: target }, forbids: 'reset', reviewAt },
      summary: 'reset would discard the in-flight migration draft',
    });
    expect(again.ok).toBe(true);
    expect((await blockerRows(carrier)).filter((row) => row.status === 'active')).toHaveLength(1);
  });

  it('refuses a target that does not resolve and writes nothing', async () => {
    const carrier = await createFeature('carrier');
    const res = await setBlocker({
      id: carrier,
      kind: 'hold',
      hold: { target: { kind: 'work-item', id: 'WI-999999999' }, forbids: 'reset', reviewAt: inDays(3) },
      summary: 'a reason',
    });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: false, code: 'hold_target_unresolved' });
    expect(await blockerRows(carrier)).toEqual([]);
  });

  it('refuses an action outside the vocabulary, an empty reason, and an over-cap reviewAt', async () => {
    const carrier = await createFeature('carrier');
    const target = await createFeature('target');
    const base = { target: { kind: 'work-item', id: target }, forbids: 'reset', reviewAt: inDays(3) };

    const badAction = await setBlocker({ id: carrier, kind: 'hold', hold: { ...base, forbids: 'touch' }, summary: 'r' });
    // The refusal must name the vocabulary, not only carry the code: parseHoldSpec re-checks
    // forbids for type narrowing, so a dropped vocabulary check still refuses, with an empty error.
    expect(badAction).toMatchObject({
      ok: false,
      code: 'hold_spec_invalid',
      error: expect.stringContaining(`forbids must be one of: ${HOLD_ACTIONS.join(', ')}.`),
    });

    const noReason = await setBlocker({ id: carrier, kind: 'hold', hold: base });
    expect(noReason).toMatchObject({ ok: false, code: 'hold_spec_invalid' });

    const overCap = await setBlocker({
      id: carrier,
      kind: 'hold',
      hold: { ...base, reviewAt: inDays(HOLD_AGENT_MAX_REVIEW_DAYS + 1) },
      summary: 'r',
    });
    expect(overCap).toMatchObject({ ok: false, code: 'hold_spec_invalid' });

    expect(await blockerRows(carrier)).toEqual([]);
  });

  it('never takes the placer as an argument, and requires reviewAt', () => {
    const hold = { target: { kind: 'work-item', id: 'WI-1' }, forbids: 'reset', reviewAt: inDays(3) };
    const schema = setBlockerTool.args as unknown as { safeParse: (v: unknown) => { success: boolean } };
    expect(schema.safeParse({ id: 'WI-2', kind: 'hold', hold, summary: 'r' }).success).toBe(true);
    expect(schema.safeParse({ id: 'WI-2', kind: 'hold', hold: { ...hold, placedBy: 'owner' }, summary: 'r' }).success).toBe(false);
    expect(schema.safeParse({ id: 'WI-2', kind: 'hold', hold: { ...hold, placedById: 'someone' }, summary: 'r' }).success).toBe(false);
    expect(schema.safeParse({ id: 'WI-2', kind: 'hold', hold, placedBy: 'owner', summary: 'r' }).success).toBe(false);
    const { reviewAt: _omit, ...noReview } = hold;
    expect(schema.safeParse({ id: 'WI-2', kind: 'hold', hold: noReview, summary: 'r' }).success).toBe(false);
    // kind 'hold' and capability 'restriction-hold' only travel together.
    expect(schema.safeParse({ id: 'WI-2', ref: 'x', kind: 'gate', capability: 'restriction-hold' }).success).toBe(false);
    expect(schema.safeParse({ id: 'WI-2', ref: 'x', kind: 'gate', hold }).success).toBe(false);
  });

  it('refuses owner placement on a turn ref that does not verify, and an owner tag without one', async () => {
    const carrier = await createFeature('carrier');
    const target = await createFeature('target');
    const hold = { target: { kind: 'work-item', id: target }, forbids: 'reset', reviewAt: inDays(3) };

    const unverified = await setBlocker({
      id: carrier,
      kind: 'hold',
      hold,
      summary: 'the owner asked for this',
      ownerTurnRef: '[turn:no-such-session@2026-10-28T00:00:00.000Z]',
    });
    expect(unverified.ok).toBe(false);

    const taggedOnly = await setBlocker({ id: carrier, kind: 'hold', hold, summary: '[owner 2026-10-28] hold resets' });
    expect(taggedOnly).toMatchObject({ ok: false, code: 'provenance_owner_tag_without_owner_kind' });

    expect(await blockerRows(carrier)).toEqual([]);
  });

  it('lets the placing agent lift an agent hold', async () => {
    const carrier = await createFeature('carrier');
    const target = await createFeature('target');
    await setBlocker({
      id: carrier,
      kind: 'hold',
      hold: { target: { kind: 'work-item', id: target }, forbids: 'reset', reviewAt: inDays(3) },
      summary: 'temporary',
    });
    const lifted = await setBlocker({ id: carrier, kind: 'hold', ref: `hold:work-item:${target}:reset`, clear: true });
    expect(lifted.ok).toBe(true);
    expect((await blockerRows(carrier)).filter((row) => row.status === 'active')).toEqual([]);
  });
});
