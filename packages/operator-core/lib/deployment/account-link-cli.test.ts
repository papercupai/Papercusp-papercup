/**
 * account-link-cli — the CLI-driven OAuth link (accounts-pool-tab-2026-06-15 P-002/D-016).
 * Drives FAKE provider ptys: Claude captures a URL/code exchange; Codex captures a device
 * URL/code and registers the isolated auth.json. Tokens never return to the caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { delimiter, dirname } from 'node:path';
import type { OwnerRpcOutcome } from '../cluster-owner-rpc';
import type { StoredCliLink } from './account-link-state';
import { runWithWorkspace, currentRequestWorkspaceId } from '../workspace-als';

const h = vi.hoisted(() => {
  const state = {
    dataCbs: [] as ((d: string) => void)[],
    exitCbs: [] as ((e: { exitCode: number; signal?: number }) => void)[],
    written: [] as string[],
    killed: 0,
    outcome: 'token' as 'token' | 'reject',
    mode: 'claude' as 'claude' | 'codex' | 'no-url',
  };
  const makePty = () => ({
    onData: (cb: (d: string) => void) => {
      state.dataCbs.push(cb);
      return { dispose: () => { state.dataCbs = state.dataCbs.filter((c) => c !== cb); } };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      state.exitCbs.push(cb);
      return { dispose: () => { state.exitCbs = state.exitCbs.filter((c) => c !== cb); } };
    },
    write: (d: string) => {
      state.written.push(d);
      // Model the real `claude setup-token` Ink TUI: the pasted code alone does NOTHING;
      // a SEPARATE Enter (\r) submits it. A regression to a single `code\r` write (which
      // the TUI swallows) therefore never resolves — exactly the production stall this fixes.
      const hasPastedCode = state.written.some((w) => w !== '\r' && w.trim());
      if (d === '\r' && hasPastedCode) {
        const out =
          state.outcome === 'reject'
            ? '\r\n\x1b[31mOAuth error: Request failed with status code 400\x1b[0m Press Enter to retry.\r\n'
            : '\r\n\x1b[32mSuccess!\x1b[0m token:\r\nsk-ant-oat01-TESTtoken_AbC-123\r\n';
        setTimeout(() => state.dataCbs.forEach((cb) => cb(out)), 0);
      }
    },
    kill: () => { state.killed += 1; },
  });
  const spawn = vi.fn(() => {
    const p = makePty();
    // The CLI prints the authorize URL on launch.
    setTimeout(() => state.dataCbs.forEach((cb) => cb(
      state.mode === 'codex'
        ? 'Open this link:\r\nhttps://auth.openai.com/codex/device\r\nEnter this one-time code\r\nABCD-12345\r\n'
        : state.mode === 'no-url'
          ? '\x1b[31mError: unable to reach claude.ai (proxy refused)\x1b[0m\r\n'
          : 'Open this URL:\r\nhttps://claude.com/cai/oauth/authorize?code=true&client_id=X&scope=user:inference&state=s\r\nPaste code: ',
    )), 0);
    return p;
  });
  return {
    state,
    spawn,
    writeFile: vi.fn(async () => {}),
    cp: vi.fn(async () => {}),
    mkdir: vi.fn(async () => {}),
    chmod: vi.fn(async () => {}),
    rm: vi.fn(async (_path: string, _opts?: { recursive?: boolean; force?: boolean }) => {}),
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith('/auth.json')) {
        return JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-access-token',
            refresh_token: 'codex-refresh-token',
          },
        });
      }
      throw new Error(`unexpected readFile ${path}`);
    }),
    updateAccountPool: vi.fn(async (mut: (p: { accounts: unknown[] }) => unknown) => mut({ accounts: [] })),
    accountStatus: vi.fn(async () => [
      { id: 'acme', label: 'Acme', credentialRef: 'token:/tmp/test/deploy-credentials/acme', boundTo: [], available: true, sustainedlyLimited: false, rate: {}, liveBuckets: [] },
    ]),
    registerAccount: vi.fn((p: { accounts: unknown[] }, input: Record<string, unknown>) => ({ accounts: [...p.accounts, input] })),
  };
});

vi.mock('@lydell/node-pty', () => ({ spawn: h.spawn }));
vi.mock('node:fs/promises', () => ({ readFile: h.readFile, writeFile: h.writeFile, cp: h.cp, mkdir: h.mkdir, chmod: h.chmod, rm: h.rm }));
// resolveCliBin probes the well-known install dirs (~/.local/bin, ~/.bun/bin, /usr/local/bin,
// linuxbrew) BEFORE the shared-resolver seam. A test that asserts the seam is therefore at the
// mercy of whether THIS host happens to have a real `codex` installed in one of them — it passed
// on a box without one and failed on a box with one (the 2026-09-17 green-checkpoint red, where
// /home/<user>/.local/bin/codex won and the injected resolver was never reached). Mocking only
// homedir() would fix the home-relative half and leave /usr/local/bin armed for the next host,
// so route accessSync through a swappable slot instead: real behaviour by default (the PATH-entry
// test writes an actual file and must find it), overridden to "nothing exists anywhere" by the
// test that needs a deterministically empty filesystem.
const fsProbe = vi.hoisted(() => ({ accessSync: null as ((...a: unknown[]) => void) | null }));
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  const real = actual.accessSync as (...a: unknown[]) => void;
  return { ...actual, accessSync: (...a: unknown[]) => (fsProbe.accessSync ?? real)(...a) };
});
vi.mock('../papercusp-root', () => ({ papercuspPath: (...p: string[]) => '/tmp/test/' + p.join('/') }));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => currentRequestWorkspaceId() ?? 'link-workspace' }));
vi.mock('./account-pool', () => ({
  registerAccount: h.registerAccount,
  normalizeAccountProvider: (provider: unknown) => (provider === 'codex' ? 'codex' : 'claude'),
}));
vi.mock('./account-pool-store', () => ({ updateAccountPool: h.updateAccountPool, accountStatus: h.accountStatus }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

const rpc = vi.hoisted(() => ({
  bind: vi.fn(async () => {}),
  locate: vi.fn<(...args: unknown[]) => Promise<OwnerRpcOutcome>>(async () => ({ ok: false, code: 'owner_gone', message: 'unknown resource' })),
  call: vi.fn(),
  handlers: new Map<string, (payload: unknown) => Promise<unknown>>(),
}));
vi.mock('../cluster-owner-rpc', () => ({
  bindOwnerRpcResource: rpc.bind,
  locateOwnerRpcResource: rpc.locate,
  callOwnerProcess: rpc.call,
  registerOwnerRpcHandler: (kind: string, handler: (payload: unknown) => Promise<unknown>) => rpc.handlers.set(kind, handler),
}));

const durable = vi.hoisted(() => ({
  rows: new Map<string, StoredCliLink>(),
  create: vi.fn(async (row: StoredCliLink) => { durable.rows.set(row.linkId, structuredClone(row)); }),
  read: vi.fn(async (id: string) => durable.rows.get(id) ?? null),
  finish: vi.fn(async (id: string, _scope: string, nonce: string, outcome: StoredCliLink['outcome'], failure: StoredCliLink['failure']) => {
    const row = durable.rows.get(id);
    if (!row || row.owner.nonce !== nonce) return false;
    durable.rows.set(id, { ...row, outcome, failure });
    return true;
  }),
  claim: vi.fn(async (row: StoredCliLink, owner: StoredCliLink['owner']) => {
    if (durable.rows.get(row.linkId)?.owner.nonce !== row.owner.nonce) return null;
    const next = { ...row, owner };
    durable.rows.set(row.linkId, next);
    return next;
  }),
  liveness: vi.fn<() => 'alive' | 'dead' | 'unknown'>(() => 'alive'),
}));
vi.mock('./account-link-state', () => ({
  createStoredCliLink: durable.create, readStoredCliLink: durable.read,
  finishStoredCliLink: durable.finish, claimStoredCliLink: durable.claim,
  newLinkOwner: () => ({ host: 'test-host', pid: process.pid, processIdentity: 'test-identity', nonce: 'new-owner' }),
  linkOwnerLiveness: durable.liveness, LINK_RECOVERY_RETENTION_MS: 86_400_000,
}));

import { startCliLink, completeCliLink, resolveCliBin, getCliLinkStatus, __resetCliLinksForTest } from './account-link-cli';

afterEach(() => {
  __resetCliLinksForTest();
  h.state.dataCbs = [];
  h.state.exitCbs = [];
  h.state.written = [];
  h.state.outcome = 'token';
  h.state.mode = 'claude';
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
  rpc.bind.mockReset().mockResolvedValue(undefined);
  rpc.locate.mockReset().mockResolvedValue({ ok: false, code: 'owner_gone', message: 'unknown resource' });
  rpc.call.mockReset();
  durable.rows.clear();
  durable.liveness.mockReset().mockReturnValue('alive');
});

describe('account-link-cli — CLI-driven OAuth link', () => {
  it('pins callback completion to the originating workspace after its request has ended', async () => {
    h.state.mode = 'codex';
    const started = await runWithWorkspace('original-workspace', () => startCliLink({ accountId: 'callback-workspace', provider: 'codex' }));
    expect(started.ok).toBe(true);
    h.state.exitCbs.forEach(cb => cb({ exitCode: 0 }));
    await vi.waitFor(() => expect(h.updateAccountPool).toHaveBeenCalledWith(expect.any(Function), 'original-workspace'));
    expect(h.accountStatus).toHaveBeenCalledWith('original-workspace');
    expect(durable.finish).toHaveBeenCalledWith(expect.any(String), '/tmp/test/deploy-credentials', 'new-owner', 'completed');
  });

  it('rejects a foreign workspace even when its process shares the local link map', async () => {
    const started = await runWithWorkspace('original-workspace', () => startCliLink({ accountId: 'workspace-fence' }));
    if (!started.ok) throw new Error(started.error);
    expect(await runWithWorkspace('foreign-workspace', () => getCliLinkStatus(started.linkId))).toEqual({ status: 'unknown' });
    expect(await runWithWorkspace('foreign-workspace', () => completeCliLink({ linkId: started.linkId, code: 'code' }))).toMatchObject({ ok: false, error: expect.stringContaining('workspace mismatch') });
    const handler = rpc.handlers.get('account-cli-link')!;
    expect(await handler({ op: 'status', linkId: started.linkId, workspaceId: 'foreign-workspace' })).toEqual({ status: 'unknown' });
    expect(await handler({ op: 'complete', linkId: started.linkId, workspaceId: 'foreign-workspace' })).toMatchObject({ ok: false });
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.updateAccountPool).not.toHaveBeenCalled();
  });

  it('reports an elapsed durable login TTL without writing or stealing the live owner', async () => {
    lostLink({ expiresAt: Date.now() - 1 });
    expect(await getCliLinkStatus('lost-link')).toMatchObject({ status: 'failed', error: expect.stringContaining('expired') });
    expect(durable.finish).not.toHaveBeenCalled();
    expect(durable.claim).not.toHaveBeenCalled();
  });

  it('restores workspace context when the owner handles a forwarded completion', async () => {
    h.state.mode = 'codex';
    const started = await runWithWorkspace('original-workspace', () => startCliLink({ accountId: 'forwarded-workspace', provider: 'codex' }));
    if (!started.ok) throw new Error(started.error);
    const handler = rpc.handlers.get('account-cli-link')!;
    expect(await handler({ op: 'status', linkId: started.linkId, workspaceId: 'original-workspace' })).toEqual({ status: 'pending' });
    expect(await handler({ op: 'complete', linkId: started.linkId, workspaceId: 'original-workspace' })).toMatchObject({ ok: true });
    expect(h.updateAccountPool).toHaveBeenCalledWith(expect.any(Function), 'original-workspace');
  });

  function lostLink(overrides: Partial<StoredCliLink> = {}): StoredCliLink {
    const row: StoredCliLink = {
      linkId: 'lost-link', scope: '/tmp/test/deploy-credentials', accountId: 'recovered',
      provider: 'codex', configDir: '/tmp/test/deploy-credentials/.codex-setup-recovered-a1',
      owner: { host: 'test-host', pid: 123, processIdentity: 'old-process', nonce: 'old-owner' },
      createdAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      retainUntil: Date.now() + 86_400_000, ...overrides,
    };
    durable.rows.set(row.linkId, row);
    return row;
  }

  it('requires durable custody before spawning, and stores no provider output', async () => {
    durable.create.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await startCliLink({ accountId: 'no-store' })).toMatchObject({ ok: false });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
    const r = await startCliLink({ accountId: 'stored' });
    expect(r.ok).toBe(true);
    expect(JSON.stringify([...durable.rows.values()])).not.toMatch(/ABCD-12345|sk-ant-oat|authorizeUrl|access_token|refresh_token/);
  });

  it('reads terminal outcome after losing the local map and resource registry', async () => {
    lostLink({ outcome: 'completed' });
    expect(await getCliLinkStatus('lost-link')).toEqual({ status: 'completed', account: null });
    expect(await completeCliLink({ linkId: 'lost-link' })).toEqual({ ok: true, account: null });
    expect(durable.claim).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('status reports measured interruption without acquiring recovery or touching credentials', async () => {
    lostLink();
    durable.liveness.mockReturnValue('dead');
    expect(await getCliLinkStatus('lost-link')).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
    expect(durable.claim).not.toHaveBeenCalled();
    expect(durable.finish).not.toHaveBeenCalled();
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.updateAccountPool).not.toHaveBeenCalled();
    expect(h.rm).not.toHaveBeenCalled();
  });

  it('recovers approved Codex auth through the maintained finalizer without another login', async () => {
    const row = lostLink();
    durable.liveness.mockReturnValue('dead');
    expect(await completeCliLink({ linkId: row.linkId })).toMatchObject({ ok: true });
    expect(durable.claim).toHaveBeenCalledOnce();
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.registerAccount).toHaveBeenCalledOnce();
    expect(h.writeFile).toHaveBeenCalledWith('/tmp/test/deploy-credentials/recovered.codex-cli/auth.json', expect.any(String), { mode: 0o600 });
    expect(durable.rows.get(row.linkId)).toMatchObject({ outcome: 'completed' });
  });

  it('permits only one concurrent restart recoverer to register the approved login', async () => {
    lostLink();
    durable.liveness.mockReturnValue('dead');
    const results = await Promise.all([completeCliLink({ linkId: 'lost-link' }), completeCliLink({ linkId: 'lost-link' })]);
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(h.registerAccount).toHaveBeenCalledOnce();
  });

  it.each(['alive', 'unknown'] as const)('never steals a %s custodian', async (state) => {
    lostLink();
    durable.liveness.mockReturnValue(state);
    expect(await completeCliLink({ linkId: 'lost-link' })).toMatchObject({ ok: false });
    expect(durable.claim).not.toHaveBeenCalled();
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'no_handler', 'send_failed'] as const)('never recovers on RPC %s', async (code) => {
    lostLink();
    durable.liveness.mockReturnValue('dead');
    rpc.locate.mockResolvedValueOnce({ ok: false, code, message: 'unavailable' });
    expect(await completeCliLink({ linkId: 'lost-link' })).toMatchObject({ ok: false });
    expect(durable.claim).not.toHaveBeenCalled();
  });

  it('preserves approved recovery auth on registration failure and retries with the same custodian', async () => {
    const row = lostLink();
    durable.liveness.mockReturnValue('dead');
    h.updateAccountPool.mockRejectedValueOnce(new Error('register unavailable'));
    expect(await completeCliLink({ linkId: row.linkId })).toMatchObject({ ok: false });
    expect(h.rm.mock.calls.some(([path]) => path === row.configDir)).toBe(false);
    expect(durable.rows.get(row.linkId)).toMatchObject({ outcome: 'failed', failure: 'registration-failed' });
    expect(await completeCliLink({ linkId: row.linkId })).toMatchObject({ ok: true });
    expect(durable.claim).toHaveBeenCalledOnce();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('keeps status pending on store failure without writing or launching', async () => {
    durable.read.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await getCliLinkStatus('lost-link')).toEqual({ status: 'pending' });
    expect(durable.create).not.toHaveBeenCalled();
    expect(durable.claim).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('checks the durable fence before a cached owner can write or register credentials', async () => {
    h.state.mode = 'codex';
    const started = await startCliLink({ accountId: 'fenced', provider: 'codex' });
    if (!started.ok) throw new Error('expected start');
    const row = durable.rows.get(started.linkId)!;
    durable.rows.set(started.linkId, { ...row, owner: { ...row.owner, nonce: 'another-custodian' } });
    expect(await completeCliLink({ linkId: started.linkId })).toMatchObject({ ok: false, error: expect.stringContaining('custody changed') });
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('binds the link to its process before spawning a login', async () => {
    const result = await startCliLink({ accountId: 'bound' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rpc.bind).toHaveBeenCalledWith('account-cli-link', result.linkId, '/tmp/test/deploy-credentials', 16 * 60_000);
    expect(rpc.bind.mock.invocationCallOrder[0]).toBeLessThan(h.spawn.mock.invocationCallOrder[0]);
  });

  it('does not spawn a login when process custody cannot be registered', async () => {
    rpc.bind.mockRejectedValueOnce(new Error('relay unavailable'));
    expect(await startCliLink({ accountId: 'unbound' })).toMatchObject({ ok: false });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.mkdir).not.toHaveBeenCalled();
  });

  it('reads a sibling-owned link through its original process', async () => {
    rpc.locate.mockResolvedValueOnce({ ok: true, result: { ownerPid: process.pid + 1 } });
    rpc.call.mockResolvedValueOnce({ ok: true, result: { status: 'pending' } });
    expect(await getCliLinkStatus('sibling-link')).toEqual({ status: 'pending' });
    expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({
      targetPid: process.pid + 1, kind: 'account-cli-link', payload: { op: 'status', linkId: 'sibling-link', workspaceId: 'link-workspace' },
    }));
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('routes pasted-code completion to the original process without another CLI', async () => {
    rpc.locate.mockResolvedValueOnce({ ok: true, result: { ownerPid: process.pid + 1 } });
    rpc.call.mockResolvedValueOnce({ ok: true, result: { ok: true, account: null } });
    expect(await completeCliLink({ linkId: 'sibling-link', code: 'code#state' })).toEqual({ ok: true, account: null });
    expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({
      payload: { op: 'complete', linkId: 'sibling-link', code: 'code#state', workspaceId: 'link-workspace' },
      timeoutMs: 65_000,
    }));
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('keeps timeout distinct from owner loss and never cleans a sibling credential home', async () => {
    rpc.locate.mockResolvedValue({ ok: true, result: { ownerPid: process.pid + 1 } });
    rpc.call.mockResolvedValueOnce({ ok: false, code: 'timeout', message: 'no response' });
    expect(await getCliLinkStatus('sibling-link')).toMatchObject({ status: 'pending' });
    expect(h.rm).not.toHaveBeenCalled();
    rpc.call.mockResolvedValueOnce({ ok: false, code: 'owner_gone', message: 'worker exited' });
    expect(await getCliLinkStatus('sibling-link')).toEqual({ status: 'unknown' });
    expect(h.rm).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('serves forwarded operations locally and rejects unsupported payloads without relaying again', async () => {
    const handler = rpc.handlers.get('account-cli-link');
    expect(handler).toBeTypeOf('function');
    expect(await handler?.({ op: 'status', linkId: 'absent', workspaceId: 'link-workspace' })).toEqual({ status: 'unknown' });
    expect(await handler?.({ op: 'complete', linkId: 'absent', code: 'c', workspaceId: 'link-workspace' })).toMatchObject({ ok: false });
    await expect(handler?.({ op: 'spawn', linkId: 'absent' })).rejects.toThrow('invalid account link operation');
    expect(rpc.locate).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalled();
  });

  it('startCliLink spawns `claude setup-token` (isolated config) + returns the URL it prints', async () => {
    const r = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['setup-token'],
      expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: expect.stringContaining('/tmp/test/deploy-credentials/.setup-acme-') }) }),
    );
    expect(r.authorizeUrl).toContain('https://claude.com/cai/oauth/authorize');
    expect(r.linkId).toBeTruthy();
  });

  it('startCliLink spawns `codex login --device-auth` and returns the device URL + code', async () => {
    h.state.mode = 'codex';
    const r = await startCliLink({ accountId: 'codex-acme', label: 'Codex Acme', provider: 'codex' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.spawn).toHaveBeenCalledWith(
      expect.any(String),
      ['login', '--device-auth'],
      expect.objectContaining({ env: expect.objectContaining({ CODEX_HOME: expect.stringContaining('/tmp/test/deploy-credentials/.codex-setup-codex-acme-') }) }),
    );
    expect(r.authorizeUrl).toBe('https://auth.openai.com/codex/device');
    expect(r.userCode).toBe('ABCD-12345');
  });

  it('adds the running Node prefix when a service PATH cannot resolve the CLI shebang', async () => {
    h.state.mode = 'codex';
    vi.stubEnv('PATH', '/does-not-exist-xyz');
    const r = await startCliLink({ accountId: 'codex-path', provider: 'codex' });
    expect(r.ok).toBe(true);
    const [command, , options] = h.spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }];
    const pathEntries = options.env.PATH?.split(delimiter) ?? [];
    expect(pathEntries).toContain(dirname(process.execPath));
    // An absolute resolved shim gets its own directory too; this keeps wrapper scripts that
    // chain through another executable working under the same restricted service PATH.
    if (command.includes('/') || command.includes('\\')) {
      expect(pathEntries).toContain(dirname(command));
    }
  });

  it('completeCliLink feeds the code, captures the token, registers it, and NEVER returns the token', async () => {
    const s = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = await completeCliLink({ linkId: s.linkId, code: 'THECODE#STATE' }, { notify: () => {}, enterDelayMs: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the code is pasted, then Enter is sent as a SEPARATE write — the Ink TUI swallows a
    // CR appended to the paste (the production "Linking…" stall). Regression guard.
    expect(h.state.written).toContain('THECODE#STATE');
    expect(h.state.written).toContain('\r');
    expect(h.state.written.some((w) => w.includes('THECODE#STATE') && w.includes('\r'))).toBe(false);
    // the token was written to a 0600 file under the account id + registered as token:<path>
    expect(h.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('deploy-credentials/acme'),
      expect.stringContaining('sk-ant-oat01-TESTtoken'),
      expect.objectContaining({ mode: 0o600 }),
    );
    const regInput = h.registerAccount.mock.calls[0]?.[1] as { id: string; credentialRef: string };
    expect(regInput.id).toBe('acme');
    expect(regInput.credentialRef).toMatch(/^token:/);
    // SECURITY invariant: the token must never appear in the API result.
    expect(JSON.stringify(r)).not.toContain('sk-ant-oat01-TESTtoken');
  });

  it('completeCliLink persists a Codex CLI home and registers it as codex-cli:<home>', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-acme', label: 'Codex Acme', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    const r = await completeCliLink({ linkId: s.linkId }, { notify: () => {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(h.writeFile).toHaveBeenCalledWith(
      '/tmp/test/deploy-credentials/codex-acme.codex-cli/auth.json',
      expect.stringContaining('codex-access-token'),
      expect.objectContaining({ mode: 0o600 }),
    );
    const regInput = h.registerAccount.mock.calls[0]?.[1] as { id: string; credentialRef: string; provider: string };
    expect(regInput.id).toBe('codex-acme');
    expect(regInput.provider).toBe('codex');
    expect(regInput.credentialRef).toBe('codex-cli:/tmp/test/deploy-credentials/codex-acme.codex-cli');
    expect(JSON.stringify(r)).not.toContain('codex-access-token');
  });

  it('installs an approved Codex login when its CLI exits, without a complete call', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-auto', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.state.exitCbs.slice().forEach((cb) => cb({ exitCode: 0 }));
    await vi.waitFor(async () => expect((await getCliLinkStatus(s.linkId)).status).toBe('completed'));
    expect(h.registerAccount).toHaveBeenCalledTimes(1);
    expect(h.registerAccount.mock.calls[0]?.[1]).toMatchObject({
      id: 'codex-auto', provider: 'codex',
      credentialRef: 'codex-cli:/tmp/test/deploy-credentials/codex-auto.codex-cli',
    });
    const late = await completeCliLink({ linkId: s.linkId });
    expect(late.ok).toBe(true);
    expect(JSON.stringify(late)).not.toContain('codex-access-token');
    expect(h.registerAccount).toHaveBeenCalledTimes(1);
  });

  it('shares Codex finalization when device approval races an explicit complete call', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-race', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.state.exitCbs.slice().forEach((cb) => cb({ exitCode: 0 }));
    const result = await completeCliLink({ linkId: s.linkId }, { notify: () => {} });
    expect(result.ok).toBe(true);
    expect(h.registerAccount).toHaveBeenCalledTimes(1);
  });

  it('does not install a login when the Codex CLI exits unsuccessfully', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-failed', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.state.exitCbs.slice().forEach((cb) => cb({ exitCode: 1 }));
    expect(h.registerAccount).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('installs a completed Codex login before pending-link expiry deletes it', async () => {
    h.state.mode = 'codex';
    vi.useFakeTimers();
    const starting = startCliLink({ accountId: 'codex-expiry', provider: 'codex' });
    await vi.advanceTimersByTimeAsync(5);
    const s = await starting;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect((await getCliLinkStatus(s.linkId)).status).toBe('completed');
    expect(h.registerAccount).toHaveBeenCalledTimes(1);
    expect(h.writeFile.mock.invocationCallOrder[0]).toBeLessThan(h.rm.mock.invocationCallOrder.at(-1)!);
  });

  it('preserves an approved login at expiry when registration fails, then allows retry', async () => {
    h.state.mode = 'codex';
    vi.useFakeTimers();
    const starting = startCliLink({ accountId: 'codex-retry', provider: 'codex' });
    await vi.advanceTimersByTimeAsync(5);
    const s = await starting;
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.updateAccountPool.mockRejectedValueOnce(new Error('registry unavailable'));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect((await getCliLinkStatus(s.linkId)).status).toBe('failed');
    expect(h.rm.mock.calls.some(([path]) => String(path).includes('.codex-setup-'))).toBe(false);
    const retried = await completeCliLink({ linkId: s.linkId }, { notify: () => {} });
    expect(retried.ok).toBe(true);
  });

  it('rejects malformed Codex credentials before replacing an existing account home', async () => {
    h.state.mode = 'codex';
    const s = await startCliLink({ accountId: 'codex-malformed', provider: 'codex' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.readFile.mockResolvedValueOnce('{invalid');
    const result = await completeCliLink({ linkId: s.linkId }, { notify: () => {} });
    expect(result.ok).toBe(false);
    expect(h.rm).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('completeCliLink fails fast (no write/register) when claude rejects the code', async () => {
    const s = await startCliLink({ accountId: 'acme', label: 'Acme' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    h.state.outcome = 'reject';
    const r = await completeCliLink({ linkId: s.linkId, code: 'BADCODE#STATE' }, { enterDelayMs: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/rejected the code/i);
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('completeCliLink rejects an unknown/expired linkId (no write, no register)', async () => {
    const r = await completeCliLink({ linkId: 'nope', code: 'x' });
    expect(r.ok).toBe(false);
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.registerAccount).not.toHaveBeenCalled();
  });

  it('startCliLink rejects a bad account id without spawning', async () => {
    const r = await startCliLink({ accountId: 'bad id!' });
    expect(r.ok).toBe(false);
    expect(h.spawn).not.toHaveBeenCalled();
  });

  // claude CLI ≥2.1.200 same-machine auto-callback (2026-07-03): claude.com delivers the OAuth
  // code straight to the CLI's localhost listener — the owner sees "You're all set up" and NO
  // code, and the CLI mints spontaneously. The server must harvest that mint on its own.
  it('auto-finalizes when the CLI mints WITHOUT a pasted code (localhost-callback flow)', async () => {
    const s = await startCliLink({ accountId: 'auto-acme', label: 'Auto' });
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(await getCliLinkStatus(s.linkId)).toEqual({ status: 'pending' });
    // The CLI prints the token with no pty write ever having happened.
    h.state.dataCbs.forEach((cb) => cb('\r\nSuccess!\r\nsk-ant-oat01-AUTOMINTED_AbC-999\r\n'));
    await vi.waitFor(async () => expect((await getCliLinkStatus(s.linkId)).status).toBe('completed'));
    expect(h.writeFile).toHaveBeenCalledWith('/tmp/test/deploy-credentials/auto-acme', 'sk-ant-oat01-AUTOMINTED_AbC-999', { mode: 0o600 });
    expect(h.registerAccount).toHaveBeenCalled();
    expect(h.state.killed).toBeGreaterThan(0); // the CLI's job is over — process released
    // A late "Complete link" click with NO code reports the finished link instead of demanding a paste…
    const done = await completeCliLink({ linkId: s.linkId });
    expect(done.ok).toBe(true);
    // The local entry is released; its durable terminal receipt remains readable.
    expect((await getCliLinkStatus(s.linkId)).status).toBe('completed');
  });

  // WI-1917 (2026-07-03): the no-URL failure used to swallow the CLI's output and blame PATH
  // unconditionally — the error must carry what the CLI ACTUALLY said so the next incident
  // self-explains instead of costing another spelunk.
  it('startCliLink surfaces the CLI output tail when no authorize URL appears', async () => {
    h.state.mode = 'no-url';
    const r = await startCliLink({ accountId: 'acme' }, { startTimeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('did not produce an authorize URL');
    expect(r.error).toContain('unable to reach claude.ai (proxy refused)');
  });
});

describe('resolveCliBin — CLI binary resolution for stripped-PATH operator hosts (WI-1917)', () => {
  it.each(['claude', 'codex'] as const)('selects the vendor %s login CLI instead of a cloud session wrapper', (provider) => {
    const vendor = `/usr/local/lib/papercusp-agent-toolchain/bin/${provider}`;
    const wrapper = `/opt/papercusp/current/bin/${provider}`;
    const sharedResolver = vi.fn(() => wrapper);
    fsProbe.accessSync = (path) => {
      if (path !== vendor && path !== wrapper) throw new Error('ENOENT');
    };
    try {
      expect(resolveCliBin(provider, { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release', PATH: '/opt/papercusp/current/bin' }, sharedResolver))
        .toBe(vendor);
      expect(sharedResolver).not.toHaveBeenCalled();
    } finally {
      fsProbe.accessSync = null;
    }
  });

  it.each(['claude', 'codex'] as const)('names a missing cloud vendor %s toolchain instead of launching a session', (provider) => {
    fsProbe.accessSync = () => { throw new Error('ENOENT'); };
    const sharedResolver = vi.fn(() => `/opt/papercusp/current/bin/${provider}`);
    try {
      expect(() => resolveCliBin(provider, { PAPERCUSP_DISTRIBUTION_PROFILE: 'vm-release', PATH: '' }, sharedResolver))
        .toThrow(/vendor login CLI.*customer agent toolchain/);
      expect(sharedResolver).not.toHaveBeenCalled();
    } finally {
      fsProbe.accessSync = null;
    }
  });

  it('an explicit env override wins verbatim, no existence check', () => {
    expect(resolveCliBin('claude', { CLAUDE_BIN: '/custom/claude' })).toBe('/custom/claude');
    expect(resolveCliBin('codex', { CODEX_BIN: '/custom/codex' })).toBe('/custom/codex');
  });

  it('finds the binary on a PATH entry', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'clibin-'));
    try {
      writeFileSync(join(dir, 'claude'), '#!/bin/sh\n');
      chmodSync(join(dir, 'claude'), 0o755);
      expect(resolveCliBin('claude', { PATH: `/does-not-exist-xyz:${dir}` })).toBe(join(dir, 'claude'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses the shared agent resolver when the operator PATH omits the canonical Codex shim', () => {
    // Hermetic on ANY host: every well-known install dir is probed before this seam, so the
    // assertion is only about the seam once the filesystem is forced to miss. See the node:fs
    // mock above for why homedir()-only isolation is insufficient.
    fsProbe.accessSync = () => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    };
    try {
      const sharedResolver = vi.fn(() => '/home/test/.papercusp/bin/codex');
      expect(resolveCliBin('codex', { PATH: '/does-not-exist-xyz' }, sharedResolver)).toBe(
        '/home/test/.papercusp/bin/codex',
      );
      expect(sharedResolver).toHaveBeenCalledWith('codex');
    } finally {
      fsProbe.accessSync = null;
    }
  });

  it('falls back past a claude-less PATH instead of failing (well-known dirs, else the bare name)', () => {
    // The 2026-07-03 staging incident: a stale systemd env whose PATH lacked ~/.local/bin. The
    // resolver must keep going — a well-known install dir when one exists on the host, the bare
    // name at worst — never silently pin the failure on the empty PATH alone.
    const resolved = resolveCliBin('claude', { PATH: '/does-not-exist-xyz' });
    expect(resolved.endsWith('/claude') || resolved === 'claude').toBe(true);
  });
});
