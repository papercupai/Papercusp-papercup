/** Current-source acceptance child for work-items-admission-bulk-dedup-background.integration.test.ts. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import postgres from 'postgres';
import { runWorkItemAdmissionBulkDedup } from '../lib/work-items-admission-bulk-dedup';
import { runWorkItemAdmissionDailyDigest } from '../lib/work-items-admission-daily-digest';
import { readAdmissionMergeSnapshots, runWorkItemAdmissionPromoter } from '../lib/work-items-admission-promoter';
import { getServingHostIdentity } from '../lib/serving-host-identity';
import { lexicalHardEdges } from '../lib/work-items-admission-census';
import { ADMISSION_MERGE_QUALITY_GOLD_CORPUS, admissionMergeQualityGoldJudgements } from '../lib/work-items-admission-merge-quality';
import { enqueueBulkDedupRun } from '../lib/work-items-admission-bulk-dedup-enqueue';
import { getWorkItem, setWorkItemState, unlinkWorkItem } from '../lib/work-items';
import { runWithWorkspace } from '../lib/workspace-als';

const home = process.env.HOME!;
const ws = process.env.PAPERCUSP_WORKSPACE_ID!;
const dsn = process.env.HARNESS_ADMIN_DATABASE_URL!;
assert.ok(home.includes('papercusp-test-runtime-'));
assert.ok(ws.startsWith('test-runtime-'));
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.equal(process.env.PAPERCUSP_CLUSTER, '0');
assert.equal(process.env.PAPERCUSP_BACKGROUND_WORKERS, '1');
assert.ok(dsn);
assert.equal(new URL(dsn).port, process.env.PAPERCUSP_PG_PORT);
assert.notEqual(new URL(dsn).port, '5432');
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN']) {
  assert.equal(process.env[key], undefined, `${key} must not enter the private runtime`);
}
const sourceUrl = new URL('../lib/work-items-admission-bulk-dedup.ts', import.meta.url);
const sourceHash = createHash('sha256').update(await readFile(sourceUrl)).digest('hex');
assert.equal(sourceHash, process.env.BULK_BG_EXPECTED_SOURCE_SHA);
const sql = postgres(dsn, { max: 4, prepare: false, onnotice: () => {} });
const harness = 'bulk-background-acceptance';
const root = 'bulk-background-acceptance';
try {
  const [server] = await sql`SELECT inet_server_port() AS port, current_database() AS db`;
  assert.equal(String(server!.port), process.env.PAPERCUSP_PG_PORT);
  const [column] = await sql`
    SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'harness_shared.work_items'::regclass AND attname = 'embedding'`;
  const dims = Number(column?.atttypmod) > 0 ? Number(column!.atttypmod) : 3;
  const vector = (axis: number) => JSON.stringify(Array.from({ length: dims }, (_, i) => i === axis ? 1 : 0));
  const promoterSourceHash = createHash('sha256').update(await readFile(
    new URL('../lib/work-items-admission-promoter.ts', import.meta.url))).digest('hex');
  assert.equal(promoterSourceHash, process.env.BULK_BG_EXPECTED_PROMOTER_SHA);
  const comparisonCases: Array<{ name: string; modelCalls: number; promoted: number; merged: number; comparisonPreserved: boolean }> = [];
  for (const name of ['unauthenticated', 'distinct', 'duplicate-admitted', 'duplicate-pending', 'omitted', 'drift']) {
    const comparisonHarness = `claimed-comparison-${name}`;
    // feature_id is unique across the workspace, including separate harnesses.
    const originalId = `${name}-original`;
    const comparisonId = `${name}-comparison`;
    for (const id of [originalId, comparisonId]) await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, payload, item_kind, nature,
         taken_by, created_ts, updated_ts, embedding, embedding_mode, admission)
      VALUES (${ws}, ${comparisonHarness}, ${id}, 'Private claimed finding', 'Independent private evidence', 'open',
        '{"privateProof":"retained"}'::jsonb, 'change', 'work', ${id === comparisonId ? 'su-private-holder' : null},
        ${id === originalId ? 1 : 2}, ${id === originalId ? 1 : 2}, ${vector(0)}::vector, 'gemma',
        ${id === comparisonId && name !== 'duplicate-pending' ? 'admitted' : 'pending'})`;
    const scope = { workspaceId: ws, harnessSlug: comparisonHarness, ids: [comparisonId] };
    let expected = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
    assert.ok(expected);
    let modelCalls = 0;
    const result = await runWorkItemAdmissionPromoter({ workspaceId: ws, harnessSlug: comparisonHarness,
      sql, runId: `claimed-comparison-background-${name}`, now: () => 10_000,
      ...(name === 'unauthenticated' ? {} : { componentScreeningItemIds: [originalId] }),
      llmCall: async (input) => {
        modelCalls += 1;
        const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map(match => match[1]!);
        assert.deepEqual(keys, [`${comparisonId}::${originalId}`]);
        return { text: '', inputTokens: 10, outputTokens: 10, json: { judgements: name === 'omitted' ? [] : [{
          pairKey: keys[0], verdict: name.startsWith('duplicate-') ? 'r-finding-merge' : 'distinct', reason: 'private background control',
        }] } };
      },
      beforePersist: async () => {
        if (name !== 'drift') return;
        await sql`UPDATE harness_shared.work_items SET payload = payload || '{"laterProof":true}'::jsonb,
          updated_ts = updated_ts + 1 WHERE workspace_id = ${ws} AND harness_slug = ${comparisonHarness} AND feature_id = ${comparisonId}`;
        expected = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
      },
      onNewlyAdmitted: async () => {},
    });
    const actual = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
    assert.deepEqual(actual, expected, `claimed comparison ${name} must remain unchanged`);
    assert.equal(result.promoted, name === 'distinct' ? 1 : 0);
    assert.equal(result.merged, 0);
    assert.equal(modelCalls, name === 'unauthenticated' ? 0 : 1);
    if (name === 'drift') assert.ok(result.guardRefusals?.some(row => row.itemId === originalId && row.reason === 'snapshot-drift'));
    const [links] = await sql`SELECT count(*)::int AS count FROM harness_shared.coord_links
      WHERE workspace_id = ${ws} AND (src_ref IN (${originalId}, ${comparisonId}) OR dst_ref IN (${originalId}, ${comparisonId})
        OR src_ref = ${`${comparisonHarness}#${originalId}`} OR dst_ref = ${`${comparisonHarness}#${originalId}`}
        OR src_ref = ${`${comparisonHarness}#${comparisonId}`} OR dst_ref = ${`${comparisonHarness}#${comparisonId}`})`;
    assert.equal(links!.count, 0);
    comparisonCases.push({ name, modelCalls, promoted: result.promoted, merged: result.merged, comparisonPreserved: true });
  }
  const claimedComparison = { sourceHash: promoterSourceHash, runtime: getServingHostIdentity(), cases: comparisonCases };
  assert.ok(claimedComparison.runtime.processId);
  assert.ok(claimedComparison.runtime.buildSha, 'private source runtime must report its measured build identity');
  const parkCases: typeof comparisonCases = [];
  const parkActor = 'su-11111111-1111-4111-8111-111111111111';
  const parkReason = 'future independent private source work';
  for (const name of ['unauthenticated', 'distinct-admitted', 'distinct-pending', 'duplicate', 'omitted',
    'missing-audit', 'audit-drift', 'dependency-drift']) {
    const parkHarness = `audited-park-${name}`;
    const originalId = `${parkHarness}-original`, comparisonId = `${parkHarness}-comparison`;
    const payload = { _claimHold: true, _ei: { source: 'su', created_by: parkActor },
      claim_hold_by: parkActor, claim_hold_reason: parkReason, claim_hold_at: new Date(5_000).toISOString() };
    for (const id of [originalId, comparisonId]) await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, payload, item_kind, nature,
         created_ts, updated_ts, embedding, embedding_mode, admission)
      VALUES (${ws}, ${parkHarness}, ${id}, 'Private audited park finding', 'Independent private park evidence', 'open',
        ${sql.json(id === comparisonId ? payload : {})}::jsonb, 'change', 'work',
        ${id === originalId ? 1 : 2}, ${id === originalId ? 1 : 2}, ${vector(0)}::vector, 'gemma',
        ${id === comparisonId && name !== 'distinct-pending' ? 'admitted' : 'pending'})`;
    if (name !== 'missing-audit') await sql`
      INSERT INTO harness_shared.audit_log (id, ts, workspace_id, actor, action, subject, details)
      VALUES (${comparisonId + '-audit'}, ${5_001}, ${ws}, ${parkActor}, 'work_items:claim_hold:set', ${comparisonId},
        ${sql.json({ mode: 'claim_hold', by: parkActor, reason: parkReason })}::jsonb)`;
    const scope = { workspaceId: ws, harnessSlug: parkHarness, ids: [comparisonId] };
    let expected = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
    assert.ok(expected);
    let modelCalls = 0;
    const result = await runWorkItemAdmissionPromoter({ workspaceId: ws, harnessSlug: parkHarness,
      sql, runId: `audited-park-background-${name}`, now: () => 10_000,
      ...(name === 'unauthenticated' ? {} : { componentScreeningItemIds: [originalId] }),
      llmCall: async (input) => {
        modelCalls += 1;
        const keys = [...input.messages[0]!.content.matchAll(/^## (.+)$/gm)].map(match => match[1]!);
        assert.deepEqual(keys, [`${comparisonId}::${originalId}`]);
        return { text: '', inputTokens: 10, outputTokens: 10, json: { judgements: name === 'omitted' ? [] : [{
          pairKey: keys[0], verdict: name === 'duplicate' ? 'r-finding-merge' : 'distinct', reason: 'private audited park control',
        }] } };
      },
      beforePersist: async () => {
        if (name === 'audit-drift') await sql`UPDATE harness_shared.audit_log
          SET details = details || '{"reason":"changed private evidence"}'::jsonb
          WHERE workspace_id = ${ws} AND id = ${comparisonId + '-audit'}`;
        else if (name === 'dependency-drift') await sql`INSERT INTO harness_shared.work_item_deps
          (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by)
          VALUES (${ws}, 'issue', ${comparisonId}, 'issue', ${comparisonId + '-blocker'}, 'blocks', ${parkActor})`;
        else return;
        expected = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
      },
      onNewlyAdmitted: async () => {},
    });
    const actual = (await readAdmissionMergeSnapshots(sql, scope)).get(comparisonId);
    assert.deepEqual(actual, expected, `audited park ${name} must remain unchanged`);
    const distinct = name.startsWith('distinct-');
    assert.equal(result.promoted, distinct ? 1 : 0);
    assert.equal(result.merged, 0);
    assert.equal(modelCalls, ['unauthenticated', 'missing-audit'].includes(name) ? 0 : 1);
    if (name.endsWith('-drift')) assert.ok(result.guardRefusals?.some(row =>
      row.itemId === originalId && row.reason === 'snapshot-drift'));
    const [original] = await sql`SELECT admission FROM harness_shared.work_items
      WHERE workspace_id = ${ws} AND harness_slug = ${parkHarness} AND feature_id = ${originalId}`;
    assert.equal(original!.admission, distinct ? 'admitted' : 'pending');
    const [links] = await sql`SELECT count(*)::int AS count FROM harness_shared.coord_links
      WHERE workspace_id = ${ws} AND (src_ref IN (${originalId}, ${comparisonId}, ${parkHarness + '#' + originalId}, ${parkHarness + '#' + comparisonId})
        OR dst_ref IN (${originalId}, ${comparisonId}, ${parkHarness + '#' + originalId}, ${parkHarness + '#' + comparisonId}))`;
    assert.equal(links!.count, 0);
    parkCases.push({ name, modelCalls, promoted: result.promoted, merged: result.merged, comparisonPreserved: true });
  }
  const auditedParkComparison = { sourceHash: promoterSourceHash, runtime: claimedComparison.runtime, cases: parkCases };
  const insertColumns = ['workspace_id', 'harness_slug', 'feature_id', 'title', 'summary', 'status', 'payload',
    'item_kind', 'nature', 'created_ts', 'updated_ts', 'embedding', 'embedding_mode', 'admission', 'admitted_at', 'admitted_by'];
  const generatedInputs = await sql`
    SELECT attname FROM pg_attribute WHERE attrelid = 'harness_shared.work_items'::regclass
     AND attname = ANY(${insertColumns}::text[]) AND attgenerated <> ''`;
  assert.deepEqual(generatedInputs.map((row) => row.attname), [], 'fixture insert contract must omit generated columns');
  const fixtures = [
    { id: 'a', title: 'Cache invalidation repeats stale entries' },
    { id: 'b', title: 'Cache invalidation repeats stale entries' },
    { id: 'c', title: 'Parser rejects valid quoted identifiers' },
    { id: 'd', title: 'Parser rejects valid quoted identifiers' },
  ];
  const expectedPairs = ['a::b', 'c::d'];
  assert.deepEqual(lexicalHardEdges(fixtures).map(({ a, b }) => `${a}::${b}`).sort(), expectedPairs,
    'fixture title normalization must produce exactly the two intended pairs');
  for (const [i, { id, title }] of fixtures.entries()) {
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, payload,
         item_kind, nature, created_ts, updated_ts, embedding, embedding_mode, admission, admitted_at, admitted_by)
      VALUES (${ws}, ${harness}, ${id}, ${title}, ${`Evidence ${id}`}, 'open',
              jsonb_build_object('gradeHistory', jsonb_build_array(${`Original evidence ${id}`}::text)),
              'change', 'work', ${i + 1}, ${i + 1}, ${vector(i < 2 ? 0 : 1)}::vector,
              'gemma', 'admitted', now(), 'test')`;
  }
  let changed = false;
  let interrupted = false;
  let calls = 0;
  let pinnedRecompute: { sourceCensusRunId: string; before: number; after: number; retiredByStage: number } | undefined;
  const candidatePairs = new Set<string>();
  const opts: Parameters<typeof runWorkItemAdmissionBulkDedup>[0] = {
    workspaceId: ws, harnessSlug: harness, runId: root, sql,
    maxStages: 1,
    census: { chunkCount: 2, targetTokens: 1_000, fullCorpusPairThreshold: 0 },
    llmCall: async (input) => {
      if (input.messages[0]?.content.includes(ADMISSION_MERGE_QUALITY_GOLD_CORPUS[0]!.pair.pairKey)) {
        return { text: '', json: { judgements: admissionMergeQualityGoldJudgements() }, inputTokens: 100, outputTokens: 20 };
      }
      calls += 1;
      const keys = [...input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)].map((match) => match[1]!);
      assert.ok(keys.length > 0, 'real judge batch must contain candidate pairs');
      for (const key of keys) {
        assert.ok(expectedPairs.includes(key), `unexpected fixture candidate ${key}`);
        candidatePairs.add(key);
      }
      if (!changed) {
        changed = true;
        const target = { workspaceId: ws, harnessSlug: harness, ids: ['b'] };
        const before = (await readAdmissionMergeSnapshots(sql, target)).get('b');
        assert.ok(before, 'drift target must exist in the actual endpoint reader');
        const changedRows = await sql`
          UPDATE harness_shared.work_items
             SET payload = payload || '{"backgroundAcceptanceDrift":true}'::jsonb
           WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND feature_id = 'b'
          RETURNING feature_id, payload`;
        assert.equal(changedRows.length, 1);
        assert.equal(changedRows[0]!.payload.backgroundAcceptanceDrift, true);
        const after = (await readAdmissionMergeSnapshots(sql, target)).get('b');
        assert.ok(after);
        assert.notEqual(after.fingerprint, before.fingerprint, 'fixture drift must change canonical endpoint identity');
        process.stdout.write('BULK_BACKGROUND_DRIFT ' + JSON.stringify({ before: before.fingerprint, after: after.fingerprint }) + '\n');
      }
      return { text: '', json: { judgements: keys.map((pairKey) => ({ pairKey, verdict: 'r-finding-merge', reason: 'same failure and remedy' })) }, inputTokens: 100, outputTokens: 20 };
    },
    beforePostStageCensus: async () => {
      if (!interrupted) {
        interrupted = true;
        const sourceCensusRunId = `${root}-census-0`;
        // Freeze this read BEFORE the fresh recount overwrites mutable edges.
        // Count the initial pinned edges independently of the stage summary,
        // then retire only judgments committed by this stage.
        const [counts] = await sql`SELECT count(*)::int AS before,
          count(*) FILTER (WHERE d.a IS NULL)::int AS after,
          count(*) FILTER (WHERE d.run_id = ${`${root}-stage-1`})::int AS retired
          FROM harness_shared.dedup_edges e
          LEFT JOIN harness_shared.dedup_adjudications d
            ON d.workspace_id = e.workspace_id AND d.harness_slug = e.harness_slug
           AND d.a = e.a AND d.b = e.b
          WHERE e.workspace_id = ${ws} AND e.harness_slug = ${harness}
            AND e.run_id = ${sourceCensusRunId} AND e.cos >= 0.9
            AND EXISTS (SELECT 1 FROM harness_shared.dedup_shard_map m
              WHERE m.run_id = ${sourceCensusRunId} AND m.item_id = e.a AND m.role = 'member')
            AND EXISTS (SELECT 1 FROM harness_shared.dedup_shard_map m
              WHERE m.run_id = ${sourceCensusRunId} AND m.item_id = e.b AND m.role = 'member')`;
        assert.deepEqual(counts, { before: 2, after: 1, retired: 1 });
        pinnedRecompute = { sourceCensusRunId, before: counts!.before, after: counts!.after, retiredByStage: counts!.retired };
        throw new Error('background acceptance post-commit interruption');
      }
    },
  };
  await assert.rejects(runWorkItemAdmissionBulkDedup(opts), /background acceptance post-commit interruption/);
  assert.ok(calls > 0);
  assert.deepEqual([...candidatePairs].sort(), expectedPairs, 'actual judge population must match the fixture contract');
  const recovered = await runWorkItemAdmissionBulkDedup({
    ...opts, llmCall: async () => { throw new Error('receipt recovery must not call the model'); },
  });
  const rows = await sql`SELECT feature_id, status FROM harness_shared.work_items
                         WHERE workspace_id = ${ws} AND harness_slug = ${harness} ORDER BY feature_id`;
  const stage = recovered.stages[0]!;
  process.stdout.write('BULK_BACKGROUND_STAGE ' + JSON.stringify({
    candidatePairs: [...candidatePairs].sort(), pairs: stage.pairs, merged: stage.merged,
    guardRefusals: stage.guardRefusals, censusBefore: stage.censusBefore, censusAfter: stage.censusAfter,
    rows: rows.map((row) => [row.feature_id, row.status]), convergenceReason: recovered.convergenceReason,
  }) + '\n');
  assert.equal(recovered.converged, false);
  assert.equal(recovered.convergenceReason, 'stage-budget');
  assert.equal(stage.pairs, 2);
  assert.ok(pinnedRecompute);
  assert.equal(stage.censusAfter, pinnedRecompute.after);
  assert.equal(recovered.stages[0]!.merged, 1);
  assert.deepEqual(recovered.stages[0]!.guardRefusals?.map((row) => [row.itemId, row.reason]), [['b', 'snapshot-drift']]);
  assert.deepEqual(rows.map((row) => [row.feature_id, row.status]), [['a', 'open'], ['b', 'open'], ['c', 'open'], ['d', 'dropped']]);
  const digest = await runWorkItemAdmissionDailyDigest({
    workspaceId: ws, harnessSlug: harness, sql, runId: 'bulk-background-digest',
    llmCall: async () => ({ text: '', json: { umbrellas: [] }, inputTokens: 100, outputTokens: 20 }),
    fileUmbrella: async () => { throw new Error('empty digest should not file an umbrella'); },
    linkUmbrella: async () => { throw new Error('empty digest should not write umbrella links'); },
  });
  assert.equal(digest.status, 'complete');
  assert.equal(digest.sourceBulkStageRunId, `${root}-stage-1`);
  assert.equal(digest.sourceCensusRunId, recovered.stages[0]!.resultCensusRunId);
  assert.equal(digest.coverage?.live, 3);
  assert.equal(digest.coverage?.covered, 3);
  assert.equal(digest.coverage?.uncovered, 0);
  const [ledger] = await sql`SELECT detail->>'status' AS status, detail->'outcome' AS outcome,
                                   detail->'guardRefusals' AS refusals, detail#>'{mergeReceipt,guardRefusals}' AS receipt_refusals
                            FROM harness_shared.admission_runs WHERE id = ${`${root}-stage-1`}`;
  assert.equal(ledger!.status, 'complete');
  assert.equal(ledger!.outcome.successful, 1);
  assert.equal(ledger!.outcome.unchanged, 1);
  assert.deepEqual(ledger!.refusals, ledger!.receipt_refusals);

  // Rehearse the public lifecycle/link writers against the actual merged pair.
  // All state is in this disposable migrated DB; no live row is reopened.
  const [loserBefore] = await sql`SELECT payload, summary FROM harness_shared.work_items
    WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND feature_id = 'd'`;
  assert.equal(loserBefore!.payload.admissionMerge.canonicalId, 'c');
  assert.equal(loserBefore!.payload.admissionMerge.prior.takenBy, null,
    'the actual merge receipt must record that the loser was unclaimed at commit');
  assert.equal(loserBefore!.payload.admissionMerge.canonical.prior.takenBy, null,
    'the actual merge receipt must record that the survivor was unclaimed at commit');
  const [adjudicationBefore] = await sql`SELECT verdict, evidence->>'reason' AS reason, judged_by AS model
    FROM harness_shared.dedup_adjudications
    WHERE workspace_id = ${ws} AND harness_slug = ${harness}
      AND run_id = ${`${root}-stage-1`} AND a = 'c' AND b = 'd'`;
  assert.equal(adjudicationBefore!.verdict, 'r-finding-merge');
  assert.ok(adjudicationBefore!.reason);
  assert.ok(adjudicationBefore!.model);
  const duplicateLinksBefore = await sql`SELECT id FROM harness_shared.coord_links
    WHERE workspace_id = ${ws} AND src_ref = 'd' AND dst_ref = 'c' AND rel = 'duplicates'`;
  assert.equal(duplicateLinksBefore.length, 1, 'reversal must remove a real canonical duplicate link');
  const reversal = await runWithWorkspace(ws, async () => {
    const loser = await getWorkItem('d', harness);
    const survivor = await getWorkItem('c', harness);
    assert.ok(loser && survivor, 'canonical endpoint readers must resolve both synthetic rows');
    const reopened = await setWorkItemState('d', 'open', {
      harness, by: 'system:bulk-grade-reversal-rehearsal', force: true,
    });
    assert.ok(reopened);
    assert.equal(reopened.state, 'open');
    assert.deepEqual(await unlinkWorkItem('d', {
      kind: survivor.family === 'issue' ? 'issue' : 'feature', ref: 'c',
    }, 'duplicates', { harness }), { ok: true });
    const restored = await getWorkItem('d', harness);
    assert.equal(restored?.state, 'open');
    return { family: loser.family, state: restored!.state };
  });
  const [loserAfter] = await sql`SELECT payload, summary, taken_by FROM harness_shared.work_items
    WHERE workspace_id = ${ws} AND harness_slug = ${harness} AND feature_id = 'd'`;
  assert.equal(loserAfter!.summary, loserBefore!.summary);
  assert.deepEqual(loserAfter!.payload.gradeHistory, loserBefore!.payload.gradeHistory);
  assert.equal(loserAfter!.taken_by, null);
  const duplicateLinks = await sql`SELECT id FROM harness_shared.coord_links
    WHERE workspace_id = ${ws} AND src_ref = 'd' AND dst_ref = 'c' AND rel = 'duplicates'`;
  assert.equal(duplicateLinks.length, 0);
  const [adjudicationAfter] = await sql`SELECT verdict, evidence->>'reason' AS reason, judged_by AS model
    FROM harness_shared.dedup_adjudications
    WHERE workspace_id = ${ws} AND harness_slug = ${harness}
      AND run_id = ${`${root}-stage-1`} AND a = 'c' AND b = 'd'`;
  assert.deepEqual(adjudicationAfter, adjudicationBefore, 'reversal must preserve the immutable judgment trail');

  // Use the real routine workflow and its maintained action-factory seam.
  // Only the model and invalidation are deterministic substitutes; DBOS,
  // admission ledgers, merge writers, and serialized inputs remain real.
  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'papercusp-bulk-grade-test', systemDatabaseUrl: dsn,
    systemDatabaseSchemaName: 'dbos', applicationVersion: process.env.DBOS__APPVERSION,
    runAdminServer: false,
  });
  const { enqueueRoutineFire } = await import('../lib/dbos/routines-workflow');
  const { registerSystemAction } = await import('../lib/harness/routines/system-actions');
  const { makeWorkItemAdmissionBulkDedupAction, bulkDedupRuntimeWiring,
    BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS } = await import('../lib/harness/routines/work-item-admission-bulk-dedup-action');
  const fireRunId = 'bulk-grade-live-fire-rehearsal';
  const priorJudgedPairs = await sql`SELECT a, b FROM harness_shared.dedup_adjudications
    WHERE workspace_id = ${ws} AND harness_slug = ${harness} ORDER BY a, b`;
  assert.deepEqual(priorJudgedPairs.map((row) => `${row.a}::${row.b}`), ['c::d'],
    'reopened pair retains its prior adjudication and is excluded from fresh judging');
  const workerPairs = new Set<string>();
  let executions = 0;
  let releaseWorker!: () => void;
  const workerRelease = new Promise<void>((resolve) => { releaseWorker = resolve; });
  let enteredWorker!: () => void;
  const workerEntered = new Promise<void>((resolve) => { enteredWorker = resolve; });
  let enteredReplay!: () => void;
  const replayEntered = new Promise<void>((resolve) => { enteredReplay = resolve; });
  const phase = (name: string) => process.stdout.write(`BULK_BACKGROUND_WORKER_PHASE ${name}\n`);
  async function awaitEntry(promise: Promise<void>, name: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`private routine ${name} did not enter in 30s`)), 30_000);
      })]);
    } finally {
      clearTimeout(timer);
    }
  }
  const workerIds: string[] = [];
  registerSystemAction('work-item-admission-bulk-dedup', makeWorkItemAdmissionBulkDedupAction({
    run: async (ctx) => {
      executions += 1;
      assert.ok(ctx.workflowId);
      workerIds.push(ctx.workflowId);
      if (executions === 2) enteredReplay();
      phase(`entered:${executions}`);
      assert.equal(ctx.payloadTemplate?.runId, fireRunId);
      assert.equal(ctx.payloadTemplate?.maxStages, 1);
      assert.equal(ctx.payloadTemplate?.shardConcurrency, 1);
      await DBOS.runStep(async () => {
        enteredWorker();
        await workerRelease;
        return { released: true };
      }, { name: 'bulk-grade-worker-hold' });
      const wiring = bulkDedupRuntimeWiring(fireRunId, ctx.workflowId);
      // Retain the source runner's deterministic canary/preflight. Production
      // capacity/model calls are outside this disposable verification.
      return runWorkItemAdmissionBulkDedup({
        ...opts, runId: fireRunId, step: wiring.step, executionId: wiring.executionId,
        ownerId: wiring.ownerId, maxStages: 1, shardConcurrency: 1,
        llmCall: async (input) => {
          if (!input.messages[0]?.content.includes(ADMISSION_MERGE_QUALITY_GOLD_CORPUS[0]!.pair.pairKey)) {
            for (const match of input.messages[0]!.content.matchAll(/^([^\s]+::[^\s]+) \|/gm)) workerPairs.add(match[1]!);
          }
          return opts.llmCall!(input);
        },
      });
    },
    invalidate: async () => {}, log: () => {},
  }), { ownSteps: true, scheduling: 'on-demand', routineTimeoutMs: BULK_DEDUP_ROUTINE_FIRE_TIMEOUT_MS });
  phase('launching');
  await DBOS.launch();
  phase('launched');
  try {
  const firstEnqueue = await enqueueBulkDedupRun(sql, {
    workspaceId: ws, harnessSlug: harness, runId: fireRunId, controls: { maxStages: 1, shardConcurrency: 1 },
  });
  assert.equal(firstEnqueue.ok, true);
  assert.equal(firstEnqueue.enqueued, true);
  const routineId = firstEnqueue.routineId;
  const [originalRoutine] = await sql`SELECT payload_template FROM harness_shared.routines WHERE id = ${routineId}`;
  const [routine] = await sql`SELECT id, workspace_id AS "workspaceId", install_slug AS "installSlug",
    target_role AS "targetRole", trigger_config AS "triggerConfig", payload_template AS "payloadTemplate", name
    FROM harness_shared.routines WHERE id = ${routineId}`;
  assert.ok(routine);
  const fireInput = routine as Parameters<typeof enqueueRoutineFire>[0];
  assert.equal((await enqueueRoutineFire(fireInput)).status, 'enqueued');
  await awaitEntry(workerEntered, 'first worker');
  const workflowId = workerIds[0]!;
  const [liveWorkflow] = await sql`SELECT status, name, inputs FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`;
  assert.equal(liveWorkflow!.status, 'PENDING');
  assert.equal(liveWorkflow!.name, 'routineFire');
  assert.equal((await enqueueRoutineFire(fireInput)).status, 'deduplicated');
  const secondEnqueue = await enqueueBulkDedupRun(sql, {
    workspaceId: ws, harnessSlug: harness, runId: fireRunId, controls: { maxStages: 1, shardConcurrency: 1 },
  });
  const rearm = await enqueueBulkDedupRun(sql, {
    workspaceId: ws, harnessSlug: harness, runId: fireRunId, controls: { maxStages: 4, shardConcurrency: 3 },
  });
  for (const refusal of [secondEnqueue, rearm]) {
    assert.equal(refusal.ok, false);
    assert.equal(refusal.enqueued, false);
    assert.equal(refusal.alreadyRunning, true);
    assert.equal(refusal.reason, 'already_running');
    assert.equal(refusal.workflowUuid, workflowId);
  }
  const [retainedRoutine] = await sql`SELECT payload_template FROM harness_shared.routines WHERE id = ${routineId}`;
  assert.deepEqual(retainedRoutine!.payload_template, originalRoutine!.payload_template);
  const [retainedWorkflow] = await sql`SELECT inputs FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`;
  assert.equal(retainedWorkflow!.inputs, liveWorkflow!.inputs, 'live serialized input must remain immutable');
  assert.equal(executions, 1, 'duplicate dispatch must not enter another worker');
  releaseWorker();
  await DBOS.getResult(workflowId, 60);
  const [completedWorkflow] = await sql`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = ${workflowId}`;
  assert.equal(completedWorkflow!.status, 'SUCCESS');
  phase('first-success');
  const operationRows = await sql`SELECT function_name FROM dbos.operation_outputs
    WHERE workflow_uuid = ${workflowId} ORDER BY function_id`;
  const durableSteps = operationRows.map((row) => String(row.function_name));
  assert.ok(durableSteps.some((name) => name.startsWith(`bulk:${fireRunId}:`)), 'bulk phases must have real DBOS checkpoints');
  const [workerStage] = await sql`SELECT detail->>'status' AS status, detail->'outcome' AS outcome
    FROM harness_shared.admission_runs WHERE id = ${`${fireRunId}-stage-1`}`;
  assert.equal(workerStage!.status, 'complete');
  assert.deepEqual([...workerPairs], ['a::b']);
  assert.equal(workerStage!.outcome.successful, 1);
  const modelCallsBeforeRepeat = calls;
  const terminalRearm = await enqueueBulkDedupRun(sql, {
    workspaceId: ws, harnessSlug: harness, runId: fireRunId, controls: { maxStages: 1, shardConcurrency: 1 },
  });
  assert.equal(terminalRearm.enqueued, true);
  assert.equal((await enqueueRoutineFire(fireInput)).status, 'enqueued');
  await awaitEntry(replayEntered, 'terminal replay');
  const replayWorkflowId = workerIds[1]!;
  assert.notEqual(replayWorkflowId, workflowId);
  await DBOS.getResult(replayWorkflowId, 60);
  phase('replay-success');
  assert.equal(executions, 2);
  assert.equal(calls, modelCallsBeforeRepeat, 'completed bulk root must replay its admission receipt without model work');
  const [repeatedStage] = await sql`SELECT detail->>'status' AS status, detail->'outcome' AS outcome
    FROM harness_shared.admission_runs WHERE id = ${`${fireRunId}-stage-1`}`;
  assert.deepEqual(repeatedStage, workerStage, 'terminal rearm must not repeat merges');
  await sql`UPDATE harness_shared.routines SET active = false, next_fire_at = NULL WHERE id = ${routineId}`;
  process.stdout.write('BULK_BACKGROUND_RECEIPT ' + JSON.stringify({
    sourceHash, workspace: ws, home, runtimeRoot: dirname(home), pgPort: server!.port,
    runId: root, candidatePairs: [...candidatePairs].sort(), merged: recovered.stages[0]!.merged, driftRefusals: ledger!.refusals,
    convergenceReason: recovered.convergenceReason, digest: { status: digest.status, sourceCensusRunId: digest.sourceCensusRunId, coverage: digest.coverage },
    reversal: { ...reversal, historyPreserved: true, duplicateLinks: duplicateLinks.length, adjudicationPreserved: true },
    liveFire: { syntheticWorkflow: false, workflowId, secondEnqueue: secondEnqueue.reason, rearm: rearm.reason,
      controlsPreserved: true, serializedInputsPreserved: true, status: completedWorkflow!.status,
      executions, terminalReplayWithoutModel: true, merged: workerStage!.outcome.successful, durableSteps },
    pinnedRecompute,
    claimedComparison,
    auditedParkComparison,
  }) + '\n');
  } finally {
    releaseWorker();
    await DBOS.shutdown();
    phase('shutdown-complete');
  }
} finally {
  await sql.end({ timeout: 5 });
}
if (process.env.BULK_BG_INJECT_FAILURE === '1') {
  process.stderr.write('BULK_BACKGROUND_INJECT_FAILURE: verifying wrapper teardown on exit 23\n');
  process.exit(23);
}
process.exit(0);
