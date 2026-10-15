/**
 * WI-10005020 (P-002 / R-14) — `linkWorkItemRefDependencies` writes a work-item dependency
 * as a `blocks` edge (src = blocker, dst = dependent) and validates EVERY referent before
 * writing ANY edge, so a refused referent never leaves a partial dependency set behind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resolveWorkItemRef: vi.fn(),
  linkWorkItem: vi.fn(),
  guardFeatureBlockEdgeAcyclic: vi.fn(),
}));

vi.mock('../../work-items', () => ({
  resolveWorkItemRef: m.resolveWorkItemRef,
  linkWorkItem: m.linkWorkItem,
}));
vi.mock('../../dbos/feature-blockers-edges', () => ({
  guardFeatureBlockEdgeAcyclic: m.guardFeatureBlockEdgeAcyclic,
}));

import { linkWorkItemRefDependencies } from './work-item-ref-blocker-edges';

const refFor = (id: string, harness = 'papercusp') => ({ kind: 'feature', ref: `${harness}#${id}` });

/** Items that exist, keyed by the harness they live in. */
let existing: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  existing = { 'WI-1': 'papercusp', 'WI-2': 'papercusp', 'WI-3': 'papercusp' };
  m.resolveWorkItemRef.mockImplementation(async (id: string, harness?: string) => {
    const home = existing[id.toUpperCase()];
    if (!home) return null;
    if (harness && harness !== home) return null;
    return refFor(id.toUpperCase(), home);
  });
  m.guardFeatureBlockEdgeAcyclic.mockResolvedValue(null);
  m.linkWorkItem.mockResolvedValue({ ok: true });
});

describe('linkWorkItemRefDependencies', () => {
  it('writes one blocks edge per referent, blocker as source and dependent as destination', async () => {
    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['WI-2', 'WI-3'],
      by: 'su-test',
    });

    expect(res).toEqual({
      ok: true,
      edges: [
        { blocker: 'WI-2', blocked: refFor('WI-1') },
        { blocker: 'WI-3', blocked: refFor('WI-1') },
      ],
    });
    expect(m.linkWorkItem).toHaveBeenCalledTimes(2);
    expect(m.linkWorkItem).toHaveBeenNthCalledWith(1, 'WI-2', refFor('WI-1'), 'blocks', {
      harness: 'papercusp',
      by: 'su-test',
    });
    expect(m.guardFeatureBlockEdgeAcyclic).toHaveBeenCalledWith('papercusp#WI-2', 'papercusp#WI-1');
  });

  it('refuses a self-dependency (case-insensitive) without writing', async () => {
    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['wi-1'],
      by: 'su-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
    expect(res.ok === false && res.error).toMatch(/cannot depend on itself/);
    // WI-10005197: the refusal carries a RefusalContract naming what the write observed.
    expect(res.ok === false && res.refusal.observed).toEqual({ dependent: 'WI-1', blockers: 'wi-1' });
    expect(res.ok === false && res.refusal.liftsWhen).toMatch(/no blocker is the dependent itself/);
    expect(m.linkWorkItem).not.toHaveBeenCalled();
  });

  it('validates every referent before writing any edge', async () => {
    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['WI-2', 'WI-404'],
      by: 'su-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
    expect(res.ok === false && res.error).toMatch(/'WI-404' was not found/);
    // WI-2 was valid, but the refusal of WI-404 must leave NO partial edge set.
    expect(res.ok === false && res.refusal.observed).toEqual({ dependent: 'WI-1', blockers: 'WI-404' });
    expect(m.linkWorkItem).not.toHaveBeenCalled();
  });

  it('falls back to a workspace-wide resolve for a referent in another harness', async () => {
    existing['EI-9'] = 'other-harness';

    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['EI-9'],
      by: 'su-test',
    });

    expect(res.ok).toBe(true);
    expect(m.resolveWorkItemRef).toHaveBeenCalledWith('EI-9', 'papercusp');
    expect(m.resolveWorkItemRef).toHaveBeenCalledWith('EI-9');
    // The edge write must not re-scope the referent to the dependent's harness.
    expect(m.linkWorkItem).toHaveBeenCalledWith('EI-9', refFor('WI-1'), 'blocks', {
      harness: undefined,
      by: 'su-test',
    });
  });

  it('refuses a dependency that would close a cycle, without writing', async () => {
    m.guardFeatureBlockEdgeAcyclic.mockImplementation(async (src: string) =>
      src === 'papercusp#WI-3' ? 'Edge would create a blocks cycle.' : null,
    );

    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['WI-2', 'WI-3'],
      by: 'su-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
    expect(res.ok === false && res.error).toBe('Edge would create a blocks cycle. No dependency was written.');
    expect(res.ok === false && res.refusal.observed).toEqual({ dependent: 'WI-1', blockers: 'WI-3' });
    expect(res.ok === false && res.refusal.liftsWhen).toMatch(/acyclic/);
    expect(m.linkWorkItem).not.toHaveBeenCalled();
  });

  it('refuses when the dependent itself cannot be resolved', async () => {
    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-404',
      harness: 'papercusp',
      referents: ['WI-2'],
      by: 'su-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
    expect(res.ok === false && res.error).toMatch(/could not be resolved as an edge endpoint/);
    // The refusal is about the dependent itself, so no blocker is named.
    expect(res.ok === false && res.refusal.observed).toEqual({ dependent: 'WI-404', blockers: null });
    expect(m.guardFeatureBlockEdgeAcyclic).not.toHaveBeenCalled();
    expect(m.linkWorkItem).not.toHaveBeenCalled();
  });

  it('names the edges already written when a later write fails', async () => {
    m.linkWorkItem
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ error: "work_item 'WI-3' not found" });

    const res = await linkWorkItemRefDependencies({
      dependentId: 'WI-1',
      harness: 'papercusp',
      referents: ['WI-2', 'WI-3'],
      by: 'su-test',
    });

    expect(res).toMatchObject({ ok: false, code: 'work_item_ref_dependency_refused' });
    expect(res.ok === false && res.error).toMatch(/blocks edge WI-3 → WI-1 was not written/);
    expect(res.ok === false && res.error).toMatch(/already written: WI-2/);
    expect(res.ok === false && res.refusal.observed).toEqual({ dependent: 'WI-1', blockers: 'WI-3' });
  });
});
