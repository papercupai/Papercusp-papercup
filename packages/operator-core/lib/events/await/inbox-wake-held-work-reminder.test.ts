import { describe, expect, it, vi } from 'vitest';
import {
  INBOX_WAKE_HELD_WORK_LISTED_CAP,
  inboxWakeHeldWorkReminderText,
  prepareInboxWakeHeldWorkReminder,
  tenantFromDeliveryWorkspace,
} from './inbox-wake-held-work-reminder';
import type { HeldWorkItem } from './wake-source-predicate';

const item = (id: string): HeldWorkItem => ({ id, harness: 'papercusp', status: 'wip', eventBlockers: [] });

describe('inboxWakeHeldWorkReminderText (WI-6554700010018536)', () => {
  it('is empty when the recipient holds nothing, whatever its mode', () => {
    expect(inboxWakeHeldWorkReminderText({ held: [], autonomyModes: ['auto'], loopActive: false })).toBe('');
  });

  it('labels held items as a snapshot and requires a live recheck before acting', () => {
    const t = inboxWakeHeldWorkReminderText({ held: [item('WI-1'), item('WI-2')], autonomyModes: [], loopActive: null });
    expect(t).toContain('work list snapshot): a recent read found 2 unfinished work-item(s) [WI-1, WI-2]');
    expect(t).toContain("recheck each item's current state and assignee with work_items:get");
    expect(t).toContain('does not finish any still-open items');
    expect(t).not.toContain('you still hold');
    // No autonomy mode ⇒ no claim about wakes.
    expect(t).not.toContain('nothing will wake you');
    expect(t).not.toContain('\n');
  });

  it('adds the no-wake sentence only for an autonomy mode with no loop armed', () => {
    const held = [item('WI-1')];
    const noLoop = inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: false });
    expect(noLoop).toContain('You are in auto mode with no loop armed, so nothing will wake you after this turn');
    expect(noLoop).toContain('loop:arm');
    expect(noLoop).toContain('work_items:release');

    expect(inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: true })).not.toContain(
      'nothing will wake you',
    );
    // Unknown loop state never claims "no loop".
    expect(inboxWakeHeldWorkReminderText({ held, autonomyModes: ['auto'], loopActive: null })).not.toContain(
      'nothing will wake you',
    );
  });

  it('caps the listed ids and summarises the rest', () => {
    const held = Array.from({ length: INBOX_WAKE_HELD_WORK_LISTED_CAP + 3 }, (_, i) => item(`WI-${i + 1}`));
    const t = inboxWakeHeldWorkReminderText({ held, autonomyModes: [], loopActive: null });
    expect(t).toContain(`a recent read found ${held.length} unfinished`);
    expect(t).toContain(`WI-${INBOX_WAKE_HELD_WORK_LISTED_CAP}, +3 more]`);
    expect(t).not.toContain(`WI-${INBOX_WAKE_HELD_WORK_LISTED_CAP + 1},`);
  });
});

describe('prepareInboxWakeHeldWorkReminder (WI-6554700010018536)', () => {
  const base = { ownerId: 'su-x', deliveryWorkspaceId: 'ws-1' };
  // Hermetic: every case stubs the tenant resolver, so none reaches Postgres.
  const withTenant = <T extends object>(deps: T) => ({
    resolveRecipientWorkspace: vi.fn(async () => 'ws-1'),
    ...deps,
  });

  it('reproduces the measured case: AUTO, two held items, no loop ⇒ both sentences', async () => {
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: withTenant({
        readHeldWorkItems: vi.fn(async () => [item('WI-A'), item('WI-B')]),
        getModes: vi.fn(async () => [{ mode: 'auto' }]),
        getLoopActive: vi.fn(async () => false),
      }),
    });
    expect(t).toContain('[WI-A, WI-B]');
    expect(t).toContain('nothing will wake you after this turn');
  });

  it('skips the mode and loop reads when nothing is held', async () => {
    const getModes = vi.fn(async () => [{ mode: 'auto' }]);
    const getLoopActive = vi.fn(async () => false);
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: withTenant({ readHeldWorkItems: vi.fn(async () => []), getModes, getLoopActive }),
    });
    expect(t).toBe('');
    expect(getModes).not.toHaveBeenCalled();
    expect(getLoopActive).not.toHaveBeenCalled();
  });

  it('drops a held item released after wake queueing but before delivery', async () => {
    let heldAtDelivery = [item('WI-RELEASED')];
    const readHeldWorkItems = vi.fn(async () => heldAtDelivery);
    const queuedWake = { ...base };

    // The wake is queued while the claim is held, then the owner checkpoints and releases it.
    heldAtDelivery = [];
    const t = await prepareInboxWakeHeldWorkReminder({
      ...queuedWake,
      deps: withTenant({ readHeldWorkItems }),
    });

    expect(readHeldWorkItems).toHaveBeenCalledTimes(1);
    expect(readHeldWorkItems).toHaveBeenCalledWith('su-x', 'ws-1');
    expect(t).toBe('');
    expect(t).not.toContain('WI-RELEASED');
  });

  it('ignores non-autonomy modes', async () => {
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: withTenant({
        readHeldWorkItems: vi.fn(async () => [item('WI-A')]),
        getModes: vi.fn(async () => [{ mode: 'ideate' }]),
        getLoopActive: vi.fn(async () => false),
      }),
    });
    expect(t).toContain('[WI-A]');
    expect(t).not.toContain('nothing will wake you');
  });

  it('a failed held-work read yields empty; a failed mode read keeps the held-work sentence', async () => {
    await expect(
      prepareInboxWakeHeldWorkReminder({
        ...base,
        deps: withTenant({ readHeldWorkItems: vi.fn(async () => Promise.reject(new Error('pg down'))) }),
      }),
    ).resolves.toBe('');

    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: withTenant({
        readHeldWorkItems: vi.fn(async () => [item('WI-A')]),
        getModes: vi.fn(async () => Promise.reject(new Error('modes down'))),
        getLoopActive: vi.fn(async () => false),
      }),
    });
    expect(t).toContain('[WI-A]');
    expect(t).not.toContain('nothing will wake you');
  });

  it('a held-work read slower than the budget yields empty instead of delaying the wake', async () => {
    const started = Date.now();
    const t = await prepareInboxWakeHeldWorkReminder({
      ...base,
      deps: withTenant({
        budgetMs: 20,
        readHeldWorkItems: vi.fn(() => new Promise<HeldWorkItem[]>(() => undefined)),
      }),
    });
    expect(t).toBe('');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('prepareInboxWakeHeldWorkReminder tenant resolution (WI-6554700010018671)', () => {
  // A real delivery row: event_wake_deliveries.workspace_id is the coordination namespace
  // 'default' for every wake (WI-3575), while the recipient's work lives under its tenant.
  const TENANT = 'papercusp-workspace';
  const realDelivery = { ownerId: 'su-held', deliveryWorkspaceId: 'default' };
  // Held work exists ONLY under the tenant — exactly what the live DB returned for delivery #927561.
  // A PLAIN function: each case wraps it in its own vi.fn, so call history never leaks between cases.
  const heldOnlyUnderTenant = async (_owner: string, ws: string): Promise<HeldWorkItem[]> =>
    ws === TENANT ? [item('WI-548')] : [];

  it("reads held work under the recipient's tenant, not the delivery's 'default' (the live regression)", async () => {
    const readHeldWorkItems = vi.fn(heldOnlyUnderTenant);
    const getModes = vi.fn(async (ws: string) => (ws === TENANT ? [{ mode: 'auto' }] : []));
    const t = await prepareInboxWakeHeldWorkReminder({
      ...realDelivery,
      deps: {
        resolveRecipientWorkspace: vi.fn(async () => TENANT),
        readHeldWorkItems,
        getModes,
        getLoopActive: vi.fn(async () => false),
      },
    });
    expect(readHeldWorkItems).toHaveBeenCalledWith('su-held', TENANT);
    expect(getModes).toHaveBeenCalledWith(TENANT, 'su-held');
    expect(t).toContain('[WI-548]');
    // The autonomy sentence depends on the tenant-keyed mode read too.
    expect(t).toContain('You are in auto mode with no loop armed');
  });

  it("never reads under the coordination namespace when the recipient's tenant is unknown", async () => {
    const readHeldWorkItems = vi.fn(heldOnlyUnderTenant);
    const t = await prepareInboxWakeHeldWorkReminder({
      ...realDelivery,
      deps: { resolveRecipientWorkspace: vi.fn(async () => null), readHeldWorkItems },
    });
    expect(t).toBe('');
    expect(readHeldWorkItems).not.toHaveBeenCalled();
  });

  it('falls back to a concrete non-coordination delivery workspace when the session lookup finds nothing', async () => {
    const readHeldWorkItems = vi.fn(heldOnlyUnderTenant);
    const t = await prepareInboxWakeHeldWorkReminder({
      ownerId: 'su-held',
      deliveryWorkspaceId: TENANT,
      deps: {
        resolveRecipientWorkspace: vi.fn(async () => Promise.reject(new Error('pg down'))),
        readHeldWorkItems,
        getModes: vi.fn(async () => []),
        getLoopActive: vi.fn(async () => null),
      },
    });
    expect(readHeldWorkItems).toHaveBeenCalledWith('su-held', TENANT);
    expect(t).toContain('[WI-548]');
  });

  it('a tenant lookup slower than the budget yields empty without reading held work', async () => {
    const readHeldWorkItems = vi.fn(heldOnlyUnderTenant);
    const t = await prepareInboxWakeHeldWorkReminder({
      ...realDelivery,
      deps: {
        budgetMs: 20,
        resolveRecipientWorkspace: vi.fn(() => new Promise<string | null>(() => undefined)),
        readHeldWorkItems,
      },
    });
    expect(t).toBe('');
    expect(readHeldWorkItems).not.toHaveBeenCalled();
  });

  it('tenantFromDeliveryWorkspace rejects the coordination namespace and non-identities', () => {
    expect(tenantFromDeliveryWorkspace('default')).toBeNull();
    expect(tenantFromDeliveryWorkspace('*')).toBeNull();
    expect(tenantFromDeliveryWorkspace('  ')).toBeNull();
    expect(tenantFromDeliveryWorkspace(null)).toBeNull();
    expect(tenantFromDeliveryWorkspace(TENANT)).toBe(TENANT);
  });
});
