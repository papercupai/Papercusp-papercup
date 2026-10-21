/**
 * R-9 (plan-item-types-registry-cupboard-2026-10-20): no definition may drop the generic-core
 * checks.
 *
 * The floor has two halves, and both are exercised on the SAME bad fixtures:
 *   - the write/load gate: `parseItemTypeDefinition` refuses a module set without generic-core.
 *     Define (P-005), pack install (P-006) and the registry loader (raw rows, any origin) all
 *     go through it, so the loader rows here stand in for "a row that arrived some other way";
 *     P-005 and P-006 add their own define/install rows to this file when those writes exist
 *     (plan-item-types-registry-cupboard-2026-10-20#D-005).
 *   - the resolution-time assertion: every resolved module set includes generic-core, and a set
 *     that somehow lacks it fails safe to the full catalog (`holdToFloor`).
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from './builtin-catalog';
import {
  FLOOR_MODULE,
  parseItemTypeDefinition,
  parsePlanTypeDefinition,
  validateDefinitionFloor,
} from './definitions';
import { buildTypeRegistrySnapshot, type DefinitionRow } from './registry';
import { STRICTEST_MODULES, createRegistryVerificationResolver, holdToFloor } from './resolve-verification';
import { DOMAIN_MODULES, type DomainModule } from './verification-modules';

/** Module sets that leave generic-core out: each must be refused wherever it enters. */
const BAD_MODULE_SETS: ReadonlyArray<readonly string[]> = [[], ['code'], ['design-evidence'], ['code', 'design-evidence']];

function itemTypeDefinition(id: string, modules?: readonly string[]) {
  return { schemaVersion: 1, id, revision: 1, title: id, ...(modules === undefined ? {} : { modules: [...modules] }) };
}

function itemTypeRow(id: string, modules: readonly string[], origin: DefinitionRow['origin'] = 'pack'): DefinitionRow {
  return {
    type_id: id,
    revision: 1,
    hive_slug: null,
    origin,
    source_listing_id: origin === 'pack' ? 'listing-floor' : null,
    retired_at: null,
    definition: itemTypeDefinition(id, modules),
  };
}

describe('definition floor — R-9 the write/load gate refuses a set without generic-core', () => {
  it.each(BAD_MODULE_SETS.map((modules) => [JSON.stringify(modules), modules] as const))(
    'validateDefinitionFloor refuses %s',
    (_label, modules) => {
      expect(validateDefinitionFloor({ modules })).toEqual([expect.stringContaining(FLOOR_MODULE)]);
    },
  );

  it.each(BAD_MODULE_SETS.map((modules) => [JSON.stringify(modules), modules] as const))(
    'parseItemTypeDefinition refuses %s instead of repairing it',
    (_label, modules) => {
      const parsed = parseItemTypeDefinition(itemTypeDefinition('acme/no-floor', modules));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.issues.join('\n')).toContain(FLOOR_MODULE);
    },
  );

  it('accepts a set that names generic-core, in catalog order', () => {
    expect(validateDefinitionFloor({ modules: ['code', 'generic-core'] })).toEqual([]);
    const parsed = parseItemTypeDefinition(itemTypeDefinition('acme/with-floor', ['code', 'generic-core']));
    expect(parsed).toMatchObject({ ok: true, definition: { modules: ['generic-core', 'code'] } });
  });

  it('an absent module list means generic-core alone', () => {
    const parsed = parseItemTypeDefinition(itemTypeDefinition('acme/default-floor'));
    expect(parsed).toMatchObject({ ok: true, definition: { modules: [FLOOR_MODULE] } });
  });

  it.each(BAD_MODULE_SETS.map((modules) => [JSON.stringify(modules), modules] as const))(
    'a raw registry row with %s is invalid and resolves to the full catalog, never a set without generic-core',
    (_label, modules) => {
      for (const origin of ['workspace', 'pack'] as const) {
        const registry = buildTypeRegistrySnapshot({ itemTypeRows: [itemTypeRow('acme/raw-row', modules, origin)] });
        expect(registry.itemType('acme/raw-row')).toBeNull();
        expect(registry.invalidRows).toEqual([
          expect.objectContaining({ typeId: 'acme/raw-row', issues: [expect.stringContaining(FLOOR_MODULE)] }),
        ]);
        const resolved = createRegistryVerificationResolver(registry)(
          { verificationProfile: 'general' },
          { deliverable: 'acme/raw-row' },
        );
        expect(resolved.modules).toEqual([...STRICTEST_MODULES]);
        expect(resolved.modules).toContain(FLOOR_MODULE);
      }
    },
  );

  it('a plan type cannot declare a module set at all, so it cannot drop generic-core', () => {
    const parsed = parsePlanTypeDefinition({
      schemaVersion: 1,
      id: 'acme/no-floor-plan',
      revision: 1,
      title: 'no floor',
      base: 'general',
      classes: ['plan-class-feature-ship'],
      defaultItemType: { id: 'papercusp/doc' },
      itemTypes: [{ id: 'papercusp/doc' }],
      modules: ['code'],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join('\n')).toMatch(/modules/);
  });

  it('every built-in item type (the first-party seed) passes the same gate', () => {
    expect(BUILTIN_CATALOG.itemTypes.length).toBeGreaterThan(0);
    for (const definition of BUILTIN_CATALOG.itemTypes) {
      expect(validateDefinitionFloor(definition)).toEqual([]);
      expect(parseItemTypeDefinition(definition)).toMatchObject({ ok: true });
    }
  });
});

describe('definition floor — R-9 every resolved module set includes generic-core', () => {
  it('holds over every built-in plan type, item type, domain module and non-code signal', () => {
    const registry = buildTypeRegistrySnapshot({
      itemTypeRows: [itemTypeRow('acme/code-only', ['generic-core', 'code'])],
    });
    const resolve = createRegistryVerificationResolver(registry);
    const deliverables = [undefined, 'acme/code-only', 'acme/missing', ...BUILTIN_CATALOG.itemTypes.map((def) => def.id)];
    const domainSets: DomainModule[][] = [[], ...DOMAIN_MODULES.map((module) => [module])];
    let checked = 0;
    for (const planType of [...BUILTIN_CATALOG.planTypes.map((def) => def.id), 'acme/missing-plan']) {
      for (const deliverable of deliverables) {
        for (const domainModules of domainSets) {
          for (const signal of [{}, { auditVerdict: 'not-code' }, { workItemKind: 'task' }]) {
            const resolved = resolve({ planType }, { deliverable, domainModules, ...signal });
            expect(resolved.modules).toContain(FLOOR_MODULE);
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('a resolved set without generic-core fails safe to the full catalog', () => {
    expect(holdToFloor(['code'])).toEqual([...STRICTEST_MODULES]);
    expect(holdToFloor([])).toEqual([...STRICTEST_MODULES]);
    expect(holdToFloor(['generic-core', 'code'])).toEqual(['generic-core', 'code']);
  });
});
