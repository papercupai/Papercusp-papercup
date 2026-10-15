/** Isolated child for list-result-door-background.integration.test.ts. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName, readJsonResult } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { applyResultDoorAsync } from '../lib/result-door';
import { safeScratchFilesystemPath } from '../lib/scratch-uri';
import { parseScratchReference } from '../lib/scratch-reference';
import { readProcessIdentity } from '../lib/process-identity';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const workspaceId = process.env.PAPERCUSP_WORKSPACE_ID!;
const dsn = process.env.HARNESS_ADMIN_DATABASE_URL!;
const pgPort = process.env.PAPERCUSP_PG_PORT!;
const runtimeRoot = dirname(process.env.HOME!);
const scratchRoot = join(process.env.HOME!, '.papercusp', 'scratch');
process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;

assert.ok(workspaceId.startsWith('test-runtime-'));
assert.equal(process.env.PAPERCUSP_SKIP_PG_DISCOVERY, '1');
assert.equal(process.env.PAPERCUSP_DBOS_ROUTINES, '0');
assert.ok(dsn);
assert.equal(new URL(dsn).port, pgPort);
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_TOKEN']) {
  assert.equal(process.env[key], undefined, key + ' must not enter the private runtime');
}

const expectedSourceHashes = JSON.parse(process.env.SCORECARDS_EXPECTED_SOURCE_HASHES!) as Record<string, string>;
const sourceHashes = Object.fromEntries(Object.entries(expectedSourceHashes).map(([path, expected]) => {
  const actual = createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
  assert.equal(actual, expected, 'source changed between parent snapshot and isolated child: ' + path);
  return [path, actual];
}));
const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const listSourceSha = sourceHashes['packages/operator-core/lib/agent-tools/scorecards/list.ts'];
assert.ok(listSourceSha);

const sql = postgres(dsn, { max: 4, prepare: false, onnotice: () => {} });
const rubricRef = 'scorecards-list-result-door-isolated';
const sourceHive = 'scorecards-list-result-door-isolated';
const rowCount = 100;
const evidenceChars = 2_000;
const args = { rubricRef, sourceHive, limit: rowCount, detail: 'full' as const, payloadTier: 'full' as const };
const targetRunId = randomUUID();
const outerRunId = randomUUID();
const context = {
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
  workspaceId,
  runId: targetRunId,
  isSuperuser: true,
  uiClientId: 'su-scorecards-list-isolated-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  cwd: root,
  baseDir: root,
  tx: {},
};

// This scenario must reach the result door with >100 KB of raw text. The
// explicit full override bypasses tooldef's separate 30k hard ceiling; the
// per-session opt-out alone does not bypass that ceiling.
assert.equal(args.payloadTier, 'full');
assert.ok(Buffer.byteLength('e'.repeat(evidenceChars), 'utf8') * rowCount > 100_000);

async function run() {
  try {
    const [server] = await sql`SELECT inet_server_port() AS port, current_database() AS database`;
    assert.equal(String(server!.port), pgPort);
    assert.equal(String(new URL(dsn).port), String(server!.port));

    await sql`
      INSERT INTO harness_shared.engineer_issues
        (workspace_id, issue_id, kind, scope, title, body, severity, source,
         state, payload, created_by, signal_origin, created_at, updated_at)
      SELECT ${workspaceId},
             'EI-sclrd-' || lpad(n::text, 4, '0'),
             'change',
             'harness:papercusp',
             'scorecards result-door fixture ' || n,
             '',
             'minor',
            'test',
            'done',
            jsonb_build_object('observation', jsonb_build_object(
              'rubricRef', ${rubricRef}::text,
              'sourceHive', ${sourceHive}::text,
              'subject', jsonb_build_object('kind', 'agent-run', 'ref', ${sourceHive}::text),
               'ratings', jsonb_build_object('history-integrity', jsonb_build_object(
                 'rating', 'healthy', 'evidence', repeat('e', ${evidenceChars})
               ))
             )),
             'su-test',
             'organic',
             now() - (n * interval '1 second'),
             now()
        FROM generate_series(1, ${rowCount}) AS fixture(n)`;

    const [storedEvidenceRow] = await sql`
      SELECT count(*)::int AS row_count,
             min(length(payload #>> '{observation,ratings,history-integrity,evidence}'))::int AS min_chars,
             max(length(payload #>> '{observation,ratings,history-integrity,evidence}'))::int AS max_chars,
             sum(length(payload #>> '{observation,ratings,history-integrity,evidence}'))::int AS total_chars
        FROM harness_shared.engineer_issues
       WHERE workspace_id = ${workspaceId}
         AND issue_id LIKE 'EI-sclrd-%'`;
    const storedEvidence = {
      rows: Number(storedEvidenceRow!.row_count),
      minChars: Number(storedEvidenceRow!.min_chars),
      maxChars: Number(storedEvidenceRow!.max_chars),
      totalChars: Number(storedEvidenceRow!.total_chars),
    };
    assert.deepEqual(storedEvidence, {
      rows: rowCount,
      minChars: evidenceChars,
      maxChars: evidenceChars,
      totalChars: rowCount * evidenceChars,
    });

    const listTool = (await import('../lib/agent-tools/scorecards/list')).default;
    assert.equal(listTool.name, 'scorecards:list');
    const projected = lookupByMcpName('scorecards:list');
    assert.ok(projected);

    const listStartedAt = performance.now();
    const target = await dispatchProjectedTool(projected!, 'scorecards:list', args, context as never, {});
    const listElapsedMs = performance.now() - listStartedAt;
    assert.equal(target.ok, true, JSON.stringify(target));
    assert.ok(target.result);
    const targetText = target.result.content.find((item) =>
      (item as { type?: unknown }).type === 'text',
    ) as { text: string } | undefined;
    assert.ok(targetText?.text);
    const targetBytes = Buffer.byteLength(targetText!.text, 'utf8');
    const targetBody = readJsonResult<{
      ok: boolean;
      count: number;
      hasMore: boolean;
      scorecards: Array<{ issueId: string; ratings: Record<string, { evidence: string }> }>;
    }>(target.result);
    assert.equal(targetBody?.ok, true);
    assert.equal(targetBody?.count, rowCount);
    assert.equal(targetBody?.hasMore, false);
    assert.equal(targetBody?.scorecards.length, rowCount);
    assert.equal(targetBody?.scorecards[0]?.issueId, 'EI-sclrd-0001');
    assert.equal(targetBody?.scorecards.at(-1)?.issueId, 'EI-sclrd-0100');
    const returnedEvidenceLengths = targetBody!.scorecards.map((row) => {
      const evidence = row.ratings['history-integrity']?.evidence;
      return typeof evidence === 'string' ? Buffer.byteLength(evidence, 'utf8') : 0;
    });
    const returnedEvidence = {
      rows: returnedEvidenceLengths.filter((length) => length > 0).length,
      minBytes: Math.min(...returnedEvidenceLengths),
      maxBytes: Math.max(...returnedEvidenceLengths),
      totalBytes: returnedEvidenceLengths.reduce((sum, length) => sum + length, 0),
    };

    const invokeTool = (await import('../lib/agent-tools/tools/invoke')).default;
    let nestedDispatches = 0;
    const invokeStartedAt = performance.now();
    const invoked = await invokeTool.handler(
      { name: 'scorecards:list', args } as never,
      {
        dispatchTool: async (name: string, receivedArgs: Record<string, unknown>) => {
          nestedDispatches += 1;
          assert.equal(name, 'scorecards:list');
          assert.deepEqual(receivedArgs, args);
          return target.result!;
        },
      } as never,
    ) as {
      content: Array<{ type?: string; text?: string }>;
      _meta?: Record<string, unknown>;
      structuredContent?: unknown;
    };
    const invokeElapsedMs = performance.now() - invokeStartedAt;
    assert.equal(nestedDispatches, 1);
    assert.equal(invoked.content[0]?.text, targetText!.text);

    let lateSettlement: unknown;
    let resolveLateSettlement!: (value: unknown) => void;
    const lateSettlementPromise = new Promise<unknown>((resolvePromise) => {
      resolveLateSettlement = resolvePromise;
    });
    const scratchTimings: unknown[] = [];
    const doorStartedAt = performance.now();
    const doored = await applyResultDoorAsync(invoked, {
      toolName: 'tools:invoke',
      nestedTargetToolName: 'scorecards:list',
      workspaceId,
      runId: outerRunId,
      onLateScratchWriteSettled: (settlement) => {
        lateSettlement = settlement;
        resolveLateSettlement(settlement);
      },
      onScratchWriteTiming: (timings) => { scratchTimings.push(timings); },
    });
    const doorElapsedMs = performance.now() - doorStartedAt;
    const doorMeta = (doored._meta?.resultDoor ?? {}) as Record<string, unknown>;
    const spillUri = doorMeta.spillUri;
    const spillPath = typeof spillUri === 'string' ? safeScratchFilesystemPath(spillUri) : null;
    assert.equal(doorMeta.truncated, true);
    assert.equal(doorMeta.spillFailed, false, JSON.stringify(doorMeta));
    assert.equal(typeof spillUri, 'string');
    assert.equal(typeof spillPath, 'string');

    if (!existsSync(spillPath!)) {
      await Promise.race([
        lateSettlementPromise,
        new Promise((_, reject) => setTimeout(() => reject(
          new Error('result-door late spill did not settle within the isolated proof budget'),
        ), 360_000)),
      ]);
    }
    assert.ok(existsSync(spillPath!));

    const spillFile = readFileSync(spillPath!);
    const parsed = parseScratchReference(spillFile);
    assert.ok(parsed);
    assert.equal(parsed.manifest.workspaceId, workspaceId);
    assert.equal(parsed.manifest.mediaType, 'application/json');
    assert.equal(parsed.payload.length, parsed.manifest.byteCount);
    const bodyOffset = parsed.manifest.bodyOffsetInPayload;
    assert.ok(Number.isSafeInteger(bodyOffset));
    const recoveredText = parsed.payload.subarray(bodyOffset!).toString('utf8');
    const recoveredEnvelope = JSON.parse(recoveredText) as {
      content: Array<{ type?: string; text?: string }>;
    };
    assert.ok(Array.isArray(recoveredEnvelope.content));
    const recoveredContent = recoveredEnvelope.content.find((item) => item.type === 'text');
    assert.ok(recoveredContent?.text);
    assert.equal(recoveredContent.text, targetText!.text);
    const recovered = JSON.parse(recoveredContent.text) as typeof targetBody;
    assert.equal(recovered.count, rowCount);
    assert.equal(recovered.scorecards.length, rowCount);
    assert.equal(recovered.scorecards[0]?.issueId, 'EI-sclrd-0001');
    assert.equal(recovered.scorecards.at(-1)?.issueId, 'EI-sclrd-0100');
    const payloadSha256 = createHash('sha256').update(parsed.payload).digest('hex');
    assert.equal(payloadSha256, parsed.manifest.sha256);

    const receipt = {
      schemaVersion: 1,
      runId: targetRunId,
      build: { sourceCommit, listSourceSha, sourceHashes, node: process.version },
      runtime: {
        host: hostname(),
        pid: process.pid,
        processIdentity: readProcessIdentity(process.pid),
        runtimeRoot,
        workspaceId,
        pgPort: String(server!.port),
        database: String(server!.database),
        privateScratchRoot: scratchRoot,
        credentialsStripped: true,
      },
      list: {
        args,
        rowCount: targetBody.scorecards.length,
        outputBytes: targetBytes,
        storedEvidence,
        returnedEvidence,
        elapsedMs: listElapsedMs,
      },
      invoke: { nestedDispatches, outputBytes: Buffer.byteLength(invoked.content[0]?.text ?? '', 'utf8'), elapsedMs: invokeElapsedMs },
      resultDoor: {
        elapsedMs: doorElapsedMs,
        truncated: doorMeta.truncated,
        spillFailed: doorMeta.spillFailed,
        upstreamProjected: doorMeta.upstreamProjected ?? false,
        spillUri,
        manifest: { byteCount: parsed.manifest.byteCount, sha256: parsed.manifest.sha256 },
        readbackIntegrity: 'verified',
        readback: {
          mode: 'direct-scratch-reference-parser',
          payloadBytes: parsed.payload.length,
          payloadSha256,
          scorecardRows: recovered.scorecards.length,
          firstIssueId: recovered.scorecards[0]?.issueId,
          lastIssueId: recovered.scorecards.at(-1)?.issueId,
        },
        scratchTimings,
        lateSettlement: lateSettlement ?? null,
      },
    };
    process.stdout.write('SCORECARDS_LIST_RESULT_DOOR_RECEIPT ' + JSON.stringify(receipt) + '\n');
  } finally {
    await sql.end({ timeout: 2 });
    await getOrgPg().sql.end({ timeout: 2 });
  }
}

await run();
