/**
 * Task provenance falls back to the caller's held claim (EI-21548894457555139).
 *
 * `resolveBashTaskProvenance` derived `workItemId` from the goal ref alone, and a goal
 * ref is only SOMETIMES a work-item id: a fleet leader declares `fleet:<slug>` and a
 * plan-bound agent declares `<plan>#P-NNN`. Both landed in the task ledger unlinked, so
 * `processes:list` could not answer "which work-item is this process for?" even while
 * the agent was holding one.
 *
 * The fallback is deliberately narrow. A fabricated work-item association is WORSE than
 * an absent one — absent reads as "unknown", wrong reads as fact and misattributes both
 * the cost and the provenance of a run — so it fires only when the held claim is
 * unambiguous. These tests pin that boundary in both directions.
 */

import { describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../../task-manager/types';
import {
  BashProvenanceRefusal,
  resolveBashTaskProvenance,
  resolveCapabilityBashTaskProvenance,
} from './bash-task-provenance';

const OWNER = 'su-b5f45c90-be2b-4ad6-b9fc-a03353f6b3bb';

const heldItem = (id: string) => ({
  id,
  title: null,
  body: null,
  harness: 'papercusp',
  checkpoint: null,
});

function deps(over: {
  goalRef?: string | null;
  held?: Array<{ id: string }>;
  throws?: boolean;
}) {
  return {
    resolveIdentity: (() => ({ ownerId: OWNER })) as never,
    readStamp: (() => ({ goalRef: over.goalRef ?? null })) as never,
    resolveGoal: (async () => null) as never,
    readHeldWorkItems: (async () => {
      if (over.throws) throw new Error('pg down');
      return (over.held ?? []).map((h) => heldItem(h.id));
    }) as never,
  };
}

const CTX = { workspaceId: 'papercusp-workspace' } as never;

describe('nested API task lineage', () => {
  const parent = { taskId: 'parent123', workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp', launchedBy: OWNER, workItemId: 'WI-current',
    state: 'running', endedAt: null } as TaskRow;
  const options = { explicitWorkItemId: 'WI-current', explicitParentTaskId: 'parent123' };
  const resolveParent = (readParentTask: (id: string) => Promise<TaskRow | null>) =>
    resolveCapabilityBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ held: [{ id: 'WI-current' }] }), readParentTask,
    }, options);

  it('preserves the caller task across the API boundary', async () => {
    const read = vi.fn(async () => parent);
    expect(await resolveParent(read)).toMatchObject({ parentTaskId: 'parent123', workItemId: 'WI-current' });
    expect(read).toHaveBeenCalledWith('parent123');
  });

  it.each([
    { workspaceId: 'foreign' }, { harnessSlug: 'foreign' }, { launchedBy: 'peer' },
    { workItemId: 'WI-other' }, { state: 'exited' }, { endedAt: '2026-10-15T00:00:00Z' },
  ])('refuses a contradictory parent %j before launch', async (change) => {
    await expect(resolveParent(async () => ({ ...parent, ...change } as TaskRow)))
      .rejects.toMatchObject({ code: 'parent_task_invalid' });
  });

  it('refuses missing and unreadable parents instead of launching an independent root', async () => {
    await expect(resolveParent(async () => null)).rejects.toMatchObject({ code: 'parent_task_invalid' });
    await expect(resolveParent(async () => { throw new Error('unavailable'); }))
      .rejects.toMatchObject({ code: 'parent_task_invalid' });
  });
});

describe('bash task provenance — goal ref that IS a work-item id', () => {
  it('uses a work-item goal only when it is still held', async () => {
    const readHeld = vi.fn(async () => [heldItem('EI-21548894457555139')]);
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'EI-21548894457555139' }),
      readHeldWorkItems: readHeld as never,
    });
    expect(p.workItemId).toBe('EI-21548894457555139');
    expect(readHeld).toHaveBeenCalledTimes(1);
  });

  it('uses the sole live claim instead of an unheld stale work-item goal', async () => {
    const p = await resolveBashTaskProvenance(
      CTX,
      'papercusp',
      deps({ goalRef: 'WI-old', held: [{ id: 'WI-current' }] }),
    );
    expect(p.workItemId).toBe('WI-current');
  });

  it('does not attribute an unheld terminal goal when no live claim remains', async () => {
    const p = await resolveBashTaskProvenance(
      CTX,
      'papercusp',
      deps({ goalRef: 'WI-done', held: [] }),
    );
    expect(p.workItemId).toBeNull();
  });
});

describe('bash task provenance — goal ref that is NOT a work-item id', () => {
  it('falls back to the single held claim for a fleet-scoped goal', async () => {
    // The incident shape: a fleet leader whose goal ref names the fleet, not an item.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [{ id: 'EI-21548894457555139' }] }),
    });
    expect(p.workItemId).toBe('EI-21548894457555139');
  });

  it('falls back for a plan-item goal too, without disturbing planSlug', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'my-plan#P-003', held: [{ id: 'WI-1234' }] }),
    });
    expect(p.workItemId).toBe('WI-1234');
    expect(p.planSlug).toBe('my-plan');
  });
});

describe('bash task provenance — a caller-named work_item_id (WI-10004202)', () => {
  // The incident: an EVL mutation run for WI-10004188 was ledgered against WI-10003976
  // because that was the session's declared goal, and it counted in WI-10003976's
  // loop-gate window. Naming the item must beat the goal ref.
  it('wins over a goal ref that is itself a work-item id', async () => {
    const p = await resolveBashTaskProvenance(
      CTX,
      'papercusp',
      deps({ goalRef: 'WI-10003976', held: [{ id: 'WI-10003976' }, { id: 'WI-10004188' }] }),
      { explicitWorkItemId: 'WI-10004188' },
    );
    expect(p.workItemId).toBe('WI-10004188');
    expect(p.goalRef).toBe('WI-10003976');
  });

  it('refuses an item the caller does not hold', async () => {
    await expect(
      resolveBashTaskProvenance(CTX, 'papercusp', deps({ goalRef: 'WI-1', held: [{ id: 'WI-1' }] }), {
        explicitWorkItemId: 'WI-999',
      }),
    ).rejects.toMatchObject({ name: 'BashProvenanceRefusal', code: 'work_item_not_held' });
  });

  it('refuses a value that is not a work-item id', async () => {
    await expect(
      resolveBashTaskProvenance(CTX, 'papercusp', deps({ held: [] }), { explicitWorkItemId: 'plan#P-004' }),
    ).rejects.toBeInstanceOf(BashProvenanceRefusal);
  });

  it('stays fail-soft when the held-claim read throws: the named item is used', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', deps({ goalRef: 'WI-1', throws: true }), {
      explicitWorkItemId: 'WI-2',
    });
    expect(p.workItemId).toBe('WI-2');
  });

  it('a blank value is the same as omitting it', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', deps({ goalRef: 'WI-1', held: [{ id: 'WI-1' }] }), {
      explicitWorkItemId: '  ',
    });
    expect(p.workItemId).toBe('WI-1');
  });
});

describe('capability:bash requires explicit attribution when multiple claims are held', () => {
  it('refuses to use a matching goal ref to guess which held item owns the command', async () => {
    await expect(resolveCapabilityBashTaskProvenance(
      CTX,
      'papercusp',
      deps({ goalRef: 'EI-goal', held: [{ id: 'EI-goal' }, { id: 'WI-other' }] }),
    )).rejects.toMatchObject({ code: 'work_item_id_required' });
  });

  it('attributes to the caller-named held item even when the goal ref names another held item', async () => {
    const p = await resolveCapabilityBashTaskProvenance(
      CTX,
      'papercusp',
      deps({ goalRef: 'EI-goal', held: [{ id: 'EI-goal' }, { id: 'WI-command' }] }),
      { explicitWorkItemId: 'WI-command' },
    );
    expect(p.workItemId).toBe('WI-command');
  });
});

describe('bash task provenance — the fallback refuses to guess', () => {
  it('requires explicit attribution for an opted-in launcher despite a retained subtask goal', async () => {
    await expect(resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-subtask', held: [{ id: 'WI-parent' }, { id: 'WI-subtask' }] }),
      { requireExplicitForMultipleHeldItems: true },
    )).rejects.toMatchObject({ code: 'work_item_id_required' });
  });

  it('accepts a held explicit parent when multiple items are held', async () => {
    const p = await resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-subtask', held: [{ id: 'WI-parent' }, { id: 'WI-subtask' }] }),
      { requireExplicitForMultipleHeldItems: true, explicitWorkItemId: 'WI-parent' },
    );
    expect(p.workItemId).toBe('WI-parent');
  });

  it('preserves implicit attribution for an opted-in caller with one held item', async () => {
    const p = await resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-parent', held: [{ id: 'WI-parent' }] }),
      { requireExplicitForMultipleHeldItems: true },
    );
    expect(p.workItemId).toBe('WI-parent');
  });
  it('uses the sole live claim instead of a stale goal for an opted-in launcher', async () => {
    const p = await resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-old', held: [{ id: 'WI-parent' }] }),
      { requireExplicitForMultipleHeldItems: true },
    );
    expect(p.workItemId).toBe('WI-parent');
  });
  it('does not attribute an opted-in launcher to an unheld stale goal', async () => {
    const p = await resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-old', held: [] }),
      { requireExplicitForMultipleHeldItems: true },
    );
    expect(p.workItemId).toBeNull();
  });
  it('requires an explicit item when a strict launcher cannot measure held claims', async () => {
    await expect(resolveBashTaskProvenance(
      CTX, 'papercusp', deps({ goalRef: 'WI-old', throws: true }),
      { requireExplicitForMultipleHeldItems: true },
    )).rejects.toMatchObject({ code: 'work_item_id_required' });
  });

  it('stays NULL when the caller holds SEVERAL items', async () => {
    // Two claims give no basis for choosing, and a wrong association reads as fact.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [{ id: 'WI-1' }, { id: 'WI-2' }] }),
    });
    expect(p.workItemId).toBeNull();
  });

  it('stays NULL when the caller holds nothing', async () => {
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', held: [] }),
    });
    expect(p.workItemId).toBeNull();
  });

  it('stays NULL — and still returns a usable provenance — when the read THROWS', async () => {
    // Provenance is fail-soft by contract: an unreadable claim must never block the shell.
    const p = await resolveBashTaskProvenance(CTX, 'papercusp', {
      ...deps({ goalRef: 'fleet:standalone-drain', throws: true }),
    });
    expect(p.workItemId).toBeNull();
    expect(p.launchedBy).toBe(OWNER);
  });
});
