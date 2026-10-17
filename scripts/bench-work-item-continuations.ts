/** BYOC R-003 current-source proxy, controlled stall, real owned-item writes.
 * Reuses createMcpProxy and the attributed mcp-call client. No shared restart.
 * --held=WI-... --unrelated=EI-...; both items must already belong to this SID.
 */
import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { isCliEntry } from '../packages/operator-core/lib/util/cli-entry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let execMemo: typeof execFile.__promisify__ | null = null;
const exec = ((...args: unknown[]) =>
  Reflect.apply((execMemo ??= promisify(execFile)), undefined, args)) as typeof execFile.__promisify__;
let phase = 'inputs';
const SOURCE_PATHS = ['apps/operator/lib/mcp-proxy/proxy.ts', 'apps/operator/lib/mcp-proxy/budgets.mjs',
  'packages/operator-core/lib/agent-tools/work_items/checkpoint.ts',
  'packages/operator-core/lib/agent-tools/work_items/claim.ts', 'packages/operator-core/lib/work-items.ts',
  'scripts/mcp-call.mjs', 'scripts/bench-work-item-continuations.ts'];
const hashes = () => Object.fromEntries(SOURCE_PATHS.map(path =>
  [path, createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex')]));

export function verifyCheckpoint(receipt: any, readback: any, id: string) {
  const written = receipt?.results?.find((row: any) => row.id === id);
  const stored = readback?.results?.find((row: any) => row.id === id);
  return receipt?.ok === true && written?.ok === true && written?.verified === true &&
    typeof written.contentHash === 'string' && written.contentHash.length > 0 &&
    stored?.ok === true && stored.checkpointContentHash === written.contentHash;
}

export function checkpointProof(receipt: any, readback: any, id: string) {
  const written = receipt?.results?.find((row: any) => row.id === id);
  const stored = readback?.results?.find((row: any) => row.id === id);
  return { id, responseOk: receipt?.ok === true, itemOk: written?.ok === true,
    verified: written?.verified === true, errorCode: written?.errorCode ?? null,
    writeCommitted: written?.writeCommitted ?? null,
    contentHash: written?.contentHash ?? written?.storedContentHash ?? null,
    readBackContentHash: stored?.checkpointContentHash ?? null };
}

// Reclaiming our own item performs a real UPDATE (taken_at=now()) without ever
// exposing it to another worker. The receipt alone cannot establish persistence.
export function claimProof(receipt: any, readback: any, id: string, owner: string, beforeTakenAt: string) {
  const written = receipt?.results?.find((row: any) => row.id === id);
  const stored = readback?.results?.find((row: any) => row.id === id);
  const takenAt = written?.workItem?.takenAt;
  const timestamp = typeof takenAt === 'string' ? Date.parse(takenAt) : NaN;
  const before = Date.parse(beforeTakenAt);
  return { id, responseOk: receipt?.ok === true, itemOk: written?.ok === true,
    receiptId: written?.workItem?.id ?? null, assignee: written?.workItem?.assignee ?? null,
    takenAt: takenAt ?? null, readBackId: stored?.workItem?.id ?? null,
    readBackAssignee: stored?.workItem?.assignee ?? null, readBackTakenAt: stored?.workItem?.takenAt ?? null,
    verified: receipt?.ok === true && written?.ok === true && written?.workItem?.id === id &&
      written.workItem.assignee === owner && stored?.ok === true && stored?.availability === 'available' &&
      stored?.workItem?.id === id && stored.workItem.assignee === owner &&
      Number.isFinite(timestamp) && Number.isFinite(before) && timestamp > before &&
      stored.workItem.takenAt === takenAt };
}

export function judgeContinuation(input: {
  wallMs: number; successfulReadback: boolean; heldAtReadback: boolean;
  claimWallMs: number; claimSuccessfulReadback: boolean; claimHeldAtReadback: boolean;
  ordered: boolean; cancelledAbsent: boolean; rejectedNotForwarded: boolean;
  unknownReceipt: boolean; unknownPersisted: boolean; sourceStable: boolean;
}) {
  return [
    { id: 'unrelated-write-within-20s', passed: Number.isFinite(input.wallMs) && input.wallMs >= 0 &&
      input.wallMs <= 20_000 && input.successfulReadback && input.heldAtReadback },
    { id: 'unrelated-claim-within-20s', passed: Number.isFinite(input.claimWallMs) && input.claimWallMs >= 0 &&
      input.claimWallMs <= 20_000 && input.claimSuccessfulReadback && input.claimHeldAtReadback },
    { id: 'same-item-order', passed: input.ordered },
    { id: 'cancelled-request-not-applied', passed: input.cancelledAbsent },
    { id: 'queue-rejection-not-forwarded', passed: input.rejectedNotForwarded },
    { id: 'lost-ack-outcome-unknown-readback', passed: input.unknownReceipt && input.unknownPersisted },
    { id: 'source-stable', passed: input.sourceStable },
  ];
}

async function waitFor(test: () => boolean, limitMs = 10_000) {
  const deadline = performance.now() + limitMs;
  while (!test()) {
    if (performance.now() >= deadline) throw new Error('Controlled probe precondition deadline');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing private listener');
  return address.port;
}

async function main() {
  const flags = Object.fromEntries(process.argv.slice(2).map(arg => {
    const match = /^--(held|unrelated|output)=(.+)$/.exec(arg);
    if (!match) throw new Error('Accepted flags: --held=WI-... --unrelated=EI-... --output=/tmp/new-file.json');
    return [match[1], match[2]];
  }));
  const { held, unrelated } = flags;
  if (!flags.output || !resolve(flags.output).startsWith('/tmp/') || !flags.output.endsWith('.json') || existsSync(flags.output)) {
    throw new Error('A new /tmp JSON output path is required to separate proxy telemetry from evidence');
  }
  const client = process.env.PAPERCUSP_SID;
  const workspace = process.env.PAPERCUSP_WORKSPACE;
  if (!client || !workspace || !/^(WI|EI)-[0-9]+$/.test(held ?? '') ||
      !/^(WI|EI)-[0-9]+$/.test(unrelated ?? '') || held === unrelated) {
    throw new Error('Verified session and two distinct owned items required');
  }
  // Import only for this probe; the summary probe's source pins remain untouched.
  phase = 'imports';
  const { createMcpProxy } = await import('../apps/operator/lib/mcp-proxy/proxy');
  const { parseSse } = await import('./mcp-call.mjs');
  const call = async (port: number, name: string, args: object, signal?: AbortSignal): Promise<any> => {
    const child = await exec(process.execPath, [resolve(ROOT, 'scripts/mcp-call.mjs'), name,
      JSON.stringify(args), '--client', client, '--workspace', workspace, '--harness', 'papercusp',
      '--port', String(port), '--raw'], { cwd: ROOT, timeout: 35_000, maxBuffer: 1024 * 1024, signal });
    const raw = child.stdout.trim();
    if (raw.startsWith('{')) {
      const result = JSON.parse(raw);
      if (result.forwardingResult) return result;
    }
    const parsed = parseSse(raw);
    if (parsed.error) throw new Error('MCP response did not contain a successful tool value');
    return parsed.result;
  };
  let beforeTakenAt = '';
  for (const id of [held, unrelated]) {
    phase = 'ownership-preflight';
    const state = await call(3170, 'work_items:get', { id, harness: 'papercusp', resume: true,
      projection: { pick: ['results[].resume.claim.assignee'] } });
    if (state?.results?.[0]?.resume?.claim?.assignee !== client) throw new Error('Item ownership changed');
    const hash = await call(3170, 'work_items:get', { id, harness: 'papercusp', payloadTier: 'full',
      projection: { pick: ['results[].id', 'results[].ok', 'results[].checkpointContentHash'] } });
    if (hash?.results?.[0]?.id !== id || hash?.results?.[0]?.ok !== true ||
        typeof hash?.results?.[0]?.checkpointContentHash !== 'string') throw new Error('Hash read preflight failed');
    if (id === unrelated) {
      const claim = await call(3170, 'work_items:get', { id, harness: 'papercusp', threadLimit: 0,
        payloadTier: 'full', projection: { pick: ['results[].id', 'results[].ok', 'results[].availability',
          'results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.takenAt'] } });
      const row = claim?.results?.find((row: any) => row.id === id);
      if (row?.workItem?.assignee !== client || row?.workItem?.id !== id ||
          !Number.isFinite(Date.parse(row?.workItem?.takenAt))) throw new Error('Claim timestamp preflight failed');
      beforeTakenAt = row.workItem.takenAt;
    }
  }
  const startedAt = new Date().toISOString();
  const before = hashes();
  const nonce = randomUUID();
  const markers = Object.fromEntries(['held', 'cancelled', 'ordered', 'overflow', 'unrelated', 'unknown']
    .map(kind => [kind, `[R003 controlled-probe ${nonce} ${kind}]`])) as Record<string, string>;
  const reached: string[] = [];
  let releaseHeld = () => {};
  const gate = new Promise<void>(resolve => { releaseHeld = resolve; });
  let heldReleased = false;
  let queued = 0;
  let unknownServerReceipt: any;
  const pending: Promise<unknown>[] = [];
  const controllers: AbortController[] = [];
  // This relay introduces a known stall before dispatch and a lost ACK after dispatch.
  // Every real dispatch keeps mcp-call's session, bearer and request metadata intact.
  const relay = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const message = JSON.parse(body.toString());
      const checkpoint = message?.params?.arguments?.checkpoint;
      const kind = message?.params?.name === 'work_items:claim' ? 'claim' :
        Object.keys(markers).find(key => typeof checkpoint === 'string' && checkpoint.includes(markers[key]!));
      if (kind) reached.push(kind);
      if (kind === 'held') await gate;
      const upstream = http.request({ host: '127.0.0.1', port: 3170, method: req.method,
        path: req.url, headers: { ...req.headers, host: '127.0.0.1:3170' } }, response => {
        if (kind === 'unknown') {
          // Consume the actual operator response, then deliberately lose its ACK.
          const receiptChunks: Buffer[] = [];
          response.on('data', chunk => receiptChunks.push(Buffer.from(chunk)));
          response.once('end', () => {
            unknownServerReceipt = parseSse(Buffer.concat(receiptChunks).toString()).result;
            res.destroy();
          });
        } else {
          res.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(res);
        }
      });
      upstream.once('error', () => res.destroy());
      res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
      upstream.end(body);
    })().catch(() => res.destroy());
  });
  phase = 'private-listeners';
  const relayPort = await listen(relay);
  const proxy = createMcpProxy({ listenPort: 0, targetHost: '127.0.0.1', targetPort: relayPort,
    retryWindowMs: 1_000, maxInFlight: 10, controlPlaneReserve: 2,
    maxCriticalContinuationQueue: 1, maxCriticalContinuationQueueWaitMs: 30_000,
    criticalContinuationQueueWaitLogMs: 0, heartbeatIntervalMs: 0,
    log: line => { if (line.includes('queued critical-continuation request')) queued += 1; } });
  const proxyPort = await listen(proxy);
  const write = (id: string, kind: string, signal?: AbortSignal) => call(proxyPort, 'work_items:checkpoint',
    { id, harness: 'papercusp', append: true,
      checkpoint: `${markers[kind]} Append-only transport measurement; existing diagnosis and acceptance scope unchanged.`,
      projection: { pick: ['ok', 'results[].id', 'results[].ok', 'results[].verified', 'results[].contentHash'] } }, signal);
  const read = (id: string) => call(3170, 'work_items:get', { id, harness: 'papercusp', payloadTier: 'full',
    projection: { pick: ['results[].id', 'results[].ok', 'results[].checkpointContentHash'] } });
  try {
    phase = 'stall-and-queue';
    const heldWrite = write(held, 'held'); pending.push(heldWrite);
    await waitFor(() => reached.includes('held'));
    const cancel = new AbortController(); controllers.push(cancel);
    const cancelled = write(held, 'cancelled', cancel.signal).then(() => 'answered', () => 'cancelled');
    pending.push(cancelled);
    await waitFor(() => queued >= 1);
    const overflow = await write(held, 'overflow');
    phase = 'unrelated-write-readback';
    const start = performance.now();
    const receipt = await write(unrelated, 'unrelated');
    const readback = await read(unrelated);
    const wallMs = performance.now() - start;
    const heldAtReadback = !heldReleased && !reached.includes('cancelled');
    phase = 'unrelated-claim-readback';
    const claimStart = performance.now();
    const claimReceipt = await call(proxyPort, 'work_items:claim', { id: unrelated, assignee: 'self',
      harness: 'papercusp', payloadTier: 'full', projection: { pick: ['ok', 'results[].id', 'results[].ok',
        'results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.takenAt'] } });
    const claimReadback = await call(3170, 'work_items:get', { id: unrelated, harness: 'papercusp',
      threadLimit: 0, payloadTier: 'full', projection: { pick: ['results[].id', 'results[].ok',
        'results[].availability', 'results[].workItem.id', 'results[].workItem.assignee', 'results[].workItem.takenAt'] } });
    const claimWallMs = performance.now() - claimStart;
    const claimHeldAtReadback = !heldReleased && !reached.includes('cancelled');
    const claim = claimProof(claimReceipt, claimReadback, unrelated, client, beforeTakenAt);
    cancel.abort();
    const cancellation = await cancelled;
    phase = 'cancel-and-order';
    // Same cancellation boundary/delay as the maintained proxy integration test.
    await new Promise(resolve => setTimeout(resolve, 50));
    const ordered = write(held, 'ordered'); pending.push(ordered);
    await waitFor(() => queued >= 2);
    const orderedBlocked = !reached.includes('ordered');
    heldReleased = true; releaseHeld();
    const heldReceipt = await heldWrite;
    const orderedReceipt = await ordered;
    const heldReadback = await read(held);
    phase = 'lost-ack-readback';
    const unknown = await write(unrelated, 'unknown');
    const unknownReadback = await read(unrelated);
    const sameItemOrder = { blockedBeforeRelease: orderedBlocked,
      heldSucceeded: heldReceipt?.ok === true,
      orderedVerified: verifyCheckpoint(orderedReceipt, heldReadback, held),
      reachedInOrder: reached.indexOf('held') < reached.indexOf('ordered') };
    const assertions = judgeContinuation({ wallMs,
      successfulReadback: verifyCheckpoint(receipt, readback, unrelated), heldAtReadback,
      claimWallMs, claimSuccessfulReadback: claim.verified, claimHeldAtReadback,
      ordered: Object.values(sameItemOrder).every(Boolean),
      cancelledAbsent: cancellation === 'cancelled' && !reached.includes('cancelled'),
      rejectedNotForwarded: overflow?.forwardingResult === 'not_forwarded' && !reached.includes('overflow'),
      unknownReceipt: unknown?.forwardingResult === 'outcome_unknown',
      unknownPersisted: verifyCheckpoint(unknownServerReceipt, unknownReadback, unrelated) &&
        unknownReadback?.results?.[0]?.checkpointContentHash !== readback?.results?.[0]?.checkpointContentHash,
      sourceStable: JSON.stringify(before) === JSON.stringify(hashes()) });
    const passed = assertions.every(row => row.passed);
    writeFileSync(flags.output, JSON.stringify({ schemaVersion: 1, kind: 'operational-test-evidence',
      name: 'BYOC P009 R003 controlled stall with authoritative owned checkpoint writes', framework: 'node',
      command: ['npx', 'tsx', 'scripts/bench-work-item-continuations.ts', `--held=${held}`, `--unrelated=${unrelated}`, `--output=${flags.output}`],
      exitCode: passed ? 0 : 1, startedAt, finishedAt: new Date().toISOString(),
      summary: 'Isolated current-source proxy and controlled relay; real owned checkpoint/claim writes with authoritative readbacks on staging3170. Timings include readback.',
      assertions: assertions.map(row => ({ ...row, evidence: row.id === 'unrelated-write-within-20s'
        ? `wallMs=${wallMs}; authoritative hash=${readback?.results?.[0]?.checkpointContentHash}`
        : row.id === 'unrelated-claim-within-20s' ? `wallMs=${claimWallMs}; takenAt=${claim.takenAt}; verified=${claim.verified}`
        : `reached=${reached.join(',')}; queued=${queued}; unknown=${unknown?.forwardingResult}` })),
      sourceHashes: before, wallMs, claimWallMs, claimProof: claim, claimHeldAtReadback,
      claimMethod: 'Renew already-owned claim; receipt and storage must agree on exact item, owner and a fresh takenAt. No release or third-party takeover.',
      items: { held, unrelated }, nonce,
      sameItemOrder,
      checkpointProofs: { held: checkpointProof(heldReceipt, null, held),
        ordered: checkpointProof(orderedReceipt, heldReadback, held),
        unrelated: checkpointProof(receipt, readback, unrelated),
        unknown: checkpointProof(unknownServerReceipt, unknownReadback, unrelated) },
      checkpointHashes: { unrelated: readback?.results?.[0]?.checkpointContentHash,
        ordered: heldReadback?.results?.[0]?.checkpointContentHash, unknown: unknownReadback?.results?.[0]?.checkpointContentHash },
      receipts: { overflow: overflow?.forwardingResult, unknown: unknown?.forwardingResult },
      scope: 'Current-source isolated proxy on real staging writes; not the deployed shared proxy or R006 shipment.',
      notExercised: ['shared deployed proxy', 'all unavailable evidence paths', 'deployed R006 acceptance'],
    }, null, 2) + '\n', { flag: 'wx' });
    if (!passed) process.exitCode = 1;
  } finally {
    releaseHeld();
    for (const controller of controllers) controller.abort();
    proxy.closeAllConnections(); relay.closeAllConnections();
    await Promise.allSettled(pending);
    await Promise.all([proxy, relay].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}

if (isCliEntry(import.meta.url)) void main().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  console.error(`Controlled continuation probe failed: phase=${phase}; code=${
    typeof code === 'string' && /^[A-Za-z0-9_]+$/.test(code) ? code : 'probe-precondition'}; verify owned checkpoints before any write retry`);
  process.exitCode = 1;
});
