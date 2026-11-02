/**
 * Tests for device-operator-actions — the PG-backed pause/resume sentinel
 * driven from the mobile WS bridge.
 *
 * (The operator-CARD verbs this file previously tested —
 * listPendingCards / dispatchCard / dismissCard / describeCard — were
 * retired with the scanner card stream: unify-agent-launches-as-blueprints
 * D-005. The pause/resume surface is what remains.)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('./operator-state-pg', () => ({
  readOperatorState: vi.fn(),
  updateOperatorState: vi.fn(),
}));
vi.mock('./sync-sse', () => ({
  notifySyncInvalidate: vi.fn().mockResolvedValue(undefined),
}));

import { readOperatorState, updateOperatorState } from './operator-state-pg';
import { notifySyncInvalidate } from './sync-sse';
import { setPaused, setResumed, setBackgroundActivityAutomatic, isPaused, getPauseInfo, routineBackgroundActivityAllowed, workspaceBackgroundActivityAllowed } from './device-operator-actions';
import { startupActivityFeatureId } from './schedule-inventory';
import { registerSystemAction } from './harness/routines/system-actions';

let saved: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  saved = {};
  vi.mocked(readOperatorState).mockResolvedValue(null);
  vi.mocked(updateOperatorState).mockImplementation(async (_table, _fallback, mutate) => {
    saved = mutate(saved) as Record<string, unknown>;
    return saved;
  });
});

describe('setPaused', () => {
  it('writes a paused row with who + when and invalidates the flag', async () => {
    await setPaused('mobile:device-1');
    expect(updateOperatorState).toHaveBeenCalledTimes(1);
    const [key] = vi.mocked(updateOperatorState).mock.calls[0]!;
    const state = saved;
    expect(key).toBe('operator_paused');
    expect(state.paused).toBe(true);
    expect(state.by).toBe('mobile:device-1');
    const at = state.at;
    expect(typeof at).toBe('string');
    if (typeof at !== 'string') throw new Error('Pause timestamp must be a string');
    expect(() => new Date(at).toISOString()).not.toThrow();
    expect(notifySyncInvalidate).toHaveBeenCalledWith('operatorPauseFlag');
  });
});

describe('routine execution admission', () => {
  const routine = { workspaceId: 'workspace-a', installSlug: 'home', name: 'optional-sweep', targetRole: 'system:admission-test-optional' };
  const policy = (over: Record<string, unknown> = {}) => ({
    version: 1, revision: 2, automatic: true, pausedUntil: null, features: {}, ...over,
  });

  it('reads fresh in the routine workspace and observes a newer disable on the next execution', async () => {
    vi.mocked(readOperatorState).mockResolvedValueOnce(null).mockResolvedValueOnce({ backgroundActivity: policy({ automatic: false }) });
    await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(true);
    await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(false);
    expect(readOperatorState).toHaveBeenNthCalledWith(2, 'operator_paused', 'workspace-a', { fresh: true });
  });

  it('uses the inventory identity for feature disable and independent pause', async () => {
    const id = startupActivityFeatureId({ source: 'routines', installSlug: routine.installSlug, name: routine.name, detail: {} }, { workspaceId: routine.workspaceId });
    for (const feature of [{ automatic: false }, { automatic: true, paused: true }]) {
      vi.mocked(readOperatorState).mockResolvedValue({ backgroundActivity: policy({ features: { [id]: { pausedUntil: null, revision: 1, ...feature } } }) });
      await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(false);
      await expect(routineBackgroundActivityAllowed({ ...routine, name: 'other-sweep' })).resolves.toBe(true);
    }
  });

  it('expires an offline pause without overriding an explicit disable', async () => {
    const pausedUntil = new Date(Date.now() - 1_000).toISOString();
    vi.mocked(readOperatorState).mockResolvedValue({ paused: true, backgroundActivity: policy({ pausedUntil }) });
    await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(true);
    vi.mocked(readOperatorState).mockResolvedValue({ paused: true, backgroundActivity: policy({ pausedUntil, automatic: false }) });
    await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(false);
  });

  it('withholds unreadable/newer policy and does not reveal its contents', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const row of [{ backgroundActivity: { version: 2, token: 'private' } }, { paused: 'false' }]) {
      vi.mocked(readOperatorState).mockResolvedValue(row);
      await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(false);
    }
    vi.mocked(readOperatorState).mockRejectedValue(new Error('private provider body'));
    await expect(routineBackgroundActivityAllowed(routine)).resolves.toBe(false);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private');
    warn.mockRestore();
  });

  it('allows only explicitly registered control/recovery actions during a pause', async () => {
    registerSystemAction('admission-test-recovery', async () => {}, { requiredForControl: 'Restores the settings control channel' });
    vi.mocked(readOperatorState).mockResolvedValue({ paused: true });
    await expect(routineBackgroundActivityAllowed({ ...routine, targetRole: 'system:admission-test-recovery' })).resolves.toBe(true);
    expect(readOperatorState).not.toHaveBeenCalled();
    await expect(routineBackgroundActivityAllowed({ ...routine, targetRole: 'system:git-sync-critical-name-alone' })).resolves.toBe(false);
  });

  it('rejects missing/wildcard workspace identity even for required recovery', async () => {
    for (const workspaceId of ['', '*', ' ']) {
      await expect(routineBackgroundActivityAllowed({ ...routine, workspaceId })).resolves.toBe(false);
    }
    expect(readOperatorState).not.toHaveBeenCalled();
  });
});

describe('workspace optional effect admission', () => {
  it('reads the explicit workspace freshly on every effect, including after a pause change', async () => {
    vi.mocked(readOperatorState).mockResolvedValueOnce({ paused: false }).mockResolvedValueOnce({ paused: true });
    await expect(workspaceBackgroundActivityAllowed('w-one')).resolves.toBe(true);
    await expect(workspaceBackgroundActivityAllowed('w-two')).resolves.toBe(false);
    expect(readOperatorState).toHaveBeenNthCalledWith(1, 'operator_paused', 'w-one', { fresh: true });
    expect(readOperatorState).toHaveBeenNthCalledWith(2, 'operator_paused', 'w-two', { fresh: true });
  });

  it('rejects missing workspace and malformed feature identity before reading policy', async () => {
    for (const workspaceId of ['', ' ', '*'])
      await expect(workspaceBackgroundActivityAllowed(workspaceId)).resolves.toBe(false);
    await expect(workspaceBackgroundActivityAllowed('w-one', 'foreign-feature')).resolves.toBe(false);
    expect(readOperatorState).not.toHaveBeenCalled();
  });
});

describe('setResumed', () => {
  it('writes paused:false (keeps the row as audit trail) and invalidates', async () => {
    await setResumed();
    expect(saved).toMatchObject({ paused: false, backgroundActivity: { revision: 1, automatic: true } });
    expect(notifySyncInvalidate).toHaveBeenCalledWith('operatorPauseFlag');
  });
});

describe('preserving background policy lifecycle', () => {
  const id = `activity-${'a'.repeat(64)}`;
  const initial = () => ({ paused: false, futureRoot: { keep: true }, backgroundActivity: {
    version: 1, revision: 10, automatic: false, pausedUntil: null, futurePolicy: 'keep',
    features: { [id]: { automatic: false, paused: true, pausedUntil: null, revision: 3, futureFeature: 'keep' } },
  } });

  it('preserves disables, feature pauses and unknown fields across pause/resume', async () => {
    saved = initial();
    await setPaused('settings', new Date(Date.now() + 60_000).toISOString(), 10);
    await setResumed(11);
    expect(saved).toMatchObject({ ...initial(), backgroundActivity: { ...initial().backgroundActivity, revision: 12 } });
  });

  it('rejects a stale resume after a newer disable without changing the row or invalidating sync', async () => {
    saved = initial();
    await setPaused('settings', null, 10);
    await setBackgroundActivityAutomatic(false, 11);
    const before = structuredClone(saved);
    vi.mocked(notifySyncInvalidate).mockClear();
    await expect(setResumed(11)).rejects.toThrow('Startup policy changed');
    expect(saved).toEqual(before);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('evaluates an expired offline pause without restoring a durable disable', async () => {
    const row = initial();
    row.paused = true;
    const expired = { ...row, backgroundActivity: { ...row.backgroundActivity, pausedUntil: new Date(Date.now() - 1_000).toISOString() } };
    vi.mocked(readOperatorState).mockResolvedValue(expired);
    await expect(isPaused()).resolves.toBe(false);
    await expect(getPauseInfo()).resolves.toEqual({ paused: false, pausedUntil: null, revision: 10 });
    expect(expired.backgroundActivity.automatic).toBe(false);
    expect(updateOperatorState).not.toHaveBeenCalled();
  });

  it('refuses invalid deadlines and newer policy formats before overwriting them', async () => {
    await expect(setPaused('settings', 'tomorrow')).rejects.toThrow();
    await expect(setPaused('settings', new Date(Date.now() - 1).toISOString())).rejects.toThrow();
    expect(updateOperatorState).not.toHaveBeenCalled();
    saved = { backgroundActivity: { version: 2, secret: 'unrecognized' } };
    const before = structuredClone(saved);
    await expect(setResumed()).rejects.toThrow();
    expect(saved).toEqual(before);
  });

  it('fails closed on malformed stored roots and pause flags instead of overwriting or allowing them', async () => {
    for (const invalid of ['not-an-object', { paused: 'false' }, []]) {
      vi.mocked(readOperatorState).mockResolvedValue(invalid);
      await expect(isPaused()).rejects.toThrow();
      await expect(getPauseInfo()).rejects.toThrow();
      saved = invalid as Record<string, unknown>;
      const before = structuredClone(saved);
      await expect(setResumed()).rejects.toThrow();
      expect(saved).toEqual(before);
    }
  });
});

describe('isPaused', () => {
  it('true only when the row says paused', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: true, by: 'x' });
    await expect(isPaused()).resolves.toBe(true);
  });
  it('false when row is paused:false', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: false });
    await expect(isPaused()).resolves.toBe(false);
  });
  it('false when no row exists', async () => {
    (readOperatorState as any).mockResolvedValue(null);
    await expect(isPaused()).resolves.toBe(false);
  });
});

describe('getPauseInfo', () => {
  it('returns who/when while paused', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: true, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
    await expect(getPauseInfo()).resolves.toEqual({ paused: true, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
  });
  it('ignores stale by/at once resumed', async () => {
    (readOperatorState as any).mockResolvedValue({ paused: false, by: 'ops', at: '2026-06-05T08:00:00.000Z' });
    await expect(getPauseInfo()).resolves.toEqual({ paused: false });
  });
  it('handles a missing row', async () => {
    (readOperatorState as any).mockResolvedValue(null);
    await expect(getPauseInfo()).resolves.toEqual({ paused: false });
  });
});
