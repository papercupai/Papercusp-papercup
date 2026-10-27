import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupPlanPgFixture, type PlanPgFixture } from '../agent-tools/plans/__tests__/_pg-tool-fixture';
import { recordReuseBriefIssued, reuseIssuedSubjects, type ReuseIssuedRecord } from './reuse-brief-ledger';
import type { ReuseProviderObservation } from './reuse-brief-providers';

let fx: PlanPgFixture;
beforeAll(async () => { fx = await setupPlanPgFixture({ isolated: true }); }, 180_000);
afterAll(async () => { await fx?.dispose(); });
const owner = 'reuse-brief-ledger-fixture';
const row = (provider: ReuseProviderObservation['provider'], status: ReuseProviderObservation['status'] = 'issued'): ReuseProviderObservation => ({
  provider, status, reason: 'complete', chars: status === 'issued' ? 100 : 0, sourceVersion: 'blob-v1', indexVersion: 'index-v2', citedPaths: ['target.ts'],
});
const input = (invocation = 'real-fixture-dispatch'): ReuseIssuedRecord => ({ context: { workspaceId: fx.workspaceId,
  owner, invocation, surface: 'claim', workItem: 'WI-fixture', plan: 'fixture-plan', planItems: ['P-009'],
  paths: ['target.ts'], sourceVersion: 'blob-v1' }, observations: [row('clones'), row('sql')],
  recover: { tool: 'work_items:get', args: { id: 'WI-fixture' } } });
describe('P009 existing issued-only PG ledger', () => {
  it('persists separate versioned sources, dedupes a retry and retains another dispatch independently', async () => {
    await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${fx.workspaceId}, ${owner}, 'actual-fixture-turn')`;
    const record = input(), signal = new AbortController().signal;
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    expect(await recordReuseBriefIssued(input('second-fixture-dispatch'), signal)).toBe(true);
    const rows = await fx.admin`SELECT owner_id, turn_id, leg, subject, cited_paths, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner} ORDER BY id`;
    expect(rows).toHaveLength(4);
    expect(rows.map(r => JSON.parse(r.subject).provider)).toEqual(['clones', 'sql', 'clones', 'sql']);
    expect(rows.every(r => r.turn_id === 'actual-fixture-turn' && r.chars === 100)).toBe(true);
    expect(JSON.parse(rows[0]!.subject)).toMatchObject({ surface: 'claim', invocation: 'real-fixture-dispatch',
      workItem: 'WI-fixture', planItems: ['P-009'], sourceVersion: 'blob-v1', indexVersion: 'index-v2', outcome: 'complete' });
  });
  it('SPEC-P-006-B: a withheld recovery call is ledgered as no suggested call, never a tool name', async () => {
    const recipient = 'reuse-brief-ledger-p006-recipient', signal = new AbortController().signal;
    await fx.admin`INSERT INTO harness_shared.identity_hook_turns (workspace_id, owner_id, turn_id)
      VALUES (${fx.workspaceId}, ${recipient}, 'p006-fixture-turn')`;
    const listed = input('p006-listed'), withheld = input('p006-withheld');
    delete withheld.recover;
    for (const record of [listed, withheld]) {
      record.context.owner = recipient;
      expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    }
    const rows = await fx.admin`SELECT subject, suggested_call
      FROM harness_shared.code_intel_pushes WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${recipient} ORDER BY id`;
    expect(rows.map(r => [JSON.parse(r.subject).invocation, r.suggested_call])).toEqual([
      ['p006-listed', 'work_items:get {"id":"WI-fixture"}'], ['p006-listed', 'work_items:get {"id":"WI-fixture"}'],
      ['p006-withheld', null], ['p006-withheld', null]]);
  });
  it('does not persist unknown/no-match/budget outcomes, invent turns or issue cancelled facts', async () => {
    const record = input('non-issued');
    record.observations = [row('coverage', 'unknown'), row('provenance', 'no-match'), row('cochange', 'budget')];
    expect(reuseIssuedSubjects(record)).toEqual([]);
    expect(await recordReuseBriefIssued(record, new AbortController().signal)).toBe(true);
    const noTurn = input('missing-turn'); noTurn.context.owner = 'no-turn-fixture';
    expect(await recordReuseBriefIssued(noTurn, new AbortController().signal)).toBe(false);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await recordReuseBriefIssued(input('cancelled'), cancelled.signal)).toBe(false);
    const rows = await fx.admin`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}`;
    expect(rows).toHaveLength(4);
    const turns = await fx.admin`SELECT owner_id FROM harness_shared.identity_hook_turns
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = 'no-turn-fixture'`;
    expect(turns).toEqual([]);
  });
  it('records five issued sources atomically while concurrent identical dispatches dedupe', async () => {
    const record = input('five-source-concurrency');
    record.observations = ['clones', 'cochange', 'provenance', 'sql', 'coverage'].map(provider =>
      row(provider as ReuseProviderObservation['provider']));
    // Inspect the migrated fixture, since source declarations alone cannot rule
    // out a trigger or an index added by a different migration.
    const triggers = await fx.admin`SELECT tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE tgrelid = 'harness_shared.code_intel_pushes'::regclass
      AND NOT tgisinternal`;
    const indexes = await fx.admin`SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'harness_shared' AND tablename = 'code_intel_pushes'`;
    const sample = reuseIssuedSubjects(record)[0]!;
    const plan = await fx.admin.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
      const result = await tx`EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON)
        INSERT INTO harness_shared.code_intel_pushes
          (workspace_id, owner_id, epoch, turn_id, leg, subject, snapshot_commit, cited_paths, suggested_call, chars)
        VALUES (${fx.workspaceId}, ${owner}, 0, 'actual-fixture-turn', ${`reuse-${sample.row.provider}`},
          ${sample.subject}, NULL, ${sample.row.citedPaths}::text[], 'fixture-explain', ${sample.row.chars})
        ON CONFLICT (workspace_id, owner_id, epoch, leg, subject) DO NOTHING`;
      await tx`ROLLBACK`;
      return result;
    });
    console.info('REUSE_LEDGER_PG_EXECUTION', JSON.stringify({ triggers, indexes, plan }));
    const results = await Promise.all([record, record, input('independent-concurrent-dispatch')]
      .map(value => recordReuseBriefIssued(value, new AbortController().signal)));
    expect(results).toEqual([true, true, true]);
    const persisted = await fx.admin`SELECT subject FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}
      AND subject::jsonb->>'invocation' = 'five-source-concurrency'`;
    expect(persisted).toHaveLength(5);
    expect(persisted.map(value => JSON.parse(value.subject).provider).sort())
      .toEqual(record.observations.map(value => value.provider).sort());
  });
  it('records a qualified holdout with zero spend and stable independent identity, without inventing issuance', async () => {
    const record = input('holdout-dispatch');
    record.context.workItem = 'WI-12';
    record.observations = [{ ...row('coverage', 'held-out'), reason: 'holdout', cohort: 'holdout' }];
    expect(reuseIssuedSubjects(record)).toEqual([]);
    const signal = new AbortController().signal;
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    expect(await recordReuseBriefIssued(record, signal)).toBe(true);
    const rows = await fx.admin`SELECT leg, subject, chars FROM harness_shared.code_intel_pushes
      WHERE workspace_id = ${fx.workspaceId} AND owner_id = ${owner}
        AND subject::jsonb->>'invocation' = 'holdout-dispatch'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ leg: 'reuse-holdout-coverage', chars: 0 });
    expect(JSON.parse(rows[0]!.subject)).toMatchObject({ provider: 'coverage', workItem: 'WI-12',
      cohort: 'holdout', selector: { paths: ['target.ts'], symbols: [] }, outcome: 'holdout' });
  });
});
