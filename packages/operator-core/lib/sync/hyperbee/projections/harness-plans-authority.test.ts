// P-018 / D-012 — author-scoped write authority wiring in the live plan projection
// (harness-plans.ts). Drives writeToPg / deleteFromPg with a FAKE tagged-sql so we can assert,
// WITHOUT a live DB, that: member mode applies unchanged; author-scoped mode rejects a non-owner's
// overwrite/delete; the owner is allowed; and the first writer binds ownership. The pure decision
// is covered separately in content-write-authority.test.ts; this proves the projection consults it
// and gates the actual INSERT/DELETE.
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { buildHarnessPlansProjection, type HarnessPlanRow } from './harness-plans';
import type { ProvenanceContext } from '../projection';
import { deriveIndexFromContent } from '../../../agent-tools/plans/derive-index';
import { stampForcedPastWaiver, summarizeForcedPast } from '../../../agent-tools/plans/forced-past-stamp';

interface Recorded {
  text: string;
  values: unknown[];
}

/** A minimal tagged-template stand-in for postgres.Sql: records each query's normalized text and
 *  returns a queued SELECT result (the owner row), [] otherwise. */
function fakeSql(
  ownerRow: { owner_author_pubkey: string | null } | null,
  policy: { membership: 'open' | 'allowlist' } | Error | null = null,
) {
  const calls: Recorded[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ').replace(/\s+/g, ' ').trim().toUpperCase();
    calls.push({ text, values });
    if (text.startsWith('SELECT OWNER_AUTHOR_PUBKEY')) {
      return Promise.resolve(ownerRow ? [ownerRow] : []);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    unsafe: async (text: string, values: unknown[]) => {
      calls.push({ text: text.toUpperCase(), values });
      if (policy instanceof Error) throw policy;
      return policy ? [{
        workspace_id: 'ws', harness_slug: 'home', policy_json: JSON.stringify(policy),
        owner_pubkey: 'owner-key', signature: 'verified-at-policy-projection',
        policy_version: 1, fed_hlc: null, updated_at: 1000,
      }] : [];
    },
  });
  return { sql: sql as unknown as postgres.Sql, calls };
}

const PLAN_ROW: HarnessPlanRow = {
  harness_slug: 'h1',
  plan_slug: 'plan-x',
  content: '# Plan',
  content_hash: 'abc',
  title: 'Plan',
  status: 'active',
  created: null,
  updated: null,
  owner: null,
  supersedes: [],
  superseded_by: null,
  archived: false,
  is_legacy: false,
};

const INDEXED_CONTENT = [
  '---',
  'slug: plan-x',
  'status: active',
  '---',
  '',
  '## Phase 1',
  '',
  '- **P-001** `todo` retain the item',
  '',
  '## Decisions',
  '',
  '### D-001 — retain the decision',
  'Date: 2026-10-08',
  'Preserve the decision body.',
].join('\n');

// A remote op authored by device 'DEV-B', resolved via resolveAuthorDevice.
const remoteProvenance: ProvenanceContext = { authorPubkey: 'srclog-B', origin: 'remote', ts: 1000, fedHlc: 'h1000' };

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws',
    harnessSlug: 'h1', // own-slug → membership guard returns 'apply', isolating the authority gate
    isFlagOn: async () => false, // full-upsert path (not bootstrap-only)
    resolveAuthorDevice: (k: string) => (k === 'srclog-B' ? 'DEV-B' : null),
    ...overrides,
  };
}

function inserted(calls: Recorded[]): boolean {
  return calls.some((c) => c.text.startsWith('INSERT INTO HARNESS_SHARED.HARNESS_PLANS'));
}
function deleted(calls: Recorded[]): boolean {
  return calls.some((c) => c.text.startsWith('DELETE FROM HARNESS_SHARED.HARNESS_PLANS'));
}

describe('harness-plans author-scoped write authority (P-018/D-012)', () => {
  it('default policy-reader failure refuses remote overwrite and delete before any mutation', async () => {
    const error = new Error('policy read unavailable');
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' }, error);
    const proj = buildHarnessPlansProjection(baseOpts({ sql, potHomeSlug: 'home' }) as never);

    await expect(proj.writeToPg(PLAN_ROW, remoteProvenance)).rejects.toThrow(error);
    await expect(proj.deleteFromPg('plan-x', 1000, 'h1000', remoteProvenance)).rejects.toThrow(error);
    expect(inserted(calls)).toBe(false);
    expect(deleted(calls)).toBe(false);
  });

  it('default policy reader enforces open-hive ownership using source-log identity', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' }, { membership: 'open' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, potHomeSlug: 'home' }) as never);

    await proj.writeToPg({ ...PLAN_ROW, owner: 'DEV-B' }, remoteProvenance);
    await proj.deleteFromPg('plan-x', 1000, 'h1000', remoteProvenance);
    expect(inserted(calls)).toBe(false);
    expect(deleted(calls)).toBe(false);
  });

  it('a successful no-policy lookup preserves explicitly permissive member behavior', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, potHomeSlug: 'home' }) as never);

    await proj.writeToPg(PLAN_ROW, remoteProvenance);
    await proj.deleteFromPg('plan-x', 1000, 'h1000', remoteProvenance);
    expect(inserted(calls)).toBe(true);
    expect(deleted(calls)).toBe(true);
  });

  it('whole-blob updates keep legacy JSONB indexes aligned with canonical content', async () => {
    const derived = deriveIndexFromContent(INDEXED_CONTENT);
    const { sql, calls } = fakeSql(null);
    const proj = buildHarnessPlansProjection(
      baseOpts({ sql, resolveWriteMode: async () => 'member' }) as never,
    );

    await proj.writeToPg({ ...PLAN_ROW, content: INDEXED_CONTENT }, remoteProvenance);

    const insert = calls.find((c) => c.text.startsWith('INSERT INTO HARNESS_SHARED.HARNESS_PLANS'))!;
    expect(insert.text).toContain('ITEMS = EXCLUDED.ITEMS');
    expect(insert.text).toContain('DECISIONS = EXCLUDED.DECISIONS');
    expect(insert.values).toContain(JSON.stringify(derived.items));
    expect(insert.values).toContain(JSON.stringify(derived.decisions));
  });

  it('per-part bootstrap seeds legacy JSONB indexes from canonical content', async () => {
    const derived = deriveIndexFromContent(INDEXED_CONTENT);
    const { sql, calls } = fakeSql(null);
    const proj = buildHarnessPlansProjection(
      baseOpts({
        sql,
        isFlagOn: async () => true,
        resolveWriteMode: async () => 'member',
      }) as never,
    );

    await proj.writeToPg({ ...PLAN_ROW, content: INDEXED_CONTENT }, remoteProvenance);

    const insert = calls.find((c) => c.text.startsWith('INSERT INTO HARNESS_SHARED.HARNESS_PLANS'))!;
    expect(insert.text).toContain('ITEMS');
    expect(insert.text).toContain('DECISIONS');
    expect(insert.values).toContain(JSON.stringify(derived.items));
    expect(insert.values).toContain(JSON.stringify(derived.decisions));
  });

  it('recomputes forced_past from canonical content and ignores a stale wire projection', async () => {
    const content = stampForcedPastWaiver(
      '# Plan\n',
      {
        reason: 'verified exception',
        checks: ['acceptance_unaudited'],
        forcedBy: { ownerId: 'su-forcer', ownerLabel: 'Forcing agent' },
      },
      new Date('2026-08-20T22:30:00.000Z'),
    )!;
    const expected = summarizeForcedPast(content)!;
    const stale = { count: 99, latest: { ...expected.latest, reason: 'forged wire value' } };
    const { sql, calls } = fakeSql(null);
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'member' }) as never);

    await proj.writeToPg({ ...PLAN_ROW, content, forced_past: stale }, remoteProvenance);

    const insert = calls.find((c) => c.text.startsWith('INSERT INTO HARNESS_SHARED.HARNESS_PLANS'))!;
    expect(insert.text).toContain('FORCED_PAST');
    expect(insert.values).toContain(JSON.stringify(expected));
    expect(insert.values).not.toContain(JSON.stringify(stale));
  });

  it('member mode: a remote op applies unchanged (insert runs), no owner read', async () => {
    const { sql, calls } = fakeSql(null);
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'member' }) as never);
    await proj.writeToPg(PLAN_ROW, remoteProvenance);
    expect(inserted(calls)).toBe(true);
    // member mode short-circuits before the owner SELECT
    expect(calls.some((c) => c.text.startsWith('SELECT OWNER_AUTHOR_PUBKEY'))).toBe(false);
  });

  it('author-scoped: first writer (unbound owner) is allowed and the insert runs', async () => {
    const { sql, calls } = fakeSql(null); // no owner yet
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.writeToPg(PLAN_ROW, remoteProvenance);
    expect(inserted(calls)).toBe(true);
  });

  it('author-scoped: a NON-owner overwrite is REJECTED (no insert) — the D-012 fix', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' }); // owned by someone else
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.writeToPg(PLAN_ROW, remoteProvenance); // op author resolves to DEV-B ≠ DEV-A
    expect(inserted(calls)).toBe(false);
  });

  it('author-scoped: the OWNER may overwrite their own plan (insert runs)', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-B' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.writeToPg(PLAN_ROW, remoteProvenance);
    expect(inserted(calls)).toBe(true);
  });

  it('author-scoped: a NON-owner DELETE is REJECTED (no delete) — strangers cannot delete your plan', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.deleteFromPg('plan-x', 1000, 'h1000', remoteProvenance);
    expect(deleted(calls)).toBe(false);
  });

  it('author-scoped: the OWNER may delete their own plan (delete runs)', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-B' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.deleteFromPg('plan-x', 1000, 'h1000', remoteProvenance);
    expect(deleted(calls)).toBe(true);
  });

  it('a LOCAL delete is never gated (operator owns their machine writes)', async () => {
    const { sql, calls } = fakeSql({ owner_author_pubkey: 'DEV-A' });
    const proj = buildHarnessPlansProjection(baseOpts({ sql, resolveWriteMode: async () => 'author-scoped' }) as never);
    await proj.deleteFromPg('plan-x', 1000, 'h1000', { authorPubkey: 'self', origin: 'local', ts: 1000 });
    expect(deleted(calls)).toBe(true);
  });
});
