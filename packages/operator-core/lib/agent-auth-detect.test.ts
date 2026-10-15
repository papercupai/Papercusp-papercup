/**
 * Coverage for agent-auth-detect: the Setup Wizard's file-existence probes for
 * Claude / OMP / GitHub-CLI sign-in. existsSync + homedir are mocked so the
 * tests assert the path-matching logic, not the host's real credential files.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join } from 'node:path';

const existsSync = vi.fn();
const readFileSync = vi.fn();
const spawnSync = vi.fn();
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: (p: string) => existsSync(p), readFileSync: (...a: unknown[]) => readFileSync(...a) };
});
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: unknown[]) => spawnSync(...args) };
});
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, homedir: () => '/home/u' };
});

import {
  claudeSignedIn,
  claudeKeychainSignedIn,
  codexSignedIn,
  ompSignedIn,
  ompAuthStatus,
  claudeCredentialVerdict,
  codexCredentialVerdict,
  agentBackendCredentialVerdict,
  safeCredentialShape,
  githubSignedIn,
  anyAgentSignedIn,
  readClaudeKeychainOAuthBundle,
  writeClaudeKeychainOAuthBundle,
  _setClaudeKeychainAccessForTests,
  _setClaudeKeychainAsyncAccessForTests,
  parseDumpKeychainItems,
  listClaudeKeychainCredentialItemsAsync,
  readKeychainSecretAsync,
  type KeychainAccess,
} from './agent-auth-detect';

/** Mark exactly the given absolute paths as existing. */
function onlyExist(...present: string[]) {
  const set = new Set(present);
  existsSync.mockImplementation((p: string) => set.has(p));
}

beforeEach(() => {
  existsSync.mockReset();
  readFileSync.mockReset();
  spawnSync.mockReset();
  spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
});
afterEach(() => vi.clearAllMocks());

describe('claudeSignedIn', () => {
  it('true when any documented Claude credential path exists', () => {
    onlyExist('/home/u/.claude/.credentials.json');
    expect(claudeSignedIn()).toBe(true);
    onlyExist('/home/u/.config/claude/credentials.json');
    expect(claudeSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(claudeSignedIn()).toBe(false);
  });
});

describe('claudeKeychainSignedIn (P-004 — macOS Keychain-aware detection)', () => {
  it('is a no-op off macOS (never spawns `security`)', () => {
    expect(claudeKeychainSignedIn('linux')).toBe(false);
    expect(claudeKeychainSignedIn('win32')).toBe(false);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('on darwin, true when `security find-generic-password` finds Claude Code\'s item (status 0)', () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'security' && args[0] === 'find-generic-password' && args[2] === 'Claude Code-credentials') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 44, stdout: '', stderr: 'could not be found' };
    });
    expect(claudeKeychainSignedIn('darwin')).toBe(true);
  });

  it('on darwin, reads WITHOUT `-w` so no secret is fetched (no Keychain-unlock prompt)', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    claudeKeychainSignedIn('darwin');
    const args = spawnSync.mock.calls[0][1] as string[];
    expect(args).not.toContain('-w');
  });

  it('on darwin, false when no service label matches (all non-zero)', () => {
    spawnSync.mockReturnValue({ status: 44, stdout: '', stderr: 'could not be found' });
    expect(claudeKeychainSignedIn('darwin')).toBe(false);
  });

  it('fails SAFE: a throwing `security` spawn is swallowed → false', () => {
    spawnSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(claudeKeychainSignedIn('darwin')).toBe(false);
  });
});

describe('readClaudeKeychainOAuthBundle / writeClaudeKeychainOAuthBundle (REQ B — Mac cred bridge)', () => {
  afterEach(() => _setClaudeKeychainAccessForTests(null));

  const validSecret = JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-x', refreshToken: 'sk-ant-ort01-x', expiresAt: 123 } });

  it('read is a no-op off macOS (returns null; the injected reader is never consulted)', () => {
    let consulted = false;
    _setClaudeKeychainAccessForTests({ read: () => { consulted = true; return validSecret; }, write: () => true });
    expect(readClaudeKeychainOAuthBundle('linux')).toBeNull();
    expect(consulted).toBe(false);
  });

  it('on darwin, parses the secret JSON and returns { bundle, service }', () => {
    _setClaudeKeychainAccessForTests({ read: (s) => (s === 'Claude Code-credentials' ? validSecret : null), write: () => true });
    const r = readClaudeKeychainOAuthBundle('darwin');
    expect(r?.service).toBe('Claude Code-credentials');
    expect(r?.bundle.claudeAiOauth?.accessToken).toBe('sk-ant-oat01-x');
  });

  it('on darwin, falls through to the second service label when the first is absent', () => {
    _setClaudeKeychainAccessForTests({ read: (s) => (s === 'Claude Code' ? validSecret : null), write: () => true });
    expect(readClaudeKeychainOAuthBundle('darwin')?.service).toBe('Claude Code');
  });

  it('on darwin, returns null when the reader is ACL-blocked (null) or the secret is not JSON', () => {
    _setClaudeKeychainAccessForTests({ read: () => null, write: () => true });
    expect(readClaudeKeychainOAuthBundle('darwin')).toBeNull();
    _setClaudeKeychainAccessForTests({ read: () => 'not-json{', write: () => true });
    expect(readClaudeKeychainOAuthBundle('darwin')).toBeNull();
  });

  it('write is a no-op off macOS (returns false without touching the Keychain)', () => {
    let wrote = false;
    _setClaudeKeychainAccessForTests({ read: () => null, write: () => { wrote = true; return true; } });
    expect(writeClaudeKeychainOAuthBundle('Claude Code-credentials', 'u', validSecret, 'win32')).toBe(false);
    expect(wrote).toBe(false);
  });

  it('on darwin, write forwards to the access shim and returns its success', () => {
    const calls: Array<{ service: string; account: string; secret: string }> = [];
    _setClaudeKeychainAccessForTests({ read: () => null, write: (service, account, secret) => { calls.push({ service, account, secret }); return true; } });
    expect(writeClaudeKeychainOAuthBundle('Claude Code-credentials', 'u', validSecret, 'darwin')).toBe(true);
    expect(calls).toEqual([{ service: 'Claude Code-credentials', account: 'u', secret: validSecret }]);
  });

  it('the DEFAULT access wires the real `security` CLI: read uses `-w`, write uses `add-generic-password -U`', () => {
    // Restore the default (spawnSync-backed) access, and drive the mocked spawnSync.
    _setClaudeKeychainAccessForTests(null);
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'find-generic-password') return { status: 0, stdout: validSecret, stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    });
    expect(readClaudeKeychainOAuthBundle('darwin')?.bundle.claudeAiOauth?.accessToken).toBe('sk-ant-oat01-x');
    const readArgs = spawnSync.mock.calls.at(-1)?.[1] as string[];
    expect(readArgs).toContain('-w');

    expect(writeClaudeKeychainOAuthBundle('Claude Code-credentials', 'u', validSecret, 'darwin')).toBe(true);
    const writeArgs = spawnSync.mock.calls.at(-1)?.[1] as string[];
    expect(writeArgs[0]).toBe('add-generic-password');
    expect(writeArgs).toContain('-U');
  });
});

describe('async Keychain list/read helpers (WI-10005306 — the inference gateway freshest-scan)', () => {
  afterEach(() => _setClaudeKeychainAccessForTests(null));

  const DUMP = [
    'keychain: "/Users/u/Library/Keychains/login.keychain-db"',
    '    "acct"<blob>="u"',
    '    "svce"<blob>="Claude Code-credentials"',
    '    "acct"<blob>="u"',
    '    "svce"<blob>="Claude Code-credentials-6ede4198"',
    '    "acct"<blob>="other"',
    '    "svce"<blob>="Some Unrelated App"',
    '    "svce"<blob>="Claude Code"',
  ].join('\n');

  it('parseDumpKeychainItems pairs each service with the account printed before it (null when none)', () => {
    expect(parseDumpKeychainItems(DUMP)).toEqual([
      { service: 'Claude Code-credentials', account: 'u' },
      { service: 'Claude Code-credentials-6ede4198', account: 'u' },
      { service: 'Some Unrelated App', account: 'other' },
      { service: 'Claude Code', account: null },
    ]);
  });

  it('listClaudeKeychainCredentialItemsAsync awaits a later-tick lister and keeps only Claude Code items', async () => {
    _setClaudeKeychainAsyncAccessForTests({
      read: () => null,
      write: () => false,
      list: () => new Promise((resolve) => setTimeout(() => resolve(parseDumpKeychainItems(DUMP)), 5)),
    });
    expect(await listClaudeKeychainCredentialItemsAsync()).toEqual([
      { service: 'Claude Code-credentials', account: 'u' },
      { service: 'Claude Code-credentials-6ede4198', account: 'u' },
      { service: 'Claude Code', account: null },
    ]);
  });

  it('listClaudeKeychainCredentialItemsAsync is [] for an absent, rejecting, or non-array lister', async () => {
    _setClaudeKeychainAsyncAccessForTests({ read: () => null, write: () => false });
    expect(await listClaudeKeychainCredentialItemsAsync()).toEqual([]);
    _setClaudeKeychainAsyncAccessForTests({ read: () => null, write: () => false, list: () => Promise.reject(new Error('timeout')) });
    expect(await listClaudeKeychainCredentialItemsAsync()).toEqual([]);
    _setClaudeKeychainAsyncAccessForTests({
      read: () => null,
      write: () => false,
      list: () => 'garbage' as unknown as { service: string; account: string | null }[],
    });
    expect(await listClaudeKeychainCredentialItemsAsync()).toEqual([]);
  });

  it('readKeychainSecretAsync returns the raw secret, and null on empty / rejecting / non-string', async () => {
    _setClaudeKeychainAsyncAccessForTests({ read: (s) => Promise.resolve(s === 'svc' ? 'SECRET\n' : ''), write: () => false });
    expect(await readKeychainSecretAsync('svc')).toBe('SECRET\n');
    expect(await readKeychainSecretAsync('other')).toBeNull();
    _setClaudeKeychainAsyncAccessForTests({ read: () => Promise.reject(new Error('ACL')), write: () => false });
    expect(await readKeychainSecretAsync('svc')).toBeNull();
  });

  it('the DEFAULT async lister never calls spawnSync (it goes through execFile)', async () => {
    _setClaudeKeychainAccessForTests(null);
    spawnSync.mockClear();
    // Off macOS the real `security` is absent, so execFile rejects → [] — but never via spawnSync.
    await listClaudeKeychainCredentialItemsAsync();
    await readKeychainSecretAsync('Claude Code-credentials');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});

describe('ompSignedIn', () => {
  it('true for either the .omp or legacy .pi_back auth path', () => {
    onlyExist('/home/u/.omp/agent/auth.json');
    expect(ompSignedIn()).toBe(true);
    onlyExist('/home/u/.pi_back/agent/auth.json');
    expect(ompSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(ompSignedIn()).toBe(false);
  });
});

describe('ompAuthStatus', () => {
  const AUTH = '/home/u/.omp/agent/auth.json';
  it('present:false when no auth.json exists', () => {
    onlyExist();
    expect(ompAuthStatus('/home/u', 1000)).toEqual({
      present: false, provider: null, authType: null, expiresAt: null, accessExpired: false, hasRefresh: false,
    });
  });
  it('parses an oauth token and FLAGS an expired access token (refresh present)', () => {
    onlyExist(AUTH);
    readFileSync.mockReturnValue(JSON.stringify({ anthropic: { type: 'oauth', token: { access: 'a', refresh: 'r', expires: 500 } } }));
    const s = ompAuthStatus('/home/u', 1000);
    expect(s).toEqual({ present: true, provider: 'anthropic', authType: 'oauth', expiresAt: 500, accessExpired: true, hasRefresh: true });
  });
  it('not expired when expiry is in the future', () => {
    onlyExist(AUTH);
    readFileSync.mockReturnValue(JSON.stringify({ anthropic: { type: 'oauth', token: { access: 'a', refresh: 'r', expires: 2000 } } }));
    expect(ompAuthStatus('/home/u', 1000).accessExpired).toBe(false);
  });
  it('falls back to the legacy .pi_back path', () => {
    onlyExist('/home/u/.pi_back/agent/auth.json');
    readFileSync.mockReturnValue(JSON.stringify({ anthropic: { type: 'oauth', token: { expires: 2000 } } }));
    expect(ompAuthStatus('/home/u', 1000).present).toBe(true);
  });
  it('present:true but inert on malformed json (never throws)', () => {
    onlyExist(AUTH);
    readFileSync.mockReturnValue('not json{');
    expect(ompAuthStatus('/home/u', 1000)).toEqual({
      present: true, provider: null, authType: null, expiresAt: null, accessExpired: false, hasRefresh: false,
    });
  });
});

// WI-10004897: a hosted workspace host gets claude/codex login copies whose refresh token is
// blanked to "" (D-311). Once the access token expires the copy 401s; the failover must not run it.
describe('claudeCredentialVerdict / codexCredentialVerdict / agentBackendCredentialVerdict', () => {
  const NOW = 10_000_000;
  const CLAUDE = '/home/u/.claude/.credentials.json';
  const CODEX = '/home/u/.codex/auth.json';
  const base = { home: '/home/u', env: {}, now: NOW, platform: 'linux' as const };
  const claudeFile = (oauth: Record<string, unknown>) => {
    onlyExist(CLAUDE);
    readFileSync.mockReturnValue(JSON.stringify({ claudeAiOauth: oauth }));
  };
  const jwt = (claims: Record<string, unknown>) =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  const codexFile = (body: Record<string, unknown>) => {
    onlyExist(CODEX);
    readFileSync.mockReturnValue(JSON.stringify(body));
  };

  it('claude: the hosted shape (blank refresh, expired access) is unusable', () => {
    claudeFile({ accessToken: 'a', refreshToken: '', expiresAt: NOW - 1 });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: false, reason: 'expired-no-refresh' });
    // Inside the expiry skew counts as expired: a spawn started now would land past it.
    claudeFile({ accessToken: 'a', refreshToken: '', expiresAt: NOW + 30_000 });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: false, reason: 'expired-no-refresh' });
  });

  it('claude: a live access token, a refresh token, or no recorded expiry is usable', () => {
    claudeFile({ accessToken: 'a', refreshToken: '', expiresAt: NOW + 3_600_000 });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: true, basis: 'live-access' });
    claudeFile({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: true, basis: 'refreshable' });
    claudeFile({ accessToken: 'a' });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: true, basis: 'no-expiry' });
  });

  it('claude: missing file or access token is absent; malformed JSON is unreadable', () => {
    onlyExist();
    expect(claudeCredentialVerdict(base)).toEqual({ usable: false, reason: 'absent' });
    claudeFile({ refreshToken: 'r' });
    expect(claudeCredentialVerdict(base)).toEqual({ usable: false, reason: 'absent' });
    onlyExist(CLAUDE);
    readFileSync.mockReturnValue('not json{');
    expect(claudeCredentialVerdict(base)).toEqual({ usable: false, reason: 'unreadable' });
  });

  it('claude: a loopback gateway or an env key wins over a dead file (cannot be judged locally)', () => {
    claudeFile({ accessToken: 'a', refreshToken: '', expiresAt: NOW - 1 });
    expect(claudeCredentialVerdict({ ...base, env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8788' } })).toEqual({
      usable: true,
      basis: 'gateway',
    });
    // A NON-loopback base URL is not the gateway: the file still decides.
    expect(claudeCredentialVerdict({ ...base, env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } }).usable).toBe(
      false,
    );
    expect(claudeCredentialVerdict({ ...base, env: { ANTHROPIC_API_KEY: 'k' } })).toEqual({
      usable: true,
      basis: 'env-key',
    });
  });

  it('codex: the hosted shape (refresh_token "", expired JWT access token) is unusable', () => {
    codexFile({ OPENAI_API_KEY: null, tokens: { access_token: jwt({ exp: (NOW - 1000) / 1000 }), refresh_token: '' } });
    expect(codexCredentialVerdict(base)).toEqual({ usable: false, reason: 'expired-no-refresh' });
  });

  it('codex: a live JWT, a refresh token, an API key, or an undecodable token is usable', () => {
    codexFile({ tokens: { access_token: jwt({ exp: (NOW + 3_600_000) / 1000 }), refresh_token: '' } });
    expect(codexCredentialVerdict(base)).toEqual({ usable: true, basis: 'live-access' });
    codexFile({ tokens: { access_token: jwt({ exp: 1 }), refresh_token: 'r' } });
    expect(codexCredentialVerdict(base)).toEqual({ usable: true, basis: 'refreshable' });
    codexFile({ OPENAI_API_KEY: 'sk-x', tokens: { access_token: jwt({ exp: 1 }), refresh_token: '' } });
    expect(codexCredentialVerdict(base)).toEqual({ usable: true, basis: 'api-key' });
    codexFile({ tokens: { access_token: 'opaque', refresh_token: '' } });
    expect(codexCredentialVerdict(base)).toEqual({ usable: true, basis: 'no-expiry' });
  });

  it('codex: no auth.json is absent; the gateway route is usable regardless of the file', () => {
    onlyExist();
    expect(codexCredentialVerdict(base)).toEqual({ usable: false, reason: 'absent' });
    expect(codexCredentialVerdict({ ...base, env: { PAPERCUSP_CODEX_GATEWAY: '1' } })).toEqual({
      usable: true,
      basis: 'gateway',
    });
    expect(codexCredentialVerdict({ ...base, env: { PAPERCUSP_ACCOUNT_ID: 'acct-1' } }).usable).toBe(true);
  });

  it('agentBackendCredentialVerdict routes by backend and does not judge other backends', () => {
    onlyExist();
    expect(agentBackendCredentialVerdict('claude-code', base)).toEqual({ usable: false, reason: 'absent' });
    expect(agentBackendCredentialVerdict('codex', base)).toEqual({ usable: false, reason: 'absent' });
    expect(agentBackendCredentialVerdict('omp', base)).toBeNull();
  });
});

describe('safeCredentialShape', () => {
  it('summarizes strings by type and length, while retaining finite numeric metadata', () => {
    const hiddenValue = ['opaque', 'refresh', 'material'].join('-');
    const shape = safeCredentialShape({
      anthropic: {
        token: {
          access: hiddenValue,
          refresh: hiddenValue,
          expires: 1_700_000_000_000,
        },
      },
    });

    expect(shape.anthropic).toEqual({
      type: 'object',
      fields: {
        token: {
          type: 'object',
          fields: {
            access: { type: 'string', length: hiddenValue.length },
            refresh: { type: 'string', length: hiddenValue.length },
            expires: { type: 'number', value: 1_700_000_000_000 },
          },
        },
      },
    });
    expect(JSON.stringify(shape)).not.toContain(hiddenValue);
  });

  it('gates on value type rather than treating a field name as safe metadata', () => {
    const hiddenValue = ['name', 'collision'].join('-');
    const shape = safeCredentialShape({
      refresh: hiddenValue,
      expires: hiddenValue,
      refreshCount: 3,
    });

    expect(shape).toEqual({
      refresh: { type: 'string', length: hiddenValue.length },
      expires: { type: 'string', length: hiddenValue.length },
      refreshCount: { type: 'number', value: 3 },
    });
    expect(JSON.stringify(shape)).not.toContain(hiddenValue);
  });

  it('does not invoke accessors and terminates on cyclic objects', () => {
    let invoked = false;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    Object.defineProperty(circular, 'secret', {
      enumerable: true,
      get() {
        invoked = true;
        return 'should-not-be-read';
      },
    });

    expect(safeCredentialShape(circular)).toEqual({
      self: { type: 'circular' },
      secret: { type: 'accessor' },
    });
    expect(invoked).toBe(false);
  });
});

describe('codexSignedIn', () => {
  it('true when the Codex auth file exists', () => {
    onlyExist('/home/u/.codex/auth.json');
    expect(codexSignedIn()).toBe(true);
  });
  it('false when none exist', () => {
    onlyExist();
    expect(codexSignedIn()).toBe(false);
  });
});

describe('githubSignedIn', () => {
  it('uses the gh binary bundled next to the packaged sidecar node executable', () => {
    const bundledGh = join(dirname(process.execPath), 'gh');
    onlyExist('/home/u/.config/gh/hosts.yml', bundledGh);
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === bundledGh && args[0] === 'auth' && args[1] === 'status') {
        return { status: 1, stdout: '', stderr: 'token is invalid' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });

  it('uses the gh binary bundled next to the packaged serve.mjs entrypoint', () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = '/Applications/Papercusp.app/Contents/Resources/sidecar/serve.mjs';
    const bundledGh = '/Applications/Papercusp.app/Contents/Resources/sidecar/bin/gh';
    try {
      onlyExist('/home/u/.config/gh/hosts.yml', bundledGh);
      spawnSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === bundledGh && args[0] === 'auth' && args[1] === 'status') {
          return { status: 1, stdout: '', stderr: 'token is invalid' };
        }
        return { status: 1, stdout: '', stderr: '' };
      });
      expect(githubSignedIn()).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it('true when gh auth is valid and setup-git wired the credential helper', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 0, stdout: 'Logged in', stderr: '' };
      }
      if (cmd === 'git' && args.includes('credential.https://github.com.helper')) {
        return { status: 0, stdout: '!/usr/local/bin/gh auth git-credential\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(true);
  });
  it('false when hosts.yml exists but gh reports an invalid token', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 1, stdout: '', stderr: 'token is invalid' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });
  it('false when gh is valid but setup-git has not wired git credentials', () => {
    onlyExist('/home/u/.config/gh/hosts.yml', '/usr/local/bin/gh');
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === '/usr/local/bin/gh' && args[0] === 'auth' && args[1] === 'status') {
        return { status: 0, stdout: 'Logged in', stderr: '' };
      }
      if (cmd === 'git' && args.includes('credential.https://github.com.helper')) {
        return { status: 1, stdout: '', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    expect(githubSignedIn()).toBe(false);
  });
  it('false otherwise', () => {
    onlyExist();
    expect(githubSignedIn()).toBe(false);
  });
});

describe('anyAgentSignedIn', () => {
  it('true if Claude, Codex, or OMP is signed in (not gated on GitHub)', () => {
    onlyExist('/home/u/.omp/agent/auth.json');
    expect(anyAgentSignedIn()).toBe(true);
    onlyExist('/home/u/.codex/auth.json');
    expect(anyAgentSignedIn()).toBe(true);
  });
  it('false when neither agent is signed in (even if GitHub is)', () => {
    onlyExist('/home/u/.config/gh/hosts.yml');
    expect(anyAgentSignedIn()).toBe(false);
  });
});
