/**
 * Pure parts of the item-type contract (plan-item-types-registry-cupboard-2026-10-20 P-004):
 * R-10's completion-field check and R-11's bar derivation, with no database.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ItemTypeContract, ItemTypeCriterion } from '../plan-verification-profile';
import { checkTypeFields, deriveItemTypeBars, itemTypeBarKey } from './item-type-contract';

const noDatatypes = vi.fn(async () => undefined);

function contract(extra: Partial<ItemTypeContract> & { id?: string } = {}): ItemTypeContract {
  return { id: 'acme/memo', revision: 3, contentHash: 'h'.repeat(64), ...extra };
}

describe('itemTypeBarKey', () => {
  it('namespaces the bar by item type and criterion, never colliding with an R-N requirement key', () => {
    expect(itemTypeBarKey('acme/memo', 'cites-sources')).toBe('T-acme--memo-cites-sources');
    expect(itemTypeBarKey('acme/memo', 'dated')).not.toBe(itemTypeBarKey('acme/note', 'dated'));
    expect(itemTypeBarKey('acme/memo', 'x')).not.toMatch(/^R-\d+$/);
  });
});

describe('checkTypeFields (R-10)', () => {
  const inline = contract({
    completion: { schema: { type: 'object', required: ['memoRef'], properties: { memoRef: { type: 'string' } } } },
  });

  it('passes an item type with no completion schema whatever the fields', async () => {
    await expect(checkTypeFields(contract(), { anything: 1 }, noDatatypes)).resolves.toEqual({ ok: true });
    await expect(checkTypeFields(undefined, undefined, noDatatypes)).resolves.toEqual({ ok: true });
  });

  it('validates fields against an inline schema, treating absent fields as an empty object', async () => {
    await expect(checkTypeFields(inline, { memoRef: 'docs/memo.md' }, noDatatypes)).resolves.toEqual({ ok: true });
    const missing = await checkTypeFields(inline, undefined, noDatatypes);
    expect(missing).toMatchObject({ ok: false, code: 'item_type_fields_invalid' });
    expect(missing.ok ? '' : missing.errors.join(' ')).toMatch(/memoRef/);
    await expect(checkTypeFields(inline, { memoRef: 7 }, noDatatypes)).resolves.toMatchObject({
      ok: false,
      code: 'item_type_fields_invalid',
    });
  });

  it('resolves a datatype reference through the lookup and validates against its schema', async () => {
    const lookup = vi.fn(async (ref: string) =>
      ref === 'review' ? { type: 'object', required: ['reviewer'], properties: { reviewer: { type: 'string' } } } : undefined);
    const byRef = contract({ completion: { datatypeRef: 'review' } });
    await expect(checkTypeFields(byRef, { reviewer: 'r-1' }, lookup)).resolves.toEqual({ ok: true });
    await expect(checkTypeFields(byRef, {}, lookup)).resolves.toMatchObject({ ok: false, code: 'item_type_fields_invalid' });
    expect(lookup).toHaveBeenCalledWith('review');
  });

  it('refuses a datatype reference that does not resolve, naming the type and the datatype', async () => {
    const dangling = contract({ id: 'acme/dangling', completion: { datatypeRef: 'nowhere' } });
    const result = await checkTypeFields(dangling, { reviewer: 'r-1' }, noDatatypes);
    expect(result).toMatchObject({ ok: false, code: 'item_type_datatype_unresolved' });
    expect(result.ok ? '' : result.errors.join(' ')).toMatch(/acme\/dangling.*nowhere/);
  });

  it('treats a resolved datatype with no payload schema as no constraint', async () => {
    const schemaless = contract({ completion: { datatypeRef: 'free-form' } });
    await expect(checkTypeFields(schemaless, { any: 'thing' }, async () => null)).resolves.toEqual({ ok: true });
  });

  it('refuses a schema that cannot compile with its own code', async () => {
    const broken = contract({ completion: { datatypeRef: 'broken' } });
    await expect(checkTypeFields(broken, {}, async () => ({ type: 'not-a-json-type' }))).resolves.toMatchObject({
      ok: false,
      code: 'item_type_completion_schema_invalid',
    });
  });
});

describe('deriveItemTypeBars (R-11)', () => {
  const template: ItemTypeCriterion[] = [
    { key: 'cites-sources', title: 'Cites its sources', description: 'Every claim names its source.' },
    { key: 'dated', title: 'Dated' },
  ];
  const rubric = new Map<string, ItemTypeCriterion[]>([
    ['memo-review', [
      { key: 'reproducible', title: 'Reproducible', description: 'A reader can re-run it.' },
      { key: 'dated', title: 'Dated (rubric)', description: 'Rubric wording for the same criterion.' },
    ]],
  ]);

  it('makes one bar per template criterion, mapped to every item of the type', () => {
    const sourced = contract({ id: 'acme/sourced', criteriaTemplate: template });
    const result = deriveItemTypeBars(
      [{ itemId: 'P-001', contract: sourced }, { itemId: 'P-002', contract: undefined }, { itemId: 'P-003', contract: sourced }],
      new Map(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars).toEqual([
      {
        barKey: 'T-acme--sourced-cites-sources',
        title: 'Cites its sources',
        model: 'Every claim names its source.',
        planItemIds: ['P-001', 'P-003'],
        source: { itemType: 'acme/sourced', revision: 3, criterionKey: 'cites-sources' },
      },
      {
        barKey: 'T-acme--sourced-dated',
        title: 'Dated',
        model: 'Dated',
        planItemIds: ['P-001', 'P-003'],
        source: { itemType: 'acme/sourced', revision: 3, criterionKey: 'dated' },
      },
    ]);
  });

  it('adds the named rubric criteria, and the template wins where both define a key', () => {
    const both = contract({ id: 'acme/reviewed', criteriaTemplate: template, rubricRef: 'memo-review' });
    const result = deriveItemTypeBars([{ itemId: 'P-004', contract: both }], rubric);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bars.map((bar) => bar.barKey)).toEqual([
      'T-acme--reviewed-cites-sources',
      'T-acme--reviewed-dated',
      'T-acme--reviewed-reproducible',
    ]);
    const dated = result.bars.find((bar) => bar.barKey === 'T-acme--reviewed-dated')!;
    expect(dated.title).toBe('Dated');
    expect(dated.source.rubricRef).toBeUndefined();
    const reproducible = result.bars.find((bar) => bar.barKey === 'T-acme--reviewed-reproducible')!;
    expect(reproducible.source).toMatchObject({ rubricRef: 'memo-review', criterionKey: 'reproducible' });
    expect(reproducible.model).toBe('A reader can re-run it.');
  });

  it('reports each uninstalled rubric once and derives no bars', () => {
    const missing = contract({ id: 'acme/unreviewed', rubricRef: 'not-installed' });
    const result = deriveItemTypeBars(
      [{ itemId: 'P-001', contract: missing }, { itemId: 'P-002', contract: missing }],
      rubric,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ itemType: 'acme/unreviewed', rubricRef: 'not-installed' });
    expect(result.problems[0]!.detail).toMatch(/not installed/);
  });

  it('derives nothing for items whose type asks for no criteria', () => {
    const result = deriveItemTypeBars([{ itemId: 'P-001', contract: contract() }, { itemId: 'P-002', contract: undefined }], rubric);
    expect(result).toEqual({ ok: true, bars: [] });
  });
});
