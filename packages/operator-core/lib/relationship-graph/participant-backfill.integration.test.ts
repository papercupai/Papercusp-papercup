/**
 * Participant backfill (plan crm-agent-sales-onboarding-apps-2026-10-06 P-003, decision D-017 point 2).
 *
 * Measured on a migrated throwaway database through the production seams: interactions stored in
 * an owner's Personal Vault are read through the team metadata path (readTeamInteractions,
 * addresses only) and projected into the relationship graph through the same participant chain
 * live delivery uses. A source's `person -> record` routing is the grant (D-013 point 4): an
 * ungranted source contributes nobody, and replaying the backfill adds no person.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { setPersonalVaultEnabled, upsertPersonalDocuments } from '../personal-vault/store';
import type { PersonalToolContext } from '../personal-vault/types';
import { backfillInteractionParticipants, runPendingParticipantBackfills } from './participant-backfill';
import { createInteractionParticipantSink } from './participants';
import { searchPeople } from './people';
import { graphDefaultHarness } from './resolver';

// createWorkItem / mergeWorkItemPayload write through the shared org pool, not the `sql` handed to
// the sinks. Without this redirect they write to whatever database the process is configured for,
// which on the dev box is the LIVE one (they did, once: two DSR- rows, deleted).
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'papercusp-workspace',
}));

// The `person` datatype is registered for this workspace only (migration 1383), and the record
// sink needs it: a workspace without it gets no person -> record sink, so nothing is granted.
const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const CTX: PersonalToolContext = { workspaceId: WS, role: 'crm-sales-agent' };
const OWNER = 'owner@me.example';
const LEAD = 'lead@prospect.example';
const ATTENDEE = 'attendee@ungranted.example';

let org: OrgTestDb;
let sql: postgres.Sql;
let userId: string;
let mailSource: string;
let calendarSource: string;

async function connect(
  kind: string,
  policy: Record<string, string[]>,
  config: Record<string, string> = { harnessSlug: HARNESS },
): Promise<{ id: string; account: string }> {
  const account = `${kind}-account-${randomUUID()}`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${userId}, ${account}, 'connected',
            ${sql.json(config)}, 'personal',
            ${sql.json(policy)}, ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  return { id: row!.id, account };
}

async function personIds(): Promise<string[]> {
  const rows = await sql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND item_kind = 'person' AND feature_id LIKE 'PER-%'
       AND (payload->>'mergedInto') IS NULL
     ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  // Migration 1415 (participant_backfill_cursor) is idempotent, so it is applied here whether or not
  // the throwaway database already ran it: the armed file first, its draft before it is armed.
  // MIGRATION_1415_PATH points at a copy, which is how scripts/mutation-probe.sh proves it can fail.
  const armed1415 = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1415-participant-backfill-cursor.sql', import.meta.url));
  await sql.unsafe(readFileSync(process.env.MIGRATION_1415_PATH ?? (existsSync(armed1415) ? armed1415 : `${armed1415}.DRAFT`), 'utf8'));
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${'participant-backfill-' + Date.now()}, 'Participant backfill')
    RETURNING id`;
  userId = user!.id;
  await setPersonalVaultEnabled(sql, WS, userId, true, 'test');

  const mail = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] });
  const calendar = await connect('gcal', { 'calendar-event': ['document', 'event'] });
  mailSource = mail.id;
  calendarSource = calendar.id;
  await upsertPersonalDocuments(sql, WS, userId, [
    {
      source: 'gmail',
      sourceId: mail.id,
      providerAccountId: mail.account,
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-05T15:00:00Z',
      participants: [LEAD, OWNER],
      title: 'Trial and security review',
      text: 'Happy to start a trial next week.',
      metadata: { from: LEAD, to: [OWNER] },
    },
    {
      source: 'gcal',
      sourceId: calendar.id,
      providerAccountId: calendar.account,
      kind: 'calendar-event',
      externalId: `evt-${randomUUID()}`,
      occurredAt: '2026-10-07T17:00:00Z',
      participants: [ATTENDEE, OWNER],
      title: 'Onboarding call',
      text: 'Agenda: install and first plan.',
      metadata: { organizer: OWNER, attendees: [ATTENDEE] },
    },
  ]);
}, 120_000);

afterAll(async () => {
  if (org && userId) {
    // Scoped to this file's own rows: the workspace is shared with other graph tests.
    const ids = [mailSource, calendarSource].filter(Boolean);
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND item_kind = 'person'
               AND (feature_id LIKE 'PER-%' OR payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[]))`.catch(() => {});
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`.catch(() => {});
    for (const table of ['personal_disclosures', 'personal_grants', 'personal_documents']) {
      await sql.unsafe(`DELETE FROM harness_shared.${table} WHERE workspace_id = $1 AND user_id = $2::uuid`, [WS, userId]).catch(() => {});
    }
    await sql`DELETE FROM harness_shared.personal_vault_settings WHERE workspace_id = ${WS} AND user_id = ${userId}::uuid`.catch(() => {});
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND owner_user_id = ${userId}::uuid`.catch(() => {});
    await sql`DELETE FROM harness_shared.users WHERE id = ${userId}`.catch(() => {});
  }
  await org?.cleanup();
});

describe('interaction participant backfill (P-003, D-017 point 2)', () => {
  it('refuses a coding role before reading anything', async () => {
    const result = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: { workspaceId: WS, role: 'engineer' } });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: 'coding_agent_denied' });
    expect(await personIds()).toEqual([]);
  });

  it('projects participants of stored interactions from a granted source only, and a replay adds no person', async () => {
    // Measure the real sink boundaries rather than inferring delivery latency from a lookup query.
    const timings: Record<string, { calls: number; ms: number }> = {};
    const start = performance.now();
    const result = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: CTX, timings });
    console.info('PARTICIPANT_BACKFILL_STAGE_TIMINGS', JSON.stringify({ totalMs: performance.now() - start, sinks: timings }));
    expect(timings['data-source-record']?.calls).toBe(2);
    expect(timings['relationship-graph-resolve']?.calls).toBe(2);
    expect(timings['team-metadata']?.calls).toBe(1);
    expect(timings['document-page']?.calls).toBeGreaterThanOrEqual(1);
    expect(Object.values(timings).every((timing) => timing.ms >= 0)).toBe(true);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const bySource = Object.fromEntries(result.sources.map((s) => [s.sourceId, s]));
    expect(bySource[mailSource]).toEqual({ sourceId: mailSource, datatype: 'email-message', granted: true, documents: 1, participants: 2 });
    // Positive control for the ungranted case: the calendar document IS stored (it is listed), so
    // the zero below is the grant, not a missing fixture.
    expect(bySource[calendarSource]).toEqual({ sourceId: calendarSource, datatype: 'calendar-event', granted: false, documents: 0, participants: 0 });

    const lead = await searchPeople(sql, WS, { emails: [LEAD] });
    expect(lead.map((p) => p.emails)).toEqual([[LEAD]]);
    expect(lead[0]!.id).toMatch(/^PER-/);
    expect(await searchPeople(sql, WS, { emails: [ATTENDEE] })).toEqual([]);

    const before = await personIds();
    expect(before).toHaveLength(2); // LEAD and OWNER from the one granted email
    const replay = await backfillInteractionParticipants(sql, { workspaceId: WS, userId, ctx: CTX });
    expect(replay.ok).toBe(true);
    expect(await personIds()).toEqual(before);
  });

  it('the platform sweep backfills each granted source once per grant (D-018, migration 1394)', async () => {
    const marker = async (id: string) =>
      (await sql<{ at: Date | null }[]>`SELECT participant_backfill_at AS at FROM harness_shared.data_sources WHERE id = ${id}::uuid`)[0]!.at;
    // Isolate from the previous case's direct calls: the marker is only written by the sweep.
    await sql`UPDATE harness_shared.data_sources SET participant_backfill_at = NULL WHERE workspace_id = ${WS}`;

    const first = await runPendingParticipantBackfills(sql, { workspaceId: WS });
    // Only the granted mail source is pending; the ungranted calendar source is never picked.
    expect(first).toEqual([{ sourceId: mailSource, outcome: 'backfilled', documents: 1, participants: 2 }]);
    expect(await marker(mailSource)).not.toBeNull();
    expect(await marker(calendarSource)).toBeNull();
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS })).toEqual([]);

    // Revoking keeps the stamp; granting again clears it, so the next tick backfills again.
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy - 'person' WHERE id = ${mailSource}::uuid`;
    expect(await marker(mailSource)).not.toBeNull();
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy || '{"person":["record"]}'::jsonb WHERE id = ${mailSource}::uuid`;
    expect(await marker(mailSource)).toBeNull();
    expect((await runPendingParticipantBackfills(sql, { workspaceId: WS })).map((r) => [r.sourceId, r.outcome])).toEqual([[mailSource, 'backfilled']]);

    // Granting the calendar source makes it pending too; its attendee then enters the graph.
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy || '{"person":["record"]}'::jsonb WHERE id = ${calendarSource}::uuid`;
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS })).toEqual([
      { sourceId: calendarSource, outcome: 'backfilled', documents: 1, participants: 2 },
    ]);
    expect((await searchPeople(sql, WS, { emails: [ATTENDEE] })).map((p) => p.emails)).toEqual([[ATTENDEE]]);
  });

  it('a personal source with no harness of its own builds its participant sink and lands in the graph home harness (D-019, WI-10006570)', async () => {
    // The built-in Google sources carry no config.harnessSlug. Before D-019 granting them
    // person -> record made the sink BUILD throw data_source_harness_missing, aborting the sync.
    const BARE = 'bare@harnessless.example';
    const bare = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] }, {});
    await upsertPersonalDocuments(sql, WS, userId, [{
      source: 'gmail',
      sourceId: bare.id,
      providerAccountId: bare.account,
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-06T09:00:00Z',
      participants: [BARE],
      title: 'Harnessless source',
      text: 'body never leaves the Vault',
      metadata: { from: BARE },
    }]);

    const errors: unknown[] = [];
    const sink = await createInteractionParticipantSink(sql, { workspaceId: WS, sourceId: bare.id, datatype: 'email-message' }, { onChainError: (cause) => errors.push(cause) });
    expect(errors).toEqual([]);
    expect(sink?.kind).toBe('relationship-graph-participants');

    const run = await runPendingParticipantBackfills(sql, { workspaceId: WS });
    expect(run).toEqual([{ sourceId: bare.id, outcome: 'backfilled', documents: 1, participants: 1 }]);
    const [person] = await searchPeople(sql, WS, { emails: [BARE] });
    expect(person?.emails).toEqual([BARE]);
    const rows = await sql<{ harness_slug: string }[]>`
      SELECT DISTINCT harness_slug FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND item_kind = 'person' AND payload->>'dataSourceId' = ${bare.id}`;
    expect(rows.map((r) => r.harness_slug)).toEqual([graphDefaultHarness()]);
  });

  it('a time-boxed sweep resumes from its saved cursor: every document exactly once across ticks, then stamped (WI-10006999, migration 1415)', async () => {
    // Before WI-10006999 the sweep walked a whole mailbox in one call with its position in memory,
    // so a large source held the connector-sync tick for many minutes and no sync ran meanwhile.
    const TOTAL = 7;
    const big = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] });
    const addresses = Array.from({ length: TOTAL }, (_, i) => `contact-${i}@timeboxed.example`);
    await upsertPersonalDocuments(sql, WS, userId, addresses.map((address, i) => ({
      source: 'gmail',
      sourceId: big.id,
      providerAccountId: big.account,
      kind: 'email',
      externalId: `msg-${i}-${randomUUID()}`,
      occurredAt: '2026-10-06T10:00:00Z',
      participants: [address],
      title: `Message ${i}`,
      text: 'body never leaves the Vault',
      metadata: { from: address },
    })));
    const state = async () =>
      (await sql<{ at: Date | null; cursor: { kind: string; afterId: string } | null }[]>`
        SELECT participant_backfill_at AS at, participant_backfill_cursor AS cursor
          FROM harness_shared.data_sources WHERE id = ${big.id}::uuid`)[0]!;

    // A clock that moves 1 ms per read: with a 6 ms budget each sweep stops after a few documents.
    let t = 0;
    const now = () => t++;
    const first = await runPendingParticipantBackfills(sql, { workspaceId: WS, batchSize: 3, budgetMs: 6, now });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ sourceId: big.id, outcome: 'partial' });
    expect(first[0]!.documents).toBeGreaterThan(0);
    expect(first[0]!.documents).toBeLessThan(TOTAL);
    const afterFirst = await state();
    expect(afterFirst.at).toBeNull();
    expect(afterFirst.cursor).toMatchObject({ kind: 'email' });
    expect(afterFirst.cursor!.afterId).toMatch(/^[0-9a-f-]{36}$/);

    const runs = [first[0]!];
    for (let i = 0; i < 10 && runs.at(-1)!.outcome === 'partial'; i += 1) {
      const next = await runPendingParticipantBackfills(sql, { workspaceId: WS, batchSize: 3, budgetMs: 6, now });
      expect(next).toHaveLength(1);
      runs.push(next[0]!);
    }
    expect(runs.length).toBeGreaterThan(2); // it really took several ticks
    expect(runs.at(-1)!.outcome).toBe('backfilled');
    expect(runs.slice(0, -1).every((r) => r.outcome === 'partial')).toBe(true);
    // Resuming, not restarting: the per-tick counts add up to the mailbox exactly.
    expect(runs.reduce((n, r) => n + r.documents, 0)).toBe(TOTAL);
    expect(runs.reduce((n, r) => n + r.participants, 0)).toBe(TOTAL);
    const done = await state();
    expect(done.at).not.toBeNull();
    expect(done.cursor).toBeNull();
    for (const address of addresses) {
      expect((await searchPeople(sql, WS, { emails: [address] })).map((p) => p.emails)).toEqual([[address]]);
    }
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS, budgetMs: 6, now })).toEqual([]);

    // A re-grant starts over: the trigger clears the cursor together with the marker.
    await sql`UPDATE harness_shared.data_sources
                 SET destination_policy = destination_policy - 'person',
                     participant_backfill_cursor = ${sql.json({ kind: 'email', afterId: afterFirst.cursor!.afterId })}
               WHERE id = ${big.id}::uuid`;
    expect((await state()).cursor).not.toBeNull();
    await sql`UPDATE harness_shared.data_sources SET destination_policy = destination_policy || '{"person":["record"]}'::jsonb WHERE id = ${big.id}::uuid`;
    expect(await state()).toEqual({ at: null, cursor: null });
    const regrant = await runPendingParticipantBackfills(sql, { workspaceId: WS });
    expect(regrant).toEqual([{ sourceId: big.id, outcome: 'backfilled', documents: TOTAL, participants: TOTAL }]);
  });

  it.each(['repeated', 'distinct'] as const)('%s participants across multiple pages retain their identities on replay (WI-10007028)', async (population) => {
    const total = 240;
    const repeated = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] });
    const addresses = [`${population}-a@profile.example`, `${population}-b@profile.example`];
    const participantsAt = (i: number) => population === 'repeated'
      ? addresses
      : [`distinct-${i}@profile.example`, addresses[1]!];
    const expectedAddresses = [...new Set(Array.from({ length: total }, (_, i) => participantsAt(i)).flat())];
    await upsertPersonalDocuments(sql, WS, userId, Array.from({ length: total }, (_, i) => ({
      source: 'gmail', sourceId: repeated.id, providerAccountId: repeated.account,
      kind: 'email', externalId: `profile-${i}-${randomUUID()}`,
      occurredAt: '2026-10-06T12:00:00Z', participants: participantsAt(i),
      title: `Fixture ${i}`, text: 'fixture body stays in the Vault',
      metadata: { from: participantsAt(i)[0], to: [participantsAt(i)[1]] },
    })));
    const idsBefore = await personIds();
    for (const phase of ['first', 'replay']) {
      const timings: Record<string, { calls: number; ms: number }> = {};
      const start = performance.now();
      const result = await backfillInteractionParticipants(sql, {
        workspaceId: WS, userId, ctx: CTX, sourceIds: [repeated.id], batchSize: 5, timings,
      });
      console.info('PARTICIPANT_BACKFILL_REPEATED_TIMINGS', JSON.stringify({
        population, phase, documents: total, totalMs: performance.now() - start, stages: timings,
      }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.reason);
      expect(result.documents).toBe(total);
      expect(result.participants).toBe(total * addresses.length);
      expect(timings['document-page']?.calls).toBeGreaterThanOrEqual(Math.ceil(total / 5));
      expect(timings['data-source-record']?.calls).toBe(total * addresses.length);
      expect(timings['relationship-graph-resolve']?.calls).toBe(total * addresses.length);
      expect(timings['resolver-lock-acquire']?.calls).toBe(total * addresses.length);
      expect(timings['resolver-load-component']?.calls).toBe(total * addresses.length);
      expect(timings['resolver-merge']?.calls).toBeGreaterThanOrEqual(total * addresses.length);
      expect(Object.values(timings).every(({ ms }) => Number.isFinite(ms) && ms >= 0)).toBe(true);
      expect(await personIds()).toHaveLength(idsBefore.length + expectedAddresses.length);
      for (const address of expectedAddresses) {
        expect((await searchPeople(sql, WS, { emails: [address] })).map((p) => p.emails)).toEqual([[address]]);
      }
    }
    // Keep the sweep cases below independent of this direct-call fixture.
    await sql`UPDATE harness_shared.data_sources SET participant_backfill_at = now() WHERE id = ${repeated.id}::uuid`;
  }, 120_000);

  it('an exhausted budget starts no further source in that sweep', async () => {
    const waiting = await connect('gmail', { 'email-message': ['document', 'event'], person: ['record'] });
    await upsertPersonalDocuments(sql, WS, userId, [{
      source: 'gmail',
      sourceId: waiting.id,
      providerAccountId: waiting.account,
      kind: 'email',
      externalId: `msg-${randomUUID()}`,
      occurredAt: '2026-10-06T11:00:00Z',
      participants: ['waiting@timeboxed.example'],
      title: 'Waiting',
      text: 'body never leaves the Vault',
      metadata: { from: 'waiting@timeboxed.example' },
    }]);
    // budgetMs 0: the deadline has already passed at the first check.
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS, budgetMs: 0 })).toEqual([]);
    expect(await runPendingParticipantBackfills(sql, { workspaceId: WS })).toEqual([
      { sourceId: waiting.id, outcome: 'backfilled', documents: 1, participants: 1 },
    ]);
  });
});
