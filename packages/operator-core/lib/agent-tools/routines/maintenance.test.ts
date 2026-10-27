import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { recoverRoutineMaintenance, runRoutineMaintenance, validateMaintenancePlan, type MaintenancePlan, type MaintenanceStore } from './maintenance';

function fixture() {
  const before = { active: true, triggerConfig: {}, payloadTemplate: {}, metadata: {}, groupSlug: null, nextFireAtIso: null };
  const plan: MaintenancePlan = {
    operationId: randomUUID(), ownerId: 'su-test', workItemId: 'WI-test', reason: 'bounded maintenance test',
    canonical: { installSlug: 'papercusp', name: 'git-sync', before },
    others: ['calendar', 'crm'].map(installSlug => ({ installSlug, name: 'git-sync', before })),
    deadlineMs: Date.now() + 10_000, phaseTimeoutMs: 500, cleanupTimeoutMs: 1_000,
  };
  const events: string[] = [];
  const applied: { auditId: string; index: number }[] = [];
  const store: MaintenanceStore = {
    prepare: vi.fn(async () => { events.push('intent'); }),
    pause: vi.fn(async (_plan, target, index) => { events.push(target.installSlug); applied.push({ auditId: target.installSlug, index }); }),
    previewCanonical: vi.fn(async () => { events.push('fresh-canonical'); return plan.canonical; }),
    assertCohort: vi.fn(async () => {}),
    seal: vi.fn(async () => { events.push('seal'); return plan; }),
    applied: vi.fn(async () => applied),
    restore: vi.fn(async id => { events.push('restore:' + id); }),
  };
  const phases = {
    publication: vi.fn(async () => { events.push('publication'); }),
    adoption: vi.fn(async () => { events.push('adoption'); }),
  };
  return { plan, store, phases, events };
}

describe('bounded routine maintenance', () => {
  it('publishes before canonical pause, adopts once and restores in reverse order', async () => {
    const { plan, store, phases, events } = fixture();
    expect((await runRoutineMaintenance(plan, store, phases)).ok).toBe(true);
    expect(events).toEqual(['intent', 'calendar', 'crm', 'publication', 'fresh-canonical', 'papercusp', 'adoption', 'seal', 'restore:papercusp', 'restore:crm', 'restore:calendar']);
  });
  it('restores a partial apply including a committed pause whose response was lost', async () => {
    const { plan, store, phases, events } = fixture();
    const pause = store.pause;
    store.pause = async (...args) => { await pause(...args); if (args[2] === 1) throw new Error('lost response'); };
    const result = await runRoutineMaintenance(plan, store, phases);
    expect(result).toMatchObject({ ok: false, cleanup: { ok: true } });
    expect(events.slice(-3)).toEqual(['seal', 'restore:crm', 'restore:calendar']);
    expect(phases.publication).not.toHaveBeenCalled();
  });
  it.each(['publication', 'adoption'] as const)('ends on %s refusal and cleans up without retrying', async stage => {
    const { plan, store, phases } = fixture();
    phases[stage].mockRejectedValue(new Error('guard refused'));
    expect(await runRoutineMaintenance(plan, store, phases)).toMatchObject({ ok: false, cleanup: { ok: true } });
    expect(phases[stage]).toHaveBeenCalledOnce();
  });
  it('cancels a timed out phase and reserves independent cleanup time', async () => {
    vi.useFakeTimers();
    try {
      const { plan, store, phases } = fixture();
      let observed: AbortSignal | undefined;
      phases.publication = vi.fn(async (signal?: AbortSignal) => { observed = signal; await new Promise(() => {}); });
      const pending = runRoutineMaintenance(plan, store, phases);
      await vi.advanceTimersByTimeAsync(501);
      expect(await pending).toMatchObject({ ok: false, cleanup: { ok: true } });
      expect(observed?.aborted).toBe(true);
      expect(phases.adoption).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('interruption triggers cleanup without waiting for the overall deadline', async () => {
    const { plan, store, phases } = fixture();
    const controller = new AbortController();
    phases.publication.mockImplementation(async () => { controller.abort(); });
    expect(await runRoutineMaintenance(plan, store, phases, controller.signal)).toMatchObject({ ok: false, cleanup: { ok: true } });
    expect(phases.adoption).not.toHaveBeenCalled();
  });
  it('continues other restores on a peer conflict and returns owned residue', async () => {
    const { plan, store, phases, events } = fixture();
    store.restore = async id => { events.push('restore:' + id); if (id === 'crm') throw new Error('newer peer pause'); };
    expect(await runRoutineMaintenance(plan, store, phases)).toMatchObject({ ok: false, cleanup: {
      ok: false, residue: [{ ref: 'crm', ownerId: plan.ownerId, workItemId: plan.workItemId }],
    } });
    expect(events.at(-1)).toBe('restore:calendar');
  });
  it('never reports restoration when the database is unavailable', async () => {
    const { plan, store, phases } = fixture();
    store.seal = async () => { throw new Error('DB unavailable'); };
    const result = await runRoutineMaintenance(plan, store, phases);
    expect(result.cleanup).toMatchObject({ ok: false, residue: [{ ownerId: plan.ownerId, workItemId: plan.workItemId }] });
    expect(store.applied).not.toHaveBeenCalled();
  });
  it('can recover independently without an operator HTTP phase', async () => {
    const { plan, store, phases } = fixture();
    expect((await recoverRoutineMaintenance(store, plan.operationId, 500)).ok).toBe(true);
    expect(phases.publication).not.toHaveBeenCalled();
    expect(phases.adoption).not.toHaveBeenCalled();
  });
  it.each(['inactive', 'duplicate', 'unbounded', 'missing-owner'])('rejects invalid %s plans before any effects', kind => {
    const { plan } = fixture();
    if (kind === 'inactive') plan.others[0]!.before = { ...plan.others[0]!.before, active: false };
    if (kind === 'duplicate') plan.others.push(plan.canonical);
    if (kind === 'unbounded') plan.phaseTimeoutMs = Infinity;
    if (kind === 'missing-owner') plan.ownerId = '';
    expect(() => validateMaintenancePlan(plan)).toThrow();
  });
});
