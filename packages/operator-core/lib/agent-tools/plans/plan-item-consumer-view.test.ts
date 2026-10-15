/**
 * WI-10005199 — consumer attestation for a landed plan-item status flip.
 *
 * `plans:set-status` reports `ok` once the plan BODY write lands; every consumer reads the
 * derived `items` index + blocked-by graph. These tests pin the attestation against fixtures
 * where the two DIVERGE (and the one where they agree), so a regression that makes the block
 * unconditional, or that drops the divergence, fails here rather than at the ship gate.
 */
import { describe, expect, it } from 'vitest';
import {
  PLAN_ITEM_CONSUMER_READ_PATH,
  attestLandedPlanItemStatus,
  attestPlanItemConsumerView,
  type PlanItemConsumerReader,
} from './plan-item-consumer-view';

const reading =
  (items: Array<{ id: string; effectiveStatus?: string | null }> | null): PlanItemConsumerReader =>
  async () =>
    items;

describe('attestPlanItemConsumerView (pure)', () => {
  it('agrees when the consumer read returns the status that was written', () => {
    const view = attestPlanItemConsumerView({ itemId: 'P-001', status: 'done' }, [
      { id: 'P-001', effectiveStatus: 'done' },
    ]);
    expect(view.divergedFromWrite).toBe(false);
    expect(view.readPath).toBe(PLAN_ITEM_CONSUMER_READ_PATH);
    expect(view.value).toEqual({ itemId: 'P-001', status: 'done' });
  });

  it('diverges when the structured index still says todo after a done flip (the EI-23770243810745552 shape)', () => {
    const view = attestPlanItemConsumerView({ itemId: 'P-001', status: 'done' }, [
      { id: 'P-001', effectiveStatus: 'todo' },
    ]);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ itemId: 'P-001', status: 'todo' });
  });

  it('diverges when a todo flip reads blocked because blockedBy is unmet', () => {
    const view = attestPlanItemConsumerView({ itemId: 'P-002', status: 'todo' }, [
      { id: 'P-002', effectiveStatus: 'blocked' },
    ]);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value.status).toBe('blocked');
  });

  it('diverges (status null) when the item is absent from the consumer read', () => {
    const view = attestPlanItemConsumerView({ itemId: 'P-009', status: 'wip' }, [
      { id: 'P-001', effectiveStatus: 'wip' },
    ]);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value).toEqual({ itemId: 'P-009', status: null });
  });

  it('diverges (status null) when nothing is readable at all', () => {
    expect(attestPlanItemConsumerView({ itemId: 'P-001', status: 'done' }, null).divergedFromWrite).toBe(true);
  });

  it('diverges when the item is present but carries no effectiveStatus', () => {
    expect(
      attestPlanItemConsumerView({ itemId: 'P-001', status: 'done' }, [{ id: 'P-001', effectiveStatus: null }])
        .divergedFromWrite,
    ).toBe(true);
  });

  it('matches only the written item id, not a sibling that happens to carry the same status', () => {
    const view = attestPlanItemConsumerView({ itemId: 'P-002', status: 'done' }, [
      { id: 'P-001', effectiveStatus: 'done' },
      { id: 'P-002', effectiveStatus: 'todo' },
    ]);
    expect(view.divergedFromWrite).toBe(true);
    expect(view.value.status).toBe('todo');
  });
});

describe('attestLandedPlanItemStatus (bounded, fail-soft, exception-only)', () => {
  it('is silent (undefined) when the consumer read agrees — an ordinary flip response is unchanged', async () => {
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: reading([{ id: 'P-001', effectiveStatus: 'done' }]),
    });
    expect(out).toBeUndefined();
  });

  it('surfaces consumerView when the index disagrees with the write', async () => {
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: reading([{ id: 'P-001', effectiveStatus: 'todo' }]),
    });
    expect(out?.consumerView).toMatchObject({
      readPath: PLAN_ITEM_CONSUMER_READ_PATH,
      divergedFromWrite: true,
      value: { itemId: 'P-001', status: 'todo' },
    });
  });

  it('surfaces consumerView (status null) when the read returns nothing readable', async () => {
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: reading(null),
    });
    expect(out?.consumerView).toMatchObject({ divergedFromWrite: true, value: { status: null } });
  });

  it('passes the plan slug to the reader', async () => {
    const seen: string[] = [];
    await attestLandedPlanItemStatus({
      slug: 'plan-xyz',
      itemId: 'P-001',
      status: 'done',
      read: async (slug) => {
        seen.push(slug);
        return [{ id: 'P-001', effectiveStatus: 'done' }];
      },
    });
    expect(seen).toEqual(['plan-xyz']);
  });

  it('never throws on a rejecting reader: reports diverged instead of claiming agreement', async () => {
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: async () => {
        throw new Error('pg down');
      },
    });
    expect(out?.consumerView).toMatchObject({ divergedFromWrite: true, value: { status: null } });
  });

  it('never outlives timeoutMs on a hung reader: reports diverged', async () => {
    const startedAt = Date.now();
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: () => new Promise(() => {}),
      timeoutMs: 25,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(out?.consumerView).toMatchObject({ divergedFromWrite: true, value: { status: null } });
  });

  it('does not let a fast reader be pre-empted by the timeout', async () => {
    const out = await attestLandedPlanItemStatus({
      slug: 'demo-plan',
      itemId: 'P-001',
      status: 'done',
      read: reading([{ id: 'P-001', effectiveStatus: 'done' }]),
      timeoutMs: 25,
    });
    expect(out).toBeUndefined();
  });
});
