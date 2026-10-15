/** Native request journey. Only launched by the canonical disposable-runtime integration test. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { publishReport, getReport } from '../lib/report-library';
import { indexReport } from '../lib/search/report-index';
import { createReportSearchSource } from '../lib/agent-tools/search/report-source';
import { readProcessIdentity } from '../lib/process-identity';
import { buildPrivateOperatorApiBundle, privateBundleRuntimeEnv, waitForPrivateOperator } from './private-http-workspace-preflight';
import { buildMemoryContextBlock } from '../lib/memory/injection';
import { splitDocSections } from '../lib/search/doc-embed-sync';
import { runChunkSyncTick } from '../lib/search/chunks/tick';
import { PLANS_CHUNK_SURFACE } from '../lib/search/chunks/registry';
import { CORPUS_SOURCE_NAMES } from '../lib/memory/corpus-recall-io';

type SourceCall = { source: string; status: string; rows: number | null; reason: string | null };
type CorpusReceipt = { outcome: string; returned: number; admitted: number;
  stages: Array<{ lexical: { sourceCalls: SourceCall[] }; semantic: { sourceCalls: SourceCall[] } }> };

async function readCorpusReceipt(sql: ReturnType<typeof getOrgPg>['sql'], workspace: string,
  owner: string, surface: string, evidenceDir: string, filename: string, stalled = false,
  healthySources: readonly string[] = stalled ? ['doc', 'report'] : ['plan', 'doc', 'report']) {
  // The production writer deliberately runs asynchronously. Wait only for its
  // persisted row; keep the native request and preparation clocks unchanged.
  const deadline = Date.now() + 5_000;
  let receipt: { id: number; admission: { corpus?: CorpusReceipt } } | undefined;
  while (Date.now() < deadline && !receipt) {
    const rows = await sql`SELECT to_jsonb(r) AS receipt FROM harness_shared.memory_recall_stats r
      WHERE workspace_id = ${workspace} AND session_id = ${owner} AND surface = ${surface}
      ORDER BY id DESC LIMIT 1`;
    receipt = rows[0]?.receipt;
    if (!receipt) await new Promise(done => setTimeout(done, 25));
  }
  writeFileSync(join(evidenceDir, filename), JSON.stringify({ owner, surface, receipt }));
  assert.ok(receipt, `${surface} did not persist its execution receipt; see ${filename}`);
  const corpus = receipt.admission.corpus;
  assert.ok(corpus, `${surface} omitted completed corpus receipts; see ${filename}`);
  assert.equal(corpus.outcome, 'ok');
  assert.ok(corpus.returned > 0 && corpus.admitted > 0, 'delivered knowledge must have positive corpus counts');
  assert.ok(corpus.stages?.length > 0, 'every executed corpus cascade must retain its stages');
  for (const stage of corpus.stages) {
    for (const leg of [stage.lexical, stage.semantic]) {
      for (const source of CORPUS_SOURCE_NAMES) {
        const call = leg.sourceCalls?.find(call => call.source === source);
        assert.ok(call, `${surface} omitted ${source} execution/non-run receipt`);
        assert.ok(['ran', 'errored', 'timed-out', 'blocked', 'not-run'].includes(call.status));
        if (call.status === 'ran') assert.ok(typeof call.rows === 'number' && call.rows >= 0);
        else assert.ok(call.reason && call.rows === null, 'non-run/error receipts must retain their reason');
      }
    }
  }
  const lexical = corpus.stages.flatMap(stage => stage.lexical.sourceCalls);
  for (const source of healthySources) {
    assert.ok(lexical.some(call => call.source === source && call.status === 'ran' && call.rows! > 0),
      `${surface} lost the healthy ${source} source receipt`);
  }
  if (stalled) assert.ok(lexical.some(call => call.source === 'plan' && call.status === 'timed-out'),
    `${surface} must distinguish the locked plan source from a healthy empty result`);
  return receipt.id;
}

let host: ChildProcess | undefined;
let hostIdentity: ReturnType<typeof readProcessIdentity>;
async function stopHost() {
  if (!host) return;
  if (host.exitCode === null && host.signalCode === null) {
    const closed = new Promise<void>(done => host!.once('close', () => done()));
    host.kill('SIGTERM');
    const timer = setTimeout(() => host?.kill('SIGKILL'), 5_000);
    await closed;
    clearTimeout(timer);
  }
  assert.notEqual(readProcessIdentity(host.pid!), hostIdentity, 'owned private host survived cleanup');
}

async function main() {
  const e = process.env;
  const workspace = e.PAPERCUSP_WORKSPACE_ID!;
  assert.match(workspace, /^test-runtime-/);
  assert.equal(e.PAPERCUSP_POT_HOME_SLUG, workspace);
  assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '0');
  assert.equal(e.PAPERCUSP_DBOS_ENABLE, '0');
  assert.equal(e.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
  assert.notEqual(e.PAPERCUSP_PG_PORT, '5432');
  const base = e.PAPERCUSP_OPERATOR_URL!;
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(![3070, 3170, 3271, 3278].includes(Number(new URL(base).port)));
  const root = resolve(import.meta.dirname, '../../..');
  const evidenceDir = e.KNOWLEDGE_NATIVE_EVIDENCE_DIR!;
  assert.ok(evidenceDir);
  const { sql } = getOrgPg();
  try {
    const owner = 'su-private-knowledge-reader';
    const stalledOwner = 'su-private-knowledge-stalled-reader';
    const reports: Awaited<ReturnType<typeof publishReport>>[] = [];
    const knowledge = [];
    for (const token of ['zephyrquartz', 'cobaltquartz', 'amberquartz', 'jadequartz']) {
      // Each owner-private positive control belongs to the reader whose native
      // request will exercise it, including the separate stalled-source reader.
      const reportOwner = token === 'amberquartz' || token === 'jadequartz' ? stalledOwner : owner;
      const report = await publishReport(sql, { workspaceId: workspace, visibility: 'owner',
        title: 'Dated diagnostic evidence', bodyMd: 'Ordinary observations.\n'.repeat(600)
          + `\n## Diagnostic recovery\n${token} diagnostic snapshot recovery evidence. Retain the snapshot before restarting the diagnostic worker.` },
      { authorOwnerId: reportOwner, harnessSlug: workspace });
      // This journey measures lexical native delivery; real vector/profile behavior
      // is separately covered by the migrated-PG source tests. No fake embedder.
      await indexReport(sql, report, null);
      const stored = await getReport(sql, workspace, report.reportId, { ownerId: reportOwner });
      assert.ok(stored?.bodyMd.includes(token), 'canonical report readback must retain the full tail');
      const otherOwner = reportOwner === owner ? stalledOwner : owner;
      assert.equal(await getReport(sql, workspace, report.reportId, { ownerId: otherOwner }), null,
        'owner-private positive controls must deny the other native reader');
      reports.push(report);
      const planSlug = `native-${token}-plan`;
      const docSlug = `native-${token}-procedure`;
      await sql`INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,title,content,status)
        VALUES (${workspace},${workspace},${planSlug},'Diagnostic plan',
          ${'Ordinary background.\n'.repeat(600) + '\n## Diagnostic recovery\nPrerequisite: retain the snapshot.\n'
            + token + ' diagnostic snapshot recovery evidence.'},'active')`;
      const docBody = '## Preparation\nPrerequisite: retain the snapshot.\n\n## Diagnostic recovery\n'
        + token + ' diagnostic snapshot recovery evidence. Apply the maintained procedure.';
      for (const [idx, section] of splitDocSections('Diagnostic procedure', docBody).entries()) {
        await sql`INSERT INTO harness_shared.doc_sections
          (source_key,slug,anchor,title,url,content,page_sha,section_idx)
          VALUES (${`harness:${workspace}`},${docSlug},${section.anchor},${section.title},
            ${`/docs/${docSlug}`},${section.content},'native-fixture',${idx})`;
      }
      knowledge.push({ planSlug, docSlug });
    }
    await runChunkSyncTick({ sql, surfaces: [{ ...PLANS_CHUNK_SURFACE,
      eligibleSql: `p.workspace_id = '${workspace}'` }] });
    const source = createReportSearchSource({ ownerId: owner, potSlug: workspace },
      { harnessSlugs: [workspace], automatic: true });
    const lexical = async (query: string) => source.lexical!({ sql, workspaceId: workspace,
      scopeFilter: null, limit: 20, query });
    const unique = await lexical('zephyrquartz');
    const control = await lexical('zephyrquartz diagnostic snapshot recovery evidence');
    const shared = await lexical('diagnostic snapshot recovery evidence');
    const privateControl = await lexical('amberquartz');
    const visibleIds = reports.slice(0, 2).map(report => report.reportId);
    writeFileSync(join(evidenceDir, 'lexical-source-control.json'), JSON.stringify({
      owner, visibleIds, deniedIds: reports.slice(2).map(report => report.reportId),
      unique, control, shared, privateControl,
    }));
    // The unique token calibrates exact retrieval independently of the selected
    // lexical engine. BM25 may also match the sibling report's shared words.
    assert.deepEqual(unique.map(hit => hit.row.source_id), [reports[0].reportId],
      'unique fixture token must reach only its report; see lexical-source-control.json');
    assert.ok(control.some(hit => hit.row.source_id === reports[0].reportId),
      'known fixture must reach the real search source; see lexical-source-control.json');
    assert.ok(control.every(hit => visibleIds.includes(hit.row.source_id)),
      'any-term matches must remain reader-visible; see lexical-source-control.json');
    assert.deepEqual(shared.map(hit => hit.row.source_id).sort(), [...visibleIds].sort(),
      'shared terms must retrieve both reader-visible reports and deny the other reader');
    assert.deepEqual(privateControl, [], 'the other reader\'s unique token must remain private');
    const warmReport = await publishReport(sql, { workspaceId: workspace, visibility: 'workspace',
      title: 'Warm corpus control', bodyMd: 'warmquartz diagnostic snapshot recovery evidence. Retain the snapshot.' },
    { authorOwnerId: 'su-private-knowledge-warmup', harnessSlug: workspace });
    await indexReport(sql, warmReport, null);
    // Calibrate the readiness oracle independently of corpus selection. Retain
    // both source hits and selection drops before the expensive native journey,
    // so a missing Report cannot be mistaken for a publication or privacy fault.
    const warmQuery = 'warmquartz diagnostic snapshot recovery evidence';
    const warmSource = createReportSearchSource({}, { harnessSlugs: [workspace], automatic: true });
    const warmUnique = await warmSource.lexical!({ sql, workspaceId: workspace,
      scopeFilter: null, limit: 20, query: 'warmquartz' });
    const warmBroad = await warmSource.lexical!({ sql, workspaceId: workspace,
      scopeFilter: null, limit: 20, query: warmQuery });
    writeFileSync(join(evidenceDir, 'warm-lexical-source-control.json'), JSON.stringify({
      query: warmQuery, reportId: warmReport.reportId, unique: warmUnique, broad: warmBroad,
    }));
    assert.deepEqual(warmUnique.map(hit => hit.row.source_id), [warmReport.reportId],
      'workspace warm-up Report must be query-ready; see warm-lexical-source-control.json');
    assert.ok(warmBroad.some(hit => hit.row.source_id === warmReport.reportId),
      'workspace warm-up Report must reach broad source search; see warm-lexical-source-control.json');
    const { recallCorpusContext } = await import('../lib/memory/corpus-recall-io');
    const warmCorpus = await recallCorpusContext({ workspaceId: workspace, harnessSlugs: [workspace],
      queryText: warmQuery, excludeOwnerId: 'su-private-source-selection-control' });
    writeFileSync(join(evidenceDir, 'warm-corpus-control.json'), JSON.stringify({
      query: warmQuery, reportId: warmReport.reportId, corpus: warmCorpus,
    }));
    const sourceBlock = await buildMemoryContextBlock({ workspaceId: workspace, harnessSlugs: [workspace],
      userId: null, queryContext: warmQuery,
      session: { sessionId: 'su-private-source-control', port: 'turn-start', client: 'codex' } });
    writeFileSync(join(evidenceDir, 'source-control.json'), JSON.stringify({ payload: sourceBlock }));
    // This receipt belongs to the normal builder above. A standalone corpus
    // diagnostic uses a different query execution and cannot explain its result.
    await readCorpusReceipt(sql, workspace, 'su-private-source-control', 'turn-start',
      evidenceDir, 'source-control-receipt.json', false, ['report']);
    assert.ok(sourceBlock?.includes(warmReport.reportId),
      'source memory builder failed known corpus control; see source-control.json and source-control-receipt.json');
    const knowledgeBlock = await buildMemoryContextBlock({ workspaceId: workspace, harnessSlugs: [workspace],
      userId: null, queryContext: 'zephyrquartz diagnostic snapshot recovery evidence',
      session: { sessionId: 'su-private-knowledge-source-control', port: 'turn-start', client: 'codex' } });
    writeFileSync(join(evidenceDir, 'knowledge-source-control.json'), JSON.stringify({ payload: knowledgeBlock }));
    assert.ok(knowledgeBlock, 'canonical knowledge source control is empty; see knowledge-source-control.json');
    assert.ok(knowledgeBlock.includes(knowledge[0].planSlug), 'canonical plan is not query-ready; see knowledge-source-control.json');
    assert.ok(knowledgeBlock.includes(knowledge[0].docSlug), 'canonical procedure is not query-ready; see knowledge-source-control.json');
    if (e.KNOWLEDGE_NATIVE_SOURCE_ONLY === '1') {
      console.log('KNOWLEDGE_NATIVE_SOURCE_READY ' + JSON.stringify({ workspace, reportId: warmReport.reportId }));
      return;
    }
    // The native route also requires the maintained shared-resource store.
    // A fresh private cluster has no su database; finish that bootstrap before
    // paying the host bundle or starting the unchanged native response clock.
    const { withOptionalMemoryAdmission } = await import('../lib/memory/mid-turn-admission');
    const admitted = await withOptionalMemoryAdmission(async () =>
      buildMemoryContextBlock({ workspaceId: workspace, harnessSlugs: [workspace],
        userId: null, queryContext: 'warmquartz diagnostic snapshot recovery evidence',
        session: { sessionId: 'su-private-admission-control', port: 'turn-start', client: 'codex' } }));
    writeFileSync(join(evidenceDir, 'admission-control.json'), JSON.stringify(admitted));
    assert.ok(admitted.admitted, 'private optional-memory resource store is not ready; see admission-control.json');
    assert.ok(admitted.value?.includes(warmReport.reportId),
      'admitted production builder failed corpus control; see admission-control.json');
    console.log('KNOWLEDGE_NATIVE_PHASE fixtures-ready');
    const bundle = join(evidenceDir, 'hono-host.mjs');
    console.log('KNOWLEDGE_NATIVE_PHASE bundle-start');
    try {
      await buildPrivateOperatorApiBundle(root, evidenceDir, { timeoutMs: 240_000, maxMs: 420_000 });
    } finally {
      writeFileSync(join(evidenceDir, 'build.log'), readFileSync(join(evidenceDir, 'operator-api-build.log')));
    }
    const bundleSha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    const hostEnv = privateBundleRuntimeEnv(e);
    host = spawn(process.execPath, [bundle], { cwd: root, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout!.on('data', chunk => process.stdout.write(chunk));
    host.stderr!.on('data', chunk => process.stderr.write(chunk));
    hostIdentity = readProcessIdentity(host.pid!);
    assert.ok(hostIdentity);
    await waitForPrivateOperator({ host, base, evidenceDir, hostIdentity, environment: hostEnv });
    console.log('KNOWLEDGE_NATIVE_PHASE host-ready');
    // Import the real native adapter and transport, preserving their actual walls.
    // @ts-ignore -- maintained native hook transport is a JavaScript module.
    const core = await import('../../../apps/operator/scripts/hooks/inject/core.mjs');
    // @ts-ignore -- maintained native Codex adapter is a JavaScript module.
    const adapter = await import('../../../apps/operator/scripts/hooks/inject/adapters/codex.mjs');
    // Readiness is measured through the real port and its unchanged wall. Use a
    // separate owner so warming never consumes the reader's epoch/dedup state.
    const warmups = [];
    let ready = false;
    for (let attempt = 0; attempt < 6 && !ready; attempt++) {
      const began = Date.now();
      const progress: unknown[] = [];
      let sampling = true;
      const sample = (async () => {
        while (sampling) {
          const rows = await sql`SELECT pid, state, wait_event_type, wait_event,
            left(query, 500) AS query, extract(epoch FROM (clock_timestamp() - query_start)) AS query_age_sec
            FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
          progress.push({ elapsedMs: Date.now() - began, rows });
          await new Promise(done => setTimeout(done, 200));
        }
      })();
      const responses: unknown[] = [];
      const payload = await core.runInjection({ adapter, nativeEvent: 'UserPromptSubmit',
        event: { prompt: 'warmquartz diagnostic snapshot recovery evidence', cwd: e.HOME },
        env: { ...e, PAPERCUSP_SID: 'su-private-knowledge-warmup', PAPERCUSP_HARNESS_SLUG: workspace },
        fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
          const response = await fetch(url, init);
          responses.push({ url: String(url), status: response.status,
            elapsedMs: Date.now() - began, body: await response.clone().text() });
          return response;
        } });
      sampling = false;
      await sample;
      ready = Boolean(payload?.includes(warmReport.reportId));
      warmups.push({ attempt, durationMs: Date.now() - began, ready, payload, responses, progress });
      writeFileSync(join(evidenceDir, 'warmup.json'), JSON.stringify(warmups));
      if (!ready) await new Promise(done => setTimeout(done, 250));
    }
    assert.ok(ready, 'actual native knowledge port never met its warm readiness precondition; see warmup.json');
    console.log('KNOWLEDGE_NATIVE_PHASE knowledge-ready');
    const requests: Array<{ url: string; status: number }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      requests.push({ url: String(url), status: response.status });
      return response;
    };
    const env = { ...e, PAPERCUSP_SID: owner, PAPERCUSP_HARNESS_SLUG: workspace };
    const turnStart = await core.runInjection({ adapter, nativeEvent: 'UserPromptSubmit',
      event: { prompt: 'zephyrquartz diagnostic snapshot recovery evidence', cwd: e.HOME }, env, fetchImpl });
    writeFileSync(join(evidenceDir, 'turn-start.json'), JSON.stringify({ requests, payload: turnStart }));
    assert.ok(turnStart?.includes(reports[0].reportId), 'native turn-start omitted the report reference');
    assert.ok(turnStart.includes(knowledge[0].planSlug), 'native turn-start omitted the plan reference');
    assert.ok(turnStart.includes(knowledge[0].docSlug), 'native turn-start omitted the maintained procedure reference');
    assert.ok(turnStart.includes('Retain the snapshot'), 'native turn-start omitted the matching tail excerpt');
    assert.equal(JSON.parse(turnStart).hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const turnStartReceipt = await readCorpusReceipt(sql, workspace, owner, 'turn-start', evidenceDir, 'turn-start-receipt.json');
    console.log('KNOWLEDGE_NATIVE_PHASE turn-start-delivered');
    const midTurn = await core.runInjection({ adapter, nativeEvent: 'PostToolUse',
      event: { tool_name: 'exec_command', tool_input: { cmd: 'rg cobaltquartz diagnostic snapshot recovery evidence' },
        tool_response: 'Investigating diagnostic snapshot recovery evidence', cwd: e.HOME }, env, fetchImpl });
    writeFileSync(join(evidenceDir, 'mid-turn.json'), JSON.stringify({ requests, payload: midTurn }));
    assert.ok(midTurn?.includes(reports[1].reportId), 'native mid-turn omitted novel report reference');
    assert.ok(midTurn.includes(knowledge[1].planSlug), 'native mid-turn omitted the novel plan reference');
    assert.ok(midTurn.includes(knowledge[1].docSlug), 'native mid-turn omitted the novel maintained procedure reference');
    assert.ok(midTurn.includes('Retain the snapshot'), 'native mid-turn omitted matching tail excerpt');
    assert.ok(!midTurn.includes(reports[0].reportId), 'native mid-turn repeated the paid turn-start reference');
    assert.ok(!midTurn.includes(knowledge[0].planSlug), 'native mid-turn repeated the paid plan reference');
    assert.ok(!midTurn.includes(knowledge[0].docSlug), 'native mid-turn repeated the paid procedure reference');
    assert.equal(JSON.parse(midTurn).hookSpecificOutput.hookEventName, 'PostToolUse');
    const midTurnReceipt = await readCorpusReceipt(sql, workspace, owner, 'mid-turn', evidenceDir, 'mid-turn-receipt.json');
    // A real private-PG lock stalls only the plan source. Use a dedicated
    // transaction so the observer and healthy sibling sources remain runnable.
    const lock = await sql.reserve();
    const stalledEnv = { ...env, PAPERCUSP_SID: stalledOwner };
    const stalledReceipts: number[] = [];
    try {
      await lock`BEGIN`;
      await lock`SET LOCAL lock_timeout = '1s'`;
      await lock`LOCK TABLE harness_shared.harness_plans IN ACCESS EXCLUSIVE MODE`;
      const lockEvidence = await lock`SELECT pid, mode, granted FROM pg_locks
        WHERE pid = pg_backend_pid() AND relation = 'harness_shared.harness_plans'::regclass
          AND mode = 'AccessExclusiveLock'`;
      assert.equal(lockEvidence[0]?.granted, true);
      writeFileSync(join(evidenceDir, 'plan-lock.json'), JSON.stringify(lockEvidence));
      for (const [index, nativeEvent, surface] of [[2, 'UserPromptSubmit', 'turn-start'],
        [3, 'PostToolUse', 'mid-turn']] as const) {
        const token = index === 2 ? 'amberquartz' : 'jadequartz';
        const began = Date.now();
        // Preserve the blocked phase on failed acceptance too. The native
        // wall still measures only runInjection; observer teardown is outside it.
        const progress: unknown[] = [];
        let sampling = true;
        const sample = (async () => {
          while (sampling) {
            try {
              const rows = await sql`SELECT pid, state, wait_event_type, wait_event,
                left(query, 500) AS query, extract(epoch FROM (clock_timestamp() - query_start)) AS query_age_sec
                FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`;
              progress.push({ elapsedMs: Date.now() - began, rows });
            } catch (error: any) { progress.push({ elapsedMs: Date.now() - began, error: error.message }); }
            await new Promise(done => setTimeout(done, 200));
          }
        })();
        let payload: string | null;
        let durationMs: number;
        try {
          payload = await core.runInjection({ adapter, nativeEvent,
            event: nativeEvent === 'UserPromptSubmit'
              ? { prompt: `${token} diagnostic snapshot recovery evidence`, cwd: e.HOME }
              : { tool_name: 'exec_command', tool_input: { cmd: `rg ${token} diagnostic snapshot recovery evidence` },
                tool_response: 'Investigating diagnostic snapshot recovery evidence', cwd: e.HOME },
            env: stalledEnv, fetchImpl });
          durationMs = Date.now() - began;
        } finally { sampling = false; await sample; }
        writeFileSync(join(evidenceDir, `stalled-${surface}.json`),
          JSON.stringify({ requests, payload, durationMs, progress }));
        // Read and persist the exact receipt before any delivery assertion can
        // fail. A later turn no longer has to reconstruct it from teardown rows.
        stalledReceipts.push(await readCorpusReceipt(sql, workspace, stalledOwner, surface,
          evidenceDir, `stalled-${surface}-receipt.json`, true));
        if (payload == null) assert.fail(`${surface} lost healthy procedure while plans stalled (no payload)`);
        assert.ok(payload.includes(knowledge[index].docSlug), `${surface} lost healthy procedure while plans stalled`);
        assert.ok(payload.includes(reports[index].reportId), `${surface} lost healthy report while plans stalled`);
        assert.ok(!payload.includes(knowledge[index].planSlug), 'locked plan must not masquerade as delivered');
        assert.equal(JSON.parse(payload).hookSpecificOutput.hookEventName, nativeEvent);
      }
    } finally {
      await lock`ROLLBACK`;
      lock.release();
    }
    console.log('KNOWLEDGE_NATIVE_PHASE stalled-source-verified');
    await stopHost();
    console.log('KNOWLEDGE_NATIVE_RECEIPT ' + JSON.stringify({ workspace, requests, reportIds: reports.map(r => r.reportId),
      knowledge, corpusReceiptIds: [turnStartReceipt, midTurnReceipt], stalledReceiptIds: stalledReceipts,
      stalledSource: 'plan', healthySourcesRetained: ['doc', 'report'],
      nativeClient: 'codex', turnStart: true, midTurn: true, hostPid: host.pid, hostStopped: true, bundleSha256 }));
  } finally {
    // Capture original pipeline receipts before private data is disposed.
    try {
      const rows = await sql`SELECT to_jsonb(r) AS receipt FROM harness_shared.memory_recall_stats r
        WHERE workspace_id = ${workspace} ORDER BY created_at DESC LIMIT 12`;
      writeFileSync(join(evidenceDir, 'recall-receipts.json'), JSON.stringify(rows));
    } catch (error: any) {
      writeFileSync(join(evidenceDir, 'recall-receipts.json'), JSON.stringify({ captureError: error.message }));
    }
    await stopHost(); await sql.end();
  }
}
if (process.argv.includes('--import-preflight')) {
  // Static imports have now resolved using Node's actual package exports.
  // Keep this branch free of getOrgPg(), host startup and fixture writes.
  console.info('KNOWLEDGE_NATIVE_IMPORTS_OK');
} else {
  main().catch(error => {
    console.error('KNOWLEDGE_NATIVE_FAILURE ' + JSON.stringify({ message: error.message, stack: error.stack }));
    process.exitCode = 1;
  });
}
