/**
 * peer-dial-registry.integration.test.ts — WI-3583: the device-pubkey →
 * live-swarm-socket registry over TWO REAL Protomux instances on a real
 * unix-socket pair (same substitution idiom as serve-wiring.integration.test.ts
 * — standing in for the hive-swarm connection). Proves the hello handshake
 * populates the registry on BOTH sides, that it coexists on the SAME muxer as
 * serve-wiring.ts's own six-slot channel without collision, that a resolved
 * device dials a REAL fetch end to end, and that an unknown device fails soft
 * (never throws) exactly like `openHiveGitFetchDuplex`'s own contract.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/peer-dial-registry.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import Protomux from 'protomux';
import cenc, { type CompactEncodingState } from 'compact-encoding';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes, same pattern as serve-wiring.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { defaultRunGit, ensurePotGitRepo } from './storage';
import { fetchOverDuplex } from './fetch-transport';
import { openHiveGitFetchDuplex, wireHiveGitServe } from './serve-wiring';
import { upsertHiveMember } from '../../hive-membership-store';
import { unsafeFederatedPotScope } from '../../federated-pot-scope';
import { setPotGitMode, getPotGitMode } from '../../harness/git-sync/hive-git-mode';
import {
  wireHiveGitDial,
  resolvePotGitPeerSocket,
  openHiveGitDuplexToDevice,
  resolveVerifiedDevicePubkeyForSocket,
  _testing,
} from './peer-dial-registry';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';

const WORKSPACE_ID = `ws-dial-registry-${randomUUID().slice(0, 8)}`;
const HIVE = `hive-dial-registry-${randomUUID().slice(0, 8)}`;
const TOPIC = Buffer.alloc(32, 11); // a fixed 32-byte stand-in for the hive topic
const FAKE_PUBKEY = Buffer.alloc(32, 13).toString('base64');
// WI-3641: the hello handshake is now SIGNED (peer-dial-registry.ts verifies
// each hello against `helloSignContext(topic)` before trusting a device_pubkey
// — see verifyEd25519 in the hello onmessage handler), so these must be REAL
// Ed25519 keypairs, not fixed filler bytes; a fake pubkey would fail
// verification and the hello would never be trusted / registered.
const serverKeypair = generateEd25519KeypairDer();
const clientKeypair = generateEd25519KeypairDer();
const SERVER_DEVICE = serverKeypair.pubkeyBase64;
const CLIENT_DEVICE = clientKeypair.pubkeyBase64;
const signAsServer = (bytes: Buffer): Buffer => signWithPrivateKeyDer(serverKeypair.privateKeyDer, bytes);
const signAsClient = (bytes: Buffer): Buffer => signWithPrivateKeyDer(clientKeypair.privateKeyDer, bytes);

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

/**
 * WI-3583 diagnosis: a RAW `node:net.Socket` (this test's stand-in for the
 * real Hyperswarm/NoiseSecretStream connection) gives protomux NO message
 * framing guarantee — `Protomux._ondata` decodes exactly ONE message from
 * whatever bytes ONE 'data' event happens to deliver, with no loop over
 * leftover bytes. Two UNBATCHED `channel.open()` writes (from wireHiveGitServe
 * then wireHiveGitDial, called back-to-back) are two independent
 * `stream.write()` calls — the OS/loopback layer is free to coalesce them
 * into ONE 'data' event, which then silently DROPS the second channel's open
 * frame (never observed as an error, just an eternally-unopened channel).
 * This reproduced as real, non-deterministic hangs under fleet host load.
 * Real Hyperswarm connections don't have this problem (NoiseSecretStream
 * frames each message explicitly), so this is a TEST-fixture-only concern —
 * but the safe, general fix (also worth mirroring in production wiring that
 * ever calls multiple `wireX` functions back-to-back on one fresh socket) is
 * to CORK the shared mux around every `wireX` call on one connection, so
 * protomux batches them into ONE `_sendBatch` write — decoded via
 * `_onbatch`'s own loop over multiple messages per buffer, which is robust
 * regardless of how the transport chunks the underlying bytes.
 */
function wireAllCorked(socket: Duplex, wire: () => void): void {
  const muxStream = socket as unknown as { userData?: unknown };
  const mux = Protomux.from(muxStream as never);
  if (!muxStream.userData) muxStream.userData = mux;
  mux.cork();
  try {
    wire();
  } finally {
    mux.uncork();
  }
}

/**
 * WI-3583 diagnosis (root cause #4, continued): `wireAllCorked` above closes
 * the coalescing gap for the INITIAL corked batch of `channel.open()` calls,
 * but it does NOT — and structurally CANNOT — close it for messages sent
 * LATER, asynchronously, from an `onopen` callback (e.g. the hello-channel's
 * `maybeSendHello`) in response to the PEER's incoming batch arriving. That
 * later send is a lone, un-corked `stream.write()`, and it can still
 * coalesce at the OS/loopback layer with some OTHER write on the same raw
 * socket happening at nearly the same wall-clock moment (observed: a
 * peer's hello, sent synchronously from its own onopen while processing an
 * incoming batch, can arrive before OR merged with a write the other side
 * makes moments later — losing one message with zero error, exactly like
 * the original coalescing bug). Chasing every such site individually is
 * whack-a-mole; the actual, general, root-cause fix is to stop relying on
 * "one `stream.write()` == one peer-side 'data' event" from a raw
 * `node:net.Socket` AT ALL — that guarantee is real production's job
 * (`NoiseSecretStream` explicitly frames every message), not a raw
 * socket's. So: wrap the raw socket in a minimal length-prefixed framing
 * Duplex before handing it to Protomux, restoring exactly the invariant
 * Protomux already assumes its transport provides. This is transport-only
 * (no protocol/business-logic change) and is a strict superset guarantee of
 * `wireAllCorked`'s batching — every write, corked-batch or lone message
 * alike, now arrives atomically regardless of how many raw socket 'data'
 * events the OS happens to deliver it as, or how many separate writes get
 * physically coalesced into one.
 */
function frameWrap(raw: Socket): Duplex {
  let recvBuf: Buffer = Buffer.alloc(0);
  const wrapped: Duplex = new Duplex({
    read() {
      /* backpressure ignored — test-scale volumes only */
    },
    write(chunk: Buffer, _enc, cb) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const header = Buffer.alloc(4);
      header.writeUInt32LE(buf.length, 0);
      // ONE Buffer.concat'd write — Node's stream internals may still split
      // this across multiple underlying syscalls, but never across two
      // logically-separate `wrapped.write()` calls, which is the only
      // coalescing this framing needs to defeat.
      raw.write(Buffer.concat([header, buf]), (err) => cb(err ?? null));
    },
    final(cb) {
      raw.end(() => cb());
    },
    destroy(err, cb) {
      raw.destroy(err ?? undefined);
      cb(err ?? null);
    },
  });
  raw.on('data', (data: Buffer) => {
    recvBuf = recvBuf.length ? Buffer.concat([recvBuf, data]) : data;
    while (recvBuf.length >= 4) {
      const len = recvBuf.readUInt32LE(0);
      if (recvBuf.length < 4 + len) break;
      wrapped.push(Buffer.from(recvBuf.subarray(4, 4 + len)));
      recvBuf = recvBuf.subarray(4 + len);
    }
  });
  raw.on('end', () => wrapped.push(null));
  raw.on('close', () => wrapped.push(null));
  raw.on('error', (e) => wrapped.destroy(e));
  return wrapped;
}

/**
 * WI-10006889: a SECOND simulated box, with its own module instance of the dial registry.
 *
 * The registry's wired-topic identity is process-global ON PURPOSE: one process is one box, and
 * a hello on a topic must carry the identity that wired that topic on this box, never the muxer's
 * "whoever wired last" config (P-203 Leg A, 023f0570b6). Two boxes simulated in ONE process that
 * wire the SAME topic under DIFFERENT devices therefore overwrite each other's signer: the later
 * wire wins and BOTH sides then sign their hellos as that one device. The WI-3496 and WI-5210
 * regressions below broke exactly that way after 2026-09-02 (both hellos carried one device;
 * one side's registry assertion passed for the wrong device and the other timed out).
 *
 * Box B therefore loads a fresh copy of the module graph, so its process-global maps are its own,
 * the way a real second machine's are. Box A keeps this file's static imports. Each side's
 * registry is asserted on its OWN instance, and each side must never register its own device.
 * The fresh graph re-arms the shared `pot-git-dial-heal` timer name (the scheduled registry stops
 * the previous timer on a re-arm), so no test here may rely on box A's automatic heal sweep; the
 * heal test drives `healSweep()` by hand.
 */
type DialBox = typeof import('./peer-dial-registry') & {
  wireHiveGitServe: typeof import('./serve-wiring').wireHiveGitServe;
};
async function loadSecondBox(): Promise<DialBox> {
  vi.resetModules();
  const dial = await import('./peer-dial-registry');
  const serve = await import('./serve-wiring');
  return { ...dial, wireHiveGitServe: serve.wireHiveGitServe };
}

/** Positive control, run as a TEST in each two-box describe: the isolation is real only if box
 *  B's registry is a different object graph from box A's (this file's static imports). If
 *  `loadSecondBox` ever stops isolating, this fails by assertion instead of the hello tests
 *  quietly asserting against one shared registry again. */
function expectIsolatedBox(b: DialBox): void {
  expect(b.resolvePotGitPeerSocket).not.toBe(resolvePotGitPeerSocket);
  expect(b._testing.wiredTopicIdentity).not.toBe(_testing.wiredTopicIdentity);
}

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('pot-git peer-dial-registry (WI-3583: device_pubkey -> live socket, over the pot-git-hello channel)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let clientSocket: Socket;
  let clientDuplex: Duplex;
  let sha = '';
  let db: OrgTestDb;
  let prevAppUrl: string | undefined;
  let prevAdminUrl: string | undefined;
  let prevPgb: string | undefined;
  let prevSkipDisc: string | undefined;

  beforeAll(async () => {
    db = await createOrgTestDb();
    prevAppUrl = process.env.HARNESS_DATABASE_URL;
    prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
    prevPgb = process.env.PAPERCUSP_PGBOUNCER;
    prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
    process.env.PAPERCUSP_PGBOUNCER = '0';
    process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
    process.env.HARNESS_DATABASE_URL = db.appDsn;
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetUrlCacheForTests();
    await _resetForTests();

    await insertHiveIfAbsent({
      workspaceId: WORKSPACE_ID,
      homeSlug: HIVE,
      pubkeyBase64: FAKE_PUBKEY,
      keychainId: 'k-dial-registry',
    });
    // WI-10006832: serve admits only an attested device, so the dialing client's device is
    // attested here, exactly as a joined member's would be.
    await upsertHiveMember({
      workspaceId: WORKSPACE_ID,
      potHomeSlug: unsafeFederatedPotScope(HIVE, 'test fixture: this hive home is its own federated scope'),
      githubUserId: 5151,
      githubUsername: 'dial-client-under-test',
      deviceAttestations: [
        {
          device_pubkey: CLIENT_DEVICE,
          gist_id: 'gist-dial-client',
          gist_url: '',
          device_label: 'test-device',
          created_at: Date.now(),
          signature_by_device: '',
        },
      ],
    });

    root = await mkdtemp(join(tmpdir(), 'hgdial-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo(HIVE, 'repo-1');
    clientRepo = await ensurePotGitRepo(HIVE, 'repo-1-mirror');
    sha = await mintCommit(serverRepo, 'work 1');
    await defaultRunGit(['update-ref', 'refs/heads/work', sha], serverRepo);
    await setPotGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getPotGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      // Coexist on the SAME muxer as serve-wiring.ts's own six-slot channel —
      // proves the hello channel is genuinely additive, not a wire collision.
      // frameWrap (see its header) restores real production's per-write
      // message-atomicity guarantee; wireAllCorked's batching on top just
      // cuts syscalls, it's no longer load-bearing for correctness.
      const srvDuplex = frameWrap(srvConn);
      wireAllCorked(srvDuplex, () => {
        wireHiveGitServe(srvDuplex, TOPIC, {
          potHomeSlug: HIVE,
          workspaceId: WORKSPACE_ID,
          // swarm.ts's production default: the signed-hello registry's verified device.
          resolvePeerDevicePubkey: resolveVerifiedDevicePubkeyForSocket,
        });
        wireHiveGitDial(srvDuplex, TOPIC, SERVER_DEVICE, signAsServer);
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
    clientSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    clientSocket.on('error', () => {});
    clientDuplex = frameWrap(clientSocket);
    // Symmetric wiring — matches REAL production usage: swarm.ts's connection
    // handler calls wireHiveGitServe + wireHiveGitDial unconditionally on
    // EVERY peer connection (both the dialer and the acceptor side), never
    // just one. A client that wires wireHiveGitDial WITHOUT wireHiveGitServe
    // (this test's earlier, asymmetric fixture) has no `pair()` notifier
    // registered for POT_GIT_PROTOCOL — so the server's own pot-git-serve
    // channel's incoming "open" control frame (also on this shared muxer)
    // hits protomux's unregistered-protocol fallback and gets REJECTED,
    // which was starving the SEPARATE hello channel's own pairing on the
    // same connection (WI-3583 diagnosis).
    wireAllCorked(clientDuplex, () => {
      wireHiveGitServe(clientDuplex, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
      wireHiveGitDial(clientDuplex, TOPIC, CLIENT_DEVICE, signAsClient);
    });
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

  it('the hello handshake learns the peer device_pubkey on BOTH sides', async () => {
    await waitFor(() => resolvePotGitPeerSocket(TOPIC, SERVER_DEVICE) !== undefined);
    await waitFor(() => resolvePotGitPeerSocket(TOPIC, CLIENT_DEVICE) !== undefined);
    // The client learned the SERVER's device from the client socket's own
    // perspective — resolving SERVER_DEVICE from this (single) process's
    // shared registry must yield a socket (either end, since both live in
    // the same process's module-level Map here).
    expect(resolvePotGitPeerSocket(TOPIC, SERVER_DEVICE)).toBeDefined();
    expect(resolvePotGitPeerSocket(TOPIC, CLIENT_DEVICE)).toBeDefined();
  });

  it('an unknown device fails soft — an immediately-destroyed duplex, never throws', async () => {
    const unknown = Buffer.alloc(32, 99).toString('base64');
    const duplex = await openHiveGitDuplexToDevice(TOPIC, unknown, { repoKey: 'repo-1' });
    expect(duplex.destroyed).toBe(true);
  });

  it('a resolved device dials a REAL fetch end to end (coexists with serve-wiring on the same muxer)', async () => {
    const duplex = await openHiveGitDuplexToDevice(TOPIC, SERVER_DEVICE, { repoKey: 'repo-1' });
    const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-dial-registry'], {
      timeoutMs: 30_000,
    });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-dial-registry'], clientRepo);
    expect(rev.stdout.trim()).toBe(sha);
  });

  it('a closed connection removes its registry entry', async () => {
    expect(resolvePotGitPeerSocket(TOPIC, CLIENT_DEVICE)).toBeDefined();
    clientSocket.destroy();
    await waitFor(() => resolvePotGitPeerSocket(TOPIC, CLIENT_DEVICE) === undefined);
  });
});

describe('WI-3496 drill regression: opens rejected by a not-yet-wired peer RECOVER once the peer wires (dead-channel-cache eviction + muxer-level config)', () => {
  // The live two-machine drill measured a ~100s skew between the two boxes'
  // pot-git wirings: the early side's channel.open() reached a peer whose
  // protomux was LIVE (it rejects unknown opens) but whose pot-git serve/dial
  // were not wired yet. Pre-fix, the rejected (closed) channel stayed cached
  // per (muxer, topic) forever, poisoning BOTH directions: the early side's
  // re-wires resolved to the dead channel, and the late side's eventual open
  // hit the pair() notifier, which ALSO resolved to the dead state and created
  // no protomux channel — so protomux rejected it right back. Deadlock, and
  // (EI-13317) no reconnect ever heals it.
  const TOPIC2 = Buffer.alloc(32, 22);
  let root2: string;
  let sockPath2: string;
  let server2: Server;
  let aSocket: Socket;
  let aDuplex: Duplex;
  let bWire: (() => void) | null = null;
  // B is the late box: its own module instance (see loadSecondBox) so its TOPIC2 wire cannot
  // overwrite the identity A signs with.
  let B: DialBox;

  beforeAll(async () => {
    B = await loadSecondBox();
    root2 = await mkdtemp(join(tmpdir(), 'hgdial-race-'));
    sockPath2 = join(root2, 'link.sock');
    server2 = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      const d = frameWrap(srvConn);
      // Simulate the drill's boot-order race: B's muxer EXISTS (protomux is
      // parsing the connection and rejects unknown channel opens) but pot-git
      // serve/dial are NOT wired yet — the tower's state while its swarm joins
      // were still booting.
      const muxStream = d as unknown as { userData?: unknown };
      const mux = Protomux.from(muxStream as never);
      if (!muxStream.userData) muxStream.userData = mux;
      bWire = () => {
        wireAllCorked(d, () => {
          B.wireHiveGitServe(d, TOPIC2, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
          B.wireHiveGitDial(d, TOPIC2, SERVER_DEVICE, signAsServer);
        });
      };
    });
    await new Promise<void>((r) => server2.listen(sockPath2, () => r()));
    aSocket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath2, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    aSocket.on('error', () => {});
    aDuplex = frameWrap(aSocket);
    // A (the early side) wires BOTH planes immediately — its opens will be
    // protomux-rejected by the unwired B.
    wireAllCorked(aDuplex, () => {
      wireHiveGitServe(aDuplex, TOPIC2, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
      wireHiveGitDial(aDuplex, TOPIC2, CLIENT_DEVICE, signAsClient);
    });
    // Let A's opens reach B and be rejected (loopback round-trip: ms).
    await new Promise((r) => setTimeout(r, 500));
  });

  afterAll(async () => {
    try {
      server2.close();
    } catch {
      /* ignore */
    }
    try {
      aSocket.destroy();
    } catch {
      /* ignore */
    }
    B?._testing.reset();
    await rm(root2, { recursive: true, force: true });
  });

  it('box B is its own module instance (WI-10006889 positive control)', () => {
    expectIsolatedBox(B);
  });

  it('openHiveGitFetchDuplex fails SOFT (fast destroyed duplex) while the peer is unwired — never the 120s hang', async () => {
    const d = await Promise.race([
      openHiveGitFetchDuplex(aDuplex, TOPIC2, { repoKey: 'repo-1' }),
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    expect(d, 'openHiveGitFetchDuplex hung instead of failing soft on a rejected channel').not.toBeNull();
    expect((d as Duplex).destroyed).toBe(true);
  });

  it('hellos flow and BOTH registries populate once the late peer finally wires', async () => {
    expect(resolvePotGitPeerSocket(TOPIC2, SERVER_DEVICE)).toBeUndefined();
    expect(B.resolvePotGitPeerSocket(TOPIC2, CLIENT_DEVICE)).toBeUndefined();
    bWire!();
    // B's own channel-opens hit A's pair() notifiers: with eviction the dead
    // states are GONE, so fresh channels pair, and the muxer-level dial config
    // lets A's re-created (pair-materialized) channel still SIGN + send its
    // hello and register B's — bidirectional recovery with no reconnect.
    // A learns B's device; B learns A's device — each in its OWN registry.
    await waitFor(() => resolvePotGitPeerSocket(TOPIC2, SERVER_DEVICE) !== undefined);
    await waitFor(() => B.resolvePotGitPeerSocket(TOPIC2, CLIENT_DEVICE) !== undefined);
    // Neither side's hello carried the other side's device (WI-10006889: a hello signed under the
    // wrong identity registers the SENDER's peer as itself, which is what masked this break).
    expect(resolvePotGitPeerSocket(TOPIC2, CLIENT_DEVICE)).toBeUndefined();
    expect(B.resolvePotGitPeerSocket(TOPIC2, SERVER_DEVICE)).toBeUndefined();
  });

  it('a refusal arriving on a LISTENERLESS client duplex is fail-soft — never an unhandled error (bg-host crash, 2026-07-17)', async () => {
    // The live crash: a peer's `refuse` frame destroys the client FrameDuplex
    // with an Error while the consumer is still between openDuplex and
    // fetchOverDuplex (bootstrap.ts awaits in that gap) — no 'error' listener
    // attached yet, so the destroy became a process-fatal uncaughtException
    // ("pot-git serve refused: no-such-repo"). Reproduce with the pure
    // in-memory refusal: a topic NOBODY wired serve for refuses 'not-serving'.
    // Pre-fix this test crashes the worker; post-fix the duplex just reads
    // `.destroyed === true`.
    const TOPIC3 = Buffer.alloc(32, 33);
    const d = await openHiveGitFetchDuplex(aDuplex, TOPIC3, { repoKey: 'anything' });
    await waitFor(() => d.destroyed, 10_000);
    // Let any pending (would-be-unhandled) 'error' emission fire.
    await new Promise((r) => setTimeout(r, 100));
    expect(d.destroyed).toBe(true);
  });
});

describe('WI-5210 fence-25 regression: a one-sided hello gap heals WITHOUT a reconnect (global wired-topic gate + reciprocal hello + heal sweep)', () => {
  // The live incident (P-303 Leg B): connection churn left the surviving
  // muxer without its own wireHiveGitDial(topic) call — the wire had landed
  // on an earlier, since-dead connection. The pair-materialized channel could
  // RECEIVE the peer's hello (WI-3496's receive-side fallbacks) but never
  // SIGN/SEND its own (`cfg.topics` gate), so ONE fetch direction stayed dead
  // for hours while the other worked, and nothing ever retried.
  const TOPIC_CHURN = Buffer.alloc(32, 44); // wired only on a DEAD connection
  const TOPIC_OTHER = Buffer.alloc(32, 55); // the only topic wired on the live muxer
  const TOPIC_STUCK = Buffer.alloc(32, 66); // unwired at receive time; wired later
  let root3: string;
  let sockPath3: string;
  let server3: Server;
  const serverDuplexes: Duplex[] = [];
  const clientSockets: Socket[] = [];
  // B (the server-side box) is its own module instance (see loadSecondBox): "this box" in the
  // comments below means B's process-global wired-topic state, which A's wires must not touch.
  let B: DialBox;

  const connect3 = async (): Promise<{ socket: Socket; duplex: Duplex }> => {
    const arrived = serverDuplexes.length;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath3, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    socket.on('error', () => {});
    clientSockets.push(socket);
    await waitFor(() => serverDuplexes.length > arrived);
    return { socket, duplex: frameWrap(socket) };
  };

  beforeAll(async () => {
    B = await loadSecondBox();
    root3 = await mkdtemp(join(tmpdir(), 'hgdial-heal-'));
    sockPath3 = join(root3, 'link.sock');
    server3 = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      serverDuplexes.push(frameWrap(srvConn));
    });
    await new Promise<void>((r) => server3.listen(sockPath3, () => r()));
  });

  afterAll(async () => {
    try {
      server3.close();
    } catch {
      /* ignore */
    }
    for (const s of clientSockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    B?._testing.reset();
    await rm(root3, { recursive: true, force: true });
  });

  it('box B is its own module instance (WI-10006889 positive control)', () => {
    expectIsolatedBox(B);
  });

  it('a channel pair-materialized on a muxer never wired for its topic still ANNOUNCES itself (the dead direction of fence-25)', async () => {
    // c1: B wires TOPIC_CHURN — then the connection dies (the churn casualty).
    // This is the only wireHiveGitDial(TOPIC_CHURN) B ever makes, so only the
    // process-global wiredTopicConfig remembers the identity for it.
    const c1 = await connect3();
    const b1 = serverDuplexes[0];
    wireAllCorked(b1, () => {
      B.wireHiveGitDial(b1, TOPIC_CHURN, SERVER_DEVICE, signAsServer);
    });
    await new Promise((r) => setTimeout(r, 300));
    c1.socket.destroy();

    // c2: the surviving connection — B wires ONLY the unrelated TOPIC_OTHER
    // here (registers the muxer's pair notifier + per-muxer socket config,
    // exactly the VM's surviving-connection state).
    const c2 = await connect3();
    const b2 = serverDuplexes[1];
    wireAllCorked(b2, () => {
      B.wireHiveGitDial(b2, TOPIC_OTHER, SERVER_DEVICE, signAsServer);
    });
    // A wires TOPIC_CHURN on its side of c2 → B pair-materializes the channel
    // on a muxer whose cfg.topics does NOT contain it. Pre-fix, B registered
    // A's hello but never sent its own: A's resolve below never succeeded.
    wireAllCorked(c2.duplex, () => {
      wireHiveGitDial(c2.duplex, TOPIC_CHURN, CLIENT_DEVICE, signAsClient);
    });
    await waitFor(() => B.resolvePotGitPeerSocket(TOPIC_CHURN, CLIENT_DEVICE) !== undefined);
    await waitFor(() => resolvePotGitPeerSocket(TOPIC_CHURN, SERVER_DEVICE) !== undefined);
    // B's pair-materialized channel signed under the identity B wired TOPIC_CHURN with on the dead
    // c1 (SERVER), never A's: neither side ever registers its own device (WI-10006889).
    expect(resolvePotGitPeerSocket(TOPIC_CHURN, CLIENT_DEVICE)).toBeUndefined();
    expect(B.resolvePotGitPeerSocket(TOPIC_CHURN, SERVER_DEVICE)).toBeUndefined();
  });

  it('the heal sweep completes a handshake that got stuck BEFORE the topic was wired anywhere on this box — no reconnect needed', async () => {
    // c4: B wires only TOPIC_OTHER (pair notifier + per-muxer identity live);
    // TOPIC_STUCK is not yet wired ANYWHERE on "this box", so B's
    // pair-materialized channel for it can receive but must not sign — the
    // stuck receive-only state (the boot-skew / churn variant of fence-25).
    const c4 = await connect3();
    const b4 = serverDuplexes[2];
    wireAllCorked(b4, () => {
      B.wireHiveGitDial(b4, TOPIC_OTHER, SERVER_DEVICE, signAsServer);
    });
    // The remote peer is HAND-ROLLED protomux, not wireHiveGitDial: it must stay
    // SILENT-proof (it records every hello it receives) and must never itself
    // pair-materialize a signing channel, which the dial module would do.
    const muxStream = c4.duplex as unknown as { userData?: unknown };
    const rawMux = Protomux.from(muxStream as never);
    if (!muxStream.userData) muxStream.userData = rawMux;
    const received: string[] = [];
    const helloWire = {
      preencode(state: CompactEncodingState, v: { device_pubkey: string; signature: Buffer }) {
        cenc.string.preencode(state, v.device_pubkey);
        cenc.buffer.preencode(state, v.signature);
      },
      encode(state: CompactEncodingState, v: { device_pubkey: string; signature: Buffer }) {
        cenc.string.encode(state, v.device_pubkey);
        cenc.buffer.encode(state, v.signature);
      },
      decode(state: CompactEncodingState) {
        return { device_pubkey: cenc.string.decode(state), signature: cenc.buffer.decode(state) };
      },
    };
    let rawHello: { send(v: { device_pubkey: string; signature: Buffer }): void } | null = null;
    const rawChannel = rawMux.createChannel({
      protocol: 'papercusp/pot-git-hello',
      id: TOPIC_STUCK,
      onopen: () => {
        rawHello?.send({
          device_pubkey: CLIENT_DEVICE,
          signature: signAsClient(Buffer.concat([Buffer.from('papercusp/pot-git-hello:v1:'), TOPIC_STUCK])),
        });
      },
      onclose: () => {},
    });
    rawHello = rawChannel!.addMessage({
      encoding: helloWire as never,
      onmessage: (v: { device_pubkey: string }) => {
        received.push(v.device_pubkey);
      },
    }) as never;
    rawChannel!.open();

    // B pair-materializes TOPIC_STUCK, verifies + registers the remote — but
    // stays SILENT (no identity gate passes yet): the one-sided dead state.
    await waitFor(() => B.resolvePotGitPeerSocket(TOPIC_STUCK, CLIENT_DEVICE) !== undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(received).toHaveLength(0);

    // B now wires TOPIC_STUCK on a NEW connection (c5) — the box has joined
    // the topic, but c4's stuck channel state is untouched by it.
    const c5 = await connect3();
    const b5 = serverDuplexes[3];
    wireAllCorked(b5, () => {
      B.wireHiveGitDial(b5, TOPIC_STUCK, SERVER_DEVICE, signAsServer);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    // One sweep heals the LIVE stuck state on c4: seeds b4's own muxer
    // identity (topic gate now passes) and sends the overdue hello over the
    // EXISTING channel — the remote finally learns this box's device.
    B._testing.healSweep();
    await waitFor(() => received.includes(SERVER_DEVICE));
  });
});

describe('pot-git peer-dial-registry unit-level (no swarm — direct registry manipulation)', () => {
  afterAll(() => {
    _testing.reset();
  });

  it('resolvePotGitPeerSocket returns undefined for a topic with no registrations', () => {
    const topic = Buffer.alloc(32, 42);
    expect(resolvePotGitPeerSocket(topic, 'anything')).toBeUndefined();
  });
});
