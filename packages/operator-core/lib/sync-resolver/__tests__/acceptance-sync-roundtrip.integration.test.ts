// @vitest-environment node
/**
 * acceptance-sync-roundtrip.integration.test.ts — the data-sync golden path
 * (read → write → invalidate) over the REAL modules against testcontainer PG.
 *
 * The canonical chain (CLAUDE.md "All client data sync goes through
 * @papercusp/sync"): reads resolve a registered queryName through the v2
 * resolver registry; writes commit and then fire `notifySyncInvalidate(...)`;
 * the invalidation travels pg_notify('sync_invalidate') → the bus's dedicated
 * PG LISTEN connection → fan-out to every subscriber. This test drives that
 * chain end-to-end for `toastLog.recent` (the first-migrated, simplest
 * registry entry; its production writer is POST /toast-log in
 * endpoint-route/routes/misc/toast-log.ts):
 *
 *   1. read   — `resolveNamedQueryV2('toastLog.recent', …)` through the REAL
 *               registry → real listToasts → real drizzle → real PG rows.
 *   2. write  — a drizzle INSERT into harness_shared.toast_log (the same
 *               write shape the route uses), visible to the next read.
 *   3. notify — `notifySyncInvalidate('toastLog.recent')` (the route's exact
 *               post-commit call) reaches a `subscribe()`d listener via a
 *               REAL pg_notify → LISTEN roundtrip.
 *   4. bridge — the PG-trigger path: the real `emit_change_notify()` function
 *               (DDL extracted from 000-baseline.sql) attached to toast_log
 *               fires on a raw INSERT, and the bus's
 *               `queryNamesForTriggerEvent` bridge synthesizes the camelCase
 *               `toastLog.recent` event subscribers actually watch.
 *
 * COVERAGE SCOPE (header honesty per the acceptance brief): everything from
 * the resolver registry down to PG, and from PG NOTIFY back up to the bus's
 * subscriber seam, is real — the only mocks are the two connection-injection
 * seams (`getHarnessAdminUrl` / `getOrgPg`) pointed at the throwaway test DB,
 * exactly as sync-sse-backfill.integration.test.ts does. NOT covered: the
 * Hono SSE route framing and the browser-side useSyncQuery cache — those sit
 * above `subscribe()`, the documented in-process seam the SSE route consumes
 * (sync-sse.ts "Register an SSE subscriber"), and need the full host.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync-resolver/__tests__/acceptance-sync-roundtrip.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({
  url: '',
  sql: null as unknown as import('postgres').Sql,
  db: null as unknown as ReturnType<typeof import('drizzle-orm/postgres-js').drizzle>,
}));

// The two connection-injection seams, pointed at the throwaway test DB —
// same mocks (and only those) as sync-sse-backfill.integration.test.ts.
vi.mock('../../embedded-pg-discovery', () => ({
  getHarnessAdminUrl: () => h.url,
  // sync-sse now resolves the URL via the source-annotated variant — keep both exports in step.
  getHarnessAdminUrlWithSource: () => ({ url: h.url, source: 'test-mock' }),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql, drizzle: h.db, db: h.db }) };
});

import { generated } from '@papercusp/db-org';
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '../index';
import { notifySyncInvalidate, subscribe, type SyncEvent } from '../../sync-sse';

const tl = generated.toastLogInHarnessShared;

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_SQL = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql/000-baseline.sql');

/** Extract a single statement from the baseline dump — the REAL shipped DDL,
 *  not a hand-rolled copy. Throws loudly if the baseline shape drifts. */
function fromBaseline(baseline: string, re: RegExp): string {
  const m = baseline.match(re);
  if (!m) throw new Error(`000-baseline.sql DDL extract failed for ${re}`);
  return m[0];
}

let dbName: string;
let adminUri: string;

beforeAll(async () => {
  adminUri = await getTestPg();
  dbName = `syncrt_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  h.url = u.toString();
  // Production-faithful client config (prepare:false + BIGINT→number), per
  // test/_pg-helpers.ts / libs/papercusp/libs/db/src/connection.ts.
  h.sql = postgres(h.url, {
    max: 4,
    onnotice: () => {},
    prepare: false,
    types: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bigint: { to: 20, from: [20], serialize: (x: any) => String(x), parse: (x: string) => Number(x) } as any,
    },
  });
  h.db = drizzle(h.sql);

  // Materialize the real shipped toast_log schema + the real reactivity
  // trigger function out of 000-baseline.sql.
  const baseline = readFileSync(BASELINE_SQL, 'utf8');
  await h.sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  for (const stmt of [
    fromBaseline(baseline, /CREATE OR REPLACE FUNCTION harness_shared\.emit_change_notify\(\)[\s\S]*?\$\$;/),
    fromBaseline(baseline, /CREATE TABLE IF NOT EXISTS harness_shared\.toast_log \([\s\S]*?\);/),
    fromBaseline(baseline, /CREATE SEQUENCE IF NOT EXISTS harness_shared\.toast_log_id_seq[\s\S]*?;/),
    fromBaseline(baseline, /ALTER SEQUENCE harness_shared\.toast_log_id_seq[^;]*;/),
    fromBaseline(baseline, /ALTER TABLE ONLY harness_shared\.toast_log ALTER COLUMN id SET DEFAULT[^;]*;/),
    'ALTER TABLE ONLY harness_shared.toast_log ADD CONSTRAINT toast_log_pkey PRIMARY KEY (id)',
  ]) {
    await h.sql.unsafe(stmt);
  }
}, 60_000);

afterAll(async () => {
  await h.sql?.end({ timeout: 5 }).catch(() => {});
  const a = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await a.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* the bus's live LISTEN connection may still hold it briefly */
  } finally {
    await a.end({ timeout: 5 });
  }
});

/** The POST /toast-log write shape (routes/misc/toast-log.ts), minus HTTP. */
async function insertToast(message: string): Promise<void> {
  await h.db.insert(tl).values({
    level: 'info',
    message,
    description: null,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
  });
  // Distinct createdAt per row so the `ORDER BY created_at DESC` read is
  // deterministic even when two inserts land in the same millisecond.
  await new Promise((r) => setTimeout(r, 2));
}

const recent = async (limit = 10) => {
  const rows = await resolveNamedQueryV2('toastLog.recent', { limit });
  expect(rows).not.toBe(NAME_NOT_FOUND);
  return rows as Array<{ message: string; createdAt: number; level: string }>;
};

// Shared subscriber tap — registered in the notify test, reused by the
// bridge test (subscribe() has no unsubscribe requirement between its).
const received: SyncEvent[] = [];

describe('acceptance: sync read → write → invalidate roundtrip (toastLog.recent)', () => {
  it('read: the registry resolves toastLog.recent against real PG with camelCase rows', async () => {
    await insertToast('first toast');
    await insertToast('second toast');

    const rows = await recent();
    expect(rows.map((r) => r.message)).toEqual(['second toast', 'first toast']);
    // camelCase mapping survived the real drizzle → ToastRow projection.
    expect(rows[0]).toMatchObject({ level: 'info', harnessSlug: null });
    expect(typeof rows[0].createdAt).toBe('number');
  });

  it('write → read: a new committed write is visible to the next resolver read', async () => {
    await insertToast('third toast');
    const rows = await recent();
    expect(rows.map((r) => r.message)).toEqual(['third toast', 'second toast', 'first toast']);
  });

  it('invalidate: notifySyncInvalidate reaches a subscribed listener over real pg_notify → LISTEN', async () => {
    await subscribe((e) => received.push(e));

    // The route's exact post-commit call: write commits, then notify. SCOPED
    // args (not undefined) so this fire's dedupe key `toastLog.recent|{…}|`
    // differs from the FULL-BUST key `toastLog.recent||` the bridge test below
    // synthesizes — the bus routes explicit notifies AND bridged targets
    // through ONE shared source-side dedupe (WI-840, 90s window), so two
    // same-key fires seconds apart would legitimately suppress the second.
    await insertToast('fourth toast');
    await notifySyncInvalidate('toastLog.recent', { probe: 'explicit-leg' });

    await vi.waitFor(
      () => expect(received.some((e) => e.name === 'toastLog.recent')).toBe(true),
      { timeout: 5000 },
    );
    // …and what the listener refetches reflects the write that prompted it.
    const rows = await recent();
    expect(rows[0].message).toBe('fourth toast');
  });

  it('bridge: a raw PG write fires emit_change_notify and the bus synthesizes toastLog.recent', async () => {
    // Attach the REAL trigger function to toast_log, the way migration
    // 107-dogfood-reactivity-triggers.sql wires the reactive tables. (toast_log
    // is bridge-mapped in TABLE_TO_QUERY_NAMES; production invalidates it via
    // the explicit route notify above — this leg proves the trigger → LISTEN →
    // bridge mechanism with the same function + bus wiring.)
    await h.sql.unsafe(
      'CREATE OR REPLACE TRIGGER emit_change_notify_trg AFTER INSERT OR UPDATE OR DELETE ON harness_shared.toast_log FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_change_notify()',
    );

    const bridgedBefore = received.filter((e) => e.name === 'toastLog.recent').length;
    await insertToast('fifth toast (trigger)');

    // Raw trigger event arrives with the <schema>.<table>.changed name…
    await vi.waitFor(
      () =>
        expect(
          received.some(
            (e) => e.name === 'harness_shared.toast_log.changed' && e.args?.op === 'INSERT',
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    // …and the bus's queryNamesForTriggerEvent bridge synthesized the
    // camelCase event the useSyncQuery subscribers actually watch.
    await vi.waitFor(
      () =>
        expect(received.filter((e) => e.name === 'toastLog.recent').length).toBe(
          bridgedBefore + 1,
        ),
      { timeout: 5000 },
    );
  });
});
