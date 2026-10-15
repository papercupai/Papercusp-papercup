/**
 * update.plan-item-clear.test.ts — `work_items:update { plan_item: null }` must CLEAR
 * the payload.plan_item stamp, on BOTH families, and retract the coverage edge it had
 * asserted (EI-20578964155166663).
 *
 * WHY THE ASSERTION IS SHAPED THE WAY IT IS — read before weakening it:
 * a jsonb null-merge does NOT clear a key. `payload || '{"plan_item":null}'` stores a
 * JSON null and leaves the key PRESENT: `payload ? 'plan_item'` stays TRUE and
 * `payload -> 'plan_item' IS NOT NULL` stays TRUE (`->` yields null::jsonb, not SQL
 * NULL). Both idioms are live in this repo's claim/admission floors, so the only
 * correct clear is a real UNSET (`payload - 'plan_item'`, i.e. mergeWorkItemPayload's
 * `unset` option). A test that asserts only "the merge was called with plan_item: null"
 * — or, at the PG layer, only `->>'plan_slug' IS NULL` — PASSES against the broken
 * null-merge implementation and is worthless. Hence expectStampCleared() below, which
 * asserts the patch carries NO plan_item key AND that `unset` names it; the control
 * test at the bottom proves that helper actually rejects the null-merge shape.
 *
 * In-tree (operator-core, tab-visible).
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/work_items/update.plan-item-clear.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockResolvedTyped } from '../../testing/typed-mock';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn(() => ({ ownerId: 'me' })) }));
// P-020 field-authority guard: no admissions by default; workspace pinned so the guard never reads the registry.
vi.mock('../../work-admission/admit', () => ({ refuseExternalOwnedPatch: vi.fn(async () => null) }));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'ws-test' }));
// The factory must name EVERY binding update.ts pulls from '../../work-items'.
// unlinkWorkItem is a STATIC import there, so omitting it here leaves it undefined at
// call time — and the clear path wraps it in try/catch, so the TypeError would be
// swallowed and this suite would pass while asserting nothing (EI-19395547021329946).
// getWorkItem is reached by DYNAMIC import on the feature-family path; vitest serves
// the same mock for it.
vi.mock('../../work-items', () => ({
  updateWorkItem: vi.fn(),
  mergeWorkItemPayload: vi.fn(),
  linkWorkItem: vi.fn(),
  unlinkWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  explainIssueClaimFloors: vi.fn(),
}));

import {
  updateWorkItem,
  mergeWorkItemPayload,
  linkWorkItem,
  unlinkWorkItem,
  getWorkItem,
} from '../../work-items';
const updM = vi.mocked(updateWorkItem);
const mergeM = vi.mocked(mergeWorkItemPayload);
const linkM = vi.mocked(linkWorkItem);
const unlinkM = vi.mocked(unlinkWorkItem);
const getM = vi.mocked(getWorkItem);
const tool = (await import('./update')).default;

type Out = { data: any };
const body = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, {} as never)) as Out).data;

const STAMP = { plan_slug: 'plan-a', item_id: 'P-004', harness_slug: 'papercusp' };

import { workItemFixture } from '../../testing/work-item-fixture';

/** The clear must be an UNSET, never a null-merge. Both halves are load-bearing:
 * the missing key rules out `{ plan_item: null }`, and the unset list is what makes
 * the write actually remove it. */
function expectStampCleared(patch: Record<string, unknown>, opts: { unset?: readonly string[] }) {
  expect(Object.keys(patch)).not.toContain('plan_item');
  expect(opts.unset ?? []).toContain('plan_item');
}

beforeEach(() => vi.clearAllMocks());

describe('work_items:update { plan_item: null } clears the stamp', () => {
  it('ISSUE family: unsets the payload key instead of null-merging it', async () => {
    mockResolvedTyped(updM, {
      ok: true,
      item: workItemFixture({ id: 'EI-1', harness: 'papercusp', payload: { plan_item: STAMP } }),
    });
    mockResolvedTyped(mergeM, workItemFixture({ id: 'EI-1', harness: 'papercusp', payload: {} }));

    const b = await body({ id: 'EI-1', harness: 'papercusp', plan_item: null });

    expect(mergeM).toHaveBeenCalledTimes(1);
    const [id, patch, opts] = mergeM.mock.calls[0] as [string, Record<string, unknown>, { unset?: string[] }];
    expect(id).toBe('EI-1');
    expectStampCleared(patch, opts);
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
  });

  it('ISSUE family: retracts the coverage edge the outgoing stamp had asserted', async () => {
    mockResolvedTyped(updM, {
      ok: true,
      item: workItemFixture({ id: 'EI-1', harness: 'papercusp', payload: { plan_item: STAMP } }),
    });
    mockResolvedTyped(mergeM, workItemFixture({ id: 'EI-1', harness: 'papercusp', payload: {} }));

    await body({ id: 'EI-1', harness: 'papercusp', plan_item: null });

    // The ref comes from the OUTGOING stamp — readable only before the unset lands.
    expect(unlinkM).toHaveBeenCalledWith(
      'EI-1',
      { kind: 'plan_item', ref: 'plan-a#P-004' },
      'relates',
      { harness: 'papercusp' },
    );
    expect(linkM).not.toHaveBeenCalled();
  });

  it('ISSUE family: an item carrying no stamp clears cleanly and retracts nothing', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-2', harness: 'papercusp', payload: {} }) });
    mockResolvedTyped(mergeM, workItemFixture({ id: 'EI-2', harness: 'papercusp', payload: {} }));

    const b = await body({ id: 'EI-2', harness: 'papercusp', plan_item: null });

    const [, patch, opts] = mergeM.mock.calls[0] as [string, Record<string, unknown>, { unset?: string[] }];
    expectStampCleared(patch, opts);
    expect(unlinkM).not.toHaveBeenCalled();
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
  });

  it('FEATURE family: the unsupported_family path unsets too, rather than silently no-opping', async () => {
    // This is the path the defect report called out: planItemPayloadPatch emits {} for a
    // clear, so without an explicit unset the handler reported ok while writing nothing.
    mockResolvedTyped(updM, { ok: false, reason: 'unsupported_family' });
    mockResolvedTyped(getM, workItemFixture({ id: 'F-1', family: 'feature', kind: 'feature', payload: { plan_item: STAMP } }));
    mockResolvedTyped(mergeM, workItemFixture({ id: 'F-1', family: 'feature', kind: 'feature', payload: {} }));

    const b = await body({ id: 'F-1', harness: 'papercusp', plan_item: null });

    expect(mergeM).toHaveBeenCalledTimes(1);
    const [id, patch, opts] = mergeM.mock.calls[0] as [string, Record<string, unknown>, { unset?: string[] }];
    expect(id).toBe('F-1');
    expectStampCleared(patch, opts);
    expect(unlinkM).toHaveBeenCalledWith(
      'F-1',
      { kind: 'plan_item', ref: 'plan-a#P-004' },
      'relates',
      { harness: 'papercusp' },
    );
    expect(b).toMatchObject({ ok: true, counts: { ok: 1, failed: 0 } });
  });

  it('SET is unaffected: a real plan_item still writes the stamp and passes no unset', async () => {
    mockResolvedTyped(updM, { ok: true, item: workItemFixture({ id: 'EI-3', harness: 'papercusp' }) });
    mockResolvedTyped(mergeM, workItemFixture({ id: 'EI-3', harness: 'papercusp', payload: { plan_item: STAMP } }));

    await body({ id: 'EI-3', harness: 'papercusp', plan_item: { slug: 'plan-a', item: 'P-004' } });

    expect(mergeM).toHaveBeenCalledWith('EI-3', { plan_item: STAMP }, { harness: 'papercusp' });
    expect(linkM).toHaveBeenCalledWith(
      'EI-3',
      { kind: 'plan_item', ref: 'plan-a#P-004' },
      'relates',
      { harness: 'papercusp', by: 'me' },
    );
    expect(unlinkM).not.toHaveBeenCalled();
  });
});

describe('control: the clear assertion is falsifiable', () => {
  it('expectStampCleared REJECTS the null-merge shape a naive fix would produce', () => {
    // Calibration, not ceremony: if this helper ever stops rejecting the broken shape,
    // every test above passes vacuously. Kept as a permanent in-file control so the
    // proof never requires mutating production code (a shared-tree mutation this repo
    // forbids — the git-sync sweep can commit the mutant).
    expect(() => expectStampCleared({ plan_item: null }, {})).toThrow();
    expect(() => expectStampCleared({ plan_item: null }, { unset: ['plan_item'] })).toThrow();
    expect(() => expectStampCleared({}, {})).toThrow();
    // …and ACCEPTS the correct one.
    expect(() => expectStampCleared({}, { unset: ['plan_item'] })).not.toThrow();
  });
});
