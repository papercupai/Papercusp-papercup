/**
 * claude-credential-sync.test.ts — the newest-wins credential reconciler
 * (claude-credential-sync-2026-06-10 P-001).
 *
 * The contract: every real-file `.credentials.json` (global + per-session
 * forks) converges on the newest valid `claudeAiOauth` bundle; symlink aliases
 * are untouched; `mcpOAuth` stays per-file; implausible or refresh-less
 * bundles never win; a converged tree produces zero writes.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileClaudeCredentials, startClaudeCredentialSync } from './claude-credential-sync';
import {
  _setClaudeKeychainAccessForTests,
  _setClaudeKeychainAsyncAccessForTests,
  type KeychainAccess,
} from './agent-auth-detect';

const NOW = 1_780_000_000_000;
const HOUR = 60 * 60 * 1000;

let home: string;
let sessionRoot: string;

function bundle(expiresAt: number, tag: string, extra: Record<string, unknown> = {}) {
  return {
    accessToken: `sk-ant-oat01-${tag}`,
    refreshToken: `sk-ant-ort01-${tag}`,
    expiresAt,
    scopes: ['user:inference'],
    subscriptionType: 'max',
    ...extra,
  };
}

function writeCreds(path: string, json: unknown) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(json, null, 2), { mode: 0o600 });
}

function globalPath() {
  return join(home, '.claude', '.credentials.json');
}

function sessionPath(id: string) {
  return join(sessionRoot, id, '.credentials.json');
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run() {
  return reconcileClaudeCredentials({ home, sessionRoot, now: NOW });
}

// ── macOS Keychain bridge test harness (REQ B) ────────────────────────────────
let keychainWrites: Array<{ service: string; account: string; secret: string }> = [];
function installFakeKeychain(readSecret: string | null, writeOk = true) {
  keychainWrites = [];
  const access: KeychainAccess = {
    read: (service) => (service === 'Claude Code-credentials' ? readSecret : null),
    write: (service, account, secret) => {
      keychainWrites.push({ service, account, secret });
      return writeOk;
    },
  };
  _setClaudeKeychainAccessForTests(access);
}
function runMac() {
  return reconcileClaudeCredentials({ home, sessionRoot, now: NOW, platform: 'darwin', keychainAccount: 'testuser' });
}
function kcSecret(expiresAt: number, tag: string) {
  return JSON.stringify({ claudeAiOauth: bundle(expiresAt, tag) });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'credsync-home-'));
  sessionRoot = mkdtempSync(join(tmpdir(), 'credsync-sessions-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
  _setClaudeKeychainAccessForTests(null);
});

describe('reconcileClaudeCredentials', () => {
  it('propagates the newest session bundle to the global file and stale forks', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old'), mcpOAuth: { g: 1 } });
    writeCreds(sessionPath('su-stale'), { claudeAiOauth: bundle(NOW + 2 * HOUR, 'mid'), mcpOAuth: { s: 2 } });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = await run();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(r.updated.sort()).toEqual([globalPath(), sessionPath('su-stale')].sort());
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    expect(readJson(sessionPath('su-stale')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    // mcpOAuth (and any sibling keys) stay per-file.
    expect(readJson(globalPath()).mcpOAuth).toEqual({ g: 1 });
    expect(readJson(sessionPath('su-stale')).mcpOAuth).toEqual({ s: 2 });
    // The winner itself is never rewritten.
    expect(readJson(sessionPath('su-fresh')).accessToken).toBeUndefined();
    // Atomic writes keep credentials private.
    expect(statSync(globalPath()).mode & 0o777).toBe(0o600);
  });

  it('is idempotent: a converged tree produces zero writes', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });

    expect((await run()).updated).toEqual([sessionPath('su-a')]);
    expect((await run()).updated).toEqual([]);
  });

  it('skips symlinked session entries (they alias the global file)', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    mkdirSync(join(sessionRoot, 'su-linked'), { recursive: true });
    symlinkSync(globalPath(), sessionPath('su-linked'));
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = await run();

    expect(lstatSync(sessionPath('su-linked')).isSymbolicLink()).toBe(true);
    expect(r.updated).toEqual([globalPath()]);
    // The alias sees the propagated bundle THROUGH the global file.
    expect(readJson(sessionPath('su-linked')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
  });

  it('never lets invalid bundles win: no refreshToken, implausible expiry, garbage', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'real') });
    // A setup-token-shaped bundle (no refreshToken) with a 1-year expiry.
    writeCreds(sessionPath('su-setup'), {
      claudeAiOauth: { ...bundle(NOW + 365 * 24 * HOUR, 'setup'), refreshToken: undefined },
    });
    // Forged absurd-future expiry.
    writeCreds(sessionPath('su-forged'), { claudeAiOauth: bundle(NOW + 60 * 24 * HOUR, 'forged') });
    // Corrupt JSON (half-written file).
    mkdirSync(join(sessionRoot, 'su-corrupt'), { recursive: true });
    writeFileSync(sessionPath('su-corrupt'), '{"claudeAiOauth": {"accessTo');

    const r = await run();

    expect(r.winner?.path).toBe(globalPath());
    // The corrupt fork is healed with the winner; invalid-but-parseable forks too.
    expect(readJson(sessionPath('su-corrupt')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-real');
    expect(readJson(sessionPath('su-forged')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-real');
  });

  it('restores a missing global file from the freshest fork', async () => {
    writeCreds(sessionPath('su-only'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new'), mcpOAuth: { s: 1 } });

    const r = await run();

    expect(r.updated).toEqual([globalPath()]);
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    // A restored global is bundle-only — it does NOT inherit the fork's mcpOAuth.
    expect(readJson(globalPath()).mcpOAuth).toBeUndefined();
    expect(statSync(globalPath()).mode & 0o777).toBe(0o600);
  });

  it('does NOT materialize ~/.claude from a fork when the dir is absent — then promotes once it exists', async () => {
    // A truly fresh box: NO ~/.claude dir at all. A `claude /login` done INSIDE
    // a psu session leaves a real fork, but reconcile deliberately won't create
    // ~/.claude here — so the lone fork is stranded and a new psu session can't
    // inherit it ("launches logged out"). This is exactly why
    // writeInteractiveClaudeConfig now mkdir's ~/.claude BEFORE reconciling.
    // (psu-login-inherit: fresh-box credential promotion.)
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    writeCreds(sessionPath('su-only'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = await run();
    // Fork is the winner, but with no ~/.claude nothing is promoted to global.
    expect(r.winner?.path).toBe(sessionPath('su-only'));
    expect(r.updated).toEqual([]);
    expect(existsSync(globalPath())).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);

    // Pre-creating ~/.claude (what writeInteractiveClaudeConfig now does) lets
    // the SAME reconcile lift the fork to the global → inheritance works.
    mkdirSync(join(home, '.claude'), { recursive: true });
    const r2 = await run();
    expect(r2.updated).toEqual([globalPath()]);
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
  });

  it('no-ops when nothing valid exists anywhere', async () => {
    writeCreds(globalPath(), { mcpOAuth: { g: 1 } });
    const r = await run();
    expect(r.winner).toBeNull();
    expect(r.updated).toEqual([]);
    expect(readJson(globalPath())).toEqual({ mcpOAuth: { g: 1 } });
  });

  it('expired-but-newest still wins (an expired family member may still refresh)', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW - 4 * HOUR, 'older') });
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW - 1 * HOUR, 'newest') });

    const r = await run();

    expect(r.winner?.path).toBe(sessionPath('su-a'));
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-newest');
  });
});

describe('reconcileClaudeCredentials — macOS Keychain bridge (REQ B)', () => {
  it('darwin: seeds the global file from the login Keychain when no file creds exist', async () => {
    // The owner's exact case: a signed-in Mac (creds in the Keychain, no ~/.claude/.credentials.json).
    installFakeKeychain(kcSecret(NOW + 8 * HOUR, 'kc'));

    const r = await runMac();

    expect(r.winner?.path).toMatch(/^keychain:/);
    expect(r.updated).toEqual([globalPath()]);
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-kc');
    // A materialized global is bundle-only.
    expect(readJson(globalPath()).mcpOAuth).toBeUndefined();
    expect(statSync(globalPath()).mode & 0o777).toBe(0o600);
    // The Keychain IS the source here → no write-back, and no bogus "keychain:*" file written.
    expect(r.keychainWriteBack).toBeNull();
    expect(keychainWrites).toEqual([]);
    expect(existsSync(join(process.cwd(), 'keychain:Claude Code-credentials'))).toBe(false);
  });

  it('darwin: propagates the Keychain bundle into a stale session fork (sibling keys preserved)', async () => {
    installFakeKeychain(kcSecret(NOW + 8 * HOUR, 'kc'));
    writeCreds(sessionPath('su-stale'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old'), mcpOAuth: { s: 1 } });

    const r = await runMac();

    expect(r.winner?.path).toMatch(/^keychain:/);
    expect(r.updated.sort()).toEqual([globalPath(), sessionPath('su-stale')].sort());
    expect(readJson(sessionPath('su-stale')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-kc');
    expect(readJson(sessionPath('su-stale')).mcpOAuth).toEqual({ s: 1 });
    expect(keychainWrites).toEqual([]);
  });

  it('darwin: writes a newer fork bundle BACK to the Keychain (keeps the direct claude fresh)', async () => {
    // A psu fork refreshed → its bundle out-dates the Keychain → must flow back so the owner's
    // direct `claude` (a Keychain reader) does not re-login when its own token expires.
    installFakeKeychain(kcSecret(NOW + 2 * HOUR, 'kc'));
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 2 * HOUR, 'kc') });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'refreshed') });

    const r = await runMac();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-refreshed');
    expect(r.keychainWriteBack).toEqual({ service: 'Claude Code-credentials', expiresAt: NOW + 8 * HOUR });
    expect(keychainWrites).toHaveLength(1);
    expect(keychainWrites[0]).toMatchObject({ service: 'Claude Code-credentials', account: 'testuser' });
    expect(JSON.parse(keychainWrites[0].secret).claudeAiOauth.accessToken).toBe('sk-ant-oat01-refreshed');
    // The read-only Keychain candidate is never written as a file.
    expect(existsSync(join(process.cwd(), 'keychain:Claude Code-credentials'))).toBe(false);
  });

  it('darwin: a converged Keychain==file tree produces zero writes and no write-back', async () => {
    installFakeKeychain(kcSecret(NOW + 8 * HOUR, 'kc'));
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'kc') });

    const r = await runMac();

    expect(r.updated).toEqual([]);
    expect(r.keychainWriteBack).toBeNull();
    expect(keychainWrites).toEqual([]);
  });

  it('darwin: an ACL-blocked / absent Keychain read leaves pure-file behaviour intact', async () => {
    installFakeKeychain(null); // errSecInteractionNotAllowed (non-GUI) or not signed in
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = await runMac();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(r.updated).toEqual([globalPath()]);
    expect(r.keychainWriteBack).toBeNull();
    expect(keychainWrites).toEqual([]);
  });

  it('darwin: a failed Keychain write-back still propagates to files (degrades, never throws)', async () => {
    installFakeKeychain(kcSecret(NOW + 2 * HOUR, 'kc'), /* writeOk */ false);
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'refreshed') });

    const r = await runMac();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-refreshed');
    expect(keychainWrites).toHaveLength(1); // attempted…
    expect(r.keychainWriteBack).toBeNull(); // …but not confirmed
  });

  it('non-darwin ignores the Keychain even if a reader would return a (winning) bundle', async () => {
    installFakeKeychain(kcSecret(NOW + 20 * 24 * HOUR, 'kc')); // huge (but plausible) expiry → would win IF consulted
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });

    const r = await reconcileClaudeCredentials({ home, sessionRoot, now: NOW, platform: 'linux', keychainAccount: 'testuser' });

    expect(r.winner?.path).toBe(globalPath());
    expect(r.keychainWriteBack).toBeNull();
    expect(keychainWrites).toEqual([]);
  });

  // WI-10005231: the reconcile runs on the operator main thread, so its Keychain calls must go
  // through the NON-BLOCKING helpers. This fake exists only behind the async seam and settles on a
  // later tick: a reconcile that still used the spawnSync helpers would never consult it (and would
  // block the host for the `security` call on a real Mac), so the seeded global would be missing.
  it('darwin: reads and writes the Keychain through the non-blocking helpers', async () => {
    const asyncWrites: string[] = [];
    const later = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 1));
    _setClaudeKeychainAsyncAccessForTests({
      read: (service) => later(service === 'Claude Code-credentials' ? kcSecret(NOW + 2 * HOUR, 'kc') : null),
      write: (service) => {
        asyncWrites.push(service);
        return later(true);
      },
    });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const r = await runMac();

    expect(r.winner?.path).toBe(sessionPath('su-fresh'));
    expect(r.keychainWriteBack).toEqual({ service: 'Claude Code-credentials', expiresAt: NOW + 8 * HOUR });
    expect(asyncWrites).toEqual(['Claude Code-credentials']);
  });

  it('the reconcile source never calls the blocking Keychain helpers', () => {
    const source = readFileSync(fileURLToPath(new URL('./claude-credential-sync.ts', import.meta.url)), 'utf8');
    expect(source).toMatch(/readClaudeKeychainOAuthBundleAsync\(/);
    expect(source).not.toMatch(/\b(?:read|write)ClaudeKeychainOAuthBundle\(/);
    // Call shapes only: prose in comments may name the primitive it is avoiding.
    expect(source).not.toMatch(/\b(?:spawnSync|execFileSync|execSync)\s*\(/);
  });
});

describe('startClaudeCredentialSync — depth-bounded session watch (2026-07-10 meltdown guard)', () => {
  // The recursive fs.watch this replaced held ~94.5k inotify watches per process
  // (Node's Linux userland recursive fallback walked every <owner>/projects/**
  // transcript dir) and rescan-stormed 16 cluster workers into a load-1100 host
  // meltdown. The contract now: the watch set stays O(owner dirs) — root + one
  // level — and NEVER descends into deep per-session trees.
  it('watches only sessionRoot + owner dirs; deep transcript trees stay unwatched; a fork write still propagates', async () => {
    // Owner fork with a DEEP churn tree (the transcript shape that melted the host).
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    const deep = join(sessionRoot, 'su-a', 'projects', 'munged-cwd', 'nested');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'transcript.jsonl'), '{}\n');
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 2 * HOUR, 'mid') });

    const handle = startClaudeCredentialSync({ home, sessionRoot });
    try {
      const watcher = handle._sessionWatcherForTests;
      expect(watcher).toBeTruthy();
      await new Promise<void>((resolve) => watcher!.once('ready', () => resolve()));

      // Watch set: sessionRoot + su-a (depth 1). Nothing under projects/.
      const watchedDirs = Object.keys(watcher!.getWatched());
      expect(watchedDirs).toContain(sessionRoot);
      expect(watchedDirs).toContain(join(sessionRoot, 'su-a'));
      expect(watchedDirs.some((d) => d.includes('projects'))).toBe(false);

      // A fork refresh (newest bundle written into an owner dir) still propagates
      // through the watcher → debounce → reconcile, without any recursive watching.
      writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'fresh') });
      await vi.waitFor(
        () => {
          expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-fresh');
        },
        { timeout: 10_000, interval: 250 },
      );
    } finally {
      handle.stop();
    }
  }, 20_000);
});

describe('reconcileClaudeCredentials — off the event loop (WI-10005186)', () => {
  // The pass runs on the operator MAIN THREAD (the background pass and the bootstrap/
  // resume request routes via writeInteractiveClaudeConfig). Synchronous, a propagating
  // pass did one temp-write + rename per real-file fork (76 on the dev box) and froze the
  // event loop in ext4 journal waits (:3170 2026-10-02 02:00:07Z: STALLED D, wchan
  // wait_transaction_locked, syscall rename, path <owner>/.credentials.json.credsync-*).
  const SYNC_CALL = /\b\w+Sync\s*\(/g;

  /** Event-loop turns (setImmediate callbacks) that run while `start()`'s promise is pending.
   *  A synchronous body — even one wrapped in `async` or deferred to a microtask — settles
   *  before any setImmediate callback runs, so it reads 0. */
  async function turnsDuring(start: () => Promise<unknown>): Promise<number> {
    let turns = 0;
    let done = false;
    const spin = () => {
      if (done) return;
      turns++;
      setImmediate(spin);
    };
    setImmediate(spin);
    try {
      await start();
    } finally {
      done = true;
    }
    return turns;
  }

  it('control: the turn counter reads 0 for a synchronous pass dressed as async', async () => {
    const syncPass = async () => {
      for (let i = 0; i < 20; i++) writeCreds(sessionPath(`su-${i}`), { claudeAiOauth: bundle(NOW, `c${i}`) });
    };
    expect(await turnsDuring(syncPass)).toBe(0);
    expect(await turnsDuring(() => Promise.resolve().then(syncPass))).toBe(0);
  });

  it('yields to the event loop while the pass is in flight (a sync body would not)', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    for (let i = 0; i < 20; i++) writeCreds(sessionPath(`su-${i}`), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    let r: Awaited<ReturnType<typeof run>> | undefined;
    const turns = await turnsDuring(async () => {
      const pending = run();
      // Nothing is written synchronously at the call site.
      expect(readJson(globalPath()).claudeAiOauth.accessToken).toBe('sk-ant-oat01-old');
      r = await pending;
    });

    expect(r?.updated).toHaveLength(21);
    expect(readJson(sessionPath('su-0')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
    expect(turns).toBeGreaterThan(0);
  });

  it('code-shape guard: the pass path makes no synchronous call', () => {
    // CREDSYNC_SHAPE_SUBJECT lets a copy-out mutation probe point this guard at a mutant.
    const subject =
      process.env.CREDSYNC_SHAPE_SUBJECT ?? fileURLToPath(new URL('./claude-credential-sync.ts', import.meta.url));
    const src = readFileSync(subject, 'utf8');
    const end = src.indexOf('export function startClaudeCredentialSync');
    expect(end).toBeGreaterThan(0); // the anchor exists — otherwise this guard checks nothing
    const code = src
      .slice(0, end)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).toContain('async function reconcileOnce'); // the region really holds the pass
    expect(code.match(SYNC_CALL) ?? []).toEqual([]);
    // Positive control: the detector does see a sync call when one is present.
    expect('const s = lstatSync(p); renameSync (a, b);'.match(SYNC_CALL)).toHaveLength(2);
  });

  it('compare-before-swap: a fork that refreshes between the scan and the write is not clobbered', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'winner') });
    writeCreds(sessionPath('su-racer'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });

    const r = await reconcileClaudeCredentials({
      home,
      sessionRoot,
      now: NOW,
      // claude rotates this fork's token after the scan read it, before our write lands.
      _beforeWriteForTests: (p) => {
        if (p === sessionPath('su-racer')) writeCreds(p, { claudeAiOauth: bundle(NOW + 9 * HOUR, 'rotated') });
      },
    });

    expect(r.updated).toEqual([]);
    expect(readJson(sessionPath('su-racer')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-rotated');
  });

  it('compare-before-swap: merges onto the FRESH file, keeping sibling keys written since the scan', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'winner') });
    writeCreds(sessionPath('su-a'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old'), mcpOAuth: { s: 1 } });

    const r = await reconcileClaudeCredentials({
      home,
      sessionRoot,
      now: NOW,
      _beforeWriteForTests: (p) => {
        if (p === sessionPath('su-a')) {
          writeCreds(p, { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old'), mcpOAuth: { s: 2 } });
        }
      },
    });

    expect(r.updated).toEqual([sessionPath('su-a')]);
    expect(readJson(sessionPath('su-a')).claudeAiOauth.accessToken).toBe('sk-ant-oat01-winner');
    expect(readJson(sessionPath('su-a')).mcpOAuth).toEqual({ s: 2 });
  });

  it('serializes overlapping passes: the second sees the converged tree and writes nothing', async () => {
    writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    for (let i = 0; i < 10; i++) writeCreds(sessionPath(`su-${i}`), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
    writeCreds(sessionPath('su-fresh'), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'new') });

    const [a, b] = await Promise.all([run(), run()]);

    expect(a.updated).toHaveLength(11);
    expect(b.updated).toEqual([]);
  });

  it('a failed swap removes its temp file and the pass carries on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeCreds(globalPath(), { claudeAiOauth: bundle(NOW + 8 * HOUR, 'winner') });
      writeCreds(sessionPath('su-blocked'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });
      writeCreds(sessionPath('su-ok'), { claudeAiOauth: bundle(NOW + 1 * HOUR, 'old') });

      const r = await reconcileClaudeCredentials({
        home,
        sessionRoot,
        now: NOW,
        // The target turns into a non-empty directory, so the rename onto it fails.
        _beforeWriteForTests: (p) => {
          if (p === sessionPath('su-blocked')) {
            rmSync(p, { force: true });
            mkdirSync(join(p, 'occupied'), { recursive: true });
          }
        },
      });

      expect(r.updated).toEqual([sessionPath('su-ok')]);
      expect(readdirSync(join(sessionRoot, 'su-blocked')).filter((n) => n.includes('.credsync-'))).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
