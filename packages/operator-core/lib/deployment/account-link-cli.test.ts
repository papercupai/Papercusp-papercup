/**
 * account-link-cli — the CLI-driven OAuth link (accounts-pool-tab-2026-06-15 P-002/D-016).
 * Drives FAKE provider ptys: Claude captures a URL/code exchange; Codex captures a device
 * URL/code and registers the isolated auth.json. Tokens never return to the caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { delimiter, dirname } from 'node:path';

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
vi.mock('./account-pool', () => ({
  registerAccount: h.registerAccount,
  normalizeAccountProvider: (provider: unknown) => (provider === 'codex' ? 'codex' : 'claude'),
}));
vi.mock('./account-pool-store', () => ({ updateAccountPool: h.updateAccountPool, accountStatus: h.accountStatus }));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));

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
});

describe('account-link-cli — CLI-driven OAuth link', () => {
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
    await vi.waitFor(() => expect(getCliLinkStatus(s.linkId).status).toBe('completed'));
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
    expect(getCliLinkStatus(s.linkId).status).toBe('completed');
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
    expect(getCliLinkStatus(s.linkId).status).toBe('failed');
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
    expect(getCliLinkStatus(s.linkId)).toEqual({ status: 'pending' });
    // The CLI prints the token with no pty write ever having happened.
    h.state.dataCbs.forEach((cb) => cb('\r\nSuccess!\r\nsk-ant-oat01-AUTOMINTED_AbC-999\r\n'));
    await vi.waitFor(() => expect(getCliLinkStatus(s.linkId).status).toBe('completed'));
    expect(h.writeFile).toHaveBeenCalledWith('/tmp/test/deploy-credentials/auto-acme', 'sk-ant-oat01-AUTOMINTED_AbC-999', { mode: 0o600 });
    expect(h.registerAccount).toHaveBeenCalled();
    expect(h.state.killed).toBeGreaterThan(0); // the CLI's job is over — process released
    // A late "Complete link" click with NO code reports the finished link instead of demanding a paste…
    const done = await completeCliLink({ linkId: s.linkId });
    expect(done.ok).toBe(true);
    // …and releases the entry.
    expect(getCliLinkStatus(s.linkId).status).toBe('unknown');
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
