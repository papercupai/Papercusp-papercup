/**
 * gateway.test.ts — the gateway:* tool HANDLERS (B-GWCTL): thin HTTP wrappers over the running
 * gateway's /admin/config + /admin/reload. A mock gateway stands in for :8788 (via PAPERCUSP_GATEWAY_PORT).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/gateway/gateway.test.ts
 */
import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gatewayStatusTool,
  gatewayReloadTool,
  gatewayOwnerReportTool,
  quarantineLegacyCapacityFields,
  CANONICAL_CONFIG_FIELDS,
} from './gateway';
import { lookupByMcpName } from '@papercusp/agent-mcp';

let server: http.Server | undefined;
const prevPort = process.env.PAPERCUSP_GATEWAY_PORT;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  if (prevPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = prevPort;
});

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

test('gateway:status advertises its actual top-level response shape', () => {
  const projected = lookupByMcpName('gateway:status');
  assert.ok(projected, 'gateway:status must be registered');
  const properties = projected.outputJsonSchema?.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), [
    'accounts',
    'admissionState',
    'codexAccounts',
    'error',
    'legacy',
    'ok',
    'providers',
    'upstreamBase',
    'version',
  ]);
  assert.equal(properties.value, undefined, 'value is nested, not a gateway:status field');
  assert.equal(properties.writer, undefined, 'writer is nested, not a gateway:status field');
});

test('gateway:status reads /admin/config; gateway:reload POSTs /admin/reload (B-GWCTL round-trip)', async () => {
  let reloadHit = false;
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/admin/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 3, accounts: ['a', 'b'] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/reload') {
      reloadHit = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, changed: true, version: 4, accounts: ['a', 'b', 'c'] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server!.address() as { port: number }).port);

  const s = body(await gatewayStatusTool.handler({} as never, {} as never));
  assert.equal(s.ok, true);
  assert.equal(s.version, 3);
  assert.deepEqual(s.accounts, ['a', 'b']);

  const rl = body(await gatewayReloadTool.handler({} as never, {} as never));
  assert.equal(rl.ok, true);
  assert.equal(rl.changed, true);
  assert.equal(rl.version, 4);
  assert.deepEqual(rl.accounts, ['a', 'b', 'c']);
  assert.equal(reloadHit, true, 'gateway:reload actually POSTed /admin/reload');
});

test('gateway:owner_report resolves agent:self to the caller owner id', async () => {
  let requestedUrl = '';
  server = http.createServer((req, res) => {
    requestedUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      owner: 'su-test',
      ledger: { requests: 1, ok: 1 },
      stageTelemetry: { ownerId: 'su-test', finalized: 1 },
    }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server!.address() as { port: number }).port);

  const report = body(await gatewayOwnerReportTool.handler(
    { agent: 'self' } as never,
    { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'ws-test' } as never,
  ));
  assert.equal(requestedUrl, '/admin/owner-report?owner=su-test');
  assert.equal(report.ok, true);
  assert.equal(report.owner, 'su-test');
  assert.equal(report.stageTelemetry.ownerId, 'su-test');
});

test('gateway:owner_report forwards owner and time/limit filters to durable request outcomes', async () => {
  let requestedUrl = '';
  server = http.createServer((req, res) => {
    requestedUrl = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requestOutcomes: { total: 1, rows: [{ outcomeClass: 'upstream-429' }] } }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server!.address() as { port: number }).port);

  const args = gatewayOwnerReportTool.args.parse({
    agent: 'owner / one',
    from: Date.parse('2026-10-13T09:00:00.000Z'),
    to: Date.parse('2026-10-13T12:00:00.000Z'),
    limit: 17,
  });
  const report = body(await gatewayOwnerReportTool.handler(args, {} as never));
  const requested = new URL(requestedUrl, 'http://gateway');

  assert.equal(requested.pathname, '/admin/owner-report');
  assert.equal(requested.searchParams.get('owner'), 'owner / one');
  assert.equal(requested.searchParams.get('from'), String(Date.parse('2026-10-13T09:00:00.000Z')));
  assert.equal(requested.searchParams.get('to'), String(Date.parse('2026-10-13T12:00:00.000Z')));
  assert.equal(requested.searchParams.get('limit'), '17');
  assert.equal(report.requestOutcomes.total, 1);
});

test('gateway:owner_report requires an agent for filters and rejects an empty time window', () => {
  assert.equal(gatewayOwnerReportTool.args.safeParse({ from: 10 }).success, false);
  assert.equal(gatewayOwnerReportTool.args.safeParse({ agent: 'owner-a', from: 20, to: 20 }).success, false);
  assert.equal(gatewayOwnerReportTool.args.safeParse({ agent: 'owner-a', from: 10, to: 20, limit: 1_000 }).success, true);
});

test('gateway:owner_report refuses agent:self without an attributable caller', async () => {
  const report = body(await gatewayOwnerReportTool.handler(
    { agent: 'self' } as never,
    {} as never,
  ));
  assert.equal(report.ok, false);
  assert.equal(report.error, 'unknown_agent');
  assert.match(report.message, /requires an attributable caller identity/);
});

// ── P-003: legacy capacity fields are quarantined, never silently level with canonical ──

test('P-003: gateway:status quarantines the legacy capacity reads under legacy:{} with a pointer', () => {
  const out = quarantineLegacyCapacityFields({
    version: 3,
    accounts: ['a'],
    codexAccounts: ['c'],
    admissionState: { lanes: [] },
    upstreamBase: 'http://x',
    admission: { maxConcurrent: 4 },
    codexAdmission: { maxConcurrent: 2 },
    concurrencyCap: 24,
    aimd: { effective: 24 },
    codexAimd: { effective: 8 },
    clamp: { recommended: 4 },
    admissionCeiling: { applied: 4 },
    codexHealthyAccounts: 2,
  });

  // Canonical fields stay exactly where callers expect them.
  assert.equal(out.version, 3);
  assert.deepEqual(out.accounts, ['a']);
  assert.deepEqual(out.admissionState, { lanes: [] });

  // Every legacy read moved down a level — NOT dropped.
  const legacy = out.legacy as Record<string, unknown>;
  assert.equal(out.codexHealthyAccounts, undefined, 'codexHealthyAccounts no longer sits level with admissionState');
  assert.equal(out.admission, undefined);
  assert.equal(out.clamp, undefined);
  assert.equal(legacy.codexHealthyAccounts, 2, 'the value is preserved, one level down');
  assert.deepEqual(legacy.admission, { maxConcurrent: 4 });
  assert.equal(legacy.readInstead, 'admissionState');

  // The trap this exists to close: the NAME does not mean what it looks like.
  const meaning = legacy.meaning as Record<string, string>;
  assert.ok(/NOT quota/.test(meaning.codexHealthyAccounts!), 'codexHealthyAccounts states its writer meaning');
  assert.ok(/CAN SERVE RIGHT NOW/.test(meaning.codexHealthyAccounts!));
  for (const k of Object.keys(legacy)) {
    if (k === 'readInstead' || k === 'why' || k === 'meaning') continue;
    assert.ok(meaning[k], `legacy field '${k}' carries a writer meaning`);
  }
});

test('P-003: a payload with no legacy fields gets no empty legacy:{} envelope', () => {
  const out = quarantineLegacyCapacityFields({ version: 1, accounts: [], admissionState: { lanes: [] } });
  assert.equal(out.legacy, undefined, 'no legacy block when there is nothing to quarantine');
  assert.equal(out.version, 1);
});

test('P-003 DRIFT PIN: every capacity field /admin/config emits is classified canonical or legacy', () => {
  // A hand-maintained list DESCRIBING code drifts silently — the derived-truth trap. Pin it: read
  // the gateway's own /admin/config response block and require each key it emits to be one we
  // classified. A newly-added legacy read then fails HERE, at the change, instead of quietly
  // sitting level with admissionState until it misleads someone.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../../inference-gateway/gateway.ts'), 'utf8');
  const marker = "requestPath === '/admin/config'";
  const start = src.indexOf(marker);
  assert.ok(start > 0, 'POSITIVE CONTROL: found the /admin/config handler in gateway.ts');
  const block = src.slice(start, src.indexOf("if (req.method === 'POST' && requestPath === '/admin/readmit')", start));
  assert.ok(block.length > 200, 'POSITIVE CONTROL: extracted a non-trivial handler block');

  // Top-level keys of the sendJson object literal: a line at exactly 8-space indent of `key:`.
  const emitted = [...block.matchAll(/^ {8}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((m) => m[1]!);
  assert.ok(emitted.includes('admissionState'), 'POSITIVE CONTROL: the key scrape sees admissionState');
  assert.ok(emitted.includes('codexHealthyAccounts'), 'POSITIVE CONTROL: the key scrape sees a known legacy field');

  // Classify each through the real function rather than a second copy of the list.
  const probe = quarantineLegacyCapacityFields(Object.fromEntries(emitted.map((k) => [k, 1])));
  const quarantined = new Set(Object.keys((probe.legacy ?? {}) as Record<string, unknown>));
  // The canonical set is IMPORTED, never re-typed here: a second copy is the same drift this
  // pin exists to catch (a field added to gateway.ts's list once went red here, WI-10003582).
  const canonicalOk = new Set<string>(CANONICAL_CONFIG_FIELDS);
  const unclassified = emitted.filter((k) => !quarantined.has(k) && !canonicalOk.has(k));
  assert.deepEqual(
    unclassified,
    [],
    `/admin/config emits key(s) that are neither canonical nor quarantined: ${unclassified.join(', ')}. ` +
      'Add each to LEGACY_CAPACITY_FIELDS (with its WRITER MEANING) or to CANONICAL_CONFIG_FIELDS in agent-tools/gateway/gateway.ts.',
  );
});

test('gateway:status fails SOFT (never throws) when the gateway is unreachable', async () => {
  process.env.PAPERCUSP_GATEWAY_PORT = '1'; // nothing listening → connection refused
  const s = body(await gatewayStatusTool.handler({} as never, {} as never));
  assert.equal(s.ok, false);
  assert.ok(String(s.error).includes('unreachable'), 'reports an unreachable gateway, not a crash');
});
