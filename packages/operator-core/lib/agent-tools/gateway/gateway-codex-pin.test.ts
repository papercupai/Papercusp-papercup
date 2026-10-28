/**
 * gateway-codex-pin.test.ts — regression coverage for EI-21719545129987944.
 *
 * `gateway:status` exposes separate Claude (`accounts`) and Codex (`codexAccounts`)
 * pools. `accounts:pin` must validate a named account against both lists, otherwise
 * a confirmed Codex account is rejected before the durable owner pin is written.
 */
import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import http from 'node:http';

const activeSessionLookup = vi.hoisted(() => vi.fn());
const recovery = vi.hoisted(() => ({ host: vi.fn(), inject: vi.fn() }));
vi.mock('../../events/await/psu-pty-discovery', () => ({
  findLiveHostAsync: recovery.host,
  hostSupports: (host: { caps?: string[] }, cap: string) => host.caps?.includes(cap) === true,
  injectIntoHostWithConfirmation: recovery.inject,
}));
vi.mock(import('../../adv-sessions'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getLatestActiveAdvSessionByOwner: activeSessionLookup,
  };
});
vi.mock('../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(),
}));

const writes: Array<{ workspaceId: string; ownerId: string; account: string; hard: boolean }> = [];

vi.mock('../../deployment/account-owner-pins', () => ({
  setOwnerPin: async (workspaceId: string, ownerId: string, pin: { account: string; hard: boolean }) => {
    writes.push({ workspaceId, ownerId, account: pin.account, hard: pin.hard });
    return pin;
  },
  clearOwnerPin: vi.fn(),
}));

const { accountsPinTool } = await import('./gateway');

const body = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
const previousPort = process.env.PAPERCUSP_GATEWAY_PORT;
let server: http.Server | undefined;
let requests = 0;
let ownerPinPosts = 0;

async function startGateway(config: { accounts?: string[]; codexAccounts?: string[] }): Promise<void> {
  server = http.createServer((req, res) => {
    requests += 1;
    if (req.method === 'GET' && req.url === '/admin/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'POST' && req.url === '/admin/owner-pin') {
      ownerPinPosts += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  process.env.PAPERCUSP_GATEWAY_PORT = String((server.address() as { port: number }).port);
}

beforeEach(() => {
  writes.length = 0;
  requests = 0;
  ownerPinPosts = 0;
  activeSessionLookup.mockReset().mockResolvedValue(null);
  recovery.host.mockReset();
  recovery.inject.mockReset().mockResolvedValue({ ok: true, confirmation: 'acked', reason: 'accepted' });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (previousPort === undefined) delete process.env.PAPERCUSP_GATEWAY_PORT;
  else process.env.PAPERCUSP_GATEWAY_PORT = previousPort;
});

test('accepts a named Codex account from the gateway codexAccounts pool', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['aviynw5_codex'] });
  activeSessionLookup.mockResolvedValue({
    agent: 'codex',
    launchArgv: ['psu', '--account=auto'],
  });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-codex-owner', account: 'aviynw5_codex' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.appliedLive, true);
  assert.deepEqual(activeSessionLookup.mock.calls[0], ['su-codex-owner', 'papercusp-workspace']);
  assert.deepEqual(writes, [
    { workspaceId: 'papercusp-workspace', ownerId: 'su-codex-owner', account: 'aviynw5_codex', hard: false },
  ]);
});

test.each(['default', 'none', 'system'])('refuses an active --account=%s session before any pin write', async (route) => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['aviynw5_codex'] });
  activeSessionLookup.mockResolvedValue({
    agent: 'codex',
    launchArgv: ['psu', `--account=${route}`],
  });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-default-owner', account: 'aviynw5_codex' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /bypass.*gateway.*respawn/i);
  assert.deepEqual(activeSessionLookup.mock.calls[0], ['su-default-owner', 'papercusp-workspace']);
  assert.deepEqual(writes, [], 'a known gateway-free session must not get a durable owner pin');
  assert.equal(ownerPinPosts, 0, 'a known gateway-free session must not receive a live owner-pin request');
  assert.equal(requests, 0, 'refuse before making gateway requests');
});

test('retains named Claude account acceptance from the accounts pool', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['codex-main'] });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-claude-owner', account: 'claude-main' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.account, 'claude-main');
});

function quotaHost() {
  return { ownerId: 'su-default-owner', sock: '/managed/host.sock', caps: ['quota-recovery-reroute'],
    startedAt: 123, childGeneration: 4, nativeSessionId: 'native-exact',
    quotaBlocked: true, quotaBlockedSinceMs: Date.now() - 1000,
    execution: { phase: 'settled', pendingTools: 0, observedAt: Date.now() } };
}

test('explicit default-to-auto recovery pins then requests same-host recovery without a prompt', async () => {
  await startGateway({ codexAccounts: ['codex-main'] });
  activeSessionLookup.mockResolvedValue({ agent: 'codex', launchArgv: ['psu', '--account=default'] });
  const host = quotaHost();
  recovery.host.mockResolvedValue(host);
  recovery.inject.mockImplementation(async () => {
    assert.equal(ownerPinPosts, 1, 'gateway auto pin is live before recycling');
    return { ok: true, confirmation: 'acked', reason: 'accepted' };
  });
  const result = body(await accountsPinTool.handler({ agent: host.ownerId, account: 'auto', recoverQuota: true } as never,
    { workspaceId: 'papercusp-workspace' } as never));
  assert.equal(result.ok, true);
  assert.equal(result.pickupVerified, false);
  const [sock, msg] = recovery.inject.mock.calls[0]!;
  assert.equal(sock, host.sock);
  assert.equal(msg.data, '');
  assert.equal(msg.mode, 'recycle');
  assert.equal(msg.ownerId, host.ownerId);
  assert.equal(msg.deliveryId, result.operationId);
  assert.deepEqual(msg.quotaRecovery.defaultToAuto, { hostStartedAt: 123, childGeneration: 4,
    nativeSessionId: host.nativeSessionId, quotaBlockedSinceMs: host.quotaBlockedSinceMs,
    expiresAtMs: msg.quotaRecovery.startedAtMs + 30_000 });
});

test('ordinary pinning uses the recovered child route rather than its original default argv', async () => {
  await startGateway({ codexAccounts: ['codex-main'] });
  activeSessionLookup.mockResolvedValue({ agent: 'codex', launchArgv: ['psu', '--account=default'] });
  recovery.host.mockResolvedValue({ ...quotaHost(), accountRoutingMode: 'auto', quotaBlocked: false });
  const result = body(await accountsPinTool.handler({ agent: 'su-default-owner', account: 'codex-main' } as never,
    { workspaceId: 'papercusp-workspace' } as never));
  assert.equal(result.ok, true);
  assert.equal(writes[0]?.account, 'codex-main');
  assert.equal(recovery.inject.mock.calls.length, 0);
});

test.each(['legacy', 'healthy', 'stale', 'busy', 'input', 'wrong-owner', 'unknown-native'])(
  'explicit recovery refuses %s evidence before gateway writes', async (failure) => {
    activeSessionLookup.mockResolvedValue({ agent: 'codex', launchArgv: ['psu', '--account=default'] });
    const host = quotaHost();
    if (failure === 'legacy') host.caps = [];
    if (failure === 'healthy') host.quotaBlocked = false;
    if (failure === 'stale') host.execution.observedAt -= 60_000;
    if (failure === 'busy') host.execution.pendingTools = 1;
    if (failure === 'input') Object.assign(host.execution, { ownerInputPending: true });
    if (failure === 'wrong-owner') host.ownerId = 'su-other';
    if (failure === 'unknown-native') host.nativeSessionId = '';
    recovery.host.mockResolvedValue(host);
    const result = body(await accountsPinTool.handler({ agent: 'su-default-owner', account: 'auto', recoverQuota: true } as never,
      { workspaceId: 'papercusp-workspace' } as never));
    assert.equal(result.ok, false);
    assert.deepEqual(writes, []);
    assert.equal(recovery.inject.mock.calls.length, 0);
  });

test('rejects a named account absent from both gateway pools before durable write', async () => {
  await startGateway({ accounts: ['claude-main'], codexAccounts: ['codex-main'] });

  const result = body(
    await accountsPinTool.handler(
      { agent: 'su-unknown-owner', account: 'missing-account' } as never,
      { workspaceId: 'papercusp-workspace' } as never,
    ),
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /missing-account.*not in the gateway pool/);
  assert.deepEqual(result.accounts, ['claude-main', 'codex-main']);
  assert.equal(writes.length, 0);
});
