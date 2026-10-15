/**
 * EI-22176521893516708 — the PreToolUse hook's ORPHANED-CLAIM RECONCILE.
 *
 * Several PreToolUse hooks share the acquire hook's matcher (control-bytes,
 * secrets, content-lint, the migration/generated-file guards). The lock is
 * claimed first; one of THEM can then deny the call. A denied tool call never
 * reaches PostToolUse, so the release never runs and the lock is held for its
 * full 20-minute TTL over a write that never happened — and git-sync excludes
 * every actively-locked path from its sweep, which is how a change half-lands
 * (a committed test importing a still-untracked module).
 *
 * The hook cannot see another hook's verdict, so it reconciles: each run it
 * sweeps cache entries whose PostToolUse demonstrably never arrived.
 *
 * The false-POSITIVE direction is the expensive one here — releasing a lock
 * for an edit that is genuinely in flight would corrupt the very serialization
 * the lock exists to provide, and would do it silently. So the discrimination
 * cases below (grace window, peer-owned, batch-owned) matter at least as much
 * as the release case, and `releases the orphan` is the calibration control
 * that stops all of them passing on a sweep that simply never fires.
 *
 * ⚠ Use `runHookProcess` (async spawn), never `spawnSync`. The stub operator
 * lives in THIS process, and spawnSync blocks the event loop for the whole
 * child — so the hook's HTTP call cannot be served, every acquire fails open,
 * and the suite reports the reconcile as broken when only the harness was.
 */
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runHookProcess } from './spawn-hook';

const HOOK = join(__dirname, '..', 'pretooluse-locks-acquire.sh');
const OWNER = 'su-orphan-sweep-test';
const GRACE_SEC = 2;
const EXPIRED_SEC = 100;

/** Keep the hook fixture independent of the Papercusp/Claude session that launched Vitest. */
function hookFixtureEnv(
  overrides: Record<string, string | undefined>,
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const inherited = Object.fromEntries(
    Object.entries(parentEnv).filter(
      ([key]) => !key.startsWith('PAPERCUSP_') && !key.startsWith('CLAUDE_'),
    ),
  );
  return { ...inherited, ...overrides };
}

let home: string, cache: string, ws: string, repo: string;
let server: Server, port: number;
let requests: Array<{ name: string; args: Record<string, any> }> = [];
let releaseInner: unknown = { ok: true };

beforeAll(async () => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'orphansweep-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  fs.writeFileSync(join(home, '.papercusp', 'su-agent-id'), 'test-agent\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'orphansweep-cache-'));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'orphansweep-ws-')));
  repo = join(ws, 'papercusp');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(join(repo, '.git'), 'gitdir: /nonexistent\n');

  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, any>;
      const name = parsed.params?.name as string;
      requests.push({ name, args: parsed.params?.arguments ?? {} });
      const inner =
        name === 'locks:release' ? releaseInner : { ok: true, lock_id: 'fresh-lock' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(inner) }] },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
  for (const d of [home, cache, ws]) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  releaseInner = { ok: true };
  for (const f of fs.readdirSync(cache)) fs.rmSync(join(cache, f), { force: true });
});

/** Seed a cached claim as the acquire hook would have written it, aged by `ageSec`. */
function seed(
  base: string,
  opts: { lockId: string; owner?: string; ageSec: number; batch?: boolean },
) {
  fs.writeFileSync(join(cache, `${base}.lock`), opts.lockId);
  fs.writeFileSync(join(cache, `${base}.paths`), JSON.stringify(['a.ts']));
  fs.writeFileSync(join(cache, `${base}.owner`), opts.owner ?? OWNER);
  if (opts.batch) fs.writeFileSync(join(cache, `${base}.batch`), '{}');
  const when = new Date(Date.now() - opts.ageSec * 1000);
  for (const suffix of ['.lock', '.paths', '.owner', ...(opts.batch ? ['.batch'] : [])]) {
    fs.utimesSync(join(cache, `${base}${suffix}`), when, when);
  }
}

/** Run the hook for one ordinary edit; the sweep runs before its acquire. */
async function runEdit(
  toolUseId = 'live-edit',
  hookEnvOverrides: Record<string, string | undefined> = {},
) {
  const file = join(repo, 'target.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  return runHookProcess('bash', [HOOK], {
    input: JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: file },
      tool_use_id: toolUseId,
      session_id: 'session-x',
      cwd: repo,
    }),
    env: hookFixtureEnv({
      ...hookEnvOverrides,
      HOME: home,
      PAPERCUSP_SID: OWNER,
      PAPERCUSP_LOCK_SID: OWNER,
      PAPERCUSP_LOCKS_CACHE_DIR: cache,
      PAPERCUSP_WORKSPACE_ROOT: ws,
      PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${port}`,
      PAPERCUSP_LOCKS_ORPHAN_GRACE_SEC: String(GRACE_SEC),
      PAPERCUSP_LOCKS_ORPHAN_EXPIRED_SEC: String(EXPIRED_SEC),
    }),
  });
}

const releasedIds = () =>
  requests.filter((r) => r.name === 'locks:release').flatMap((r) => r.args.lock_ids ?? []);
const exists = (name: string) => fs.existsSync(join(cache, name));

describe('EI-22176521893516708 — orphaned-claim reconcile', () => {
  it('keeps hook fixtures isolated from inherited agent-session variables', () => {
    const env = hookFixtureEnv(
      {
        PAPERCUSP_SID: OWNER,
        PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:12345',
      },
      {
        PATH: '/usr/bin',
        PAPERCUSP_AGENT_SESSION: '1',
        PAPERCUSP_FOREIGN_OFFER_ID: 'parent-offer',
        PAPERCUSP_OPERATOR_URL: 'http://session-only.invalid',
        CLAUDE_CODE_SESSION_ID: 'parent-session',
      },
    );

    expect(env.PATH).toBe('/usr/bin');
    expect(env.PAPERCUSP_SID).toBe(OWNER);
    expect(env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:12345');
    expect(env.PAPERCUSP_AGENT_SESSION).toBeUndefined();
    expect(env.PAPERCUSP_FOREIGN_OFFER_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('filters an inherited foreign offer before the host orphan sweep', async () => {
    const priorOffer = process.env.PAPERCUSP_FOREIGN_OFFER_ID;
    process.env.PAPERCUSP_FOREIGN_OFFER_ID = 'inherited-offer';
    try {
      seed('orphan', { lockId: 'orphan-lock', ageSec: GRACE_SEC + 5 });
      await runEdit('inherited-offer-edit');
      expect(releasedIds()).toContain('orphan-lock');
      expect(exists('last-orphan-sweep.json')).toBe(true);
    } finally {
      if (priorOffer === undefined) delete process.env.PAPERCUSP_FOREIGN_OFFER_ID;
      else process.env.PAPERCUSP_FOREIGN_OFFER_ID = priorOffer;
    }
  });

  it('fails closed on an explicit foreign offer before orphan sweeping', async () => {
    seed('orphan', { lockId: 'orphan-lock', ageSec: GRACE_SEC + 5 });
    const r = await runEdit('foreign-offer-edit', {
      PAPERCUSP_FOREIGN_OFFER_ID: 'controlled-offer',
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.name).toBeUndefined();
    expect(releasedIds()).not.toContain('orphan-lock');
    expect(exists('orphan.lock')).toBe(true);
    expect(exists('last-orphan-sweep.json')).toBe(false);
  });

  it('releases an orphan whose PostToolUse never ran, and clears its cache entry', async () => {
    seed('orphan', { lockId: 'orphan-lock', ageSec: GRACE_SEC + 5 });
    const r = await runEdit();
    expect(r.status).toBe(0);
    expect(releasedIds()).toContain('orphan-lock');
    expect(exists('orphan.lock')).toBe(false);
    expect(exists('orphan.owner')).toBe(false);
  });

  it('sweeps BEFORE acquiring, so a retry blocked by its own orphan self-heals', async () => {
    seed('orphan', { lockId: 'orphan-lock', ageSec: GRACE_SEC + 5 });
    await runEdit();
    // Ordering is the whole point: releasing after the acquire would leave the
    // retry refused by the lock its own blocked attempt had just created.
    const names = requests.map((r) => r.name);
    expect(names.indexOf('locks:release')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('locks:release')).toBeLessThan(names.indexOf('locks:acquire'));
  });

  it('leaves a claim inside the grace window alone — it may be the edit in flight', async () => {
    seed('inflight', { lockId: 'inflight-lock', ageSec: 0 });
    await runEdit();
    expect(releasedIds()).not.toContain('inflight-lock');
    expect(exists('inflight.lock')).toBe(true);
  });

  it("leaves a peer's orphan alone — only its owner can release it", async () => {
    seed('peer', { lockId: 'peer-lock', ageSec: GRACE_SEC + 5, owner: 'su-someone-else' });
    await runEdit();
    expect(releasedIds()).not.toContain('peer-lock');
    expect(exists('peer.lock')).toBe(true);
  });

  it('leaves a batch claim to the PostToolBatch cleanup that owns it', async () => {
    seed('batched', { lockId: 'batch-lock', ageSec: GRACE_SEC + 5, batch: true });
    await runEdit();
    expect(releasedIds()).not.toContain('batch-lock');
    expect(exists('batched.lock')).toBe(true);
  });

  it('prunes an entry past the lock TTL from disk WITHOUT an operator call', async () => {
    seed('expired', { lockId: 'expired-lock', ageSec: EXPIRED_SEC + 5 });
    await runEdit();
    // The row is already gone server-side; spending a release call on it would
    // be pure noise, but the cache litter still has to go.
    expect(releasedIds()).not.toContain('expired-lock');
    expect(exists('expired.lock')).toBe(false);
    expect(exists('expired.paths')).toBe(false);
  });

  it('keeps the cache entry when the release fails, so the next edit retries', async () => {
    releaseInner = { ok: false, reason: 'nope' };
    seed('retry', { lockId: 'retry-lock', ageSec: GRACE_SEC + 5 });
    await runEdit();
    expect(releasedIds()).toContain('retry-lock');
    expect(exists('retry.lock')).toBe(true);
  });

  it('records the sweep in a marker — a reconcile that releases locks is never silent', async () => {
    seed('orphan', { lockId: 'orphan-lock', ageSec: GRACE_SEC + 5 });
    await runEdit();
    const marker = JSON.parse(fs.readFileSync(join(cache, 'last-orphan-sweep.json'), 'utf8'));
    expect(marker.released).toContain('orphan-lock');
    expect(marker.owner).toBe(OWNER);
  });

  it('stamps .owner on a granted claim, so the sweep has an owner to match on', async () => {
    // Guards the wiring, not just the logic: an unstamped claim would make the
    // owner check above reject every one of this session's own orphans, leaving
    // the sweep present but permanently unreachable.
    await runEdit('granted-edit');
    expect(fs.readFileSync(join(cache, 'granted-edit.owner'), 'utf8')).toBe(OWNER);
  });
});
