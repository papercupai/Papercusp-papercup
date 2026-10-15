/**
 * The producer→app round trip, asserted on the RECEIVING END (P-008, made
 * provider-neutral by P-006 / D-023).
 *
 * Every other test in this directory stops at the sending abstraction: it
 * checks that the producer builds the right batch, resolves the right owner, or
 * mints the right token. None of them can answer the question this one asks —
 * does a real row arrive in the app's own store, and can the app itself serve
 * it back? That needs a live app, so it lives here rather than in a unit test,
 * and it SKIPS rather than fails when one is not configured.
 *
 * WHAT MAKES THIS EVIDENCE RATHER THAN A MOCK:
 *  - the token is minted by the production `appServiceAuthHeader` and verified
 *    by the app's own `jwtVerify`, so the auth leg is real. The test asserts an
 *    unauthenticated call is REFUSED first, which is what proves the app is not
 *    running in LOCAL_MODE (where any caller is accepted as a fixed owner and
 *    this whole suite would pass vacuously);
 *  - the batch is built by `buildAppSyncBatch` from records shaped by
 *    `appRowFromSourceRecord` — the same mapper the live push sink and the
 *    reconcile sweep both use, so a divergence between them would surface here;
 *  - the assertion is a GET against the app's own read endpoint, not a database
 *    peek, so it exercises the app's store AND its read path.
 *
 * WHAT MAKES IT PROVIDER-NEUTRAL (D-023): every case sends records from TWO
 * providers in ONE batch — a Google kind and a non-Google kind — that reuse the
 * SAME native id. The app must keep them as two rows keyed `<sourceId>:<native>`
 * and serve each back under its own source. The batch names the producer's sync
 * stream (`APP_SYNC_SOURCE_REF`), never a provider, and the apps' trigger doors
 * are the provider-neutral `/api/triggers/email` and `/api/triggers/calendar`.
 *
 * It uses a per-run synthetic ownerId, source ids and native id so it neither
 * depends on nor disturbs whatever real data the app holds.
 *
 * To run it, point it at a live sidecar (see the calendar/email TESTING.md):
 *   EMAIL_APP_URL, EMAIL_AUTH_SECRET  (and/or CALENDAR_*)
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { appServiceAuthHeader } from './app-auth';
import {
  APP_SYNC_SOURCE_REF,
  appRowFromSourceRecord,
  appRowId,
  buildAppSyncBatch,
  DATATYPE_FOR_APP,
} from './app-rows';
import type { ProducerSourceRecord } from './app-rows';
import { deliverAppSyncBatch } from './live-sink';
import type { ProducerApp } from './owner-mapping';

const PROBE_TIMEOUT_MS = 3_000;

interface ProviderUnderTest {
  /** Provider kind — the `<kind>` in `ext:<kind>:<event>`. */
  kind: string;
  /** The canonical `documents.source` category this provider writes. */
  source: string;
}

interface AppCase {
  app: ProducerApp;
  /** One Google kind and one non-Google kind, both routed by datatype (D-010). */
  providers: readonly [ProviderUnderTest, ProviderUnderTest];
  baseUrl: string;
  secret: string;
}

const PROVIDERS: Record<ProducerApp, readonly [ProviderUnderTest, ProviderUnderTest]> = {
  email: [{ kind: 'gmail', source: 'gmail' }, { kind: 'outlook', source: 'outlook' }],
  calendar: [{ kind: 'gcal', source: 'calendar' }, { kind: 'outlook-calendar', source: 'calendar' }],
};

function configuredCases(): AppCase[] {
  const cases: AppCase[] = [];
  for (const app of ['email', 'calendar'] as const) {
    const baseUrl = process.env[`${app.toUpperCase()}_APP_URL`]?.trim() ?? '';
    const secret = process.env[`${app.toUpperCase()}_AUTH_SECRET`]?.trim() ?? '';
    if (baseUrl && secret) {
      cases.push({ app, providers: PROVIDERS[app], baseUrl: baseUrl.replace(/\/+$/, ''), secret });
    }
  }
  return cases;
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

const CASES = configuredCases();
const live = new Map<ProducerApp, boolean>();
await Promise.all(CASES.map(async (c) => live.set(c.app, await reachable(c.baseUrl))));

/** A record from one provider, shaped exactly as the producer shapes one. */
function recordFor(
  app: ProducerApp,
  provider: ProviderUnderTest,
  sourceId: string,
  externalId: string,
  occurredAt: string,
): ProducerSourceRecord {
  return {
    source: provider.source,
    datatypeId: DATATYPE_FOR_APP[app],
    kind: app === 'email' ? 'message' : 'event',
    externalId,
    sourceId,
    occurredAt,
    title: `round trip via ${provider.kind}`,
    text: 'Delivered by the platform→app data producer.',
    // Provider-shaped fields ride through `metadata` untouched, exactly as a
    // real normalized payload does.
    metadata: app === 'email'
      ? { from: `${provider.kind}@example.com`, to: ['owner@example.com'] }
      : { calendarId: 'primary', start: { dateTime: occurredAt }, end: { dateTime: occurredAt } },
  };
}

function readPath(app: ProducerApp, rowId: string): string {
  const id = encodeURIComponent(rowId);
  return app === 'email' ? `/api/threads/${id}` : `/api/events/${id}`;
}

async function servedRow(c: AppCase, authorization: string, rowId: string): Promise<{ status: number; row?: Record<string, unknown> }> {
  const res = await fetch(`${c.baseUrl}${readPath(c.app, rowId)}`, {
    headers: { authorization },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as { messages?: Record<string, unknown>[]; event?: Record<string, unknown> };
  const row = c.app === 'email' ? body.messages?.find((m) => m.id === rowId) : body.event;
  return { status: res.status, row };
}

describe.skipIf(CASES.length === 0)('producer → app round trip, two providers (live app required)', () => {
  for (const c of CASES) {
    describe.skipIf(!live.get(c.app))(`${c.app}`, () => {
      const ownerId = `p006-live-test-${randomUUID()}`;
      // ONE native id shared by both providers: only per-source row ids keep
      // the two records apart in the app.
      const nativeId = `p006-${randomUUID()}`;
      const sourceIds = [randomUUID(), randomUUID()] as const;

      it('refuses an unauthenticated read (proves LOCAL_MODE is off, so the auth leg is real)', async () => {
        const res = await fetch(`${c.baseUrl}/api/sync/cursor?sourceRef=${encodeURIComponent(APP_SYNC_SOURCE_REF)}`, {
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(res.status).toBe(401);
      });

      it('delivers one batch from two providers and the app serves each row back under its own source', async () => {
        const occurredAt = new Date().toISOString();
        const rows = c.providers.map((provider, i) => {
          const mapped = appRowFromSourceRecord(recordFor(c.app, provider, sourceIds[i], nativeId, occurredAt));
          expect(mapped, `the ${c.app} datatype must map to an app for ${provider.kind}`).not.toBeNull();
          expect(mapped!.app).toBe(c.app);
          return mapped!.row;
        });
        const rowIds = sourceIds.map((sid) => appRowId(nativeId, sid));
        expect(rows.map((r) => r.id)).toEqual(rowIds);
        expect(new Set(rowIds).size).toBe(2);

        const batch = buildAppSyncBatch(c.app, rows, { cursor: null });
        // The batch names the producer's stream, never a provider (D-023 §2).
        expect(batch.body.sourceRef).toBe(APP_SYNC_SOURCE_REF);
        const result = await deliverAppSyncBatch(batch, ownerId, { baseUrl: c.baseUrl, secret: c.secret });
        expect(result.status).toBe(200);
        expect(result.rowCount).toBe(2);

        // RECEIVING END: ask the APP, through the APP's own read path, under a
        // token minted the way the producer mints one.
        const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
        for (const [i, rowId] of rowIds.entries()) {
          const served = await servedRow(c, authorization, rowId);
          expect(served.status, `${c.providers[i].kind}: read ${rowId}`).toBe(200);
          expect(served.row?.id, `the ${c.app} app must serve back the ${c.providers[i].kind} row`).toBe(rowId);
          // The record's own provenance survives the trip: that is what the
          // app writes back through (D-023 §2), never a default source.
          const servedSource = c.app === 'email'
            ? (served.row?.mailbox as { sourceId?: string } | undefined)?.sourceId
            : served.row?.sourceId;
          expect(servedSource, `${c.providers[i].kind}: served source id`).toBe(sourceIds[i]);
        }
      });

      it('reports a cursor for the producer stream and requires the stream to be named', async () => {
        const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
        const named = await fetch(
          `${c.baseUrl}/api/sync/cursor?sourceRef=${encodeURIComponent(APP_SYNC_SOURCE_REF)}`,
          { headers: { authorization }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        );
        expect(named.status).toBe(200);
        expect((await named.json()) as { ok: boolean }).toMatchObject({ ok: true });

        // No default stream any more: a provider name used to be implied here.
        const unnamed = await fetch(`${c.baseUrl}/api/sync/cursor`, {
          headers: { authorization },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(unnamed.status).toBe(400);
      });

      it('serves the provider-neutral trigger door and no Google-named one (D-023 §4)', async () => {
        const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
        const retired = c.app === 'email' ? '/api/triggers/gmail' : '/api/triggers/google-calendar';
        const gone = await fetch(`${c.baseUrl}${retired}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(gone.status, `${retired} must be gone, not aliased`).toBe(404);

        // A key of the WRONG datatype is refused by the generic door before any
        // dedupe claim or launch, which proves the route exists and validates
        // `ext:<kind>:<event>` without side effects.
        const wrongKey = c.app === 'email' ? 'ext:outlook-calendar:event-upcoming' : 'ext:outlook:message.received';
        const refused = await fetch(`${c.baseUrl}/api/triggers/${c.app}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ eventKey: wrongKey, dedupeKey: `p006-refused-${randomUUID()}`, payload: {} }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        expect(refused.status).toBe(400);
        expect(((await refused.json()) as { error?: string }).error).toBe(`${c.app}_trigger_event_unsupported`);
      });

      // ── P-012: the email judgment door is de-conflated, proven on the LIVE app ──
      // The trigger door stores content and mints NO work item; platform
      // bindings stay the single judgment path. Its observable contract is two
      // facts: the content lands, and `workItemIds` comes back EMPTY. Driven
      // here by a NON-Google provider, so the door's provider neutrality and the
      // de-conflation are proven by the same request against the deployed app.
      // (Calendar's door launches a meeting-prep plan run on the platform, so
      // the live suite deliberately does not fire a valid calendar trigger.)
      if (c.app === 'email') {
        it('ingests an Outlook trigger through /api/triggers/email and mints ZERO work items', async () => {
          const triggerNativeId = `p012-${randomUUID()}`;
          const sourceId = randomUUID();
          const outlook = c.providers[1];
          const mapped = appRowFromSourceRecord(
            recordFor(c.app, outlook, sourceId, triggerNativeId, new Date().toISOString()),
          );
          expect(mapped, `the ${c.app} datatype must map to an app`).not.toBeNull();
          const rowId = appRowId(triggerNativeId, sourceId);

          const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
          const res = await fetch(`${c.baseUrl}/api/triggers/email`, {
            method: 'POST',
            headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({
              eventKey: `ext:${outlook.kind}:message.received`,
              dedupeKey: rowId,
              datatype: DATATYPE_FOR_APP.email,
              payload: mapped!.row,
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            ok: boolean;
            deduplicated: boolean;
            workItemIds: string[];
            messageId?: string;
          };
          expect(body.ok).toBe(true);
          expect(body.deduplicated).toBe(false);
          // THE ASSERTION THIS TEST EXISTS FOR.
          expect(body.workItemIds).toEqual([]);
          // …and the content half still landed, so an empty list means the
          // judgment half was REMOVED rather than the whole handler having been
          // switched off. Without this a fully broken endpoint would also pass.
          expect(body.messageId).toBe(rowId);

          const served = await servedRow(c, authorization, rowId);
          expect(served.status).toBe(200);
          expect(served.row?.id, 'the app must serve back the message its trigger door ingested').toBe(rowId);
        });
      }
    });
  }
});

// ── WI-933686 — the same round trip, on REAL PROVIDER DATA ──────────────────
//
// WHY THIS EXISTS SEPARATELY FROM THE BLOCK ABOVE.
// That block is deliberately non-disturbing: it uses a per-run synthetic
// ownerId and source ids. That makes the AUTH leg, the DELIVERY leg and the APP
// real — but the DATA fake, and the fake data is precisely the gap WI-933686
// was filed for. Acceptance scorecard EI-21832584701743975 rated
// `web-apps-real-data` only partially-met because both apps' real-data claim
// rested on the platform delivery ledger and on manual driving, rather than on
// an executing assertion. This block is that assertion.
//
// It changes exactly ONE variable: the record is READ FROM the live
// `documents` vault (the newest row of the app's datatype, whichever provider
// wrote it — the same rows the production producer reads) instead of being
// synthesized. The converter, the batch builder, the delivery sink, the minted
// token and the app's own read endpoint are the identical production path
// already exercised above.
//
// SAFETY — why this is not "writing real things into the owner's app":
//  • REAL DATA, THROWAWAY OWNER. The gap was that the data was fake, never that
//    the owner was, so the synthetic ownerId is KEPT. Real provider content
//    proves the path; the throwaway owner keeps the owner's own store untouched.
//  • READ-ONLY with respect to the provider. It re-delivers content the
//    platform already holds. It never reaches the draft gateway (Email stays
//    draft-only by never invoking `mail:reply` at all) and never proposes,
//    updates or deletes a calendar event.
//  • OFF BY DEFAULT even when an app IS configured, so an ordinary
//    `test:affected` run never touches the owner's mail.
//
// NON-VACUOUS BY CONSTRUCTION: enabling the flag is an explicit assertion that
// real data should be present, so an empty vault FAILS loudly here rather than
// skipping. A test that silently passes when it read nothing would recreate the
// very defect this item is about — a claim resting on something unexecuted.

const REAL_DATA_ENABLED = process.env.APP_LIVE_REAL_DATA_E2E === '1';

/**
 * Newest real vault record for an app datatype, shaped as the exact
 * `ProducerSourceRecord` the production producer builds. Returns null when the
 * vault holds none, so the caller can fail with a specific reason.
 */
async function readRealSourceRecord(datatypeId: string): Promise<ProducerSourceRecord | null> {
  const client = new Client({ connectionString: getHarnessAdminUrl() });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT source, datatype_id, kind, external_id, occurred_at, title, text, metadata,
              source_id, provider_account_id
         FROM harness_shared.documents
        WHERE datatype_id = $1
          AND external_id IS NOT NULL
          AND btrim(external_id) <> ''
        ORDER BY occurred_at DESC NULLS LAST
        LIMIT 1`,
      [datatypeId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      source: row.source,
      datatypeId: row.datatype_id,
      kind: row.kind,
      externalId: row.external_id,
      occurredAt: row.occurred_at,
      title: row.title,
      text: row.text,
      metadata: row.metadata,
      sourceId: row.source_id,
      providerAccountId: row.provider_account_id,
    };
  } finally {
    await client.end();
  }
}

describe.skipIf(!REAL_DATA_ENABLED || CASES.length === 0)(
  'WI-933686 real provider data → app round trip (opt-in: APP_LIVE_REAL_DATA_E2E=1)',
  () => {
    for (const c of CASES) {
      describe.skipIf(!live.get(c.app))(`${c.app}`, () => {
        const ownerId = `wi933686-live-test-${randomUUID()}`;

        it('delivers a REAL vault record through the production path and the app serves it back', async () => {
          const record = await readRealSourceRecord(DATATYPE_FOR_APP[c.app]);

          // Loud rather than vacuous: opting in asserts real data IS present.
          expect(
            record,
            `no real '${DATATYPE_FOR_APP[c.app]}' row in harness_shared.documents — ` +
              'this test cannot prove the real-data path without one. Connect a ' +
              'provider and let a sync land, or unset APP_LIVE_REAL_DATA_E2E.',
          ).not.toBeNull();

          // Provenance assertions, on identifiers only — never on message content,
          // which must not reach a failure message or a CI log.
          const externalId = String(record!.externalId);
          expect(record!.datatypeId).toBe(DATATYPE_FOR_APP[c.app]);
          expect(externalId.length).toBeGreaterThan(0);
          expect(
            record!.metadata,
            'a real vault row must carry the provider payload the app consumes',
          ).toBeTruthy();

          const mapped = appRowFromSourceRecord(record!);
          expect(mapped, `the ${c.app} datatype must map to an app`).not.toBeNull();
          expect(mapped!.app).toBe(c.app);
          // The mapper keys the app row by source id + REAL provider id (D-010).
          const rowId = appRowId(externalId, record!.sourceId);
          expect(mapped!.row.id).toBe(rowId);
          expect(mapped!.row.nativeId).toBe(externalId);

          const batch = buildAppSyncBatch(c.app, [mapped!.row], { cursor: null });
          const result = await deliverAppSyncBatch(batch, ownerId, {
            baseUrl: c.baseUrl,
            secret: c.secret,
          });
          expect(result.status).toBe(200);
          expect(result.rowCount).toBe(1);

          // RECEIVING END: the app's own read path, under a production-minted token.
          const authorization = await appServiceAuthHeader(c.app, ownerId, { secret: c.secret });
          const served = await servedRow(c, authorization, rowId);
          expect(served.status).toBe(200);
          // THE ASSERTION THIS BLOCK EXISTS FOR: data that actually came from a
          // provider traversed the app's own run path, and the app served it back.
          expect(
            served.row?.id,
            `the ${c.app} app must serve back the REAL ${String(record!.source)} record it was sent`,
          ).toBe(rowId);
        });
      });
    }
  },
);
