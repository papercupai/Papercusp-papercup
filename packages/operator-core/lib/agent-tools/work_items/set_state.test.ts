/**
 * set_state.test.ts — work_items:set_state handler, dual-arity keyed-array contract
 * (bulk-endpoint-standardization-2026-06-21). Engine + P-114 arm mocked. Pins: inline
 * single → one result; ids:[…]+state homogeneous; items:[…] heterogeneous states; a
 * not-found item fails only itself; the P-114 arm is evaluated per item.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { standardValidate } from '@papercusp/tooldef';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
// readNonAgentWorkCategory backs the D-035 agent-work door gate (work-nature/agent-work-door-gate);
// null = the row IS agent work, so every existing case reaches its own write path unchanged.
const readNonAgentWorkCategory = vi.hoisted(() => vi.fn(async () => null as { nature: string; audience: string | null } | null));
vi.mock('../../work-items', () => ({
  getWorkItem: vi.fn(),
  setWorkItemStateWithAliasInfo: vi.fn(),
  commentWorkItem: vi.fn(),
  readNonAgentWorkCategory,
}));
vi.mock('../../scheduler/plan-item-lane-guard', () => ({ resolvePlanItemStamp: vi.fn() }));
vi.mock('./arm-reversible-work-item', () => ({ planWorkItemArm: vi.fn(async () => null), commitWorkItemArm: vi.fn() }));

import { commentWorkItem, getWorkItem, setWorkItemStateWithAliasInfo, type WorkItem } from '../../work-items';
import { resolvePlanItemStamp } from '../../scheduler/plan-item-lane-guard';
import { mockResolvedTyped } from '../../testing/typed-mock';
import { planWorkItemArm } from './arm-reversible-work-item';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
const getM = vi.mocked(getWorkItem);
const setM = vi.mocked(setWorkItemStateWithAliasInfo);
const planStampM = vi.mocked(resolvePlanItemStamp);
const armM = vi.mocked(planWorkItemArm);
const tool = (await import('./set_state')).default;

type Out = { data: any };
const body = async (args: unknown) => (((await tool.handler(args as never, {} as never)) as Out).data);

describe('work_items:set_state dispatch validation (EI-25280526101674032)', () => {
  it('accepts a forced reopen through the Standard Schema validator used by MCP dispatch', async () => {
    const parsed = await standardValidate(tool.args, {
      id: 'WI-test',
      harness: 'papercusp',
      state: 'open',
      force: true,
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({ id: 'WI-test', state: 'open', force: true });
    }
  });

  it('explains that terminal evidence fields are invalid on an open transition', async () => {
    const parsed = await standardValidate(tool.args, {
      id: 'WI-test',
      harness: 'papercusp',
      state: 'open',
      force: true,
      completionRef: 'reopen note',
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const message = parsed.issues[0]?.message ?? '';
      expect(message).toContain('`completionRef` is a terminal-only field');
      expect(message).toContain('use `reason` or `note`');
      expect(message).not.toContain('Invalid option: expected one of');
    }
  });

  it.each([
    ['inline', { id: 'WI-test', state: 'dropped' }],
    ['ids batch', { ids: ['WI-test'], state: 'dropped' }],
    ['items batch', { items: [{ id: 'WI-test', state: 'dropped' }] }],
  ])('explains missing terminal assumptions for the %s form', async (_label, input) => {
    const parsed = await standardValidate(tool.args, input);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      const messages = parsed.issues.map((entry) => entry.message).join('\n');
      expect(messages).toContain('a terminal close requires `assumptions`');
      expect(messages).not.toContain('Invalid option: expected one of');
      expect(messages).not.toContain('Unrecognized keys: "id", "state"');
    }
  });
});

/** Default mock: no alias — the item lands exactly on the requested state. */
function noAlias(id: string, state: string) {
  return { workItem: { id, state }, aliased: false, requestedState: state, expectedState: state, appliedState: state } as never;
}

const workItem = (overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'state'>): WorkItem => ({
  kind: 'feature',
  family: 'feature',
  harness: 'papercusp',
  title: 'Plan-linked work',
  summary: '',
  assignee: null,
  takenAt: null,
  lastProgressAt: null,
  assignedBy: null,
  createdBy: null,
  severity: null,
  goalId: null,
  parent: null,
  payload: {},
  origin: 'local',
  auditVerdict: null,
  verifiedAuthorGithubUserId: null,
  rank: null,
  rankWriter: null,
  rankUpdatedAt: null,
  priority: null,
  terminalOwner: null,
  terminalCompletionRef: null,
  terminalCompletionEvidence: null,
  completionAuthority: null,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
  closedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  armM.mockResolvedValue(null as never);
  getM.mockResolvedValue(null);
  planStampM.mockResolvedValue(null);
  setM.mockImplementation(async (id: string, state: string) => noAlias(id, state));
});

describe('work_items:set_state handler (keyed-array)', () => {
  it('sets one inline and returns the workItem', async () => {
    const b = await body({ id: 'WI-1', state: 'passed' });
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { id: 'WI-1', state: 'passed' } });
    expect(setM).toHaveBeenCalledWith('WI-1', 'passed', {
      harness: undefined,
      by: 'me',
      completionRef: undefined,
      force: undefined,
      onTerminalConflict: expect.any(Function),
    });
  });

  it('sets MANY to the same state via ids:[…] (homogeneous) — arm evaluated per item', async () => {
    const b = await body({ ids: ['WI-1', 'WI-2'], state: 'resolved', harness: 'h' });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.every((r: { workItem: { state: string } }) => r.workItem.state === 'resolved')).toBe(true);
    expect(armM).toHaveBeenCalledTimes(2);
    expect(setM).toHaveBeenCalledWith('WI-2', 'resolved', {
      harness: 'h',
      by: 'me',
      completionRef: undefined,
      force: undefined,
      onTerminalConflict: expect.any(Function),
    });
  });

  it('items:[…] sets heterogeneous states per item', async () => {
    const b = await body({ items: [{ id: 'WI-1', state: 'passed' }, { id: 'WI-2', state: 'failing' }] });
    expect(b.results[0].workItem.state).toBe('passed');
    expect(b.results[1].workItem.state).toBe('failing');
  });

  it('a not-found item (null workItem) fails only itself', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      id === 'WI-X'
        ? ({ workItem: null, aliased: false, requestedState: state, appliedState: null } as never)
        : noAlias(id, state),
    );
    const b = await body({ ids: ['WI-1', 'WI-X'], state: 'done' });
    expect(b.counts).toEqual({ ok: 1, failed: 1, refusals: { 'remote-authored': 0, other: 1 } });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-X' });
  });

  it('groups remote-authored and other refusals in bounded counts without changing item errors', async () => {
    setM
      .mockRejectedValueOnce(new Error('work_item is remote-authored and cannot be mutated locally'))
      .mockRejectedValueOnce(new Error('database refusal'));
    const b = await body({ ids: ['WI-remote', 'WI-other'], state: 'wip' });
    expect(b.counts).toEqual({ ok: 0, failed: 2, refusals: { 'remote-authored': 1, other: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-remote', error: expect.stringContaining('remote-authored') });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'WI-other', error: 'database refusal' });
  });

  it('a thrown engine error (unmappable state) becomes that item\'s {ok:false}', async () => {
    setM.mockRejectedValueOnce(new Error('cannot take state'));
    const b = await body({ id: 'WI-1', state: 'bogus' });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-1' });
    expect(String(b.results[0].error)).toMatch(/cannot take state/);
  });

  it('refuses direct blocked writes for plan-linked work-items and points to the plan source of truth', async () => {
    mockResolvedTyped(getM, workItem({ id: 'WI-plan', state: 'wip' }));
    planStampM.mockResolvedValue({ plan_slug: 'plan-slug', item_ids: ['P-015'] });

    const b = await body({ id: 'WI-plan', state: 'blocked' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-plan' });
    expect(String(b.results[0].error)).toMatch(/plan-slug#P-015/);
    expect(String(b.results[0].error)).toMatch(/plans:set-status/);
    expect(setM).not.toHaveBeenCalled();
    expect(armM).not.toHaveBeenCalled();
  });

  it('refuses a standalone blocked write without an active typed blocker', async () => {
    mockResolvedTyped(getM, workItem({ id: 'WI-standalone', state: 'wip', payload: {} }));
    const b = await body({ id: 'WI-standalone', state: 'blocked' });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(String(b.results[0].error)).toMatch(/no active typed blocker/);
    expect(String(b.results[0].error)).toMatch(/work_items:set_blocker/);
    expect(String(b.results[0].error)).toMatch(/work_items:link/);
    expect(String(b.results[0].error)).toContain(
      'work_items:link { id: "<blocker-id>", target_id: "WI-standalone", rel: "blocks" }',
    );
    expect(String(b.results[0].error)).not.toContain('work_items:link { source:');
    expect(setM).not.toHaveBeenCalled();
    expect(armM).not.toHaveBeenCalled();
  });

  it('accepts a standalone blocked write when an active typed external blocker exists', async () => {
    mockResolvedTyped(
      getM,
      workItem({
        id: 'WI-typed',
        state: 'wip',
        payload: {
          externalBlockers: [
            {
              kind: 'event',
              capability: 'live-dependency',
              capabilitySource: 'explicit',
              ref: 'deploy:complete',
              summary: 'await deploy',
              status: 'active',
              createdAt: '2026-09-01T00:00:00.000Z',
              createdBy: 'me',
              updatedAt: '2026-09-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );
    const b = await body({ id: 'WI-typed', state: 'blocked' });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(setM).toHaveBeenCalledWith('WI-typed', 'blocked', {
      harness: undefined,
      by: 'me',
      completionRef: undefined,
      force: undefined,
      onTerminalConflict: expect.any(Function),
    });
  });

  it('does not treat cleared blocker history as an active reason to block', async () => {
    mockResolvedTyped(
      getM,
      workItem({
        id: 'WI-cleared',
        state: 'wip',
        payload: {
          externalBlockers: [
            {
              kind: 'runtime',
              ref: 'service:ready',
              summary: 'service was unavailable',
              status: 'cleared',
              createdAt: '2026-09-01T00:00:00.000Z',
              createdBy: 'me',
              updatedAt: '2026-09-01T00:01:00.000Z',
              clearedAt: '2026-09-01T00:01:00.000Z',
              clearedBy: 'me',
            },
          ],
        },
      }),
    );

    const b = await body({ id: 'WI-cleared', state: 'blocked' });

    expect(b.counts).toMatchObject({ ok: 0, failed: 1 });
    expect(String(b.results[0].error)).toMatch(/no active typed blocker/);
    expect(setM).not.toHaveBeenCalled();
  });
});

describe('work_items:set_state — typed blocker guidance (WI-39529)', () => {
  it('stays within the shared prompt-weight budget', () => {
    expect(promptWeight(tool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it('routes external and work-item dependency reasons to their structured writers', () => {
    const description = (tool as { description?: string }).description ?? '';
    const guidance = (tool as { guidance?: { when?: string; chaining?: string; seeAlso?: string[] } }).guidance;
    const text = [description, guidance?.when, guidance?.chaining, ...(guidance?.seeAlso ?? [])].join('\n');

    expect(text).toContain('work_items:set_blocker');
    expect(text).toContain('work_items:link');
    expect(text).toContain('work_items:link { id, rel:"blocks", target_id }');
    expect(text).toContain('active typed external blocker');
    expect(text).toContain('rel:"blocks"');
  });

  it('publishes the typed-blocker precondition on every schema state variant that accepts blocked', () => {
    const schema = z.toJSONSchema(tool.args as never) as Record<string, unknown>;
    const blockedStateSchemas: Array<Record<string, unknown>> = [];
    const visit = (value: unknown) => {
      if (typeof value !== 'object' || value === null) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      const object = value as Record<string, unknown>;
      const states = object.enum;
      if (Array.isArray(states) && states.includes('blocked')) blockedStateSchemas.push(object);
      Object.values(object).forEach(visit);
    };
    visit(schema);

    expect(blockedStateSchemas.length).toBeGreaterThan(0);
    for (const stateSchema of blockedStateSchemas) {
      expect(stateSchema.description).toContain('active typed blocker');
      expect(stateSchema.description).toContain('work_items:set_blocker');
      expect(stateSchema.description).toContain('work_items:link');
    }
  });
});

// EI-7125 / WI-2573: an issue-family 'blocked'/'needs-human'/etc request silently
// aliases to 'open' inside setWorkItemState (EI-450) — this used to read as an
// unexplained ok:true no-op. onAlias now lets the tool surface a per-item note.
describe('work_items:set_state — alias note (EI-7125 / WI-2573)', () => {
  it('surfaces an aliasNote when the write aliases', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'done' },
      aliased: true,
      requestedState: state,
      expectedState: 'done',
      appliedState: 'done',
      aliasNote: `requested state '${state}' was normalized to 'done'.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', workItem: { state: 'done' }, expectedState: 'done' });
    expect(b.results[0].aliasNote).toMatch(/requested state 'resolved'.*normalized to 'done'/);
  });

  it('omits aliasNote entirely when the requested state is already canonical (no alias fired)', async () => {
    // Default mock: no alias — mirrors a canonical state like 'resolved'.
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0]).not.toHaveProperty('aliasNote');
  });

  it('each item in a heterogeneous batch gets its OWN aliasNote independently', async () => {
    setM.mockImplementation(async (id: string, state: string) =>
      state === 'resolved'
        ? ({
            workItem: { id, state: 'done' },
            aliased: true,
            requestedState: state,
            expectedState: 'done',
            appliedState: 'done',
            aliasNote: `requested state '${state}' was normalized to 'done'.`,
          } as never)
        : noAlias(id, state),
    );
    const b = await body({ items: [{ id: 'WI-1', state: 'resolved' }, { id: 'WI-2', state: 'wip' }] });
    expect(b.results[0].aliasNote).toBeTruthy();
    expect(b.results[1]).not.toHaveProperty('aliasNote');
  });
});

// EI-7712: the fail-loud contract every result row now carries — `aliased` /
// `requestedState` / `appliedState` are present on EVERY successful result, not just
// when an aliasNote string is generated, so a careless caller comparing appliedState
// against what it asked for catches a divergence even without pattern-matching prose.
describe('work_items:set_state — aliased/requestedState/appliedState on every result (EI-7712)', () => {
  it('a clean (non-aliased) write reports aliased:false with matching requested/applied state', async () => {
    const b = await body({ id: 'WI-1', state: 'wip' });
    expect(b.results[0]).toMatchObject({ aliased: false, requestedState: 'wip', expectedState: 'wip', appliedState: 'wip' });
  });

  it('an aliased write reports aliased:true with DIVERGENT requested/applied state, even without reading aliasNote', async () => {
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'done' },
      aliased: true,
      requestedState: state,
      expectedState: 'done',
      appliedState: 'done',
      aliasNote: `requested state '${state}' was normalized to 'done'.`,
    }) as never);
    const b = await body({ id: 'WI-1', state: 'resolved' });
    expect(b.results[0].aliased).toBe(true);
    expect(b.results[0].requestedState).toBe('resolved');
    expect(b.results[0].expectedState).toBe('done');
    expect(b.results[0].appliedState).toBe('done');
    expect(b.results[0].requestedState).not.toBe(b.results[0].appliedState);
  });

  it('a silent divergence with NO intentional normalization fails the item using the canonical readback — the WI-2381 recurrence guard', async () => {
    // Simulates a lower-layer bug that persists a DIFFERENT state than requested
    // WITHOUT a normalization alias. The handler must fail this item instead of returning
    // ok:true with a different state that callers can overlook.
    setM.mockImplementation(async (id: string, state: string) => ({
      workItem: { id, state: 'open' }, // silently stayed 'open' instead of 'blocked'
      aliased: true,
      requestedState: state,
      expectedState: 'blocked',
      appliedState: 'open',
      aliasNote: `requested state '${state}' was not applied verbatim — recorded as 'open' instead.`,
    }) as never);
    const b = await body({ id: 'WI-2381', state: 'blocked' });
    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0]).toMatchObject({
      ok: false,
      id: 'WI-2381',
      error: expect.stringContaining("normalizes to 'blocked', but the canonical post-write reader returned 'open'"),
    });
  });
});

// WI-2142258: setWorkItemStateWithAliasInfo already computes the full attested/upgraded
// diagnosis for a terminal write that lands on a row a DIFFERENT actor already closed
// (e.g. system:plan-item-reconcile racing ahead of a caller who flipped the plan item
// first) via its `onTerminalConflict` callback, and work_items:complete already wires +
// surfaces it. The three `toHaveBeenCalledWith(..., onTerminalConflict: expect.any(Function))`
// assertions above only prove THIS tool passes a callback — they pass even if that callback
// is a no-op. These prove the callback's output actually reaches the caller, end-to-end,
// under the SAME field names/shape work_items:complete uses (deliberately, per the
// set_state.ts comment at the wiring site) — a caller must not learn two spellings of
// "your evidence didn't win" depending on which tool it called.
describe('work_items:set_state — terminal conflict surfaced end-to-end (WI-2142258)', () => {
  it('returns the attestation when a second terminal close preserves the existing state', async () => {
    setM.mockImplementation(async (id: string, state: string, opts) => {
      opts?.onTerminalConflict?.({
        outcome: 'attested',
        existingOwner: 'system:tool-failure-signature-fold',
        existingAuthority: null,
        existingEvidenceSufficient: false,
        incomingEvidenceSufficient: false,
        note: 'was ALREADY completed; this close was FILED AS A SECOND ATTESTATION',
      } as never);
      return {
        workItem: { id, state: 'resolved' },
        aliased: true,
        requestedState: state,
        expectedState: 'dropped',
        appliedState: 'resolved',
      } as never;
    });

    const b = await body({
      id: 'EI-already-resolved',
      state: 'dropped',
      completionRef: 'duplicate observation retraction',
      assumptions: 'none',
    });

    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({
      ok: true,
      aliased: true,
      requestedState: 'dropped',
      expectedState: 'dropped',
      appliedState: 'resolved',
      terminalConflict: {
        outcome: 'attested',
        existingOwner: 'system:tool-failure-signature-fold',
      },
    });
    expect(b.results[0].terminalConflictWarning).toContain('COMPLETION RECORDED AS A SECOND ATTESTATION');
  });

  it('still fails readback verification when an upgraded terminal write returns a divergent state', async () => {
    setM.mockImplementation(async (id: string, state: string, opts) => {
      opts?.onTerminalConflict?.({
        outcome: 'upgraded',
        existingOwner: 'system:plan-item-reconcile',
        existingAuthority: 'proposed',
        existingEvidenceSufficient: false,
        incomingEvidenceSufficient: true,
        note: 'the richer completion replaced the earlier record',
      } as never);
      return {
        workItem: { id, state: 'resolved' },
        aliased: true,
        requestedState: state,
        expectedState: 'dropped',
        appliedState: 'resolved',
      } as never;
    });

    const b = await body({
      id: 'EI-upgraded-divergent',
      state: 'dropped',
      completionRef: 'richer completion evidence',
      assumptions: 'none',
    });

    expect(b).toMatchObject({ ok: false, counts: { ok: 0, failed: 1 } });
    expect(b.results[0].error).toContain(
      "normalizes to 'dropped', but the canonical post-write reader returned 'resolved'",
    );
  });

  it('surfaces terminalConflictWarning + raw terminalConflict when the callback fires with outcome "attested"', async () => {
    setM.mockImplementation(async (id: string, state: string, opts) => {
      opts?.onTerminalConflict?.({
        outcome: 'attested',
        existingOwner: 'system:plan-item-reconcile',
        existingAuthority: 'proposed',
        existingEvidenceSufficient: false,
        incomingEvidenceSufficient: true,
        note: 'was ALREADY completed by system:plan-item-reconcile … FILED AS A SECOND ATTESTATION',
      } as never);
      return noAlias(id, state);
    });

    const b = await body({ id: 'WI-1', state: 'done', completionRef: 'landed in abc123', assumptions: 'none' });

    expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1' });
    expect(b.results[0].terminalConflictWarning).toContain('COMPLETION RECORDED AS A SECOND ATTESTATION');
    expect(b.results[0].terminalConflictWarning).toContain('was ALREADY completed by system:plan-item-reconcile');
    expect(b.results[0].terminalConflict).toMatchObject({
      outcome: 'attested',
      existingOwner: 'system:plan-item-reconcile',
    });
  });

  it('surfaces the distinct "replaced" wording when the callback fires with outcome "upgraded"', async () => {
    setM.mockImplementation(async (id: string, state: string, opts) => {
      opts?.onTerminalConflict?.({
        outcome: 'upgraded',
        existingOwner: 'system:plan-item-reconcile',
        existingAuthority: 'proposed',
        existingEvidenceSufficient: false,
        incomingEvidenceSufficient: true,
        note: 'your record replaced the thinner reconciler stub',
      } as never);
      return noAlias(id, state);
    });

    const b = await body({ id: 'WI-2', state: 'done', completionRef: 'landed in abc123', assumptions: 'none' });

    expect(b.results[0].terminalConflictWarning).toContain('YOUR COMPLETION REPLACED AN EARLIER, THINNER ONE');
    expect(b.results[0].terminalConflict).toMatchObject({ outcome: 'upgraded' });
  });

  it('omits terminalConflictWarning/terminalConflict entirely when the callback never fires (the ordinary case)', async () => {
    const b = await body({ id: 'WI-3', state: 'done', completionRef: 'landed in abc123', assumptions: 'none' });

    expect(b.results[0]).not.toHaveProperty('terminalConflictWarning');
    expect(b.results[0]).not.toHaveProperty('terminalConflict');
  });
});

describe('work_items:set_state — terminal timeout recovery guidance (EI-20234204782129196)', () => {
  it('names the assumptions declaration when set_state is used after a completion timeout', () => {
    const description = (tool as { description?: string }).description ?? '';
    const guidance = (tool as { guidance?: { when?: string; chaining?: string } }).guidance;
    const text = `${description}\n${guidance?.when ?? ''}\n${guidance?.chaining ?? ''}`;
    expect(text).toContain('completionRef');
    expect(text).toContain('assumptions');
    expect(text).toContain('"none"');
    expect(text).toContain('facts:assert keys');
    expect(text).toContain('work_items:complete times out');
  });
});

/**
 * P-005 / D-006 — the terminal-state evidence requirement is STRUCTURAL.
 *
 * These assert the SCHEMA (tool.args), not the handler: the point of the change is
 * that an evidence-less terminal write is unrepresentable at the boundary, so it
 * never reaches the handler at all. Before this, `state` was a bare string and
 * `completionRef` was `.optional()` with the rule living in its .describe() — the
 * IFEval-FC failure mode (models miss rules embedded in schema descriptions).
 */
describe('terminal writes structurally require completion evidence (P-005)', () => {
  const parse = (args: unknown) => (tool.args as { safeParse: (v: unknown) => { success: boolean } }).safeParse(args);

  /**
   * P-017 (b) gate #2 added a SECOND terminal requirement (`assumptions`, D-050). This
   * block is about the EVIDENCE rule, so every payload here carries a satisfied
   * assumption declaration — otherwise `rejects(...)` would pass for the wrong reason
   * (missing assumptions rather than missing evidence) and would keep passing even if
   * the evidence gate were deleted. The assumption gate is isolated symmetrically in
   * its own describe block below.
   */
  const withAssumptions = (args: unknown): unknown => {
    if (typeof args !== 'object' || args === null) return args;
    const o = { ...(args as Record<string, unknown>) };
    const terminalStates = new Set(['done', 'dropped', 'passed', 'deprecated', 'resolved', 'closed']);
    const isTerminal = (state: unknown) =>
      typeof state === 'string' && terminalStates.has(state.trim().toLowerCase());
    if (Array.isArray(o.items)) {
      o.items = o.items.map((it) =>
        typeof it === 'object' && it !== null && isTerminal((it as Record<string, unknown>).state)
          ? { assumptions: 'none', ...(it as Record<string, unknown>) }
          : it,
      );
    }
    if (!Array.isArray(o.items) && o.assumptions === undefined && isTerminal(o.state)) o.assumptions = 'none';
    return o;
  };

  const accepts = (args: unknown) => expect(parse(withAssumptions(args)).success).toBe(true);
  const rejects = (args: unknown) => expect(parse(withAssumptions(args)).success).toBe(false);

  it('rejects an evidence-less terminal write in ALL THREE call shapes', () => {
    // Fixing only itemSpec would MOVE the bypass to the shorthand rather than close it.
    rejects({ id: 'WI-1', state: 'done' });
    rejects({ ids: ['WI-1', 'WI-2'], state: 'dropped' });
    rejects({ items: [{ id: 'WI-1', state: 'done' }] });
  });

  it('accepts a terminal write that carries evidence, in all three shapes', () => {
    accepts({ id: 'WI-1', state: 'done', completionRef: 'landed in abc123' });
    accepts({ ids: ['WI-1'], state: 'dropped', completionRef: 'superseded by WI-9' });
    accepts({ items: [{ id: 'WI-1', state: 'done', completionRef: 'ref' }] });
  });

  it('enforces the rule on LEGACY terminal spellings too, not just done/dropped', () => {
    // These are terminal only after aliasing — a gate keyed on the raw unified pair
    // would let `passed`/`resolved` close an item with no evidence at all.
    rejects({ id: 'WI-1', state: 'passed' });
    rejects({ id: 'WI-1', state: 'resolved' });
    rejects({ id: 'WI-1', state: 'closed' });
    rejects({ id: 'WI-1', state: 'deprecated' });
  });

  it('leaves non-terminal writes alone — no evidence required', () => {
    for (const state of ['wip', 'blocked', 'needs-human', 'open', 'todo']) {
      accepts({ id: 'WI-1', state });
    }
  });

  it('still folds case drift, and enforces the gate on the folded value', () => {
    // Acceptance must not narrow: `DONE`/`WIP` worked before and still do — but
    // `DONE` is now correctly recognized as terminal rather than slipping the gate.
    rejects({ id: 'WI-1', state: 'DONE' });
    accepts({ id: 'WI-1', state: 'DONE', completionRef: 'ref' });
    accepts({ id: 'WI-1', state: 'WIP' });
  });

  it('rejects an unknown state instead of parking it in limbo (GAP-5)', () => {
    // `state` used to be z.string().max(40), so a typo was accepted and landed the
    // row in a non-dispatchable state no queue would ever offer again.
    rejects({ id: 'WI-1', state: 'donee' });
    rejects({ items: [{ id: 'WI-1', state: 'complete' }] });
  });
});

/**
 * P-017 (b) gate #2 / D-016 / D-050 — a terminal close must DECLARE the assumptions it
 * rests on, or say "none" explicitly.
 *
 * Isolated from the evidence block above by construction: every payload here carries a
 * satisfied `completionRef`, so each assertion can only be about `assumptions`. If the
 * two gates shared fixtures, either could be deleted without a test going red.
 */
describe('terminal writes structurally require an assumption declaration (P-017 b#2)', () => {
  // A DISCRIMINATED union, not `{ success: boolean }`: the message-shape test below
  // reads `r.error.issues` on the failure branch, and a plain boolean cannot narrow
  // — it yields both "Property 'error' does not exist" and an implicitly-any `i` in
  // the `.map`. Modelling only the two fields these tests actually touch keeps the
  // cast honest about what it is asserting.
  const parse = (args: unknown) =>
    (
      tool.args as {
        safeParse: (
          v: unknown,
        ) => { success: true } | { success: false; error: { issues: { message: string }[] } };
      }
    ).safeParse(args);
  const REF = 'landed in abc123';

  it('rejects a terminal write with evidence but NO assumption declaration, in all three shapes', () => {
    // Fixing only itemSpec would MOVE the bypass to the shorthand rather than close it —
    // and the shorthand is the cheaper call, so it would carry all the traffic.
    expect(parse({ id: 'WI-1', state: 'done', completionRef: REF }).success).toBe(false);
    expect(parse({ ids: ['WI-1', 'WI-2'], state: 'dropped', completionRef: REF }).success).toBe(false);
    expect(parse({ items: [{ id: 'WI-1', state: 'done', completionRef: REF }] }).success).toBe(false);
  });

  it('accepts the explicit "none" — saying nothing-recorded is a valid answer', () => {
    expect(parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' }).success).toBe(true);
    expect(
      parse({ items: [{ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' }] }).success,
    ).toBe(true);
  });

  it('accepts the server-stamped assumptions object on a read→retry', () => {
    expect(
      parse({
        id: 'WI-1',
        state: 'done',
        completionRef: REF,
        assumptions: {
          declared: 'none',
          resolvedAt: '2026-09-05T21:00:00.000Z',
        },
      }).success,
    ).toBe(true);
  });

  it('accepts one or more facts:assert keys', () => {
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: ['gate-red-is-flake'] }).success,
    ).toBe(true);
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: ['a-key', 'b-key'] }).success,
    ).toBe(true);
  });

  it('rejects the shapes that would let the field die — empty array, empty string, wrong type', () => {
    const bad: unknown[] = [[], [''], ['   '], '', 'None', true, 0, null, {}];
    for (const assumptions of bad) {
      expect(
        parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions }).success,
        `assumptions: ${JSON.stringify(assumptions)} must be refused`,
      ).toBe(false);
    }
  });

  /**
   * EI-18812234312014879. Rejecting the wrong shape (above) is only half the job —
   * the refusal has to say what the right one IS. Both refusals described the VALUE
   * ("the key(s) ... or the literal \"none\"") without the CONTAINER, so a caller with
   * exactly one key passed a bare string and got back zod's default `Invalid input`:
   * no expected type, no example. Hit live while closing a work item; cost two calls.
   */
  it('names the ARRAY shape when the value is malformed, not a bare "Invalid input"', () => {
    const r = parse({ id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'my-fact-key' });
    expect(r.success, 'a bare key string is still (correctly) refused').toBe(false);

    const message = r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
    expect(message, "must not be zod's contentless default").not.toMatch(/^Invalid input$/);
    expect(message, 'must show the brackets, which is the whole point').toContain('["my-fact-key"]');
    expect(message, 'must still offer the "none" escape hatch').toContain('none');
  });

  it('leaves NON-terminal writes alone — no declaration required', () => {
    for (const state of ['wip', 'blocked', 'needs-human', 'open', 'todo']) {
      expect(parse({ id: 'WI-1', state }).success, state).toBe(true);
    }
  });

  it('enforces the rule on LEGACY terminal spellings and case drift, not just done/dropped', () => {
    for (const state of ['passed', 'resolved', 'closed', 'deprecated', 'DONE']) {
      expect(parse({ id: 'WI-1', state, completionRef: REF }).success, state).toBe(false);
      expect(
        parse({ id: 'WI-1', state, completionRef: REF, assumptions: 'none' }).success,
        `${state} + assumptions`,
      ).toBe(true);
    }
  });

  it('a mixed items[] batch refuses as a whole when ONE item omits the declaration', () => {
    expect(
      parse({
        items: [
          { id: 'WI-1', state: 'done', completionRef: REF, assumptions: 'none' },
          { id: 'WI-2', state: 'done', completionRef: REF },
        ],
      }).success,
    ).toBe(false);
  });
});

/**
 * EI-19961538712475843 — `reason` / `note` are accepted as aliases for `completionRef`
 * on a TERMINAL write, and REFUSED on a non-terminal one.
 *
 * Measured 2026-09-05 over harness_shared.tool_invocations (7d): 84 rejections from 52
 * distinct agents, 59 of them a bare `Unrecognized key` — 53 naming `reason`, 6 naming
 * `note`. `reason` is this verb's own family convention (work_items:park, :release,
 * :hold_open, :rehome, :request_release, :claim … all declare it), so set_state was the
 * outlier, not the callers.
 *
 * The asymmetry is the point and is asserted in both directions: a terminal write can
 * store the value (`terminal_completion_ref`), a non-terminal one cannot — so accepting
 * the alias there would report success and discard the value, which is the silent-drop
 * bug `_body-alias.ts` exists to prevent rather than a fix for it.
 */
describe('work_items:set_state — reason/note alias for completionRef (EI-19961538712475843)', () => {
  type Parsed = {
    success: boolean;
    error?: { issues: ReadonlyArray<{ message: string }> };
  };
  const parse = (args: unknown): Parsed =>
    (tool.args as { safeParse: (v: unknown) => Parsed }).safeParse(args);
  const messages = (args: unknown): string =>
    (parse(args).error?.issues ?? []).map((i) => i.message).join(' | ');
  const EVIDENCE = 'superseded by WI-2 — shipped in abc123';

  it('publishes terminal aliases only on terminal state variants', () => {
    type SchemaNode = Record<string, unknown>;
    const schema = tool.args.toJSONSchema() as SchemaNode;
    const nodes: SchemaNode[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const node = value as SchemaNode;
      nodes.push(node);
      Object.values(node).forEach(visit);
    };
    const includesEnumValue = (value: unknown, wanted: string): boolean => {
      if (Array.isArray(value)) return value.includes(wanted) || value.some((entry) => includesEnumValue(entry, wanted));
      if (typeof value !== 'object' || value === null) return false;
      const node = value as SchemaNode;
      return (
        (Array.isArray(node.enum) && node.enum.includes(wanted)) ||
        Object.values(node).some((entry) => includesEnumValue(entry, wanted))
      );
    };
    visit(schema);

    const blockedVariants = nodes.filter((node) => {
      const properties = node.properties as Record<string, unknown> | undefined;
      return properties?.state !== undefined && includesEnumValue(properties.state, 'blocked');
    });
    expect(blockedVariants.length).toBeGreaterThan(0);
    for (const node of blockedVariants) {
      const properties = node.properties as Record<string, unknown>;
      expect(properties).not.toHaveProperty('reason');
      expect(properties).not.toHaveProperty('note');
      expect(properties).not.toHaveProperty('completionRef');
    }

    const terminalAliasVariant = nodes.some((node) => {
      const properties = node.properties as Record<string, unknown> | undefined;
      return Boolean(properties?.reason && properties.state && !includesEnumValue(properties.state, 'blocked'));
    });
    expect(terminalAliasVariant).toBe(true);
  });

  // ── the fix: the spelling the rest of the family taught now works ──────────────
  it('ACCEPTS `reason` in place of completionRef on a terminal write', () => {
    expect(parse({ id: 'WI-1', state: 'done', reason: EVIDENCE, assumptions: 'none' }).success).toBe(true);
  });

  it('ACCEPTS `note` in place of completionRef on a terminal write', () => {
    expect(parse({ id: 'WI-1', state: 'dropped', note: EVIDENCE, assumptions: 'none' }).success).toBe(true);
  });

  it('ACCEPTS the alias inside an items[] terminal arm', () => {
    expect(
      parse({ items: [{ id: 'WI-1', state: 'done', reason: EVIDENCE, assumptions: 'none' }] }).success,
    ).toBe(true);
  });

  // ── CALIBRATION: the guard the alias relaxes must still bite, or these tests
  //    would pass just as well against a schema that accepts anything ────────────
  it('still REFUSES a terminal write carrying no evidence under ANY spelling', () => {
    expect(parse({ id: 'WI-1', state: 'done', assumptions: 'none' }).success).toBe(false);
    expect(parse({ items: [{ id: 'WI-1', state: 'done', assumptions: 'none' }] }).success).toBe(false);
  });

  it('still REFUSES a terminal write missing the assumption declaration', () => {
    expect(parse({ id: 'WI-1', state: 'done', reason: EVIDENCE }).success).toBe(false);
  });

  it('still REFUSES a genuinely unknown key', () => {
    expect(parse({ id: 'WI-1', state: 'done', reson: EVIDENCE, assumptions: 'none' }).success).toBe(false);
  });

  // ── blocked: still refused, because its reason must be a TYPED blocker ─────────
  it('names work_items:set_blocker when a `blocked` write carries a reason', () => {
    expect(parse({ id: 'WI-1', state: 'blocked', reason: EVIDENCE }).success).toBe(false);
    expect(messages({ id: 'WI-1', state: 'blocked', reason: EVIDENCE })).toContain('work_items:set_blocker');
    expect(parse({ items: [{ id: 'WI-1', state: 'blocked', note: EVIDENCE }] }).success).toBe(false);
  });

  it('does not blame `reason` when a progress write fails for an unrelated cause', () => {
    // CALIBRATION for the narrowed refusal: an unknown key beside an accepted `reason`
    // must not be reported as the old "reason is refused here" message.
    expect(parse({ id: 'WI-1', state: 'wip', reason: EVIDENCE, reson: 'x' }).success).toBe(false);
    expect(messages({ id: 'WI-1', state: 'wip', reason: EVIDENCE, reson: 'x' })).not.toContain('set_blocker');
  });

  // ── ambiguity is reported, never silently resolved (the _body-alias rule) ──────
  it('REFUSES completionRef + reason carrying DIFFERENT values', () => {
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: EVIDENCE, reason: 'something else', assumptions: 'none' })
        .success,
    ).toBe(false);
  });

  it('ACCEPTS completionRef + reason carrying the SAME value', () => {
    expect(
      parse({ id: 'WI-1', state: 'done', completionRef: EVIDENCE, reason: EVIDENCE, assumptions: 'none' }).success,
    ).toBe(true);
  });

  it('REFUSES reason + note carrying DIFFERENT values', () => {
    expect(
      parse({ id: 'WI-1', state: 'done', reason: EVIDENCE, note: 'something else', assumptions: 'none' }).success,
    ).toBe(false);
  });

  // ── load-bearing: the aliased value REACHES the write. Without this the schema
  //    could accept `reason` and the handler still persist undefined — an accepted
  //    argument that vanishes, i.e. the exact bug, dressed as the fix ─────────────
  it('passes the aliased value through to the write as completionRef', async () => {
    await body({ id: 'WI-1', state: 'done', reason: EVIDENCE, assumptions: 'none' });
    expect(setM).toHaveBeenCalledWith('WI-1', 'done', expect.objectContaining({ completionRef: EVIDENCE }));
  });

  it('passes the aliased value through for every id in ids[]', async () => {
    await body({ ids: ['WI-1', 'WI-2'], state: 'done', note: EVIDENCE, assumptions: 'none' });
    expect(setM).toHaveBeenCalledWith('WI-2', 'done', expect.objectContaining({ completionRef: EVIDENCE }));
  });

  it('prefers an explicit completionRef over the alias when both agree', async () => {
    await body({ id: 'WI-1', state: 'done', completionRef: EVIDENCE, reason: EVIDENCE, assumptions: 'none' });
    expect(setM).toHaveBeenCalledWith('WI-1', 'done', expect.objectContaining({ completionRef: EVIDENCE }));
  });
});

/**
 * EI-24917736184136483 — a `reason` / `note` on an open / wip / needs-human write is
 * RECORDED as a comment on the item instead of being refused.
 *
 * Measured 2026-10-05 over harness_shared.tool_invocations (7d): ~110 of this verb's
 * schema rejections were this shape (75 of them `state:"wip"` + `reason`, 39 agents).
 * The old refusal existed because the state row has no reason column; the comment
 * thread is where the value persists, so the write now lands it there.
 *
 * Asserted in both directions: the reason REACHES a comment, and it never reaches
 * `completionRef` (which the writer ignores on a non-terminal branch — a silent drop).
 */
describe('work_items:set_state — non-terminal reason is recorded as a comment (EI-24917736184136483)', () => {
  type Parsed = { success: boolean; error?: { issues: ReadonlyArray<{ message: string }> } };
  const parse = (args: unknown): Parsed =>
    (tool.args as { safeParse: (v: unknown) => Parsed }).safeParse(args);
  const commentM = vi.mocked(commentWorkItem);
  const REASON = 'picked up after WI-2 landed; starting on the schema half';

  beforeEach(() => {
    setM.mockReset();
    commentM.mockReset();
    setM.mockImplementation(async (id, state) => noAlias(id, state));
    commentM.mockResolvedValue({ id: 4242, thread_id: 't', author_id: 'me', body: '', created_ts: '' });
  });

  it('ACCEPTS `reason` / `note` on wip, open and needs-human (inline, ids[] and items[])', () => {
    expect(parse({ id: 'WI-1', state: 'wip', reason: REASON }).success).toBe(true);
    expect(parse({ id: 'WI-1', state: 'open', note: REASON }).success).toBe(true);
    expect(parse({ id: 'WI-1', state: 'needs-human', reason: REASON }).success).toBe(true);
    expect(parse({ ids: ['WI-1', 'WI-2'], state: 'in_progress', reason: REASON }).success).toBe(true);
    expect(parse({ items: [{ id: 'WI-1', state: 'wip', reason: REASON }] }).success).toBe(true);
  });

  it('records the reason as a comment on the item and reports where it went', async () => {
    const out = await body({ id: 'WI-1', state: 'wip', reason: REASON });
    expect(commentM).toHaveBeenCalledTimes(1);
    expect(commentM).toHaveBeenCalledWith('WI-1', expect.stringContaining(REASON), 'me', expect.any(Object));
    expect(out.results[0]).toMatchObject({ ok: true, transitionNoteRecorded: { as: 'comment', postId: 4242 } });
  });

  it('never routes a non-terminal reason into completionRef', async () => {
    await body({ id: 'WI-1', state: 'wip', reason: REASON });
    expect(setM).toHaveBeenCalledWith('WI-1', 'wip', expect.objectContaining({ completionRef: undefined }));
  });

  it('records one comment per id in ids[] and per row in items[]', async () => {
    await body({ ids: ['WI-1', 'WI-2'], state: 'wip', note: REASON });
    await body({ items: [{ id: 'WI-3', state: 'open', reason: REASON }, { id: 'WI-4', state: 'wip' }] });
    expect(commentM.mock.calls.map((c) => c[0])).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });

  it('applies a batch-level reason to each eligible items[] row', async () => {
    await body({
      reason: REASON,
      items: [{ id: 'WI-5', state: 'wip' }, { id: 'WI-6', state: 'open' }],
    });

    expect(commentM.mock.calls.map((call) => call[0])).toEqual(['WI-5', 'WI-6']);
    expect(commentM.mock.calls.every((call) => String(call[1]).includes(REASON))).toBe(true);
  });

  it('routes a batch-level reason by each row state in a mixed batch', async () => {
    await body({
      reason: REASON,
      items: [
        { id: 'WI-9', state: 'done', assumptions: 'none' },
        { id: 'WI-10', state: 'wip' },
      ],
    });

    expect(setM).toHaveBeenCalledWith('WI-9', 'done', expect.objectContaining({ completionRef: REASON }));
    expect(commentM).toHaveBeenCalledWith('WI-10', expect.stringContaining(REASON), 'me', expect.any(Object));
  });

  it('refuses a batch-level reason for blocked rows with typed-blocker guidance', () => {
    const result = parse({ reason: REASON, items: [{ id: 'WI-7', state: 'blocked' }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' | ')).toContain('work_items:set_blocker');

    const schema = z.toJSONSchema(tool.args as never);
    const advertised = JSON.stringify(schema);
    expect(advertised).toContain('x-papercusp-call-constraint');
    expect(advertised).toContain('a batch-level `reason` or `note` applies to every row');
    expect(advertised).toContain('forbidden when any row state is `blocked`');
  });

  it('refuses conflicting batch and per-row reason values', () => {
    expect(
      parse({ reason: REASON, items: [{ id: 'WI-8', state: 'wip', reason: 'different explanation' }] }).success,
    ).toBe(false);
  });

  it('posts no comment when no reason was given', async () => {
    await body({ id: 'WI-1', state: 'wip' });
    expect(commentM).not.toHaveBeenCalled();
  });

  it('posts no comment when the state write did not land (no orphan comment)', async () => {
    setM.mockResolvedValueOnce({ workItem: null, aliased: false, requestedState: 'wip', expectedState: 'wip', appliedState: null });
    const out = await body({ id: 'WI-404', state: 'wip', reason: REASON });
    expect(commentM).not.toHaveBeenCalled();
    expect(out.results[0].ok).toBe(false);
  });

  it('reports a failed comment loudly instead of dropping the reason', async () => {
    commentM.mockRejectedValueOnce(new Error('thread store down'));
    const out = await body({ id: 'WI-1', state: 'wip', reason: REASON });
    expect(out.results[0].ok).toBe(true);
    expect(out.results[0].transitionNoteWarning).toContain('NOT recorded');
    expect(out.results[0].transitionNoteWarning).toContain(REASON);
  });

  it('still REFUSES reason + note carrying DIFFERENT values on a progress write', () => {
    expect(parse({ id: 'WI-1', state: 'wip', reason: REASON, note: 'something else' }).success).toBe(false);
  });

  it('still REFUSES completionRef on a non-terminal write', () => {
    expect(parse({ id: 'WI-1', state: 'wip', completionRef: REASON }).success).toBe(false);
  });
});
