/**
 * Cupboard stats indexer — P-076 tests.
 *
 * The GitHub fetch is stubbed; D1 is the same FakeStore pattern as
 * harnesses.test.ts (re-used locally rather than imported to keep
 * test files independent — D1's surface is small).
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  fetchGhRepo,
  fetchGhLanguages,
  fetchGhContributorCount,
  indexOneHarness,
  indexBatch,
} from '../indexer';
import type { Env } from '../env';
import type { HarnessRow } from '../db';

// ── minimal D1 + KV mocks (shared shape with harnesses.test.ts) ────

// Loose row shape — tests push HarnessRow values into harnesses[] and audit
// rows separately. Using a string-indexed type with optional fields keeps
// the FakeStore compatible with both shapes without sprinkling casts.
type Row = HarnessRow | { [k: string]: unknown };

class FakeStmt {
  constructor(private sql: string, private store: FakeStore, private binds: unknown[] = []) {}
  bind(...v: unknown[]): FakeStmt { return new FakeStmt(this.sql, this.store, v); }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const changes = this.store.execute(this.sql, this.binds);
    return { success: true, meta: { changes } };
  }
  async first<T = Row>(): Promise<T | null> {
    const rows = this.store.query(this.sql, this.binds);
    return (rows[0] as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[]; success: true }> {
    const rows = this.store.query(this.sql, this.binds);
    return { results: rows as T[], success: true };
  }
}

class FakeStore {
  tables: Record<string, Row[]> = { harnesses: [], audit: [] };
  execute(sql: string, binds: unknown[]): number {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('UPDATE HARNESSES SET UNLISTED_AT')) {
      const [unlisted_at, unlisted_reason, updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.unlisted_at = unlisted_at; row.unlisted_reason = unlisted_reason; row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.includes('UPDATE HARNESSES') && upper.includes('STARS =')) {
      const [stars, contributor_count, last_activity_at, languages, refreshed, updated, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.stars = stars;
        row.contributor_count = contributor_count;
        row.last_activity_at = last_activity_at;
        row.languages = languages;
        row.stats_refreshed_at = refreshed;
        row.updated_at = updated;
        return 1;
      }
      return 0;
    }
    if (upper.includes('UPDATE HARNESSES') && upper.includes('PUBLISHER_DEVICE_PUBKEY = NULL')) {
      const [updated_at, id] = binds;
      const row = this.tables.harnesses.find((r) => r.id === id);
      if (row) {
        row.publisher_device_pubkey = null;
        row.publisher_attestation_gist_id = null;
        row.updated_at = updated_at;
        return 1;
      }
      return 0;
    }
    if (upper.startsWith('INSERT INTO AUDIT')) {
      const [ts, kind, detail] = binds;
      this.tables.audit.push({ ts, kind, detail });
      return 1;
    }
    return 0;
  }
  query(sql: string, binds: unknown[]): Row[] {
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT * FROM HARNESSES WHERE')) {
      let rows = this.tables.harnesses.filter((r) => r.unlisted_at == null);
      const limit = binds[binds.length - 1] as number;
      rows = rows.slice(0, limit);
      return rows;
    }
    return [];
  }
}

function makeEnv(): { env: Env; store: FakeStore } {
  const store = new FakeStore();
  const db = { prepare(sql: string) { return new FakeStmt(sql, store) as unknown as D1PreparedStatement; } } as unknown as D1Database;
  const env = {
    DB: db,
    COUNTERS: {} as KVNamespace,
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', IP_HASH_PEPPER: '',
    ENVIRONMENT: 'test', CUPBOARD_HOST: 'cupboard.test',
    RATE_PER_USER_PUBLISH_HOURLY: '5', RATE_PER_USER_REPORT_HOURLY: '10',
    RATE_PER_IP_LIST_PER_MINUTE: '60', INDEXER_BATCH_SIZE: '5',
  } as Env;
  return { env, store };
}

function harness(over: Partial<HarnessRow> = {}): HarnessRow {
  return {
    id: 'h1', listing_kind: 'harness', blueprint_kind: null, identity_surface: null, project_ref: null, listing_ref: null,
    github_repository_id: 42, github_owner: 'alice', github_name: 'cool',
    github_url: 'https://github.com/alice/cool', title: 'Cool', description: null,
    topic_hex: 'a'.repeat(64), publisher_github_user_id: 1, publisher_github_login: 'alice',
    publisher_permission: null, publisher_device_pubkey: null, publisher_attestation_gist_id: null,
    provides_tools: null, uses_tools: null, provides_events: null, requires_events: null, requires_rubrics: null,
    provides_item_types: null, provides_plan_types: null, requires_plan_type: null,
    hive_pubkey: null, hive_title: null,
    claim_status: 'unclaimed', claimant_github_user_id: null, claimant_github_login: null,
    superseded_by: null, stars: 0, contributor_count: 0, last_activity_at: null,
    languages: null, stats_refreshed_at: null,
    created_at: 1, updated_at: 1, unlisted_at: null, unlisted_reason: null,
    tarball_r2_key: null, tarball_content_hash: null, tarball_bytes: null,
    review_status: 'approved', reviewed_at: null, review_reason: null,
    delivery_type: null, latest_json_url: null, release_repo: null, icon_url: null, platforms: null,
    // Catalog fields (migration 018 / P-008). `visibility` mirrors the
    // migration's NOT NULL DEFAULT 'public' backfill — every pre-018 row is in
    // the public catalog — and every other axis defaults to unset.
    visibility: 'public', tenant_id: null,
    sku_ref: null, pricing_model: null, price_amount_micros: null, price_currency: null,
    compatibility_json: null, required_permissions: null,
    release_version: null, release_content_hash: null, release_manifest_digest: null,
    release_signature: null, release_manifest: null, release_published_at: null,
    yanked_at: null, yanked_reason: null, revoked_at: null, revoked_reason: null,
    pinned_commit_sha: null, pinned_tree_digest: null, pinned_at: null,
    approved_commit_sha: null, approved_tree_digest: null, approved_at: null, drift: 0,
    authority_unresolved: null, authority_unresolved_cause: null,
    // Migration 041: every listing's baseline badge is the Worker's own pin + scan.
    verified_by: 'worker',
    ...over,
  };
}

function makeFetch(handlers: Record<string, (url: string) => Response>): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, _init?: RequestInit) => {
    for (const [pattern, fn] of Object.entries(handlers)) {
      if (url.includes(pattern)) return fn(url);
    }
    return new Response('not stubbed', { status: 500 });
  };
}

// ── fetchGhRepo ─────────────────────────────────────────────────────

describe('fetchGhRepo', () => {
  it('parses stars + pushed_at on 200', async () => {
    const fetchImpl = makeFetch({
      '/repos/alice/cool': () => new Response(JSON.stringify({
        stargazers_count: 99,
        pushed_at: '2026-05-25T12:00:00Z',
      }), { status: 200 }),
    });
    const r = await fetchGhRepo('alice', 'cool', fetchImpl);
    expect(r.stars).toBe(99);
    expect(r.last_activity_at).toBe(Date.parse('2026-05-25T12:00:00Z'));
    expect(r.not_found).toBe(false);
    expect(r.rate_limited).toBe(false);
  });

  it('detects 404 → not_found', async () => {
    const fetchImpl = makeFetch({
      '/repos/': () => new Response('', { status: 404 }),
    });
    const r = await fetchGhRepo('alice', 'gone', fetchImpl);
    expect(r.not_found).toBe(true);
  });

  it('detects 429 → rate_limited', async () => {
    const fetchImpl = makeFetch({
      '/repos/': () => new Response('', { status: 429 }),
    });
    const r = await fetchGhRepo('alice', 'cool', fetchImpl);
    expect(r.rate_limited).toBe(true);
  });

  it('detects X-RateLimit-Remaining=0 → rate_limited', async () => {
    const fetchImpl = makeFetch({
      '/repos/': () => new Response('{}', { status: 200, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    const r = await fetchGhRepo('alice', 'cool', fetchImpl);
    expect(r.rate_limited).toBe(true);
  });

  it('treats 5xx as transient error', async () => {
    const fetchImpl = makeFetch({
      '/repos/': () => new Response('', { status: 502 }),
    });
    const r = await fetchGhRepo('alice', 'cool', fetchImpl);
    expect(r.error_status).toBe(502);
  });
});

// ── fetchGhContributorCount (Link header parsing) ────────────────────

describe('fetchGhContributorCount', () => {
  it('parses Link rel="last" page count', async () => {
    const link = '<https://api.github.com/repositories/1/contributors?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/contributors?per_page=1&page=27>; rel="last"';
    const fetchImpl = makeFetch({
      '/contributors': () => new Response('', { status: 200, headers: { link } }),
    });
    const r = await fetchGhContributorCount('alice', 'cool', fetchImpl);
    expect(r.count).toBe(27);
  });

  it('returns 1 when no rel="last" link (≤1 contributor)', async () => {
    const fetchImpl = makeFetch({
      '/contributors': () => new Response('', { status: 200 }),
    });
    const r = await fetchGhContributorCount('alice', 'cool', fetchImpl);
    expect(r.count).toBe(1);
  });
});

// ── indexOneHarness ─────────────────────────────────────────────────

describe('indexOneHarness', () => {
  let env: Env; let store: FakeStore;
  beforeEach(() => { ({ env, store } = makeEnv()); });

  it('happy path: updates row + audits nothing extra', async () => {
    store.tables.harnesses.push(harness());
    const fetchImpl = makeFetch({
      '/repos/alice/cool/languages': () => new Response(JSON.stringify({ TypeScript: 1000 }), { status: 200 }),
      '/repos/alice/cool/contributors': () => new Response('', { status: 200 }),
      '/repos/alice/cool': () => new Response(JSON.stringify({ stargazers_count: 12, pushed_at: '2026-05-25T00:00:00Z' }), { status: 200 }),
    });
    const r = await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(r.outcome).toBe('updated');
    expect(store.tables.harnesses[0].stars).toBe(12);
    expect(store.tables.harnesses[0].languages).toBe(JSON.stringify({ TypeScript: 1000 }));
  });

  it('404 → unlists + audits', async () => {
    store.tables.harnesses.push(harness());
    const fetchImpl = makeFetch({
      '/repos/alice/cool': () => new Response('', { status: 404 }),
    });
    const r = await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(r.outcome).toBe('unlisted');
    expect(store.tables.harnesses[0].unlisted_at).not.toBeNull();
    expect(store.tables.harnesses[0].unlisted_reason).toBe('by_indexer:gh_404');
    expect(store.tables.audit.some((a) => (a as { kind: string }).kind === 'indexer_unlisted')).toBe(true);
  });

  it('rate-limit → outcome rate_limited, no PG mutation', async () => {
    store.tables.harnesses.push(harness());
    const fetchImpl = makeFetch({
      '/repos/alice/cool': () => new Response('', { status: 429 }),
    });
    const r = await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(r.outcome).toBe('rate_limited');
    expect(store.tables.harnesses[0].stars).toBe(0);
    expect(store.tables.harnesses[0].unlisted_at).toBeNull();
  });

  it('5xx → outcome skipped_error', async () => {
    store.tables.harnesses.push(harness());
    const fetchImpl = makeFetch({
      '/repos/alice/cool': () => new Response('', { status: 503 }),
    });
    const r = await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(r.outcome).toBe('skipped_error');
    expect(r.detail).toContain('503');
  });
});

// ── indexOneHarness: channel-2 attestation verify + revocation (item 1) ──

describe('indexOneHarness — channel-2 attestation (item 1)', () => {
  let env: Env; let store: FakeStore;
  beforeEach(() => { ({ env, store } = makeEnv()); });

  const repoOk = () =>
    new Response(JSON.stringify({ stargazers_count: 1, pushed_at: '2026-05-25T00:00:00Z' }), { status: 200 });
  const attested = () =>
    harness({ publisher_github_user_id: 1, publisher_device_pubkey: 'PK', publisher_attestation_gist_id: 'g1' });

  it('keeps a valid attestation (gist owner + pubkey match)', async () => {
    store.tables.harnesses.push(attested());
    const fetchImpl = makeFetch({
      '/gists/g1': () => new Response(JSON.stringify({ owner: { id: 1 }, files: { 'x.json': { content: JSON.stringify({ device_pubkey: 'PK' }) } } }), { status: 200 }),
      '/repos/': repoOk,
    });
    await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(store.tables.harnesses[0].publisher_device_pubkey).toBe('PK');
    expect(store.tables.audit.some((a) => (a as { kind: string }).kind === 'attestation_cleared')).toBe(false);
  });

  it('clears attestation when the gist is gone (404 = revocation)', async () => {
    store.tables.harnesses.push(attested());
    const fetchImpl = makeFetch({
      '/gists/g1': () => new Response('', { status: 404 }),
      '/repos/': repoOk,
    });
    await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(store.tables.harnesses[0].publisher_device_pubkey).toBeNull();
    expect(store.tables.harnesses[0].publisher_attestation_gist_id).toBeNull();
    const cleared = store.tables.audit.find((a) => (a as { kind: string }).kind === 'attestation_cleared');
    expect((cleared as { detail: string })?.detail).toContain('gist_not_found');
  });

  it('clears attestation on gist owner mismatch', async () => {
    store.tables.harnesses.push(attested());
    const fetchImpl = makeFetch({
      '/gists/g1': () => new Response(JSON.stringify({ owner: { id: 999 }, files: { 'x.json': { content: JSON.stringify({ device_pubkey: 'PK' }) } } }), { status: 200 }),
      '/repos/': repoOk,
    });
    await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(store.tables.harnesses[0].publisher_device_pubkey).toBeNull();
    const cleared = store.tables.audit.find((a) => (a as { kind: string }).kind === 'attestation_cleared');
    expect((cleared as { detail: string })?.detail).toContain('mismatch');
  });

  it('leaves attestation untouched on a gist rate-limit (re-checked next pass)', async () => {
    store.tables.harnesses.push(attested());
    const fetchImpl = makeFetch({
      '/gists/g1': () => new Response('', { status: 429 }),
      '/repos/': repoOk,
    });
    await indexOneHarness(env, store.tables.harnesses[0] as HarnessRow, fetchImpl);
    expect(store.tables.harnesses[0].publisher_device_pubkey).toBe('PK');
  });
});

// ── indexBatch ──────────────────────────────────────────────────────

describe('indexBatch', () => {
  let env: Env; let store: FakeStore;
  beforeEach(() => { ({ env, store } = makeEnv()); });

  it('processes the batch + audits summary', async () => {
    store.tables.harnesses.push(harness({ id: 'h1' }));
    store.tables.harnesses.push(harness({ id: 'h2', github_name: 'other' }));
    const fetchImpl = makeFetch({
      '/repos/': () => new Response(JSON.stringify({ stargazers_count: 1, pushed_at: '2026-05-25T00:00:00Z' }), { status: 200 }),
    });
    const r = await indexBatch(env, { fetchImpl });
    expect(r.examined).toBe(2);
    expect(r.updated).toBe(2);
    expect(r.errors).toBe(0);
    const auditRow = store.tables.audit.find((a) => (a as { kind: string }).kind === 'indexer_batch');
    expect(auditRow).toBeTruthy();
  });

  it('early-exits on rate-limit', async () => {
    store.tables.harnesses.push(harness({ id: 'h1' }));
    store.tables.harnesses.push(harness({ id: 'h2', github_name: 'b' }));
    store.tables.harnesses.push(harness({ id: 'h3', github_name: 'c' }));
    let calls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      calls++;
      if (calls > 1) return new Response('', { status: 429 });
      return new Response(JSON.stringify({ stargazers_count: 1, pushed_at: '2026-05-25T00:00:00Z' }), { status: 200 });
      void url;
    });
    const r = await indexBatch(env, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.rate_limited).toBeGreaterThanOrEqual(1);
    // We should NOT have indexed all three.
    expect(r.updated + r.unlisted + r.errors + r.rate_limited).toBeLessThan(4);
  });

  it('respects INDEXER_BATCH_SIZE cap', async () => {
    for (let i = 0; i < 20; i++) {
      store.tables.harnesses.push(harness({ id: `h${i}`, github_name: `repo${i}` }));
    }
    const fetchImpl = makeFetch({
      '/repos/': () => new Response(JSON.stringify({ stargazers_count: 1, pushed_at: '2026-05-25T00:00:00Z' }), { status: 200 }),
    });
    const r = await indexBatch(env, { fetchImpl });
    // INDEXER_BATCH_SIZE = 5 in makeEnv()
    expect(r.examined).toBe(5);
  });
});
