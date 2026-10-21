/**
 * Pinned resolution and `extends` (plan-item-types-registry-cupboard P-005, D-006, R-14).
 * A pinned plan resolves exactly the revision it activated with, retired or not, and a pin
 * whose content no longer matches fails safe to the strictest set. An item type's effective
 * modules include its parent's, so a child never drops what its parent requires.
 */
import { describe, expect, it } from 'vitest';
import { definitionContentHash } from './content-hash';
import { buildTypeRegistrySnapshot, type DefinitionRow } from './registry';
import {
  createRegistryVerificationResolver,
  STRICTEST_MODULES,
  type PlanTypePins,
  type ResolvedTypeRef,
} from './resolve-verification';

function itemRow(
  id: string,
  revision: number,
  modules: string[],
  extra: Record<string, unknown> = {},
  retired = false,
): DefinitionRow {
  return {
    type_id: id,
    revision,
    hive_slug: null,
    definition: { schemaVersion: 1, id, revision, title: `${id}@${revision}`, modules, ...extra },
    origin: 'workspace',
    source_listing_id: null,
    retired_at: retired ? new Date('2026-10-21T00:00:00Z') : null,
  };
}

function pins(itemTypes: Record<string, DefinitionRow>): PlanTypePins {
  return {
    itemTypes: new Map(
      Object.entries(itemTypes).map(([id, row]) => [id, { revision: row.revision, contentHash: definitionContentHash(row.definition) }]),
    ),
    planTypes: new Map(),
  };
}

const plan = { verificationProfile: 'coding' };
const item = { deliverable: 'acme/legal-review' };

describe('pinned verification resolution', () => {
  const rev1 = itemRow('acme/legal-review', 1, ['generic-core', 'code']);
  const rev2 = itemRow('acme/legal-review', 2, ['generic-core']);

  it('an unpinned plan resolves the newest revision', () => {
    const resolve = createRegistryVerificationResolver(buildTypeRegistrySnapshot({ itemTypeRows: [rev1, rev2] }));
    expect(resolve(plan, item).modules).toEqual(['generic-core']);
  });

  it('a pinned plan keeps its revision after a newer, smaller revision is defined', () => {
    const resolve = createRegistryVerificationResolver(
      buildTypeRegistrySnapshot({ itemTypeRows: [rev1, rev2] }),
      { pins: pins({ 'acme/legal-review': rev1 }) },
    );
    const resolution = resolve(plan, item);
    expect(resolution.modules).toEqual(['generic-core', 'code']);
    expect(resolution.codeDeliverable).toBe(true);
  });

  it('a retired revision stops new references but still resolves for a plan pinned to it', () => {
    const retired1 = itemRow('acme/legal-review', 1, ['generic-core', 'code'], {}, true);
    const registry = buildTypeRegistrySnapshot({ itemTypeRows: [retired1] });
    expect(registry.itemType('acme/legal-review')).toBeNull();
    expect(registry.itemTypeIds()).not.toContain('acme/legal-review');
    expect(createRegistryVerificationResolver(registry)(plan, item).modules).toEqual([...STRICTEST_MODULES]);
    const pinned = createRegistryVerificationResolver(registry, { pins: pins({ 'acme/legal-review': retired1 }) });
    expect(pinned(plan, item).modules).toEqual(['generic-core', 'code']);
  });

  it('a pin whose content no longer matches fails safe to the strictest set', () => {
    const tampered: PlanTypePins = {
      itemTypes: new Map([['acme/legal-review', { revision: 1, contentHash: '0'.repeat(64) }]]),
      planTypes: new Map(),
    };
    const resolve = createRegistryVerificationResolver(buildTypeRegistrySnapshot({ itemTypeRows: [rev1, rev2] }), { pins: tampered });
    expect(resolve(plan, item).modules).toEqual([...STRICTEST_MODULES]);
  });

  it('a pinned revision that no longer exists fails safe to the strictest set', () => {
    const resolve = createRegistryVerificationResolver(
      buildTypeRegistrySnapshot({ itemTypeRows: [rev2] }),
      { pins: pins({ 'acme/legal-review': rev1 }) },
    );
    expect(resolve(plan, item).modules).toEqual([...STRICTEST_MODULES]);
  });

  it('records every type it resolved, so activation can pin them', () => {
    const parent = itemRow('acme/base', 1, ['generic-core', 'code']);
    const child = itemRow('acme/legal-review', 1, ['generic-core'], { extends: { id: 'acme/base' } });
    const seen: ResolvedTypeRef[] = [];
    const resolve = createRegistryVerificationResolver(
      buildTypeRegistrySnapshot({ itemTypeRows: [parent, child] }),
      { onResolved: (ref) => seen.push(ref) },
    );
    resolve(plan, item);
    expect(seen.map((ref) => `${ref.kind}:${ref.id}@${ref.revision}`).sort()).toEqual([
      'item-type:acme/base@1',
      'item-type:acme/legal-review@1',
      'plan-type:papercusp/coding@1',
    ]);
    expect(seen.find((ref) => ref.id === 'acme/base')?.contentHash).toBe(definitionContentHash(parent.definition));
  });
});

describe('extends', () => {
  it("a child's effective modules include its parent's", () => {
    const parent = itemRow('acme/base', 1, ['generic-core', 'code']);
    const child = itemRow('acme/legal-review', 1, ['generic-core'], { extends: { id: 'acme/base' } });
    const resolve = createRegistryVerificationResolver(buildTypeRegistrySnapshot({ itemTypeRows: [parent, child] }));
    expect(resolve(plan, item).modules).toEqual(['generic-core', 'code']);
  });

  it('the parent honours its own pin', () => {
    const parent1 = itemRow('acme/base', 1, ['generic-core', 'code']);
    const parent2 = itemRow('acme/base', 2, ['generic-core']);
    const child = itemRow('acme/legal-review', 1, ['generic-core'], { extends: { id: 'acme/base' } });
    const registry = buildTypeRegistrySnapshot({ itemTypeRows: [parent1, parent2, child] });
    expect(createRegistryVerificationResolver(registry)(plan, item).modules).toEqual(['generic-core']);
    const pinned = createRegistryVerificationResolver(registry, { pins: pins({ 'acme/base': parent1, 'acme/legal-review': child }) });
    expect(pinned(plan, item).modules).toEqual(['generic-core', 'code']);
  });

  it('an unresolvable parent fails safe to the strictest set', () => {
    const child = itemRow('acme/legal-review', 1, ['generic-core'], { extends: { id: 'acme/missing' } });
    const resolve = createRegistryVerificationResolver(buildTypeRegistrySnapshot({ itemTypeRows: [child] }));
    expect(resolve(plan, item).modules).toEqual([...STRICTEST_MODULES]);
  });

  it('a cycle fails safe to the strictest set', () => {
    const a = itemRow('acme/legal-review', 1, ['generic-core'], { extends: { id: 'acme/other' } });
    const b = itemRow('acme/other', 1, ['generic-core'], { extends: { id: 'acme/legal-review' } });
    const resolve = createRegistryVerificationResolver(buildTypeRegistrySnapshot({ itemTypeRows: [a, b] }));
    expect(resolve(plan, item).modules).toEqual([...STRICTEST_MODULES]);
  });
});
