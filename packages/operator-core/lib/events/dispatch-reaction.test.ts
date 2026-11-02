import { describe, it, expect, vi } from 'vitest';
const deps = vi.hoisted(() => ({ loads: 0, loadStack: '' }));
vi.mock('../projected-tool-deps', () => {
  deps.loads++;
  deps.loadStack = new Error('Unexpected eager dispatcher import').stack ?? '';
  return { PROJECTED_DEPS: {} };
});
vi.mock('../device-operator-actions', () => ({ workspaceBackgroundActivityAllowed: vi.fn(async () => true) }));
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../agent-tools/coordination/identity';
import { buildReactionCtx, fireReactionInProcess, reactionBackgroundActivityAllowed } from './dispatch-reaction';
import { workspaceBackgroundActivityAllowed } from '../device-operator-actions';
import { CACHE_BUMP_TAGS_ACTION } from './builtin-actions';
import type { ReactionCause } from './types';
import { startupReactionFeatureId } from './reaction-id';

it('builds reaction context without loading the product dispatcher', () => {
  expect(deps.loads, deps.loadStack).toBe(0);
});

const parent = {
  workspaceId: 'w1',
  harnessSlug: 'h9',
  role: 'worker',
  featureId: 'F-1',
  chunkId: 'C-1',
  spawnId: 'sp-parent',
  uiClientId: 'agent-1',
} as unknown as UnifiedToolContext;

const cause: ReactionCause = { depth: 1, chain: ['r1'], ruleId: 'r1', rootRunId: 'root' };

describe('event execution admission', () => {
  it('withholds before tool lookup/dispatch and rechecks after resume', async () => {
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const options = { fire: 'unregistered:optional', args: {}, parentCtx: parent, cause };
    await expect(fireReactionInProcess(options)).resolves.toEqual({ ok: true, withheld: true });
    await expect(fireReactionInProcess(options)).resolves.toMatchObject({ ok: false, error: 'unknown reaction tool "unregistered:optional"' });
    expect(workspaceBackgroundActivityAllowed).toHaveBeenLastCalledWith('w1', startupReactionFeatureId('w1', 'r1'));
    expect(deps.loads, deps.loadStack).toBe(0);
  });

  it('keeps the closed cache/control actions available without reading optional policy', async () => {
    vi.mocked(workspaceBackgroundActivityAllowed).mockClear();
    await expect(reactionBackgroundActivityAllowed('w1', CACHE_BUMP_TAGS_ACTION, 'r1')).resolves.toBe(true);
    for (const workspaceId of ['', '*', ' '])
      await expect(reactionBackgroundActivityAllowed(workspaceId, CACHE_BUMP_TAGS_ACTION, 'r1')).resolves.toBe(false);
    expect(workspaceBackgroundActivityAllowed).not.toHaveBeenCalled();
  });

  it('isolates disabled rules and workspaces and rejects optional work without a rule identity', async () => {
    const disabled = startupReactionFeatureId('w1', 'r1');
    vi.mocked(workspaceBackgroundActivityAllowed).mockImplementation(async (_workspace, featureId) => featureId !== disabled);
    await expect(fireReactionInProcess({ fire: 'unregistered:optional', args: {}, parentCtx: parent, cause }))
      .resolves.toEqual({ ok: true, withheld: true });
    await expect(reactionBackgroundActivityAllowed('w1', 'unregistered:optional', 'r2')).resolves.toBe(true);
    await expect(reactionBackgroundActivityAllowed('w2', 'unregistered:optional', 'r1')).resolves.toBe(true);
    vi.mocked(workspaceBackgroundActivityAllowed).mockClear();
    await expect(reactionBackgroundActivityAllowed('w1', 'unregistered:optional', '')).resolves.toBe(false);
    expect(workspaceBackgroundActivityAllowed).not.toHaveBeenCalled();
    vi.mocked(workspaceBackgroundActivityAllowed).mockResolvedValue(true);
  });
});

describe('buildReactionCtx', () => {
  it('inherits the trigger scope + stamps reaction provenance', () => {
    const c = buildReactionCtx(parent, 'w1', cause);
    expect(c.workspaceId).toBe('w1');
    expect(c.harnessSlug).toBe('h9');
    expect(c.role).toBe('worker');
    expect(c.uiClientId).toBe('agent-1');
    expect(c.spawnId).toBe('event-reaction');
    expect(c.parentSpawnId).toBe('sp-parent');
    expect(c.transport).toBe('in_process');
    expect(c.reactionCause).toEqual(cause);
    expect(typeof c.runId).toBe('string');
  });

  it('first-party (no capability) runs with full system trust', () => {
    const c = buildReactionCtx(parent, 'w1', cause);
    expect(c.gateBypass).toEqual({ capability: true, quota: true, role: true });
    expect(c.principal?.slug).toBe('system:event-reaction');
    expect(c.principal?.capabilities.has('*')).toBe(true);
  });

  it('remains attributable through the coordination identity resolver', () => {
    const c = buildReactionCtx(parent, 'w1', cause);
    const identity = resolveAgentIdentity(c);
    expect(identity.ownerId).toBe('agent-1');
    expect(identity.source).toBe('event-reaction');
  });

  it('scoped (capability) sandboxes to that one capability (D-012)', () => {
    const c = buildReactionCtx(parent, 'w1', cause, 'plugin:foo:emit');
    // capability bypass is OFF → the capability gate enforces against the principal
    expect(c.gateBypass).toEqual({ quota: true, role: true });
    expect(c.principal?.capabilities.has('*')).toBe(false);
    expect(c.principal?.capabilities.has('plugin:foo:emit')).toBe(true);
    expect(c.principal?.slug).toContain('plugin:event-reaction:plugin:foo:emit');
  });

  it('falls back to operator role + wildcard harness when the parent lacks them', () => {
    const c = buildReactionCtx({} as UnifiedToolContext, 'w2', cause);
    expect(c.role).toBe('operator');
    expect(c.harnessSlug).toBe('*');
    expect(c.uiClientId).toBeNull();
  });
});
