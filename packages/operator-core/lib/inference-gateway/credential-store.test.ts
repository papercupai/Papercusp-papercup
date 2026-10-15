/** Tests for the hive inference gateway credential resolver (P-003). */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCredentialRef,
  withOAuthBeta,
  CLAUDE_CONTEXT_1M_BETA,
  bundleTokenStorage,
  makeCredentialResolver,
  makeBearerCredentialResolver,
  credentialRefSupportsOpenAiBearer,
  normalizeBearerToken,
  scrubSecrets,
  _setKeychainReaderForTests,
  _setKeychainListerForTests,
  _setKeychainWriterForTests,
  type ClaudeCredentialBundle,
} from './credential-store';
import {
  registerProvider,
  __resetRegistryForTest,
  type OAuthProvider,
} from '../oauth/providers';
import { __resetTokenCacheForTest } from '../oauth/token';

let dir: string;
let savedHome: string | undefined;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ig-cred-'));
  // The keychain channel's freshest-scan includes $HOME/.claude/.credentials.json — redirect
  // HOME so no test ever reads (or writes!) the real box credential.
  savedHome = process.env.HOME;
  process.env.HOME = dir;
  __resetRegistryForTest();
  __resetTokenCacheForTest();
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** A fake claude provider whose refresh() hands back a counted new token. */
function fakeClaude(): { provider: OAuthProvider; refreshes: () => number } {
  let n = 0;
  const provider: OAuthProvider = {
    id: 'claude',
    config: { clientId: 'x', clientSecret: '', authorizeUrl: 'a', tokenUrl: 't', redirectUri: 'r' },
    buildAuthorizeUrl: () => 'url',
    exchangeCode: async () => ({ accessToken: 'a' }),
    refresh: async (rt) => {
      n += 1;
      return { accessToken: `refreshed-${n}`, refreshToken: `${rt}-rotated`, expiresAt: Date.now() + 3_600_000 };
    },
  };
  return { provider, refreshes: () => n };
}

test('parseCredentialRef — token / file / bare / ~ / env channels (no static key: literal)', () => {
  assert.deepEqual(parseCredentialRef('token:/a/b'), { kind: 'token', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('file:/a/b'), { kind: 'file', path: '/a/b' });
  assert.deepEqual(parseCredentialRef('/a/b'), { kind: 'file', path: '/a/b' });
  // env: reads the secret from an env VAR (the Codex/OpenAI API-key channel, 2026-06-21) — supported.
  assert.deepEqual(parseCredentialRef('env:NAME'), { kind: 'env', path: 'NAME' });
  // A STATIC key: literal is still rejected — secrets never live inline in a credentialRef.
  assert.throws(() => parseCredentialRef('key:/a/b'), /unsupported/);
});

test('withOAuthBeta — always includes oauth flag, de-duplicated, preserves others', () => {
  assert.equal(withOAuthBeta(null), 'oauth-2025-04-20');
  assert.equal(withOAuthBeta('oauth-2025-04-20'), 'oauth-2025-04-20');
  assert.equal(withOAuthBeta('fine-grained-tool-streaming-2025-05-14'), 'fine-grained-tool-streaming-2025-05-14,oauth-2025-04-20');
  assert.equal(withOAuthBeta(null, true), `oauth-2025-04-20,${CLAUDE_CONTEXT_1M_BETA}`);
  assert.equal(withOAuthBeta(`oauth-2025-04-20,${CLAUDE_CONTEXT_1M_BETA}`, true), `oauth-2025-04-20,${CLAUDE_CONTEXT_1M_BETA}`);
});

test('bundleTokenStorage — read maps claudeAiOauth, update rewrites + preserves other fields', async () => {
  const path = join(dir, 'b.json');
  const bundle: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 123, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' },
  };
  await fs.writeFile(path, JSON.stringify(bundle));
  const store = bundleTokenStorage(path);
  const cfg = await store.read('inference-gateway', path);
  assert.equal(cfg.access, 'AT');
  assert.equal(cfg.access_refresh, 'RT');
  assert.equal(cfg.access_expires_at, 123);

  await store.update('inference-gateway', path, { access: 'AT2', access_refresh: 'RT2', access_expires_at: 999 });
  const after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'AT2');
  assert.equal(after.claudeAiOauth.refreshToken, 'RT2');
  assert.equal(after.claudeAiOauth.expiresAt, 999);
  assert.equal(after.claudeAiOauth.subscriptionType, 'max', 'preserves non-token fields');
  assert.equal(after.claudeAiOauth.rateLimitTier, 'default_claude_max_20x');
});

test('makeCredentialResolver — token: returns the raw setup-token, cached (no refresh)', async () => {
  const path = join(dir, 'tok');
  await fs.writeFile(path, '  sk-ant-oat-abc\n');
  const r = makeCredentialResolver(`token:${path}`);
  assert.equal(r.kind, 'token');
  assert.equal(await r.current(), 'sk-ant-oat-abc');
  // mutate the file; cached value should persist until invalidate()
  await fs.writeFile(path, 'sk-ant-oat-CHANGED');
  assert.equal(await r.current(), 'sk-ant-oat-abc');
  r.invalidate();
  assert.equal(await r.current(), 'sk-ant-oat-CHANGED');
});

test('makeBearerCredentialResolver — file: rejects Codex ChatGPT auth.json for gateway bearer use', async () => {
  const path = join(dir, 'codex-auth.json');
  await fs.writeFile(path, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'codex-access-token',
      refresh_token: 'codex-refresh-token',
    },
  }));
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  await assert.rejects(r.current(), /ChatGPT auth\.json.*OpenAI API bearer/);
  assert.equal(await credentialRefSupportsOpenAiBearer(`file:${path}`), false);
});

test('makeBearerCredentialResolver — file: prefers OPENAI_API_KEY when present in a Codex auth-shaped JSON file', async () => {
  const path = join(dir, 'codex-auth-with-api-key.json');
  await fs.writeFile(path, JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: { value: 'sk-openai-from-json' },
    tokens: {
      access_token: 'chatgpt-access-token',
      refresh_token: 'chatgpt-refresh-token',
    },
  }));
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'sk-openai-from-json');
  assert.equal(await credentialRefSupportsOpenAiBearer(`file:${path}`), true);
});

test('makeBearerCredentialResolver — file: extracts bearer JSON tokens.access_token when it is not a ChatGPT auth bundle', async () => {
  const path = join(dir, 'bearer-json.json');
  await fs.writeFile(path, JSON.stringify({ tokens: { access_token: 'bearer-access-token' } }));
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  assert.equal(await r.current(), 'bearer-access-token');
  await fs.writeFile(path, JSON.stringify({ tokens: { access_token: 'changed' } }));
  assert.equal(await r.current(), 'bearer-access-token', 'serves cached token until invalidated');
  r.invalidate();
  assert.equal(await r.current(), 'changed');
});

test('makeBearerCredentialResolver — file: still accepts raw bearer token files', async () => {
  const path = join(dir, 'raw-openai-token');
  await fs.writeFile(path, '  sk-openai-test\n');
  const r = makeBearerCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'sk-openai-test');
});

test('makeCredentialResolver — file: refreshes a near-expiry bundle once, then serves the cache', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider); // pre-register so ensureClaudeProvider keeps our fake
  const path = join(dir, 'b.json');
  const expired: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'stale', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expired));

  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(r.kind, 'file');
  assert.equal(await r.current(), 'refreshed-1', 'expired bundle triggers a refresh');
  assert.equal(refreshes(), 1);
  // the bundle was rewritten with the new token + rotated refresh token
  const after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'refreshed-1');
  assert.equal(after.claudeAiOauth.refreshToken, 'RT-rotated');
  // second call within the fresh window serves the cache — no second refresh
  assert.equal(await r.current(), 'refreshed-1');
  assert.equal(refreshes(), 1);
});

test('makeCredentialResolver — file: serves a still-fresh token without refreshing', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider);
  const path = join(dir, 'b.json');
  const fresh: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'good', refreshToken: 'RT', expiresAt: Date.now() + 3_600_000 },
  };
  await fs.writeFile(path, JSON.stringify(fresh));
  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'good');
  assert.equal(refreshes(), 0, 'fresh token is not refreshed');
});

// ── Backlog #6: credential-store deeper edges (continuation; prior owner su-c8455e93) ──

test('parseCredentialRef — expands ~ to $HOME for bare/file:/token: refs; env: trims the var name', () => {
  const prevHome = process.env.HOME;
  process.env.HOME = '/home/tester';
  try {
    assert.deepEqual(parseCredentialRef('~/x'), { kind: 'file', path: '/home/tester/x' });
    assert.deepEqual(parseCredentialRef('file:~/c.json'), { kind: 'file', path: '/home/tester/c.json' });
    assert.deepEqual(parseCredentialRef('token:~/.claude/tok'), { kind: 'token', path: '/home/tester/.claude/tok' });
    // env: names a process.env var — surrounding whitespace is trimmed off the name.
    assert.deepEqual(parseCredentialRef('env:  MY_KEY  '), { kind: 'env', path: 'MY_KEY' });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});

test('withOAuthBeta — splits a multi-flag header, trims + drops empties, dedups a mid-list oauth flag', () => {
  // whitespace around commas + an empty segment are normalised away; oauth appended last
  assert.equal(withOAuthBeta('flag-a , , flag-b'), 'flag-a,flag-b,oauth-2025-04-20');
  // oauth already present mid-list → not duplicated, first-seen order preserved
  assert.equal(withOAuthBeta('flag-a,oauth-2025-04-20,flag-b'), 'flag-a,oauth-2025-04-20,flag-b');
  // an all-whitespace header collapses to just the required oauth flag
  assert.equal(withOAuthBeta('   '), 'oauth-2025-04-20');
});

test('makeCredentialResolver — rejects an env: ref (env is a bearer-only channel)', () => {
  assert.throws(() => makeCredentialResolver('env:SOME_KEY'), /env: is only valid for bearer accounts/);
});

test('makeCredentialResolver — token: empty file throws rather than serving an empty bearer', async () => {
  const path = join(dir, 'empty-tok');
  await fs.writeFile(path, '   \n');
  const r = makeCredentialResolver(`token:${path}`);
  await assert.rejects(r.current(), /empty setup-token/);
});

test('makeBearerCredentialResolver — env: reads process.env, trims it, throws when unset or empty', async () => {
  const VAR = `IG_TEST_CRED_${process.pid}`;
  const prev = process.env[VAR];
  try {
    process.env[VAR] = '  sk-from-env  ';
    const r = makeBearerCredentialResolver(`env:${VAR}`);
    assert.equal(r.kind, 'token', 'env channel reports as a non-refreshing token');
    assert.equal(await r.current(), 'sk-from-env');
    // unset var → a fresh resolver throws
    delete process.env[VAR];
    await assert.rejects(makeBearerCredentialResolver(`env:${VAR}`).current(), /empty or unset/);
    // whitespace-only var → also throws
    process.env[VAR] = '   ';
    await assert.rejects(makeBearerCredentialResolver(`env:${VAR}`).current(), /empty or unset/);
  } finally {
    if (prev === undefined) delete process.env[VAR];
    else process.env[VAR] = prev;
  }
});

test('makeBearerCredentialResolver — file: rejects empty file, JSON without access_token, and malformed JSON', async () => {
  const empty = join(dir, 'empty-bearer');
  await fs.writeFile(empty, '   \n');
  await assert.rejects(makeBearerCredentialResolver(`file:${empty}`).current(), /empty bearer token/);

  const noTok = join(dir, 'no-access.json');
  await fs.writeFile(noTok, JSON.stringify({ tokens: { refresh_token: 'r' } }));
  await assert.rejects(makeBearerCredentialResolver(`file:${noTok}`).current(), /no tokens\.access_token/);

  const bad = join(dir, 'bad.json');
  await fs.writeFile(bad, '{ not valid json ');
  await assert.rejects(makeBearerCredentialResolver(`file:${bad}`).current(), /failed to parse/);
});

test('makeCredentialResolver — file: invalidate() drops the cache so a post-401 read re-refreshes', async () => {
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider);
  const path = join(dir, 'b.json');
  const expired: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'stale', refreshToken: 'RT', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expired));

  const r = makeCredentialResolver(`file:${path}`);
  assert.equal(await r.current(), 'refreshed-1');
  assert.equal(refreshes(), 1);

  // Mimic the 401 path: invalidate the in-memory cache, and the bundle has since gone stale again.
  r.invalidate();
  const expiredAgain: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'refreshed-1', refreshToken: 'RT2', expiresAt: Date.now() - 1000 },
  };
  await fs.writeFile(path, JSON.stringify(expiredAgain));
  assert.equal(await r.current(), 'refreshed-2', 'invalidate re-reads disk and refreshes again');
  assert.equal(refreshes(), 2);
});

test('bundleTokenStorage — read tolerates a bundle missing the claudeAiOauth block', async () => {
  const path = join(dir, 'empty-bundle.json');
  await fs.writeFile(path, JSON.stringify({}));
  const cfg = await bundleTokenStorage(path).read('inference-gateway', path);
  assert.equal(cfg.access, undefined);
  assert.equal(cfg.access_refresh, undefined);
  assert.equal(cfg.access_expires_at, null);
});

test('bundleTokenStorage — update clears expiresAt on a non-number value, leaves it untouched when the key is absent', async () => {
  const path = join(dir, 'b2.json');
  const base: ClaudeCredentialBundle = {
    claudeAiOauth: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 5000, subscriptionType: 'max' },
  };
  const store = bundleTokenStorage(path);

  // key present but null (the getOAuthToken writeback when a provider returns no expiry) → cleared
  await fs.writeFile(path, JSON.stringify(base));
  await store.update('inference-gateway', path, { access: 'AT2', access_expires_at: null });
  let after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.accessToken, 'AT2');
  assert.equal(after.claudeAiOauth.expiresAt, undefined, 'null expires_at clears the field');
  assert.equal(after.claudeAiOauth.subscriptionType, 'max', 'still preserves unrelated fields');

  // key absent from the patch → expiresAt is left exactly as it was
  await fs.writeFile(path, JSON.stringify(base));
  await store.update('inference-gateway', path, { access: 'AT3' });
  after = JSON.parse(await fs.readFile(path, 'utf8')) as ClaudeCredentialBundle;
  assert.equal(after.claudeAiOauth.expiresAt, 5000, 'absent expires_at key leaves the field unchanged');
});

// ---------------------------------------------------------------------------
// Whitespace-corrupted credentials (WI-1919, 2026-07-03): a hand-pasted token wrapped by a
// terminal carries an EMBEDDED newline `trim()` cannot see — injected into the Authorization
// header it kills every request on the account with `Headers.append: invalid header value`.
// Every read path must collapse ALL whitespace, not just trim the ends.
// ---------------------------------------------------------------------------

test('normalizeBearerToken — strips embedded newlines/CR/tabs/spaces, not just the ends', () => {
  assert.equal(normalizeBearerToken('sk-ant-oat01-abc\ndef\r\n'), 'sk-ant-oat01-abcdef');
  assert.equal(normalizeBearerToken('  sk-ant-oat01-x\ty  '), 'sk-ant-oat01-xy');
  assert.equal(normalizeBearerToken('\n \r'), '');
});

test('makeCredentialResolver — token: file with a MID-TOKEN newline serves a header-safe bearer', async () => {
  const path = join(dir, 'wrapped-token');
  // The exact 2026-07-03 corruption shape: the paste wrapped mid-token.
  await fs.writeFile(path, 'sk-ant-oat01-first-half\nsecond-half\n');
  const r = makeCredentialResolver(`token:${path}`);
  const token = await r.current();
  assert.equal(token, 'sk-ant-oat01-first-halfsecond-half');
  assert.ok(!/\s/.test(token), 'no whitespace may survive into the Authorization header');
});

test('makeBearerCredentialResolver — file + env bearers are whitespace-collapsed too', async () => {
  const path = join(dir, 'wrapped-bearer');
  await fs.writeFile(path, 'sk-live-abc\ndef');
  assert.equal(await makeBearerCredentialResolver(`token:${path}`).current(), 'sk-live-abcdef');
  process.env.IG_TEST_WRAPPED = 'tok\nen-value';
  try {
    assert.equal(await makeBearerCredentialResolver('env:IG_TEST_WRAPPED').current(), 'token-value');
  } finally {
    delete process.env.IG_TEST_WRAPPED;
  }
});

test('scrubSecrets — redacts sk-ant tokens and generic Bearer values, keeps an identifying prefix', () => {
  const leak = 'Headers.append: "Bearer sk-ant-oat01-dYS9il_gckQSlXtFsyt70QyVa6omAniJ" is an invalid header value';
  const scrubbed = scrubSecrets(leak);
  assert.ok(!scrubbed.includes('dYS9il_gckQSlXtFsyt70QyVa6omAniJ'), 'token body must not survive');
  assert.ok(scrubbed.includes('sk-ant-oat01…[redacted]'), 'keeps the identifying prefix');
  // Generic (non-anthropic) bearer values are redacted too.
  assert.equal(scrubSecrets('Bearer abcdefghijklmnopqrstuvwx failed'), 'Bearer [redacted] failed');
  // Non-secret text passes through untouched.
  assert.equal(scrubSecrets('plain error, no secrets'), 'plain error, no secrets');
});

// ── keychain: channel (P-006, cross-platform-hardening-and-agent-ergonomics-2026-07-05) ──

test('parseCredentialRef — keychain: names the macOS Keychain service', () => {
  assert.deepEqual(parseCredentialRef('keychain:Claude Code-credentials'), {
    kind: 'keychain',
    path: 'Claude Code-credentials',
  });
});

test('keychain resolver — serves the scanned bundle, caches until near expiry, invalidate() re-scans', async () => {
  let reads = 0;
  _setKeychainReaderForTests((service) => {
    assert.equal(service, 'Claude Code-credentials');
    reads++;
    return JSON.stringify({ claudeAiOauth: { accessToken: 'kc-token-1', expiresAt: Date.now() + 60 * 60 * 1000 } });
  });
  try {
    const r = makeCredentialResolver('keychain:Claude Code-credentials');
    assert.equal(r.kind, 'keychain');
    assert.equal(await r.current(), 'kc-token-1');
    assert.equal(await r.current(), 'kc-token-1');
    assert.equal(reads, 1, 'far-from-expiry token is served from cache');
    r.invalidate();
    assert.equal(await r.current(), 'kc-token-1');
    assert.equal(reads, 2, 'invalidate() forces a re-scan');
  } finally {
    _setKeychainReaderForTests(null);
  }
});

test('keychain resolver — near-expiry re-scan is rate-bounded (the scan shells out per item, never per request)', async () => {
  let reads = 0;
  _setKeychainReaderForTests(() => {
    reads++;
    return JSON.stringify({ claudeAiOauth: { accessToken: 'kc-near', expiresAt: Date.now() + 60_000 } }); // inside the 5-min skew
  });
  try {
    const r = makeCredentialResolver('keychain:Claude Code');
    assert.equal(await r.current(), 'kc-near');
    assert.equal(await r.current(), 'kc-near');
    assert.equal(reads, 1, 'a just-completed scan is not repeated per request within the throttle window');
    r.invalidate(); // a 401 bypasses the throttle — the served token is bad NOW
    assert.equal(await r.current(), 'kc-near');
    assert.equal(reads, 2);
  } finally {
    _setKeychainReaderForTests(null);
  }
});

test('keychain resolver — no readable source anywhere throws the UNAUTHENTICATED guidance', async () => {
  _setKeychainReaderForTests(() => null);
  try {
    await assert.rejects(
      makeCredentialResolver('keychain:Claude Code-credentials').current(),
      /UNAUTHENTICATED.*none readable.*Sign in with `claude`/s,
    );
  } finally {
    _setKeychainReaderForTests(null);
  }
  _setKeychainReaderForTests(() => 'not-json'); // a non-bundle payload is skipped, not fatal
  try {
    await assert.rejects(
      makeCredentialResolver('keychain:Claude Code-credentials').current(),
      /UNAUTHENTICATED.*none readable/s,
    );
  } finally {
    _setKeychainReaderForTests(null);
  }
});

// ── keychain freshest-scan (fleet-member-login root-cause fix, 2026-07-06) ─────────────────────
// Claude Code keeps ONE rotating bundle PER config dir (base item + hashed siblings). The gateway
// must serve the freshest LIVE bundle across all of them + the disk file — a stale snapshot in
// any single source must never 401 the whole fleet while a live CLI holds a fresh token.

const BASE = 'Claude Code-credentials';
const hour = 60 * 60 * 1000;
const bundleJson = (accessToken: string, expiresAt?: number, refreshToken?: string) =>
  JSON.stringify({ claudeAiOauth: { accessToken, ...(expiresAt !== undefined ? { expiresAt } : {}), ...(refreshToken ? { refreshToken } : {}) } });

test('freshest-scan — a LIVE hashed sibling wins over a stale base item AND a stale disk bundle (the Mac-VM fleet-member scenario)', async () => {
  const now = Date.now();
  // The disk bundle: the dead snapshot that used to shadow everything (file: took precedence).
  await fs.mkdir(join(dir, '.claude'), { recursive: true });
  await fs.writeFile(join(dir, '.claude', '.credentials.json'), bundleJson('file-stale', now - 12 * hour, 'RT-dead'));
  _setKeychainListerForTests(() => [
    { service: BASE, account: 'u' },
    { service: `${BASE}-6ede4198`, account: 'u' }, // the live CLI session's item
    { service: `${BASE}-b8ad9472`, account: 'u' }, // a long-dead session's item
  ]);
  _setKeychainReaderForTests((service) => {
    if (service === BASE) return bundleJson('base-stale', now - 12 * hour, 'RT-dead');
    if (service === `${BASE}-6ede4198`) return bundleJson('live-cli-token', now + 7 * hour, 'RT-live');
    if (service === `${BASE}-b8ad9472`) return bundleJson('old-stale', now - 290 * hour, 'RT-ancient');
    return null;
  });
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    assert.equal(await r.current(), 'live-cli-token', 'the freshest LIVE bundle is served, wherever it lives');
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
  }
});

test('freshest-scan — a known-future expiry beats no-expiry junk; unknown-expiry serves only when it is all there is', async () => {
  const now = Date.now();
  _setKeychainListerForTests(() => [
    { service: `${BASE}-junk`, account: 'u' },
    { service: `${BASE}-live`, account: 'u' },
  ]);
  _setKeychainReaderForTests((service) => {
    if (service === `${BASE}-junk`) return bundleJson('junk-no-expiry');
    if (service === `${BASE}-live`) return bundleJson('known-live', now + hour);
    return null;
  });
  try {
    assert.equal(await makeCredentialResolver(`keychain:${BASE}`).current(), 'known-live');
  } finally {
    _setKeychainReaderForTests(null);
  }
  _setKeychainReaderForTests((service) => (service === `${BASE}-junk` ? bundleJson('junk-no-expiry') : null));
  try {
    assert.equal(
      await makeCredentialResolver(`keychain:${BASE}`).current(),
      'junk-no-expiry',
      'an unknown-expiry bundle is still better than failing when nothing else exists',
    );
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
  }
});

test('freshest-scan — ALL expired: refreshes the freshest refreshable bundle and persists the rotation back to its Keychain item', async () => {
  const now = Date.now();
  const { provider, refreshes } = fakeClaude();
  registerProvider(provider);
  const writes: { service: string; account: string; secret: string }[] = [];
  _setKeychainListerForTests(() => [
    { service: `${BASE}-older`, account: 'u' },
    { service: `${BASE}-newer`, account: 'u' },
  ]);
  _setKeychainReaderForTests((service) => {
    if (service === `${BASE}-older`) return bundleJson('stale-a', now - 20 * hour, 'RT-older');
    if (service === `${BASE}-newer`) return bundleJson('stale-b', now - 1 * hour, 'RT-newer');
    return null;
  });
  _setKeychainWriterForTests((service, account, secret) => {
    writes.push({ service, account, secret });
    return true;
  });
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    assert.equal(await r.current(), 'refreshed-1');
    assert.equal(refreshes(), 1, 'exactly one refresh — the freshest refreshable bundle');
    assert.equal(writes.length, 1, 'the rotated bundle was persisted');
    assert.equal(writes[0].service, `${BASE}-newer`, 'freshest-first: the most recent bundle holds the valid refresh token');
    assert.equal(writes[0].account, 'u');
    const persisted = JSON.parse(writes[0].secret) as ClaudeCredentialBundle;
    assert.equal(persisted.claudeAiOauth.refreshToken, 'RT-newer-rotated', 'the ROTATED refresh token is what survives');
    assert.equal(persisted.claudeAiOauth.accessToken, 'refreshed-1');
    // the refreshed token is cached — no second refresh on the next call
    assert.equal(await r.current(), 'refreshed-1');
    assert.equal(refreshes(), 1);
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
    _setKeychainWriterForTests(null);
  }
});

test('freshest-scan — a refused Keychain write-back falls back to persisting the disk bundle (rotation must land SOMEWHERE)', async () => {
  const now = Date.now();
  const { provider } = fakeClaude();
  registerProvider(provider);
  _setKeychainListerForTests(() => [{ service: `${BASE}-x`, account: 'u' }]);
  _setKeychainReaderForTests((service) => (service === `${BASE}-x` ? bundleJson('stale', now - hour, 'RT1') : null));
  _setKeychainWriterForTests(() => false); // ACL refused the non-creating writer
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    assert.equal(await r.current(), 'refreshed-1');
    const onDisk = JSON.parse(await fs.readFile(join(dir, '.claude', '.credentials.json'), 'utf8')) as ClaudeCredentialBundle;
    assert.equal(onDisk.claudeAiOauth.refreshToken, 'RT1-rotated');
    assert.equal(onDisk.claudeAiOauth.accessToken, 'refreshed-1');
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
    _setKeychainWriterForTests(null);
  }
});

test('freshest-scan — identical refresh tokens across snapshots are attempted ONCE; total failure throws UNAUTHENTICATED with a negative cache', async () => {
  const now = Date.now();
  let attempts = 0;
  registerProvider({
    id: 'claude',
    config: { clientId: 'x', clientSecret: '', authorizeUrl: 'a', tokenUrl: 't', redirectUri: 'r' },
    buildAuthorizeUrl: () => 'url',
    exchangeCode: async () => ({ accessToken: 'a' }),
    refresh: async () => {
      attempts += 1;
      throw new Error('Refresh token not found or invalid');
    },
  });
  let reads = 0;
  _setKeychainListerForTests(() => [
    { service: `${BASE}-copy1`, account: 'u' },
    { service: `${BASE}-copy2`, account: 'u' },
  ]);
  _setKeychainReaderForTests((service) => {
    reads++;
    if (service === `${BASE}-copy1`) return bundleJson('stale-1', now - 2 * hour, 'RT-same');
    if (service === `${BASE}-copy2`) return bundleJson('stale-2', now - 3 * hour, 'RT-same'); // same family snapshot
    return null;
  });
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    await assert.rejects(r.current(), /UNAUTHENTICATED.*all hard-expired.*refresh attempts failed/s);
    assert.equal(attempts, 1, 'the shared refresh token was attempted once, not once per snapshot');
    const readsAfterFirst = reads;
    await assert.rejects(r.current(), /UNAUTHENTICATED/);
    assert.equal(reads, readsAfterFirst, 'the UNAUTHENTICATED verdict is served from the negative cache, not re-derived per request');
    r.invalidate();
    await assert.rejects(r.current(), /UNAUTHENTICATED/);
    assert.ok(reads > readsAfterFirst, 'invalidate() clears the negative cache so a fresh sign-in is picked up immediately');
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
  }
});

test('freshest-scan — 401 recovery: invalidate() + re-scan picks up a bundle a CLI refreshed in the meantime', async () => {
  const now = Date.now();
  let generation = 1;
  _setKeychainListerForTests(() => [{ service: `${BASE}-live`, account: 'u' }]);
  _setKeychainReaderForTests((service) =>
    service === `${BASE}-live` ? bundleJson(`cli-token-${generation}`, now + generation * hour) : null,
  );
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    assert.equal(await r.current(), 'cli-token-1');
    generation = 2; // the CLI rotated its bundle; upstream 401s our cached token
    r.invalidate();
    assert.equal(await r.current(), 'cli-token-2', 'the very next request serves the CLI-refreshed token — no gateway restart');
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
  }
});

test('makeBearerCredentialResolver — rejects keychain: (Claude-subscription-only channel)', () => {
  assert.throws(() => makeBearerCredentialResolver('keychain:Claude Code'), /keychain: is Claude-subscription-only/);
});

// ── WI-10005306: the freshest-scan's Keychain calls are NON-BLOCKING ─────────────────────────────
// The gateway serves every member's inference from one event loop; the scan shells out to
// `security` once per enumerated item plus a `dump-keychain` of up to 15s. A spawnSync there froze
// every in-flight request for the duration. These pin both halves: the seams are AWAITED (an async
// fake that settles on a later tick is honoured, not read as a truthy Promise), and the source
// never reintroduces a synchronous spawn.

/** Settle `v` on a later macrotask, like a real execFile('security', …) callback. */
const later = <T>(v: T, ms = 5): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(v), ms));

test('freshest-scan — ASYNC Keychain seams are awaited, and the event loop keeps turning during the scan (WI-10005306)', async () => {
  const now = Date.now();
  const { provider } = fakeClaude();
  registerProvider(provider);
  const writes: string[] = [];
  _setKeychainListerForTests(() => later([{ service: `${BASE}-a`, account: 'u' }, { service: `${BASE}-b`, account: 'u' }]));
  _setKeychainReaderForTests((service) =>
    later(service === `${BASE}-b` ? bundleJson('stale-b', now - hour, 'RT-b') : service === `${BASE}-a` ? bundleJson('stale-a', now - 5 * hour, 'RT-a') : null),
  );
  _setKeychainWriterForTests((service) => later((writes.push(service), true)));
  let ticks = 0;
  const ticker = setInterval(() => (ticks += 1), 1);
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    // All-expired → refresh the freshest (b) and persist through the ASYNC writer.
    assert.equal(await r.current(), 'refreshed-1');
    assert.deepEqual(writes, [`${BASE}-b`], 'the async writer resolved true, so no disk fallback ran');
    await assert.rejects(fs.access(join(dir, '.claude', '.credentials.json')), 'a resolved-true async write-back must not ALSO write the disk bundle');
    assert.ok(ticks > 0, 'timers fired while the scan awaited its Keychain calls');
  } finally {
    clearInterval(ticker);
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
    _setKeychainWriterForTests(null);
  }
});

test('freshest-scan — a REJECTING lister/reader/writer is a miss, never a failed request (WI-10005306)', async () => {
  const now = Date.now();
  const { provider } = fakeClaude();
  registerProvider(provider);
  // Lister rejects → the base item is still scanned; a rejecting sibling read is skipped.
  _setKeychainListerForTests(() => Promise.reject(new Error('dump-keychain timed out')));
  _setKeychainReaderForTests((service) =>
    service === BASE ? later(bundleJson('base-stale', now - hour, 'RT-base')) : Promise.reject(new Error('ACL')),
  );
  _setKeychainWriterForTests(() => Promise.reject(new Error('errSecInteractionNotAllowed')));
  try {
    const r = makeCredentialResolver(`keychain:${BASE}`);
    assert.equal(await r.current(), 'refreshed-1', 'the base item still refreshes when enumeration fails');
    const onDisk = JSON.parse(await fs.readFile(join(dir, '.claude', '.credentials.json'), 'utf8')) as ClaudeCredentialBundle;
    assert.equal(onDisk.claudeAiOauth.refreshToken, 'RT-base-rotated', 'a rejecting writer falls back to the disk bundle');
  } finally {
    _setKeychainReaderForTests(null);
    _setKeychainListerForTests(null);
    _setKeychainWriterForTests(null);
  }
});

test('credential-store source — no synchronous spawn, and only the ASYNC Keychain helpers are imported (WI-10005306)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('./credential-store.ts', import.meta.url)), 'utf8');
  // Positive control: the guard is reading the real module, not an empty/wrong file.
  assert.match(source, /export async function scanLocalCredentialCandidates/);
  assert.doesNotMatch(source, /\b(?:spawnSync|execFileSync|execSync)\s*\(/, 'a sync spawn blocks every in-flight gateway request');
  assert.doesNotMatch(
    source,
    /\b(?:listClaudeKeychainCredentialItems|writeClaudeKeychainOAuthBundle|readClaudeKeychainOAuthBundle)\b(?!Async)/,
    'the sync agent-auth-detect Keychain helpers shell out with spawnSync',
  );
});
