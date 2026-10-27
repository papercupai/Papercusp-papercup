/**
 * The platform relationship graph against real Postgres (crm-agent-sales-onboarding-apps-
 * 2026-10-06 P-002, D-001 / D-011).
 *
 * The shared connector driver, its default sinks (record + admission + the relationship-graph
 * resolve sink), createWorkItem, mergeWorkItemPayload and migration 1383's registry rows all run
 * for real; only the two providers are fixtures (a CRM-like source and a Phone-like source).
 *
 * Properties under test:
 *   - one canonical person per real human ACROSS sources: records sharing an email or phone merge
 *     into one PER- row, with every member stamped `personId`;
 *   - per-field provenance: each merged field names its source record, data source and
 *     observed-at time; an accepted value carries acceptedBy and outranks later observations;
 *   - canonical ids are stable: a record joining a cluster never changes its id, and when two
 *     clusters merge the younger canonical row is retired with `mergedInto` (readers follow it);
 *   - a person links to an organization by email domain, also when the organization arrives later;
 *   - interaction participants (email-message) resolve to graph persons; unknown keys are reported;
 *   - every graph row is nature `record` (never claimable work), and a source that does not route
 *     `person` to `record` writes nothing to the graph;
 *   - replay and a full backfill converge on the same rows.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { HostFetch, ProviderAdapter, ProviderDescriptor } from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { createProviderRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { runConnectorSync } from '../providers/connector-runtime';
import { dataSourceRecordId } from '../data-sources/datatype-destination-sink';
import { listProvenanceKey } from './merge';
import { getPeople, mergePeople, searchPeople, readPersonQualificationEvidence } from './people';
import {
  acceptEntityField,
  mergeEntities,
  findEntityByIdentity,
  getCanonicalEntity,
  resolveIdentities,
  resolveInteractionParticipants,
} from './resolver';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql, ws: 'papercusp-workspace' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => h.ws,
}));

const WS = 'papercusp-workspace';
const HARNESS = 'papercusp';
const CRM = 'graph-crm-fixture';
const PHONE = 'graph-phone-fixture';

const MAIL = 'graph-mail-fixture';
const SIGNUPS = 'papercusp-signups';
const signupConfig = { accountId: 'a'.repeat(32), namespaceId: 'b'.repeat(32) };
const signupKey = 'signup:2026-10-26T12:00:00.000Z:abc12345';
const signupCapture = {
  email: 'Ada@Acme.com', what: 'Automate support', ts: '2026-10-26T12:00:00.000Z',
  attribution: { distinct_id: 'PER-forged', first_touch: { utm_campaign: 'launch' } },
  personId: 'PER-forged', consent: true, activated: true,
};
const { providerAdapter: signupAdapter } = createRequire(import.meta.url)(
  '../../../../libs/papercusp/plugins/papercusp-signups/index.cjs',
) as { providerAdapter: ProviderAdapter };
const signupFetch: HostFetch = async ({ request }) => ({
  status: 200, headers: {}, bodyEncoding: 'utf8',
  body: JSON.stringify(new URL(request.url).pathname.endsWith('/keys')
    ? { success: true, result: [{ name: signupKey }], result_info: { cursor: '' } }
    : signupCapture),
});
const FIXTURE_DATATYPES = ['person', 'organization', 'email-message', 'calendar-event', 'call'] as const;

interface FixtureRecord {
  datatype: (typeof FIXTURE_DATATYPES)[number];
  nativeId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

const feeds: Record<string, FixtureRecord[]> = { [CRM]: [], [PHONE]: [], [MAIL]: [] };

function fixtureProvider(id: string): { descriptor: ProviderDescriptor; adapter: ProviderAdapter } {
  const descriptor: ProviderDescriptor = {
    id,
    contractVersion: 1,
    datatypes: [...FIXTURE_DATATYPES],
    // Capabilities are `<domain>.<verb>` (no hyphen), so the mail and calendar datatypes read
    // under the same `mail.read` / `calendar.read` domains the real providers declare.
    capabilities: ['person.read', 'organization.read', 'mail.read', 'calendar.read', 'call.read'],
    egressHosts: [`${id}.example.com`],
  };
  const adapter: ProviderAdapter = {
    describe: () => descriptor,
    syncPage: async () => ({
      records: feeds[id]!.map((r) => ({
        datatype: r.datatype,
        nativeId: r.nativeId,
        event: `${r.datatype}-updated`,
        payload: { provider: id, externalId: r.nativeId, ...r.payload },
        ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}),
      })),
      nextCursor: null,
      hasMore: false,
    }),
    invoke: async () => {
      throw new Error(`${id} is a read-only fixture`);
    },
  };
  return { descriptor, adapter };
}

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let registry: ProviderRegistry;
const noFetch: HostFetch = async () => ({ status: 404, headers: {}, body: '', bodyEncoding: 'utf8' });

async function ingest(db: Sql, input: IngestExternalTriggerInput) {
  return ingestExternalTriggerEvent(db, input, {
    emit: async (event) => ({ ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 }),
  });
}

async function sync(sourceId: string, hostFetch: HostFetch = noFetch): Promise<void> {
  await sql`UPDATE harness_shared.data_sources SET sync_next_attempt_at = NULL WHERE id = ${sourceId}::uuid`;
  const result = await runConnectorSync(
    sql,
    { workspaceId: WS, harness: HARNESS, sourceIds: [sourceId] },
    { registry, ingest, hostFetchFor: () => hostFetch, leaseOwner: 'relationship-graph-it' },
  );
  expect(result.sources, JSON.stringify(result.sources)).toEqual([
    expect.objectContaining({ sourceId, outcome: 'synced', rejected: 0 }),
  ]);
}

async function connect(kind: string, policy: Record<string, string[]> = { person: ['record'], organization: ['record'] }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
       destination_policy, permission_mapping)
    VALUES (${WS}, ${kind}, ${alice}, ${`${kind}-account-${Date.now()}-${Math.random()}`}, 'connected',
            ${sql.json({ harnessSlug: HARNESS, ...(kind === SIGNUPS ? signupConfig : {}) })}, 'organization',
            ${sql.json(policy)}, ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  return row!.id;
}

interface GraphRow {
  feature_id: string;
  item_kind: string;
  nature: string;
  title: string;
  payload: Record<string, unknown>;
}

async function graphRows(prefix: 'PER-' | 'ORG-' | 'DSR-', datatype: 'person' | 'organization'): Promise<GraphRow[]> {
  return sql<GraphRow[]>`
    SELECT feature_id, item_kind, nature, title, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND item_kind = ${datatype} AND feature_id LIKE ${`${prefix}%`}
     ORDER BY created_ts, feature_id`;
}

const live = (rows: GraphRow[]) => rows.filter((r) => !r.payload.mergedInto);

async function clean(): Promise<void> {
  const sources = await sql<{ id: string }[]>`
    SELECT id::text FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${CRM}, ${PHONE}, ${MAIL}, ${SIGNUPS})`;
  const ids = sources.map((s) => s.id);
  await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND item_kind IN ('person', 'organization')
             AND (feature_id LIKE 'PER-%' OR feature_id LIKE 'ORG-%' OR payload->>'dataSourceId' = ANY(${sql.array(ids)}::text[]))`;
  if (ids.length > 0) {
    await sql`DELETE FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array(ids)}::uuid[])`;
  }
  await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind IN (${CRM}, ${PHONE}, ${MAIL}, ${SIGNUPS})`;
  feeds[CRM] = [];
  feeds[PHONE] = [];
  feeds[MAIL] = [];
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`relationship-graph-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
  registry = createProviderRegistry();
  for (const id of [CRM, PHONE, MAIL]) {
    const { descriptor, adapter } = fixtureProvider(id);
    // Awaited: register() is async and validates the descriptor, so an un-awaited rejection would
    // leave the registry empty and surface only as every sync returning `sources: []`.
    await registry.register({ descriptor, adapter, pluginName: id, runtime: 'js' } as never);
  }
  await registry.register({ descriptor: await signupAdapter.describe(), adapter: signupAdapter, pluginName: SIGNUPS, runtime: 'js' } as never);
  expect(registry.list().map((p) => p.descriptor.id).sort()).toEqual([CRM, MAIL, PHONE, SIGNUPS].sort());
});

afterAll(async () => {
  if (org) await clean().catch(() => {});
  if (alice) await sql`DELETE FROM harness_shared.users WHERE id = ${alice}`.catch(() => {});
  await org?.cleanup();
});

beforeEach(async () => {
  await clean();
});

describe('platform relationship graph (P-002, R-1)', () => {
  it('reads cited signup fit inputs from canonical membership, without promoting attribution or consent (P-019)', async () => {
    const source = await connect(SIGNUPS, { person: ['record'] });
    await sync(source, signupFetch);
    const [person] = live(await graphRows('PER-', 'person'));
    const recordId = dataSourceRecordId(WS, source, 'person', signupKey);
    const result = await readPersonQualificationEvidence(sql, WS, person!.feature_id);
    expect(result).toMatchObject({ status: 'available', person: { id: person!.feature_id }, sources: [{
      recordId, evidenceRef: `work-item:${recordId}`, provider: SIGNUPS, dataSourceId: source,
      selfReportedUseCase: signupCapture.what,
    }] });
    expect(JSON.stringify(result)).not.toMatch(/PER-forged|communicationConsent|emailVerified|distinct_id|productIdentityBinding/);
    expect(await readPersonQualificationEvidence(sql, 'foreign-workspace', person!.feature_id))
      .toEqual({ status: 'unknown', reason: 'person_unavailable' });
    expect(await readPersonQualificationEvidence(sql, WS, recordId))
      .toEqual({ status: 'unknown', reason: 'person_unavailable' });
    // A concurrent source retirement must not become a partial assessment.
    await sql`UPDATE harness_shared.work_items SET payload = payload || '{"retiredAt":"2026-10-27T00:00:00Z"}'::jsonb
      WHERE workspace_id = ${WS} AND feature_id = ${recordId}`;
    expect(await readPersonQualificationEvidence(sql, WS, person!.feature_id))
      .toEqual({ status: 'unknown', reason: 'source_records_unavailable' });
  });
  it('ingests a packaged signup as a cited person record and converges on replay (P-019)', async () => {
    const source = await connect(SIGNUPS, { person: ['record'] });
    await sync(source, signupFetch);

    const recordId = dataSourceRecordId(WS, source, 'person', signupKey);
    const [person] = live(await graphRows('PER-', 'person'));
    expect(person).toMatchObject({ nature: 'record', payload: {
      canonical: true, emails: ['ada@acme.com'], memberRecordIds: [recordId],
      provenance: { 'emails:ada@acme.com': {
        source: { kind: 'record', recordId, dataSourceId: source, provider: SIGNUPS },
        observedAt: signupCapture.ts,
      } },
    } });
    expect(person!.feature_id).not.toBe('PER-forged');
    const [record] = await graphRows('DSR-', 'person');
    expect(record).toMatchObject({ feature_id: recordId, nature: 'record', payload: {
      personId: person!.feature_id, dataSourceId: source,
      extensions: { [SIGNUPS]: {
        signupEventId: signupKey, capturedAt: signupCapture.ts,
        evidenceRef: `cloudflare-kv:${signupConfig.accountId}:${signupConfig.namespaceId}:${signupKey}`,
        emailVerified: false, communicationConsent: false,
        selfReported: { useCase: signupCapture.what, attribution: {
          distinct_id: 'PER-forged', first_touch: { utm_campaign: 'launch' },
        } },
      } },
    } });
    expect(record!.payload.consent).toBeUndefined();
    expect(record!.payload.activated).toBeUndefined();

    await sync(source, signupFetch);
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'person' });
    expect((await graphRows('DSR-', 'person')).map(r => r.feature_id)).toEqual([recordId]);
    expect(live(await graphRows('PER-', 'person')).map(r => r.feature_id)).toEqual([person!.feature_id]);
    const deliveries = await sql<{ sink_kind: string; error: string | null }[]>`
      SELECT sink_kind, error FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ${source}::uuid`;
    expect(deliveries.filter(d => d.error)).toEqual([]);
    expect(deliveries.map(d => d.sink_kind)).toEqual(expect.arrayContaining(['data-source-record', 'relationship-graph-resolve']));
  });

  it('requires the signup source to grant the person record destination (P-019)', async () => {
    const source = await connect(SIGNUPS, {});
    await sync(source, signupFetch);
    expect(await graphRows('DSR-', 'person')).toEqual([]);
    expect(await graphRows('PER-', 'person')).toEqual([]);

    await sql`UPDATE harness_shared.data_sources SET destination_policy = ${sql.json({ person: ['record'] })}
               WHERE workspace_id = ${WS} AND id = ${source}::uuid`;
    await sync(source, signupFetch);
    expect(await graphRows('DSR-', 'person')).toHaveLength(1);
    expect(live(await graphRows('PER-', 'person'))).toHaveLength(1);
  });

  it('registers person/organization/commitment as records and call as a document (migration 1383)', async () => {
    const rows = await sql<Array<{ id: string; tier: string; work_item_kind: string | null; nature: string }>>`
      SELECT id, tier, work_item_kind, nature FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id IN ('person', 'organization', 'commitment', 'call') ORDER BY id`;
    expect(rows).toEqual([
      { id: 'call', tier: 'first-class', work_item_kind: null, nature: 'document' },
      { id: 'commitment', tier: 'generic-kind', work_item_kind: 'commitment', nature: 'record' },
      { id: 'organization', tier: 'generic-kind', work_item_kind: 'organization', nature: 'record' },
      { id: 'person', tier: 'generic-kind', work_item_kind: 'person', nature: 'record' },
    ]);
  });

  it('merges one human across sources into one canonical person with per-field provenance and a stable id', async () => {
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada L.', title: 'CTO', emails: ['ada@acme.com'], updatedAt: '2026-09-01T00:00:00Z' } },
      { datatype: 'person', nativeId: 'crm-bob', payload: { displayName: 'Bob', emails: ['bob@beta.io'], updatedAt: '2026-09-01T00:00:00Z' } },
      // Delivered AFTER the persons: Ada must still be linked to it (relink path).
      { datatype: 'organization', nativeId: 'crm-acme', payload: { name: 'Acme', domains: ['acme.com'], updatedAt: '2026-09-01T00:00:00Z' } },
    ];
    const crm = await connect(CRM);
    await sync(crm);

    const [acme] = live(await graphRows('ORG-', 'organization'));
    expect(acme).toMatchObject({ title: 'Acme', nature: 'record', payload: { canonical: true, domains: ['acme.com'] } });
    const afterCrm = live(await graphRows('PER-', 'person'));
    expect(afterCrm.map((r) => r.title).sort()).toEqual(['Ada L.', 'Bob']);
    const adaId = afterCrm.find((r) => r.title === 'Ada L.')!.feature_id;
    const adaAfterCrm = afterCrm.find((r) => r.feature_id === adaId)!;
    expect(adaAfterCrm.payload.organizationId).toBe(acme!.feature_id);
    expect(adaAfterCrm.payload.provenance).toMatchObject({
      organizationId: { source: { kind: 'derived', from: 'email-domain:acme.com' }, acceptedBy: null },
    });

    feeds[PHONE] = [
      { datatype: 'person', nativeId: 'ph-ada', payload: { displayName: 'Ada Lovelace', emails: ['ADA@acme.com'], phones: ['+1 (555) 123-4567'], updatedAt: '2026-10-01T00:00:00Z' } },
    ];
    const phone = await connect(PHONE);
    await sync(phone);

    const persons = live(await graphRows('PER-', 'person'));
    expect(persons).toHaveLength(2); // one per real human, across both sources
    const ada = persons.find((r) => r.feature_id === adaId)!; // the id did not move
    const crmAda = dataSourceRecordId(WS, crm, 'person', 'crm-ada');
    const phoneAda = dataSourceRecordId(WS, phone, 'person', 'ph-ada');
    expect(ada).toMatchObject({ item_kind: 'person', nature: 'record', title: 'Ada Lovelace' });
    expect(ada.payload).toMatchObject({
      canonical: true,
      provider: 'relationship-graph',
      externalId: adaId,
      displayName: 'Ada Lovelace',
      title: 'CTO',
      emails: ['ada@acme.com'],
      phones: ['+15551234567'],
      memberRecordIds: [crmAda, phoneAda].sort(),
      identityKeys: ['email:ada@acme.com', 'phone:+15551234567'],
    });
    expect(ada.payload.provenance).toMatchObject({
      displayName: { source: { kind: 'record', recordId: phoneAda, dataSourceId: phone, provider: PHONE }, observedAt: '2026-10-01T00:00:00.000Z', acceptedBy: null },
      title: { source: { kind: 'record', recordId: crmAda, dataSourceId: crm, provider: CRM }, observedAt: '2026-09-01T00:00:00.000Z', acceptedBy: null },
      'phones:+15551234567': { source: { recordId: phoneAda } },
    });

    // Every member row is stamped with its canonical person and stays a record.
    const members = await graphRows('DSR-', 'person');
    expect(members.filter((r) => [crmAda, phoneAda].includes(r.feature_id)).map((r) => [r.payload.personId, r.nature]))
      .toEqual([[adaId, 'record'], [adaId, 'record']]);

    // Lookup by any identity key reaches the same person.
    expect((await findEntityByIdentity(sql, WS, 'person', 'phone:+15551234567'))?.id).toBe(adaId);

    // Interaction participants resolve to graph persons; an unknown address is reported.
    expect(await resolveInteractionParticipants(sql, WS, 'email-message', { from: 'Ada <ada@acme.com>', to: ['bob@beta.io', 'zed@zeta.io'] }))
      .toEqual({ personIds: [adaId, persons.find((r) => r.title === 'Bob')!.feature_id].sort(), unresolved: ['email:zed@zeta.io'] });

    // Replay and a full backfill converge on the same rows.
    const snapshot = async () => (await graphRows('PER-', 'person')).map((r) => ({ id: r.feature_id, title: r.title, members: r.payload.memberRecordIds, merged: r.payload.mergedInto ?? null }));
    const before = await snapshot();
    await sync(crm);
    await sync(phone);
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'person' });
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'organization' });
    expect(await snapshot()).toEqual(before);
  });

  it('a record that bridges two clusters retires the younger canonical person into the older', async () => {
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'] } },
      { datatype: 'person', nativeId: 'crm-bob', payload: { displayName: 'Bob', emails: ['bob@beta.io'] } },
    ];
    const crm = await connect(CRM);
    await sync(crm);
    const [first, second] = live(await graphRows('PER-', 'person'));
    expect(second).toBeDefined();

    feeds[PHONE] = [{ datatype: 'person', nativeId: 'ph-shared', payload: { emails: ['ada@acme.com', 'bob@beta.io'] } }];
    const phone = await connect(PHONE);
    await sync(phone);

    const rows = await graphRows('PER-', 'person');
    expect(live(rows).map((r) => r.feature_id)).toEqual([first!.feature_id]);
    const retired = rows.find((r) => r.feature_id === second!.feature_id)!;
    expect(retired.payload).toMatchObject({ mergedInto: first!.feature_id, memberRecordIds: [], identityKeys: [] });
    expect((await getCanonicalEntity(sql, WS, 'person', second!.feature_id))?.id).toBe(first!.feature_id);
    expect(live(rows)[0]!.payload.memberRecordIds).toHaveLength(3);
  });

  it('keeps orphaned retired canonical people out of every live read path', async () => {
    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'] } }];
    const crm = await connect(CRM);
    await sync(crm);

    const [canonical] = live(await graphRows('PER-', 'person'));
    const [source] = (await graphRows('DSR-', 'person'));
    expect(canonical).toBeDefined();
    expect(source).toBeDefined();

    // Removing the last source record is the resolver path that retires a canonical row with
    // retiredAt but no mergedInto pointer. Keep its old identity key below to cover rows written
    // by older versions that did not clear identityKeys when they retired an orphan.
    await sql`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${source!.feature_id}`;
    await resolveIdentities(sql, { workspaceId: WS, datatype: 'person' });
    await sql`UPDATE harness_shared.work_items
                 SET payload = payload || ${sql.json({ identityKeys: ['email:ada@acme.com'] })}
               WHERE workspace_id = ${WS} AND feature_id = ${canonical!.feature_id}`;

    const retired = (await graphRows('PER-', 'person')).find((row) => row.feature_id === canonical!.feature_id)!;
    expect(retired.payload).toMatchObject({ retiredAt: expect.any(String), memberRecordIds: [] });
    expect(await searchPeople(sql, WS, { query: 'Ada' })).toEqual([]);
    expect(await searchPeople(sql, WS, { emails: ['ada@acme.com'] })).toEqual([]);
    expect(await getCanonicalEntity(sql, WS, 'person', canonical!.feature_id)).toBeNull();
    expect(await findEntityByIdentity(sql, WS, 'person', 'email:ada@acme.com')).toBeNull();
    expect(await resolveInteractionParticipants(sql, WS, 'email-message', { from: 'Ada <ada@acme.com>' }))
      .toEqual({ personIds: [], unresolved: ['email:ada@acme.com'] });
  });

  it('an accepted value carries acceptedBy and outranks a later observation', async () => {
    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'], updatedAt: '2026-09-01T00:00:00Z' } }];
    const crm = await connect(CRM);
    await sync(crm);
    const [ada] = live(await graphRows('PER-', 'person'));

    const accepted = await acceptEntityField(sql, {
      workspaceId: WS, datatype: 'person', canonicalId: ada!.feature_id, field: 'displayName', value: 'Countess Ada', acceptedBy: 'user:avi',
    }, { now: () => new Date('2026-10-02T00:00:00Z') });
    expect(accepted.payload).toMatchObject({
      displayName: 'Countess Ada',
      provenance: { displayName: { source: { kind: 'accepted' }, observedAt: '2026-10-02T00:00:00.000Z', acceptedBy: 'user:avi' } },
    });

    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada Renamed', emails: ['ada@acme.com'], updatedAt: '2026-10-05T00:00:00Z' } }];
    await sync(crm);
    const after = await getCanonicalEntity(sql, WS, 'person', ada!.feature_id);
    expect(after?.payload.displayName).toBe('Countess Ada');
    expect(after?.title).toBe('Countess Ada');

    await expect(acceptEntityField(sql, {
      workspaceId: WS, datatype: 'person', canonicalId: ada!.feature_id, field: 'favouriteColour', value: 'blue', acceptedBy: 'user:avi',
    })).rejects.toMatchObject({ code: 'unknown_field' });
  });

  it('a person merge joins two people the keys missed, survives a re-sync, and replays idempotently (D-027, R-2)', async () => {
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada Lovelace', emails: ['ada@acme.com'] } },
      { datatype: 'person', nativeId: 'crm-ada-home', payload: { displayName: 'Ada L.', emails: ['ada.l@home.example'] } },
    ];
    const crm = await connect(CRM);
    await sync(crm);
    const [older, younger] = live(await graphRows('PER-', 'person'));
    expect(younger).toBeDefined();

    const merged = await mergePeople(
      sql, WS, { ids: [younger!.feature_id, older!.feature_id], acceptedBy: 'user:avi' },
      { now: () => new Date('2026-10-06T17:00:00Z') },
    );
    expect(merged).toMatchObject({ alreadyMerged: false, person: { id: older!.feature_id, sourceRecordCount: 2 } });
    expect([...merged.person.emails].sort()).toEqual(['ada.l@home.example', 'ada@acme.com']);
    expect([...merged.merged].sort()).toEqual([older!.feature_id, younger!.feature_id].sort());

    const rows = await graphRows('PER-', 'person');
    expect(live(rows).map((r) => r.feature_id)).toEqual([older!.feature_id]);
    expect(rows.find((r) => r.feature_id === younger!.feature_id)!.payload).toMatchObject({ mergedInto: older!.feature_id });
    expect((await getPeople(sql, WS, [younger!.feature_id])).get(younger!.feature_id)?.id).toBe(older!.feature_id);

    // Every member record carries the one asserted key and who asserted it.
    const records = await graphRows('DSR-', 'person');
    expect(records).toHaveLength(2);
    const [linkKey] = records[0]!.payload.assertedSameAs as string[];
    expect(linkKey).toMatch(/^same:[0-9a-f]{24}$/);
    for (const record of records) {
      expect(record.payload.assertedSameAs).toEqual([linkKey]);
      expect((record.payload.assertedSameAsBy as Record<string, unknown>)[linkKey!]).toEqual({
        acceptedBy: 'user:avi', acceptedAt: '2026-10-06T17:00:00.000Z', entities: [older!.feature_id, younger!.feature_id].sort(),
      });
    }

    // The connector re-delivers both records with fresh payloads: the merge holds.
    feeds[CRM] = [
      { datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada Lovelace', emails: ['ada@acme.com'], updatedAt: '2026-10-07T00:00:00Z' } },
      { datatype: 'person', nativeId: 'crm-ada-home', payload: { displayName: 'Ada L.', emails: ['ada.l@home.example'], updatedAt: '2026-10-07T00:00:00Z' } },
    ];
    await sync(crm);
    expect(live(await graphRows('PER-', 'person')).map((r) => r.feature_id)).toEqual([older!.feature_id]);

    // Replaying the merge writes nothing and returns the same survivor.
    const again = await mergeEntities(sql, {
      workspaceId: WS, datatype: 'person', canonicalIds: [older!.feature_id, younger!.feature_id], acceptedBy: 'user:avi',
    });
    expect(again).toMatchObject({ alreadyMerged: true, linkKey: null, stamped: 0, survivor: { id: older!.feature_id } });

    await expect(mergePeople(sql, WS, { ids: [older!.feature_id, older!.feature_id], acceptedBy: 'user:avi' }))
      .rejects.toMatchObject({ code: 'too_few_entities' });
    await expect(mergePeople(sql, WS, { ids: [older!.feature_id, 'PER-000000000000000000000000'], acceptedBy: 'user:avi' }))
      .rejects.toMatchObject({ code: 'entity_missing' });
    await expect(mergePeople(sql, WS, { ids: [older!.feature_id, younger!.feature_id], acceptedBy: '  ' }))
      .rejects.toMatchObject({ code: 'empty_actor' });
  });

  it('a source that does not route person to record writes nothing to the graph', async () => {
    feeds[CRM] = [{ datatype: 'person', nativeId: 'crm-ada', payload: { displayName: 'Ada', emails: ['ada@acme.com'] } }];
    const crm = await connect(CRM, { organization: ['record'] });
    await sync(crm);
    expect(await graphRows('DSR-', 'person')).toEqual([]);
    expect(await graphRows('PER-', 'person')).toEqual([]);
  });

  it('ingesting an email, a calendar event and a phone call for the same address yields exactly one person (SPEC-P-002, R-1)', async () => {
    const policy = { person: ['record'], organization: ['record'], call: ['document'] };
    const email = { id: 'msg-1', from: '"Ada Lovelace" <ada@acme.com>', to: ['me@papercusp.test'], subject: 'Renewal pricing', body: 'CONFIDENTIAL-BODY' };
    const event = { id: 'evt-1', title: 'Renewal review', organizer: 'me@papercusp.test', attendees: [{ email: 'ADA@acme.com', displayName: 'Ada' }], description: 'CONFIDENTIAL-AGENDA' };
    // The canonical call schema (migration 1383) carries participants as strings: each entry is ONE
    // identity, so the caller's number and Ada's address are two participants, never linked by
    // co-occurring on the same call (D-012: conservative keys).
    const call = { title: 'Call with Ada', from: '+1 (555) 123-4567', to: ['+15550009999'], participants: ['"Ada Lovelace" <ada@acme.com>', '+1 555 123 4567'], text: 'CONFIDENTIAL-TRANSCRIPT' };
    feeds[MAIL] = [
      { datatype: 'email-message', nativeId: 'msg-1', payload: email, occurredAt: '2026-10-02T09:00:00.000Z' },
      { datatype: 'email-message', nativeId: 'msg-2', payload: { id: 'msg-2', from: 'No Reply <no-reply@acme.com>', to: ['me@papercusp.test'], subject: 'Receipt' }, occurredAt: '2026-10-02T10:00:00.000Z' },
      { datatype: 'calendar-event', nativeId: 'evt-1', payload: event, occurredAt: '2026-10-03T15:00:00.000Z' },
    ];
    feeds[PHONE] = [{ datatype: 'call', nativeId: 'call-1', payload: call, occurredAt: '2026-10-04T11:00:00.000Z' }];
    const mail = await connect(MAIL, policy);
    const phone = await connect(PHONE, policy);
    await sync(mail);
    await sync(phone);

    // Each interaction was stored by its own store sink (Vault for mail/calendar, corpus for the call)
    // and projected by the participant sink, with no delivery error.
    const deliveries = await sql<{ datatype_id: string; sink_kind: string; error: string | null }[]>`
      SELECT datatype_id, sink_kind, error FROM harness_shared.trigger_deliveries
       WHERE workspace_id = ${WS} AND source_id = ANY(${sql.array([mail, phone])}::uuid[])
         AND datatype_id IN ('email-message', 'calendar-event', 'call')`;
    expect(deliveries.filter((d) => d.error)).toEqual([]);
    for (const datatype of ['email-message', 'calendar-event', 'call']) {
      const kinds = new Set(deliveries.filter((d) => d.datatype_id === datatype).map((d) => d.sink_kind));
      expect(kinds.has('relationship-graph-participants'), datatype).toBe(true);
      expect([...kinds].some((k) => k !== 'relationship-graph-participants'), datatype).toBe(true);
    }

    // Exactly one platform person for that address (the SPEC-P-002 falsifier is two).
    const adas = live(await graphRows('PER-', 'person')).filter((r) => (r.payload.identityKeys as string[]).includes('email:ada@acme.com'));
    expect(adas).toHaveLength(1);
    const ada = adas[0]!;
    // P-003 (D-016/D-017): the person read path apps use answers with that ONE person, whether
    // asked by exact address (any casing) or by free text.
    for (const found of [
      await searchPeople(sql, WS, { emails: ['ADA@acme.com'] }),
      await searchPeople(sql, WS, { query: 'lovelace' }),
      await searchPeople(sql, WS, { query: 'ada@acme' }),
    ]) {
      expect(found.map((p) => p.id)).toEqual([ada.feature_id]);
      expect(found[0]).toMatchObject({ emails: ['ada@acme.com'], displayName: expect.stringContaining('Ada') });
    }
    expect((await getPeople(sql, WS, [ada.feature_id])).get(ada.feature_id)?.id).toBe(ada.feature_id);
    expect(ada.payload).toMatchObject({
      canonical: true,
      displayName: 'Ada Lovelace',
      emails: ['ada@acme.com'],
      identityKeys: ['email:ada@acme.com'],
    });
    expect(ada.payload.phones ?? []).toEqual([]);
    expect([...(ada.payload.memberRecordIds as string[])].sort()).toEqual([
      dataSourceRecordId(WS, mail, 'person', 'participant:email:ada@acme.com'),
      dataSourceRecordId(WS, phone, 'person', 'participant:email:ada@acme.com'),
    ].sort());

    // The number on the same call is its own person: co-occurrence is not identity.
    const caller = await findEntityByIdentity(sql, WS, 'person', 'phone:+15551234567');
    expect(caller).not.toBeNull();
    expect(caller!.id).not.toBe(ada.feature_id);
    expect(caller!.payload.emails ?? []).toEqual([]);

    // The three interaction records resolve to that one person.
    for (const [datatype, payload] of [['email-message', email], ['calendar-event', event], ['call', call]] as const) {
      expect((await resolveInteractionParticipants(sql, WS, datatype, payload)).personIds, datatype).toContain(ada.feature_id);
    }

    // Every field carries source, observed-at and accepted-by provenance.
    const provenance = ada.payload.provenance as Record<string, { source?: unknown; observedAt?: unknown; acceptedBy?: unknown }>;
    for (const key of ['displayName', listProvenanceKey('emails', 'ada@acme.com')]) {
      expect(Object.keys(provenance), key).toContain(key);
    }
    for (const [key, entry] of Object.entries(provenance)) {
      expect(entry.source, key).toEqual(expect.any(Object));
      expect(entry.observedAt, key).toEqual(expect.any(String));
      expect(entry.acceptedBy === null || typeof entry.acceptedBy === 'string', key).toBe(true);
    }
    expect(provenance.displayName).toMatchObject({ source: { kind: 'record', dataSourceId: phone }, observedAt: '2026-10-04T11:00:00.000Z', acceptedBy: null });

    // Identity only: no subject, body, agenda or transcript reached the graph.
    const graphText = JSON.stringify([...(await graphRows('PER-', 'person')), ...(await graphRows('DSR-', 'person'))]);
    for (const secret of ['CONFIDENTIAL', 'Renewal pricing', 'Renewal review', 'Receipt']) expect(graphText).not.toContain(secret);

    // An automated sender is not a person.
    expect(await findEntityByIdentity(sql, WS, 'person', 'email:no-reply@acme.com')).toBeNull();

    // Replaying both sources adds no person.
    const before = live(await graphRows('PER-', 'person')).map((r) => r.feature_id);
    await sync(mail);
    await sync(phone);
    expect(live(await graphRows('PER-', 'person')).map((r) => r.feature_id)).toEqual(before);
  });

  it('a source that does not route person to record projects no interaction participants (D-013 grant)', async () => {
    feeds[PHONE] = [{ datatype: 'call', nativeId: 'call-1', payload: { from: '+1 555 123 4567', participants: ['Ada <ada@acme.com>'] } }];
    const phone = await connect(PHONE, { call: ['document'] });
    await sync(phone);
    // Positive control: the call itself was stored, so the empty graph is the grant, not a dropped delivery.
    const stored = await sql<{ sink_kind: string }[]>`
      SELECT sink_kind FROM harness_shared.trigger_deliveries WHERE workspace_id = ${WS} AND source_id = ${phone}::uuid AND datatype_id = 'call'`;
    const kinds = stored.map((s) => s.sink_kind);
    expect(kinds, JSON.stringify(kinds)).toContain('data-source-document');
    // The grant: no participant sink is attached for a source that does not route person to record.
    expect(kinds, JSON.stringify(kinds)).not.toContain('relationship-graph-participants');
    expect(await graphRows('DSR-', 'person')).toEqual([]);
    expect(await graphRows('PER-', 'person')).toEqual([]);
  });

  it('interaction sources grant person -> record by default (migration 1413 restores 1393 over the 1395 hold, D-017/D-020, WI-10006589)', async () => {
    // 1393 made person -> record the gmail/gcal default; 1395 held it back while the release running
    // connector-sync still aborted a harnessless personal source's sync on it; 1413 restores it once
    // the D-020 fix served on the connector-sync host. Migrations apply in order, so this reads 1413.
    const defaults = await sql<Array<{ kind: string; policy: Record<string, string[]> }>>`
      SELECT k AS kind, (harness_shared.data_source_kind_defaults(k)).destination_policy AS policy
        FROM unnest(ARRAY['gmail', 'gcal', 'contacts']::text[]) AS k`;
    const byKind = Object.fromEntries(defaults.map((d) => [d.kind, d.policy]));
    expect(byKind.gmail).toEqual({ 'email-message': ['document', 'event'], person: ['record'] });
    expect(byKind.gcal).toEqual({ 'calendar-event': ['document', 'event'], person: ['record'] });
    // Contacts are not an interaction source: D-015 brings contacts in as connector person records.
    expect(byKind.contacts).toEqual({ contact: ['document', 'event'] });

    // The INSERT trigger applies the kind default to a newly connected source with no policy.
    const [row] = await sql<Array<{ id: string; policy: Record<string, string[]> }>>`
      INSERT INTO harness_shared.data_sources
        (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
         destination_policy, permission_mapping)
      VALUES (${WS}, 'gmail', ${alice}, ${`gmail-default-${Date.now()}-${Math.random()}`}, 'connected',
              ${sql.json({ harnessSlug: HARNESS })}, 'organization', '{}'::jsonb, ${sql.json({ mode: 'source-acl' })})
      RETURNING id::text, destination_policy AS policy`;
    try {
      // Positive control: the trigger did apply the kind default (the interaction route is there).
      expect(row!.policy['email-message']).toEqual(['document', 'event']);
      // The grant rides in with the default, so a newly connected Google source feeds the graph.
      expect(row!.policy.person).toEqual(['record']);
    } finally {
      await sql`DELETE FROM harness_shared.data_sources WHERE id = ${row!.id}::uuid`;
    }
  });

  it('migration 1413 re-grants person -> record on existing interaction sources, harnessless personal ones included, and re-runs as a no-op (WI-10006589)', async () => {
    // The subject is the real migration file: the armed .sql, or its .DRAFT while it is being written.
    // MIGRATION_1413_PATH points the test at a copy, which is how scripts/mutation-probe.sh proves it can fail.
    const armed = fileURLToPath(new URL('../../../../libs/papercusp/libs/db/sql/1413-restore-interaction-person-grant.sql', import.meta.url));
    const subject = process.env.MIGRATION_1413_PATH ?? (existsSync(armed) ? armed : `${armed}.DRAFT`);
    const migration = readFileSync(subject, 'utf8');
    const insert = async (kind: string, scope: 'personal' | 'organization', config: Record<string, string>, policy: Record<string, string[]>) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO harness_shared.data_sources
          (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope,
           destination_policy, permission_mapping)
        VALUES (${WS}, ${kind}, ${alice}, ${`${kind}-1413-${Date.now()}-${Math.random()}`}, 'connected',
                ${sql.json(config)}, ${scope}, ${sql.json(policy)}, ${sql.json({ mode: 'source-acl' })})
        RETURNING id::text`;
      return row!.id;
    };
    // The shape 1395 left behind on the live database: a personal Google source with no harnessSlug.
    const held = await insert('gmail', 'personal', {}, { 'email-message': ['document', 'event'] });
    const otherRoute = await insert('gcal', 'organization', { harnessSlug: HARNESS }, { 'calendar-event': ['document', 'event'], person: ['document'] });
    const notInteraction = await insert('slack', 'organization', { harnessSlug: HARNESS }, { 'chat-message': ['document', 'event'] });
    const ids = [held, otherRoute, notInteraction];
    const policies = async () =>
      Object.fromEntries(
        (await sql<Array<{ id: string; policy: Record<string, string[]> }>>`
          SELECT id::text, destination_policy AS policy FROM harness_shared.data_sources WHERE id = ANY(${ids}::uuid[])`).map((r) => [r.id, r.policy]),
      );
    try {
      // Positive control: the fixtures start without the grant, so the assertions below measure 1413.
      const before = await policies();
      expect(before[held]!.person).toBeUndefined();
      expect(before[otherRoute]!.person).toEqual(['document']);

      await sql.unsafe(migration);
      const after = await policies();
      expect(after[held]).toEqual({ 'email-message': ['document', 'event'], person: ['record'] });
      // Other person routes a source already had are kept beside the grant.
      expect(after[otherRoute]!.person).toEqual(['document', 'record']);
      // Only sources that route an interaction datatype are touched.
      expect(after[notInteraction]).toEqual({ 'chat-message': ['document', 'event'] });

      await sql.unsafe(migration);
      expect(await policies()).toEqual(after);
    } finally {
      await sql`DELETE FROM harness_shared.data_sources WHERE id = ANY(${ids}::uuid[])`;
    }
  });
});
