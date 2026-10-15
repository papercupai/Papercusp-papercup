/**
 * topics-feed.integration.test.ts — the cross-object topic tagging + "everything
 * about topic X" feed (integration-adoption Capstone P1) against REAL Postgres
 * (the shared baseline-schema DB via inject('baselineSchemaDsn')).
 *
 * BRIEF-test-coverage-fu-coordination-federation-area target #4: topicFeed /
 * tagObject were untested. Drives the `topics-feed.ts` module through its OWN
 * getOrgPg() handle + the real PgTaggableStore (coord_links edges), enriching from
 * the real backing tables. Covers:
 *  • empty topic → []
 *  • a conversation-kind item enriched (title + state from coord_conversations)
 *  • an issue-kind item enriched (title + state from engineer_issues)
 *  • a mixed-kind feed
 *  • a DANGLING tag (backing row absent) → enrich degrades to nulls, never throws
 *  • tagObject / listObjectTags / untagObject round-trip (idempotent)
 *
 * Uses conversation + issue kinds (neither under RLS); the `feature` kind enriches
 * from the RLS-gated harness_features_consolidated, out of scope here. coord_links
 * is TRUNCATEd per test and the seeded backing rows deleted — no other baseline-DSN
 * suite touches these tables.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { tagObject, untagObject, listObjectTags, topicFeed } from './topics-feed';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

async function seedConversation(id: string, title: string, state = 'open'): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_conversations (workspace_id, id, kind, scope, asker_id, title, state)
    VALUES ('default', ${id}, 'question', 'operator', 'su-asker', ${title}, ${state})`;
}

async function seedIssue(id: string, title: string, state = 'open'): Promise<void> {
  // Seed through the canonical writer surface. The compatibility view's INSERT
  // readback uses its pre-trigger scope, which can be rehomed by pot membership.
  await admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind)
    VALUES ('default',
      COALESCE(harness_shared.workspace_platform_pot('default'), 'operator:default'),
      ${id}, ${title}, '', ${state}, 'bug')`;
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_links`;
});
afterEach(async () => {
  // Drop the seeded backing rows so a run leaves no trace (the test's own refs).
  await admin`DELETE FROM harness_shared.coord_conversations WHERE id LIKE 'tf-%'`.catch(() => {});
  await admin`DELETE FROM harness_shared.engineer_issues WHERE issue_id LIKE 'EI-TF%'`.catch(() => {});
});

describe('topicFeed (real PG)', () => {
  it('seeds a stored issue in the workspace platform pot visible through the issue view', async () => {
    await seedIssue('EI-TF-storage', 'stored issue');
    const [{ platform }] = await admin`
      SELECT harness_shared.workspace_platform_pot('default') AS platform`;
    const [stored] = await admin`
      SELECT harness_slug, item_kind, title
      FROM harness_shared.work_items
      WHERE workspace_id = 'default' AND feature_id = 'EI-TF-storage'`;
    expect(stored).toEqual({
      harness_slug: platform ?? 'operator:default',
      item_kind: 'bug',
      title: 'stored issue',
    });
    const [visible] = await admin`
      SELECT base_harness_slug, kind, title, state
      FROM harness_shared.engineer_issues
      WHERE workspace_id = 'default' AND issue_id = 'EI-TF-storage'`;
    expect(visible).toEqual({
      base_harness_slug: stored.harness_slug,
      kind: 'bug',
      title: 'stored issue',
      state: 'open',
    });
  });

  it('returns [] for a topic with no tagged objects', async () => {
    expect(await topicFeed('tf-empty-topic')).toEqual([]);
  });

  it('enriches a conversation-kind item with its title + state', async () => {
    await seedConversation('tf-conv-1', 'shop freezes in Firefox', 'open');
    await tagObject('conversation', 'tf-conv-1', 'tf-firefox');

    const feed = await topicFeed('tf-firefox');
    expect(feed).toEqual([
      { kind: 'conversation', ref: 'tf-conv-1', title: 'shop freezes in Firefox', state: 'open' },
    ]);
  });

  it('enriches an issue-kind item with its title + state', async () => {
    await seedIssue('EI-TF1', 'flaky cart test', 'resolved');
    await tagObject('issue', 'EI-TF1', 'tf-flake');

    const feed = await topicFeed('tf-flake');
    expect(feed).toEqual([{ kind: 'issue', ref: 'EI-TF1', title: 'flaky cart test', state: 'resolved' }]);
  });

  it('returns a mixed-kind feed for objects sharing a topic', async () => {
    await seedConversation('tf-conv-2', 'why so slow?', 'open');
    await seedIssue('EI-TF2', 'dashboard TTFB regression', 'open');
    await tagObject('conversation', 'tf-conv-2', 'tf-perf');
    await tagObject('issue', 'EI-TF2', 'tf-perf');

    const feed = await topicFeed('tf-perf');
    const byRef = Object.fromEntries(feed.map((f) => [f.ref, f]));
    expect(Object.keys(byRef).sort()).toEqual(['EI-TF2', 'tf-conv-2']);
    expect(byRef['tf-conv-2']).toMatchObject({ kind: 'conversation', title: 'why so slow?' });
    expect(byRef['EI-TF2']).toMatchObject({ kind: 'issue', title: 'dashboard TTFB regression' });
  });

  it('degrades gracefully on a dangling tag (backing row absent) — nulls, not a throw', async () => {
    // Tag a conversation ref that has NO coord_conversations row.
    await tagObject('conversation', 'tf-conv-missing', 'tf-dangling');
    // …alongside a real one, to prove the dangler does not poison the rest.
    await seedConversation('tf-conv-real', 'real one', 'open');
    await tagObject('conversation', 'tf-conv-real', 'tf-dangling');

    const feed = await topicFeed('tf-dangling');
    const byRef = Object.fromEntries(feed.map((f) => [f.ref, f]));
    expect(byRef['tf-conv-missing']).toEqual({
      kind: 'conversation',
      ref: 'tf-conv-missing',
      title: null,
      state: null,
    });
    expect(byRef['tf-conv-real']).toMatchObject({ title: 'real one', state: 'open' });
  });

  it('degrades to nulls for an unknown kind (no enrich branch)', async () => {
    // 'plan' has an enrich branch but no backing row → nulls; an entirely-unknown
    // ref still surfaces with nulls rather than throwing.
    await tagObject('plan', 'tf-plan-missing', 'tf-unknown');
    const feed = await topicFeed('tf-unknown');
    expect(feed).toEqual([{ kind: 'plan', ref: 'tf-plan-missing', title: null, state: null }]);
  });
});

describe('tagObject / listObjectTags / untagObject (real PG)', () => {
  it('round-trips: tag → list → untag, and tagging is idempotent', async () => {
    await seedConversation('tf-conv-rt', 'round trip', 'open');

    await tagObject('conversation', 'tf-conv-rt', 'tf-area-a');
    await tagObject('conversation', 'tf-conv-rt', 'tf-area-b');
    await tagObject('conversation', 'tf-conv-rt', 'tf-area-a'); // duplicate → no-op

    expect((await listObjectTags('conversation', 'tf-conv-rt')).sort()).toEqual(['tf-area-a', 'tf-area-b']);

    await untagObject('conversation', 'tf-conv-rt', 'tf-area-a');
    expect(await listObjectTags('conversation', 'tf-conv-rt')).toEqual(['tf-area-b']);

    // The untagged object drops out of area-a's feed; stays in area-b's.
    expect(await topicFeed('tf-area-a')).toEqual([]);
    expect((await topicFeed('tf-area-b')).map((f) => f.ref)).toEqual(['tf-conv-rt']);
  });

  it('untagging a non-existent tag is a harmless no-op', async () => {
    await expect(untagObject('conversation', 'tf-never-tagged', 'tf-nope')).resolves.toBeUndefined();
    expect(await listObjectTags('conversation', 'tf-never-tagged')).toEqual([]);
  });
});
