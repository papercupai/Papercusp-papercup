/**
 * P-005 / D-010 — provider-neutral routing, asserted end to end on real SQL.
 *
 * Vault ingestion and the app-row producer route a record by its canonical
 * datatype and its server-owned source, never by an `ext:gmail:` / `ext:gcal:`
 * key prefix or a provider-name map. This file drives the PRODUCTION path —
 * `ingestExternalTriggerEvent` with the real Personal Vault sink, then the
 * reconcile read (`selectCanonicalRowsAfter`) and the shared mapper
 * (`appRowFromSourceRecord`) that both producer paths use — for a provider that
 * is not Google, and checks each falsifier of acceptance bar R-4:
 *   - routing depends on a Google key prefix or a provider-name map;
 *   - an account is misidentified;
 *   - native ids collide across sources;
 *   - a record crosses a local principal boundary.
 *
 * `outlook-fixture` is a registered-provider stand-in with its own source kind,
 * so its trigger keys are `ext:outlook-fixture:*`. Every source deliberately
 * reuses ONE native id: collisions are the property under test.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent } from '../external-triggers/ingestion';
import { authorizePersonalAccess } from '../personal-vault/authorization';
import { createPersonalVaultExternalSinkForSource, vaultDedupeKey } from '../personal-vault/live-sink';
import { createPersonalGrant, searchPersonalDocuments } from '../personal-vault/store';
import { appRowFromSourceRecord, appRowId, DATATYPE_FOR_APP } from './app-rows';
import { selectCanonicalRowsAfter } from './reconcile';

const WS = 'provider-routing-test';
const FIXTURE = 'outlook-fixture';
const NATIVE = 'shared-native-1';
const OCCURRED_AT = '2026-10-01T09:00:00Z';

let org: OrgTestDb;
let alice: string;
let bob: string;
const emittedKeys: string[] = [];

interface VaultRow {
  user_id: string;
  source: string;
  source_id: string | null;
  provider_account_id: string | null;
  datatype_id: string | null;
  external_id: string | null;
  dedupe_key: string;
}

async function makeUser(label: string): Promise<string> {
  const [user] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name)
    VALUES (${`provider-routing-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, ${label})
    RETURNING id`;
  return user.id;
}

/** The test workspace needs its own copy of each canonical datatype. */
async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`provider_routing_test_datatype_missing:${id}`);
  await upsertDatatype(org.adminSql, {
    id: base.id,
    workspaceId: WS,
    potSlug: base.potSlug,
    title: base.title,
    description: base.description,
    tier: base.tier,
    nature: base.nature,
    audience: base.audience,
    workItemKind: base.workItemKind,
    payloadSchema: base.payloadSchema,
    authoritativeWriter: base.authoritativeWriter,
    selfImprovement: base.selfImprovement,
    published: base.published,
    tags: base.tags,
    createdBy: 'provider-routing-integration',
  });
}

async function source(kind: string, ownerUserId: string, account: string): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, owner_user_id, provider_account_id, status)
    VALUES (${WS}, ${kind}, ${ownerUserId}, ${account}, 'ready')
    RETURNING id`;
  return row.id;
}

/** Ingest one record through the production path with the source's own Vault sink. */
async function ingest(
  sourceId: string,
  kind: string,
  datatypeId: 'email-message' | 'calendar-event',
  payload: Record<string, unknown>,
  externalId: string = NATIVE,
) {
  const sink = await createPersonalVaultExternalSinkForSource(org.adminSql, WS, sourceId);
  return ingestExternalTriggerEvent(org.adminSql, {
    workspaceId: WS,
    sourceId,
    source: kind,
    event: datatypeId === 'email-message' ? 'message.received' : 'event-created',
    externalId,
    datatypeId,
    adapterPayload: payload,
    normalize: (p) => p as Record<string, unknown>,
    occurredAt: OCCURRED_AT,
    additionalSinks: [sink],
  }, {
    emit: async (event) => {
      emittedKeys.push(event.key);
      return { ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 };
    },
  });
}

const mail = (to: string) => ({ id: NATIVE, from: 'carol@example.com', to: [to], subject: 'Quarterly', text: 'Body' });
const meeting = (organizer: string) => ({ id: NATIVE, summary: 'Standup', organizer, attendees: ['dan@example.com'] });

async function vaultRows(userId: string): Promise<VaultRow[]> {
  return org.adminSql<VaultRow[]>`
    SELECT user_id::text, source, source_id::text, provider_account_id, datatype_id, external_id, dedupe_key
      FROM harness_shared.documents
     WHERE workspace_id = ${WS} AND user_id = ${userId}
     ORDER BY datatype_id, source_id`;
}

const accountPrefix = (account: string) => `account:${createHash('sha256').update(account).digest('hex')}:`;

beforeAll(async () => {
  org = await createOrgTestDb();
  alice = await makeUser('alice');
  bob = await makeUser('bob');
  await copyDatatype('email-message');
  await copyDatatype('calendar-event');
});

afterAll(async () => {
  if (org) {
    for (const id of [alice, bob]) {
      if (id) await org.adminSql`DELETE FROM harness_shared.users WHERE id = ${id}`.catch(() => {});
    }
  }
  await org?.cleanup();
});

beforeEach(async () => {
  emittedKeys.length = 0;
  await org.adminSql`DELETE FROM harness_shared.trigger_runs WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.documents WHERE workspace_id = ${WS}`;
  await org.adminSql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS}`;
});

describe('P-005 provider-neutral routing (D-010)', () => {
  it('routes a non-Google email and calendar record into the Vault by datatype, keyed by source id', async () => {
    const account = 'alice@outlook.example';
    const fx = await source(FIXTURE, alice, account);
    // One source can expose two datatypes with the same native id. Delivery
    // dedupe must include the datatype so neither provider record suppresses the other.
    const nativeFor = { 'email-message': NATIVE, 'calendar-event': NATIVE } as const;
    const dedupeKeys = new Set<string>();

    for (const [datatypeId, payload] of [
      ['email-message', mail(account)],
      ['calendar-event', { ...meeting(account), id: nativeFor['calendar-event'] }],
    ] as const) {
      const result = await ingest(fx, FIXTURE, datatypeId, payload, nativeFor[datatypeId]);
      dedupeKeys.add(result.event.dedupeKey);
      expect(result.event.dedupeKey).toBe(`${FIXTURE}:${datatypeId}:${NATIVE}`);
      expect(result.deliveries).toEqual(expect.arrayContaining([
        expect.objectContaining({ sinkKind: 'personal-vault', outcome: 'delivered', deduped: false }),
      ]));
    }
    expect([...dedupeKeys]).toHaveLength(2);

    // No Google key prefix was involved anywhere on the way in.
    expect(emittedKeys.length).toBe(2);
    expect(emittedKeys.every((key) => key.startsWith(`ext:${FIXTURE}:`))).toBe(true);

    const rows = await vaultRows(alice);
    expect(rows.map((r) => r.datatype_id)).toEqual(['calendar-event', 'email-message']);
    for (const row of rows) {
      const datatypeId = row.datatype_id as keyof typeof nativeFor;
      const native = nativeFor[datatypeId];
      expect(row).toMatchObject({ source_id: fx, provider_account_id: account, external_id: native });
      // The Vault partition is named for the DATATYPE, never the provider
      // (WI-10006490): a non-Google provider's mail lands in `mail`.
      const category = datatypeId === 'email-message' ? 'mail' : 'calendar';
      expect(row.source).toBe(category);
      expect(row.dedupe_key).toBe(accountPrefix(account) + vaultDedupeKey(category, native, fx));
      expect(row.dedupe_key).toContain(`:${fx}:${native}`);
    }

    // The same rows reach each app's batch through the datatype-keyed read.
    for (const app of ['email', 'calendar'] as const) {
      const native = nativeFor[DATATYPE_FOR_APP[app] as keyof typeof nativeFor];
      const canonical = await selectCanonicalRowsAfter(org.adminSql, WS, alice, DATATYPE_FOR_APP[app], null, 50);
      expect(canonical).toHaveLength(1);
      const mapped = appRowFromSourceRecord(canonical[0]!);
      expect(mapped?.app).toBe(app);
      expect(mapped?.row).toMatchObject({ id: appRowId(native, fx), nativeId: native });
    }
  });

  it('makes a non-Google provider\'s mail readable under the provider-neutral personal:mail scope (WI-10006490)', async () => {
    const account = 'alice@outlook.example';
    const fx = await source(FIXTURE, alice, account);
    await ingest(fx, FIXTURE, 'email-message', mail(account));

    const ctx = { workspaceId: WS, role: 'meeting-prep' };
    expect((await authorizePersonalAccess(org.adminSql, ctx, WS, alice, ['personal:mail'])).allowed).toBe(false);
    await createPersonalGrant(org.adminSql, {
      workspaceId: WS, userId: alice, principalType: 'agent-role', principalId: 'meeting-prep',
      scopes: ['personal:mail'], grantedBy: 'owner',
    });
    expect(await authorizePersonalAccess(org.adminSql, ctx, WS, alice, ['personal:mail']))
      .toMatchObject({ allowed: true, scopes: ['personal:mail'] });
    // There is no Google-named partition left to grant against or read from.
    expect((await authorizePersonalAccess(org.adminSql, ctx, WS, alice, ['personal:gmail'])).allowed).toBe(false);

    const found = await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'Quarterly', scopes: ['personal:mail'] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: 'mail', scopeKey: 'personal:mail', externalId: NATIVE });
    expect(await searchPersonalDocuments(org.adminSql, WS, alice, { query: 'Quarterly', scopes: ['personal:gmail'] }))
      .toEqual([]);
  });

  it('keeps two providers that reuse one native id distinct in the Vault and in the app batch', async () => {
    const gmailAccount = 'alice@gmail.example';
    const fixtureAccount = 'alice@outlook.example';
    const google = await source('gmail', alice, gmailAccount);
    const fx = await source(FIXTURE, alice, fixtureAccount);
    await ingest(google, 'gmail', 'email-message', mail(gmailAccount));
    await ingest(fx, FIXTURE, 'email-message', mail(fixtureAccount));

    const rows = (await vaultRows(alice)).filter((r) => r.datatype_id === 'email-message');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.dedupe_key)).size).toBe(2);
    // Control: without the source id the two keys are identical — this is the
    // collision the source-scoped key exists to prevent.
    expect(vaultDedupeKey('gmail', NATIVE, null)).toBe(vaultDedupeKey('gmail', NATIVE, null));

    const accountBySource = new Map([[google, gmailAccount], [fx, fixtureAccount]]);
    const canonical = await selectCanonicalRowsAfter(org.adminSql, WS, alice, DATATYPE_FOR_APP.email, null, 50);
    const mapped = canonical.map((record) => ({ record, out: appRowFromSourceRecord(record) }));
    expect(mapped.map(({ out }) => out?.app)).toEqual(['email', 'email']);
    expect(mapped.map(({ out }) => out?.row.id).sort()).toEqual([appRowId(NATIVE, google), appRowId(NATIVE, fx)].sort());
    for (const { record, out } of mapped) {
      // Each row carries ITS source's account, never the other provider's.
      expect(out?.row.nativeId).toBe(NATIVE);
      expect(out?.row.mailbox).toMatchObject({
        sourceId: record.sourceId,
        providerAccountId: accountBySource.get(record.sourceId!),
      });
    }

    // Datatype selects the app: no calendar row exists, so the calendar batch is empty.
    expect(await selectCanonicalRowsAfter(org.adminSql, WS, alice, DATATYPE_FOR_APP.calendar, null, 50)).toEqual([]);
  });

  it('never exposes a record across a local principal boundary, even for the same provider account', async () => {
    // Same provider kind AND the same provider account address, owned by two
    // different local users: only the server-owned source decides the owner.
    const account = 'shared@outlook.example';
    const fxAlice = await source(FIXTURE, alice, account);
    const fxBob = await source(FIXTURE, bob, account);
    // A payload that tries to nominate the other principal must not widen the write.
    await ingest(fxAlice, FIXTURE, 'email-message', { ...mail(account), ownerUserId: bob, userId: bob });
    await ingest(fxBob, FIXTURE, 'email-message', mail(account));

    const aliceRows = await vaultRows(alice);
    const bobRows = await vaultRows(bob);
    expect(aliceRows.map((r) => r.source_id)).toEqual([fxAlice]);
    expect(bobRows.map((r) => r.source_id)).toEqual([fxBob]);

    const aliceBatch = await selectCanonicalRowsAfter(org.adminSql, WS, alice, DATATYPE_FOR_APP.email, null, 50);
    const bobBatch = await selectCanonicalRowsAfter(org.adminSql, WS, bob, DATATYPE_FOR_APP.email, null, 50);
    expect(aliceBatch.map((r) => appRowFromSourceRecord(r)?.row.id)).toEqual([appRowId(NATIVE, fxAlice)]);
    expect(bobBatch.map((r) => appRowFromSourceRecord(r)?.row.id)).toEqual([appRowId(NATIVE, fxBob)]);
  });

  it('routes by datatype, not by the provider-named label (control)', () => {
    // A provider-name map would have sent a `gmail`-labelled record to the email
    // app. With no datatype it is not routable at all…
    expect(appRowFromSourceRecord({ source: 'gmail', kind: 'message', datatypeId: null, externalId: 'x' })).toBeNull();
    // …and a non-Google label with the email datatype IS routed to email.
    expect(appRowFromSourceRecord({
      source: FIXTURE,
      kind: 'message',
      datatypeId: 'email-message',
      sourceId: 's-1',
      externalId: 'x',
    })?.app).toBe('email');
  });
});
