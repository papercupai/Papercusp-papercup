/**
 * toast-log-data.integration.test.ts — listToasts, the drizzle-based toast-log
 * read (GET /api/toast-log + notifications:recent), against a real Postgres.
 *
 * Behaviors a fake-db unit test can't prove (this is a drizzle query builder, not
 * raw sql): newest-first ordering, the `since` (gte created_at) delta filter, the
 * harness-slug eq filter (only when the slug passes SLUG_RE), limit clamping, and
 * the bigint id/created_at → Number mapping.
 *
 * We keep the REAL generated drizzle schema (`generated.toastLogInHarnessShared`)
 * and inject a drizzle db built over the testcontainer connection.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const h = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ db: h.db }) };
});

const { listToasts } = await import('./toast-log-data');

let rootSql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `toast_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to baseline: id + created_at are bigint, slug/description/action nullable.
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.toast_log (
      id bigint NOT NULL,
      level text NOT NULL,
      message text NOT NULL,
      description text,
      harness_slug text,
      created_at bigint NOT NULL,
      action_label text,
      action_href text
    )`);
  h.db = drizzle(rootSql);
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.toast_log`;
});

async function insertToast(o: { id: number; createdAt: number; level?: string; message?: string; harnessSlug?: string | null; description?: string | null; actionLabel?: string | null; actionHref?: string | null }) {
  await rootSql`
    INSERT INTO harness_shared.toast_log (id, level, message, description, harness_slug, created_at, action_label, action_href)
    VALUES (${o.id}, ${o.level ?? 'info'}, ${o.message ?? `m${o.id}`}, ${o.description ?? null},
            ${o.harnessSlug ?? null}, ${o.createdAt}, ${o.actionLabel ?? null}, ${o.actionHref ?? null})`;
}

describe('listToasts (drizzle, PG)', () => {
  it('returns rows newest-first, mapped to ToastRow with numeric id/createdAt', async () => {
    await insertToast({ id: 1, createdAt: 100, message: 'oldest' });
    await insertToast({ id: 2, createdAt: 300, message: 'newest', description: 'd', actionLabel: 'Open', actionHref: '/x', harnessSlug: 'web' });
    await insertToast({ id: 3, createdAt: 200, message: 'middle' });
    const { toasts } = await listToasts();
    expect(toasts.map((t) => t.message)).toEqual(['newest', 'middle', 'oldest']); // created_at DESC
    expect(toasts[0]).toEqual({
      id: 2, level: 'info', message: 'newest', description: 'd',
      harnessSlug: 'web', createdAt: 300, actionLabel: 'Open', actionHref: '/x',
    });
    expect(typeof toasts[0]!.id).toBe('number'); // bigint coerced
    expect(typeof toasts[0]!.createdAt).toBe('number');
  });

  it('honours limit (and caps the newest)', async () => {
    for (let i = 1; i <= 5; i++) await insertToast({ id: i, createdAt: i * 10 });
    const { toasts } = await listToasts({ limit: 2 });
    expect(toasts.map((t) => t.id)).toEqual([5, 4]); // newest 2
  });

  it('filters by level before applying the newest-row limit', async () => {
    await insertToast({ id: 1, createdAt: 100, level: 'warning', message: 'older warning' });
    await insertToast({ id: 2, createdAt: 200, level: 'info', message: 'newer info' });
    const { toasts } = await listToasts({ level: 'warning', limit: 1 });
    expect(toasts.map((t) => t.id)).toEqual([1]);
  });

  it('the `since` filter returns only created_at >= since (the delta read)', async () => {
    await insertToast({ id: 1, createdAt: 100 });
    await insertToast({ id: 2, createdAt: 200 });
    await insertToast({ id: 3, createdAt: 300 });
    const { toasts } = await listToasts({ since: 200 });
    expect(toasts.map((t) => t.id).sort()).toEqual([2, 3]); // 100 excluded
  });

  it('a valid slug filters to that harness; an invalid slug is ignored (all rows)', async () => {
    await insertToast({ id: 1, createdAt: 100, harnessSlug: 'web' });
    await insertToast({ id: 2, createdAt: 200, harnessSlug: 'api' });
    await insertToast({ id: 3, createdAt: 300, harnessSlug: null });
    expect((await listToasts({ slug: 'web' })).toasts.map((t) => t.id)).toEqual([1]); // eq harness_slug
    // 'bad slug!' fails SLUG_RE → clause dropped → all rows returned
    expect((await listToasts({ slug: 'bad slug!' })).toasts.map((t) => t.id)).toEqual([3, 2, 1]);
  });
});
