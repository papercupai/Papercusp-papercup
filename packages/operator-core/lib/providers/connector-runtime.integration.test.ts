/**
 * R-3 — one host-owned connector sync runtime
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05, P-004).
 *
 * A scripted fake provider is registered in a real provider registry and driven
 * through restarts, a provider dying mid-page, expired cursors, duplicate pages,
 * edits, deletes and 429 responses. Every assertion reads the REAL ingestion
 * ledger (`harness_shared.trigger_deliveries`) and the real lease/cursor/backoff
 * columns on `harness_shared.data_sources` (migration 1360).
 *
 * The falsifiers this file pins (R-3): a replay duplicates a delivery, an
 * interrupted sync skips an object, a rate-limited provider advances an
 * uncommitted cursor, or a provider that dies mid-page leaves a cursor committed
 * past undelivered objects.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostFetch,
  ProviderAdapter,
  ProviderDescriptor,
  ProviderRecord,
  ProviderSyncPage,
  ProviderSyncRequest,
} from '@papercusp/plugin-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { upsertChatMessages } from '../data-sources/chat-retrieval-units';
import { createDatatypeDestinationSinks } from '../data-sources/datatype-destination-sink';
import { getDatatype, upsertDatatype } from '../datatype-registry-store';
import { ingestExternalTriggerEvent, type IngestExternalTriggerInput } from '../external-triggers/ingestion';
import { createProviderRegistry, providerRegistry, type ProviderRegistry } from '../integrations/provider-registry';
import {
  connectorRecordDedupeKey,
  formatConnectorSyncLog,
  ProviderSyncFailure,
  runConnectorSync,
  wakeConnectorSource,
  type ConnectorSyncDeps,
  type ConnectorSyncResult,
} from './connector-runtime';
import { listUnhealthyConnectorSources } from './connector-source-health';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';

// A sync pass records fallback observations; their timer flush opens the live org-admin pool,
// which the real-PG rail refuses with a console.warn that fails whichever test is running
// (WI-6554700010018422, same stub as get-feedback-core.integration.test.ts / WI-6554700010009686).
// The afterAll guard keeps the stub honest: nothing else in this file may reach the live pool.
vi.mock('../degradation/fallback-observations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../degradation/fallback-observations')>()),
  observeFallback: vi.fn(() => true),
}));
afterAll(() => { expect(readRealPgRailBlocks().blocked).toBe(0); });

const WS = 'connector-runtime-test';
const KIND = 'connector-fixture';
const DRIVER = 'driver-a';
const OCCURRED_AT = '2026-10-01T09:00:00Z';

const descriptor: ProviderDescriptor = {
  id: KIND,
  contractVersion: 1,
  datatypes: ['email-message'],
  capabilities: ['mail.read'],
  egressHosts: ['graph.microsoft.com', 'login.microsoftonline.com'],
  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['Mail.Read'],
    pkce: true,
  },
};

let org: OrgTestDb;
let registry: ProviderRegistry;
/** The provider's behaviour for the current test; `host` is the host.fetch the driver handed it. */
let handler: (req: ProviderSyncRequest, host: { fetch: HostFetch }) => Promise<ProviderSyncPage>;
/** Every syncPage call the driver made, in order. */
let calls: Array<{ cursor: string | null; mode: string }>;
/** Dedupe key of every REAL event-bus delivery (a deduped replay never emits). */
let emitted: string[];
/** Simulates the host dying while admitting a page: throw once this many records were admitted. */
let crashIngestAfter: number | null;
let ingestCalls: number;

const adapter: ProviderAdapter = {
  describe: () => descriptor,
  syncPage: async (req, host) => {
    calls.push({ cursor: req.cursor, mode: req.mode });
    return handler(req, host);
  },
  invoke: async () => ({ ok: true }),
};

const noNetwork = (async () => {
  throw new Error('connector-runtime test: the fake provider never fetches');
}) as unknown as HostFetch;

async function ingest(sql: OrgTestDb['adminSql'], input: IngestExternalTriggerInput) {
  if (crashIngestAfter !== null && ingestCalls >= crashIngestAfter) {
    throw new Error('host process died while admitting the page');
  }
  ingestCalls += 1;
  return ingestExternalTriggerEvent(sql, input, {
    emit: async (event) => {
      emitted.push(String((event.payload as { dedupeKey?: unknown } | undefined)?.dedupeKey));
      return { ok: true, key: event.key, woken: 0, notified: [], msgId: null, waiters: 0 };
    },
  });
}

function deps(overrides: Partial<ConnectorSyncDeps> = {}): ConnectorSyncDeps {
  return {
    registry,
    ingest,
    sinksFor: async () => [],
    hostFetchFor: () => noNetwork,
    leaseOwner: DRIVER,
    ...overrides,
  };
}

function sync(sourceId: string, overrides: Partial<ConnectorSyncDeps> = {}): Promise<ConnectorSyncResult> {
  return runConnectorSync(
    org.adminSql,
    { workspaceId: WS, harness: 'papercusp', sourceIds: [sourceId], pollIntervalSeconds: 300 },
    deps(overrides),
  );
}

/** Run one pass and return the single source outcome. */
async function syncOne(sourceId: string, overrides: Partial<ConnectorSyncDeps> = {}) {
  const result = await sync(sourceId, overrides);
  expect(result.sources).toHaveLength(1);
  return result.sources[0];
}

function mail(nativeId: string, subject = 'Quarterly', extra: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    datatype: 'email-message',
    nativeId,
    event: 'message.received',
    payload: { id: nativeId, from: 'carol@example.com', to: ['alice@example.com'], subject, text: 'Body' },
    occurredAt: OCCURRED_AT,
    ...extra,
  };
}

function page(records: ProviderRecord[], nextCursor: string | null, hasMore: boolean): ProviderSyncPage {
  return { records, nextCursor, hasMore };
}

/** Provider behaviour keyed by the cursor it is asked for (`start` = null). */
function scripted(steps: Record<string, ProviderSyncPage | (() => never)>) {
  return async (req: ProviderSyncRequest): Promise<ProviderSyncPage> => {
    const step = steps[req.cursor ?? 'start'];
    if (!step) throw new Error(`fake provider: unscripted cursor ${req.cursor ?? 'start'}`);
    return typeof step === 'function' ? step() : step;
  };
}

const fail = (cause: unknown) => (): never => {
  throw cause;
};

async function createSource(): Promise<string> {
  const [row] = await org.adminSql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, provider_account_id, status)
    VALUES (${WS}, ${KIND}, ${`acct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'ready')
    RETURNING id::text`;
  return row.id;
}

interface SourceState {
  cursor: string | null;
  backfill_status: string;
  status: string;
  failure_count: number;
  next_in: number | null;
  lease_owner: string | null;
  last_error: string | null;
  progress: { catchUp?: ProviderSyncPage['catchUp']; lossRisk?: ProviderSyncPage['lossRisk']; lastSyncedAt?: string } | null;
}

async function state(sourceId: string): Promise<SourceState> {
  const [row] = await org.adminSql<SourceState[]>`
    SELECT cursor->>'provider' AS cursor,
           backfill_status,
           status,
           sync_failure_count AS failure_count,
           EXTRACT(EPOCH FROM sync_next_attempt_at - now())::float8 AS next_in,
           sync_lease_owner AS lease_owner,
           last_error,
           cursor->'providerSync' AS progress
      FROM harness_shared.data_sources
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  return row;
}

/** Time passes: the source's backoff / poll interval has elapsed. */
async function makeDue(sourceId: string): Promise<void> {
  await org.adminSql`
    UPDATE harness_shared.data_sources SET sync_next_attempt_at = now() - interval '1 second'
     WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
}

/** Ledger rows for a source: one per (dedupe key, sink). */
async function ledger(sourceId: string): Promise<Array<{ dedupe_key: string; sink_kind: string; n: number }>> {
  return org.adminSql<Array<{ dedupe_key: string; sink_kind: string; n: number }>>`
    SELECT dedupe_key, sink_kind, count(*)::int AS n
      FROM harness_shared.trigger_deliveries
     WHERE workspace_id = ${WS} AND source_id = ${sourceId}::uuid
     GROUP BY dedupe_key, sink_kind
     ORDER BY dedupe_key, sink_kind`;
}

async function ledgerKeys(sourceId: string): Promise<string[]> {
  return [...new Set((await ledger(sourceId)).map((row) => row.dedupe_key))].sort();
}

const keysFor = (sourceId: string, records: ProviderRecord[]) =>
  records.map((record) => connectorRecordDedupeKey(sourceId, record)).sort();

/** Exactly-once: no (key, sink) row twice and no key emitted twice. */
async function expectExactlyOnce(sourceId: string): Promise<void> {
  for (const row of await ledger(sourceId)) expect(row.n, `${row.dedupe_key}/${row.sink_kind}`).toBe(1);
  const keys = emitted.filter((key) => key.startsWith(`connector:${sourceId}:`));
  expect(keys.length, 'an event-bus delivery was emitted twice').toBe(new Set(keys).size);
}

async function copyDatatype(id: string): Promise<void> {
  const base = await getDatatype(org.adminSql, 'papercusp-workspace', id);
  if (!base) throw new Error(`connector_runtime_test_datatype_missing:${id}`);
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
    createdBy: 'connector-runtime-integration',
  });
}

beforeAll(async () => {
  org = await createOrgTestDb();
  await copyDatatype('email-message');
  registry = createProviderRegistry();
  await registry.register({ descriptor, adapter, pluginName: 'connector-fixture-plugin' });
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(() => {
  handler = async () => page([], null, false);
  calls = [];
  emitted = [];
  crashIngestAfter = null;
  ingestCalls = 0;
});

describe('connector sync driver over registered providers (R-3)', () => {
  it('does not lease or poll a write-only package, and resumes after same-id replacement', async () => {
    const src = await createSource();
    const before = await state(src);
    const hostFetchFor = vi.fn(() => noNetwork);
    const servicesFor = vi.fn(async () => undefined);
    registry.unregister(KIND);
    const writeOnly = { ...descriptor, sync: false };
    await registry.register({ descriptor: writeOnly, adapter: { ...adapter, describe: () => writeOnly }, pluginName: 'write-only-fixture' });
    try {
      const result = await sync(src, { hostFetchFor, servicesFor });
      expect(result.sources).toEqual([]);
      expect(calls).toEqual([]);
      expect(hostFetchFor).not.toHaveBeenCalled();
      expect(servicesFor).not.toHaveBeenCalled();
      expect(await state(src)).toEqual(before);
      expect(await ledgerKeys(src)).toEqual([]);
    } finally {
      registry.unregister(KIND);
      await registry.register({ descriptor, adapter, pluginName: 'connector-fixture-plugin' });
    }
    expect((await syncOne(src, { hostFetchFor, servicesFor })).outcome).toBe('synced');
    expect(calls).toHaveLength(1);
    expect(hostFetchFor).toHaveBeenCalledOnce();
    expect((await state(src)).progress?.lastSyncedAt).toBeTruthy();
  });

  it('skips a due source until descriptor-required config is present without recording a sync failure', async () => {
    const src = await createSource();
    const configDescriptor: ProviderDescriptor = {
      ...descriptor,
      configSchema: {
        type: 'object',
        properties: { teamIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
        required: ['teamIds'],
      },
    };
    const configRegistry = createProviderRegistry();
    await configRegistry.register({
      descriptor: configDescriptor,
      adapter: { ...adapter, describe: () => configDescriptor },
      pluginName: 'connector-config-readiness-test-plugin',
    });
    const hostFetchFor = vi.fn(() => noNetwork);
    const servicesFor = vi.fn(async () => undefined);

    const outcome = await syncOne(src, { registry: configRegistry, hostFetchFor, servicesFor });

    expect(outcome).toMatchObject({
      outcome: 'needs-config',
      mode: 'backfill',
      missingConfig: ['teamIds'],
      pages: 0,
    });
    expect(calls).toEqual([]);
    expect(hostFetchFor).not.toHaveBeenCalled();
    expect(servicesFor).not.toHaveBeenCalled();
    expect(await state(src)).toMatchObject({
      cursor: null,
      status: 'ready',
      failure_count: 0,
      lease_owner: null,
      last_error: null,
    });
    expect(formatConnectorSyncLog({ providers: 1, sources: [outcome] })).toContain('needs_config=1');
  });

  it('refuses an undeclared membership snapshot without committing its cursor', async () => {
    const src = await createSource();
    handler = async () => ({ ...page([], 'untrusted', false), membership: { members: [{ providerUserId: '42' }] } });
    const applyMembership = vi.fn();
    await syncOne(src, { applyMembership });
    expect(applyMembership).not.toHaveBeenCalled();
    expect(await state(src)).toMatchObject({ cursor: null, failure_count: 1 });
  });

  it('applies declared membership before cursor commit and replays after an apply failure', async () => {
    const src = await createSource();
    descriptor.membership = { identityProvider: 'fixture' };
    try {
      handler = async () => ({ ...page([], 'members-committed', false), membership: { members: [{ providerUserId: '42' }] } });
      const applyMembership = vi.fn<NonNullable<ConnectorSyncDeps['applyMembership']>>(async () => {
        expect((await state(src)).cursor).toBeNull();
        throw new Error('membership write interrupted');
      });
      await syncOne(src, { applyMembership });
      expect(await state(src)).toMatchObject({ cursor: null, failure_count: 1 });
      await makeDue(src);
      applyMembership.mockImplementation(async () => {
        expect((await state(src)).cursor).toBeNull();
        return { applied: false, reason: 'not_organization_scope' };
      });
      expect(await syncOne(src, { applyMembership })).toMatchObject({ outcome: 'synced', membership: { applied: false } });
      expect((await state(src)).cursor).toBe('members-committed');
      expect(applyMembership).toHaveBeenCalledTimes(2);
    } finally {
      delete descriptor.membership;
    }
  });

  it('backfills every page, commits each cursor after admission, then polls incrementally', async () => {
    const src = await createSource();
    const first = [mail('m1'), mail('m2')];
    const second = [mail('m3')];
    handler = scripted({ start: page(first, 'c1', true), c1: page(second, 'c2', false) });

    const outcome = await syncOne(src);
    expect(outcome).toMatchObject({ outcome: 'synced', mode: 'backfill', pages: 2, admitted: 3, deduped: 0 });
    expect(calls).toEqual([
      { cursor: null, mode: 'backfill' },
      { cursor: 'c1', mode: 'backfill' },
    ]);
    const after = await state(src);
    expect(after).toMatchObject({ cursor: 'c2', backfill_status: 'complete', status: 'connected', failure_count: 0, lease_owner: null });
    expect(after.next_in).toBeGreaterThan(200); // the poll interval, not "due now"
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [...first, ...second]));
    await expectExactlyOnce(src);

    // Not due yet: the driver does not touch the provider.
    expect((await sync(src)).sources).toEqual([]);

    await makeDue(src);
    const fourth = [mail('m4')];
    handler = scripted({ c2: page(fourth, 'c3', false) });
    const incremental = await syncOne(src);
    expect(incremental).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 1 });
    expect(calls.at(-1)).toEqual({ cursor: 'c2', mode: 'incremental' });
    expect((await state(src)).cursor).toBe('c3');
  });

  it('resolves sinks once per datatype per sync, not once per record (P-011)', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('s1'), mail('s2'), mail('s3')], 'c1', false) });
    const resolved: string[] = [];
    const outcome = await syncOne(src, {
      sinksFor: async (_sql, _source, datatype) => {
        resolved.push(datatype);
        return [];
      },
    });
    expect(outcome).toMatchObject({ outcome: 'synced', admitted: 3 });
    // Positive control: three records were admitted, so a per-record resolver would show 3.
    expect(resolved).toEqual(['email-message']);
  });

  it('an interrupted sync resumes from the last committed cursor and delivers each object exactly once', async () => {
    const src = await createSource();
    const first = [mail('m1')];
    const second = [mail('m2'), mail('m3'), mail('m4')];
    handler = scripted({ start: page(first, 'c1', true), c1: page(second, 'c2', false) });

    // The host dies after admitting m1 (page 1, committed) and m2, while admitting m3.
    crashIngestAfter = 2;
    const crashed = await syncOne(src);
    expect(crashed.outcome).toBe('failed');
    expect((await state(src)).cursor).toBe('c1'); // never past the undelivered m3/m4
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));

    // A real crash never ran the failure bookkeeping: leave a lapsed lease behind,
    // as a killed process would, and restart a fresh driver.
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET sync_lease_owner = 'dead-driver', sync_lease_expires_at = now() - interval '1 second'
       WHERE id = ${src}::uuid`;
    await makeDue(src);
    crashIngestAfter = null;
    const resumed = await syncOne(src, { leaseOwner: 'driver-restarted' });

    expect(resumed).toMatchObject({ outcome: 'synced', pages: 1, admitted: 2, deduped: 1 });
    expect(calls.at(-1)).toEqual({ cursor: 'c1', mode: 'backfill' }); // resumed, not restarted from scratch
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [...first, ...second])); // nothing skipped
    await expectExactlyOnce(src);
    expect(await state(src)).toMatchObject({ cursor: 'c2', backfill_status: 'complete', failure_count: 0, lease_owner: null });
  });

  it('a provider that dies mid-page commits no cursor past undelivered objects', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1')], 'c1', true),
      c1: fail(Object.assign(new Error('provider daemon exited'), { code: 'EPIPE' })),
    });
    const died = await syncOne(src);
    expect(died).toMatchObject({ outcome: 'failed', pages: 1, admitted: 1 });
    const afterDeath = await state(src);
    expect(afterDeath).toMatchObject({ cursor: 'c1', failure_count: 1, lease_owner: null });
    expect(afterDeath.next_in).toBeGreaterThan(20); // backed off
    expect(afterDeath.next_in).toBeLessThanOrEqual(30);

    // A half-written page (a record outside the descriptor's datatypes) is refused whole:
    // its valid record is not admitted and the cursor does not move.
    await makeDue(src);
    handler = scripted({
      c1: page([mail('m2'), { ...mail('bad'), datatype: 'calendar-event' }], 'c2', false),
    });
    expect((await syncOne(src)).outcome).toBe('failed');
    expect((await state(src)).cursor).toBe('c1');
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1')]));

    await makeDue(src);
    handler = scripted({ c1: page([mail('m2')], 'c2', false) });
    const recovered = await syncOne(src);
    expect(recovered).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));
    expect(await state(src)).toMatchObject({ cursor: 'c2', failure_count: 0, status: 'connected' });
    await expectExactlyOnce(src);
  });

  it('repeated failures back off exponentially and degrade the source health', async () => {
    const src = await createSource();
    handler = fail(new Error('upstream 503'));
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) await makeDue(src);
      expect((await syncOne(src)).outcome).toBe('failed');
      const s = await state(src);
      expect(s.failure_count).toBe(attempt);
      waits.push(Math.round(s.next_in ?? 0));
    }
    expect(waits[1]).toBeGreaterThan(waits[0]);
    expect(waits[2]).toBeGreaterThan(waits[1]);
    expect((await state(src)).status).toBe('degraded');

    await makeDue(src);
    handler = scripted({ start: page([mail('m1')], 'c1', false) });
    const recovery = await syncOne(src);
    expect(recovery.outcome).toBe('synced');
    // WI-6554700010018612: connector-sync resolves the source's health alarm on this field.
    expect(recovery.recoveredFrom).toBe('degraded');
    expect(await state(src)).toMatchObject({ status: 'connected', failure_count: 0, last_error: null });
  });

  it('an expired cursor resets to a fresh backfill once, and the replayed objects dedupe', async () => {
    const src = await createSource();
    const mailbox = [mail('m1'), mail('m2')];
    handler = scripted({ start: page(mailbox, 'c1', false) });
    await syncOne(src);

    await makeDue(src);
    handler = scripted({
      c1: fail(new ProviderSyncFailure({ kind: 'cursor-expired', message: 'history id too old' })),
      start: page(mailbox, 'c2', false),
    });
    const reset = await syncOne(src);
    expect(reset).toMatchObject({ outcome: 'synced', cursorReset: true, mode: 'backfill', admitted: 0, deduped: 2 });
    // WI-10001662 port: a full resync names the provider's reason, on the outcome and the log line.
    expect(reset.cursorResetReason).toBe('history id too old');
    expect(formatConnectorSyncLog({ providers: 1, sources: [reset] })).toContain(
      `cursor_resets=1 reset_reasons=${src}: history id too old`,
    );
    expect(calls.slice(-2)).toEqual([
      { cursor: 'c1', mode: 'incremental' },
      { cursor: null, mode: 'backfill' },
    ]);
    expect(await state(src)).toMatchObject({ cursor: 'c2', backfill_status: 'complete' });
    await expectExactlyOnce(src);

    // A provider that rejects the fresh cursor too is a failure, never a reset loop.
    await makeDue(src);
    const expired = fail(new ProviderSyncFailure({ kind: 'cursor-expired', message: 'still expired' }));
    handler = scripted({ c2: expired, start: expired });
    const callsBefore = calls.length;
    expect((await syncOne(src)).outcome).toBe('failed');
    expect(calls.length - callsBefore).toBe(2);
  });

  it('duplicate pages dedupe against the ledger (with a positive control for the counter)', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1'), mail('m2')], 'c1', true),
      c1: page([mail('m2'), mail('m3')], 'c2', false), // m2 repeated across pages
    });
    const outcome = await syncOne(src);
    expect(outcome).toMatchObject({ admitted: 3, deduped: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2'), mail('m3')]));
    await expectExactlyOnce(src);
    const emittedBefore = emitted.length;

    // Positive control: a driver that did NOT derive a replay-stable key would admit the
    // same object again. The same counters must see that second delivery, so the
    // exactly-once assertions above are not vacuous.
    await ingest(org.adminSql, {
      workspaceId: WS,
      sourceId: src,
      source: KIND,
      event: 'message.received',
      externalId: 'm2',
      datatypeId: 'email-message',
      adapterPayload: mail('m2').payload,
      normalize: (payload) => payload as Record<string, unknown>,
      occurredAt: OCCURRED_AT,
      dedupeKey: `connector:${src}:email-message:m2:unstable-${Date.now()}`,
    });
    expect(emitted.length).toBe(emittedBefore + 1);
    expect((await ledgerKeys(src)).length).toBe(4);
    await expect(expectExactlyOnce(src)).resolves.toBeUndefined(); // distinct keys, so still one row each
    expect(emitted.filter((key) => key.includes(':email-message:m2:')).length).toBe(2);
  });

  it('edits and deletes of an existing object are new deliveries; a replayed delete is not', async () => {
    const src = await createSource();
    const original = mail('m1', 'v1');
    const edited = mail('m1', 'v2');
    const deleted = mail('m1', 'v2', { event: 'message.deleted', deleted: true });
    handler = scripted({
      start: page([original], 'c1', false),
      c1: page([edited], 'c2', false),
      c2: page([deleted], 'c3', false),
      c3: page([deleted], 'c4', false),
    });

    expect((await syncOne(src)).admitted).toBe(1);
    await makeDue(src);
    expect((await syncOne(src)).admitted).toBe(1); // edit
    await makeDue(src);
    expect((await syncOne(src)).admitted).toBe(1); // delete
    await makeDue(src);
    expect(await syncOne(src)).toMatchObject({ admitted: 0, deduped: 1 }); // delete replayed

    expect(await ledgerKeys(src)).toEqual(keysFor(src, [original, edited, deleted]));
    await expectExactlyOnce(src);
  });

  it('a 429 keeps the committed cursor and waits out retry-after; a push wake does not override it', async () => {
    const src = await createSource();
    handler = scripted({
      start: page([mail('m1')], 'c1', true),
      c1: fail(new ProviderSyncFailure({ kind: 'rate-limited', retryAfterSeconds: 120, message: '429 Too Many Requests' })),
    });
    const limited = await syncOne(src);
    expect(limited).toMatchObject({ outcome: 'rate-limited', admitted: 1 });
    const s = await state(src);
    expect(s).toMatchObject({ cursor: 'c1', status: 'connected', failure_count: 1, lease_owner: null });
    expect(s.next_in).toBeGreaterThan(100);
    expect(s.next_in).toBeLessThanOrEqual(120);

    const callsBefore = calls.length;
    expect((await sync(src)).sources).toEqual([]); // still cooling down
    expect(await wakeConnectorSource(org.adminSql, { workspaceId: WS, sourceId: src })).toBe(true);
    expect((await sync(src)).sources).toEqual([]); // the wake never overrides a backoff
    expect(calls.length).toBe(callsBefore);

    // A JSON-RPC shaped error from a daemon provider classifies the same way.
    await makeDue(src);
    handler = scripted({
      c1: fail({ code: -32000, message: 'provider error', data: { kind: 'rate-limited', retryAfterSeconds: 60 } }),
    });
    expect((await syncOne(src)).outcome).toBe('rate-limited');
    const again = await state(src);
    expect(again.cursor).toBe('c1');
    expect(again.next_in).toBeGreaterThan(40);
    expect(again.next_in).toBeLessThanOrEqual(60);

    await makeDue(src);
    handler = scripted({ c1: page([mail('m2')], 'c2', false) });
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(await ledgerKeys(src)).toEqual(keysFor(src, [mail('m1'), mail('m2')]));
  });

  it('a push wake makes a healthy source due immediately', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('m1')], 'c1', false), c1: page([mail('m2')], 'c2', false) });
    await syncOne(src);
    expect((await sync(src)).sources).toEqual([]); // polled recently

    expect(await wakeConnectorSource(org.adminSql, { workspaceId: WS, sourceId: src })).toBe(true);
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 1 });
  });

  it('skips a source whose lease another live driver holds, and takes over a lapsed one', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('m1')], 'c1', false) });
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET sync_lease_owner = 'driver-b', sync_lease_expires_at = now() + interval '5 minutes'
       WHERE id = ${src}::uuid`;
    expect((await syncOne(src)).outcome).toBe('leased-elsewhere');
    expect(calls).toEqual([]);
    expect(await ledger(src)).toEqual([]);
    expect((await state(src)).lease_owner).toBe('driver-b');

    await org.adminSql`
      UPDATE harness_shared.data_sources SET sync_lease_expires_at = now() - interval '1 second'
       WHERE id = ${src}::uuid`;
    expect((await syncOne(src)).outcome).toBe('synced');
    expect((await state(src)).lease_owner).toBeNull();
  });

  it('an auth failure marks the source reconnect-required and stops syncing it', async () => {
    const src = await createSource();
    handler = fail(new ProviderSyncFailure({ kind: 'auth', message: 'invalid_grant' }));
    expect(await syncOne(src)).toMatchObject({ outcome: 'reconnect-required', error: 'invalid_grant' });
    const s = await state(src);
    expect(s.status).toBe('error');
    expect(s.last_error).toMatch(/^reconnect_required: invalid_grant/);
    await makeDue(src);
    expect((await sync(src)).sources).toEqual([]);
  });

  // WI-6554700010018612: the health alarm reads unhealthy sources straight from data_sources, because
  // an `error` source is never synced again and so never appears in a pass result.
  it('lists an unhealthy source for the health alarm, and a clean first pass is not a recovery', async () => {
    const healthy = await createSource();
    const first = await syncOne(healthy);
    expect(first.outcome).toBe('synced');
    expect(first).not.toHaveProperty('recoveredFrom');

    const broken = await createSource();
    handler = fail(new ProviderSyncFailure({ kind: 'auth', message: 'invalid_grant' }));
    await syncOne(broken);

    const listed = await listUnhealthyConnectorSources(org.adminSql, WS);
    const ids = listed.map((source) => source.id);
    expect(ids).toContain(broken);
    expect(ids).not.toContain(healthy);
    expect(listed.find((source) => source.id === broken)).toMatchObject({
      kind: KIND,
      status: 'error',
      failureCount: 1,
      lastError: expect.stringMatching(/^reconnect_required: invalid_grant/),
      lastSuccessAt: null,
    });
  });
});

/**
 * Readership per container (cupboard-distributable-integrations-2026-10-10 D-026): a source made of
 * containers (Slack channels) gets one permission list per container, and each record's document is
 * bound to its own container's list, so nobody reads a channel they are not in.
 */
describe('container readership and source scope (D-026)', () => {
  const member = (providerUserId: string) => ({ providerUserId });

  async function orgSource(): Promise<string> {
    const [row] = await org.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.data_sources
        (workspace_id, kind, provider_account_id, status, scope, destination_policy, permission_mapping)
      VALUES (${WS}, ${KIND}, ${`org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`}, 'ready', 'organization',
              ${org.adminSql.json({ 'email-message': ['document'] })}, ${org.adminSql.json({ mode: 'source-acl' })})
      RETURNING id::text`;
    return row.id;
  }

  /** The source-wide list and every container list of a source, with their members. */
  async function lists(src: string) {
    return org.adminSql<Array<{ source_ref: string; title: string; members: string[] }>>`
      SELECT l.source_ref, l.title,
             coalesce(array_agg(m.provider_user_id ORDER BY m.provider_user_id)
                        FILTER (WHERE m.provider_user_id IS NOT NULL), '{}') AS members
        FROM harness_shared.document_permission_lists l
        LEFT JOIN harness_shared.document_permission_members m ON m.workspace_id = l.workspace_id AND m.list_id = l.id
       WHERE l.workspace_id = ${WS} AND (l.source_ref = ${src} OR l.source_ref LIKE ${`${src}#%`})
       GROUP BY l.source_ref, l.title
       ORDER BY l.source_ref`;
  }

  /** Which list each of the source's documents is bound to. */
  async function documentLists(src: string) {
    return org.adminSql<Array<{ external_id: string; source_ref: string; acl_ref: string | null }>>`
      SELECT d.external_id, l.source_ref, d.metadata->>'aclRef' AS acl_ref
        FROM harness_shared.documents d
        JOIN harness_shared.document_permission_lists l ON l.id = d.permission_list_id
       WHERE d.workspace_id = ${WS} AND position(${src} in d.dedupe_key) > 0
       ORDER BY d.external_id`;
  }

  /** The production document sink, without the other connector sinks. */
  const documentSinks: ConnectorSyncDeps['sinksFor'] = (sql, source, datatype) =>
    createDatatypeDestinationSinks(sql, { workspaceId: source.workspaceId, sourceId: source.id, datatype });

  async function withMembership<T>(membership: ProviderDescriptor['membership'], run: () => Promise<T>): Promise<T> {
    descriptor.membership = membership;
    try {
      return await run();
    } finally {
      delete descriptor.membership;
    }
  }

  it('binds each document to its container list, empties a container the next snapshot drops, and keeps an unseen container unreadable', async () => {
    const src = await orgSource();
    await withMembership({ identityProvider: 'fixture', containers: true }, async () => {
      handler = scripted({
        start: {
          ...page([mail('m1', 'In general', { aclRef: 'C1' }), mail('m2', 'In private', { aclRef: 'C2' }), mail('m3', 'Source-wide')], 'c1', false),
          membership: {
            members: [member('U0')],
            containers: [
              { ref: 'C1', title: '#general', members: [member('U1'), member('U2')] },
              { ref: 'C2', title: '#private', members: [member('U2')] },
            ],
          },
        },
      });
      const first = await syncOne(src, { sinksFor: documentSinks });
      expect(first).toMatchObject({ outcome: 'synced', admitted: 3, membership: { applied: true, containers: 2 } });
      expect(await lists(src)).toEqual([
        { source_ref: src, title: '', members: ['U0'] },
        { source_ref: `${src}#C1`, title: '#general', members: ['U1', 'U2'] },
        { source_ref: `${src}#C2`, title: '#private', members: ['U2'] },
      ]);
      expect(await documentLists(src)).toEqual([
        { external_id: 'm1', source_ref: `${src}#C1`, acl_ref: 'C1' },
        { external_id: 'm2', source_ref: `${src}#C2`, acl_ref: 'C2' },
        { external_id: 'm3', source_ref: src, acl_ref: null },
      ]);

      // The app left #private and a message arrives in a channel membership has not named yet.
      await makeDue(src);
      handler = scripted({
        c1: {
          ...page([mail('m4', 'Not yet named', { aclRef: 'C3' })], 'c2', false),
          membership: { members: [member('U0')], containers: [{ ref: 'C1', members: [member('U1')] }] },
        },
      });
      expect(await syncOne(src, { sinksFor: documentSinks })).toMatchObject({ outcome: 'synced', mode: 'incremental', admitted: 1 });
      expect(await lists(src)).toEqual([
        { source_ref: src, title: '', members: ['U0'] },
        { source_ref: `${src}#C1`, title: '#general', members: ['U1'] },
        { source_ref: `${src}#C2`, title: '#private', members: [] },
        { source_ref: `${src}#C3`, title: '', members: [] },
      ]);
      expect((await documentLists(src)).find((doc) => doc.external_id === 'm4')).toEqual({
        external_id: 'm4',
        source_ref: `${src}#C3`,
        acl_ref: 'C3',
      });
    });
  });

  it('refuses containers and aclRefs a descriptor does not allow, without committing the cursor', async () => {
    const applyMembership = vi.fn();
    const refused = async (membership: ProviderDescriptor['membership'], result: ProviderSyncPage) => {
      const src = await orgSource();
      handler = async () => result;
      await withMembership(membership, () => syncOne(src, { applyMembership }));
      return state(src);
    };
    const snapshot = (containers: unknown) => ({ members: [member('U0')], containers }) as ProviderSyncPage['membership'];
    const flat = { identityProvider: 'fixture' };
    const containers = { identityProvider: 'fixture', containers: true };

    // Containers from a provider whose descriptor does not declare them.
    expect(await refused(flat, { ...page([], 'x', false), membership: snapshot([{ ref: 'C1', members: [] }]) }))
      .toMatchObject({ cursor: null, failure_count: 1 });
    // A container named twice, a malformed ref, and a container without a member list.
    for (const bad of [
      [{ ref: 'C1', members: [] }, { ref: 'C1', members: [] }],
      [{ ref: 'two words', members: [] }],
      [{ ref: 'C1' }],
    ]) {
      expect(await refused(containers, { ...page([], 'x', false), membership: snapshot(bad) })).toMatchObject({ cursor: null, failure_count: 1 });
    }
    // A record naming a container: only allowed when containers are declared, and only a well-formed ref.
    expect(await refused(flat, page([mail('m1', 'x', { aclRef: 'C1' })], 'x', false))).toMatchObject({ cursor: null, failure_count: 1 });
    expect(await refused(containers, page([mail('m1', 'x', { aclRef: 'two words' })], 'x', false))).toMatchObject({ cursor: null, failure_count: 1 });
    expect(applyMembership).not.toHaveBeenCalled();

    // Positive control: the same shapes pass once declared and well formed.
    const ok = await orgSource();
    handler = async () => ({ ...page([mail('m1', 'x', { aclRef: 'C1' })], 'x', false), membership: snapshot([{ ref: 'C1', members: [] }]) });
    applyMembership.mockResolvedValue({ applied: false, reason: 'not_organization_scope' });
    await withMembership(containers, () => syncOne(ok, { applyMembership }));
    expect(await state(ok)).toMatchObject({ cursor: 'x', failure_count: 0 });
    expect(applyMembership).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: ok }), {
      identityProvider: 'fixture',
      members: [member('U0')],
      containers: [{ ref: 'C1', members: [] }],
    });
  });

  it('preserves the rejected cursor for catch-up and records retention loss in source health (P-032)', async () => {
    const src = await createSource();
    handler = scripted({ start: page([mail('m1')], 'old', false) });
    await syncOne(src);
    await makeDue(src);
    const lossRisk = { kind: 'retention-window-exceeded' as const, oldestReachableAt: '2026-10-02T00:00:00Z', detail: 'Events before this boundary were discarded' };
    handler = async (req) => {
      if (req.cursor === 'old') throw new ProviderSyncFailure({ kind: 'cursor-expired', message: 'retention expired' });
      expect(req).toMatchObject({ cursor: null, mode: 'backfill', catchUpFrom: 'old' });
      return { ...page([mail('m2')], 'new', false), catchUp: { path: 'backfill', reason: 'cursor-expired' }, lossRisk };
    };
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', cursorReset: true, lossRisk });
    expect(await state(src)).toMatchObject({ cursor: 'new', status: 'degraded', failure_count: 0,
      progress: { lossRisk, catchUp: { path: 'backfill', reason: 'cursor-expired' } } });
    expect((await state(src)).last_error).toContain('oldest_reachable_at=2026-10-02T00:00:00Z');
    expect(Number.isFinite(Date.parse((await state(src)).progress!.lastSyncedAt!))).toBe(true);
    await makeDue(src);
    handler = async () => page([], 'later', false);
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced', lossRisk });
    expect(await state(src)).toMatchObject({ cursor: 'later', status: 'degraded', progress: { lossRisk } });
    await expectExactlyOnce(src);
  });

  it('refuses malformed retention evidence before admission or cursor commit (P-032)', async () => {
    const src = await createSource();
    handler = async () => ({ ...page([mail('m1')], 'bad', false),
      lossRisk: { kind: 'retention-window-exceeded', oldestReachableAt: 'yesterday', detail: '' } });
    expect(await syncOne(src)).toMatchObject({ outcome: 'failed', admitted: 0 });
    expect(await state(src)).toMatchObject({ cursor: null, progress: null });
    expect(await ledger(src)).toEqual([]);
  });

  it('keeps the rejected cursor across a failed reset backfill and a later pass (P-032)', async () => {
    const src = await createSource();
    handler = scripted({ start: page([], 'old', false) });
    await syncOne(src);
    await makeDue(src);
    handler = async (req) => {
      if (req.cursor === 'old') throw { kind: 'cursor-expired', message: 'retention expired' };
      expect(req.catchUpFrom).toBe('old');
      throw new Error('remote unavailable during backfill');
    };
    expect(await syncOne(src)).toMatchObject({ outcome: 'failed', cursorReset: true });
    expect(await state(src)).toMatchObject({ cursor: null, progress: { catchUpFrom: 'old' } });
    await makeDue(src);
    handler = async (req) => {
      expect(req).toMatchObject({ cursor: null, mode: 'backfill', catchUpFrom: 'old' });
      return page([], null, false);
    };
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced' });
    expect(await state(src)).toMatchObject({ cursor: null, progress: { catchUpFrom: null } });
    expect(Number.isFinite(Date.parse((await state(src)).progress!.lastSyncedAt!))).toBe(true);
  });

  it('does not commit a page loss warning past a failed record admission (P-032)', async () => {
    const src = await createSource();
    crashIngestAfter = 0;
    handler = async () => ({ ...page([mail('m1')], 'bad', false),
      lossRisk: { kind: 'capped-window-overflow', oldestReachableAt: '2026-10-02T00:00:00Z', detail: 'Capped read could not close the gap' } });
    expect(await syncOne(src)).toMatchObject({ outcome: 'failed' });
    expect(await state(src)).toMatchObject({ cursor: null, progress: null });
  });

  it('applies each coverage window after the page is admitted and before its cursor commits (WI-6554700010012278)', async () => {
    const cursorsSeen: Array<string | null> = [];
    const reconcileCoverage = vi.fn(async (_sql: unknown, source: { id: string }, _coverage: unknown) => {
      cursorsSeen.push((await state(source.id)).cursor);
      return { tombstoned: 2 };
    });
    const window = { datatype: 'email-message', containerRef: 'C1', from: '2026-09-30T10:00:00.000Z', to: '2026-09-30T11:00:00.000Z', nativeIds: ['m1'] };
    const thread = { ...window, threadRef: 'T1', nativeIds: [] };
    const src = await orgSource();
    handler = async () => ({ ...page([mail('m1')], 'x', false), coverage: [window, thread] });
    expect(await syncOne(src, { reconcileCoverage })).toMatchObject({ outcome: 'synced', coverageTombstoned: 4 });
    expect(reconcileCoverage.mock.calls.map((call) => call[2])).toEqual([window, thread]);
    expect(reconcileCoverage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: src }), window);
    expect(cursorsSeen).toEqual([null, null]);
    expect(await state(src)).toMatchObject({ cursor: 'x', failure_count: 0 });

    // A window for a datatype the descriptor does not declare is refused before anything is erased.
    reconcileCoverage.mockClear();
    const bad = await orgSource();
    handler = async () => ({ ...page([], 'x', false), coverage: [{ ...window, datatype: 'chat-message' }] });
    await syncOne(bad, { reconcileCoverage });
    expect(await state(bad)).toMatchObject({ cursor: null, failure_count: 1 });
    expect(reconcileCoverage).not.toHaveBeenCalled();
  });

  it('by default, a chat-message coverage window tombstones the stored messages it no longer holds (WI-6554700010012278)', async () => {
    const declared = descriptor.datatypes;
    descriptor.datatypes = [...declared, 'chat-message'];
    try {
      const src = await orgSource();
      await upsertChatMessages(org.adminSql, WS, src, [
        { channelId: 'C1', providerMessageId: 'C1:1.1', threadKey: null, body: 'kept', postedAt: '2026-09-30T10:00:00Z' },
        { channelId: 'C1', providerMessageId: 'C1:1.2', threadKey: null, body: 'deleted offline', postedAt: '2026-09-30T10:01:00Z' },
      ]);
      handler = async () => ({
        ...page([], 'x', false),
        coverage: [{ datatype: 'chat-message', containerRef: 'C1', nativeIds: ['C1:1.1'] }, { datatype: 'email-message', containerRef: 'C1', nativeIds: [] }],
      });
      expect(await syncOne(src)).toMatchObject({ outcome: 'synced', coverageTombstoned: 1 });
      const rows = await org.adminSql<{ provider_message_id: string; deleted: boolean }[]>`
        SELECT provider_message_id, deleted_at IS NOT NULL AS deleted FROM harness_shared.chat_messages
         WHERE workspace_id = ${WS} AND data_source_id = ${src}::uuid ORDER BY provider_message_id`;
      expect(rows).toEqual([
        { provider_message_id: 'C1:1.1', deleted: false },
        { provider_message_id: 'C1:1.2', deleted: true },
      ]);
    } finally {
      descriptor.datatypes = declared;
    }
  });

  it("passes the source's scope on every sync request", async () => {
    const scopes: Array<string | undefined> = [];
    handler = async (req) => {
      scopes.push(req.scope);
      return page([], null, false);
    };
    await syncOne(await orgSource());
    const pot = await createSource();
    await org.adminSql`
      UPDATE harness_shared.data_sources SET scope = 'pot', scope_ref = 'connector-pot'
       WHERE workspace_id = ${WS} AND id = ${pot}::uuid`;
    await syncOne(pot);
    expect(scopes).toEqual(['organization', 'pot']);
  });

  it('gives a live-search (federated) source no sync pass, and the same source syncs once back on its own mode', async () => {
    handler = async () => page([], null, false);
    const src = await orgSource();
    const [{ sync_mode: ownMode }] = await org.adminSql<{ sync_mode: string }[]>`
      SELECT sync_mode FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND id = ${src}::uuid`;
    expect(ownMode).not.toBe('federated');
    await org.adminSql`
      UPDATE harness_shared.data_sources SET sync_mode = 'federated' WHERE workspace_id = ${WS} AND id = ${src}::uuid`;
    const skipped = await sync(src);
    expect(skipped.sources).toEqual([]);
    expect(calls).toEqual([]);

    // Positive control: the same source, back on its own mode, gets its pass.
    await org.adminSql`
      UPDATE harness_shared.data_sources SET sync_mode = ${ownMode} WHERE workspace_id = ${WS} AND id = ${src}::uuid`;
    expect(await syncOne(src)).toMatchObject({ outcome: 'synced' });
    expect(calls).toHaveLength(1);
  });
});

/**
 * D-020: a provider declaring `sync.adopt` starts a source a retired host path drove from that
 * path's freshest cursor, instead of null (a full re-walk under new delivery keys).
 */
describe('sync.adopt: adopting a pre-provider cursor (D-020)', () => {
  let adoptRegistry: ProviderRegistry;
  let adoptCalls: Array<Record<string, unknown>>;
  let adoptAnswer: () => unknown;

  const adoptingAdapter: ProviderAdapter = {
    describe: () => ({ ...descriptor, capabilities: ['mail.read', 'sync.adopt'] }),
    syncPage: adapter.syncPage,
    invoke: async (req) => {
      if (req.capability !== 'sync.adopt') throw new Error(`unexpected capability ${req.capability}`);
      adoptCalls.push((req.args as { prior: Record<string, unknown> }).prior);
      return adoptAnswer();
    },
  };

  async function setCursor(sourceId: string, cursor: Record<string, unknown>): Promise<void> {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET cursor = ${org.adminSql.json(cursor as never)}::jsonb
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
  }

  async function hasProviderKey(sourceId: string): Promise<boolean> {
    const [row] = await org.adminSql<{ has: boolean }[]>`
      SELECT cursor ? 'provider' AS has FROM harness_shared.data_sources
       WHERE workspace_id = ${WS} AND id = ${sourceId}::uuid`;
    return row.has;
  }

  const adoptSync = (sourceId: string) => syncOne(sourceId, { registry: adoptRegistry });

  beforeAll(async () => {
    adoptRegistry = createProviderRegistry();
    await adoptRegistry.register({
      descriptor: { ...descriptor, capabilities: ['mail.read', 'sync.adopt'] },
      adapter: adoptingAdapter,
      pluginName: 'connector-fixture-adopting-plugin',
    });
  });

  beforeEach(() => {
    adoptCalls = [];
    adoptAnswer = () => ({ cursor: null, backfillComplete: false });
  });

  it('adopts the legacy position once, without the host-owned wake key, and syncs incrementally from it', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '500', emailAddress: 'a@example.com', wake: 'wake-state' });
    adoptAnswer = () => ({ cursor: 'adopted-500', backfillComplete: true });
    handler = scripted({ 'adopted-500': page([mail('m1')], 'c1', false) });

    const first = await adoptSync(src);
    expect(first).toMatchObject({ outcome: 'synced', adopted: true, mode: 'incremental', admitted: 1 });
    expect(adoptCalls).toEqual([{ historyId: '500', emailAddress: 'a@example.com' }]);
    expect(calls).toEqual([{ cursor: 'adopted-500', mode: 'incremental' }]);
    expect(await state(src)).toMatchObject({ cursor: 'c1', backfill_status: 'complete' });

    // The provider now owns the cursor: no second adoption.
    await makeDue(src);
    handler = scripted({ c1: page([], 'c2', false) });
    const second = await adoptSync(src);
    expect(second.adopted).toBeUndefined();
    expect(adoptCalls).toHaveLength(1);
    expect(calls.at(-1)).toEqual({ cursor: 'c1', mode: 'incremental' });
  });

  it('an adopted position that still owes a backfill syncs in backfill mode', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '700', backfill: { status: 'pending', pageToken: 'p9' } });
    adoptAnswer = () => ({ cursor: 'adopted-700', backfillComplete: false });
    handler = scripted({ 'adopted-700': page([mail('m1')], 'b1', true), b1: page([], 'b2', false) });
    const outcome = await adoptSync(src);
    expect(outcome).toMatchObject({ outcome: 'synced', adopted: true, mode: 'backfill' });
    expect(calls).toEqual([
      { cursor: 'adopted-700', mode: 'backfill' },
      { cursor: 'b1', mode: 'backfill' },
    ]);
    expect(await state(src)).toMatchObject({ cursor: 'b2', backfill_status: 'complete' });
  });

  it('never re-adopts once the provider key exists, even when a cursor-expired reset nulled it', async () => {
    const src = await createSource();
    await setCursor(src, { provider: null, historyId: '900' });
    const outcome = await adoptSync(src);
    expect(outcome.outcome).toBe('synced');
    expect(adoptCalls).toEqual([]);
    expect(calls).toEqual([{ cursor: null, mode: 'backfill' }]);
  });

  it('a provider with nothing to adopt starts fresh, and a source with no prior state is never asked', async () => {
    const src = await createSource();
    await setCursor(src, { lastSyncAt: '2026-09-01T00:00:00Z' });
    expect((await adoptSync(src)).adopted).toBeUndefined();
    expect(adoptCalls).toHaveLength(1);
    expect(calls).toEqual([{ cursor: null, mode: 'backfill' }]);

    const fresh = await createSource();
    await adoptSync(fresh);
    expect(adoptCalls).toHaveLength(1);
  });

  it('an adopt failure fails the pass and writes no cursor, rather than falling back to a null start', async () => {
    const src = await createSource();
    await setCursor(src, { historyId: '1200' });
    adoptAnswer = () => {
      throw new Error('adopt exploded');
    };
    const failed = await adoptSync(src);
    expect(failed).toMatchObject({ outcome: 'failed' });
    expect(calls).toEqual([]);
    expect(await hasProviderKey(src)).toBe(false);
    expect((await state(src)).failure_count).toBe(1);

    // A malformed answer is a failure too.
    await makeDue(src);
    adoptAnswer = () => ({ cursor: 42, backfillComplete: true });
    expect((await adoptSync(src)).outcome).toBe('failed');
    expect(await hasProviderKey(src)).toBe(false);
  });
});

/**
 * P-013 R-7, re-asserted on the provider path (WI-10006345): the data-source record is the one
 * copy a sync runs from. These passes use the PRODUCTION host.fetch (no `hostFetchFor` override),
 * so the token comes from the record's credential_ref through the real token store; only the
 * network edge (global fetch) and the token file's location are faked.
 */
describe('the data-source record is the one copy a sync runs from (P-013 R-7)', () => {
  const GLOBAL_PLUGIN = 'connector-runtime-record-plugin';
  const TOKEN_PLUGIN = `provider:${KIND}`;
  const GRAPH = 'https://graph.microsoft.com/v1.0/me/messages';
  const priorHome = process.env.PAPERCUSP_HOME;
  let home: string;
  let seen: Array<{ url: string; authorization: string | null }>;

  async function recordSource(credentialRef: string | null, config: Record<string, unknown>): Promise<string> {
    const src = await createSource();
    await org.adminSql`
      UPDATE harness_shared.data_sources
         SET credential_ref = ${credentialRef}, config = ${JSON.stringify(config)}::text::jsonb
       WHERE workspace_id = ${WS} AND id = ${src}::uuid`;
    return src;
  }

  async function setCredential(src: string, credentialRef: string | null): Promise<void> {
    await org.adminSql`
      UPDATE harness_shared.data_sources SET credential_ref = ${credentialRef}
       WHERE workspace_id = ${WS} AND id = ${src}::uuid`;
  }

  /** One pass through the production host.fetch. */
  async function productionSync(src: string) {
    const production = deps();
    delete (production as { hostFetchFor?: unknown }).hostFetchFor;
    const result = await runConnectorSync(
      org.adminSql,
      { workspaceId: WS, harness: 'papercusp', sourceIds: [src], pollIntervalSeconds: 300 },
      production,
    );
    expect(result.sources).toHaveLength(1);
    return result.sources[0];
  }

  beforeAll(async () => {
    // The production host.fetch resolves the provider and its token store from the global registry.
    providerRegistry().unregisterPlugin(GLOBAL_PLUGIN);
    await providerRegistry().register({ descriptor, adapter, pluginName: GLOBAL_PLUGIN });
  });

  afterAll(() => {
    providerRegistry().unregisterPlugin(GLOBAL_PLUGIN);
  });

  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'paperhome-connector-record-'));
    process.env.PAPERCUSP_HOME = home;
    const dir = join(home, 'harnesses', 'papercusp', 'plugin-configs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${TOKEN_PLUGIN}.json`), JSON.stringify({ 'slot-a': 'token-a', 'slot-b': 'token-b' }));
    seen = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
        return Response.json({ value: [] });
      }),
    );
    // Each pass fetches once through the host, then returns one record and the next cursor.
    handler = async (req, host) => {
      await host.fetch({ source: req.source, request: { url: GRAPH } });
      const at = req.cursor ?? 'c0';
      return page([mail(`m-${at}`)], `${at}+`, false);
    };
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (priorHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  it('syncs from the record: its config reaches the provider, its credential signs the call, status and cursor land back on it', async () => {
    const src = await recordSource(`${TOKEN_PLUGIN}:slot-a`, { folder: 'Inbox' });
    let config: unknown;
    const base = handler;
    handler = async (req, host) => {
      config = req.config;
      return base(req, host);
    };

    expect(await productionSync(src)).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(config).toEqual({ folder: 'Inbox' });
    expect(seen).toEqual([{ url: GRAPH, authorization: 'Bearer token-a' }]);
    expect(await state(src)).toMatchObject({ cursor: 'c0+', status: 'connected', failure_count: 0, last_error: null });
  });

  it('a credential_ref rotated on the record is the one used at the next pass', async () => {
    const src = await recordSource(`${TOKEN_PLUGIN}:slot-a`, {});
    expect(await productionSync(src)).toMatchObject({ outcome: 'synced' });

    await setCredential(src, `${TOKEN_PLUGIN}:slot-b`);
    await makeDue(src);
    expect(await productionSync(src)).toMatchObject({ outcome: 'synced', admitted: 1 });
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer token-a', 'Bearer token-b']);
    expect((await state(src)).cursor).toBe('c0++');
  });

  it('clearing the record credential stops the sync: no request leaves, the cursor stays', async () => {
    const src = await recordSource(`${TOKEN_PLUGIN}:slot-a`, {});
    // Positive control: with the credential set, a pass does reach the network.
    expect(await productionSync(src)).toMatchObject({ outcome: 'synced' });
    expect(seen).toHaveLength(1);

    await setCredential(src, null);
    await makeDue(src);
    const stopped = await productionSync(src);
    expect(stopped.outcome).toBe('failed');
    expect(seen).toHaveLength(1);
    const after = await state(src);
    expect(after.cursor).toBe('c0+');
    expect(after.last_error).toMatch(/no access token/);
  });
});
