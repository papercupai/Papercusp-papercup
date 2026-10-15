/**
 * datatype-frontier-placement.integration.test — `frontierPlacementKindClause` against real PG
 * (enterprise-data-sources-2026-10-01 P-009 / D-022).
 *
 * Placement is decided by the row's NATURE + AUDIENCE through the single work predicate
 * (`harness_shared.work_item_is_agent_work`, migration 1325) plus the issue-family ROUTE — no
 * longer by the retired `hive-placement` registry tag. The clause reads columns only, so it is
 * driven over a synthetic VALUES relation shaped like `harness_features_consolidated`
 * (item_kind, nature, audience, payload); createOrgTestDb applies the full migration set, so
 * the 1325 function exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { upsertDatatype } from './datatype-registry-store';
import { frontierPlacementKindClause, HIVE_PLACEMENT_TAG } from './datatype-frontier-placement';

const { createOrgTestDb } = await import('../test/_org-test-db');

interface Candidate {
  id: string;
  item_kind: string;
  nature: string | null;
  audience: string | null;
  payload?: Record<string, unknown>;
}

/** Run the frontier clause over synthetic candidate rows; return the ids it admits. */
async function placeable(db: OrgTestDb, rows: Candidate[]): Promise<string[]> {
  const json = JSON.stringify(rows.map((r) => ({ ...r, payload: r.payload ?? {} })));
  const out = await db.adminSql<{ id: string }[]>`
    SELECT id FROM jsonb_to_recordset(${json}::jsonb)
             AS t(id text, item_kind text, nature text, audience text, payload jsonb)
     WHERE ${frontierPlacementKindClause(db.adminSql, 'ws-frontier')}
     ORDER BY id`;
  return out.map((r) => r.id);
}

describe('frontier placement by nature/audience (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('admits feature-family agent work; excludes issue-routed kinds, human audience and non-work natures', async () => {
    const admitted = await placeable(db, [
      { id: 'a-feature', item_kind: 'feature', nature: 'work', audience: 'agent' },
      { id: 'b-generic-work', item_kind: 'bet-analysis', nature: 'work', audience: 'agent' },
      { id: 'c-bug', item_kind: 'bug', nature: 'work', audience: 'agent' },
      { id: 'd-task', item_kind: 'task', nature: 'work', audience: 'agent' },
      { id: 'e-email-draft', item_kind: 'email-draft-proposal', nature: 'work', audience: 'human' },
      { id: 'f-record', item_kind: 'wager', nature: 'record', audience: null },
      { id: 'g-document', item_kind: 'slack-message', nature: 'document', audience: null },
      { id: 'h-event', item_kind: 'calendar-event', nature: 'event', audience: null },
    ]);
    expect(admitted).toEqual(['a-feature', 'b-generic-work']);
  });

  it('excludes the observation lane and needs-owner-action rows, as the work predicate does', async () => {
    const admitted = await placeable(db, [
      { id: 'a-plain', item_kind: 'feature', nature: 'work', audience: 'agent' },
      { id: 'b-observation', item_kind: 'feature', nature: 'work', audience: 'agent', payload: { lane: 'observation' } },
      { id: 'c-owner-action', item_kind: 'feature', nature: 'work', audience: 'agent', payload: { needsOwnerAction: true } },
      { id: 'd-owner-action-false', item_kind: 'feature', nature: 'work', audience: 'agent', payload: { needsOwnerAction: false } },
    ]);
    expect(admitted).toEqual(['a-plain', 'd-owner-action-false']);
  });

  it('the retired hive-placement tag is not a decider: placement follows the stamped nature, tagged or not', async () => {
    const ws = 'ws-frontier';
    // Registry rows are what migration 1322's trigger stamps nature/audience FROM; the tag on
    // them must no longer change the verdict in either direction.
    await upsertDatatype(db.adminSql, {
      id: 'tagged-record',
      workspaceId: ws,
      title: 'Tagged record',
      description: 'a record that still carries the old opt-in tag',
      tier: 'generic-kind',
      nature: 'record',
      workItemKind: 'tagged-record',
      tags: [HIVE_PLACEMENT_TAG],
    });
    await upsertDatatype(db.adminSql, {
      id: 'untagged-work',
      workspaceId: ws,
      title: 'Untagged work',
      description: 'agent work that never opted in',
      tier: 'generic-kind',
      nature: 'work',
      audience: 'agent',
      workItemKind: 'untagged-work',
      tags: [],
    });
    const stamped = await db.adminSql<{ kind: string; nature: string; audience: string | null }[]>`
      SELECT v.kind, k.nature, k.audience
        FROM (VALUES ('tagged-record'), ('untagged-work')) AS v(kind),
             LATERAL harness_shared.work_item_kind_nature(${ws}, v.kind) AS k`;
    const rows = stamped.map((s) => ({ id: s.kind, item_kind: s.kind, nature: s.nature, audience: s.audience }));
    expect(await placeable(db, rows)).toEqual(['untagged-work']);
  });
});
