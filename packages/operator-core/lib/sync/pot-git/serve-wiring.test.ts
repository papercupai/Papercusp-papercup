/**
 * serve-wiring.test.ts — unit coverage for EI-18765930091826096's session-leak
 * DETECTOR (`noteSessionHighWater`).
 *
 * WHY A UNIT SIBLING rather than more cases in serve-wiring.integration.test.ts:
 * the detector is pure decision logic over two map sizes, and the property that
 * matters most — that it stays SILENT in healthy operation and reports ONCE per
 * new high-water rather than per session — is about what it does NOT emit. That
 * is awkward to pin down through a real socket + real `git upload-pack`, where
 * session counts are timing-dependent; here every count is exact and chosen.
 *
 * WHY THESE ASSERT ON `sessionWarnHighWater` AND NOT ON THE LOG LINE: `potGitLog`
 * is a deliberate no-op under vitest (the repo runs `vitest-fail-on-console`, so
 * an unconditional diagnostic would fail every suite touching this path), which
 * makes the warn itself unobservable in-process. The high-water is written on
 * the SAME branch that emits the warn, so asserting the bookkeeping IS asserting
 * the detector fired. Confirmed non-vacuous: stubbing `noteSessionHighWater` to a
 * no-op fails the "fires" and "new high-water" cases below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// WI-6364: the superseded-store lookup reads the harness registry. PARTIAL mock
// (importOriginal) is mandatory — serve-wiring's transitive imports touch other
// exports of this module at import time, and vitest throws on ANY missing key
// with an error naming an unrelated module.
const { loadRegistryMock } = vi.hoisted(() => ({ loadRegistryMock: vi.fn() }));
vi.mock('../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadHarnessRegistry: loadRegistryMock,
}));

import {
  _testing,
  resolvePeerAdmission,
  resolveServeAdmission,
  DEFAULT_SERVE_PROGRESS_WINDOW_MS,
  type InFlightServe,
  type ServeProgress,
} from './serve-wiring';

const { SESSION_LEAK_WARN_AT, noteSessionHighWater, newChannelState, formatRefusalTarget } = _testing;

/** The detector reads only `.size` off the two session maps, so a plain filler
 *  object per slot is sufficient and keeps these cases free of socket plumbing. */
function withSessions(client: number, server: number): ReturnType<typeof newChannelState> {
  // topic/mux are carried only so a refusal can name its own lookup key; the
  // leak detector reads neither, so any placeholder keeps these cases honest.
  const state = newChannelState('00'.repeat(32), null);
  for (let i = 0; i < client; i++) state.clientSessions.set(i, {} as never);
  for (let i = 0; i < server; i++) state.serverSessions.set(i, {} as never);
  return state;
}

describe('pot-git session-leak detector (EI-18765930091826096 recurrence guard)', () => {
  it('the threshold sits above healthy operation (sessions are per-fetch, so healthy is 0-1)', () => {
    // Guards the constant itself: a threshold at 0/1 would fire on every normal
    // fetch and train readers to ignore the line — the failure mode that makes a
    // detector worse than none.
    expect(SESSION_LEAK_WARN_AT).toBeGreaterThan(1);
  });

  it('stays SILENT below the threshold — a healthy peer never emits this line', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT - 1, 0);
    expect(noteSessionHighWater(state)).toBe(false);
    expect(state.sessionWarnHighWater).toBe(0);
  });

  it('fires once the live session total reaches the threshold', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT);
  });

  it('counts BOTH directions — a leak on the serving side is just as real', () => {
    // Splitting the same total across client+server must still trip it: the
    // incident leaked client sessions, but abandoned rungs also strand the
    // serving side's `git upload-pack`.
    const client = Math.floor(SESSION_LEAK_WARN_AT / 2);
    const state = withSessions(client, SESSION_LEAK_WARN_AT - client);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT);
  });

  it('does NOT re-report at the same level — a sustained leak cannot become the storm', () => {
    // Asserts the EMISSION DECISION, not the high-water value: the value is
    // identical whether a repeat call warned or stayed quiet, so a value-only
    // assertion here passes against a detector that warns every single time.
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    // Re-registering at an unchanged count (the shape a steady leak produces
    // while it plateaus) must emit nothing further.
    expect(noteSessionHighWater(state)).toBe(false);
    expect(noteSessionHighWater(state)).toBe(false);
  });

  it('reports again only on a NEW high-water — which is the signal that it is still climbing', () => {
    const state = withSessions(SESSION_LEAK_WARN_AT, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    state.clientSessions.set(999, {} as never);
    expect(noteSessionHighWater(state)).toBe(true);
    expect(state.sessionWarnHighWater).toBe(SESSION_LEAK_WARN_AT + 1);
  });

  it('stays quiet when sessions DRAIN and re-climb below the previous peak (the fix working)', () => {
    // This is the post-fix shape: counts rise under load and fall back as fetches
    // settle. Re-reporting every oscillation would make a HEALTHY peer noisy and
    // bury a real climb.
    const state = withSessions(SESSION_LEAK_WARN_AT + 4, 0);
    expect(noteSessionHighWater(state)).toBe(true);
    const peak = state.sessionWarnHighWater;
    state.clientSessions.clear();
    expect(noteSessionHighWater(state)).toBe(false);
    for (let i = 0; i < SESSION_LEAK_WARN_AT + 1; i++) state.clientSessions.set(i, {} as never);
    expect(noteSessionHighWater(state)).toBe(false);
    expect(state.sessionWarnHighWater).toBe(peak);
  });
});

/**
 * EI-18776567787336109 — the per-fetch duplex must honour protomux's flow
 * control.
 *
 * THE BUG: `_write` called its callback unconditionally, so node was always
 * told "that write landed, send more" no matter how backed up the muxer's
 * stream was. A warm fetch (100-650 ms) never notices; a multi-GB cold join
 * shovels the entire pack into the connection as fast as upload-pack can
 * produce it, because nothing upstream can apply the brakes.
 *
 * protomux reports the pressure both ways — `send()` returns the muxer's
 * `drained` flag, and a channel gets an `ondrain` callback — so honouring it is
 * what makes this duplex a properly flow-controlled stream: the deferred write
 * callback pauses `child.stdout` through the existing pipe.
 */
describe('FrameDuplex backpressure (EI-18776567787336109)', () => {
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  it('PARKS the write callback while the wire is backed up, and resumes on drain', async () => {
    const resumes: Array<() => void> = [];
    let sent = 0;
    const d = new _testing.FrameDuplex(
      () => {
        sent++;
        return false; // protomux: "stream is full, stop writing"
      },
      () => {},
      (resume) => resumes.push(resume),
    );

    let writeDone = false;
    d.write(Buffer.from('pack-bytes'), () => {
      writeDone = true;
    });
    await tick();

    // The bytes went out, but the write is NOT acknowledged — that unacknowledged
    // callback is the entire braking mechanism.
    expect(sent).toBe(1);
    expect(writeDone).toBe(false);
    expect(resumes).toHaveLength(1);

    // The channel drains -> the parked write completes.
    for (const r of resumes.splice(0)) r();
    await tick();
    expect(writeDone).toBe(true);
  });

  it('does NOT park when the wire reports it is drained', async () => {
    const resumes: Array<() => void> = [];
    const d = new _testing.FrameDuplex(
      () => true, // protomux: "plenty of room"
      () => {},
      (resume) => resumes.push(resume),
    );

    let writeDone = false;
    d.write(Buffer.from('x'), () => {
      writeDone = true;
    });
    await tick();

    expect(writeDone).toBe(true);
    expect(resumes).toHaveLength(0);
  });
});

/**
 * WI-6364 (fix C) — the serve path must REFUSE a store it has abandoned rather
 * than answer a fetch out of it.
 *
 * The VERDICT is pure and tested in repo-identity.test.ts. What only this side
 * can cover is the wiring around it: which registry entries are even eligible,
 * and the fail-open contract. Both matter more than they look — a too-wide
 * entry set lets an unrelated pot's abandoned alias refuse a healthy fetch, and
 * a fail-CLOSED registry error would take the whole serve plane down on a
 * diagnostic improvement.
 */
describe('WI-6364: the serve path\'s superseded-store lookup', () => {
  const { resolveSupersededRepoKey } = _testing;

  /** The live tower shape: the pot home (re-keyed to gh-<id> on 2026-07-20,
   *  stranding `papercusp.git`), a member repo under the SAME pot directory,
   *  and an unrelated pot that has its own abandoned alias. */
  const REGISTRY = {
    projects: [
      { slug: 'papercusp', self_repo: true, github_repository_id: 1223568103 },
      { slug: 'hive-canary', hive_slug: 'papercusp' },
      { slug: 'other-pot', self_repo: true, github_repository_id: 999 },
    ],
  };

  it('THE LIVE REPRO: the pot home\'s abandoned alias is refused, naming the canonical key', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'papercusp')).resolves.toEqual({
      requested: 'papercusp',
      canonical: 'gh-1223568103',
      entrySlug: 'papercusp',
    });
  });

  it('serves the canonical key, and serves a member repo sharing the pot directory', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'gh-1223568103')).resolves.toBeNull();
    await expect(resolveSupersededRepoKey('papercusp', 'hive-canary')).resolves.toBeNull();
  });

  it('SCOPING: another pot\'s abandoned alias can never refuse a fetch here', async () => {
    // `other-pot` is a superseded alias — but of a pot whose stores do not live
    // under this potHomeSlug. A registry-wide scan would refuse this.
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('papercusp', 'other-pot')).resolves.toBeNull();
  });

  it('a pot with no registry entries at all yields no verdict', async () => {
    loadRegistryMock.mockResolvedValue(REGISTRY);
    await expect(resolveSupersededRepoKey('unknown-pot', 'papercusp')).resolves.toBeNull();
  });

  it('FAILS OPEN: an unreadable registry never refuses — a diagnostic must not take the serve plane down', async () => {
    loadRegistryMock.mockRejectedValue(new Error('registry unreadable'));
    await expect(resolveSupersededRepoKey('papercusp', 'papercusp')).resolves.toBeNull();
  });
});

describe('serve-refusal diagnosability (a refusal must name its own lookup key)', () => {
  const REQUESTED = 'd85dc18c0bac0c9a'.repeat(4); // 64 hex
  const OTHER = '0edc4b5f618f81b3'.repeat(4);

  // The regression this guards is not a crash — it is a refusal that cannot be
  // acted on. `not-serving` is decided by a (muxer, topic) lookup, so dropping
  // the topic from the line makes the reason unfalsifiable from logs; that is
  // what stalled the live rig<->tower papercusp diagnosis.
  it('names the topic the refusal is about', () => {
    expect(formatRefusalTarget('not-serving', REQUESTED, [])).toContain(`topic=${REQUESTED.slice(0, 16)}`);
    // every reason carries the topic, not only not-serving
    expect(formatRefusalTarget('no-such-repo', REQUESTED, [])).toContain(`topic=${REQUESTED.slice(0, 16)}`);
  });

  it('DISTINGUISHES the two shapes of not-serving: an unwired muxer vs a channel-id mismatch', () => {
    // (1) nothing wired on this muxer at all
    expect(formatRefusalTarget('not-serving', REQUESTED, [])).toContain('serveTopics=<none>');
    // (2) this muxer DOES serve — just not the requested topic. Distinct from
    // (1), and the pair is what identifies a dialer/server channel-id mismatch.
    const mismatch = formatRefusalTarget('not-serving', REQUESTED, [OTHER]);
    expect(mismatch).toContain(`serveTopics=${OTHER.slice(0, 16)}`);
    expect(mismatch).not.toContain('<none>');
  });

  it('reports an unreadable registration set as distinct from an empty one', () => {
    // Collapsing these would let a broken probe read as a confident "nothing
    // is wired here" — the diagnosis and the fix differ.
    expect(formatRefusalTarget('not-serving', REQUESTED, null)).toContain('serveTopics=<unreadable>');
  });

  it('omits serveTopics for reasons that do not depend on it', () => {
    // no-such-repo already proves serve WAS registered, so the set is noise.
    expect(formatRefusalTarget('no-such-repo', REQUESTED, [OTHER])).not.toContain('serveTopics');
  });

  it('survives a state with no topic rather than printing a misleading empty key', () => {
    expect(formatRefusalTarget('not-serving', '', [])).toContain('topic=<unknown>');
  });
});

describe('EI-18802104888674071: serve reachability across a shared peer connection', () => {
  const { resolveServeRegistration } = _testing;
  const cfgA = { potHomeSlug: 'papercusp', workspaceId: 'ws-1' };
  const cfgB = { potHomeSlug: 'hello-world-3-pot', workspaceId: 'ws-1' };
  const OWN_SOCKET = { tag: 'wired-here' };
  const LIVE_SOCKET = { tag: 'this-muxers-live-connection' };

  // THE LIVE REPRO. Two pots share one peer connection; whichever pot's swarm
  // handled it is the only one `wireHiveGitServe` ran for, but `mux.pair` is
  // registered at PROTOCOL scope so the OTHER pot's channel still materializes
  // here. Before this fix that channel refused `not-serving` for the life of
  // the connection — observed on the rig as
  // `topic=d85dc18c…(papercusp) serveTopics=0edc4b5f…(hello-world-3-pot)`.
  it('serves a pot wired on ANOTHER muxer, using THIS connection for identity', () => {
    const got = resolveServeRegistration(undefined, cfgA, LIVE_SOCKET);
    expect(got?.serverConfig).toBe(cfgA);
    // Identity MUST come from the live connection. Carrying the socket stored
    // at the original registration would authenticate this peer as a different
    // one — the failure mode that makes widening the lookup dangerous at all.
    expect(got?.socket).toBe(LIVE_SOCKET);
  });

  it('prefers this muxer\'s OWN registration over the process-wide one', () => {
    const got = resolveServeRegistration({ serverConfig: cfgB, socket: OWN_SOCKET }, cfgA, LIVE_SOCKET);
    expect(got?.serverConfig).toBe(cfgB);
    expect(got?.socket).toBe(OWN_SOCKET);
  });

  // The boundary that keeps this from being a privilege leak: the fallback is
  // keyed by the SAME topicHex, never "any config on this muxer". A pot this
  // box never wired serve for stays unserved.
  it('REFUSES a topic this box never wired serve for anywhere', () => {
    expect(resolveServeRegistration(undefined, undefined, LIVE_SOCKET)).toBeNull();
  });

  it('REFUSES when the peer on this connection cannot be identified', () => {
    // No socket ⇒ resolvePeerDevicePubkey has nothing to authenticate against.
    // Adopting the config anyway would serve an unauthenticated peer.
    expect(resolveServeRegistration(undefined, cfgA, undefined)).toBeNull();
  });
});

// ─── EI-18802033487678337: bounded per-repo serve concurrency ───────────
//
// WHY A PURE UNIT: the rule this guards is a LIVE-TOPOLOGY property (how many
// `pack-objects` processes one repo can be made to run at once), and the
// surrounding path needs a Protomux, a real bare repo, and a spawned
// upload-pack. The decision itself is pure, so it is asserted here where every
// input is exact — the same split that made `resolveServeRegistration`
// testable.
//
// WHAT THIS IS PROTECTING (live tower, 2026-07-27): 3+ concurrent
// `git pack-objects` on one 4.1G repo, 1.0-1.7GB RSS and 40-126% CPU each,
// spawned ~15s apart, with serves logging 120-566s against a requester whose
// ceiling is 120s. Contention pushed every serve past that ceiling, the
// requester re-dialled, and each re-dial added another process — a loop that
// amplifies rather than settles.
describe('resolveServeAdmission (EI-18802033487678337)', () => {
  const REPO = '/pot-git/papercusp/papercusp.git';
  const OTHER = '/pot-git/papercusp/other.git';
  const chanA = { c: 'A' };
  const chanB = { c: 'B' };
  const chanC = { c: 'C' };
  // Default progress is "never wrote a byte", which is what every pre-WI-6412
  // case here assumed implicitly — so the rule-1/rule-2 expectations below are
  // unchanged by the progress rule, and still assert exactly what they used to.
  const serve = (
    channel: object,
    repoPath: string,
    sessionId: number,
    progress: ServeProgress = { bytesOut: 0, bytesIn: 0, lastWriteAt: 0 },
  ): InFlightServe => ({
    channel,
    repoPath,
    repoKey: 'papercusp',
    sessionId,
    startedAt: 0,
    progress,
  });

  it('admits freely when the repo is idle', () => {
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // Rule 1 — the orphan reaper. A requester drives at most one fetch of a given
  // repo per channel at a time (the deepen ladder's rungs are strictly
  // sequential), so a SECOND live request for the same repo on the same channel
  // proves the first will never be read again.
  it('SUPERSEDES an in-flight serve of the same repo on the same channel', () => {
    const stale = serve(chanA, REPO, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [stale] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([stale]);
  });

  // The boundary that keeps rule 1 from being a cross-peer kill: a DIFFERENT
  // channel is a different peer connection, whose fetch is live and must not be
  // torn down by someone else's request.
  it("never supersedes another CHANNEL's serve of the same repo", () => {
    const other = serve(chanB, REPO, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [other] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // ...and the same-channel rule is scoped to the same REPO: a peer fetching
  // two different repos concurrently is legitimate.
  it("never supersedes the same channel's serve of a DIFFERENT repo", () => {
    const other = serve(chanA, OTHER, 1);
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanA, inFlight: [other] });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // Capacity is no longer decided by a local numeric cap. Distinct peers are
  // admitted here; the shared adaptive governor owns any queueing decision at
  // the actual `upload-pack` process boundary.
  it('admits concurrent serves from distinct channels without a local cap', () => {
    const inFlight = Array.from({ length: 8 }, (_, i) => serve({ c: i }, REPO, i + 1));
    const got = resolveServeAdmission({ repoPath: REPO, channel: chanC, inFlight });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  it('still supersedes same-channel work while other channels continue', () => {
    const mine = serve(chanA, REPO, 1);
    const got = resolveServeAdmission({
      repoPath: REPO,
      channel: chanA,
      inFlight: [mine, serve(chanB, REPO, 2)],
    });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([mine]);
  });

  // Supersession remains scoped to the same repository path even though the
  // local capacity cap has been removed.
  it('does not supersede a different repo on the same channel', () => {
    const got = resolveServeAdmission({
      repoPath: REPO,
      channel: chanA,
      inFlight: [serve(chanA, OTHER, 1)],
    });
    expect(got.admit).toBe(true);
    expect(got.supersede).toEqual([]);
  });

  // ─── WI-6412: rule 0, progress-aware supersession ───────────────────────
  //
  // The livelock, from the live bg-host log (2026-07-27 12:02–12:04, pid
  // 2949152): ONE peer re-requested the same repo every ~15s, and every
  // re-request superseded our own in-flight `upload-pack`. Nine consecutive
  // attempts streamed 145MB → 790MB of real pack data and each was discarded at
  // ~15s, so a ~4.1GB repo could never converge — ~2.4GB served and thrown away
  // in two minutes, at zero progress.
  //
  // The defect is in rule 1's PREMISE, not its implementation: "a second live
  // request for the same repo on the same channel PROVES the first will never
  // be read again" is false against a requester that re-drives on a timer, and
  // the cost of believing it scales with the size of the transfer — it is
  // maximally wrong exactly when the transfer matters most.
  describe('rule 0 — an actively streaming serve is never discarded (WI-6412)', () => {
    const NOW = 1_000_000;
    // A genuinely streaming serve necessarily has inbound bytes: `upload-pack`
    // cannot emit any pack data before the client's `command=fetch` + wants
    // arrive. `bytesIn` is small because a request is small — the asymmetry with
    // `bytesOut` is the normal shape of a fetch, not a quirk of this fixture.
    const streamed = (msSinceLastWrite: number, bytesOut = 145_081_103): ServeProgress => ({
      bytesOut,
      bytesIn: 226,
      lastWriteAt: NOW - msSinceLastWrite,
    });

    it('REFUSES the re-request instead of discarding a serve that is streaming right now', () => {
      const live = serve(chanA, REPO, 1, streamed(200));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [live],
        now: NOW,
      });
      // The whole point: the in-flight transfer survives the re-request.
      expect(got.supersede).toEqual([]);
      // ...and the re-request is refused rather than admitted, because admitting
      // it would run a SECOND pack-objects over the same multi-GB repo for a
      // peer that already has a live stream it can just keep reading.
      expect(got.admit).toBe(false);
      expect(got.refuseReason).toBe('busy-streaming');
    });

    // Rule 1 still has to work: this is the case it was built for, and the fix
    // must not cost it. A serve whose bytes stopped is genuinely abandoned.
    it('still SUPERSEDES a serve whose last byte is older than the progress window', () => {
      const stalled = serve(chanA, REPO, 1, streamed(DEFAULT_SERVE_PROGRESS_WINDOW_MS + 1));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [stalled],
        now: NOW,
      });
      expect(got.admit).toBe(true);
      expect(got.supersede).toEqual([stalled]);
    });

    // Keyed on bytes ACTUALLY MOVED, not on a fresh timestamp: a serve that was
    // admitted a moment ago but has produced nothing is the orphan rule 1
    // exists to reap, and must not be protected just for being young.
    it('still SUPERSEDES a serve that has never written a byte, however recent', () => {
      const orphan = serve(chanA, REPO, 1, { bytesOut: 0, bytesIn: 0, lastWriteAt: NOW });
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [orphan],
        now: NOW,
      });
      expect(got.admit).toBe(true);
      expect(got.supersede).toEqual([orphan]);
    });

    // WI-6189 — THE GREETING-WEDGE. `bytesOut > 0` alone could not answer "is
    // this serve streaming?", because protocol v2 opens with a capability
    // advertisement the server writes BEFORE reading any input. Measured on this
    // box at exactly 147B, and identical for a 120K repo and a 4.9M one (it
    // carries no repo content), so it is nonzero for every serve that got as far
    // as spawning — including one that then hangs forever because the requester
    // never sent its `command=fetch`.
    //
    // Live on the tower 2026-08-02: across six hours EVERY serve to peers
    // nWXvaGiA/Lm1ABoMR died at 0B or exactly 147B — not one ever reached its
    // first pack byte — while 10 requests in a single 30s window were refused
    // `busy-streaming` behind a serve stuck at the greeting.
    const V2_CAPABILITY_ADVERTISEMENT_BYTES = 147;
    const greetedThenHung = (msSinceGreeting: number): ServeProgress => ({
      bytesOut: V2_CAPABILITY_ADVERTISEMENT_BYTES,
      // The whole point: the requester never asked for anything.
      bytesIn: 0,
      lastWriteAt: NOW - msSinceGreeting,
    });

    it('SUPERSEDES a serve wedged at the v2 greeting, however recent its 147B write', () => {
      const wedged = serve(chanA, REPO, 1, greetedThenHung(100));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [wedged],
        now: NOW,
      });
      // Before the fix this was held as `busy-streaming` for the full window.
      expect(got.admit).toBe(true);
      expect(got.supersede).toEqual([wedged]);
      expect(got.refuseReason).toBeUndefined();
    });

    // The operative harm was not the wasted slot, it was the REFUSALS issued on
    // the wedged serve's behalf — the requests that might have succeeded.
    it('does not refuse busy-streaming behind a greeting-wedged serve', () => {
      let refusals = 0;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const t = NOW + attempt * 3_000;
        const got = resolveServeAdmission({
          repoPath: REPO,
          channel: chanA,
          // Re-wedged each time: a fresh 147B greeting, still no inbound byte.
          inFlight: [serve(chanA, REPO, 1, { ...greetedThenHung(0), lastWriteAt: t - 100 })],
          now: t,
        });
        if (got.refuseReason === 'busy-streaming') refusals += 1;
      }
      expect(refusals).toBe(0);
    });

    // The boundary that keeps the fix from being a blunt byte threshold: a real
    // stream that has only just begun has FEWER outbound bytes than the wedged
    // serve above, and must still be protected. Keying on `bytesIn` gets this
    // right; comparing `bytesOut` against 147 would get it exactly backwards.
    it('protects a real stream whose pack has barely started (fewer bytes than the greeting)', () => {
      const justStarted = serve(chanA, REPO, 1, {
        bytesOut: 64,
        bytesIn: 226,
        lastWriteAt: NOW - 100,
      });
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [justStarted],
        now: NOW,
      });
      expect(got.supersede).toEqual([]);
      expect(got.refuseReason).toBe('busy-streaming');
    });

    // ...and the fix must not resurrect the WI-6412 livelock it narrows: that
    // one streamed 145MB-790MB, which necessarily had inbound bytes.
    it('still protects the WI-6412 multi-GB transfer (it has inbound bytes by construction)', () => {
      const live = serve(chanA, REPO, 1, streamed(200));
      expect(live.progress.bytesIn).toBeGreaterThan(0);
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [live],
        now: NOW,
      });
      expect(got.supersede).toEqual([]);
      expect(got.refuseReason).toBe('busy-streaming');
    });

    it('treats the window boundary itself as still streaming', () => {
      const edge = serve(chanA, REPO, 1, streamed(DEFAULT_SERVE_PROGRESS_WINDOW_MS));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [edge],
        now: NOW,
      });
      expect(got.supersede).toEqual([]);
    });

    // Same input, two windows, opposite verdicts — so the window is provably
    // consulted rather than incidentally satisfied.
    it('honours an explicit progressWindowMs in both directions', () => {
      const live = serve(chanA, REPO, 1, streamed(8_000));
      const base = { repoPath: REPO, channel: chanA, inFlight: [live], now: NOW };
      expect(resolveServeAdmission({ ...base, progressWindowMs: 10_000 }).supersede).toEqual([]);
      expect(resolveServeAdmission({ ...base, progressWindowMs: 5_000 }).supersede).toEqual([live]);
    });

    // Rule 0 is scoped exactly like rule 1 — same channel AND same repo. A
    // different peer's live transfer is rule 2's business, not rule 0's, and
    // must not start refusing unrelated requests.
    it("a DIFFERENT channel's streaming serve does not trigger rule 0", () => {
      const other = serve(chanB, REPO, 1, streamed(10));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [other],
        now: NOW,
      });
      expect(got.admit).toBe(true);
      expect(got.supersede).toEqual([]);
    });

    it("the same channel's streaming serve of a DIFFERENT repo does not block", () => {
      const other = serve(chanA, OTHER, 1, streamed(10));
      const got = resolveServeAdmission({
        repoPath: REPO,
        channel: chanA,
        inFlight: [other],
        now: NOW,
      });
      expect(got.admit).toBe(true);
      expect(got.supersede).toEqual([]);
    });

    // The end-to-end regression, at the cadence actually observed: a peer
    // re-requesting every 15s against a serve that keeps streaming must now
    // discard NOTHING, where the old rule discarded all nine attempts.
    it('breaks the observed livelock: 9 re-requests at ~15s discard nothing', () => {
      let servedBytes = 0;
      let discarded = 0;
      for (let attempt = 0; attempt < 9; attempt += 1) {
        const t = NOW + attempt * 15_000;
        servedBytes += 145_000_000;
        const got = resolveServeAdmission({
          repoPath: REPO,
          channel: chanA,
          // Still streaming when the re-request lands — the last write is
          // moments old, not 15s old.
          inFlight: [
            serve(chanA, REPO, 1, { bytesOut: servedBytes, bytesIn: 226, lastWriteAt: t - 100 }),
          ],
          now: t,
        });
        discarded += got.supersede.length;
      }
      expect(discarded).toBe(0);
    });
  });
});

/**
 * WI-10006832: only a verified, attested, non-revoked device may pull ANY repo. WI-10006827
 * (soak c1010r: the tower served the main repo to device ywj8zjsF four minutes after it was
 * revoked) closed the revoked half with a deny-list, which still served an UNVERIFIED socket.
 * The end-to-end wiring (real pot_members rows refusing real fetches) is in
 * serve-wiring.integration.test.ts.
 */
describe('resolvePeerAdmission (WI-10006832, supersedes WI-10006827)', () => {
  const base = { workspaceId: 'ws-1', potHomeSlug: 'pot-a' };
  // MEMBER= is attested to github user 77; nobody attests STRANGER=.
  const members: Record<string, number> = { 'MEMBER=': 77, 'REVOKED=': 88 };
  const resolveMember = vi.fn(async (_ws: string, _slug: string, pk: string) => members[pk] ?? null);
  const loadRevoked = vi.fn(async () => new Set(['REVOKED=', 'OTHER=']));
  beforeEach(() => {
    resolveMember.mockClear();
    loadRevoked.mockClear();
  });

  it('admits a verified, attested, non-revoked device and returns its member (calibration: not refuse-all)', async () => {
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: 'MEMBER=', loadRevoked, resolveMember }),
    ).resolves.toEqual({ ok: true, githubUserId: 77 });
    expect(loadRevoked).toHaveBeenCalledWith('ws-1', 'pot-a');
    expect(resolveMember).toHaveBeenCalledWith('ws-1', 'pot-a', 'MEMBER=');
  });

  it('refuses an UNVERIFIED socket (no signed hello) and reads nothing: the WI-10006832 hole', async () => {
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: undefined, loadRevoked, resolveMember }),
    ).resolves.toEqual({ ok: false, refusal: 'unverified-peer' });
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: '', loadRevoked, resolveMember }),
    ).resolves.toEqual({ ok: false, refusal: 'unverified-peer' });
    expect(loadRevoked).not.toHaveBeenCalled();
    expect(resolveMember).not.toHaveBeenCalled();
  });

  it('refuses a revoked device by name, even when a stale attestation still maps it to a member', async () => {
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: 'REVOKED=', loadRevoked, resolveMember }),
    ).resolves.toEqual({ ok: false, refusal: 'revoked-device' });
  });

  it('refuses a verified device that no member of this pot attests', async () => {
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: 'STRANGER=', loadRevoked, resolveMember }),
    ).resolves.toEqual({ ok: false, refusal: 'unknown-device' });
  });

  it('fails closed when the revoked set cannot be read', async () => {
    const failingRevoked = vi.fn(async (): Promise<Set<string>> => {
      throw new Error('pg down');
    });
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: 'MEMBER=', loadRevoked: failingRevoked, resolveMember }),
    ).resolves.toEqual({ ok: false, refusal: 'revocation-lookup-error' });
  });

  it('fails closed when the member lookup errors', async () => {
    const failingMember = vi.fn(async (): Promise<number | null> => {
      throw new Error('pg down');
    });
    await expect(
      resolvePeerAdmission({ ...base, peerDevicePubkey: 'MEMBER=', loadRevoked, resolveMember: failingMember }),
    ).resolves.toEqual({ ok: false, refusal: 'member-lookup-error' });
  });
});
