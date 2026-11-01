import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { discoverySourceHash, loadBlindReviewDiscoveries, type DiscoveryOccurrence } from './blind-review-discovery-source';

describe('blind discovery source SQL scope (real PG)', () => {
  let db: FreshPgDb;
  let occurrence: DiscoveryOccurrence;
  beforeAll(async () => {
    db = await createFreshPgDb('blind-discovery-source');
    await applyMigrationForTest(db.sql, fileURLToPath(new URL('../../../libs/papercusp/libs/db/sql/831-issue-occurrence-ledger.sql', import.meta.url)));
    const [row] = await db.sql<DiscoveryOccurrence[]>`
      INSERT INTO harness_shared.work_item_occurrences
        (workspace_id, canonical_harness_slug, canonical_work_item_id, reporter, source_tool,
         report_kind, reported_title, evidence, occurred_at)
      VALUES ('discovery-ws', 'papercusp', 'EI-ORIGINAL', 'su-reporter', 'improvements:capture',
        'canonical-created', 'Retain source receipts', jsonb_build_object('body', 'Keep the complete receipt after its source retires.'),
        '2026-10-25T10:00:00Z')
      RETURNING occurrence_id::text, canonical_work_item_id, reporter, source_tool, report_kind,
        reported_title, evidence->>'body' AS body, occurred_at`;
    occurrence = row;
  }, 90_000);
  afterAll(async () => { await db?.cleanup(); });

  function load(workspaceId = 'discovery-ws', harnessSlug = 'papercusp', sha256 = discoverySourceHash(occurrence)) {
    return loadBlindReviewDiscoveries({ workspaceId, harnessSlug, planCreatedAt: '2026-10-25T11:00:00Z',
      declarations: [{ itemId: 'P-001', kind: 'agent-added', reason: 'Repair source retention',
        discoverySources: [{ ref: `issue-occurrence:${occurrence.occurrence_id}`, sha256 }] }],
    }, db.sql);
  }

  it('reads the original JSON body and verifies a stable timestamp-normalized hash', async () => {
    expect(await load()).toEqual([expect.objectContaining({ workItemId: 'EI-ORIGINAL', reporter: 'su-reporter',
      text: occurrence.body, sha256: discoverySourceHash(occurrence), occurredAt: '2026-10-25T10:00:00.000Z' })]);
    expect(discoverySourceHash({ ...occurrence, occurred_at: '2026-10-25T10:00:00.000Z' }))
      .toBe(discoverySourceHash(occurrence));
  });

  it('refuses an exact occurrence id from another workspace or harness', async () => {
    await expect(load('other-ws')).rejects.toThrow('blind_discovery_source_invalid');
    await expect(load('discovery-ws', 'other-harness')).rejects.toThrow('blind_discovery_source_invalid');
  });

  it('refuses a wrong immutable content pin', async () => {
    await expect(load('discovery-ws', 'papercusp', 'a'.repeat(64))).rejects.toThrow('blind_discovery_source_invalid');
  });
});
