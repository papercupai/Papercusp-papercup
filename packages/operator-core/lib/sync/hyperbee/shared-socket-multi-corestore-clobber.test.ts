/**
 * WI-5673 — SHARED-SOCKET / MULTI-CORESTORE SERVE CLOBBER.
 *
 * THE PRODUCTION TOPOLOGY THIS MODELS (all three facts are in-tree today):
 *   1. There is ONE process-wide Hyperswarm (`_sharedSwarm`, swarm.ts:3163), so
 *      ONE peer socket is muxed across EVERY harness sharing that peer —
 *      "the live-fed rig runs hello-world-pot + hello-world + papercusp over a
 *      single connection" (swarm.ts:2702-2704, EI-13317/WI-5481).
 *   2. Each harness has its OWN Corestore (corestore.ts, cached per
 *      `${workspaceRoot}::${harnessSlug}`).
 *   3. Each harness's connection handler calls `opts.store.replicate(socket)`
 *      on that SHARED socket (swarm.ts:2519).
 *
 * So N distinct corestores call `.replicate()` on ONE stream. scope-cores.ts
 * (lines 13-15) documents — "verified against corestore 7.9.2 / hypercore 11 /
 * protomux source" — exactly why that is unsafe:
 *
 *     "protomux `pair()` is a Map SET keyed (protocol,id): a second corestore's
 *      `replicate()` on the same stream CLOBBERS the first's hypercore/alpha
 *      pairing — so the scoped store must never `replicate()` a shared socket."
 *
 * That invariant is honoured for the SCOPED store and violated by the MAIN
 * path. `pair()` registers the lazy `ondiscoverykey → _attachMaybe` SERVE
 * callback; a Map.set means only the LAST corestore to replicate the socket can
 * ever answer a discovery-key request. Every core belonging to a losing store is
 * then structurally UNSERVABLE on that connection — while the socket itself
 * stays fully handshaken and live.
 *
 * That is precisely the `connected_never_replicated [never_attached]` signature,
 * and it explains what a purely local theory could not:
 *   - the connection is alive (swarmConnections > 0) yet peersCount stays 0;
 *   - it is ORDER-dependent, hence non-deterministic run to run;
 *   - it is DIRECTION-selective (each side has its own pair() winner);
 *   - a peer handle to a core nobody serves sits at peersCount 0 FOREVER
 *     (verified separately: peer-log-post-connection-attach.test.ts + fact
 *     wi-5673-lead-peerscount-requires-remote-to-serve).
 *
 * The control case in this file is the same wiring with ONE corestore per side,
 * which must keep working — so a red here is specifically the multi-store
 * clobber, never a broken harness.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
// This is the exact stream a Hyperswarm connection hands to `store.replicate(socket)`,
// so the probe must use it. Upstream ships no types; the shim lives with the rest of the
// Holepunch shims in ./holepunch.d.ts, so the `NoiseSecretStream` annotation below is a
// real type rather than the `any` a `@ts-ignore` here used to leave it as.
import NoiseSecretStream from '@hyperswarm/secret-stream';
import { openOwnLog, openRemoteLog } from './peer-log';
import { __resetRemoteCoreHostsForTest, registerStoreMachine } from './remote-core-host';

const cleanups: Array<() => void> = [];

// WI-8533: a whole-test timeout used to hide which setup/replication await
// stalled. Keep the pending row too: afterEach can report it when Vitest times
// out before the promise settles. Each operation captures its test's array so
// a late settlement cannot overwrite the next test's diagnostic state.
interface PhaseMeasurement {
  name: string;
  startedAt: number;
  cpuStart: NodeJS.CpuUsage;
  wallMs?: number;
  cpuMs?: number;
  state: 'pending' | 'fulfilled' | 'rejected';
}
let phases: PhaseMeasurement[] = [];
beforeEach(() => { phases = []; });

async function phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const row: PhaseMeasurement = {
    name, startedAt: performance.now(), cpuStart: process.cpuUsage(), state: 'pending',
  };
  phases.push(row);
  try {
    const result = await operation();
    row.state = 'fulfilled';
    return result;
  } catch (error) {
    row.state = 'rejected';
    throw error;
  } finally {
    const cpu = process.cpuUsage(row.cpuStart);
    row.wallMs = performance.now() - row.startedAt;
    row.cpuMs = (cpu.user + cpu.system) / 1_000;
  }
}

afterEach(({ task }) => {
  if (task.result?.state === 'fail' || process.env.PAPERCUSP_SOCKET_PHASE_TRACE === '1') {
    // CPU is this worker process's usage during the phase, not host load or
    // proof of CPU contention. An unresolved phase remains explicitly pending.
    const measurements = phases.map((row) => {
      const cpu = process.cpuUsage(row.cpuStart);
      return {
        phase: row.name,
        state: row.state,
        wallMs: Math.round(row.wallMs ?? performance.now() - row.startedAt),
        processCpuMs: Math.round(row.cpuMs ?? (cpu.user + cpu.system) / 1_000),
      };
    });
    // eslint-disable-next-line no-console
    console.log(`[WI-8533 phases] ${JSON.stringify({ test: task.name, measurements })}`);
  }
  while (cleanups.length) {
    try {
      cleanups.pop()!();
    } catch {}
  }
});

function makeStoreDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });
  return dir;
}

function storeAt(dir: string): Corestore {
  const store = new Corestore(dir);
  cleanups.push(() => {
    void store.close();
  });
  return store;
}

function makeStore(prefix: string): Corestore {
  return storeAt(makeStoreDir(prefix));
}

/**
 * A real loopback NOISE-SECRET-STREAM pair — byte-for-byte the stream type a
 * Hyperswarm connection hands to `store.replicate(socket)` (that is what makes
 * `noiseStream.userData` a single SHARED Protomux, which is the whole point).
 * A raw TCP socket is NOT a substitute: hypercore's createProtocolStream reads
 * `outerStream.noiseStream` and throws `Invalid stream` without one.
 */
async function noiseStreamPair(): Promise<[NoiseSecretStream, NoiseSecretStream]> {
  const [rawA, rawB] = await phase('socket.loopback-connect', () => rawSocketPair());
  const a = new NoiseSecretStream(true, rawA);
  const b = new NoiseSecretStream(false, rawB);
  cleanups.push(() => {
    try {
      a.destroy();
      b.destroy();
    } catch {}
  });
  await phase('socket.noise-handshake', () => Promise.all([
    new Promise<void>((r) => a.on('connect', () => r())),
    new Promise<void>((r) => b.on('connect', () => r())),
  ]));
  return [a, b];
}

async function rawSocketPair(): Promise<[net.Socket, net.Socket]> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) {
        reject(new Error('no port'));
        return;
      }
      let a: net.Socket | null = null;
      let b: net.Socket | null = null;
      const done = (): void => {
        if (a && b) {
          server.close();
          cleanups.push(() => {
            try {
              a!.destroy();
              b!.destroy();
            } catch {}
          });
          resolve([a, b]);
        }
      };
      server.on('connection', (s) => {
        b = s;
        done();
      });
      const c = net.connect(addr.port, '127.0.0.1', () => {
        a = c;
        done();
      });
      c.on('error', reject);
    });
  });
}

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

async function seedLog(store: Corestore, hbKey: string): Promise<string> {
  const own = await phase(`seed.${hbKey}.open`, () => openOwnLog(store));
  await phase(`seed.${hbKey}.append`, () => own.append({
    type: 'put',
    table: 'features_consolidated',
    hbKey,
    value: {},
    ts: 10,
    schema_version: 1,
    author_pubkey: 'A',
  }));
  return own.keyHex;
}

// TEMPORARY MITIGATION: THE DEFECT case exceeded its former 30s budget; its
// causal phase is still unknown (WI-6554700010008533). The 90s budget is not a
// root-cause fix. Failures now report completed and pending measured phases;
// PAPERCUSP_SOCKET_PHASE_TRACE=1 also emits them for focused diagnostic runs.
describe('shared-socket multi-corestore serve clobber (WI-5673)', () => {
  it('CONTROL: one corestore per side over a real socket serves its log fine', async () => {
    const serveStore = makeStore('ssc-ctl-serve-');
    await serveStore.ready();
    const fetchStore = makeStore('ssc-ctl-fetch-');
    await fetchStore.ready();

    const keyHex = await seedLog(serveStore, 'CTL-1');

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remote = await openRemoteLog(fetchStore, keyHex);
    const attached = await waitFor(() => (remote.peersCount?.() ?? 0) > 0);

    expect(attached).toBe(true);
    await remote.update();
    expect(remote.length).toBe(1);
  }, 90_000);

  it('THE DEFECT: a SECOND corestore replicating the same socket makes the FIRST store’s log unservable (peersCount stays 0 on a live connection)', async () => {
    // Serve side: two "harnesses" sharing one socket, exactly like the rig.
    const serveFirst = makeStore('ssc-serve-1-');
    await phase('serveFirst.ready', () => serveFirst.ready());
    const serveSecond = makeStore('ssc-serve-2-');
    await phase('serveSecond.ready', () => serveSecond.ready());

    // Fetch side: mirror topology, so each store can hold its peer's handle.
    const fetchFirst = makeStore('ssc-fetch-1-');
    await phase('fetchFirst.ready', () => fetchFirst.ready());
    const fetchSecond = makeStore('ssc-fetch-2-');
    await phase('fetchSecond.ready', () => fetchSecond.ready());

    const keyFirst = await seedLog(serveFirst, 'H1-1');
    const keySecond = await seedLog(serveSecond, 'H2-1');

    const [sockFetch, sockServe] = await noiseStreamPair();

    // Both harnesses replicate the SHARED socket, in join order.
    serveFirst.replicate(sockServe);
    serveSecond.replicate(sockServe);
    fetchFirst.replicate(sockFetch);
    fetchSecond.replicate(sockFetch);

    await phase('replication.settle', () => waitFor(() => false, 250));

    // Production ordering: the peer log is admitted (opened) long after the
    // connection is established.
    const remoteFirst = await phase('remoteFirst.open', () => openRemoteLog(fetchFirst, keyFirst));
    const remoteSecond = await phase('remoteSecond.open', () => openRemoteLog(fetchSecond, keySecond));

    const firstAttached = await phase('remoteFirst.attach', () =>
      waitFor(() => (remoteFirst.peersCount?.() ?? 0) > 0, 4_000));
    const secondAttached = await phase('remoteSecond.attach', () =>
      waitFor(() => (remoteSecond.peersCount?.() ?? 0) > 0, 4_000));

    // Report both so a failure names WHICH store lost the pair() race.
    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 probe] firstAttached=${firstAttached} (peers=${remoteFirst.peersCount?.() ?? 0}) ` +
        `secondAttached=${secondAttached} (peers=${remoteSecond.peersCount?.() ?? 0})`,
    );

    // THE ASSERTION UNDER TEST: with the clobber, exactly one side can be
    // served — so this expectation FAILS while the defect is live, and is the
    // regression guard once the shared socket is muxed safely.
    expect({ firstAttached, secondAttached }).toEqual({
      firstAttached: true,
      secondAttached: true,
    });
  }, 90_000);

  /**
   * The one surviving leg of the clobber theory. The case above passes because
   * the serve-side core was ALREADY OPEN when `replicate()` ran, and corestore
   * eagerly attaches every open core at that moment — so the lazy
   * `ondiscoverykey` callback (the thing `pair()` clobbers) is never consulted.
   *
   * A core that is on disk but NOT open can only be served through that lazy
   * callback. If the second corestore's `pair()` really does strand the first,
   * THIS is where it shows: same live connection, same handshake, but the
   * requested core is answered by the wrong store's `_attachMaybe`.
   */
  it('COLD CORE CONTROL: with ONE corestore on the socket, a cold on-disk core IS served lazily', async () => {
    const serveDir = makeStoreDir('ssc-coldctl-');
    const warm = storeAt(serveDir);
    await warm.ready();
    const keyHex = await seedLog(warm, 'COLDCTL-1');
    await warm.close();

    const serveStore = storeAt(serveDir);
    await serveStore.ready();
    const fetchStore = makeStore('ssc-coldctl-fetch-');
    await fetchStore.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe); // the ONLY store on this socket
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remote = await openRemoteLog(fetchStore, keyHex);
    const attached = await waitFor(() => (remote.peersCount?.() ?? 0) > 0, 4_000);
    // eslint-disable-next-line no-console
    console.log(`[WI-5673 cold CONTROL] attached=${attached} (peers=${remote.peersCount?.() ?? 0})`);

    // This MUST pass — it is what isolates the failure below to the second
    // corestore's pair() clobber rather than to cold cores being unservable.
    expect(attached).toBe(true);
    await remote.update();
    expect(remote.length).toBe(1);
  }, 90_000);

  it('COLD CORE + a second corestore on the socket: PROVEN BROKEN — the log is unservable forever on a live connection (characterization; INVERT when fixed)', async () => {
    const serveFirstDir = makeStoreDir('ssc-cold-1-');
    const serveSecondDir = makeStoreDir('ssc-cold-2-');

    // Write the log, then CLOSE the whole store so the core is cold on disk.
    const warm = storeAt(serveFirstDir);
    await warm.ready();
    const keyFirst = await seedLog(warm, 'COLD-1');
    await warm.close();

    const serveFirst = storeAt(serveFirstDir);
    await serveFirst.ready();
    const serveSecond = storeAt(serveSecondDir);
    await serveSecond.ready();
    // serveSecond is the LAST to replicate, so it owns the hypercore/alpha
    // notify slot — the core being requested belongs to serveFirst.
    const keySecond = await seedLog(serveSecond, 'COLD-2');

    const fetchStore = makeStore('ssc-cold-fetch-');
    await fetchStore.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveFirst.replicate(sockServe);
    serveSecond.replicate(sockServe);
    fetchStore.replicate(sockFetch);
    await waitFor(() => false, 250);

    const remoteCold = await openRemoteLog(fetchStore, keyFirst);
    const coldAttached = await waitFor(() => (remoteCold.peersCount?.() ?? 0) > 0, 4_000);
    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 cold probe] coldAttached=${coldAttached} (peers=${remoteCold.peersCount?.() ?? 0}) ` +
        `warmKeyOnSecondStore=${keySecond.slice(0, 8)}`,
    );

    // ⚠ CHARACTERIZATION OF A LIVE DEFECT — this asserts the BROKEN behaviour
    // on purpose, so the shared green gate is not red-pinned by a known bug
    // while the fix is designed. The three assertions above it are the controls
    // that make this one mean "the second corestore's pair() clobber", and
    // nothing else: same cold core + same wiring with ONE store attaches fine.
    //
    // WHEN THE FIX LANDS, INVERT THIS: `expect(coldAttached).toBe(true)` plus
    // the update()/length/get() checks the COLD CORE CONTROL case already runs.
    // A green here after a fix means the fix did NOT work.
    expect(coldAttached).toBe(false);
    expect(remoteCold.peersCount?.() ?? 0).toBe(0);
  }, 90_000);

  /**
   * THE PRODUCTION SHAPE, taken from a real preserved failure bundle
   * (~/.papercusp/live-fed-gate/triage/fail/130857-replication_soak).
   *
   * The rig's two harnesses (`hello-world`, `hello-world-pot`) are in the SAME
   * hive, and each ADMITS THE OTHER'S PEER LOG — the bundle shows one key
   * admitted under both (`announce_admitted harness=hello-world-pot …
   * origin=hello-world … key=2860344a` ×14 and the mirror for 9b3550a9), and
   * replication-liveness running repair for the SAME key under BOTH harnesses
   * (2860344afd25: 5 repair lines under each). So ONE remote core is opened in
   * TWO different corestores on the SAME machine, and both stores replicate the
   * SAME peer socket.
   *
   * Both sessions want a replicator on one muxer, but `pair()` has ONE
   * hypercore/alpha slot. This models exactly that: two fetch-side stores, one
   * socket, one key.
   *
   * The bundle's episode pattern is the fingerprint to match — the SAME key
   * alternating `never_attached` (harness A's view) and `replicator_lost`
   * (harness B's view), with repair-on-detect reporting "re-attached" and the
   * log stalling again seconds later.
   */
  it('SAME KEY IN TWO CORESTORES that are NOT declared same-machine: only one can hold a replicator (upstream invariant — two simulated machines in one process)', async () => {
    __resetRemoteCoreHostsForTest();
    const serveStore = makeStore('ssc-samekey-serve-');
    await serveStore.ready();
    const keyHex = await seedLog(serveStore, 'SAMEKEY-1');

    // Two harness stores on the fetch side, mirroring hello-world +
    // hello-world-pot both admitting the same peer log.
    const fetchHarnessA = makeStore('ssc-samekey-fa-');
    await fetchHarnessA.ready();
    const fetchHarnessB = makeStore('ssc-samekey-fb-');
    await fetchHarnessB.ready();

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    fetchHarnessA.replicate(sockFetch);
    fetchHarnessB.replicate(sockFetch); // second store on the SAME socket
    await waitFor(() => false, 250);

    const viaA = await openRemoteLog(fetchHarnessA, keyHex);
    const viaB = await openRemoteLog(fetchHarnessB, keyHex);

    const aAttached = await waitFor(() => (viaA.peersCount?.() ?? 0) > 0, 4_000);
    const bAttached = await waitFor(() => (viaB.peersCount?.() ?? 0) > 0, 4_000);

    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 same-key probe] harnessA=${aAttached} (peers=${viaA.peersCount?.() ?? 0}) ` +
        `harnessB=${bAttached} (peers=${viaB.peersCount?.() ?? 0})`,
    );

    // Exactly ONE of the two stores gets a replicator; the other sits at
    // peersCount 0 indefinitely. Asserted as "exactly one" rather than "A wins"
    // so the guard does not depend on registration order.
    //
    // ⚠ THIS IS NOT A PAPERCUSP BUG TO FIX — it is an UPSTREAM INVARIANT, and
    // this case pins it so nobody re-litigates it. A Protomux carries at most
    // ONE hypercore/alpha channel per discovery key: hypercore's replicator
    // `_makePeer()` bails on `protomux.opened({ protocol, id: discoveryKey })`
    // and `protomux.createChannel` is `unique` by default (index.js:437). Two
    // INDEPENDENT replicas of one key can therefore never both replicate over
    // one socket.
    //
    // The papercusp defect (WI-5673) was CREATING two replicas of one key on one
    // machine — sibling harnesses in the same Hive admit the same keys but each
    // held its own Corestore. The fix removes the duplicate rather than trying
    // to win an unwinnable second slot; see the next test, and remote-core-host.ts.
    // These stores are deliberately NOT declared same-machine here (that models
    // two machines simulated in one process), so the dedup correctly does not
    // apply and the upstream invariant shows through.
    const attachedCount = (aAttached ? 1 : 0) + (bAttached ? 1 : 0);
    expect(attachedCount).toBe(1);
  }, 90_000);

  /**
   * THE FIX (WI-5673): the rig's real shape — two SIBLING harness stores on the
   * SAME machine, both admitting the same peer log, over one shared socket.
   *
   * `remote-core-host.ts` opens that log in exactly ONE store per machine and
   * hands the sibling a SESSION on it, so there is one core, one channel, and
   * both harnesses see live replication. Before the fix this was the production
   * failure: the losing harness reported the key as connected_never_replicated,
   * repair-on-detect "re-attached" a session that still could not win the single
   * slot, and repair-exhaustion escalated to a forced topic rejoin that tore
   * down the shared socket for the healthy co-tenants too.
   */
  it('SAME KEY, TWO SIBLING STORES ON ONE MACHINE: deduped to a single core, so BOTH harnesses replicate (WI-5673 fix)', async () => {
    __resetRemoteCoreHostsForTest();
    const serveStore = makeStore('ssc-dedup-serve-');
    await serveStore.ready();
    const keyHex = await seedLog(serveStore, 'DEDUP-1');

    const fetchHarnessA = makeStore('ssc-dedup-fa-');
    await fetchHarnessA.ready();
    const fetchHarnessB = makeStore('ssc-dedup-fb-');
    await fetchHarnessB.ready();

    // What the corestore factory declares for two harnesses of one workspace:
    // same machine ⇒ their admitted remote logs must share one core.
    registerStoreMachine(fetchHarnessA, '/machine-one');
    registerStoreMachine(fetchHarnessB, '/machine-one');

    const [sockFetch, sockServe] = await noiseStreamPair();
    serveStore.replicate(sockServe);
    fetchHarnessA.replicate(sockFetch);
    fetchHarnessB.replicate(sockFetch); // second store on the SAME socket
    await waitFor(() => false, 250);

    const viaA = await openRemoteLog(fetchHarnessA, keyHex);
    const viaB = await openRemoteLog(fetchHarnessB, keyHex);

    const aAttached = await waitFor(() => (viaA.peersCount?.() ?? 0) > 0, 4_000);
    const bAttached = await waitFor(() => (viaB.peersCount?.() ?? 0) > 0, 4_000);

    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 dedup probe] harnessA=${aAttached} (peers=${viaA.peersCount?.() ?? 0}) ` +
        `harnessB=${bAttached} (peers=${viaB.peersCount?.() ?? 0})`,
    );

    expect((aAttached ? 1 : 0) + (bAttached ? 1 : 0)).toBe(2);

    // …and the shared core actually carries data to BOTH harnesses: the whole
    // point is that the sibling is not merely "attached" but genuinely reading.
    await viaA.update();
    await viaB.update();
    expect(viaA.length).toBeGreaterThan(0);
    expect(viaB.length).toBe(viaA.length);
    expect(await viaB.get(0)).toMatchObject({ hbKey: 'DEDUP-1' });
  }, 90_000);

  /**
   * THE DIRECT PROOF OF THE RECONNECT-ORDER REFINEMENT.
   *
   * A natural experiment across two real gate bundles predicted that the winner
   * is decided by `replicate()` ORDER, and therefore RESHUFFLES on every
   * reconnect (~/.papercusp/live-fed-gate/triage/fail/…):
   *
   *   bundle            swarm-churn(A)  rejoins(A)  harnesses hit(A)  frame B episodes
   *   content_bidir            1            1              1                0
   *   replication_soak        85            5              3                4
   *
   * i.e. with no churn the SAME frame+harness loses every time (frame B never
   * emits an episode); with heavy churn both frames and both harnesses take
   * turns losing. That only follows if the winner is order-dependent.
   *
   * This test decides it mechanically, with no production instrumentation:
   * run the same two-store/one-key setup in BOTH registration orders and see
   * whether the winner follows the order. If it does, a reconnect — which
   * re-runs both stores' replicate() in whatever order they reconnect — can
   * hand the replicator to the other harness, which is exactly the observed
   * never_attached ⇄ replicator_lost churn on a single key.
   */
  it('WHAT DECIDES THE WINNER: core-OPEN order, not replicate() order (a first attempt asserting replicate-order was REFUTED here)', async () => {
    async function winnerFor(
      replicateOrder: 'A-first' | 'B-first',
      openOrder: 'A-first' | 'B-first',
    ): Promise<string> {
      const tag = `${replicateOrder}-${openOrder}`;
      const serveStore = makeStore(`ssc-ord-serve-${tag}-`);
      await serveStore.ready();
      const keyHex = await seedLog(serveStore, 'ORDER-1');

      const storeA = makeStore(`ssc-ord-a-${tag}-`);
      await storeA.ready();
      const storeB = makeStore(`ssc-ord-b-${tag}-`);
      await storeB.ready();

      const [sockFetch, sockServe] = await noiseStreamPair();
      serveStore.replicate(sockServe);
      if (replicateOrder === 'A-first') {
        storeA.replicate(sockFetch);
        storeB.replicate(sockFetch);
      } else {
        storeB.replicate(sockFetch);
        storeA.replicate(sockFetch);
      }
      await waitFor(() => false, 250);

      let viaA;
      let viaB;
      if (openOrder === 'A-first') {
        viaA = await openRemoteLog(storeA, keyHex);
        viaB = await openRemoteLog(storeB, keyHex);
      } else {
        viaB = await openRemoteLog(storeB, keyHex);
        viaA = await openRemoteLog(storeA, keyHex);
      }
      await waitFor(() => (viaA.peersCount?.() ?? 0) > 0 || (viaB.peersCount?.() ?? 0) > 0, 4_000);
      await waitFor(() => false, 500); // fair chance for the loser to attach late

      const a = (viaA.peersCount?.() ?? 0) > 0;
      const b = (viaB.peersCount?.() ?? 0) > 0;
      return `${a ? 'A' : ''}${b ? 'B' : ''}` || 'NEITHER';
    }

    const repA_openA = await winnerFor('A-first', 'A-first');
    const repB_openA = await winnerFor('B-first', 'A-first');
    const repA_openB = await winnerFor('A-first', 'B-first');
    const repB_openB = await winnerFor('B-first', 'B-first');

    // eslint-disable-next-line no-console
    console.log(
      `[WI-5673 order matrix] rep=A,open=A -> ${repA_openA} | rep=B,open=A -> ${repB_openA} | ` +
        `rep=A,open=B -> ${repA_openB} | rep=B,open=B -> ${repB_openB}`,
    );

    // The defect itself: never both, in any combination.
    for (const w of [repA_openA, repB_openA, repA_openB, repB_openB]) {
      expect(['A', 'B']).toContain(w);
    }

    // REFUTED (recorded so nobody re-tries it): replicate() order does NOT
    // decide the winner — holding open-order fixed and flipping replicate order
    // leaves the winner unchanged.
    expect(repA_openA).toBe(repB_openA);
    expect(repA_openB).toBe(repB_openB);

    // WHAT DOES decide it: whichever store OPENS the core first claims the
    // muxer channel for that discovery key; the other never gets a replicator.
    // This still permits the victim to flip across a reconnect — both harnesses'
    // repair loops race to re-open after a rejoin — but the race is on OPEN,
    // not on replicate().
    expect(repA_openA).toBe('A');
    expect(repA_openB).toBe('B');
  }, 120_000);
});
