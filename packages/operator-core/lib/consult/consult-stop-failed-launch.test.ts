/**
 * WI-10006690 — the REAL `defaultStopFailedLaunch`, not the walk's injected fake.
 *
 * A consult rank abandoned before its host could run a turn (kickoff not
 * persisted, or the child died before host registration) used to leave its
 * adv_sessions row open: the launcher is killed during boot before it learns its
 * own row id, so it cannot report its end, and the row read as an open session
 * until the idle reaper noticed it ~25-35 min later (observed: su-28711899, row
 * #35186, ended_by='reaper' at +25 min). The stop now closes that answering
 * identity's row as `ended_by='cleanup'`, but only after a CONFIRMED kill.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const killTask = vi.fn();
const closeTask = vi.fn();
const getLatestActiveAdvSessionByOwner = vi.fn();
const markAdvSessionEnded = vi.fn();

vi.mock('../task-manager/control', () => ({ killTask: (...a: unknown[]) => killTask(...a) }));
vi.mock('../task-manager/store', () => ({ closeTask: (...a: unknown[]) => closeTask(...a) }));
vi.mock('../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adv-sessions')>()),
  getLatestActiveAdvSessionByOwner: (...a: unknown[]) => getLatestActiveAdvSessionByOwner(...a),
  markAdvSessionEnded: (...a: unknown[]) => markAdvSessionEnded(...a),
}));

const { defaultStopFailedLaunch } = await import('./consult-dispatch');

const OWNER = 'su-answer-fresh';

describe('defaultStopFailedLaunch never-ran row close (WI-10006690)', () => {
  beforeEach(() => {
    killTask.mockReset().mockResolvedValue({ ok: true });
    closeTask.mockReset().mockResolvedValue(true);
    getLatestActiveAdvSessionByOwner.mockReset().mockResolvedValue({ id: 35186, coordOwnerId: OWNER });
    markAdvSessionEnded.mockReset().mockResolvedValue(true);
  });

  it('closes the answering identity’s open row as cleanup after a confirmed kill', async () => {
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(killTask).toHaveBeenCalledWith('task-1');
    expect(closeTask).not.toHaveBeenCalled();
    expect(getLatestActiveAdvSessionByOwner).toHaveBeenCalledWith(OWNER);
    expect(markAdvSessionEnded).toHaveBeenCalledWith(35186, null, 'cleanup');
    expect(out).toBe('stopped task task-1; closed adv_session #35186 as never-ran (cleanup)');
  });

  it('CONTROL: without the never-ran marker the stop touches no row', async () => {
    const out = await defaultStopFailedLaunch('task-1');
    expect(out).toBe('stopped task task-1');
    expect(getLatestActiveAdvSessionByOwner).not.toHaveBeenCalled();
    expect(markAdvSessionEnded).not.toHaveBeenCalled();
  });

  it('leaves the row open when the kill is refused — the process may still boot', async () => {
    killTask.mockResolvedValue({ ok: false, error: 'task_not_found' });
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(out).toBe('stop of task task-1 refused: task_not_found');
    expect(closeTask).not.toHaveBeenCalled();
    expect(markAdvSessionEnded).not.toHaveBeenCalled();
  });

  it('reconciles the exact task row when its systemd scope is positively already gone', async () => {
    killTask.mockResolvedValue({
      ok: false, taskId: 'task-1', action: 'kill', error: 'already_gone',
      detail: 'scope task-1.scope is no longer known to systemd',
    });
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(closeTask).toHaveBeenCalledWith('task-1', {
      state: 'ended_unobserved',
      exitReason: 'scope already gone during failed-launch containment',
    });
    expect(markAdvSessionEnded).toHaveBeenCalledWith(35186, null, 'cleanup');
    expect(out).toBe('verified task task-1 scope already gone; recorded ended_unobserved; closed adv_session #35186 as never-ran (cleanup)');
  });

  it('does not claim a ledger update when already-gone evidence races a terminal row or missing row', async () => {
    killTask.mockResolvedValue({ ok: false, error: 'already_gone' });
    closeTask.mockResolvedValue(false);
    const out = await defaultStopFailedLaunch('task-1');
    expect(out).toBe('verified task task-1 scope already gone; ledger row already terminal or unavailable');
  });

  it('leaves the row open when the kill throws', async () => {
    killTask.mockRejectedValue(new Error('ledger down'));
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(out).toBe('stop of task task-1 threw: ledger down');
    expect(markAdvSessionEnded).not.toHaveBeenCalled();
  });

  it('reports a missing open row instead of closing anything', async () => {
    getLatestActiveAdvSessionByOwner.mockResolvedValue(null);
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(out).toBe(`stopped task task-1; no open adv_session for ${OWNER}`);
    expect(markAdvSessionEnded).not.toHaveBeenCalled();
  });

  it('reports a row the launcher already ended (the guarded update matched nothing)', async () => {
    markAdvSessionEnded.mockResolvedValue(false);
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(out).toBe('stopped task task-1; adv_session #35186 was already ended');
  });

  it('never throws when the row close fails', async () => {
    getLatestActiveAdvSessionByOwner.mockRejectedValue(new Error('pg unavailable'));
    const out = await defaultStopFailedLaunch('task-1', { answeringOwnerId: OWNER });
    expect(out).toBe(`stopped task task-1; close of ${OWNER}'s adv_session threw: pg unavailable`);
  });
});
