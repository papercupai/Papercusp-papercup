/**
 * report-session-end-release.test.ts — activity:report's SessionEnd/Stop
 * lease-release cascade (session-death-claim-release-2026-07-11 P-002, the
 * FAST PATH). The SAME lifecycle event that already (un)arms the inbox-wake
 * watch must ALSO force-release every work-item lease + coordination claim
 * the ending owner holds — via the shared `releaseAllWorkItemLeasesForOwner`
 * core (work-item-lease-release.ts), the exact function P-001's scheduled
 * backstop sweep also calls. Mocks the PG sink + every side-effect primitive
 * so this stays a pure handler unit test (the release core itself is proven
 * against real PG in work-item-lease-reaper.integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetRespawnExpectedMarkers, markRespawnExpected } from '../../carry-respawn-marker';

const h = vi.hoisted(() => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  heal: vi.fn(),
  release: vi.fn(),
  releaseLocks: vi.fn(),
  resetWake: vi.fn(),
  wakeResumeTurn: vi.fn(),
  loopOwners: vi.fn(),
  /** In-memory stand-in for the marker's PG table (see the mock below). */
  marks: new Map<string, number>(),
}));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));
vi.mock('../../work-item-lease-release', () => ({ releaseAllWorkItemLeasesForOwner: h.release }));
vi.mock('../locks/release-all-owned', () => ({ releaseAllOwnedLocks: h.releaseLocks }));
// WI-6756: this seam READS PG. Leaving it un-stubbed would not merely touch the DB —
// the read never settles, so it hangs PAST the handler's try/catch (which only catches
// throws) until the suite timeout. Stub it in every test in this file.
vi.mock('../../session-reset-continuation', () => ({
  recentContextResetWake: h.resetWake,
  isWakeResumeTurn: h.wakeResumeTurn,
}));
vi.mock('../../adv-roster', () => ({ activeLoopOwners: h.loopOwners }));
// The carry-respawn marker is PG-backed too (migration 716 — the operator is clustered,
// so an in-memory Map was invisible to the sibling worker that handles the SessionEnd).
// Same reasoning as the stub above: keep this file a pure handler unit test by standing
// the table up in memory, preserving the real single-use + TTL + per-owner semantics.
// The SQL itself is proven in carry-respawn-marker.integration.test.ts.
vi.mock('../../carry-respawn-marker', () => ({
  RESPAWN_EXPECTED_TTL_MS: 60_000,
  markRespawnExpected: async (ownerId: string, ttlMs = 60_000) => {
    if (ownerId?.trim()) h.marks.set(ownerId, Date.now() + ttlMs);
  },
  consumeRespawnExpected: async (ownerId: string) => {
    if (!ownerId?.trim()) return false;
    const expiresAt = h.marks.get(ownerId);
    if (expiresAt === undefined) return false;
    h.marks.delete(ownerId);
    return expiresAt >= Date.now();
  },
  __resetRespawnExpectedMarkers: async () => {
    h.marks.clear();
  },
}));

const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);
const responseBody = (res: Awaited<ReturnType<typeof run>>) =>
  JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;

beforeEach(() => {
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
  h.release.mockReset().mockResolvedValue({ releasedIds: [], claimsCleared: 0 });
  h.releaseLocks.mockReset().mockResolvedValue({
    released: [],
    heldBefore: 0,
    crossDomainReleased: [],
    resourcesReleased: 0,
  });
  // Default: no context-reset wake in the window ⇒ an ordinary death, release runs.
  h.resetWake.mockReset().mockResolvedValue(null);
  // Default: not the end of a one-turn wake resume ⇒ the standing watch is retired.
  h.wakeResumeTurn.mockReset().mockResolvedValue(false);
  // Default: the owner has no armed loop ⇒ an ordinary terminal SessionEnd.
  h.loopOwners.mockReset().mockResolvedValue(new Set<string>());
  void __resetRespawnExpectedMarkers();
});

describe('activity:report SessionEnd → work-item lease release (P-002 fast path)', () => {
  it('SessionEnd (■ session ended) triggers releaseAllWorkItemLeasesForOwner for the ending owner', async () => {
    h.release.mockResolvedValueOnce({ releasedIds: ['WI-1', 'WI-2'], claimsCleared: 1 });
    const res = await run({ owner: 'su-dead', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-dead');
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(h.releaseLocks).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'su-dead' }));
    // The existing inbox-wake cancel still fires too — this is additive, not a replacement.
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(responseBody(res).session_end_disposition).toBe('terminal');
  });

  // WI-10005679: the wake executor resumes an exited session as a one-turn
  // `--resume <id> -p` child. Its SessionEnd is how `-p` ends, so retiring the
  // standing watch there made a recruited judge unwakeable after one follow-up.
  it('a terminal SessionEnd that closes a verified wake-resume turn KEEPS the inbox-wake, still releases', async () => {
    h.wakeResumeTurn.mockResolvedValueOnce(true);
    const res = await run({
      owner: 'su-judge',
      kind: 'lifecycle',
      summary: '■ session ended',
      wake_delivery_id: 413379,
    });
    expect(h.wakeResumeTurn).toHaveBeenCalledWith('su-judge', 413379);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledWith('su-judge');
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    const body = responseBody(res);
    expect(body.session_end_disposition).toBe('terminal');
    expect(body.inbox_wake_retained).toBe('wake-resume-turn');
  });

  it('a delivery id the ledger does not confirm still retires the inbox-wake', async () => {
    const res = await run({
      owner: 'su-judge',
      kind: 'lifecycle',
      summary: '■ session ended',
      wake_delivery_id: 999,
    });
    expect(h.wakeResumeTurn).toHaveBeenCalledWith('su-judge', 999);
    expect(h.cancel).toHaveBeenCalledWith('su-judge', '*');
    expect(responseBody(res)).not.toHaveProperty('inbox_wake_retained');
  });

  it('a failed wake-resume ledger read keeps today\'s cancel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.wakeResumeTurn.mockRejectedValueOnce(new Error('pg down'));
    await run({ owner: 'su-judge', kind: 'lifecycle', summary: '■ session ended', wake_delivery_id: 7 });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('wake-resume check'))).toBe(true);
    warn.mockRestore();
  });

  it('a continuation SessionEnd never consults the wake-resume ledger', async () => {
    h.resetWake.mockResolvedValueOnce({ channel: 'psu-socket-reset', at: new Date(), ageMs: 10 });
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended', wake_delivery_id: 5 });
    expect(h.wakeResumeTurn).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('SessionStart (▶ session started) does NOT trigger a release — only the end transition', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.arm).toHaveBeenCalledTimes(1);
  });

  it('a non-lifecycle (tool) report never triggers a release', async () => {
    await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('an unrecognized lifecycle summary never triggers a release', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'todos updated' });
    expect(h.release).not.toHaveBeenCalled();
  });

  it('a release failure never breaks the activity report or skips the inbox-wake cancel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.release.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-dead', kind: 'lifecycle', summary: '■ session ended' });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(h.cancel).toHaveBeenCalledTimes(1); // unaffected by the release failure
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a lock-release failure is fail-open and does not skip the work-item release', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.releaseLocks.mockRejectedValueOnce(new Error('locks db down'));
    await run({ owner: 'su-dead', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledWith('su-dead');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * EI-18676518990229124: a carry-respawn (session:request-compaction) ends this
 * process under the SAME ownerId and relaunches it seconds later. That
 * SessionEnd must NOT force-release the owner's claims or cancel its standing
 * inbox-wake watch — the successor is the same logical agent and would resume
 * holding claims that had just silently
 * evaporated (the exact 4x-in-45-minutes symptom reported live). The marker
 * `session:request-compaction` sets right after a successful `injectIntoHost`
 * is what tells this branch to skip the release for that one transition.
 */
describe('activity:report SessionEnd → carry-respawn marker suppresses the P-002 release', () => {
  it('a marked owner (carry-respawn expected) → claims and the inbox-wake watch are preserved', async () => {
    await markRespawnExpected('su-resuming');
    const res = await run({ owner: 'su-resuming', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    // The marker short-circuits: no wake-ledger round-trip is spent when it already answers.
    expect(h.resetWake).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(responseBody(res)).toMatchObject({ ok: true, session_end_disposition: 'continuation' });
  });

  it('an UNMARKED owner still gets the normal force-release (no regression to the P-002 fast path)', async () => {
    h.release.mockResolvedValueOnce({ releasedIds: ['WI-9'], claimsCleared: 1 });
    await run({ owner: 'su-genuinely-dead', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-genuinely-dead');
  });

  it('the mark is SINGLE-USE: a second SessionEnd for the same owner (e.g. a real death shortly after) is NOT suppressed', async () => {
    await markRespawnExpected('su-flappy');
    await run({ owner: 'su-flappy', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).not.toHaveBeenCalled();
    await run({ owner: 'su-flappy', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-flappy');
  });

  it('the mark is scoped per-owner: marking su-x never suppresses su-y\'s release', async () => {
    await markRespawnExpected('su-x');
    await run({ owner: 'su-y', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-y');
  });
});

/**
 * WI-6756: the SAME exemption for the OTHER trigger that ends a session under
 * the same ownerId — a COLD loop wake delivered over psu-socket-reset/recycle,
 * which re-execs the CLI child. The carry-respawn marker structurally cannot
 * cover this one: papercup-bg-host injects that wake and never marks anything,
 * so there is no mark to find. The guard reads the durable wake ledger instead. Measured before the fix: 5 consecutive wakes each
 * force-released the leader's claims ~412ms after the wake landed.
 */
describe('activity:report SessionEnd → a recent context-reset wake suppresses the P-002 release (WI-6756)', () => {
  it('a psu-socket-reset wake in the window → claims and the inbox-wake watch are preserved', async () => {
    h.resetWake.mockResolvedValueOnce({ channel: 'psu-socket-reset', at: new Date(), ageMs: 412 });
    const res = await run({ owner: 'su-cold-loop', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(responseBody(res)).toMatchObject({ ok: true, session_end_disposition: 'continuation' });
  });

  it('a psu-socket-recycle wake is treated the same (it also re-execs the child)', async () => {
    h.resetWake.mockResolvedValueOnce({ channel: 'psu-socket-recycle', at: new Date(), ageMs: 900 });
    await run({ owner: 'su-cold-loop', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('NO reset wake in the window → the normal force-release still runs (a real death is unaffected)', async () => {
    h.resetWake.mockResolvedValueOnce(null);
    h.release.mockResolvedValueOnce({ releasedIds: ['WI-7'], claimsCleared: 1 });
    await run({ owner: 'su-really-dead', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-really-dead');
  });

  it('FAILS OPEN: a ledger read error must not strand claims — it falls through to the release', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.resetWake.mockRejectedValueOnce(new Error('pg down'));
    await run({ owner: 'su-unknown', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledWith('su-unknown');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('the ledger is only consulted on the END transition, never on SessionStart', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.resetWake).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
  });
});

/**
 * EI-21431501901242395: a warm engine loop is durable continuation authority
 * for the coordination owner even when the current native CLI incarnation
 * emits SessionEnd between wakes. Releasing here strips the loop's driving
 * work-item claim before its already-armed successor turn arrives.
 */
describe('activity:report SessionEnd → an armed engine loop preserves the same-owner claim', () => {
  it('an armed warm-loop owner is a continuation: work-item and lock releases are SKIPPED', async () => {
    h.loopOwners.mockResolvedValueOnce(new Set(['su-warm-loop']));

    const res = await run({ owner: 'su-warm-loop', kind: 'lifecycle', summary: '■ session ended' });

    expect(h.resetWake).toHaveBeenCalledWith('su-warm-loop');
    expect(h.loopOwners).toHaveBeenCalledTimes(1);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(responseBody(res)).toMatchObject({ ok: true, session_end_disposition: 'continuation' });
  });

  it('CONTROL: an inactive/missing loop does not weaken genuine SessionEnd cleanup', async () => {
    h.loopOwners.mockResolvedValueOnce(new Set());

    const res = await run({ owner: 'su-terminal', kind: 'lifecycle', summary: '■ session ended' });

    expect(h.release).toHaveBeenCalledWith('su-terminal');
    expect(h.releaseLocks).toHaveBeenCalledTimes(1);
    expect(responseBody(res)).toMatchObject({ ok: true, session_end_disposition: 'terminal' });
  });
});
