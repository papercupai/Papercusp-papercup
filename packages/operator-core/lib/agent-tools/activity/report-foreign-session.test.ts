/**
 * report-foreign-session.test.ts — WI-10003957. A nested CLI inherits its su's
 * PAPERCUSP_SID, so its SessionStart/SessionEnd hooks report AS that su. On
 * 2026-09-29 a test's `claude -p 'say ok'` probe (run from su-075445e6's
 * capability:bash integration suite) re-anchored the su's adv row to itself on
 * start, and on end read as the owner's terminal death: leases + locks released,
 * inbox-wake cancelled, and lifecycle-report.sh fleet:kill'ed the LIVE host.
 *
 * activity:report now classifies the reporting native session against the
 * owner's bound incarnation (classifyOwnerNativeSession) and treats a `foreign`
 * one as inert. The row classifier itself is pinned purely below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  arm: vi.fn(),
  cancel: vi.fn(),
  heal: vi.fn(),
  release: vi.fn(),
  releaseLocks: vi.fn(),
  resetWake: vi.fn(),
  wakeResumeTurn: vi.fn(),
  loopOwners: vi.fn(),
  consume: vi.fn(),
  classify: vi.fn(),
  reanchorById: vi.fn(),
  reanchorByOwner: vi.fn(),
}));

vi.mock('@papercusp/activity-bridge', () => ({ recordActivity: vi.fn(async () => ({ id: 42 })) }));
vi.mock('../../activity-pg-store', () => ({ createPgTelemetryStore: () => ({}) }));
vi.mock('../coordination/watermarks', () => ({ writeWatermark: vi.fn(async () => undefined) }));
vi.mock('../../events/await/inbox-wake-arm', () => ({
  armInboxWake: h.arm,
  cancelInboxWake: h.cancel,
  ensureInboxWakeArmedForActiveSession: h.heal,
}));
vi.mock('../../work-item-lease-release', () => ({ releaseAllWorkItemLeasesForOwner: h.release }));
vi.mock('../locks/release-all-owned', () => ({ releaseAllOwnedLocks: h.releaseLocks }));
vi.mock('../../session-reset-continuation', () => ({
  recentContextResetWake: h.resetWake,
  isWakeResumeTurn: h.wakeResumeTurn,
}));
vi.mock('../../adv-roster', () => ({ activeLoopOwners: h.loopOwners }));
vi.mock('../../carry-respawn-marker', () => ({ consumeRespawnExpected: h.consume }));
vi.mock('../../adv-sessions', async (importActual) => ({
  ...(await importActual<typeof import('../../adv-sessions')>()),
  classifyOwnerNativeSession: h.classify,
  reanchorAdvSessionNativeId: h.reanchorById,
  reanchorAdvSessionNativeIdByOwner: h.reanchorByOwner,
}));

const { classifyOwnerNativeSessionRows } = await vi.importActual<typeof import('../../adv-sessions')>(
  '../../adv-sessions',
);
const tool = (await import('./report')).default;
const ctx = { principal: { workspaceId: '*' } } as unknown as Parameters<typeof tool.handler>[1];
const run = (args: Record<string, unknown>, context = ctx) =>
  tool.handler(args as Parameters<typeof tool.handler>[0], context);
const body = (res: Awaited<ReturnType<typeof run>>) =>
  JSON.parse((res as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;

const OWNER = 'su-075445e6-540e-4f8d-b350-608f9cae12a9';
const LIVE = 'e9c13e34-e9e6-4cd2-ada8-5910804a90bd';
const PROBE = '6f323e34-40e5-4c30-a3cf-ece385f8ce0b';
const START = { owner: OWNER, kind: 'lifecycle', summary: '▶ session started', agent: 'claude' };
const END = { owner: OWNER, kind: 'lifecycle', summary: '■ session ended', agent: 'claude' };

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.arm.mockResolvedValue({ awaitId: 1, eventKey: 'coord:inbox-wake:x', handleNote: 'ok' });
  h.cancel.mockResolvedValue(1);
  h.heal.mockResolvedValue(false);
  h.release.mockResolvedValue({ releasedIds: ['WI-1'], claimsCleared: 1 });
  h.releaseLocks.mockResolvedValue({ released: [], heldBefore: 0, crossDomainReleased: [], resourcesReleased: 0 });
  h.resetWake.mockResolvedValue(null);
  h.wakeResumeTurn.mockResolvedValue(false);
  h.loopOwners.mockResolvedValue(new Set());
  h.consume.mockResolvedValue(false);
  h.reanchorById.mockResolvedValue({ reanchored: true, owner: OWNER });
  h.reanchorByOwner.mockResolvedValue({ reanchored: true, owner: OWNER });
  h.classify.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
    sessionId === LIVE
      ? { binding: 'bound', boundSessionId: LIVE, advSessionId: 31412 }
      : { binding: 'foreign', boundSessionId: LIVE, advSessionId: 31412 },
  );
});

describe('activity:report — a FOREIGN native session never acts as the owner (WI-10003957)', () => {
  it('passes the concrete request workspace into native-session classification', async () => {
    const scopedCtx = {
      workspaceId: 'ws-activity-report',
      principal: { workspaceId: 'ws-activity-report' },
    } as unknown as Parameters<typeof tool.handler>[1];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await run({ ...END, session_id: PROBE }, scopedCtx);

      expect(h.classify).toHaveBeenCalledWith(expect.objectContaining({
        ownerId: OWNER,
        sessionId: PROBE,
        workspaceId: 'ws-activity-report',
      }));
    } finally {
      warn.mockRestore();
    }
  });

  it('foreign SessionEnd: no lease/lock release, no inbox-wake cancel, no carry-marker consume, disposition=foreign', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await run({ ...END, session_id: PROBE, cwd: '/tmp' });
    expect(body(res).session_end_disposition).toBe('foreign');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('session-end IGNORED'));
    warn.mockRestore();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.releaseLocks).not.toHaveBeenCalled();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
  });

  it('the bound incarnation ending is still a genuine terminal end (the real-death path is unchanged)', async () => {
    const res = await run({ ...END, session_id: LIVE });
    expect(body(res).session_end_disposition).toBe('terminal');
    expect(h.release).toHaveBeenCalledWith(OWNER);
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('foreign SessionStart does NOT re-anchor the owner row to the nested CLI', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await run({ ...START, session_id: PROBE, cwd: '/tmp' });
    expect(h.reanchorByOwner).not.toHaveBeenCalled();
    expect(h.reanchorById).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('re-anchor REFUSED'));
    warn.mockRestore();
  });

  it('foreign SessionStart right after a context-reset wake IS the in-place /clear reset — re-anchor proceeds (WI-37420)', async () => {
    h.resetWake.mockResolvedValue({ channel: 'psu-socket-reset', ageMs: 900 });
    await run({ ...START, session_id: PROBE });
    expect(h.reanchorByOwner).toHaveBeenCalledWith(OWNER, PROBE);
  });

  it('an unbound owner row still gets its first binding from SessionStart', async () => {
    h.classify.mockResolvedValue({ binding: 'unbound', boundSessionId: null, advSessionId: 31412 });
    await run({ ...START, session_id: LIVE, adv_session_id: 31412 });
    expect(h.reanchorById).toHaveBeenCalledWith(31412, LIVE);
  });

  it('FAILS OPEN on a binding read error: behaves exactly as before (terminal end releases)', async () => {
    h.classify.mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await run({ ...END, session_id: PROBE });
    expect(body(res).session_end_disposition).toBe('terminal');
    expect(h.release).toHaveBeenCalledWith(OWNER);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('binding check'));
    warn.mockRestore();
  });

  it('a report without a native session id is never classified', async () => {
    await run({ ...END });
    expect(h.classify).not.toHaveBeenCalled();
  });
});

describe('classifyOwnerNativeSessionRows', () => {
  const row = (id: number, session_id: string | null, active: boolean) => ({ id, session_id, active });

  it('bound when an active row carries the reported id', () => {
    expect(classifyOwnerNativeSessionRows([row(2, LIVE, true)], LIVE).binding).toBe('bound');
  });

  it('foreign when the active row is bound to a different native session (the incident)', () => {
    expect(classifyOwnerNativeSessionRows([row(31412, LIVE, true)], PROBE)).toEqual({
      binding: 'foreign',
      boundSessionId: LIVE,
      advSessionId: 31412,
    });
  });

  it('unbound when no candidate carries a native id', () => {
    expect(classifyOwnerNativeSessionRows([row(7, null, true)], LIVE).binding).toBe('unbound');
    expect(classifyOwnerNativeSessionRows([], LIVE).binding).toBe('unbound');
  });

  it('ended rows are ignored while any active row exists; otherwise the newest row decides', () => {
    expect(classifyOwnerNativeSessionRows([row(9, LIVE, true), row(8, PROBE, false)], PROBE).binding).toBe('foreign');
    expect(classifyOwnerNativeSessionRows([row(8, LIVE, false), row(3, PROBE, false)], LIVE).binding).toBe('bound');
  });
});
