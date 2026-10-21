/**
 * The registry-backed verification resolver (plan-item-types-registry-cupboard-2026-10-20 P-002).
 *
 * R-5: code verification follows the RESOLVED module set: an item type is code exactly when
 *      its modules include `code`, whatever its id is called.
 * R-6: an unknown item type or plan type fails safe to the FULL module catalog, and activating
 *      a plan that references one is refused with the pack to install named.
 *
 * Registry fixtures are built through buildTypeRegistrySnapshot from definition rows, the same
 * path loadTypeRegistry takes over the Postgres rows, so the schema validation is exercised too.
 */
import { describe, expect, it } from 'vitest';
import {
  activationGateRefusalValue,
  evaluateConversationActivationGate,
  isActivationGateRefusalValue,
} from '../agent-tools/plans/plan-activation-gate';
import { resolveVerification, withVerificationResolver } from '../plan-verification-profile';
import { buildTypeRegistrySnapshot, type DefinitionRow } from './registry';
import {
  STRICTEST_MODULES,
  createRegistryVerificationResolver,
  findUnregisteredTypes,
  heldToPlanType,
  unregisteredTypesRefusal,
} from './resolve-verification';
import { VERIFICATION_MODULES } from './verification-modules';

function itemTypeRow(id: string, modules: string[], revision = 1, extra: Partial<DefinitionRow> = {}): DefinitionRow {
  return {
    type_id: id,
    revision,
    hive_slug: null,
    origin: 'pack',
    source_listing_id: 'listing-1',
    retired_at: null,
    // Every listed set names generic-core: a set without it is refused (R-9, definition-floor.test.ts).
    definition: { schemaVersion: 1, id, revision, title: id, modules: ['generic-core', ...modules] },
    ...extra,
  };
}

function planTypeRow(
  id: string,
  itemTypes: Array<{ id: string; minRevision?: number; maxRevision?: number }>,
  defaultItemType: string,
  base: 'coding' | 'general' = 'general',
): DefinitionRow {
  return {
    type_id: id,
    revision: 1,
    hive_slug: null,
    origin: 'pack',
    source_listing_id: 'listing-2',
    retired_at: null,
    definition: {
      schemaVersion: 1,
      id,
      revision: 1,
      title: id,
      base,
      classes: ['plan-class-feature-ship'],
      defaultItemType: { id: defaultItemType },
      itemTypes,
    },
  };
}

const REGISTRY = buildTypeRegistrySnapshot({
  itemTypeRows: [
    // A third-party item type that IS code, though nothing in its id says so.
    itemTypeRow('acme/contract-clause', ['code']),
    // A third-party item type that is NOT code, though its id contains "code".
    itemTypeRow('acme/code-review-memo', ['design-evidence']),
    // Revision 2 drops design-evidence; a plan type pinned to revision 1 must keep it.
    itemTypeRow('acme/legal-review', ['design-evidence'], 1),
    itemTypeRow('acme/legal-review', [], 2),
  ],
  planTypeRows: [
    planTypeRow(
      'acme/legal-plan',
      [{ id: 'acme/legal-review', maxRevision: 1 }, { id: 'acme/contract-clause' }, { id: 'acme/code-review-memo' }],
      'acme/legal-review',
    ),
  ],
});

const resolve = createRegistryVerificationResolver(REGISTRY);

describe('resolve-verification — R-5 code-ness is the resolved module set', () => {
  it('code verification follows the resolved module set', () => {
    const code = resolve({ planType: 'acme/legal-plan' }, { deliverable: 'acme/contract-clause' });
    expect(code).toMatchObject({ itemType: 'acme/contract-clause', codeDeliverable: true, deliverable: null });
    expect(code.modules).toEqual(['generic-core', 'code']);

    const memo = resolve({ planType: 'acme/legal-plan' }, { deliverable: 'acme/code-review-memo' });
    expect(memo).toMatchObject({ itemType: 'acme/code-review-memo', codeDeliverable: false });
    expect(memo.modules).toEqual(['generic-core', 'design-evidence']);
    expect(memo.modules).not.toContain('code');
  });

  it('built-in kinds resolve through their first-party item types with today’s module sets', () => {
    const code = resolve({ verificationProfile: 'coding' }, { deliverable: 'code' });
    expect(code).toMatchObject({ itemType: 'papercusp/code', deliverable: 'code', codeDeliverable: true });
    const doc = resolve({ verificationProfile: 'coding' }, { deliverable: 'doc' });
    expect(doc).toMatchObject({ itemType: 'papercusp/doc', deliverable: 'doc', codeDeliverable: false });
    expect(doc.modules).not.toContain('code');
  });

  it('an item with no declared type takes the plan type’s default, within its revision range', () => {
    const r = resolve({ planType: 'acme/legal-plan' }, {});
    expect(r).toMatchObject({
      itemType: 'acme/legal-review',
      deliverableSource: 'profile-default',
      profile: 'general',
      profileSource: 'declared',
      codeDeliverable: false,
    });
    // Revision 2 exists but the plan type pins maxRevision 1, so design-evidence stays.
    expect(r.modules).toEqual(['generic-core', 'design-evidence']);
  });

  it('heldToPlanType intersects a reference with the range the plan type lists', () => {
    const planType = REGISTRY.planType('acme/legal-plan');
    expect(heldToPlanType(planType, { id: 'acme/legal-review', minRevision: 1, maxRevision: 3 })).toEqual({
      id: 'acme/legal-review',
      minRevision: 1,
      maxRevision: 1,
    });
    // An id the plan type does not list keeps its own range; no plan type changes nothing.
    expect(heldToPlanType(planType, { id: 'acme/other', minRevision: 2 })).toEqual({ id: 'acme/other', minRevision: 2 });
    expect(heldToPlanType(null, { id: 'acme/legal-review' })).toEqual({ id: 'acme/legal-review' });
  });

  it('is the default behind resolveVerification, and an override still wins', () => {
    expect(resolveVerification({ verificationProfile: 'coding' }, { deliverable: 'code' }).itemType).toBe('papercusp/code');
    const viaOverride = withVerificationResolver(resolve, () =>
      resolveVerification({ planType: 'acme/legal-plan' }, { deliverable: 'acme/contract-clause' }),
    );
    expect(viaOverride.codeDeliverable).toBe(true);
  });
});

describe('resolve-verification — R-6 an unknown type fails safe', () => {
  it('unknown type fails safe to the strictest set', () => {
    expect([...STRICTEST_MODULES]).toEqual([...VERIFICATION_MODULES]);

    // An unregistered item type, declared under a registered plan type.
    const unknownItem = resolve({ planType: 'acme/legal-plan' }, { deliverable: 'acme/not-installed' });
    expect(unknownItem.modules).toEqual([...VERIFICATION_MODULES]);
    expect(unknownItem).toMatchObject({ itemType: 'acme/not-installed', codeDeliverable: true });

    // An unregistered plan type: its items' default cannot resolve either.
    const unknownPlan = resolve({ planType: 'globex/research-plan' }, {});
    expect(unknownPlan.modules).toEqual([...VERIFICATION_MODULES]);
    expect(unknownPlan.codeDeliverable).toBe(true);

    // An unknown first-party slug is not rescued by the catalog.
    const unknownFirstParty = resolve({ verificationProfile: 'general' }, { deliverable: 'papercusp/no-such-kind' });
    expect(unknownFirstParty.modules).toEqual([...VERIFICATION_MODULES]);
  });

  it('an already-activated plan whose type vanished resolves to the full catalog', () => {
    const before = buildTypeRegistrySnapshot({
      itemTypeRows: [itemTypeRow('acme/memo', [])],
    });
    const after = buildTypeRegistrySnapshot({
      itemTypeRows: [itemTypeRow('acme/memo', [], 1, { retired_at: new Date('2026-10-20T00:00:00Z') })],
    });
    const plan = { verificationProfile: 'general' };
    const item = { deliverable: 'acme/memo' };
    expect(createRegistryVerificationResolver(before)(plan, item).modules).toEqual(['generic-core']);
    expect(createRegistryVerificationResolver(after)(plan, item).modules).toEqual([...VERIFICATION_MODULES]);
  });

  it('an invalid definition row is unresolvable, never a weaker set', () => {
    const registry = buildTypeRegistrySnapshot({
      itemTypeRows: [itemTypeRow('acme/broken', ['not-a-module'])],
    });
    expect(registry.invalidRows).toHaveLength(1);
    const r = createRegistryVerificationResolver(registry)({ verificationProfile: 'general' }, { deliverable: 'acme/broken' });
    expect(r.modules).toEqual([...VERIFICATION_MODULES]);
  });

  it('findUnregisteredTypes names every unresolvable plan type and item type, grouped by type', () => {
    const items = [
      { id: 'P-001', deliverable: 'acme/contract-clause' },
      { id: 'P-002', deliverable: 'acme/not-installed' },
      { id: 'P-003', deliverable: 'acme/not-installed' },
      { id: 'P-004', deliverable: 'code' },
      { id: 'P-005', deliverable: null },
    ];
    expect(findUnregisteredTypes({ planType: 'acme/legal-plan' }, items, REGISTRY)).toEqual([
      expect.objectContaining({ kind: 'item-type', id: 'acme/not-installed', itemIds: ['P-002', 'P-003'] }),
    ]);
    const both = findUnregisteredTypes({ planType: 'globex/research-plan' }, items, REGISTRY);
    expect(both.map((u) => [u.kind, u.id])).toEqual([
      ['plan-type', 'globex/research-plan'],
      ['item-type', 'acme/not-installed'],
    ]);
    expect(both[0]!.install).toContain('globex/research-plan');
    expect(findUnregisteredTypes({ verificationProfile: 'coding' }, [{ id: 'P-001', deliverable: 'doc' }], REGISTRY)).toEqual([]);
  });

  it('unregisteredTypesRefusal names what to install, and is null when everything resolves', () => {
    expect(unregisteredTypesRefusal([])).toBeNull();
    const text = unregisteredTypesRefusal(
      findUnregisteredTypes({ planType: 'acme/legal-plan' }, [{ id: 'P-002', deliverable: 'acme/not-installed' }], REGISTRY),
    );
    expect(text).toMatch(/^unregistered_type:/);
    expect(text).toContain('item type "acme/not-installed" (used by P-002)');
    expect(text).toContain('install the Cupboard pack that provides "acme/not-installed"');
  });
});

describe('plan activation gate — R-6 refuses an unregistered type, naming the install', () => {
  const SCOPE = { workspaceId: 'ws', harnessSlug: 'papercusp', planSlug: 'plan-a' } as const;
  const REUSE =
    '\n## Existing infrastructure reused\n\n```reuse\n' +
    '{"searched":[],"reused":[],"newSurfaces":[],"notApplicable":"Prose-only plan; no code surface."}\n```\n';
  const LIBRARIES =
    '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"No library could do this."}\n```\n';
  const plan = (status: string, opts: { type?: string; deliverable?: string } = {}) =>
    `---\ntitle: Plan A\nslug: plan-a\nstatus: ${status}\n${opts.type ? `type: ${opts.type}\n` : ''}` +
    'created: 2026-10-20\nupdated: 2026-10-20\nowner: test\n---\n\n## Items\n\n' +
    `- **P-001** \`todo\` Do the thing.${opts.deliverable ? ` deliverable: ${opts.deliverable}` : ''}\n` +
    REUSE +
    LIBRARIES;

  /** The tagged-template tx stub of plan-activation-gate-declarations.test.ts, plus the registry tables. */
  function txFor(content: string, registryRows: { item?: DefinitionRow[]; plan?: DefinitionRow[] } = {}) {
    const calls: string[] = [];
    const tx = (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      calls.push(text);
      if (text.includes('harness_shared.plan_audits')) return Promise.resolve([{ audit_seq: 4, activation: {} }]);
      if (text.includes('harness_shared.harness_plans')) return Promise.resolve([{ content }]);
      if (text.includes('harness_shared.plan_item_type_definitions')) return Promise.resolve(registryRows.item ?? []);
      if (text.includes('harness_shared.plan_type_definitions')) return Promise.resolve(registryRows.plan ?? []);
      return Promise.reject(new Error(`unexpected query: ${text.slice(0, 80)}`));
    };
    return { tx, calls };
  }

  it('refuses a ready plan whose item type is not installed, and names the pack to install', async () => {
    const { tx } = txFor(plan('ready', { deliverable: 'acme/legal-review' }));
    const verdict = await evaluateConversationActivationGate(tx as never, SCOPE);
    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'unregistered_type',
      auditSeq: 4,
      unregisteredTypes: [expect.objectContaining({ kind: 'item-type', id: 'acme/legal-review', itemIds: ['P-001'] })],
    });
    expect(verdict.message).toContain('install the Cupboard pack that provides "acme/legal-review"');

    const refusal = activationGateRefusalValue('plan-a', verdict);
    expect(refusal).toMatchObject({ ok: false, code: 'unregistered_type', unregisteredTypes: verdict.unregisteredTypes });
    expect(isActivationGateRefusalValue(refusal)).toBe(true);
  });

  it('refuses a draft plan whose declared plan type is not installed, judging the pending content', async () => {
    const { tx } = txFor(plan('draft'));
    const verdict = await evaluateConversationActivationGate(tx as never, {
      ...SCOPE,
      pendingContent: plan('ready', { type: 'globex/research-plan' }),
    });
    expect(verdict).toMatchObject({
      satisfied: false,
      code: 'unregistered_type',
      unregisteredTypes: [expect.objectContaining({ kind: 'plan-type', id: 'globex/research-plan' })],
    });
  });

  it('passes once the registry holds the types, reading the registry tables', async () => {
    const { tx, calls } = txFor(plan('ready', { type: 'acme/legal-plan', deliverable: 'acme/legal-review' }), {
      item: [itemTypeRow('acme/legal-review', ['design-evidence'])],
      plan: [planTypeRow('acme/legal-plan', [{ id: 'acme/legal-review' }], 'acme/legal-review')],
    });
    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 4 });
    expect(calls.some((c) => c.includes('plan_item_type_definitions'))).toBe(true);
  });

  it('a plan naming only built-in kinds never reads the registry tables', async () => {
    const { tx, calls } = txFor(plan('ready', { deliverable: 'doc' }));
    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 4 });
    expect(calls.some((c) => c.includes('_definitions'))).toBe(false);
  });

  it('does not strand an already-active plan whose type vanished', async () => {
    const { tx } = txFor(plan('active', { deliverable: 'acme/legal-review' }));
    await expect(evaluateConversationActivationGate(tx as never, SCOPE)).resolves.toEqual({ satisfied: true, auditSeq: 4 });
  });
});
