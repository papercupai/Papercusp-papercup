/**
 * typed-properties.test.ts — the pure typed-property core
 * (work-on-everything-goal-2026-08-23 P-023 / WI-41047).
 *
 * Pins prepareTypedPropertyMutation (CAS incl. 0-means-unset, editable_by
 * authorization, unknown property, injected datatype validation, envelope
 * build + prior-value fallback to the declaration default) and
 * renderPropertyDelta (the orient-fold delta line).
 */
import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { PrepareTypedPropertyMutationArgs } from './typed-properties';
import {
  OrderedSelectionPolicySchema,
  TypedPropertySchemaDocumentSchema,
  orderedSelectionPolicyPayloadSchema,
  readTypedPropertyCollection,
} from './typed-properties';
import { checkAgainstJsonSchema } from './json-schema-validation';

// Copy-out falsifiability probes exercise the unchanged suite against a relocated
// subject. Ordinary CI always uses the real module; no in-tree mutation is needed.
const { prepareTypedPropertyMutation, renderPropertyDelta }: typeof import('./typed-properties') =
  process.env.PAPERCUSP_TYPED_PROPERTY_PROBE
    ? await import(/* @vite-ignore */ pathToFileURL(process.env.PAPERCUSP_TYPED_PROPERTY_PROBE).href)
    : await import('./typed-properties');

const SCHEMA = {
  worklist: { datatype: 'string-list', default: ['perf'], editable_by: 'both' },
  budget: { datatype: 'usd', editable_by: 'owner' },
  notes: { datatype: 'prose', editable_by: 'agent' },
} as const;

const okValidate: PrepareTypedPropertyMutationArgs['validate'] = () => ({ ok: true });

const base = (over: Partial<PrepareTypedPropertyMutationArgs>): PrepareTypedPropertyMutationArgs => ({
  propertySchema: SCHEMA,
  properties: {},
  property: 'worklist',
  value: ['docs sweeps'],
  expectedVersion: 0,
  provenance: 'owner-edit',
  actorId: 'avi',
  validate: okValidate,
  ...over,
});

describe('P-023: prepareTypedPropertyMutation', () => {
  it('bad_property_schema on a malformed declaration document', () => {
    const r = prepareTypedPropertyMutation(base({ propertySchema: { 'BAD NAME': { datatype: 'x', editable_by: 'both' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_property_schema');
  });

  it('bad_properties on a malformed stored document', () => {
    const r = prepareTypedPropertyMutation(base({ properties: { worklist: { value: 1 } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad_properties');
  });

  it('unknown_property when the name is not declared', () => {
    const r = prepareTypedPropertyMutation(base({ property: 'nope' }));
    expect(r).toMatchObject({ ok: false, code: 'unknown_property', property: 'nope' });
  });

  it('forbidden: an agent-edit on an owner-only property (and vice versa)', () => {
    const agentOnOwner = prepareTypedPropertyMutation(
      base({ property: 'budget', provenance: 'agent-edit', value: 5 }),
    );
    expect(agentOnOwner).toMatchObject({
      ok: false,
      code: 'forbidden',
      editableBy: 'owner',
      refusal: {
        observed: { property: 'budget', editableBy: 'owner', actor: 'agent', provenance: 'agent-edit' },
        whoCanMakeItTrue: ['owner'],
      },
    });
    const ownerOnAgent = prepareTypedPropertyMutation(
      base({ property: 'notes', provenance: 'owner-edit', value: 'x' }),
    );
    expect(ownerOnAgent).toMatchObject({
      ok: false,
      code: 'forbidden',
      editableBy: 'agent',
      refusal: { whoCanMakeItTrue: ['another-agent'] },
    });
  });

  it('stale: expectedVersion must match (0 = unset)', () => {
    // Unset property, caller claims version 3 → stale with actual 0.
    const claimed = prepareTypedPropertyMutation(base({ expectedVersion: 3 }));
    expect(claimed).toMatchObject({ ok: false, code: 'stale', expectedVersion: 3, actualVersion: 0 });
    // Set property at version 2, caller claims 1 → stale with actual 2.
    const stored = {
      worklist: {
        value: ['perf'],
        version: 2,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit',
      },
    };
    const behind = prepareTypedPropertyMutation(base({ properties: stored, expectedVersion: 1 }));
    expect(behind).toMatchObject({ ok: false, code: 'stale', expectedVersion: 1, actualVersion: 2 });
  });

  it('invalid_value carries the injected validator issues + the datatype ref', () => {
    const r = prepareTypedPropertyMutation(
      base({ validate: () => ({ ok: false, issues: ['/0 must be string'] }) }),
    );
    expect(r).toMatchObject({
      ok: false,
      code: 'invalid_value',
      datatype: 'string-list',
      issues: ['/0 must be string'],
    });
  });

  it('blocks an array-length reduction unless the caller explicitly confirms the shrink', () => {
    const stored = {
      worklist: {
        value: ['first', 'second', 'third'],
        version: 4,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit' as const,
      },
    };

    const blocked = prepareTypedPropertyMutation(
      base({ properties: stored, expectedVersion: 4, value: ['first'] }),
    );
    expect(blocked).toEqual({
      ok: false,
      code: 'shrink_blocked',
      property: 'worklist',
      priorLength: 3,
      proposedLength: 1,
      actualVersion: 4,
      recovery: { confirmShrink: true },
      // WI-10005197: a fail-closed refusal states what lifts it and who can make that true.
      refusal: {
        observed: { property: 'worklist', priorLength: '3', proposedLength: '1' },
        liftsWhen: expect.stringContaining('confirmShrink:true'),
        whoCanMakeItTrue: ['self'],
      },
    });

    const confirmed = prepareTypedPropertyMutation(
      base({
        properties: stored,
        expectedVersion: 4,
        value: ['first'],
        confirmShrink: true,
      }),
    );
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.entry.value).toEqual(['first']);
    expect(confirmed.entry.version).toBe(5);
  });

  it('does not treat array growth, same-length replacement, or scalar writes as shrink', () => {
    const worklist = {
      value: ['first', 'second'],
      version: 2,
      edited_at: new Date().toISOString(),
      edited_by: 'avi',
      provenance: 'owner-edit' as const,
    };
    for (const value of [
      ['replacement', 'same-length'],
      ['first', 'second', 'third'],
    ]) {
      expect(
        prepareTypedPropertyMutation(
          base({ properties: { worklist }, expectedVersion: 2, value }),
        ).ok,
      ).toBe(true);
    }

    expect(
      prepareTypedPropertyMutation(
        base({ property: 'notes', value: 'short', provenance: 'agent-edit' }),
      ).ok,
    ).toBe(true);
  });

  it('reports stale before shrink_blocked when the caller version is not current', () => {
    const stored = {
      worklist: {
        value: ['first', 'second'],
        version: 3,
        edited_at: new Date().toISOString(),
        edited_by: 'avi',
        provenance: 'owner-edit' as const,
      },
    };
    expect(
      prepareTypedPropertyMutation(
        base({ properties: stored, expectedVersion: 2, value: [] }),
      ),
    ).toMatchObject({ ok: false, code: 'stale', actualVersion: 3 });
  });

  it('ok: envelope build — version bump, provenance + actor stamp, merged document', () => {
    const r = prepareTypedPropertyMutation(base({}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entry.version).toBe(1);
    expect(r.entry.provenance).toBe('owner-edit');
    expect(r.entry.edited_by).toBe('avi');
    expect(r.entry.value).toEqual(['docs sweeps']);
    // priorValue falls back to the DECLARATION default when unset.
    expect(r.priorValue).toEqual(['perf']);
    expect(r.priorVersion).toBe(0);
    expect(r.properties.worklist).toBe(r.entry);
  });

  it('ok: a second write increments the stored version and reports the stored prior', () => {
    const first = prepareTypedPropertyMutation(base({}));
    if (!first.ok) throw new Error('first write refused');
    const second = prepareTypedPropertyMutation(
      base({
        properties: first.properties,
        expectedVersion: 1,
        value: ['docs sweeps', 'gate triage'],
        provenance: 'agent-edit',
        actorId: 'su-1',
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entry.version).toBe(2);
    expect(second.priorValue).toEqual(['docs sweeps']);
    expect(second.entry.provenance).toBe('agent-edit');
  });
  it('persists the owner reason with the CAS value and allows the next edit', () => {
    const first = prepareTypedPropertyMutation(base({ reason: '  Friday demo  ' }));
    if (!first.ok) throw new Error('first edit refused');
    expect(first.entry.reason).toBe('Friday demo');
    const stale = prepareTypedPropertyMutation(base({ properties: first.properties, reason: 'stale change' }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale');
    expect(first.properties.worklist.reason).toBe('Friday demo');
    const next = prepareTypedPropertyMutation(base({ properties: first.properties, expectedVersion: 1 }));
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.entry.reason).toBeUndefined();
  });
});

describe('P-023: renderPropertyDelta', () => {
  it('scalar-array diff renders +added −removed', () => {
    expect(renderPropertyDelta('worklist', ['perf'], ['docs sweeps'])).toBe(
      'worklist: +"docs sweeps" −"perf"',
    );
  });

  it('unset prior array renders additions only', () => {
    expect(renderPropertyDelta('worklist', undefined, ['a'])).toBe('worklist: +"a"');
  });

  it('identical arrays render unchanged', () => {
    expect(renderPropertyDelta('worklist', ['a'], ['a'])).toBe('worklist: unchanged');
  });

  it('scalars render prior → next, with ∅ for unset', () => {
    expect(renderPropertyDelta('budget', undefined, 500)).toBe('budget: ∅ → 500');
    expect(renderPropertyDelta('budget', 500, 750)).toBe('budget: 500 → 750');
  });

  it('long values are clipped to one line', () => {
    const long = 'x'.repeat(200);
    const line = renderPropertyDelta('notes', undefined, long);
    expect(line.length).toBeLessThan(80);
    expect(line).toContain('…');
  });
});

describe('opt-in typed collections and owner policies (P-002)', () => {
  const portable = {
    tea_choices: { datatype: 'list', default: ['mint', 'chamomile', 'rooibos'], editable_by: 'both',
      collection: { source: 'manual', policy: 'tea_policy', order: 'display', selectable: true, defaultSelected: true } },
    tea_policy: { datatype: 'ordered-selection-policy', default: { order: [], excluded: [] }, editable_by: 'owner' },
  } as const;
  const plans = {
    worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both',
      collection: { ...portable.tea_choices.collection, source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority' } },
    worklist_policy: portable.tea_policy,
  } as const;

  it('accepts both sources without changing a legacy declaration or its default order', () => {
    expect(TypedPropertySchemaDocumentSchema.parse(portable)).toEqual(portable);
    expect(TypedPropertySchemaDocumentSchema.parse(plans)).toEqual(plans);
    expect(TypedPropertySchemaDocumentSchema.parse(SCHEMA)).toEqual(SCHEMA);
  });

  it('leaves an unconfigured legacy collection and its saved plan order outside automatic enrollment', () => {
    const legacy = {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both',
        default: ['plan:legacy/default'] },
    };
    const properties = { worklist: { value: ['plan:legacy/beta', 'plan:legacy/alpha'],
      version: 7, edited_by: 'legacy-owner', provenance: 'owner-edit',
      edited_at: '2026-10-07T00:00:00Z' } };
    const before = structuredClone({ legacy, properties });
    for (const source of [undefined, { ok: true as const, items: ['plan:discovered/new'] },
      { ok: false as const, reason: 'discovery unavailable' }]) {
      expect(readTypedPropertyCollection({ propertySchema: legacy, properties,
        property: 'worklist', source })).toEqual({ ok: true, configured: false });
    }
    expect({ legacy, properties }).toEqual(before);
  });

  it('refuses a missing, self-referencing, agent-editable or wrong-datatype policy', () => {
    const { tea_policy: _policy, ...missing } = portable;
    const invalid = [missing,
      { ...portable, tea_choices: { ...portable.tea_choices, collection: { ...portable.tea_choices.collection, policy: 'tea_choices' } } },
      { ...portable, tea_policy: { ...portable.tea_policy, editable_by: 'both' } },
      { ...portable, tea_policy: { ...portable.tea_policy, datatype: 'record' } },
      { ...portable, tea_choices: { ...portable.tea_choices, collection: { ...portable.tea_choices.collection, source: 'eval' } } },
    ];
    for (const schema of invalid) expect(TypedPropertySchemaDocumentSchema.safeParse(schema).success).toBe(false);
  });

  it('checks policy defaults, unique collection ids and qualified active-plan identity', () => {
    for (const schema of [
      { ...portable, tea_choices: { ...portable.tea_choices, default: ['mint', 'mint'] } },
      { ...portable, tea_policy: { ...portable.tea_policy, default: { order: ['mint', 'mint'], excluded: [] } } },
      { ...plans, worklist: { ...plans.worklist, default: ['plan:ambiguous'] } },
      { ...plans, worklist_policy: { ...plans.worklist_policy, default: { order: [], excluded: ['plan:ambiguous'] } } },
      { ...plans, worklist: { ...plans.worklist, datatype: 'list' } },
    ]) expect(TypedPropertySchemaDocumentSchema.safeParse(schema).success).toBe(false);
    expect(TypedPropertySchemaDocumentSchema.safeParse({ ...plans,
      worklist: { ...plans.worklist, default: ['plan:one/shared', 'plan:two/shared'] },
    }).success).toBe(true);
  });

  it('the pure policy and registry validator reject the same malformed values', () => {
    for (const value of [
      { order: [], excluded: [] },
      { order: ['mint'], excluded: ['rooibos'] },
      { order: ['mint', 'mint'], excluded: [] },
      { order: [], excluded: ['mint', 'mint'] },
      { order: [], excluded: [] , selected: [] },
      { order: [], excluded: [1] },
      { order: [''], excluded: [] },
      { order: [] },
      null,
    ]) expect(checkAgainstJsonSchema(orderedSelectionPolicyPayloadSchema(), value).ok)
      .toBe(OrderedSelectionPolicySchema.safeParse(value).success);
  });

  it('stores owner choices with CAS/provenance while independent agent source writes preserve the policy', () => {
    const first = prepareTypedPropertyMutation(base({ propertySchema: portable, property: 'tea_policy',
      value: { order: ['rooibos', 'mint'], excluded: ['chamomile'] } }));
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('owner policy refused');
    expect(first.entry).toMatchObject({ version: 1, provenance: 'owner-edit', edited_by: 'avi' });
    const update = prepareTypedPropertyMutation(base({ propertySchema: portable, properties: first.properties,
      property: 'tea_choices', value: ['mint', 'chamomile', 'rooibos', 'hibiscus'], provenance: 'agent-edit' }));
    expect(update.ok).toBe(true);
    if (!update.ok) throw new Error('source update refused');
    expect(update.properties.tea_policy).toEqual(first.entry);
    expect(prepareTypedPropertyMutation(base({ propertySchema: portable, properties: update.properties,
      property: 'tea_policy', expectedVersion: 1, value: { order: [], excluded: [] }, provenance: 'agent-edit' })))
      .toMatchObject({ ok: false, code: 'forbidden', editableBy: 'owner' });
    expect(prepareTypedPropertyMutation(base({ propertySchema: portable, properties: update.properties,
      property: 'tea_policy', expectedVersion: 0, value: { order: [], excluded: [] } })))
      .toMatchObject({ ok: false, code: 'stale', actualVersion: 1 });
  });

  it('retains dormant preferences but refuses malformed and ambiguous policy writes', () => {
    expect(prepareTypedPropertyMutation(base({ propertySchema: portable, property: 'tea_policy',
      value: { order: ['temporarily-absent'], excluded: ['not-currently-listed'] } })).ok).toBe(true);
    for (const value of [
      { order: ['plan:ambiguous'], excluded: [] },
      { order: [], excluded: ['plan:ambiguous'] },
      { order: ['plan:one/shared', 'plan:one/shared'], excluded: [] },
    ]) expect(prepareTypedPropertyMutation(base({ propertySchema: plans, property: 'worklist_policy', value })))
      .toMatchObject({ ok: false, code: 'invalid_value' });
    expect(prepareTypedPropertyMutation(base({ propertySchema: plans, property: 'worklist_policy',
      value: { order: ['plan:one/shared', 'plan:two/shared'], excluded: ['plan:other/dormant'] } })).ok).toBe(true);
  });

  const entry = (value: unknown, version = 1) => ({ value, version,
    edited_at: '2026-10-08T01:00:00.000Z', edited_by: 'owner', provenance: 'owner-edit' });

  it('the same reader orders and selects a manual non-plan collection and discovered plans', () => {
    const manual = readTypedPropertyCollection({ propertySchema: portable,
      properties: { tea_policy: entry({ order: ['rooibos', 'mint'], excluded: ['chamomile'] }, 3) },
      property: 'tea_choices' });
    expect(manual).toMatchObject({ ok: true, configured: true, policyVersion: 3,
      items: [{ id: 'rooibos', selected: true }, { id: 'mint', selected: true }, { id: 'chamomile', selected: false }],
      selected: ['rooibos', 'mint'] });
    const discovered = readTypedPropertyCollection({ propertySchema: plans, property: 'worklist',
      properties: { worklist_policy: entry({ order: ['plan:one/b', 'plan:one/a'], excluded: ['plan:one/a'] }) },
      source: { ok: true, items: ['plan:one/a', 'plan:one/b', 'plan:one/c', 'plan:one/a'] } });
    expect(discovered).toMatchObject({ ok: true, items: [
      { id: 'plan:one/b', selected: true }, { id: 'plan:one/a', selected: false }, { id: 'plan:one/c', selected: true }],
      selected: ['plan:one/b', 'plan:one/c'] });
  });

  it('append, disappearance, reactivation and agent source edits preserve owner preferences', () => {
    const policy = entry({ order: ['rooibos', 'mint'], excluded: ['rooibos'] }, 4);
    const properties = { tea_policy: policy };
    const snapshot = structuredClone(properties);
    const read = (items: string[]) => readTypedPropertyCollection({ propertySchema: portable, properties,
      property: 'tea_choices', source: { ok: true, items } });
    expect(read(['mint', 'chamomile', 'rooibos', 'hibiscus'])).toMatchObject({
      selected: ['mint', 'chamomile', 'hibiscus'] });
    expect(read(['mint', 'hibiscus'])).toMatchObject({ selected: ['mint', 'hibiscus'], policy: policy.value });
    expect(read(['mint', 'rooibos', 'hibiscus'])).toMatchObject({
      items: [{ id: 'rooibos', selected: false }, { id: 'mint', selected: true }, { id: 'hibiscus', selected: true }] });
    expect(properties).toEqual(snapshot);
  });

  it('discovers scheduled plan runs and persists their owner exclusions without poisoning ordinary plans', () => {
    const run = 'plan:one/nightly@run-1786557604333';
    const first = prepareTypedPropertyMutation(base({ propertySchema: plans, property: 'worklist_policy',
      value: { order: [run, 'plan:one/a'], excluded: [run] } }));
    expect(first).toMatchObject({ ok: true, entry: { version: 1, provenance: 'owner-edit' } });
    if (!first.ok) throw new Error('scheduled plan policy refused');
    expect(readTypedPropertyCollection({ propertySchema: plans, property: 'worklist', properties: first.properties,
      source: { ok: true, items: ['plan:one/a', run, 'plan:one/b'] } }))
      .toMatchObject({ ok: true, selected: ['plan:one/a', 'plan:one/b'], items: [
        { id: run, selected: false }, { id: 'plan:one/a', selected: true }, { id: 'plan:one/b', selected: true },
      ] });
    expect(prepareTypedPropertyMutation(base({ propertySchema: plans, property: 'worklist_policy',
      properties: first.properties, expectedVersion: 0, value: { order: [run], excluded: [] } })))
      .toMatchObject({ ok: false, code: 'stale', actualVersion: 1 });
    for (const invalid of ['plan:nightly@run-123', 'plan:one/nightly@run-token', 'plan:one/nightly@run-123/extra']) {
      expect(readTypedPropertyCollection({ propertySchema: plans, property: 'worklist', properties: {},
        source: { ok: true, items: ['plan:one/a', invalid] } })).toMatchObject({ ok: false });
    }
  });

  it('an initially unchecked collection uses explicit inclusions, and exclusion always wins', () => {
    const unchecked = { ...portable, tea_choices: { ...portable.tea_choices,
      collection: { ...portable.tea_choices.collection, defaultSelected: false } } };
    expect(readTypedPropertyCollection({ propertySchema: unchecked, properties: {}, property: 'tea_choices' }))
      .toMatchObject({ selected: [] });
    expect(readTypedPropertyCollection({ propertySchema: unchecked, property: 'tea_choices',
      properties: { tea_policy: entry({ order: ['rooibos'], included: ['mint', 'rooibos'], excluded: ['rooibos'] }) } }))
      .toMatchObject({ selected: ['mint'] });
    expect(readTypedPropertyCollection({ propertySchema: portable, property: 'tea_choices',
      properties: { tea_policy: entry({ order: [], excluded: [] }) } }))
      .toMatchObject({ selected: ['mint', 'chamomile', 'rooibos'] });
  });

  describe('only plans I pick: an unchecked registered source seeds picks from the stored list', () => {
    const picked = { ...plans, worklist: { ...plans.worklist,
      collection: { ...plans.worklist.collection, defaultSelected: false } } };
    const stored = (value: unknown) => ({ worklist: { ...entry(value, 14), edited_by: 'steward', provenance: 'agent-edit' } });
    const discovered = { ok: true as const, items: ['plan:one/c', 'plan:one/a', 'plan:one/b', 'plan:one/d'] };

    it('selects exactly the stored list, in its order, and flags the policy as derived', () => {
      const properties = stored(['plan:one/b', 'plan:one/a']);
      const snapshot = structuredClone(properties);
      const read = readTypedPropertyCollection({ propertySchema: picked, properties, property: 'worklist', source: discovered });
      expect(read).toMatchObject({ ok: true, configured: true, policyVersion: 0, seededFromList: true,
        policy: { order: ['plan:one/b', 'plan:one/a'], excluded: [], included: ['plan:one/b', 'plan:one/a'] },
        items: [{ id: 'plan:one/b', selected: true }, { id: 'plan:one/a', selected: true },
          { id: 'plan:one/c', selected: false }, { id: 'plan:one/d', selected: false }],
        selected: ['plan:one/b', 'plan:one/a'] });
      expect(properties).toEqual(snapshot);
    });

    it('the seeded policy is exactly what the owner can persist at expectedVersion 0', () => {
      const properties = stored(['plan:one/b']);
      const read = readTypedPropertyCollection({ propertySchema: picked, properties, property: 'worklist', source: discovered });
      if (!read.ok || !read.configured) throw new Error('seed unavailable');
      const write = prepareTypedPropertyMutation(base({ propertySchema: picked, properties,
        property: 'worklist_policy', value: { ...read.policy, included: [...read.policy.included!, 'plan:one/d'] } }));
      expect(write).toMatchObject({ ok: true, entry: { version: 1, provenance: 'owner-edit' } });
      if (!write.ok) throw new Error('owner policy refused');
      const after = readTypedPropertyCollection({ propertySchema: picked, properties: write.properties,
        property: 'worklist', source: discovered });
      expect(after).toMatchObject({ policyVersion: 1, selected: ['plan:one/b', 'plan:one/d'] });
      expect(after).not.toHaveProperty('seededFromList');
    });

    it('a saved owner policy alone decides; the stored list no longer widens it', () => {
      const properties = { ...stored(['plan:one/a', 'plan:one/b']),
        worklist_policy: entry({ order: ['plan:one/c'], excluded: ['plan:one/a'], included: ['plan:one/c'] }, 2) };
      expect(readTypedPropertyCollection({ propertySchema: picked, properties, property: 'worklist', source: discovered }))
        .toMatchObject({ selected: ['plan:one/c'], policyVersion: 2 });
    });

    it('resolves a unique legacy shorthand and drops an ambiguous or unresolvable one', () => {
      const properties = stored(['plan:a', 'plan:shared', 'plan:missing']);
      const read = readTypedPropertyCollection({ propertySchema: picked, properties, property: 'worklist',
        source: { ok: true, items: ['plan:one/a', 'plan:one/shared', 'plan:two/shared'] } });
      expect(read).toMatchObject({ ok: true, selected: ['plan:one/a'], policy: { included: ['plan:one/a'] } });
    });

    it('never seeds a manual source, a default-selected source, or a declared default pick list', () => {
      const properties = stored(['plan:one/b']);
      expect(readTypedPropertyCollection({ propertySchema: plans, properties, property: 'worklist', source: discovered }))
        .toMatchObject({ selected: discovered.items });
      const declaredPicks = { ...picked, worklist_policy: { ...picked.worklist_policy,
        default: { order: [], excluded: [], included: ['plan:one/d'] } } };
      expect(readTypedPropertyCollection({ propertySchema: declaredPicks, properties, property: 'worklist', source: discovered }))
        .toMatchObject({ selected: ['plan:one/d'] });
      const unchecked = { ...portable, tea_choices: { ...portable.tea_choices,
        collection: { ...portable.tea_choices.collection, defaultSelected: false } } };
      expect(readTypedPropertyCollection({ propertySchema: unchecked, property: 'tea_choices',
        properties: { tea_choices: entry(['mint']) } })).toMatchObject({ selected: [] });
    });
  });

  it('source failures and malformed/agent-authored policies stay unavailable without a write', () => {
    const properties = { worklist_policy: entry({ order: [], excluded: ['plan:one/a'] }) };
    const snapshot = structuredClone(properties);
    expect(readTypedPropertyCollection({ propertySchema: plans, properties, property: 'worklist' }))
      .toMatchObject({ ok: false, reason: 'registered collection source is unavailable' });
    expect(readTypedPropertyCollection({ propertySchema: plans, properties, property: 'worklist',
      source: { ok: false, reason: 'provider offline' } })).toMatchObject({ ok: false, reason: 'provider offline' });
    expect(readTypedPropertyCollection({ propertySchema: plans, properties, property: 'worklist',
      source: { ok: true, items: ['plan:ambiguous'] } })).toMatchObject({ ok: false });
    expect(readTypedPropertyCollection({ propertySchema: plans, property: 'worklist',
      properties: { worklist_policy: { ...properties.worklist_policy, provenance: 'agent-edit' } },
      source: { ok: true, items: [] } })).toMatchObject({ ok: false });
    expect(properties).toEqual(snapshot);
    expect(readTypedPropertyCollection({ propertySchema: SCHEMA, properties: {}, property: 'worklist' }))
      .toEqual({ ok: true, configured: false });
  });
});
