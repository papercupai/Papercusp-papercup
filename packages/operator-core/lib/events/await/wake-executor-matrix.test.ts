// @vitest-environment node
/**
 * wake-executor-matrix.test.ts — the C4 liveness/lifecycle matrix + the EI-152
 * REAL-SEAM regression (coordination-test-suite-2026-06-08 P-003, P-006).
 *
 * ## What was missing (D-001)
 * `wake-executor.test.ts` has 27 green tests, yet EI-152 shipped: a handle-less
 * always-armed wake PARKED even though a live psu control socket was available,
 * because those tests MOCK `findPsuHost`/`injectPsuHost` — the real socket-inject
 * seam was never exercised. This suite closes that:
 *
 *  - the SOCKET dimension is REAL: `executeWake`'s `psu-socket-inject` rung runs
 *    against a genuine unix socket stood up by the keystone testbed, through the
 *    operator's REAL `findLiveHost` + `injectIntoHost` (the default deps — NOT
 *    mocked). EI-152 is asserted on this real path: no-handle + live socket →
 *    `delivered:psu-socket-inject`, never `park`.
 *  - the LIVENESS dimension (alive / exited / stale-presence / pid-reuse /
 *    no-recorded-pid / ended-row) is driven through injected deterministic deps
 *    (`getSession`/`presence`/`alive`/`findPty`/`spawnDetached`) — spawning a real
 *    claude/codex needs credentials and is the live-smoke tier, not CI.
 *
 * Every cell of (liveness) × (handle? / live-socket?) → an asserted outcome, so a
 * future regression in ANY rung — not just the one EI-152 hit — goes red. The
 * adversarial pid-reuse cells assert "no misroute": a recorded pid that is alive
 * but is not OUR managed pty must PARK, never inject into the wrong process.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeWake, type ExecuteWakeDeps } from './wake-executor';
import {
  MultiSessionTestbed,
  makeDelivery,
  advSessionHandle,
  deadPid,
  type TestSession,
} from '../../../test/_multi-session-testbed';
import type { WakeOutcome } from './types';

/** A presence record shape getPresence returns (only the fields executeWake reads). */
function presenceRec(over: { stale?: boolean; revoked?: boolean } = {}) {
  return {
    ownerId: 'x',
    ownerLabel: '',
    workspaceId: 'default',
    source: '',
    intent: '',
    currentPlanSlug: null,
    currentFiles: [],
    host: '',
    pid: null,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    stale: over.stale ?? false,
    revoked: over.revoked ?? false,
    userId: null,
  } as unknown as Awaited<ReturnType<NonNullable<ExecuteWakeDeps['presence']>>>;
}

describe('wake-executor C4 liveness × handle/socket matrix (real socket seam)', () => {
  // turn-provenance P-002: this suite deliberately runs the REAL tagTurnForInjection
  // (no tagTurn stub) so the envelope+ledger leg is exercised end-to-end — isolate
  // its ledger dir so the suite never writes the real ~/.papercusp/turn-provenance.
  let prevProvDir: string | undefined;
  let provDir: string;
  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    prevProvDir = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    provDir = mkdtempSync(join(tmpdir(), 'wake-prov-'));
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provDir;
  });
  afterEach(async () => {
    if (prevProvDir === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = prevProvDir;
    const { rmSync } = await import('node:fs');
    try {
      rmSync(provDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  let tb: MultiSessionTestbed;

  beforeEach(() => {
    tb = MultiSessionTestbed.create();
  });
  afterEach(async () => {
    await tb.destroy();
  });

  /** Base deps: every rung that would touch the OS is injected deterministic;
   *  the psu-socket rung stays REAL (real findLiveHost against the isolated dir). */
  function baseDeps(over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
    const deps = baseDepsRaw(over);
    // Hermetic owner election (WI-10008189): stamp fixture rows with their id + owner and
    // model "no successor", so a not-alive handle never reaches the real PG election read.
    return { ...deps, ...tb.ownerElectionDeps(deps) };
  }

  function baseDepsRaw(over: Partial<ExecuteWakeDeps>): ExecuteWakeDeps {
    return {
      findPsuHost: tb.findPsuHostDep(), // REAL discovery, isolated dir
      // injectPsuHost left as default → the REAL injectIntoHost transport
      getSession: async () => null,
      findPty: () => null,
      write: () => true,
      presence: async () => null,
      alive: () => false,
      spawnDetached: () => 4242, // pretend a headless resume spawned
      // Hermetic by default (P-001): a dead-waiter degrade never reaches the
      // real sendMessage (which touches PG/coordLog) unless a test overrides it.
      sendCoordMessage: async () => ({}) as never,
      // Channel 2 claims the adv row atomically before spawning. Hermetic by
      // default for the same reason as sendCoordMessage above (the production
      // claim writes to PG); model a WINNING claim so these rows exercise the
      // outcome under test. The claim's own losing/faulting behaviour is
      // covered explicitly below.
      claimResume: async () => true,
      // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
      accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
      // EI-27228943258833551: the EI-203843 lifecycle gate is the FIRST delivery
      // decision, and its production default reads the session brief from PG with
      // failClosed:true. Left unstubbed, a slow or unreachable PG parks every row
      // as "lifecycle custody is unknown" before it reaches the rung under test,
      // so the killed-owner and retirement-race rows went red without exercising
      // their guards. Model "no lifecycle record" here; rows that test the gate
      // itself override it explicitly.
      getSessionLifecycle: async () => null,
      ...over,
    };
  }

  // ── handle-less (always-armed inbox-wake) row — the EI-152 territory ──────

  it('EI-152: no handle + LIVE psu socket → delivered via the socket, NOT park', async () => {
    const s = tb.session('A');
    const host = await tb.spawnSocketHost(s.ownerId);
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });

    const out = await executeWake(d, baseDeps());

    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'psu-socket-inject' });
    // The REAL socket actually received the REAL v1 turn envelope.
    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({ v: 1, mode: 'turn' });
    expect(host.received[0].data).toContain('[await-event]');
    // turn-provenance P-002 (real tagger, real socket): the injected turn opens
    // with the origin envelope, and the ledger row it references EXISTS and
    // classifies the delivered bytes as verified agent-origin.
    expect(host.received[0].data).toMatch(/^⟦turn-origin:wake-pump nonce:[a-f0-9]{16}⟧\n/);
    const { readLedgerRows, classify } = await import('../../turn-provenance/turn-provenance');
    const rows = readLedgerRows(s.ownerId, { includeExpired: true });
    expect(rows).toHaveLength(1);
    expect(classify(host.received[0].data, rows).verdict).toBe('verified-agent');
  });

  it('no handle + no socket + presence LIVE → park (inbox-only)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });
    const out = await executeWake(d, baseDeps({ presence: async () => presenceRec() }));
    expect(out.kind).toBe('park');
  });

  it('EI-25270078901082313: deliberate registered managed reattachment releases only a post-shutdown wake over the real socket', async () => {
    const s = tb.session('reattached');
    const shutdown = { at: '2026-10-06T22:07:55.842Z', by: s.ownerId };
    const wake = makeDelivery({
      id: 460480, subscriberId: s.ownerId, wakeHandle: null,
      createdAt: '2026-10-06T22:08:07.000Z',
    });
    let detachedResumes = 0;
    const d = baseDeps({
      getSessionLifecycle: async () => ({ shutdown }),
      resolveWakeModeFn: async () => 'auto',
      spawnDetached: () => { detachedResumes++; return 4242; },
    });
    expect(await executeWake(wake, d)).toMatchObject({ kind: 'park' });
    const host = await tb.spawnSocketHost(s.ownerId, { advSessionId: s.advSessionId });
    await expect(tb.findPsuHostDep()(s.ownerId)).resolves.toMatchObject({ ownerId: s.ownerId, sock: host.sock });
    expect(await executeWake(wake, d)).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(host.received).toHaveLength(1);
    expect(host.received[0]).toMatchObject({ v: 1, mode: 'turn', deliveryId: '460480', ownerId: s.ownerId });
    // A registered successor does not erase the durable old-delivery cutoff.
    expect(await executeWake({ ...wake, id: 460479, createdAt: '2026-10-06T22:07:15.733Z' }, d)).toMatchObject({ kind: 'drop' });
    expect(host.received).toHaveLength(1);
    expect(detachedResumes).toBe(0);
  });

  it('no handle + no socket + presence STALE → DEGRADES to a coord inbox notification (P-001), not a drop', async () => {
    const s = tb.session('A');
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });
    const sendCoordMessage = async () => ({}) as never;
    const out = await executeWake(d, baseDeps({ presence: async () => presenceRec({ stale: true }), sendCoordMessage }));
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'inbox' });
  });

  it('no handle + no socket + presence REVOKED → DEGRADES to a coord inbox notification (P-001), not a drop', async () => {
    const s = tb.session('A');
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });
    const sendCoordMessage = async () => ({}) as never;
    const out = await executeWake(d, baseDeps({ presence: async () => presenceRec({ revoked: true }), sendCoordMessage }));
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'inbox' });
  });

  it('no handle + no socket + presence gone AND the inbox send itself fails → still drops, visibly', async () => {
    const s = tb.session('A');
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });
    const out = await executeWake(
      d,
      baseDeps({
        presence: async () => presenceRec({ stale: true }),
        sendCoordMessage: async () => {
          throw new Error('log write failed');
        },
      }),
    );
    expect(out.kind).toBe('drop');
  });

  it('no handle + socket present but inject FAILS → falls through to park (presence live)', async () => {
    const s = tb.session('A');
    await tb.spawnSocketHost(s.ownerId);
    const d = makeDelivery({ subscriberId: s.ownerId, wakeHandle: null });
    // Override injectPsuHost to simulate a write failure on an otherwise-live host.
    const out = await executeWake(
      d,
      baseDeps({ injectPsuHost: async () => false, presence: async () => presenceRec() }),
    );
    expect(out.kind).toBe('park');
  });

  // ── adv-session row: the live-socket rung wins before the pid logic (1b) ───

  it('adv-session alive + pidKnown, but LIVE socket → psu-socket-inject (socket beats pty)', async () => {
    const s = tb.session('A');
    const host = await tb.spawnSocketHost(s.ownerId);
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { pid: process.pid }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: process.pid, endedAt: null }) as never,
        alive: () => true,
        // findPty would also hit, but the socket rung is checked first.
        findPty: () => ({ id: 'pty-1' }) as never,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'psu-socket-inject' });
    expect(host.received[0]).toMatchObject({ v: 1, mode: 'turn' });
  });

  it('adv-session alive + pidKnown + managed pty (no socket) → pty-inject', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { pid: process.pid }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: process.pid, endedAt: null }) as never,
        alive: () => true,
        findPty: () => ({ id: 'pty-1' }) as never,
        write: () => true,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'pty-inject' });
  });

  it('pid-reuse / no-misroute: pid ALIVE but not our managed pty (no socket) → park, never inject', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { pid: process.pid }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: process.pid, endedAt: null }) as never,
        alive: () => true, // pid is alive (reused by some other process)
        findPty: () => null, // …but it is NOT one of our managed ptys
      }),
    );
    expect(out.kind).toBe('park'); // must NOT have pty-injected into the wrong pid
  });

  it('EI-151 cross-owner pid-reuse: the live pty at this pid belongs to a PEER → executor scopes the lookup to the subscriber, gets null, parks (never injects A\'s wake into B)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { pid: process.pid }),
    });
    let askedOwner: string | null | undefined = undefined;
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: process.pid, endedAt: null }) as never,
        alive: () => true, // the recorded pid is alive — recycled to a peer's managed pty
        // Owner-aware finder (mirrors the real findPtyByPid): a pty IS live at
        // this pid, but it is tagged with a DIFFERENT owner, so the owner-scoped
        // lookup yields null for THIS subscriber.
        findPty: ((_pid: number, owner?: string | null) => {
          askedOwner = owner;
          return null;
        }) as never,
      }),
    );
    expect(out.kind).toBe('park'); // A's wake is never injected into the peer's session
    expect(askedOwner).toBe(s.ownerId); // the executor scoped the pid lookup to the subscriber
  });

  it('adv-session alive, NO recorded pid, no socket → park (avoid concurrent resume)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { pid: null }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: null }) as never,
        presence: async () => presenceRec(), // fresh → alive evidence, but no pid
      }),
    );
    expect(out.kind).toBe('park');
  });

  it('deliberately killed owner drops a later inbox wake without starting a process (WI-6554700010010429)', async () => {
    const s = tb.session('retired');
    let spawned = 0;
    let claimed = 0;
    const d = makeDelivery({ subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-retired', pid: null }),
    });
    const out = await executeWake(d, baseDeps({
      getSession: async () => ({ pid: null, endedAt: new Date().toISOString(),
        retiredAt: new Date().toISOString(), retiredBy: 'fleet:kill:operator',
        agent: 'claude', sessionId: 'native-retired', coordOwnerId: s.ownerId, cwd: s.cwd }) as never,
      claimResume: async () => { claimed++; return true; },
      spawnDetached: () => { spawned++; return 4242; },
    }));
    expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('retired') });
    expect(spawned).toBe(0);
    expect(claimed).toBe(0);
  });

  it('ENDED row even though the recorded pid was reused-alive → treated as exited (resume), not inject', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', pid: process.pid }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        // endedAt set → isAlive=false regardless of pid liveness
        getSession: async () => ({ pid: process.pid, endedAt: new Date().toISOString(), agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => true,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('adv-session EXITED (pid dead) + resumable claude → resume-headless (detached)', async () => {
    const s = tb.session('A');
    const dead = await deadPid();
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: dead }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: dead, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => false,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
  });

  // ── WI-10005134: a LIVE psu host means the session is running ─────────────
  // A psu host carry-respawns its CLI child under a new pid, so the adv row's
  // recorded pid can be dead while the session is alive. Measured 2026-10-01:
  // three wakes for one owner went resume-headless while its host was live and
  // deferring them, putting a second `claude --resume` on the live session.

  it('WI-10005134: recorded pid DEAD + LIVE psu host whose inject misses → park, NEVER resume-headless', async () => {
    const s = tb.session('A');
    await tb.spawnSocketHost(s.ownerId);
    const dead = await deadPid();
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: dead }),
    });
    let spawns = 0;
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: dead, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => false,
        injectPsuHost: async () => false,
        spawnDetached: () => {
          spawns += 1;
          return 4242;
        },
      }),
    );
    expect(out.kind).toBe('park');
    expect(out.kind === 'park' ? out.reason : '').toContain('WI-10005134');
    expect(spawns).toBe(0);
  });

  it('WI-10005134: host ACKS a deferred-carry-respawn-pending refusal → park with the host reason, no second attempt, no spawn', async () => {
    const s = tb.session('A');
    await tb.spawnSocketHost(s.ownerId);
    const dead = await deadPid();
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: dead }),
    });
    let injects = 0;
    let spawns = 0;
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: dead, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => false,
        injectPsuHostWithConfirmation: async () => {
          injects += 1;
          return { ok: false, confirmation: 'acked', reason: 'deferred-carry-respawn-pending' };
        },
        spawnDetached: () => {
          spawns += 1;
          return 4242;
        },
      }),
    );
    expect(out).toEqual<WakeOutcome>({
      kind: 'park',
      reason:
        'psu-host deferred-carry-respawn-pending: the live host deferred this wake; parked for a durable retry, never a second process',
      // parkOnHostDeferral marks a host-accepted deferral as host-owned so the
      // pump's attempt ceiling and inbox fallback do not race the host re-arm.
      hostCommitPending: true,
    });
    expect(injects).toBe(1);
    expect(spawns).toBe(0);
  });

  it('WI-10005134 calibration: same stale pid with NO psu host still resumes headless', async () => {
    // Without a live host the session really has exited; the guard must not
    // swallow the legitimate resume (the control for the two cases above).
    const s = tb.session('A');
    const dead = await deadPid();
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: dead }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: dead, endedAt: null, agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        alive: () => false,
        injectPsuHost: async () => false,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
  });

  it('adv-session exited + claude WITHOUT native session id + presence live → park (no --continue)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: null, pid: null }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: new Date().toISOString(), agent: 'claude', sessionId: null, coordOwnerId: null, cwd: s.cwd }) as never,
        presence: async () => presenceRec(),
      }),
    );
    expect(out.kind).toBe('park');
  });

  it('adv-session exited + not resumable + presence GONE → DEGRADES to a coord inbox notification (P-001), not a drop', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: null, pid: null }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: new Date().toISOString(), agent: 'claude', sessionId: null, coordOwnerId: null, cwd: s.cwd }) as never,
        presence: async () => null,
      }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'inbox' });
  });

  it('resume spawn FAILS → error outcome (the pump retries with backoff)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: null }),
    });
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: new Date().toISOString(), agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        spawnDetached: () => null, // spawn failure
      }),
    );
    expect(out.kind).toBe('error');
  });

  // ── Channel 2 single-winner resume claim (EI-21247460909447431) ───────────
  it('retirement racing the pre-spawn check drops at the resume claim', async () => {
    const s = tb.session('retired-during-preparation');
    let spawned = 0;
    const out = await executeWake(makeDelivery({ subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-race', pid: null }),
    }), baseDeps({
      getSession: async () => ({ pid: null, endedAt: new Date().toISOString(),
        agent: 'claude', sessionId: 'native-race', coordOwnerId: s.ownerId, cwd: s.cwd }) as never,
      claimResume: async () => 'retired',
      spawnDetached: () => { spawned++; return 4242; },
    }));
    expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('retired') });
    expect(spawned).toBe(0);
  });

  //
  // The claim exists so a queued loop wake and a manual `psu --resume` cannot
  // both spawn a writer for the same session. Both rows below must PARK without
  // spawning — but they must not be conflated: one lost a real race, the other
  // never got an answer. Reporting a datastore fault as a lost race sends an
  // operator hunting a competing resumer that never existed.

  it('resume claim LOST to a competing resumer → parks without spawning a second writer', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: null }),
    });
    let spawned = 0;
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: new Date().toISOString(), agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        claimResume: async () => false,
        spawnDetached: () => {
          spawned += 1;
          return 4242;
        },
      }),
    );
    expect(out.kind).toBe('park');
    // 64f9133915 reworded the lost-claim reason when it added the owner election: a claim
    // can now be lost to a competing resumer OR superseded by a newer owner session.
    expect(out.kind === 'park' && out.reason).toMatch(/was lost or superseded/);
    expect(spawned).toBe(0); // the entire point of the claim
  });

  it('resume claim that cannot be EVALUATED parks as unavailable, not as a lost race', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'claude', sessionId: 'native-A', pid: null }),
    });
    let spawned = 0;
    const out = await executeWake(
      d,
      baseDeps({
        getSession: async () => ({ pid: null, endedAt: new Date().toISOString(), agent: 'claude', sessionId: 'native-A', coordOwnerId: null, cwd: s.cwd }) as never,
        claimResume: async () => {
          throw new Error('ECONNREFUSED writing the claim');
        },
        spawnDetached: () => {
          spawned += 1;
          return 4242;
        },
      }),
    );
    expect(out.kind).toBe('park');
    const reason = out.kind === 'park' ? out.reason : '';
    expect(reason).toMatch(/could not be evaluated/);
    expect(reason).toContain('ECONNREFUSED writing the claim');
    expect(reason).not.toMatch(/was lost or superseded/);
    expect(spawned).toBe(0); // an unevaluable claim is still never a second writer
  });

  // ── plan-run handle row ───────────────────────────────────────────────────

  it('plan-run handle → plan-run-resume (delivered)', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: { kind: 'plan-run', runId: 77 },
    });
    const out = await executeWake(
      d,
      baseDeps({ resumePlanRun: async () => ({ ok: true }) }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'plan-run-resume' });
  });

  it('plan-run handle resume fails → error', async () => {
    const s = tb.session('A');
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: { kind: 'plan-run', runId: 77 },
    });
    const out = await executeWake(
      d,
      baseDeps({ resumePlanRun: async () => ({ ok: false, error: 'run gone' }) }),
    );
    expect(out.kind).toBe('error');
  });
});
