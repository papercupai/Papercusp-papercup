/**
 * condition-bridge-assignment.test.ts — gate-repair-plane-on-current-build-2026-10-15
 * P-004 (BAR R-4; clauses SPEC-P-004-OWNED / SPEC-P-004-UNOWNED).
 *
 * Alarm-minted gate and repair-queue work-items are assigned AT CREATION to the live
 * holder of `gate.greenCheckpoint.ownership`. With no live holder they land unassigned
 * and the item's own summary says why.
 *
 * Three layers, so a regression is caught where it originates:
 *   1. the pure decision (`decideConditionAssignment`) over owned / unowned / stale /
 *      stalled / unmeasured / unreadable ownership;
 *   2. the catalog policy (including current-run frozen-repair legs);
 *   3. the mint itself — `acquireConditionOwner` with every store faked — asserting what
 *      actually reaches `createWorkItem` (assignee, assignedBy, summary).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellOwnership } from './gate-ownership';

const h = vi.hoisted(() => ({
  createWorkItem: vi.fn(),
  setWorkItemState: vi.fn(),
  findConditionObject: vi.fn(),
  linkWorkItemToCondition: vi.fn(),
  resolveWorkItemPot: vi.fn(),
  holderRows: [] as { feature_id: string }[],
  incumbentRows: [] as { taken_by: string | null }[],
  claimWorkItem: vi.fn(),
  claimWins: true,
}));

vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (/SET condition_key = NULL/.test(text)) return Promise.resolve([]);
      if (/SELECT taken_by/.test(text)) return Promise.resolve(h.incumbentRows);
      if (/SELECT feature_id/.test(text)) return Promise.resolve(h.holderRows);
      if (/SET condition_key =/.test(text)) {
        return Promise.resolve(h.claimWins ? [{ feature_id: String(values[1]) }] : []);
      }
      throw new Error(`unexpected SQL in condition-bridge-assignment.test: ${text.slice(0, 120)}`);
    },
  }),
}));
vi.mock('../work-items', () => ({
  claimWorkItem: h.claimWorkItem,
  createWorkItem: h.createWorkItem,
  setWorkItemState: h.setWorkItemState,
}));
vi.mock('./condition-object', () => ({
  findConditionObject: h.findConditionObject,
  linkWorkItemToCondition: h.linkWorkItemToCondition,
}));
vi.mock('../pot-membership', () => ({ resolveWorkItemPot: h.resolveWorkItemPot }));

import {
  ACTIONABLE_CONDITIONS,
  CONDITION_BRIDGE_ACTOR,
  acquireConditionOwner,
  decideConditionAssignment,
  type GateOwnerObservation,
} from './condition-bridge';
import {
  FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
  FROZEN_REPAIR_LEG_CONDITION_PREFIX,
} from './actionable-conditions';

/** A full ownership cell. Defaults describe a positively-live held claim. */
function ownership(over: Partial<CellOwnership> = {}): CellOwnership {
  return {
    assessment: 'held-live',
    eventKey: 'gate-red-streak:papercusp',
    workItem: 'WI-GATE',
    claimState: 'held',
    unknown: null,
    takenBy: 'su-gate-owner',
    takenAt: '2026-10-27T02:00:00.000Z',
    lastProgressAt: '2026-10-27T02:30:00.000Z',
    expiresAt: '2026-10-27T03:30:00.000Z',
    holderSessionState: 'live',
    duplicates: [],
    thread: {} as CellOwnership['thread'],
    ...over,
  };
}

const live = (over: Partial<CellOwnership> = {}): GateOwnerObservation => ({
  ok: true,
  ownership: ownership(over),
  heldByLiveHolder: true,
});
const notLive = (over: Partial<CellOwnership> = {}): GateOwnerObservation => ({
  ok: true,
  ownership: ownership(over),
  heldByLiveHolder: false,
});

describe('decideConditionAssignment (pure)', () => {
  it('owned: assigns to the live gate owner', () => {
    expect(decideConditionAssignment('live-gate-owner', live())).toEqual({
      assignee: 'su-gate-owner',
      reason: null,
    });
  });

  it('unowned: leaves it unassigned and names the unowned condition', () => {
    const d = decideConditionAssignment(
      'live-gate-owner',
      notLive({ claimState: 'no-object', assessment: 'unowned', takenBy: null, holderSessionState: null }),
    );
    expect(d?.assignee).toBeNull();
    expect(d?.reason).toMatch(/no live owner/);
    expect(d?.reason).toContain('gate-red-streak:papercusp');
  });

  it('stale owner: a held claim by an ended session is NOT assigned, and the holder is named', () => {
    const d = decideConditionAssignment(
      'live-gate-owner',
      notLive({ assessment: 'held-by-ended-session', holderSessionState: 'ended', takenBy: 'su-dead' }),
    );
    expect(d?.assignee).toBeNull();
    expect(d?.reason).toContain('su-dead');
    expect(d?.reason).toMatch(/not a live owner/);
    expect(d?.reason).toContain('ended');
  });

  it('stalled owner: a live session that stopped progressing is NOT assigned', () => {
    const d = decideConditionAssignment(
      'live-gate-owner',
      notLive({ assessment: 'held-stalled', holderSessionState: 'live', takenBy: 'su-wedged' }),
    );
    expect(d?.assignee).toBeNull();
    expect(d?.reason).toContain('held-stalled');
  });

  it('never assigns on liveness alone without a recorded holder', () => {
    const d = decideConditionAssignment('live-gate-owner', live({ takenBy: null }));
    expect(d?.assignee).toBeNull();
  });

  it('unmeasured ownership is reported as unmeasured, not as "no owner"', () => {
    const d = decideConditionAssignment(
      'live-gate-owner',
      notLive({ claimState: null, assessment: null, takenBy: null, unknown: { code: 'resolver-failed', detail: 'store down' } }),
    );
    expect(d?.assignee).toBeNull();
    expect(d?.reason).toMatch(/unmeasured/);
    expect(d?.reason).toContain('resolver-failed: store down');
  });

  it('a failed ownership read is its own stated reason', () => {
    const d = decideConditionAssignment('live-gate-owner', { ok: false, error: 'boom' });
    expect(d).toEqual({ assignee: null, reason: expect.stringContaining('could not be read (boom)') });
  });

  it('no policy: returns null — nothing to assign and nothing to explain', () => {
    expect(decideConditionAssignment(undefined, live())).toBeNull();
  });
});

describe('catalog assignment policy', () => {
  const policyOf = (prefix: string) => ACTIONABLE_CONDITIONS.find((c) => c.prefix === prefix)?.assignTo;

  it('every gate and repair-queue alarm prefix is assigned to the live gate owner', () => {
    for (const prefix of [
      'green-stall:',
      'gate-red-streak:',
      'green-checkpoint-lost-run:',
      'green-checkpoint-run-progress:',
      'main-behind-staging:',
      FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
      FROZEN_REPAIR_LEG_CONDITION_PREFIX,
    ]) {
      expect(policyOf(prefix), prefix).toBe('live-gate-owner');
    }
  });

  it('no gate-family catalog entry can ship without an assignment policy (falsifier for a new prefix)', () => {
    const gateFamily = /^(green-|gate-|main-behind-)/;
    const missing = ACTIONABLE_CONDITIONS.filter(
      (c) =>
        (gateFamily.test(c.prefix) || c.prefix.startsWith('frozen-repair-')) &&
        c.assignTo !== 'live-gate-owner',
    ).map((c) => c.prefix);
    expect(missing).toEqual([]);
  });

  it('non-gate conditions declare no assignment policy', () => {
    expect(policyOf('single-primary:')).toBeUndefined();
    expect(policyOf('degraded:')).toBeUndefined();
  });
});

describe('acquireConditionOwner assigns the mint at creation (P-004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.holderRows = [];
    h.claimWins = true;
    h.resolveWorkItemPot.mockImplementation(async ({ rawSlug }: { rawSlug: string }) => rawSlug);
    h.findConditionObject.mockResolvedValue({ workItem: null });
    h.linkWorkItemToCondition.mockResolvedValue(undefined);
    h.createWorkItem.mockImplementation(async () => ({ id: 'WI-MINTED' }));
  });

  const spec = {
    title: 'gate red streak on papercusp',
    summary: 'Three consecutive red verdicts.',
    harness: 'papercusp',
    workspaceId: 'papercusp-workspace',
  };

  it('owned: the created row carries the live gate owner as assignee', async () => {
    const readGateOwner = vi.fn(async () => live());
    const r = await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner });

    expect(readGateOwner).toHaveBeenCalledWith('papercusp');
    expect(h.createWorkItem).toHaveBeenCalledTimes(1);
    const input = h.createWorkItem.mock.calls[0][0];
    expect(input.assignee).toBe('su-gate-owner');
    expect(input.assignedBy).toBe(CONDITION_BRIDGE_ACTOR);
    expect(input.summary).toBe('Three consecutive red verdicts.');
    expect(r).toMatchObject({ workItem: 'WI-MINTED', created: true, assignedTo: 'su-gate-owner' });
    expect(r.unassignedReason).toBeUndefined();
  });

  it.each(['packages/a/x.test.ts', 'lint:tsc'])(
    'assigns the current-run repair leg %s to the live gate owner (EI-27206037186017447)',
    async (entry) => {
      const readGateOwner = vi.fn(async () => live());
      const r = await acquireConditionOwner(
        `${FROZEN_REPAIR_LEG_CONDITION_PREFIX}papercusp:${entry}`, spec, { readGateOwner },
      );
      expect(readGateOwner).toHaveBeenCalledWith('papercusp');
      expect(h.createWorkItem.mock.calls[0][0]).toMatchObject({
        assignee: 'su-gate-owner', assignedBy: CONDITION_BRIDGE_ACTOR,
      });
      expect(r).toMatchObject({ created: true, assignedTo: 'su-gate-owner' });
    },
  );

  it('unowned: the created row is unassigned and its summary states why', async () => {
    const readGateOwner = vi.fn(async () =>
      notLive({ claimState: 'no-object', assessment: 'unowned', takenBy: null, holderSessionState: null }),
    );
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner });

    const input = h.createWorkItem.mock.calls[0][0];
    expect(input.assignee).toBeUndefined();
    expect(input.assignedBy).toBeUndefined();
    expect(input.summary).toMatch(/^Three consecutive red verdicts\.\n\nAssignment: Left unassigned: the gate has no live owner/);
    expect(r.assignedTo).toBeUndefined();
    expect(r.unassignedReason).toMatch(/no live owner/);
  });

  it('stale owner: an ended holder is not assigned; the summary names them', async () => {
    const readGateOwner = vi.fn(async () =>
      notLive({ assessment: 'held-by-ended-session', holderSessionState: 'ended', takenBy: 'su-dead' }),
    );
    await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner });

    const input = h.createWorkItem.mock.calls[0][0];
    expect(input.assignee).toBeUndefined();
    expect(input.summary).toContain('su-dead');
  });

  it('a failed ownership read still mints, unassigned, with the failure stated', async () => {
    const readGateOwner = vi.fn(async (): Promise<GateOwnerObservation> => ({ ok: false, error: 'pg down' }));
    const r = await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner });

    expect(r.created).toBe(true);
    const input = h.createWorkItem.mock.calls[0][0];
    expect(input.assignee).toBeUndefined();
    expect(input.summary).toContain('could not be read (pg down)');
  });

  it('a condition with no policy never reads gate ownership and mints unassigned, summary untouched', async () => {
    const readGateOwner = vi.fn(async () => live());
    await acquireConditionOwner('single-primary:no-primary', spec, { readGateOwner });

    expect(readGateOwner).not.toHaveBeenCalled();
    const input = h.createWorkItem.mock.calls[0][0];
    expect(input.assignee).toBeUndefined();
    expect(input.summary).toBe('Three consecutive red verdicts.');
  });

  it('adopting an ASSIGNED incumbent reads no ownership and writes nothing', async () => {
    h.holderRows = [{ feature_id: 'WI-INCUMBENT' }];
    h.incumbentRows = [{ taken_by: 'su-already-on-it' }];
    const readGateOwner = vi.fn(async () => live());
    const r = await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner });

    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false });
    expect(r.assignedTo).toBeUndefined();
    expect(readGateOwner).not.toHaveBeenCalled();
    expect(h.claimWorkItem).not.toHaveBeenCalled();
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });
});

describe('acquireConditionOwner re-offers an unassigned incumbent on re-fire (plan D-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.holderRows = [{ feature_id: 'WI-INCUMBENT' }];
    h.incumbentRows = [{ taken_by: null }];
    h.claimWins = true;
    h.resolveWorkItemPot.mockImplementation(async ({ rawSlug }: { rawSlug: string }) => rawSlug);
    h.findConditionObject.mockResolvedValue({ workItem: null });
    h.claimWorkItem.mockImplementation(async (id: string) => ({ id }));
  });

  const spec = { title: 'green stall on papercusp', harness: 'papercusp', workspaceId: 'papercusp-workspace' };

  it('fired unowned, owner claimed the gate since: the re-fire hands the incumbent to that owner', async () => {
    const readGateOwner = vi.fn(async () => live());
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner });

    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false, assignedTo: 'su-gate-owner' });
    expect(readGateOwner).toHaveBeenCalledWith('papercusp');
    expect(h.claimWorkItem).toHaveBeenCalledWith('WI-INCUMBENT', 'su-gate-owner', {
      harness: 'papercusp',
      assignedBy: CONDITION_BRIDGE_ACTOR,
    });
    expect(h.createWorkItem).not.toHaveBeenCalled();
  });

  it('an empty-string holder counts as unheld, like the claim CAS does', async () => {
    h.incumbentRows = [{ taken_by: '' }];
    const r = await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner: async () => live() });
    expect(r.assignedTo).toBe('su-gate-owner');
  });

  it('still unowned at re-fire: nothing is claimed and the incumbent is returned unchanged', async () => {
    const readGateOwner = vi.fn(async () => notLive({ claimState: 'no-object', assessment: 'unowned', takenBy: null, holderSessionState: null }));
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner });

    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false });
    expect(r.assignedTo).toBeUndefined();
    expect(h.claimWorkItem).not.toHaveBeenCalled();
  });

  it('a stale holder at re-fire is not handed the item', async () => {
    const readGateOwner = vi.fn(async () => notLive({ assessment: 'held-by-ended-session', holderSessionState: 'ended', takenBy: 'su-dead' }));
    const r = await acquireConditionOwner('gate-red-streak:papercusp', spec, { readGateOwner });
    expect(r.assignedTo).toBeUndefined();
    expect(h.claimWorkItem).not.toHaveBeenCalled();
  });

  it('a peer claimed it between the read and the write: the CAS refuses and no assignee is reported', async () => {
    h.claimWorkItem.mockResolvedValue(null);
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner: async () => live() });
    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false });
    expect(r.assignedTo).toBeUndefined();
  });

  it('a failed claim never breaks adoption', async () => {
    h.claimWorkItem.mockRejectedValue(new Error('pg down'));
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner: async () => live() });
    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false });
    expect(r.assignedTo).toBeUndefined();
  });

  it('a link-only incumbent (no key on the row) gets the same re-offer', async () => {
    h.holderRows = [];
    h.findConditionObject.mockResolvedValue({ workItem: 'WI-LINKED' });
    const r = await acquireConditionOwner('green-stall:papercusp', spec, { readGateOwner: async () => live() });
    expect(r).toMatchObject({ workItem: 'WI-LINKED', created: false, assignedTo: 'su-gate-owner' });
  });

  it('a condition with no policy never reads the incumbent row or gate ownership', async () => {
    const readGateOwner = vi.fn(async () => live());
    h.incumbentRows = [];
    const r = await acquireConditionOwner('single-primary:no-primary', spec, { readGateOwner });
    expect(r).toMatchObject({ workItem: 'WI-INCUMBENT', created: false });
    expect(readGateOwner).not.toHaveBeenCalled();
    expect(h.claimWorkItem).not.toHaveBeenCalled();
  });
});
