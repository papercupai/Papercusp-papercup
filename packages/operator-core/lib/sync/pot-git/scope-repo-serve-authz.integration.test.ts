/**
 * scope-repo-serve-authz.integration.test.ts — WI-3641: proving test for the
 * `scopes/` repo authorization gate wired into `serve-wiring.ts`'s `handleReq`
 * (module header §"SERVER side"). Exercises the REAL signed-hello handshake
 * (peer-dial-registry.ts, WI-3583) end to end over two real Protomux
 * instances, so `resolvePeerDevicePubkey` resolves an actually
 * SIGNATURE-VERIFIED device — never the wire `req` frame's self-reported
 * `peerGithubUserId` — then drives the `authorizeScopeRepoServe` roster gate
 * against a REAL `pot_members` row (tier-1 owner-only roster, scope-roster.ts).
 *
 * Three proving cases (P-201 fail-closed deferral, closed by WI-3641):
 *   1. an AUTHORIZED member (device attested to the scope's owner github user
 *      id) fetches the scope repo successfully;
 *   2. a peer that never completes the signed hello (no verified device on
 *      the socket) is refused — `resolvePeerDevicePubkey` returns undefined;
 *   3. a peer with a SIGNED, verified hello whose device is NOT attested to
 *      any hive member (unknown to `resolveGithubUserIdForDevicePubkey`) is
 *      refused — signed-but-non-member.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/scope-repo-serve-authz.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm, mkdtemp } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { Duplex } from 'node:stream';
import Protomux from 'protomux';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { unsafeFederatedPotScope } from '../../federated-pot-scope';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { _resetForTests } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache getOrgPg() memoizes, same pattern as serve-wiring.integration.test.ts
import { _resetUrlCacheForTests } from '../../../../../libs/papercusp/libs/db/src/connection';
import { insertHiveIfAbsent } from '../../hive-store';
import { upsertHiveMember } from '../../hive-membership-store';
import { defaultRunGit } from './storage';
import { ensureScopeRepo, scopeRepoWireKey } from './scope-repo';
import { fetchOverDuplex } from './fetch-transport';
import { wireHiveGitServe } from './serve-wiring';
import { setPotGitMode, getPotGitMode } from '../../harness/git-sync/hive-git-mode';
import { wireHiveGitDial, resolveVerifiedDevicePubkeyForSocket, resolvePotGitPeerSocket } from './peer-dial-registry';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';

const WORKSPACE_ID = `ws-scope-serve-authz-${randomUUID().slice(0, 8)}`;
// WI-6312: branded at the declaration — this suite writes and reads its own synthetic slug.
const HIVE = unsafeFederatedPotScope(
  `hive-scope-serve-authz-${randomUUID().slice(0, 8)}`,
  'authz fixture: writes and reads the same synthetic hive slug',
);
const TOPIC = Buffer.alloc(32, 21); // a fixed 32-byte stand-in for the hive topic
const FAKE_HIVE_PUBKEY = Buffer.alloc(32, 22).toString('base64');
const SCOPE_OWNER_GITHUB_USER_ID = 555001;
// The tier-1 (no directory) scope roster is OWNER-ONLY (scope-roster.ts) — a
// scope's canonical owner id doubles as its ONLY member for this test's
// purposes (real getScopeRoster() call inside handleReq, no roster mock).
const SCOPE = { kind: 'fleet' as const, ownerGithubUserId: SCOPE_OWNER_GITHUB_USER_ID, slug: 'widgets' };

// Real Ed25519 keypairs — the signed-hello handshake (peer-dial-registry.ts)
// verifies each hello against `helloSignContext(topic)`, so a fixed/fake pubkey
// would fail verification and never register (mirrors
// peer-dial-registry.integration.test.ts's own fixture).
const serverKeypair = generateEd25519KeypairDer();
const authorizedMemberKeypair = generateEd25519KeypairDer();
const unknownDeviceKeypair = generateEd25519KeypairDer();
const SERVER_DEVICE = serverKeypair.pubkeyBase64;
const AUTHORIZED_MEMBER_DEVICE = authorizedMemberKeypair.pubkeyBase64;
const UNKNOWN_DEVICE = unknownDeviceKeypair.pubkeyBase64;
const signAsServer = (bytes: Buffer): Buffer => signWithPrivateKeyDer(serverKeypair.privateKeyDer, bytes);
const signAsAuthorizedMember = (bytes: Buffer): Buffer =>
  signWithPrivateKeyDer(authorizedMemberKeypair.privateKeyDer, bytes);
const signAsUnknownDevice = (bytes: Buffer): Buffer => signWithPrivateKeyDer(unknownDeviceKeypair.privateKeyDer, bytes);

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

/** Same coalescing-avoidance idiom as peer-dial-registry.integration.test.ts
 *  (see its header comment for the full WI-3583 diagnosis): a raw
 *  `node:net.Socket` gives protomux no message-framing guarantee, so wrap it
 *  in a minimal length-prefixed framing Duplex before handing it to protomux. */
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

async function waitFor(predicate: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** One (server, client) connected socket pair over a fresh unix socket,
 *  server-side always wiring `wireHiveGitServe` (with the REAL
 *  `resolveVerifiedDevicePubkeyForSocket` resolver — never a stub) +
 *  `wireHiveGitDial` (so the client's signed hello, if any, actually reaches
 *  it). Returns the client duplex + a teardown fn. `clientSignsHello: null`
 *  skips the client's `wireHiveGitDial` entirely — the "never says hello"
 *  case. */
async function connectPair(
  root: string,
  sockName: string,
  clientDevice: string | null,
  signAsClient: ((bytes: Buffer) => Buffer) | null,
): Promise<{ clientDuplex: Duplex; teardown: () => Promise<void> }> {
  const sockPath = join(root, sockName);
  const server = createServer({ allowHalfOpen: true }, (srvConn) => {
    srvConn.on('error', () => {});
    const srvDuplex = frameWrap(srvConn);
    wireAllCorked(srvDuplex, () => {
      wireHiveGitServe(srvDuplex, TOPIC, {
        potHomeSlug: HIVE,
        workspaceId: WORKSPACE_ID,
        resolvePeerDevicePubkey: resolveVerifiedDevicePubkeyForSocket,
      });
      wireHiveGitDial(srvDuplex, TOPIC, SERVER_DEVICE, signAsServer);
    });
  });
  await new Promise<void>((r) => server.listen(sockPath, () => r()));
  const clientSocket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ path: sockPath, allowHalfOpen: true });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  clientSocket.on('error', () => {});
  const clientDuplex = frameWrap(clientSocket);
  wireAllCorked(clientDuplex, () => {
    // Symmetric wiring, matching real production (swarm.ts wires both fns on
    // every connection, both sides) — required so the server's own pot-git
    // channels pair correctly on this shared muxer (WI-3583 diagnosis).
    wireHiveGitServe(clientDuplex, TOPIC, { potHomeSlug: HIVE, workspaceId: WORKSPACE_ID });
    if (clientDevice && signAsClient) {
      wireHiveGitDial(clientDuplex, TOPIC, clientDevice, signAsClient);
    }
  });
  return {
    clientDuplex,
    teardown: async () => {
      try {
        clientSocket.destroy();
      } catch {
        /* ignore */
      }
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
  };
}

describe('scope-repo serve authorization gate (WI-3641: P-201 fail-closed deferral, closed)', () => {
  let root: string;
  let serverScopeRepo: string;
  let clientRepo: string;
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
      pubkeyBase64: FAKE_HIVE_PUBKEY,
      keychainId: 'k-scope-serve-authz',
    });
    // The AUTHORIZED_MEMBER_DEVICE is attested to the scope's owner github
    // user id — tier-1 (no directory) scope-roster.ts membership is
    // OWNER-ONLY, so this is exactly what makes fetch case #1 authorized.
    // UNKNOWN_DEVICE is deliberately never upserted anywhere.
    await upsertHiveMember({
      workspaceId: WORKSPACE_ID,
      potHomeSlug: HIVE,
      githubUserId: SCOPE_OWNER_GITHUB_USER_ID,
      githubUsername: 'scope-owner',
      deviceAttestations: [
        {
          device_pubkey: AUTHORIZED_MEMBER_DEVICE,
          gist_id: 'g-1',
          gist_url: 'https://gist.example/1',
          device_label: 'authorized-member-device',
          created_at: Date.now(),
          signature_by_device: 'unused-in-this-fixture',
        },
      ],
    });

    root = await mkdtemp(join(tmpdir(), 'hgscopeauthz-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverScopeRepo = await ensureScopeRepo(HIVE, SCOPE);
    clientRepo = await (await import('./storage')).ensurePotGitRepo(HIVE, 'client-mirror');
    sha = await mintCommit(serverScopeRepo, 'scoped work 1');
    await defaultRunGit(['update-ref', 'refs/heads/work', sha], serverScopeRepo);
    await setPotGitMode(WORKSPACE_ID, HIVE, 'bridged');
    expect(await getPotGitMode(WORKSPACE_ID, HIVE)).toBe('bridged');
  });

  afterAll(async () => {
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

  it('1) an AUTHORIZED member (signed hello, attested to the scope owner) fetches the scope repo successfully', async () => {
    const { clientDuplex, teardown } = await connectPair(
      root,
      'authorized.sock',
      AUTHORIZED_MEMBER_DEVICE,
      signAsAuthorizedMember,
    );
    try {
      // Wait for the signed hello to actually verify server-side before
      // sending req — otherwise this races handleReq's
      // resolvePeerDevicePubkey(state.socket) against the async hello
      // handshake and could flakily refuse a genuinely-authorized peer.
      await waitFor(() => resolvePotGitPeerSocket(TOPIC, AUTHORIZED_MEMBER_DEVICE) !== undefined);
      const duplex = await (
        await import('./serve-wiring')
      ).openHiveGitFetchDuplex(clientDuplex, TOPIC, { repoKey: scopeRepoWireKey(SCOPE) });
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-scope-authorized'], {
        timeoutMs: 30_000,
      });
      expect(res.stderr).not.toMatch(/timed out/);
      expect(res.code, res.stderr).toBe(0);
      const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-scope-authorized'], clientRepo);
      expect(rev.stdout.trim()).toBe(sha);
    } finally {
      await teardown();
    }
  });

  it('2) a peer that never completes the signed hello is refused (no verified device on the socket)', async () => {
    const { clientDuplex, teardown } = await connectPair(root, 'no-hello.sock', null, null);
    try {
      const duplex = await (
        await import('./serve-wiring')
      ).openHiveGitFetchDuplex(clientDuplex, TOPIC, { repoKey: scopeRepoWireKey(SCOPE) });
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-no-hello'], {
        timeoutMs: 30_000,
      });
      expect(res.code).not.toBe(0);
      const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-no-hello'], clientRepo);
      expect(rev.code).not.toBe(0);
    } finally {
      await teardown();
    }
  });

  it('3) a SIGNED, verified peer whose device is not attested to any hive member is refused (signed-but-non-member)', async () => {
    const { clientDuplex, teardown } = await connectPair(root, 'unknown-device.sock', UNKNOWN_DEVICE, signAsUnknownDevice);
    try {
      // Wait for the (unknown) device's hello to verify server-side first —
      // this proves the refusal is specifically "signed-but-non-member"
      // (unknown-device), not merely "hello not verified yet".
      await waitFor(() => resolvePotGitPeerSocket(TOPIC, UNKNOWN_DEVICE) !== undefined);
      const duplex = await (
        await import('./serve-wiring')
      ).openHiveGitFetchDuplex(clientDuplex, TOPIC, { repoKey: scopeRepoWireKey(SCOPE) });
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-unknown-device'], {
        timeoutMs: 30_000,
      });
      expect(res.code).not.toBe(0);
      const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-unknown-device'], clientRepo);
      expect(rev.code).not.toBe(0);
    } finally {
      await teardown();
    }
  });

  it('a non-scope (pot-home) repo fetch is unaffected by the scope gate (regression guard)', async () => {
    // WI-10006832: the pot-wide admission gate applies to every repo, so this client proves an
    // attested device with a real signed hello; the scope roster still plays no part here.
    const { clientDuplex, teardown } = await connectPair(
      root,
      'pot-home.sock',
      AUTHORIZED_MEMBER_DEVICE,
      signAsAuthorizedMember,
    );
    try {
      await waitFor(() => resolvePotGitPeerSocket(TOPIC, AUTHORIZED_MEMBER_DEVICE) !== undefined);
      const potHomeRepo = await (await import('./storage')).ensurePotGitRepo(HIVE, 'repo-pot-home');
      const potHomeSha = await mintCommit(potHomeRepo, 'pot-home work');
      await defaultRunGit(['update-ref', 'refs/heads/work', potHomeSha], potHomeRepo);
      const duplex = await (
        await import('./serve-wiring')
      ).openHiveGitFetchDuplex(clientDuplex, TOPIC, { repoKey: 'repo-pot-home' });
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-pot-home'], {
        timeoutMs: 30_000,
      });
      expect(res.code, res.stderr).toBe(0);
      const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-pot-home'], clientRepo);
      expect(rev.stdout.trim()).toBe(potHomeSha);
    } finally {
      await teardown();
    }
  });

  it('WI-10006832: a pot-home repo fetch over a socket that never sent the signed hello is refused, fast and named', async () => {
    // The hole WI-10006832 closes: a modified client that skips the hello stays unidentified.
    // Before the pot-wide gate only scopes/ repos checked identity, so this fetch was served.
    const { clientDuplex, teardown } = await connectPair(root, 'pot-home-no-hello.sock', null, null);
    try {
      const potHomeRepo = await (await import('./storage')).ensurePotGitRepo(HIVE, 'repo-pot-home-nohello');
      const potHomeSha = await mintCommit(potHomeRepo, 'pot-home work, no hello');
      await defaultRunGit(['update-ref', 'refs/heads/work', potHomeSha], potHomeRepo);
      const duplex = await (
        await import('./serve-wiring')
      ).openHiveGitFetchDuplex(clientDuplex, TOPIC, { repoKey: 'repo-pot-home-nohello' });
      const t0 = Date.now();
      const res = await fetchOverDuplex(clientRepo, duplex, ['+refs/heads/work:refs/heads/via-pot-home-nohello'], {
        timeoutMs: 30_000,
      });
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/serve refused: unverified-peer/);
      expect(Date.now() - t0).toBeLessThan(10_000);
      const rev = await defaultRunGit(['rev-parse', '--verify', '-q', 'refs/heads/via-pot-home-nohello'], clientRepo);
      expect(rev.code).not.toBe(0);
    } finally {
      await teardown();
    }
  });
});
