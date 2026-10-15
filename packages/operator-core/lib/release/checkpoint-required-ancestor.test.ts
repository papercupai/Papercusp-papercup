import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assessFrozenRepairQueuePreflight, assessRequiredAncestorPreflight, frozenRepairQueueReadTarget } from './checkpoint-required-ancestor';
import { gateVerdictEnv } from './gate-verdict-target';

const queueRead = vi.hoisted(() => vi.fn());
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'papercusp-workspace' }));
vi.mock('../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'papercusp' }));
vi.mock('../harness/routines/release-actions', () => ({
  readFrozenCandidateRepairQueue: queueRead, releaseFixerSpawnAlive: vi.fn(async () => false),
}));

beforeEach(() => { queueRead.mockReset(); queueRead.mockResolvedValue(null); });

// WI-10008171: calendar's scheduled green-checkpoint read papercusp's frozen repair queue
// (keyed by the operator HOME harness) and adopted papercusp's repairHead f07043ba — a commit
// absent from calendar's integration root — then crashed on `rev-parse f07043ba^{commit}`.
describe('frozenRepairQueueReadTarget (WI-10008171)', () => {
  const home = { workspaceId: 'papercusp-workspace', installSlug: 'papercusp' };

  it('keys the queue by the GATED install when the runner carries a gate target', () => {
    const homeFn = vi.fn(() => home);
    const env = gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' });

    expect(frozenRepairQueueReadTarget(homeFn, env)).toEqual({
      workspaceId: 'papercusp-workspace',
      installSlug: 'calendar',
    });
    expect(homeFn).not.toHaveBeenCalled();
  });

  it('two installs in one workspace never share a queue key', () => {
    const calendar = frozenRepairQueueReadTarget(
      () => home,
      gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' }),
    );
    const papercusp = frozenRepairQueueReadTarget(
      () => home,
      gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'papercusp' }),
    );
    expect(calendar.installSlug).not.toBe(papercusp.installSlug);
  });

  it('falls back to the operator home only when no gate target is present', () => {
    expect(frozenRepairQueueReadTarget(() => home, {})).toEqual(home);
  });

  it('a half-set gate target is not a target: it falls back rather than mixing keys', () => {
    const env = gateVerdictEnv({ workspaceId: 'papercusp-workspace', installSlug: 'calendar' });
    const [workspaceKey] = Object.keys(env);
    expect(frozenRepairQueueReadTarget(() => home, { [workspaceKey]: 'papercusp-workspace' })).toEqual(home);
  });

  it('an explicit request target outranks the shared server environment', async () => {
    const target = { workspaceId: 'papercusp-workspace', installSlug: 'slack-asana-bug-drill' };
    expect(frozenRepairQueueReadTarget(() => home, gateVerdictEnv(home), target)).toEqual(target);
    await assessFrozenRepairQueuePreflight(null, '/drill', target);
    await assessRequiredAncestorPreflight('a'.repeat(40), null, '/drill', target);
    expect(queueRead.mock.calls.map(([selected]) => selected)).toEqual([target, target]);
  });
});
