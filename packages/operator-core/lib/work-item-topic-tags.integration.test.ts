/**
 * work-item-topic-tags.integration.test.ts — EI-18654138087054247.
 *
 * REGRESSION: `work_items:tag` used to write a topic ONLY to the coord tag store
 * (coord_links rel='tagged'), which NEITHER claim-spec evaluator reads — so a
 * retrofit tag reported ok, round-tripped through `work_items:get{detail:true}`
 * .topics, and the item STILL failed fleet admission with
 * `fleet_scope_violation`. Verified live on WI-5779: two `tagged` edges present,
 * `harness_features_consolidated.tags` NULL.
 *
 * These tests pin the tag field each evaluator ACTUALLY reads:
 *   • feature-family → the `tags` jsonb COLUMN (scheduler/get-next.ts FIELD_MAP)
 *   • issue-family   → `payload.tags` (scheduler/claim-spec-match.ts
 *     `staticTagsOfWorkItem`)
 * plus the pure set semantics, idempotence, untag symmetry, non-array tolerance,
 * and workspace/harness scoping. Gated on Docker like the other *-integration
 * tests; inline DDL carries only the columns under test.
 *
 * EI-18810823481386446 adds the OUTCOME contract: a 0-row write is classified
 * (`already` vs `remote-origin` vs `no-row`) instead of collapsing to one `false`.
 *
 * ⚠ SCOPE OF THE remote-origin TEST BELOW: the inline `engineer_issues` DDL here is
 * a plain TABLE. Production's is a VIEW whose INSTEAD OF trigger is what actually
 * no-ops the write on a federated row. So these tests pin the TypeScript
 * classification (origin='remote' ⇒ outcome 'remote-origin', payload untouched) —
 * NOT the trigger itself. That is the right split: the trigger is DB-side behavior
 * already covered by its migration, and the defect being fixed was that the TS
 * layer could not TELL the two 0-row cases apart.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  /** ids the own-node heal recognises as authored by THIS node (WI-10006515). */
  ownNodeIds: new Set<string>(),
  healCalls: [] as Array<{ workspaceId: string; id: string }>,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
// The plain-table fixture has no work_items base or author keys, so the real identity check
// cannot run here. This stand-in keeps its contract: flip origin to 'local' only for an
// own-node row (simulated by `ownNodeIds`) and answer whether it healed. The SQL identity
// predicate itself is covered by work-items-claim-issue-scope-reread.integration.test.ts.
vi.mock('./work-items-admission', () => ({
  selfHealOwnNodeOriginIfStranded: async (workspaceId: string, id: string) => {
    h.healCalls.push({ workspaceId, id });
    if (!h.ownNodeIds.has(id)) return false;
    const rows = await h.sql`
      UPDATE harness_shared.engineer_issues SET origin = 'local'
       WHERE workspace_id = ${workspaceId} AND issue_id = ${id} AND origin = 'remote'
      RETURNING issue_id`;
    return rows.length > 0;
  },
}));

const { nextTagSet, syncTopicTagToClaimTags } = await import('./work-item-topic-tags');

const FEATURES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    workspace_id text NOT NULL DEFAULT 'default',
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    tags jsonb,
    updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;
const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.engineer_issues (
    workspace_id text NOT NULL DEFAULT 'default',
    issue_id text NOT NULL,
    title text,
    payload jsonb,
    origin text,
    updated_at timestamptz,
    PRIMARY KEY (workspace_id, issue_id))`;

const WS = 'default';
const HARNESS = 'papercusp';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-item-topic-tags');
  h.sql = db.sql;
  await db.sql.unsafe(FEATURES_DDL);
  await db.sql.unsafe(ISSUES_DDL);
}, 60_000);

beforeEach(async () => {
  h.ownNodeIds.clear();
  h.healCalls.length = 0;
  await db.sql`DELETE FROM harness_shared.harness_features_consolidated`;
  await db.sql`DELETE FROM harness_shared.engineer_issues`;
});

async function seedFeature(id: string, tags: unknown = null, workspaceId = WS, harness = HARNESS) {
  await db.sql`
    INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, title, tags)
    VALUES (${workspaceId}, ${harness}, ${id}, 'seed', ${tags === null ? null : JSON.stringify(tags)}::text::jsonb)`;
}
async function featureTags(id: string, harness = HARNESS): Promise<unknown> {
  const rows = await db.sql<{ tags: unknown }[]>`
    SELECT tags FROM harness_shared.harness_features_consolidated
     WHERE feature_id = ${id} AND harness_slug = ${harness}`;
  return rows[0]?.tags ?? null;
}
async function seedIssue(id: string, payload: unknown = null, workspaceId = WS, origin: string | null = 'local') {
  await db.sql`
    INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, title, payload, origin)
    VALUES (${workspaceId}, ${id}, 'seed', ${payload === null ? null : JSON.stringify(payload)}::text::jsonb, ${origin})`;
}

/** The outcome alone — most assertions below only care WHICH of the five it is. */
const outcomeOf = async (args: Parameters<typeof syncTopicTagToClaimTags>[0]) =>
  (await syncTopicTagToClaimTags(args)).outcome;
async function issuePayload(id: string, workspaceId = WS): Promise<Record<string, unknown> | null> {
  const rows = await db.sql<{ payload: Record<string, unknown> | null }[]>`
    SELECT payload FROM harness_shared.engineer_issues
     WHERE issue_id = ${id} AND workspace_id = ${workspaceId}`;
  return rows[0]?.payload ?? null;
}

describe('nextTagSet (pure set semantics)', () => {
  it('adds, dedups, and preserves order', () => {
    expect(nextTagSet(null, 'p2p-release', 'add')).toEqual(['p2p-release']);
    expect(nextTagSet(['a'], 'b', 'add')).toEqual(['a', 'b']);
    expect(nextTagSet(['a', 'b'], 'b', 'add')).toEqual(['a', 'b']);
  });
  it('removes, and tolerates a non-array legacy value', () => {
    expect(nextTagSet(['a', 'b'], 'a', 'remove')).toEqual(['b']);
    expect(nextTagSet('not-an-array', 'a', 'add')).toEqual(['a']);
    expect(nextTagSet({ a: 1 }, 'a', 'remove')).toEqual([]);
  });
});

describe('feature-family: the `tags` COLUMN the claim SQL reads (EI-18654138087054247)', () => {
  it('THE REGRESSION — tagging an item with a NULL tags column makes the tag claim-visible', async () => {
    // WI-5779's exact live shape: the row exists, tags is NULL.
    await seedFeature('WI-5779', null);
    expect(await featureTags('WI-5779')).toBeNull(); // pre-fix state: invisible to the claim SQL

    expect(
      await syncTopicTagToClaimTags({
        id: 'WI-5779',
        family: 'feature',
        workspaceId: WS,
        harness: HARNESS,
        topic: 'p2p-release',
      }),
    ).toEqual({ outcome: 'applied', mirrored: true, changed: true });
    expect(await featureTags('WI-5779')).toEqual(['p2p-release']);
  });

  it('appends to an existing set and is idempotent', async () => {
    await seedFeature('WI-1', ['existing']);
    expect(await outcomeOf({ id: 'WI-1', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release' })).toBe('applied');
    expect(await featureTags('WI-1')).toEqual(['existing', 'p2p-release']);
    // Re-tagging writes nothing — but the field DOES hold the tag, so this is
    // `already`/mirrored, never the same answer as a refused write.
    expect(await syncTopicTagToClaimTags({ id: 'WI-1', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release' })).toEqual({
      outcome: 'already',
      mirrored: true,
      changed: false,
    });
    expect(await featureTags('WI-1')).toEqual(['existing', 'p2p-release']);
  });

  it('untag removes only that tag, and is idempotent', async () => {
    await seedFeature('WI-2', ['a', 'p2p-release', 'b']);
    expect(await outcomeOf({ id: 'WI-2', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release', remove: true })).toBe('applied');
    expect(await featureTags('WI-2')).toEqual(['a', 'b']);
    // Idempotent UNTAG: desired state is "tag absent", which holds — `already`.
    expect(await outcomeOf({ id: 'WI-2', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release', remove: true })).toBe('already');
    expect(await featureTags('WI-2')).toEqual(['a', 'b']);
  });

  it('tolerates a legacy NON-ARRAY tags value instead of throwing', async () => {
    await seedFeature('WI-3', 'legacy-string');
    expect(await outcomeOf({ id: 'WI-3', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release' })).toBe('applied');
    expect(await featureTags('WI-3')).toEqual(['p2p-release']);
  });

  it('is workspace- and harness-scoped, and reports the miss as `no-row` (NOT `already`)', async () => {
    await seedFeature('WI-4', null, 'other-ws', HARNESS);
    expect(await syncTopicTagToClaimTags({ id: 'WI-4', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release' })).toEqual({
      outcome: 'no-row',
      mirrored: false,
      changed: false,
    });
    expect(await featureTags('WI-4')).toBeNull();

    await seedFeature('WI-5', null, WS, 'other-harness');
    expect(await outcomeOf({ id: 'WI-5', family: 'feature', workspaceId: WS, harness: HARNESS, topic: 'p2p-release' })).toBe('no-row');
    expect(await featureTags('WI-5', 'other-harness')).toBeNull();
  });
});

describe('issue-family: the `payload.tags` the JS evaluator reads (EI-18654138087054247)', () => {
  it('tagging an issue with no payload makes the tag claim-visible', async () => {
    await seedIssue('EI-1', null);
    expect(await outcomeOf({ id: 'EI-1', family: 'issue', workspaceId: WS, topic: 'p2p-release' })).toBe('applied');
    expect(await issuePayload('EI-1')).toEqual({ tags: ['p2p-release'] });
  });

  it('MERGES into the existing payload — never replaces sibling keys', async () => {
    await seedIssue('EI-2', { implementAttempts: 2, tags: ['a'] });
    expect(await outcomeOf({ id: 'EI-2', family: 'issue', workspaceId: WS, topic: 'p2p-release' })).toBe('applied');
    expect(await issuePayload('EI-2')).toEqual({ implementAttempts: 2, tags: ['a', 'p2p-release'] });
  });

  it('is idempotent, and untag removes only that tag', async () => {
    await seedIssue('EI-3', { tags: ['a', 'p2p-release'] });
    expect(await outcomeOf({ id: 'EI-3', family: 'issue', workspaceId: WS, topic: 'p2p-release' })).toBe('already');
    expect(await outcomeOf({ id: 'EI-3', family: 'issue', workspaceId: WS, topic: 'p2p-release', remove: true })).toBe('applied');
    expect(await issuePayload('EI-3')).toEqual({ tags: ['a'] });
    expect(await outcomeOf({ id: 'EI-3', family: 'issue', workspaceId: WS, topic: 'p2p-release', remove: true })).toBe('already');
  });

  it('is workspace-scoped, and reports the miss as `no-row`', async () => {
    await seedIssue('EI-4', null, 'other-ws');
    expect(await outcomeOf({ id: 'EI-4', family: 'issue', workspaceId: WS, topic: 'p2p-release' })).toBe('no-row');
    expect(await issuePayload('EI-4', 'other-ws')).toBeNull();
  });

  describe('EI-18810823481386446 — a federated row must NOT report success', () => {
    it('THE BUG: a remote-origin row returns `remote-origin`/mirrored:false, not the `already`-shaped false a caller reads as fine', async () => {
      // WI-3669's exact live shape: the row resolves, payload.tags is NULL, and the
      // production view's INSTEAD OF trigger refuses the local write. Pre-fix this
      // returned the SAME `false` as an idempotent re-tag, and tagWorkItem discarded
      // it — so work_items:tag answered ok:true having written nothing.
      await seedIssue('EI-REMOTE', null, WS, 'remote');

      expect(await syncTopicTagToClaimTags({ id: 'EI-REMOTE', family: 'issue', workspaceId: WS, topic: 'p2p-excluded' })).toEqual({
        outcome: 'remote-origin',
        mirrored: false,
        changed: false,
      });
      // and it genuinely wrote nothing.
      expect(await issuePayload('EI-REMOTE')).toBeNull();
    });

    it('reports `remote-origin` for an UNTAG too — the refusal is a property of the row, not the direction', async () => {
      await seedIssue('EI-REMOTE-2', { tags: ['p2p-excluded'] }, WS, 'remote');
      expect(await outcomeOf({ id: 'EI-REMOTE-2', family: 'issue', workspaceId: WS, topic: 'p2p-excluded', remove: true })).toBe('remote-origin');
      expect(await issuePayload('EI-REMOTE-2')).toEqual({ tags: ['p2p-excluded'] });
    });

    it('a LOCAL row is unaffected — the guard is origin-specific, not a blanket refusal', async () => {
      await seedIssue('EI-LOCAL', null, WS, 'local');
      expect(await outcomeOf({ id: 'EI-LOCAL', family: 'issue', workspaceId: WS, topic: 'p2p-excluded' })).toBe('applied');
      expect(await issuePayload('EI-LOCAL')).toEqual({ tags: ['p2p-excluded'] });
    });
  });

  describe('WI-10006515 — an OWN-NODE row stranded at origin=remote is healed, not refused', () => {
    it('heals an own-node remote row and applies the tag (pre-fix: remote-origin, tag never mirrored)', async () => {
      await seedIssue('EI-OWN', null, WS, 'remote');
      h.ownNodeIds.add('EI-OWN');

      expect(await syncTopicTagToClaimTags({ id: 'EI-OWN', family: 'issue', workspaceId: WS, topic: 'p2p-excluded' })).toEqual({
        outcome: 'applied',
        mirrored: true,
        changed: true,
      });
      expect(await issuePayload('EI-OWN')).toEqual({ tags: ['p2p-excluded'] });
      expect(h.healCalls).toEqual([{ workspaceId: WS, id: 'EI-OWN' }]);
    });

    it('heals an own-node remote row on UNTAG too', async () => {
      await seedIssue('EI-OWN-2', { tags: ['p2p-excluded'] }, WS, 'remote');
      h.ownNodeIds.add('EI-OWN-2');
      expect(await outcomeOf({ id: 'EI-OWN-2', family: 'issue', workspaceId: WS, topic: 'p2p-excluded', remove: true })).toBe('applied');
      expect(await issuePayload('EI-OWN-2')).toEqual({ tags: [] });
    });

    it('a TRUE peer row is still refused: the heal is consulted, declines, and nothing is written', async () => {
      await seedIssue('EI-PEER', null, WS, 'remote');
      expect(await outcomeOf({ id: 'EI-PEER', family: 'issue', workspaceId: WS, topic: 'p2p-excluded' })).toBe('remote-origin');
      expect(await issuePayload('EI-PEER')).toBeNull();
      expect(h.healCalls).toEqual([{ workspaceId: WS, id: 'EI-PEER' }]);
    });

    it('a LOCAL row never consults the heal (the exceptional path only)', async () => {
      await seedIssue('EI-LOCAL-2', null, WS, 'local');
      expect(await outcomeOf({ id: 'EI-LOCAL-2', family: 'issue', workspaceId: WS, topic: 'p2p-excluded' })).toBe('applied');
      expect(h.healCalls).toEqual([]);
    });
  });
});
