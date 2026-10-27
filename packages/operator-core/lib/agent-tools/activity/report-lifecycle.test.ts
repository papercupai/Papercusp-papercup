/**
 * report-lifecycle.test.ts — activity:report's always-arm side effect
 * (turn-lifecycle-control-2026-06-08 P-003/P-004/P-008).
 *
 * A lifecycle report (SessionStart / SessionEnd) must (un)arm the worker's
 * inbox-wake watch — the universal, client-agnostic arm point (D-001). A tool
 * report, or an unrecognized lifecycle summary, must not. Mocks the PG sink +
 * the arm primitive so this stays a pure handler unit test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  heal: vi.fn(),
  reanchor: vi.fn(),
  reanchorById: vi.fn(),
  classify: vi.fn(),
  bindTasks: vi.fn(),
}));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
// The SessionEnd path force-releases this owner's locks and work-item leases, and
// both seams talk to REAL Postgres. Unmocked, they made this UNIT test a
// load-dependent flake: under fleet contention the release lost a lock/statement
// race (pg 57014), report.ts console.warn'd the degradation — correctly, it is
// fire-and-forget and must not fail the request — and vitest-fail-on-console turned
// that into a red. It passed at 08:35Z and failed at 08:41Z on the same commit with
// no code change between, which is the signature of an environment-dependent test,
// not a defect (EI-21876713250361239, the missing PG isolation boundary).
// Stub both: this file is about the inbox-wake lifecycle, and each release path has
// its own coverage. The mocks keep the import-actual spread that
// `lint:full-replacement-mocks` requires, so a newly added export cannot strand.
vi.mock('../locks/release-all-owned', async (orig) => ({
  ...(await orig<typeof import('../locks/release-all-owned')>()),
  releaseAllOwnedLocks: vi.fn(async () => ({
    released: [],
    heldBefore: 0,
    crossDomainReleased: [],
    granularReleased: 0,
    resourcesReleased: 0,
  })),
}));
vi.mock('../../work-item-lease-release', async (orig) => ({
  ...(await orig<typeof import('../../work-item-lease-release')>()),
  releaseAllWorkItemLeasesForOwner: vi.fn(async () => ({ releasedIds: [], claimsCleared: 0 })),
}));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));
// WI-37420 / WI-37445: adv-sessions is a PROTECTED module — a bare factory that
// enumerates its exports strands the moment one is added (WI-7185 red-pinned the
// fleet gate exactly that way), so `lint:full-replacement-mocks` and
// full-replacement-mock-guard.test.ts require the import-actual spread here.
// The spread is also strictly more faithful than the enumeration it replaces:
// NATIVE_SESSION_ID_RE now IS the real regex rather than a hand-copied duplicate
// that could silently drift from production's, which is what the original
// comment was reaching for — a UUID-shaped session_id routes through the same
// validation production applies.
vi.mock('../../adv-sessions', async (orig) => ({
  ...(await orig<typeof import('../../adv-sessions')>()),
  classifyOwnerNativeSession: h.classify,
  reanchorAdvSessionNativeId: h.reanchorById,
  reanchorAdvSessionNativeIdByOwner: h.reanchor,
}));
vi.mock('../../task-manager/store', async (orig) => ({
  ...(await orig<typeof import('../../task-manager/store')>()),
  bindLiveAgentSessionTasksToNativeSession: h.bindTasks,
}));

const tool = (await import('./report')).default;
const ctx = { workspaceId: 'ws-report', principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], ctx);

beforeEach(() => {
  h.arm.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockReset().mockResolvedValue(1);
  h.heal.mockReset().mockResolvedValue(false);
  h.reanchor.mockReset().mockResolvedValue({ reanchored: true, owner: 'su-abc' });
  h.reanchorById.mockReset().mockResolvedValue({ reanchored: true, owner: 'su-abc' });
  h.classify.mockReset().mockResolvedValue({ binding: 'unbound', boundSessionId: null, advSessionId: 42 });
  h.bindTasks.mockReset().mockResolvedValue([]);
});

describe('activity:report lifecycle → inbox-wake (always-arm)', () => {
  it('SessionStart (▶ session started) ARMS the worker inbox-wake watch', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: 'sid', agent: 'claude' });
    expect(h.arm).toHaveBeenCalledTimes(1);
    expect(h.arm.mock.calls[0][0]).toMatchObject({ ownerId: 'su-abc' });
    expect(h.cancel).not.toHaveBeenCalled();
  });

  // WI-10005679: a judge reads its directed inbox (WI-10005678), so it is armed like
  // any other tracked session. The former exclusion left a judge whose launch-time
  // arm was retired with no SessionStart re-arm and no self-heal.
  it('judge SessionStart ARMS the inbox-wake watch like any tracked session', async () => {
    await run({ owner: 'judge-abc', role: 'judge', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.arm).toHaveBeenCalledTimes(1);
    expect(h.arm.mock.calls[0][0]).toMatchObject({ ownerId: 'judge-abc' });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.heal).not.toHaveBeenCalled();
  });

  it('SessionEnd (■ session ended) CANCELS the worker inbox-wake watch (D-003)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended' });
    expect(h.cancel).toHaveBeenCalledTimes(1);
    expect(h.cancel.mock.calls[0][0]).toBe('su-abc');
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('a non-lifecycle (tool) report self-heals (arms-if-missing), never arms/cancels directly', async () => {
    await run({ owner: 'su-abc', kind: 'tool', tool_name: 'Edit', summary: 'edited a file' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    // launch-wakeability: a tool call drives the self-heal so a session whose
    // SessionStart arm was lost becomes wakeable from its first tool call.
    expect(h.heal).toHaveBeenCalledTimes(1);
    expect(h.heal.mock.calls[0][0]).toMatchObject({ ownerId: 'su-abc' });
  });

  it('judge tool reports drive the inbox-wake self-heal (WI-10005679)', async () => {
    await run({ owner: 'judge-abc', role: 'judge', kind: 'tool', tool_name: 'scorecards:evaluate' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.heal).toHaveBeenCalledTimes(1);
    expect(h.heal.mock.calls[0][0]).toMatchObject({ ownerId: 'judge-abc' });
  });

  it('an unrecognized lifecycle summary is a defensive no-op (no arm/cancel, no self-heal)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'todos updated' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    // kind==='lifecycle' (just an unknown summary) must NOT self-heal — only genuine
    // non-lifecycle reports do.
    expect(h.heal).not.toHaveBeenCalled();
  });

  // EI-12979: lifecyclePhase used to be an unanchored `/end/i` / `/start/i` regex,
  // so ANY lifecycle summary merely CONTAINING those words would misfire — e.g.
  // "recommend a fix" contains "end" and would have wrongly CANCELLED the
  // worker's inbox-wake watch AND force-released every lease/claim it holds
  // (the phase==='end' branch above), and "restarted the watcher" contains
  // "start" and would have wrongly re-ARMED. Only the EXACT marker literal may
  // trigger either side effect.
  it('EI-12979: a lifecycle summary merely containing "end" as a substring does NOT cancel (no false session-end)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'recommend a fix' });
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
  });

  it('EI-12979: a lifecycle summary merely containing "start" as a substring does NOT arm (no false session-start)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: 'restarted the watcher' });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('an arm failure never breaks the activity report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.arm.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    // The report still returns ok despite the arm hiccup (the warn is best-effort).
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// WI-37420 recurrence guard: a COLD loop wake delivered over psu-socket-reset types
// `/clear` into the LIVE pty (session-reset-continuation.ts) — the CLI child mints a
// fresh native session id for that in-place reset WITHOUT the host ever
// kill+respawning the process, so the WI-5075 respawn report (which only fires from
// psu-pty-host's recycleChild) never covers this leg. This SessionStart lifecycle
// hook fire is the only signal that crosses the process boundary carrying the fresh
// id, so it must re-anchor `adv_sessions.session_id` itself — otherwise the owner's
// row is stuck on its FIRST launch's transcript forever across every subsequent
// reset (every owner→native-session consumer then tracks a dead transcript).
describe('activity:report SessionStart → adv_sessions reanchor (WI-37420)', () => {
  const validId = '8409515c-dc91-45bc-b9ef-409dcd3aa7a2';

  it('SessionStart with a valid native session UUID reanchors adv_sessions for the owner', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: validId });
    expect(h.reanchor).toHaveBeenCalledTimes(1);
    expect(h.reanchor).toHaveBeenCalledWith('su-abc', validId);
  });

  it('SessionStart with the stable adv row id reanchors by id, never by mutable owner ordering', async () => {
    await run({
      owner: 'su-abc',
      kind: 'lifecycle',
      summary: '▶ session started',
      session_id: validId,
      adv_session_id: 42,
    });
    expect(h.reanchorById).toHaveBeenCalledWith(42, validId);
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('late native SessionStart binds live tasks only after the exact adv row confirms the owner', async () => {
    await run({
      owner: 'su-abc',
      kind: 'lifecycle',
      summary: '▶ session started',
      session_id: validId,
      adv_session_id: 42,
    });
    expect(h.bindTasks).toHaveBeenCalledTimes(1);
    expect(h.bindTasks).toHaveBeenCalledWith({
      workspaceId: 'ws-report',
      coordOwnerId: 'su-abc',
      sessionId: validId,
    });
  });

  it('does not bind tasks when the exact adv row cannot confirm the reporting owner', async () => {
    h.reanchorById.mockResolvedValueOnce({ reanchored: false, owner: null });
    await run({
      owner: 'su-abc',
      kind: 'lifecycle',
      summary: '▶ session started',
      session_id: validId,
      adv_session_id: 42,
    });
    expect(h.bindTasks).not.toHaveBeenCalled();
  });

  it('binds the exact enrolled task row and still reconciles other live rows', async () => {
    const taskId = '0123456789abcdefghj';
    await run({
      owner: 'su-abc',
      kind: 'lifecycle',
      summary: '▶ session started',
      session_id: validId,
      adv_session_id: 42,
      agent_task_id: taskId,
    });
    expect(h.bindTasks).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws-report',
      coordOwnerId: 'su-abc',
      sessionId: validId,
      initialTaskId: taskId,
    });
    expect(h.bindTasks).toHaveBeenNthCalledWith(2, {
      workspaceId: 'ws-report',
      coordOwnerId: 'su-abc',
      sessionId: validId,
    });
  });

  it('SessionStart with a non-UUID session_id does NOT call the reanchor (no malformed write)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: 'sid' });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('SessionStart with no session_id at all does NOT call the reanchor', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started' });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('SessionEnd never calls the reanchor (start-only)', async () => {
    await run({ owner: 'su-abc', kind: 'lifecycle', summary: '■ session ended', session_id: validId });
    expect(h.reanchor).not.toHaveBeenCalled();
  });

  it('a reanchor failure never breaks the activity report', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.reanchor.mockRejectedValueOnce(new Error('pg down'));
    const res = await run({ owner: 'su-abc', kind: 'lifecycle', summary: '▶ session started', session_id: validId });
    const content = (res as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0].text)).toMatchObject({ ok: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
