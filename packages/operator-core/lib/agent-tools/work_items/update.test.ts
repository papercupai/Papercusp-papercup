/**
 * update.test.ts — the work_items:update HANDLER (updateWorkItem mocked), bulk
 * keyed-array contract. Pins the single-inline patch passthrough, the items:[…]
 * fan-out, the per-item not_found mapping (batch survives), and the feature-family
 * `unsupported_family` error mapping. The unified replacement for the retired
 * issues:update (coordination-unification-2026-06-23 P-009).
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/update.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
// P-020 field-authority guard: no admissions by default; workspace pinned so the guard never reads the registry.
vi.mock('../../work-admission/admit', () => ({ refuseExternalOwnedPatch: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../work-items', () => ({
  updateWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  activeExternalBlockers: (payload: unknown) => {
    const blockers = (payload as { externalBlockers?: unknown } | undefined)?.externalBlockers;
    return Array.isArray(blockers) ? blockers.filter((b) => b?.status === 'active') : [];
  },
  mergeWorkItemPayload: vi.fn(),
  linkWorkItem: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
}));

import { updateWorkItem, getWorkItem, mergeWorkItemPayload, linkWorkItem, explainIssueClaimFloors } from '../../work-items';
import { workItemFixture } from '../../testing/work-item-fixture';
const updM = vi.mocked(updateWorkItem);
const getM = vi.mocked(getWorkItem);
const mergeM = vi.mocked(mergeWorkItemPayload);
const linkM = vi.mocked(linkWorkItem);
const floorsM = vi.mocked(explainIssueClaimFloors);
const updateMod = await import('./update');
const tool = updateMod.default;
const { reservedPayloadKeys } = updateMod; // WI-41509 payload merge guard
const { refuseExternalOwnedPatch } = await import('../../work-admission/admit');
const refuseM = vi.mocked(refuseExternalOwnedPatch);

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as Out).data;

const OWNER_CONDITION = {
  kind: 'human', ref: 'credential:test-service', capability: 'credential', status: 'active',
  summary: 'Provide the service credential.', nextVerb: 'Configure the credential and verify access.',
  createdBy: 'su-requester', createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
  defaultIfUnanswered: 'Remains parked until the credential is provided.',
};

beforeEach(() => {
  vi.clearAllMocks();
  getM.mockImplementation(async (id) => workItemFixture({ id, payload: { externalBlockers: [OWNER_CONDITION] } }));
});

describe('work_items:update handler (bulk keyed-array)', () => {
  it('refuses forged reporter publication, answer and question payloads before writing', async () => {
    for (const key of ['reporterRelease', 'reporterAnswer', 'reporterQuestion']) {
      const out = await body({ id: 'EI-1', payload: { [key]: { forged: true } } });
      expect(out.results[0]).toMatchObject({ ok: false, id: 'EI-1' });
      expect(out.results[0].error).toContain(key);
    }
    expect(updM).not.toHaveBeenCalled();
    expect(mergeM).not.toHaveBeenCalled();
  });
  it('edits one inline { id, …fields } and passes the patch + owner through', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-1', title: 'new' } } as never);
    const b = await body({ id: 'EI-1', title: 'new', severity: 'major' });
    expect(updM).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ title: 'new', severity: 'major' }),
      'me',
      expect.objectContaining({ harness: undefined }),
    );
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', item: { id: 'EI-1', title: 'new' } });
  });

  it('passes a goal attribution through for an existing item', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-1', goalId: 'goal-a' }) });
    const b = await body({ id: 'EI-1', goal: 'goal-a' });
    expect(updM).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ goal: 'goal-a' }),
      'me',
      expect.any(Object),
    );
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-1', item: { goalId: 'goal-a' } });
  });

  it('passes duplicate/child parent links through, including an explicit clear', async () => {
    mockImplementationTyped(updM, async (id) => ({ ok: true, item: workItemFixture({ id }) }));
    await body({ items: [{ id: 'EI-child', parent: 'EI-parent' }, { id: 'EI-duplicate', parent: null }] });
    expect(updM).toHaveBeenNthCalledWith(
      1,
      'EI-child',
      expect.objectContaining({ parent: 'EI-parent' }),
      'me',
      expect.any(Object),
    );
    expect(updM).toHaveBeenNthCalledWith(
      2,
      'EI-duplicate',
      expect.objectContaining({ parent: null }),
      'me',
      expect.any(Object),
    );
  });

  it('backfills payload.plan_item and its coverage edge for an existing item', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-1', harness: 'papercusp' }) });
    mockResolvedTyped(mergeM, workItemFixture({
      id: 'EI-1',
      harness: 'papercusp',
      payload: { plan_item: { plan_slug: 'plan-a', item_id: 'P-004', harness_slug: 'papercusp' } },
    }));
    const b = await body({
      id: 'EI-1',
      plan_item: { slug: 'plan-a', item: 'P-004' },
      harness: 'papercusp',
    });
    expect(mergeM).toHaveBeenCalledWith(
      'EI-1',
      { plan_item: { plan_slug: 'plan-a', item_id: 'P-004', harness_slug: 'papercusp' } },
      { harness: 'papercusp' },
    );
    expect(linkM).toHaveBeenCalledWith(
      'EI-1',
      { kind: 'plan_item', ref: 'plan-a#P-004' },
      'relates',
      { harness: 'papercusp', by: 'me' },
    );
    expect(b.results[0]).toMatchObject({ ok: true, item: { payload: { plan_item: expect.any(Object) } } });
  });

  it('does not stamp a plan item or coverage edge with the operator wildcard', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-operator', harness: null }) });
    const result = (await tool.handler(
      { id: 'EI-operator', plan_item: { slug: 'plan-a', item: 'P-operator' } } as never,
      { harnessSlug: '*' } as never,
    )) as Out;
    expect(mergeM).not.toHaveBeenCalled();
    expect(linkM).toHaveBeenCalledWith(
      'EI-operator',
      { kind: 'plan_item', ref: 'plan-a#P-operator' },
      'relates',
      { harness: undefined, by: 'me' },
    );
    expect(result.data).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
  });

  it('applies plan_item to a feature-family item instead of refusing the family-agnostic stamp', async () => {
    mockResolvedTyped(updM, { ok: false, reason: 'unsupported_family' });
    mockResolvedTyped(mergeM, workItemFixture({
      id: 'F-1',
      kind: 'feature',
      family: 'feature',
      payload: { plan_item: { plan_slug: 'plan-a', item_id: 'P-002', harness_slug: 'papercusp' } },
    }));
    const b = await body({ id: 'F-1', harness: 'papercusp', plan_item: { slug: 'plan-a', item: 'P-002' } });
    expect(mergeM).toHaveBeenCalledWith(
      'F-1',
      { plan_item: { plan_slug: 'plan-a', item_id: 'P-002', harness_slug: 'papercusp' } },
      { harness: 'papercusp' },
    );
    expect(linkM).toHaveBeenCalledWith(
      'F-1',
      { kind: 'plan_item', ref: 'plan-a#P-002' },
      'relates',
      { harness: 'papercusp', by: 'me' },
    );
    expect(b.results[0]).toMatchObject({ ok: true, id: 'F-1' });
  });

  it('fans out the top-level goal default while preserving a per-item clear', async () => {
    mockImplementationTyped(updM, async (id) => ({ ok: true, item: workItemFixture({ id }) }));
    await body({ goal: 'goal-a', items: [{ id: 'EI-1' }, { id: 'EI-2', goal: null }] });
    expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ goal: 'goal-a' }), 'me', expect.any(Object));
    expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ goal: null }), 'me', expect.any(Object));
  });

  it('items:[…] heterogeneous fan-out preserves order + per-item harness', async () => {
    updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
    const b = await body({ items: [{ id: 'EI-1', title: 'a', harness: 'h1' }, { id: 'EI-2', body: 'b' }] });
    expect(b.counts).toEqual({ ok: 2, failed: 0 });
    expect(b.results.map((r: { id: string }) => r.id)).toEqual(['EI-1', 'EI-2']);
    expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.any(Object), 'me', { harness: 'h1' });
  });

  it('a not_found item maps to { ok:false, error } without failing the rest', async () => {
    updM.mockImplementation(
      async (id: string) =>
        (id === 'EI-X' ? { ok: false, reason: 'not_found' } : { ok: true, item: { id } }) as never,
    );
    const b = await body({ items: [{ id: 'EI-1' }, { id: 'EI-X' }] });
    // EI-23737206446729041: envelope `ok` is DERIVED from items, so failed>0 => ok:false.
    // Per-item isolation (what this test proves) is unchanged: the batch still ran every item.
    expect(b.ok).toBe(false);
    expect(b.counts).toEqual({ ok: 1, failed: 1 });
    expect(b.results[1]).toMatchObject({ ok: false, id: 'EI-X', error: expect.stringContaining('not found') });
  });

  it('a feature-family item maps to an unsupported_family error', async () => {
    updM.mockResolvedValue({ ok: false, reason: 'unsupported_family' });
    const b = await body({ id: 'F-1', title: 'x' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'F-1', error: expect.stringContaining('feature-family') });
  });

  // EI-14948: a remote-authored (origin='remote') issue-family row resolves fine via
  // work_items:get / work_items:comment but the engineer_issues view's INSTEAD OF
  // trigger deliberately no-ops a local field-edit — updateWorkItem now surfaces that
  // as its own typed reason instead of the generic (misleading) 'not_found', and the
  // handler must map it to an honest, specific error naming the actual cause.
  it('a remote_origin_not_editable item maps to a specific remote-authored error, not a misleading "not found"', async () => {
    updM.mockResolvedValue({ ok: false, reason: 'remote_origin_not_editable' } as never);
    const b = await body({ id: 'EI-14660', title: 'corrected title' });
    expect(b.counts).toEqual({ ok: 0, failed: 1 });
    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-14660' });
    expect(b.results[0].error).toMatch(/remote-authored/);
    expect(b.results[0].error).not.toMatch(/not found/);
  });

  // EI-19919820196426791: raising severity to critical/major on an item structurally
  // unclaimable (observation lane / owner action) used to report a plain ok:true with
  // nothing flagging that the write can't move it into the work queue.
  it('severity:major on an observation-lane item surfaces claimabilityWarning', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-1', harness: 'papercusp' } } as never);
    floorsM.mockResolvedValue([
      { id: 'EI-1', admissible: false, refusedBy: 'observation-lane', detail: 'payload.lane = "observation" — a captured NOTE, never work-queue material (D-005)' },
    ] as never);
    const b = await body({ id: 'EI-1', severity: 'major' });
    expect(floorsM).toHaveBeenCalledWith('papercusp', ['EI-1']);
    expect(b.results[0].claimabilityWarning).toMatch(/structurally UNCLAIMABLE/);
    expect(b.results[0].claimabilityWarning).toMatch(/observation/);
  });

  it('severity:critical on an owner-action item surfaces claimabilityWarning', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'WI-1', harness: 'papercusp' } } as never);
    floorsM.mockResolvedValue([
      { id: 'WI-1', admissible: false, refusedBy: 'needs-owner-action', detail: 'payload.needsOwnerAction = true — a credential requires the owner' },
    ] as never);
    const b = await body({ id: 'WI-1', severity: 'critical' });
    expect(b.results[0].claimabilityWarning).toMatch(/owner|credential/i);
  });

  it('severity:minor never checks claim floors (only critical/major do)', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-2', harness: 'papercusp' } } as never);
    const b = await body({ id: 'EI-2', severity: 'nit' });
    expect(floorsM).not.toHaveBeenCalled();
    expect(b.results[0].claimabilityWarning).toBeUndefined();
  });

  it('severity:major on an otherwise-admissible item adds no warning', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-3', harness: 'papercusp' } } as never);
    floorsM.mockResolvedValue([{ id: 'EI-3', admissible: true, refusedBy: null, detail: null }] as never);
    const b = await body({ id: 'EI-3', severity: 'major' });
    expect(b.results[0].claimabilityWarning).toBeUndefined();
  });

  it('a floor lookup failure never fails the underlying field-edit', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-4', harness: 'papercusp' } } as never);
    floorsM.mockRejectedValue(new Error('db down'));
    const b = await body({ id: 'EI-4', severity: 'critical' });
    expect(b.results[0]).toMatchObject({ ok: true, id: 'EI-4' });
    expect(b.results[0].claimabilityWarning).toBeUndefined();
  });

  // EI-8497: a body edit the underlying updateWorkItem rejected as a fat-finger
  // shrink maps to a clear, actionable error (not a bare "not found").
  describe('body-shrink guard mapping (EI-8497)', () => {
    it('a body_shrink_guard reason maps to an actionable error naming confirmShrink', async () => {
      updM.mockResolvedValue({ ok: false, reason: 'body_shrink_guard', existingLength: 200, newLength: 11 } as never);
      const b = await body({ id: 'EI-1', body: 'placeholder' });
      expect(b.counts).toEqual({ ok: 0, failed: 1 });
      expect(b.results[0]).toMatchObject({
        ok: false,
        id: 'EI-1',
        error: expect.stringContaining('confirmShrink:true'),
      });
      expect(b.results[0].error).toContain('200');
      expect(b.results[0].error).toContain('11');
    });

    it('passes confirmShrink through to updateWorkItem for the single-id form', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
      await body({ id: 'EI-1', body: 'placeholder', confirmShrink: true });
      expect(updM).toHaveBeenCalledWith(
        'EI-1',
        expect.objectContaining({ body: 'placeholder', confirmShrink: true }),
        'me',
        expect.any(Object),
      );
    });

    it('a top-level confirmShrink applies as the default for items:[] that omit their own (mirrors EI-7639)', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ confirmShrink: true, items: [{ id: 'EI-1', body: 'a' }, { id: 'EI-2', body: 'b' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ confirmShrink: true }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ confirmShrink: true }), 'me', expect.any(Object));
    });
  });

  // EI-7639: a top-level field-edit was previously SILENTLY DROPPED in the
  // items:[] batch form — `{ kind:'change', items:[{id},{id}] }` returned
  // ok:true for every item (updated_ts bumped) while applying NO kind change,
  // because only each item's OWN (undefined) field was used. A top-level
  // field must now apply as the default for every item that omits its own.
  describe('top-level field-edit as a batch default (EI-7639)', () => {
    it('applies a top-level `kind` to every item in items:[] that omits its own', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ kind: 'change', items: [{ id: 'EI-1' }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });

    it('a per-item field WINS over the top-level default (per-item is more specific)', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ kind: 'change', items: [{ id: 'EI-1', kind: 'bug' }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ kind: 'bug' }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });

    it('applies a top-level `harness` default alongside a top-level `severity` default', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ severity: 'major', harness: 'papercusp', items: [{ id: 'EI-1' }, { id: 'EI-2', harness: 'h2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ severity: 'major' }), 'me', { harness: 'papercusp' });
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ severity: 'major' }), 'me', { harness: 'h2' });
    });

    it('an explicit item-level `null` (clear the field) is NOT overridden by a top-level default', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      await body({ foundDuring: 'wave-1', items: [{ id: 'EI-1', foundDuring: null }, { id: 'EI-2' }] });
      expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ foundDuring: null }), 'me', expect.any(Object));
      expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ foundDuring: 'wave-1' }), 'me', expect.any(Object));
    });

    it('the single-id inline form is unaffected (no items[] present)', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
      await body({ id: 'EI-1', kind: 'change' });
      expect(updM).toHaveBeenCalledWith('EI-1', expect.objectContaining({ kind: 'change' }), 'me', expect.any(Object));
    });
  });

  // EI-18151406094317010: needsTwoMachineRig isn't a real issue column — updateWorkItem's
  // patch would silently drop it (unknown key), so it must be applied ADDITIVELY via
  // mergeWorkItemPayload onto payload.needs_2_machine_rig (the exact key
  // crossMachineRigExclusionSql reads in scheduler:get_next / claim_next), never through
  // the updateIssue column patch.
  describe('needsTwoMachineRig → payload.needs_2_machine_rig (EI-18151406094317010)', () => {
    it('true: calls mergeWorkItemPayload with needs_2_machine_rig:true and returns the merged item', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'WI-5631', title: 'rig item' } } as never);
      mergeM.mockResolvedValue({ id: 'WI-5631', title: 'rig item', payload: { needs_2_machine_rig: true } } as never);
      const b = await body({ id: 'WI-5631', needsTwoMachineRig: true });
      expect(mergeM).toHaveBeenCalledWith('WI-5631', { needs_2_machine_rig: true }, { harness: undefined });
      expect(b.results[0]).toMatchObject({
        ok: true,
        id: 'WI-5631',
        item: { payload: { needs_2_machine_rig: true } },
      });
    });

    it('false: clears the tag via mergeWorkItemPayload with needs_2_machine_rig:false', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'WI-5631' } } as never);
      mergeM.mockResolvedValue({ id: 'WI-5631', payload: { needs_2_machine_rig: false } } as never);
      await body({ id: 'WI-5631', needsTwoMachineRig: false });
      expect(mergeM).toHaveBeenCalledWith('WI-5631', { needs_2_machine_rig: false }, { harness: undefined });
    });

    it('omitted: never calls mergeWorkItemPayload (no spurious payload write)', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
      await body({ id: 'EI-1', title: 'unrelated edit' });
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('items:[…] per-item needsTwoMachineRig fans out independently', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
      await body({ items: [{ id: 'WI-1', needsTwoMachineRig: true }, { id: 'WI-2' }] });
      expect(mergeM).toHaveBeenCalledTimes(1);
      expect(mergeM).toHaveBeenCalledWith('WI-1', { needs_2_machine_rig: true }, expect.any(Object));
    });

    it('a top-level needsTwoMachineRig applies as the batch default (mirrors EI-7639)', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
      await body({ needsTwoMachineRig: true, items: [{ id: 'WI-1' }, { id: 'WI-2' }] });
      expect(mergeM).toHaveBeenCalledTimes(2);
      expect(mergeM).toHaveBeenNthCalledWith(1, 'WI-1', { needs_2_machine_rig: true }, expect.any(Object));
      expect(mergeM).toHaveBeenNthCalledWith(2, 'WI-2', { needs_2_machine_rig: true }, expect.any(Object));
    });
  });

  // WI-5689: needsHuman was DECLARED in the zod schema (FIELDS.needsHuman) and documented
  // in the tool description, but never threaded into `list` nor applied in the handler —
  // a genuine dead field: work_items:update{needsHuman:true} always resolved to
  // `it.needsHuman === undefined`, so mergeWorkItemPayload was never called and the call
  // still returned ok:true (confirmed live via direct Postgres read on EI-12519 — a
  // genuine write-side no-op, not a stale-read artifact). Mirrors the needsTwoMachineRig
  // contract above exactly.
  describe('needsHuman compatibility input → split owner-action payload (P-005)', () => {
    it.each([
      ['absent condition', {}],
      ['existing owner flag', { needsOwnerAction: true }],
      ['legacy capability', { humanCapability: 'credential' }],
      ['technical dependency', { externalBlockers: [{ ...OWNER_CONDITION, kind: 'runtime', capability: 'live-dependency' }] }],
      ['product decision', { externalBlockers: [{ ...OWNER_CONDITION, capability: 'product-decision' }] }],
      ['cleared condition', { externalBlockers: [{ ...OWNER_CONDITION, status: 'cleared' }] }],
      ['unanswerable human ask', { externalBlockers: [{ ...OWNER_CONDITION, defaultIfUnanswered: undefined }] }],
      ['missing next action', { externalBlockers: [{ ...OWNER_CONDITION, nextVerb: '' }] }],
    ])('refuses %s before a mixed field update can write anything', async (_label, payload) => {
      getM.mockResolvedValue(workItemFixture({ id: 'EI-unsupported', payload }));
      const b = await body({ id: 'EI-unsupported', needsHuman: true, title: 'must stay unchanged' });
      expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-unsupported' });
      expect(b.results[0].error).toContain('current typed');
      expect(updM).not.toHaveBeenCalled();
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('does not treat a caller-supplied condition as current owner authority', async () => {
      getM.mockResolvedValue(workItemFixture({ id: 'EI-unsupported', payload: {} }));
      const b = await body({ id: 'EI-unsupported', needsHuman: true, payload: { externalBlockers: [OWNER_CONDITION] } });
      expect(b.results[0].ok).toBe(false);
      expect(updM).not.toHaveBeenCalled();
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('preserves a typed upstream runtime owner condition without inventing a human ask', async () => {
      getM.mockResolvedValue(workItemFixture({ id: 'EI-upstream', payload: {
        externalBlockers: [{ ...OWNER_CONDITION, kind: 'runtime', capability: 'external-service-action', defaultIfUnanswered: undefined }],
      } }));
      mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-upstream' }) });
      mockResolvedTyped(mergeM, workItemFixture({ id: 'EI-upstream', payload: { needsOwnerAction: true } }));
      expect((await body({ id: 'EI-upstream', needsHuman: true })).results[0].ok).toBe(true);
      expect(mergeM).toHaveBeenCalledWith('EI-upstream', { needsOwnerAction: true }, expect.any(Object));
    });

    it.each(['issue', 'feature'])('reports a condition race for %s without claiming that the flag landed', async (family) => {
      const rawConditions = [{ ...OWNER_CONDITION, legacyEvidence: { generation: 7 } }];
      getM.mockResolvedValue(workItemFixture({ id: 'WI-race', payload: { externalBlockers: rawConditions } }));
      if (family === 'issue') mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'WI-race' }) });
      else updM.mockResolvedValue({ ok: false, reason: 'unsupported_family' } as never);
      mergeM.mockResolvedValue(null);

      const b = await body({ id: 'WI-race', needsHuman: true });

      expect(mergeM).toHaveBeenCalledWith('WI-race', { needsOwnerAction: true }, {
        harness: undefined, unset: ['needsHuman'], expectedExternalBlockers: rawConditions, requireNonTerminal: true,
      });
      expect(b.results[0]).toMatchObject({ ok: false, id: 'WI-race' });
      expect(b.results[0].error).toContain('owner-condition-changed');
      expect(b.results[0].error).toContain(family === 'issue' ? 'earlier field or payload edits may have applied' : 'No admission flags or plan stamp were applied');
    });

    it('true: writes needsOwnerAction and removes the legacy needsHuman key', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-12519', title: 'human item' } } as never);
      mergeM.mockResolvedValue({ id: 'EI-12519', title: 'human item', payload: { needsOwnerAction: true } } as never);
      const b = await body({ id: 'EI-12519', needsHuman: true });
      expect(mergeM).toHaveBeenCalledWith(
        'EI-12519',
        { needsOwnerAction: true },
        { harness: undefined, unset: ['needsHuman'], expectedExternalBlockers: [OWNER_CONDITION], requireNonTerminal: true },
      );
      expect(b.results[0]).toMatchObject({
        ok: true,
        id: 'EI-12519',
        item: { payload: { needsOwnerAction: true } },
      });
    });

    it('false: re-admits by removing both legacy and strict keys', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-12519' } } as never);
      mergeM.mockResolvedValue({ id: 'EI-12519', payload: {} } as never);
      await body({ id: 'EI-12519', needsHuman: false });
      expect(mergeM).toHaveBeenCalledWith(
        'EI-12519',
        {},
        { harness: undefined, unset: ['needsHuman', 'needsOwnerAction'] },
      );
    });

    it('omitted: never calls mergeWorkItemPayload (no spurious payload write)', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
      await body({ id: 'EI-1', title: 'unrelated edit' });
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('items:[…] per-item needsHuman fans out independently', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
      await body({ items: [{ id: 'WI-1', needsHuman: true }, { id: 'WI-2' }] });
      expect(mergeM).toHaveBeenCalledTimes(1);
      expect(mergeM).toHaveBeenCalledWith(
        'WI-1',
        { needsOwnerAction: true },
        expect.objectContaining({ unset: ['needsHuman'] }),
      );
    });

    it('a top-level needsHuman applies as the batch default (mirrors EI-7639)', async () => {
      updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
      mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
      await body({ needsHuman: true, items: [{ id: 'WI-1' }, { id: 'WI-2' }] });
      expect(mergeM).toHaveBeenCalledTimes(2);
      expect(mergeM).toHaveBeenNthCalledWith(1, 'WI-1', { needsOwnerAction: true }, expect.objectContaining({ unset: ['needsHuman'] }));
      expect(mergeM).toHaveBeenNthCalledWith(2, 'WI-2', { needsOwnerAction: true }, expect.objectContaining({ unset: ['needsHuman'] }));
    });

    // EI-18707466248332421: the rig-gate WRITE path for the FEATURE family. The READ floor has
    // been GLOBAL across both families since EI-14806 (crossMachineRigExclusionSql via
    // claimFloorsWhereSql — proved by get-next-rig-floor.integration.test.ts), but NOTHING could
    // ARM it on a feature-family item: this handler calls updateWorkItem first, and its
    // issue-family-only `unsupported_family` refusal short-circuited the payload-flag merges — so
    // the global floor was unreachable for the feature family. Live consequence: WI-3500 (8
    // placements) + WI-3496 (6) burned 14 spawns on legs the repo's own committed scaffold
    // (papercusp-desktop/bin/hive-git-drill.sh) already declares impossible on one box.
    // These are the guards that would have failed the day the read floor went in write-side-less.
    describe('feature-family admission flags are writable (EI-18707466248332421)', () => {
      const FEATURE_FAMILY = { ok: false, reason: 'unsupported_family' } as const;

      it('needsTwoMachineRig on a FEATURE-family item is APPLIED, not refused as unsupported_family', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockResolvedValue({ id: 'WI-3500', payload: { needs_2_machine_rig: true } } as never);
        const b = await body({ id: 'WI-3500', needsTwoMachineRig: true });
        expect(mergeM).toHaveBeenCalledWith('WI-3500', { needs_2_machine_rig: true }, { harness: undefined });
        expect(b.counts).toEqual({ ok: 1, failed: 0 });
        expect(b.results[0]).toMatchObject({
          ok: true,
          id: 'WI-3500',
          item: { payload: { needs_2_machine_rig: true } },
        });
        expect(b.results[0].error).toBeUndefined();
      });

      it('clearing the flag (false) on a FEATURE-family item also lands — the re-admit path', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockResolvedValue({ id: 'WI-3500', payload: { needs_2_machine_rig: false } } as never);
        const b = await body({ id: 'WI-3500', needsTwoMachineRig: false });
        expect(mergeM).toHaveBeenCalledWith('WI-3500', { needs_2_machine_rig: false }, { harness: undefined });
        expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3500' });
      });

      it('needsHuman — the sibling family-agnostic flag — is likewise applied on a FEATURE-family item', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockResolvedValue({ id: 'WI-3496', payload: { needsOwnerAction: true } } as never);
        const b = await body({ id: 'WI-3496', needsHuman: true });
        expect(mergeM).toHaveBeenCalledWith(
          'WI-3496',
          { needsOwnerAction: true },
          { harness: undefined, unset: ['needsHuman'], expectedExternalBlockers: [OWNER_CONDITION], requireNonTerminal: true },
        );
        expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3496' });
      });

      it('both flags on a FEATURE-family item merge together in ONE payload patch', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
        const b = await body({ id: 'WI-3500', needsTwoMachineRig: true, needsHuman: true });
        expect(mergeM).toHaveBeenCalledTimes(1);
        expect(mergeM).toHaveBeenCalledWith(
          'WI-3500',
          { needs_2_machine_rig: true, needsOwnerAction: true },
          { harness: undefined, unset: ['needsHuman'], expectedExternalBlockers: [OWNER_CONDITION], requireNonTerminal: true },
        );
        expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-3500' });
      });

      it('a per-item flag inside items:[…] reaches a FEATURE-family row (the batch form)', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
        const b = await body({ items: [{ id: 'WI-3500', needsTwoMachineRig: true }, { id: 'WI-3496', needsTwoMachineRig: true }] });
        expect(b.counts).toEqual({ ok: 2, failed: 0 });
        expect(mergeM).toHaveBeenNthCalledWith(1, 'WI-3500', { needs_2_machine_rig: true }, expect.any(Object));
        expect(mergeM).toHaveBeenNthCalledWith(2, 'WI-3496', { needs_2_machine_rig: true }, expect.any(Object));
      });

      // The flag is family-agnostic; a COLUMN edit genuinely is not. Applying the flag must not
      // silently swallow the rejection of the pipeline-owned half.
      it('a flag alongside a COLUMN edit applies the flag but still reports the column rejection', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockResolvedValue({ id: 'WI-3500', payload: { needs_2_machine_rig: true } } as never);
        const b = await body({ id: 'WI-3500', needsTwoMachineRig: true, title: 'a pipeline-owned edit' });
        expect(mergeM).toHaveBeenCalledWith('WI-3500', { needs_2_machine_rig: true }, expect.any(Object));
        expect(b.counts).toEqual({ ok: 0, failed: 1 });
        expect(b.results[0].error).toMatch(/WERE applied/);
        expect(b.results[0].error).toMatch(/needs_2_machine_rig/);
      });

      it('a PURE column edit on a FEATURE-family item is unchanged — refused, with NO payload write', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        const b = await body({ id: 'F-1', title: 'x' });
        expect(mergeM).not.toHaveBeenCalled();
        expect(b.counts).toEqual({ ok: 0, failed: 1 });
        expect(b.results[0].error).toMatch(/feature-family/);
      });

      it('a vanished item (merge returns null) falls back to the honest unsupported_family error', async () => {
        updM.mockResolvedValue(FEATURE_FAMILY as never);
        mergeM.mockResolvedValue(null as never);
        const b = await body({ id: 'WI-gone', needsTwoMachineRig: true });
        expect(b.counts).toEqual({ ok: 0, failed: 1 });
        expect(b.results[0].error).toMatch(/feature-family/);
      });
    });

    it('needsHuman and needsTwoMachineRig on the same item both merge (two separate calls)', async () => {
      updM.mockResolvedValue({ ok: true, item: { id: 'WI-1' } } as never);
      mergeM.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ id, payload: patch }) as never);
      const b = await body({ id: 'WI-1', needsHuman: true, needsTwoMachineRig: true });
      expect(mergeM).toHaveBeenCalledTimes(2);
      expect(mergeM).toHaveBeenNthCalledWith(1, 'WI-1', { needs_2_machine_rig: true }, expect.any(Object));
      expect(mergeM).toHaveBeenNthCalledWith(
        2,
        'WI-1',
        { needsOwnerAction: true },
        expect.objectContaining({ unset: ['needsHuman'] }),
      );
      // the second merge's return value wins as the final echoed item (last-write, matches
      // needsTwoMachineRig's own existing item-reassignment pattern above)
      expect(b.results[0]).toMatchObject({ ok: true, id: 'WI-1', item: { payload: { needsOwnerAction: true } } });
    });
  });
});

// EI-6060: `status`/`state` are lifecycle fields owned by work_items:set_state. Zod's
// default object() SILENTLY STRIPPED them, so an update({ id, state:'resolved' }) parsed
// clean, changed nothing, and returned ok:true — a silent no-op read as success. The args
// schema rejects them as unknown keys; keeping them out of the declared shape also prevents
// the generated tool schema from advertising lifecycle fields that the runtime rejects.
// (Tested at the schema layer because the handler is invoked directly in the tests above,
// bypassing arg parsing.)
describe('work_items:update args schema — rejects lifecycle-state footguns (EI-6060)', () => {
  it('rejects an inline `state` field instead of silently stripping it', () => {
    const r = tool.args.safeParse({ id: 'EI-1', state: 'resolved' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('state'))).toBe(true);
    }
  });

  it('rejects an inline `status` field', () => {
    const r = tool.args.safeParse({ id: 'EI-1', status: 'resolved' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('status'))).toBe(true);
    }
  });

  it('rejects a `state`/`status` field inside items:[…]', () => {
    const state = tool.args.safeParse({ items: [{ id: 'EI-1', state: 'closed' }] });
    const status = tool.args.safeParse({ items: [{ id: 'EI-2', status: 'open' }] });
    expect(state.success).toBe(false);
    expect(status.success).toBe(false);
    if (!state.success) {
      expect(state.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('state'))).toBe(true);
    }
    if (!status.success) {
      expect(status.error.issues.some((i) => i.code === 'unrecognized_keys' && i.keys.includes('status'))).toBe(true);
    }
  });

  it('does not advertise lifecycle fields in the generated tool schema', async () => {
    const { z } = await import('zod');
    const schema = z.toJSONSchema(tool.args as never) as {
      properties?: {
        state?: unknown;
        status?: unknown;
        items?: { items?: { properties?: { state?: unknown; status?: unknown } } };
      };
    };
    expect(schema.properties).not.toHaveProperty('state');
    expect(schema.properties).not.toHaveProperty('status');
    expect(schema.properties?.items?.items?.properties).not.toHaveProperty('state');
    expect(schema.properties?.items?.items?.properties).not.toHaveProperty('status');
  });

  it('still ACCEPTS a valid field-only patch (no false positive)', () => {
    expect(tool.args.safeParse({ id: 'EI-1', title: 'new', severity: 'major' }).success).toBe(true);
    expect(tool.args.safeParse({ items: [{ id: 'EI-1', body: 'b', kind: 'change' }] }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'EI-1', goal: 'goal-a' }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'EI-1', goal: null }).success).toBe(true);
    expect(tool.args.safeParse({ id: 'EI-1', plan_item: { slug: 'plan-a', item: 'P-001' } }).success).toBe(true);
  });

  it('still enforces id-or-items', () => {
    const r = tool.args.safeParse({ title: 'orphan' });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => /pass \{ id/.test(i.message))).toBe(true);
  });
});

describe('work_items:update unknown-key redirects (EI-21771591408106167)', () => {
  it('teaches callers that assignee belongs to work_items:claim', () => {
    const redirect = tool.guidance?.argRedirects?.assignee;
    expect(redirect).toMatchObject({
      tool: 'work_items:claim',
      args: { id: '<work-item-id>', assignee: '<assignee>' },
    });
    expect((redirect as { note?: string }).note).toMatch(/work_items:claim/);
  });
});

// WI-4492: the item's primary text column had inverted names across the CRUD triad —
// get RETURNS `summary`, create took `summary`, update took `body` — and each write verb
// SILENTLY DISCARDED the wrong one (Zod stripped it) while returning ok:true. So the
// natural get→edit→update round-trip dropped the body. update now ACCEPTS `summary` as an
// alias for `body`, is `.strict()` (an unknown field is a loud error, not a silent drop),
// and rejects both-with-different-values.
describe('work_items:update — body/summary alias + strict (WI-4492)', () => {
  it('maps a `summary` arg to `body` when calling updateWorkItem (the get→update round-trip)', async () => {
    updM.mockResolvedValue({ ok: true, item: { id: 'EI-1' } } as never);
    await body({ id: 'EI-1', summary: 'the real text' });
    expect(updM).toHaveBeenCalledWith(
      'EI-1',
      expect.objectContaining({ body: 'the real text' }),
      'me',
      expect.any(Object),
    );
  });

  it('maps a per-item `summary` to body inside items:[…]', async () => {
    updM.mockImplementation(async (id: string) => ({ ok: true, item: { id } }) as never);
    await body({ items: [{ id: 'EI-1', summary: 'a' }, { id: 'EI-2', body: 'b' }] });
    expect(updM).toHaveBeenNthCalledWith(1, 'EI-1', expect.objectContaining({ body: 'a' }), 'me', expect.any(Object));
    expect(updM).toHaveBeenNthCalledWith(2, 'EI-2', expect.objectContaining({ body: 'b' }), 'me', expect.any(Object));
  });

  describe('args schema', () => {
    it('ACCEPTS `summary` as an alias for `body`', () => {
      expect(tool.args.safeParse({ id: 'EI-1', summary: 'text' }).success).toBe(true);
    });

    it('REJECTS an unknown field loudly instead of silently stripping it (strict)', () => {
      const r = tool.args.safeParse({ id: 'EI-1', boddy: 'a typo for body' });
      expect(r.success).toBe(false);
    });

    it('REJECTS both `body` and `summary` with DIFFERENT values (ambiguous)', () => {
      const r = tool.args.safeParse({ id: 'EI-1', body: 'x', summary: 'y' });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues.some((i) => /same field/i.test(i.message))).toBe(true);
    });

    it('ACCEPTS both `body` and `summary` when EQUAL (no false positive)', () => {
      expect(tool.args.safeParse({ id: 'EI-1', body: 'same', summary: 'same' }).success).toBe(true);
    });

    it('REJECTS an unknown field inside items:[…]', () => {
      expect(tool.args.safeParse({ items: [{ id: 'EI-1', notafield: 1 }] }).success).toBe(false);
    });
  });

  /* WI-41509 — the free-form payload merge and the guard that makes it safe.
   *
   * The capability exists because an existing item's payload was closed to agents: a plan
   * that ruled "stamp your verdict onto payload.<key>" was unsatisfiable, and the zero it
   * produced read as a skipped step rather than a missing tool (learning-loop triage
   * D-004/D-058). The guard exists because payload also carries ADMISSION IDENTITY —
   * `payload ? 'plan_item'` admits an item into a plan-scoped fleet lane — so a merge that
   * could write those keys would let any caller forge admission or wedge a claim floor.
   *
   * FALSIFIABILITY: `refusesEverything` / `refusesNothing` below are deliberately-wrong
   * implementations kept permanently in-file as controls. They must FAIL the same
   * assertions the real guard passes — otherwise these tests would still be green against
   * a guard that had stopped discriminating, which is the failure mode a guard test exists
   * to catch. The substring case is the calibration: it is the one a naive `includes()`
   * implementation gets wrong while passing every other assertion here. */
  describe('payload merge guard (WI-41509)', () => {
    const refusesEverything = (p: Record<string, unknown> | undefined) => Object.keys(p ?? {});
    const refusesNothing = (_p: Record<string, unknown> | undefined) => [] as string[];

    it('refuses admission, claim-state and _-prefixed keys — and accepts ordinary ones', () => {
      expect(reservedPayloadKeys({ plan_item: {} })).toEqual(['plan_item']);
      expect(reservedPayloadKeys({ claim_hold_by: 'x' })).toEqual(['claim_hold_by']);
      expect(reservedPayloadKeys({ needsOwnerAction: true })).toEqual(['needsOwnerAction']);
      expect(reservedPayloadKeys({ _ei: 1 })).toEqual(['_ei']);
      expect(reservedPayloadKeys({ _somethingInventedTomorrow: 1 })).toEqual([
        '_somethingInventedTomorrow',
      ]);
      expect(reservedPayloadKeys({ triage: { merit: 'M1' } })).toEqual([]);
      expect(reservedPayloadKeys(undefined)).toEqual([]);
    });

    it('CALIBRATION: a key merely CONTAINING a reserved name is allowed (exact match, not substring)', () => {
      // A naive `includes()` guard passes every assertion above and fails this one.
      expect(reservedPayloadKeys({ my_plan_item_notes: 1, triage_lane_summary: 1 })).toEqual([]);
    });

    it('CONTROL: deliberately-wrong guards fail the assertions the real guard passes', () => {
      expect(refusesEverything({ triage: 1 })).not.toEqual([]); // over-refuses a legal key
      expect(refusesNothing({ plan_item: {} })).not.toEqual(['plan_item']); // under-refuses admission
    });

    it('MERGES a free-form key without disturbing siblings, via mergeWorkItemPayload', async () => {
      mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-1' }) });
      mockResolvedTyped(
        mergeM,
        workItemFixture({ id: 'EI-1', payload: { _ei: 1, triage: { merit: 'M1' } } }),
      );
      await body({ id: 'EI-1', payload: { triage: { merit: 'M1' } } });
      // The patch is passed through verbatim — a shallow jsonb merge, never a replace.
      expect(mergeM).toHaveBeenCalledWith('EI-1', { triage: { merit: 'M1' } }, { harness: undefined });
    });

    it('REFUSES BEFORE ANY WRITE — a reserved key leaves no half-applied column edit', async () => {
      const b = await body({ id: 'EI-1', title: 'new title', payload: { plan_item: { a: 1 } } });
      expect(b.results[0].ok).toBe(false);
      expect(b.results[0].error).toMatch(/plan_item/);
      // The load-bearing half: the title edit must NOT have landed under the error.
      expect(updM).not.toHaveBeenCalled();
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('reserves agent-review workflow authority and readiness from generic replacement', () => {
      expect(reservedPayloadKeys({
        agentReview: { status: 'revision-submitted', round: 1 },
        implementationReadiness: { status: 'ready' },
      })).toEqual(['agentReview', 'implementationReadiness']);
    });

    it.each(['agentReview', 'implementationReadiness'] as const)(
      'refuses a generic %s replacement before any write and names its lifecycle owner',
      async (key) => {
        const b = await body({ id: 'EI-1', title: 'new title', payload: { [key]: { status: 'revision-submitted' } } });
        expect(b.results[0].ok).toBe(false);
        expect(b.results[0].error).toMatch(new RegExp(key));
        expect(b.results[0].error).toMatch(/agent-review lifecycle/);
        expect(updM).not.toHaveBeenCalled();
        expect(mergeM).not.toHaveBeenCalled();
      },
    );

    // WI-6554700010030345: externalBlockers bypassed wait-ref admission through this merge.
    // The payload below is the shape actually written on 2026-10-22 — an active event wait
    // on the broad `git-sync:committed` wake, which set_blocker's admission refuses.
    it('reserves externalBlockers, including a clearing [] (it would also erase history)', () => {
      expect(reservedPayloadKeys({ externalBlockers: [] })).toEqual(['externalBlockers']);
      // Calibration: an ordinary key that merely contains the name stays writable.
      expect(reservedPayloadKeys({ externalBlockersNote: 'x' })).toEqual([]);
    });

    it('REFUSES an externalBlockers merge before any write and names work_items:set_blocker', async () => {
      const b = await body({
        id: 'EI-1',
        title: 'new title',
        payload: {
          externalBlockers: [
            { ref: 'git-sync:committed', kind: 'event', status: 'active', summary: 'waiting for git-sync' },
          ],
        },
      });
      expect(b.results[0].ok).toBe(false);
      expect(b.results[0].error).toMatch(/externalBlockers/);
      expect(b.results[0].error).toMatch(/work_items:set_blocker/);
      expect(updM).not.toHaveBeenCalled();
      expect(mergeM).not.toHaveBeenCalled();
    });

    it('keeps the externalBlockers redirect off refusals of other reserved keys', async () => {
      const b = await body({ id: 'EI-1', payload: { plan_item: { a: 1 } } });
      expect(b.results[0].error).not.toMatch(/set_blocker/);
    });
  });
});

describe('work_items:update field authority (enterprise-data-sources P-020)', () => {
  it('refuses a title edit on an admitted item before any write', async () => {
    refuseM.mockResolvedValueOnce({
      code: 'field_owned_by_source',
      message: 'title on EI-9 is owned by its source (record r-1)',
      fields: ['title'],
    });
    const b = await body({ id: 'EI-9', title: 'renamed' });
    expect(refuseM).toHaveBeenCalledWith('ws-test', 'EI-9', ['title']);
    expect(updM).not.toHaveBeenCalled();
    expect(b.results[0]).toMatchObject({ ok: false, id: 'EI-9' });
    expect(String(b.results[0].error)).toContain('field_owned_by_source');
  });

  it('passes both title and body to the guard and writes when the item was not admitted', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-1', title: 't' }) });
    await body({ id: 'EI-1', title: 't', body: 'b' });
    expect(refuseM).toHaveBeenCalledWith('ws-test', 'EI-1', ['title', 'body']);
    expect(updM).toHaveBeenCalledTimes(1);
  });

  it('does not consult admissions for an edit that touches neither title nor body', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-1' }) });
    await body({ id: 'EI-1', severity: 'major' });
    expect(refuseM).not.toHaveBeenCalled();
  });
});
