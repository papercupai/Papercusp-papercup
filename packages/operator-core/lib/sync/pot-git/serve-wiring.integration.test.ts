/**
 * serve-wiring.integration.test.ts — P-201 end to end: `wireHiveGitServe` +
 * `openHiveGitFetchDuplex` over TWO REAL Protomux instances on a
 * `@hyperswarm/secret-stream`-framed unix-socket pair (standing in for the
 * hive-swarm connection), driving a REAL `git upload-pack` ↔ `git fetch`
 * round trip (git on PATH, no swarm/DHT). Exercises the mode gate against the
 * REAL federated settings store (git-sync-action.ts's own dependency,
 * unmocked here on purpose).
 *
 * WHY SecretStream AND NOT A BARE net.Socket (WI-3490 live finding,
 * 2026-07-09): Protomux's own contract (its README: "By framed stream, it has
 * to be a stream that preserves the messages, ie something that length
 * prefixes like @hyperswarm/secret-stream") REQUIRES a message-framed
 * transport — a bare `net.Socket` is a raw byte stream with NO such
 * guarantee. Wiring `wireHiveGitServe`/`openHiveGitFetchDuplex` directly onto
 * raw sockets (the original shape of this test) reproduced a genuine, 100%
 * deterministic hang OUTSIDE vitest/PG too (a standalone tsx repro): two
 * small writes issued close together (the channel's "open" control message
 * immediately followed by the "req" data message) land in ONE 'data' event
 * on the receiving raw socket (confirmed via a `net.Socket.prototype.write`
 * + `Protomux.prototype._ondata` monkeypatch: a single 68-byte chunk = the
 * 55-byte open + the 13-byte req coalesced) — but `Protomux._ondata` decodes
 * only ONE message per 'data' event, so the coalesced `req` bytes are
 * silently never dispatched and `handleReq` never fires. This is a
 * TEST-HARNESS bug, not a `serve-wiring.ts` production bug: the real
 * hive-swarm connection's `noiseStream` already provides this framing
 * natively, so production is unaffected. Wrapping each raw socket end in a
 * `SecretStream(isInitiator, rawSocket)` (already a transitive dependency via
 * `apps/operator`'s `hyperswarm`/`corestore`/`hyperbee` deps — same hoisted-
 * import pattern `lib/sync/hyperbee/swarm.ts` already relies on for
 * `protomux`/`corestore`) reproduces the REAL connection's framing and the
 * hang disappears (confirmed via the same standalone repro).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/serve-wiring.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import SecretStream from '@hyperswarm/secret-stream';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes (not re-exported from the index) — same pattern as _baseline-coord-fixture.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { defaultRunGit, ensurePotGitRepo } from './storage';
import { fetchOverDuplex } from './fetch-transport';
import { wireHiveGitServe, openHiveGitFetchDuplex, _testing as serveTesting } from './serve-wiring';
import { scopeRepoWireKey } from './scope-repo';
import { setPotGitMode, getPotGitMode } from '../../harness/git-sync/hive-git-mode';
import { addRevokedHivePubkeys, upsertHiveMember } from '../../hive-membership-store';
import { loadRevokedHivePubkeysForLocalPot, unsafeFederatedPotScope } from '../../federated-pot-scope';

const WORKSPACE_ID = `ws-serve-wiring-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-serve-wiring-${randomUUID().slice(0, 8)}`;
const TOPIC = Buffer.alloc(32, 7); // a fixed 32-byte stand-in for the hive topic
// A fake-but-valid raw-32-byte Ed25519 pubkey — setPotGitMode/setHiveSetting
// enforce a real Hive row exists (getHiveBySlug), same fixture idiom as
// hive-settings-store.integration.test.ts's own `pk()` helper.
const FAKE_PUBKEY = Buffer.alloc(32, 9).toString('base64');
// WI-10006832: the serve gate admits only a verified device that a member of this pot attests.
// The shared server below identifies every client socket as CLIENT_DEVICE, attested in beforeAll.
const CLIENT_DEVICE = Buffer.alloc(32, 13).toString('base64');
const CLIENT_MEMBER_ID = 4141;
const HIVE_SCOPE_REASON = 'test fixture: this hive home is its own federated scope';
function attestation(devicePubkey: string) {
  return {
    device_pubkey: devicePubkey,
    gist_id: `gist-${devicePubkey.slice(0, 6)}`,
    gist_url: '',
    device_label: 'test-device',
    created_at: Date.now(),
    signature_by_device: '',
  };
}

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

describe('pot-git serve-wiring (P-201: serveUploadPack over the papercusp/pot-git Protomux channel)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let clientSocket: Socket;
  let clientNoise: InstanceType<typeof SecretStream>;
  let sha = '';
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    // `wireHiveGitServe`'s internal mode-check (serve-wiring.ts) calls
    // getPotGitMode with NO sql override — it always reads through the
    // ambient getOrgPg() singleton (the one real pool in production). So a
    // Hive row created in an ISOLATED createOrgTestDb() container would be
    // invisible to it. Fix: env-route getOrgPg() itself at this throwaway
    // migrated DB (the `_baseline-coord-fixture.ts` pattern) so every no-sql
    // call in this test — ours AND serve-wiring.ts's internal one — resolves
    // to the SAME database.
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    // The throwaway container has no PgBouncer in front; on a server-class dev
    // box getOrgPg()'s pgbouncer rewrite would otherwise redirect these reads
    // to the box's OWN pooler (wrong Postgres entirely) — same guard
    // _baseline-coord-fixture.ts uses.
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    // A Hive row must exist — setHiveSetting/setPotGitMode enforce the
    // logical scope via getHiveBySlug (same fixture idiom as
    // hive-settings-store.integration.test.ts). No explicit `sql` — this
    // goes through the now env-routed getOrgPg(), same as production.
    await insertHiveIfAbsent({
      workspaceId: WORKSPACE_ID,
      homeSlug: HIVE,
      pubkeyBase64: FAKE_PUBKEY,
      keychainId: 'k-serve-wiring',
    });
    await upsertHiveMember({
      workspaceId: WORKSPACE_ID,
      potHomeSlug: unsafeFederatedPotScope(HIVE, HIVE_SCOPE_REASON),
      githubUserId: CLIENT_MEMBER_ID,
      githubUsername: 'client-under-test',
      deviceAttestations: [attestation(CLIENT_DEVICE)],
    });

    root = await mkdtemp(join(tmpdir(), 'hgserve-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo(HIVE, 'repo-1');
    clientRepo = await ensurePotGitRepo(HIVE, 'repo-1-mirror');
    sha = await mintCommit(serverRepo, 'work 1');
    await defaultRunGit(['update-ref', 'refs/heads/work', sha], serverRepo);
    await setPotGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getPotGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');

    sockPath = join(root, 'link.sock');
    // allowHalfOpen:true on BOTH ends — a FIN on one leg must not tear down the
    // socket before its buffered bytes flush (same reasoning as fetch-transport's
    // own link; here it also carries the Protomux muxer for BOTH channels).
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      // Protomux requires a MESSAGE-FRAMED stream (its own README: "it has to
      // be a stream that preserves the messages, ie something that length
      // prefixes like @hyperswarm/secret-stream") — a bare net.Socket does
      // NOT preserve message boundaries (two small writes issued close
      // together can coalesce into one 'data' event, silently dropping the
      // second message — see the module header, WI-3490). Wrap with a real
      // SecretStream, exactly mirroring what the real hive-swarm connection's
      // `noiseStream` already provides in production.
      const srvNoise = new SecretStream(false, srvConn);
      wireHiveGitServe(srvNoise, TOPIC, {
        potHomeSlug: HIVE,
        workspaceId: WORKSPACE_ID,
        resolvePeerDevicePubkey: () => CLIENT_DEVICE,
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    clientSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
    clientNoise = new SecretStream(true, clientSocket);
    await clientNoise.opened;
  });

  afterAll(async () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    await setPotGitMode(WORKSPACE_ID, HIVE, null);
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });

    // Restore the ambient getOrgPg() routing + tear down the throwaway DB —
    // must run AFTER the last no-sql call above, and must leave no cached
    // pool pointed at a container we're about to drop.
    if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
    else process.env.HARNESS_DATABASE_URL = prevAppUrl;
    if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
    if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
    else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
    if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
    _resetUrlCacheForTests();
    await _resetForTests();
    await db?.cleanup();
  });

  it('fetches the served repo end to end (real git upload-pack, real git fetch)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/work'], {
      timeoutMs: 30_000,
    });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/work'], clientRepo);
    expect(rev.stdout.trim()).toBe(sha);
    const cat = await defaultRunGit(['cat-file', '-e', sha], clientRepo);
    expect(cat.code).toBe(0);
  });

  /**
   * EI-18765930091826096 recurrence guards — THE SESSION LEAK THAT DEGRADED A
   * PEER CHANNEL UNTIL ONLY A PROCESS RESTART CLEARED IT.
   *
   * Every other test in this file asserts on a fetch's RESULT, and a leaked
   * session does not change any result — which is precisely why this defect
   * survived to a live 2-machine rig, where it presented as "the one reachable
   * peer returns `unexpected disconnect` on every rung, at every rung size, for
   * 40 minutes". These assert on the SESSION MAPS instead: the state that
   * accumulates.
   *
   * The mechanism they pin, in order:
   *   1. a fetch that COMPLETES releases its session on both sides;
   *   2. a fetch that is ABANDONED LOCALLY (the ceiling fires, git is SIGKILLed,
   *      the caller walks away) releases it too — this is the one that leaked,
   *      because the map was only ever pruned by REMOTE events (refuse / end
   *      frame / channel close);
   *   3. an abandoned duplex can no longer absorb inbound pack bytes.
   */
  it('EI-18765930091826096: a COMPLETED fetch leaves no session registered on either side', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/work'], {
      timeoutMs: 30_000,
    });
    expect(res.code, res.stderr).toBe(0);
    // NOTE: do NOT add `expect(duplex.destroyed)` here. It looks like it defends
    // fetchOverDuplex's ownership release, but on this healthy path the pipes end
    // both halves anyway and node auto-destroys the duplex — mutation testing
    // showed it passes with the release REVERTED. The test that actually
    // distinguishes it lives in fetch-transport.integration.test.ts, on the
    // abandoned path, where nothing else can end the duplex.
    //
    // The release below is driven by stream 'close' / the serve `finally`, both
    // of which land a tick or two after the fetch resolves.
    await vi.waitFor(
      () => {
        const counts = serveTesting.sessionCounts(clientNoise, TOPIC);
        expect(counts?.client ?? 0).toBe(0);
      },
      { timeout: 5_000 },
    );
  });

  it('EI-18765930091826096: a fetch ABANDONED LOCALLY still releases its session (the leak: the map was only pruned by REMOTE events)', async () => {
    const before = serveTesting.sessionCounts(clientNoise, TOPIC)?.client ?? 0;
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
    // The session is live now — that is what makes the assertion below meaningful
    // rather than vacuously true against a map that was never populated.
    expect(serveTesting.sessionCounts(clientNoise, TOPIC)?.client).toBe(before + 1);

    // Abandon exactly as a ceiling-fired fetch does: no refuse, no end frame,
    // no channel close — purely a LOCAL give-up.
    duplex.destroy();

    await vi.waitFor(
      () => {
        expect(serveTesting.sessionCounts(clientNoise, TOPIC)?.client).toBe(before);
      },
      { timeout: 5_000 },
    );
  });

  it('EI-18765930091826096: a data frame arriving after EOF is dropped, not pushed past the end', async () => {
    const d = new serveTesting.FrameDuplex(
      () => {},
      () => {},
    );
    const errors: string[] = [];
    d.on('error', (e: NodeJS.ErrnoException) => errors.push(e.code ?? e.message));
    d.resume();
    d.pushEnd();
    await new Promise((r) => setImmediate(r));

    // A late/duplicate data frame for an already-ended session. Unguarded this is
    // ERR_STREAM_PUSH_AFTER_EOF, which this class's fail-soft 'error' listener
    // swallows — an invisible protocol violation.
    //
    // Deliberately NOT asserted here: "an abandoned duplex buffers nothing".
    // That was measured and is NOT what this guard does — node already no-ops
    // push-after-destroy, and the bytes that actually leaked went into a LIVE
    // unread duplex, which nothing here can detect. The tests that defend the
    // leak itself are the two above (close-prune + ownership release).
    d.pushChunk(Buffer.alloc(64 * 1024, 1));
    await new Promise((r) => setImmediate(r));
    expect(errors, 'a post-EOF data frame must be dropped, not pushed').toEqual([]);
  });

  /**
   * WI-6184 recurrence guard: A REFUSAL MUST NEVER PRESENT AS A TIMEOUT.
   *
   * `expect(res.code).not.toBe(0)` alone is NOT enough — it passes identically
   * whether the peer refused in 20ms or said nothing at all and the client sat
   * out its full ceiling. That indistinguishability is the whole defect class
   * this guard exists to catch: on the 2-machine rig every cold-join burned the
   * FULL 120s ceiling and reported a bare ":failed" with no reason, because a
   * throw inside `handleReq` was swallowed with no frame sent (serve-wiring.ts's
   * trailing `.catch`) and because `serveUploadPack`'s spawn-error path never
   * ended the duplex. Both are fixed; these assertions FAIL if either regresses.
   *
   * So every refusal path asserts all three: it did not time out, it named its
   * reason on the wire, and it returned fast (a refuse frame is one round-trip —
   * orders of magnitude under the ceiling, with generous headroom for CI load).
   */
  const REFUSAL_FAST_MS = 10_000;
  const expectFastNamedRefusal = (
    res: { code: number; stderr: string; timedOut: boolean },
    elapsedMs: number,
    reason: RegExp,
  ): void => {
    expect(res.code, res.stderr).not.toBe(0);
    // The refusal must arrive as a `refuse` FRAME, not as silence-then-ceiling.
    expect(res.timedOut, `refusal presented as a TIMEOUT: ${res.stderr}`).toBe(false);
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.stderr).toMatch(reason);
    expect(elapsedMs, `refusal took ${elapsedMs}ms — expected a fast refuse frame`).toBeLessThan(
      REFUSAL_FAST_MS,
    );
  };

  it('a legacy-mode hive REFUSES fast, naming mode-legacy — never serves a byte, never a timeout', async () => {
    await setPotGitMode(WORKSPACE_ID, HIVE, 'legacy');
    try {
      const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'repo-1' });
      const t0 = Date.now();
      const res = await fetchOverDuplex(
        clientRepo,
        duplex,
        ['+refs/heads/work:refs/heads/other-legacy-attempt'],
        { timeoutMs: 15_000 },
      );
      expectFastNamedRefusal(res, Date.now() - t0, /serve refused: mode-legacy/);
    } finally {
      await setPotGitMode(WORKSPACE_ID, HIVE, 'bridged');
    }
  });

  it('refuses an unknown repoKey fast, naming no-such-repo', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: 'not-a-real-repo' });
    const t0 = Date.now();
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never'], {
      timeoutMs: 15_000,
    });
    expectFastNamedRefusal(res, Date.now() - t0, /serve refused: no-such-repo/);
  });

  it('refuses a path-traversal repoKey fast, naming bad-repo-key (never touches the fs outside the root)', async () => {
    const duplex = await openHiveGitFetchDuplex(clientNoise, TOPIC, { repoKey: '../../etc' });
    const t0 = Date.now();
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never2'], {
      timeoutMs: 15_000,
    });
    expectFastNamedRefusal(res, Date.now() - t0, /serve refused: bad-repo-key/);
  });

  /**
   * WI-6184 — the LAST unguarded hang in the serve path.
   *
   * `handleReq`'s async body ended in a bare `.catch(() => {})`. Any throw
   * inside it — and several call sites are deliberately NOT wrapped, e.g. the
   * `cfg.resolvePeerDevicePubkey(socket)` hook exercised here — was swallowed
   * with NO frame sent back. The requester learned nothing and sat out its
   * FULL fetch ceiling (120 s in prod) on a failure the serving side knew
   * about instantly. Now it answers `refuse('serve-error')`.
   *
   * This test needs its own wiring because the shared server above passes a
   * resolver that never throws (an unverified socket refuses cleanly with
   * `unverified-peer`, which is a DIFFERENT branch and would not catch this bug).
   */
  it('REGRESSION (WI-6184): a THROWING serve hook answers refuse(serve-error) instead of hanging the peer', async () => {
    const badSockPath = join(root, 'serve-error.sock');
    let hookCalls = 0;
    const badServer = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      wireHiveGitServe(new SecretStream(false, srvConn), TOPIC, {
        potHomeSlug: HIVE,
        workspaceId: WORKSPACE_ID,
        resolvePeerDevicePubkey: () => {
          hookCalls++;
          throw new Error('boom: peer-identity resolver blew up');
        },
      });
    });
    await new Promise<void>((r) => badServer.listen(badSockPath, () => r()));
    const badSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: badSockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    badSocket.on('error', () => {});
    const badNoise = new SecretStream(true, badSocket);
    await badNoise.opened;

    try {
      // A scope-family repoKey routes through the hook that throws.
      const duplex = await openHiveGitFetchDuplex(badNoise, TOPIC, {
        repoKey: scopeRepoWireKey({ kind: 'fleet', ownerGithubUserId: 7, slug: 'boom-scope' }),
      });
      const t0 = Date.now();
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never3'], {
        timeoutMs: 15_000,
      });
      // The hook really did throw — otherwise this test proves nothing.
      expect(hookCalls).toBeGreaterThan(0);
      // Named, and FAST: `code !== 0` alone would also pass on a full-ceiling
      // timeout, i.e. on exactly the bug this guards.
      expectFastNamedRefusal(res, Date.now() - t0, /serve refused: serve-error/);
    } finally {
      try {
        badSocket.destroy();
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => badServer.close(() => r()));
    }
  });

  /**
   * WI-10006827 — a REVOKED device must not pull the pot's MAIN repo. Soak c1010r measured the
   * hole live: the tower logged `serve OK ... peer=ywj8zjsF` four minutes after that device was
   * revoked, because only scopes/ repos consulted the caller's device. The revocation here is
   * written by the same writer substrate:revoke_contributor uses (addRevokedHivePubkeys) and read
   * back through the exact lookup the gate uses, so this pins the real row, not a stub.
   */
  it('WI-10006827 + WI-10006832: the main repo is refused, fast and named, to a revoked, an unattested and an unverified peer; an attested device is served', async () => {
    const REVOKED = Buffer.alloc(32, 11).toString('base64');
    const MEMBER = Buffer.alloc(32, 12).toString('base64');
    const STRANGER = Buffer.alloc(32, 14).toString('base64');
    await db.adminSql`INSERT INTO harness_shared.pot_members (workspace_id, pot_home_slug, github_user_id, github_username)
      VALUES (${WORKSPACE_ID}, ${HIVE}, 4242, 'owner-under-test') ON CONFLICT DO NOTHING`;
    await addRevokedHivePubkeys(
      WORKSPACE_ID,
      unsafeFederatedPotScope(HIVE, 'test fixture: this hive home is its own federated scope'),
      4242,
      [REVOKED],
    );
    // Positive control on the fixture: the gate's own lookup sees the revocation.
    expect(await loadRevokedHivePubkeysForLocalPot(WORKSPACE_ID, HIVE)).toContain(REVOKED);
    // MEMBER is attested through the real writer. REVOKED is offered too, and the writer drops it
    // because it is revoked, which is why the revoked refusal below is not an attestation gap.
    await upsertHiveMember({
      workspaceId: WORKSPACE_ID,
      potHomeSlug: unsafeFederatedPotScope(HIVE, HIVE_SCOPE_REASON),
      githubUserId: 4242,
      githubUsername: 'owner-under-test',
      deviceAttestations: [attestation(MEMBER), attestation(REVOKED)],
    });

    const fetchAs = async (peer: string | undefined, tag: string) => {
      const sock = join(root, `revoke-${tag}.sock`);
      const srv = createServer({ allowHalfOpen: true }, (srvConn) => {
        srvConn.on('error', () => {});
        wireHiveGitServe(new SecretStream(false, srvConn), TOPIC, {
          potHomeSlug: HIVE,
          workspaceId: WORKSPACE_ID,
          resolvePeerDevicePubkey: () => peer,
        });
      });
      await new Promise<void>((r) => srv.listen(sock, () => r()));
      const s = await new Promise<Socket>((resolve, reject) => {
        const conn = connect({ path: sock, allowHalfOpen: true });
        conn.once('connect', () => resolve(conn));
        conn.once('error', reject);
      });
      s.on('error', () => {});
      const noise = new SecretStream(true, s);
      await noise.opened;
      try {
        const duplex = await openHiveGitFetchDuplex(noise, TOPIC, { repoKey: 'repo-1' });
        const t0 = Date.now();
        const res = await fetchOverDuplex(clientRepo, duplex, [`+refs/heads/work:refs/heads/revoke-${tag}`], {
          timeoutMs: 15_000,
        });
        return { res, elapsedMs: Date.now() - t0 };
      } finally {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
        await new Promise<void>((r) => srv.close(() => r()));
      }
    };

    const refused = await fetchAs(REVOKED, 'revoked');
    expectFastNamedRefusal(refused.res, refused.elapsedMs, /serve refused: revoked-device/);
    // WI-10006832: a socket that never proved a device (a client that skipped the signed hello).
    const unverified = await fetchAs(undefined, 'unverified');
    expectFastNamedRefusal(unverified.res, unverified.elapsedMs, /serve refused: unverified-peer/);
    // WI-10006832: a verified device that no member of this pot attests.
    const stranger = await fetchAs(STRANGER, 'stranger');
    expectFastNamedRefusal(stranger.res, stranger.elapsedMs, /serve refused: unknown-device/);
    // Control: the same wiring, the same repo, an attested device that is not revoked, is served.
    const served = await fetchAs(MEMBER, 'member');
    expect(served.res.code, served.res.stderr).toBe(0);
  });

  it('EI-18752434722211671: a peer that never opens AND never closes the channel fails soft instead of hanging forever', async () => {
    // THE ROOT CAUSE OF A DEVICE-WIDE GIT-SYNC WEDGE (P-302 rig, 2026-07-26).
    // Every other failure path here is a peer that says NO — refused, closed,
    // pre-destroyed — and each already fails fast. This is the peer that says
    // NOTHING: the connection is live and the noise handshake completes, but
    // nothing on the far end ever accepts OR rejects the pot-git channel, so
    // our `open` control frame goes out and no `onopen`/`onclose` ever comes
    // back. `waitOpened` used to be an unbounded promise settled ONLY by those
    // two events, so this hung the caller FOREVER — and it runs strictly
    // BEFORE any duplex exists, so `fetchOverDuplex`'s fetch ceiling could not
    // cover it. Live consequence: a git-sync DBOS fire checkpointed 8 steps,
    // entered `git-sync:ref-announce`, never recorded a 9th, and held the
    // routine's dedup pin across 3 DBOS recovery attempts — rejecting every
    // subsequent git-sync enqueue on that device for hours.
    //
    // Pre-fix this test does not fail an assertion; it hits the vitest
    // timeout, which is exactly the production symptom.
    const deadSockPath = join(root, 'dead-peer.sock');
    // Tracked so teardown can destroy the SERVER end too: this peer never
    // completes a session, so destroying only the client leaves the accepted
    // connection lingering and `server.close()`'s callback never fires (it
    // waits for every connection to end). Every other test in this file
    // finishes a real exchange, so their sockets close on their own.
    let deadSrvConn: Socket | null = null;
    const deadServer = createServer({ allowHalfOpen: true }, (srvConn) => {
      deadSrvConn = srvConn;
      srvConn.on('error', () => {});
      // A REAL SecretStream (so the handshake completes and we get past
      // `await opened`) deliberately never wired to pot-git serve — no
      // `wireHiveGitServe`, no Protomux, nothing to answer or refuse.
      const deadNoiseSrv = new SecretStream(false, srvConn);
      deadNoiseSrv.on('error', () => {});
      deadNoiseSrv.resume(); // swallow our frames; reply to none of them
    });
    await new Promise<void>((r) => deadServer.listen(deadSockPath, () => r()));
    const deadSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: deadSockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    deadSocket.on('error', () => {});
    const deadNoise = new SecretStream(true, deadSocket);
    deadNoise.on('error', () => {});
    await deadNoise.opened;

    try {
      const t0 = Date.now();
      const duplex = await openHiveGitFetchDuplex(
        deadNoise,
        TOPIC,
        { repoKey: 'repo-1' },
        { openTimeoutMs: 500 },
      );
      const elapsed = Date.now() - t0;
      // It RETURNED — the whole point. And it returned the documented
      // fail-soft shape, so the calling leg reports `fetch-failed` and
      // re-dials next tick rather than wedging the routine.
      expect(duplex.destroyed).toBe(true);
      expect(elapsed).toBeLessThan(10_000);
      // The fail-soft duplex feeds `fetchOverDuplex`'s already-destroyed fast
      // path — so a wedged peer costs ONE short ceiling, not a stacked one.
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/never4'], {
        timeoutMs: 15_000,
      });
      expect(res.code).not.toBe(0);
      expect(res.timedOut).toBe(false);
    } finally {
      for (const s of [deadSocket, deadSrvConn as Socket | null]) {
        try {
          s?.destroy();
        } catch {
          /* ignore */
        }
      }
      await new Promise<void>((r) => deadServer.close(() => r()));
    }
  });
});
