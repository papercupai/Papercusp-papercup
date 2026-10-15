/**
 * Receive-side projection unit test (plan-federation-regrain P-006). In-memory
 * store + capturing recompose-sink + a flag stub — proves: a part op LWW-upserts
 * the part; the harness_plans recompose is FLAG-GATED (inert when OFF — the dark
 * guard); concurrent different-part ops merge into the recomposed content; a
 * malformed wire row is rejected.
 */
import { describe, it, expect } from 'vitest';
import type postgres from 'postgres';
import { InMemoryPlanPartsStore } from '../../../plan-parts/store';
import {
  buildHarnessPlanPartsProjection,
  createPlanPartsRecomposeBatch,
  _testing,
  type PlanPartWireRow,
} from './harness-plan-parts';
import { stampForcedPastWaiver, summarizeForcedPast } from '../../../agent-tools/plans/forced-past-stamp';
import { deriveIndexFromContent } from '../../../agent-tools/plans/derive-index';

function part(planSlug: string, partKey: string, body: string, overrides: Partial<PlanPartWireRow> = {}): PlanPartWireRow {
  return { harness_slug: 'h', plan_slug: planSlug, part_key: partKey, kind: 'item', body, ordinal: 0, tombstone: false, ...overrides };
}

function rig(flag: boolean) {
  const store = new InMemoryPlanPartsStore();
  const recomposed: Array<{ planSlug: string; content: string }> = [];
  const proj = buildHarnessPlanPartsProjection({
    workspaceId: 'ws',
    harnessSlug: 'h',
    store,
    isFlagOn: async () => flag,
    recomposeSink: async (planSlug, content) => { recomposed.push({ planSlug, content }); },
  });
  return { store, recomposed, proj };
}

describe('harness-plan-parts projection', () => {
  it('per-part recomposition refreshes legacy JSONB indexes from canonical content', async () => {
    const content = [
      '---',
      'slug: p1',
      'status: active',
      '---',
      '',
      '# Plan',
      '',
      '## Now',
      '',
      '**State:** active',
      '**Next:** keep both indexes aligned',
      '',
      '## Phase 1',
      '',
      '- **P-001** `todo` retain the item',
      '',
      '## Decisions',
      '',
      '### D-001 — retain the decision',
      'Date: 2026-10-08',
      'Preserve the decision body.',
    ].join('\n');
    const derived = deriveIndexFromContent(content);
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join(' ').replace(/\s+/g, ' ').trim().toUpperCase(), values });
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    const store = new InMemoryPlanPartsStore();
    const proj = buildHarnessPlanPartsProjection({
      workspaceId: 'ws',
      harnessSlug: 'h',
      store,
      sql,
      isFlagOn: async () => true,
      readLocalContent: async () => content,
    });

    await proj.writeToPg(
      part('p1', 'section:now', '## Now\n\nchanged', { kind: 'section' }),
      { authorPubkey: 'A', origin: 'remote', ts: 200 },
    );

    const update = calls.find((c) => c.text.startsWith('UPDATE HARNESS_SHARED.HARNESS_PLANS'))!;
    expect(update.text).toContain('ITEMS');
    expect(update.text).toContain('DECISIONS');
    expect(update.values).toContain(JSON.stringify(derived.items));
    expect(update.values).toContain(JSON.stringify(derived.decisions));
  });

  it('recomputes forced_past when a federated part recomposes canonical content', async () => {
    const baseline = stampForcedPastWaiver(
      '---\nslug: p1\nstatus: active\n---\n\n# Plan\n\n## Now\n\nold\n',
      {
        reason: 'verified exception',
        checks: ['audit_coverage_stale'],
        forcedBy: { ownerId: 'su-forcer', ownerLabel: 'Forcing agent' },
      },
      new Date('2026-08-20T22:30:00.000Z'),
    )!;
    const expected = summarizeForcedPast(baseline)!;
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join(' ').replace(/\s+/g, ' ').trim().toUpperCase(), values });
      return Promise.resolve([]);
    }) as unknown as postgres.Sql;
    const store = new InMemoryPlanPartsStore();
    const proj = buildHarnessPlanPartsProjection({
      workspaceId: 'ws',
      harnessSlug: 'h',
      store,
      sql,
      isFlagOn: async () => true,
      readLocalContent: async () => baseline,
    });

    await proj.writeToPg(
      part('p1', 'section:now', '## Now\n\nchanged', { kind: 'section' }),
      { authorPubkey: 'A', origin: 'remote', ts: 200 },
    );

    const update = calls.find((c) => c.text.startsWith('UPDATE HARNESS_SHARED.HARNESS_PLANS'))!;
    expect(update.text).toContain('FORCED_PAST');
    expect(update.values).toContain(JSON.stringify(expected));
  });

  it('composeKey == plan_slug/part_key (matches part_fed_key)', () => {
    expect(_testing.composeKey(part('p1', 'item:P-001', 'x'))).toBe('p1/item:P-001');
  });

  it('rejects a malformed wire row', () => {
    expect(_testing.decodeValue({ plan_slug: 'p' })).toBeNull();
    expect(_testing.decodeValue(part('p', 'item:P-001', 'x'))).not.toBeNull();
  });

  it('FLAG OFF: upserts the part but does NOT recompose harness_plans (dark guard)', async () => {
    const { store, recomposed, proj } = rig(false);
    await proj.writeToPg(part('p1', 'item:P-001', 'a'), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    expect((await store.getParts('p1')).get('item:P-001')?.text).toBe('a'); // part landed
    expect(recomposed).toEqual([]); // but harness_plans untouched
  });

  it('FLAG ON: recomposes harness_plans from merged parts; concurrent different parts both land', async () => {
    const { recomposed, proj } = rig(true);
    // Seed two parts so the recompose has structure.
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nbody'), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `todo` one', { ordinal: 1 }), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    // Two concurrent edits to DIFFERENT parts (different keys).
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `done` ONE by A', { ordinal: 1 }), { authorPubkey: 'A', origin: 'remote', ts: 200 });
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nB EDIT'), { authorPubkey: 'B', origin: 'remote', ts: 201 });
    const last = recomposed.at(-1)!.content;
    expect(last).toContain('`done` ONE by A'); // A's part
    expect(last).toContain('B EDIT'); // B's part — both survive in the recompose
  });

  it('FLAG ON: same-key older op is dropped (LWW)', async () => {
    const { recomposed, proj } = rig(true);
    await proj.writeToPg(part('p1', 'item:P-001', 'new', { ordinal: 0 }), { authorPubkey: 'A', origin: 'remote', ts: 200 });
    await proj.writeToPg(part('p1', 'item:P-001', 'stale', { ordinal: 0 }), { authorPubkey: 'B', origin: 'remote', ts: 150 });
    expect(recomposed.at(-1)!.content).toContain('new');
    expect(recomposed.at(-1)!.content).not.toContain('stale');
  });

  it('drops a part for a foreign harness_slug', async () => {
    const { store, proj } = rig(true);
    await proj.writeToPg(part('p1', 'item:P-001', 'x', { harness_slug: 'other' }), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    expect((await store.getParts('p1')).size).toBe(0);
  });
});

/**
 * WI-2142064: applyPart()/deletePart() used to end in an UNCONDITIONAL recompose,
 * so N part ops for the SAME plan cost N full recomposes. With a recomposeBatch
 * threaded in, they mark the plan dirty instead — the batch drains ONCE, after
 * every op has landed, so N ops fold into exactly one recompose per distinct
 * dirty plan (still reflecting every op, since recompose always re-reads the
 * CURRENT merged parts from the store — never a stale snapshot from op #1).
 */
describe('harness-plan-parts projection — recomposeBatch coalescing (WI-2142064)', () => {
  function batchRig(flag = true) {
    const store = new InMemoryPlanPartsStore();
    const recomposed: Array<{ planSlug: string; content: string }> = [];
    const recomposeBatch = createPlanPartsRecomposeBatch();
    const proj = buildHarnessPlanPartsProjection({
      workspaceId: 'ws',
      harnessSlug: 'h',
      store,
      isFlagOn: async () => flag,
      recomposeSink: async (planSlug, content) => { recomposed.push({ planSlug, content }); },
      recomposeBatch,
    });
    return { store, recomposed, proj, recomposeBatch };
  }

  it('defers recompose across several same-plan ops, then drains to exactly ONE recompose reflecting all of them', async () => {
    const { recomposed, proj, recomposeBatch } = batchRig();
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nbody'), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `todo` one', { ordinal: 1 }), { authorPubkey: 'seed', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-001', '- **P-001** `done` ONE by A', { ordinal: 1 }), { authorPubkey: 'A', origin: 'remote', ts: 200 });
    await proj.writeToPg(part('p1', 'section:now', '## Now\n\nB EDIT'), { authorPubkey: 'B', origin: 'remote', ts: 201 });
    // Four ops for the SAME plan, none recomposed yet — the batch only marks dirty.
    expect(recomposed).toEqual([]);

    await recomposeBatch.drain();

    // Exactly one recompose, and it reflects EVERY op above (the last drain
    // always reads the CURRENT merged parts, not a stale snapshot).
    expect(recomposed).toHaveLength(1);
    expect(recomposed[0]!.planSlug).toBe('p1');
    expect(recomposed[0]!.content).toContain('`done` ONE by A');
    expect(recomposed[0]!.content).toContain('B EDIT');

    // Draining an already-drained (now-clean) batch is a no-op.
    await recomposeBatch.drain();
    expect(recomposed).toHaveLength(1);
  });

  it('drains each DISTINCT dirty plan exactly once, never cross-contaminating plans', async () => {
    const { recomposed, proj, recomposeBatch } = batchRig();
    await proj.writeToPg(part('p1', 'section:now', 'p1 body'), { authorPubkey: 'A', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p2', 'section:now', 'p2 body'), { authorPubkey: 'A', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-001', 'p1 item'), { authorPubkey: 'A', origin: 'remote', ts: 2 });

    await recomposeBatch.drain();

    expect(recomposed).toHaveLength(2); // one per distinct plan, not per op
    const bySlug = Object.fromEntries(recomposed.map((r) => [r.planSlug, r.content]));
    expect(bySlug.p1).toContain('p1 body');
    expect(bySlug.p1).toContain('p1 item');
    expect(bySlug.p2).toContain('p2 body');
    expect(bySlug.p2).not.toContain('p1');
  });

  it('FLAG OFF: still coalesces to zero recomposes (the dark guard applies inside recompose either way)', async () => {
    const { recomposed, proj, recomposeBatch } = batchRig(false);
    await proj.writeToPg(part('p1', 'item:P-001', 'a'), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    await proj.writeToPg(part('p1', 'item:P-002', 'b'), { authorPubkey: 'A', origin: 'remote', ts: 100 });
    await recomposeBatch.drain();
    expect(recomposed).toEqual([]);
  });

  it('a tombstone delete also coalesces through the same batch', async () => {
    const { store, recomposed, proj, recomposeBatch } = batchRig();
    await proj.writeToPg(part('p1', 'item:P-001', 'keep me'), { authorPubkey: 'A', origin: 'remote', ts: 1 });
    await proj.writeToPg(part('p1', 'item:P-002', 'delete me'), { authorPubkey: 'A', origin: 'remote', ts: 1 });
    expect(recomposed).toEqual([]); // still un-drained

    await proj.deleteFromPg('p1/item:P-002', 500);
    expect(recomposed).toEqual([]); // the delete ALSO just marks dirty, doesn't recompose inline

    await recomposeBatch.drain();

    expect(recomposed).toHaveLength(1); // both the two writes + the delete collapsed to one recompose
    expect(recomposed[0]!.content).toContain('keep me');
    expect(recomposed[0]!.content).not.toContain('delete me');
    expect((await store.getParts('p1')).has('item:P-002')).toBe(false); // tombstone removes the key
  });

  it('without a recomposeBatch (every existing caller), behavior is unchanged: inline recompose per op', async () => {
    const { recomposed, proj } = rig(true); // the ORIGINAL no-batch rig from above
    await proj.writeToPg(part('p1', 'item:P-001', 'a'), { authorPubkey: 'A', origin: 'remote', ts: 1 });
    expect(recomposed).toHaveLength(1); // already recomposed — no drain call needed/available
  });
});

/**
 * WI-5720 — a part op tagged with a RETIRED harness slug must canonicalize at the same
 * wire boundary as the plan ROW (projections/harness-plans.ts). If the two disagree the
 * parts land in one partition and the recomposed document in another, so the recompose
 * targets a harness_plans row that does not exist. Observed live: inbound federation
 * wrote 2066 `papercup` parts alongside 78 `papercup` plan rows in July 2026, months
 * after the rename.
 */
describe('harness-plan-parts projection — retired harness_slug canonicalization (WI-5720)', () => {
  it('rewrites a retired papercup slug to papercusp at the wire boundary', () => {
    expect(_testing.decodeValue(part('p1', 'item:P-001', 'x', { harness_slug: 'papercup' }))?.harness_slug)
      .toBe('papercusp');
    expect(_testing.decodeValue(part('p1', 'item:P-001', 'x', { harness_slug: 'papercup-hive' }))?.harness_slug)
      .toBe('papercusp');
  });

  it('leaves a live slug untouched, by reference', () => {
    const row = part('p1', 'item:P-001', 'x', { harness_slug: 'oddsmith-hive' });
    expect(_testing.decodeValue(row)).toBe(row);
  });

  it('a retired-slug part APPLIES to the canonical harness instead of being dropped as foreign', async () => {
    // The receiver is bound to `papercusp`; a peer still tagging `papercup` used to fall
    // through applyPart's cross-member path and write under the dead slug. Canonicalized,
    // it is an own-slug op and lands in the receiver's own store.
    const store = new InMemoryPlanPartsStore();
    const proj = buildHarnessPlanPartsProjection({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      store,
      isFlagOn: async () => true,
      recomposeSink: async () => {},
    });
    const decoded = _testing.decodeValue(part('p1', 'item:P-001', 'x', { harness_slug: 'papercup' }))!;
    await proj.writeToPg(decoded, { authorPubkey: 'A', origin: 'remote', ts: 100 });
    expect((await store.getParts('p1')).size).toBe(1);
  });
});
