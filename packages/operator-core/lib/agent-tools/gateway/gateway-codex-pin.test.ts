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
vi.mock('../../adv-sessions', () => ({
  getLatestActiveAdvSessionByOwner: activeSessionLookup,
}));
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
