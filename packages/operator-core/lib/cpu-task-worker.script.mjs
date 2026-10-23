/**
 * Worker script for cpu-task-worker.ts — handles CPU-heavy synchronous work
 * off the operator main thread:
 *
 *   serialize  → JSON.stringify (with BigInt→Number replacer)
 *   broad_tree_scan → TypeScript AST census detection for evidence freshness
 *
 * Runs in a dedicated worker_threads thread so the main event loop is free
 * during the blocking compute. Both tasks share the same lifecycle and
 * round-trip id for pending-map correlation.
 *
 * infra-perf-reliability-audit-round3-2026-06-19 P-011 / round4 P-002.
 * The gzip half was removed 2026-07-26: the operator is a loopback desktop
 * sidecar and no longer compresses any response, so there is nothing to
 * offload. Do not re-add it (scripts/check-no-wire-compression.mjs).
 *
 * Protocol (main → worker):
 *   { kind: 'serialize', id: number, value: unknown }
 *
 * Protocol (worker → main):
 *   { kind: 'ready' }
 *   { kind: 'serialize_ok', id: number, json: string }
 *   { kind: 'serialize_err', id: number, error: string }
 *
 * Plain ESM .mjs (no TypeScript transform) — same convention as
 * local-embedder-worker.script.mjs.
 */

import { parentPort } from 'node:worker_threads';

/**
 * BigInt-safe JSON.stringify replacer. Matches the replacer used in
 * rest-query-batch.ts so the worker output is byte-identical to what the
 * main thread produced before.
 */
function replaceBigInt(_k, v) {
  return typeof v === 'bigint' ? Number(v) : v;
}

// Keep parsing on this thread, including TypeScript's module initialization.
// Evidence checks must never run this work inline in the request host.
async function detectBroadRepoTreeScan(source) {
  const { default: ts } = await import('typescript');
  const file = ts.createSourceFile('repo-measurement.test.ts', source, ts.ScriptTarget.Latest, false);
  let hasRootCollection = false;
  let hasDirectoryRead = false;
  let hasTraversal = false;
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const name = node.text.toUpperCase();
      if (/ROOTS?$|(?:DIRS|DIRECTORIES)$/.test(name) && name.length > 4) hasRootCollection = true;
      if (/^(?:WALK|SCAN(?:TREE|DIRECTORY|FILES)?|VISIT)$/i.test(node.text)) hasTraversal = true;
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      if (name && /^(?:READDIR|READDIRSYNC|GLOB|GLOBSYNC|FASTGLOB)$/i.test(name)) hasDirectoryRead = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return hasRootCollection && hasDirectoryRead && hasTraversal;
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  const { kind, id } = msg;

  if (kind !== 'serialize' && kind !== 'broad_tree_scan') return;

  try {
    if (kind === 'broad_tree_scan') {
      const broadTreeScan = await detectBroadRepoTreeScan(msg.source);
      parentPort.postMessage({ kind: 'broad_tree_scan_ok', id, broadTreeScan });
      return;
    }
    const json = JSON.stringify(msg.value, replaceBigInt);
    parentPort.postMessage({ kind: 'serialize_ok', id, json });
  } catch (err) {
    parentPort.postMessage({
      kind: kind === 'serialize' ? 'serialize_err' : 'broad_tree_scan_err',
      id,
      error: err && err.message ? err.message : String(err),
    });
  }
});

// Signal ready immediately — no heavy init here; the worker is cheap to spawn.
parentPort.postMessage({ kind: 'ready' });
