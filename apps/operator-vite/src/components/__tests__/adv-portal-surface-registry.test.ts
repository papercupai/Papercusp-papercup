/**
 * Every desktop ADV tab reaches the cloud portal (portal-parity-adv-tabs-2026-09-05 P-001).
 *
 * The portal mounts an ADV tab's body natively through
 * `packages/operator-ui/src/surfaces` `OPERATOR_SURFACES[kind]`, so a desktop tab
 * is reachable in the portal ONLY when that registry names it. Before this plan
 * 14 of the 20 tabs were silently absent (the portal collapsed them to Overview).
 * `ADV_TAB_SURFACE_KINDS` is typed over the full `AdvTabId` union, which makes
 * the omission a compile error; this test pins the RUNTIME half — that each
 * mapped kind really has a component behind it, that the map is a bijection, and
 * that the pot-bar verdict for a surface is the operator's own verdict for its tab.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// The bridge writes the grid palette into the document at import; a registry
// test has no document to paint (same mock the PlansSurface test uses).
vi.mock('../../../../../packages/operator-ui/src/grid-theme-bridge', () => ({}));

import { ADV_TAB_IDS } from '../adv/AdvShell';
import { POT_BAR_TAB_IDS, potBarModeForTab } from '../adv/adv-pot-bar-tabs';
import {
  ADV_TAB_SURFACE_KINDS,
  OPERATOR_SURFACES,
  advTabForSurface,
  isOperatorSurfaceKind,
  potScopeForSurface,
} from '../../../../../packages/operator-ui/src/surfaces';

type InventoryRow = { id: string; destination: string; scenario: string; eligibility: string;
  disposition: string; owner: string };
type Inventory = { schemaVersion: number; sourceRef: string; nativeExceptionDecision: string;
  eligibility: Record<string, string>; rows: InventoryRow[] };
const inventory: Inventory = JSON.parse(readFileSync(new URL(
  '../../../../../docs/evidence/cloud-portal-desktop-parity-inventory-2026-10-09.json', import.meta.url), 'utf8'));
// P-001's agreed population, rather than deriving the expected population from
// the artifact being checked. Functional pending rows do not claim acceptance.
const otherDestinations: Record<string, string> = {
  'utility.plans': '?app=plans', 'utility.inbox': '?app=inbox', 'utility.cloud': '?app=cloud',
  'utility.cupboard': '?app=cupboard', 'utility.dev': '?app=dev', 'utility.support': '?app=support',
  'utility.settings': '?app=settings', 'utility.quick-panel': '?panel=quick',
  'utility.shortcuts': 'existing global shortcut dispatch', 'roster.message': 'selected-agent message',
  'roster.wake': 'selected-agent wake', 'roster.stop': 'selected managed-session stop',
  'roster.open-conversation': 'selected-agent conversation', 'native.os-window-focus': 'operator OS terminal window',
  'existing.voice': 'portal-voice-parity-and-release-2026-09-08#P-031',
  'existing.hosted-native-cloud': 'cloud-cross-feature-e2e-shipment-2026-10-08#P-002,P-003,P-004',
};
const expectedDestinations = { ...otherDestinations, ...Object.fromEntries(
  ADV_TAB_IDS.map(tab => [`adv.${tab}`, `?app=${ADV_TAB_SURFACE_KINDS[tab]}`])) };
function inventoryErrors(value: Inventory): string[] {
  const errors: string[] = [];
  const ids = value.rows.map(row => row.id);
  if (value.schemaVersion !== 1 || !value.sourceRef.trim()) errors.push('inventory provenance');
  if (new Set(ids).size !== ids.length || ids.length !== Object.keys(expectedDestinations).length)
    errors.push('population cardinality');
  for (const id of Object.keys(expectedDestinations)) if (!ids.includes(id)) errors.push(`missing:${id}`);
  for (const row of value.rows) {
    if (row.destination !== expectedDestinations[row.id]) errors.push(`destination:${row.id}`);
    if (row.scenario !== row.id) errors.push(`scenario:${row.id}`);
    if (!value.eligibility[row.eligibility]?.trim() || !/^WI-\d+$/.test(row.owner)) errors.push(`eligibility/owner:${row.id}`);
    if (!['mapping-reviewed-functional-pending', 'functional-pending', 'existing-lane-pending', 'reviewed-native-only']
      .includes(row.disposition)) errors.push(`unmeasured:${row.id}`);
    if ((row.disposition === 'reviewed-native-only') !== (row.id === 'native.os-window-focus'))
      errors.push(`native-exception:${row.id}`);
  }
  if (value.nativeExceptionDecision !== 'cloud-portal-desktop-parity-closure-2026-10-09#D-002')
    errors.push('native-exception authority');
  return errors;
}

describe('PARITY-P001 inventory completeness detector', () => {
  it('accepts all 37 individually identified destinations, eligibility rules and honest dispositions', () => {
    expect(inventory.rows).toHaveLength(37);
    expect(inventoryErrors(inventory)).toEqual([]);
    expect(inventory.rows.filter(row => row.disposition === 'reviewed-native-only').map(row => row.id))
      .toEqual(['native.os-window-focus']);
  });
  it('detects an omitted non-ADV workflow even when all 20 ADV mappings remain', () => {
    const changed = structuredClone(inventory);
    changed.rows = changed.rows.filter(row => row.id !== 'utility.inbox');
    expect(inventoryErrors(changed)).toContain('missing:utility.inbox');
  });
  it('detects duplicate identities and scenarios instead of accepting the same row twice', () => {
    const changed = structuredClone(inventory);
    const removedId = changed.rows[0].id;
    changed.rows[0] = { ...changed.rows[1] };
    expect(inventoryErrors(changed)).toContain('population cardinality');
    expect(inventoryErrors(changed)).toContain(`missing:${removedId}`);
  });
  it.each(['destination', 'scenario', 'eligibility', 'owner', 'disposition'] as const)
  ('detects an unmeasured or misrouted %s', field => {
    const changed = structuredClone(inventory);
    changed.rows[0][field] = '';
    expect(inventoryErrors(changed).length).toBeGreaterThan(0);
  });
  it('refuses an additional native-only exception and a missing exception decision', () => {
    const changed = structuredClone(inventory);
    changed.rows[0].disposition = 'reviewed-native-only';
    changed.nativeExceptionDecision = '';
    expect(inventoryErrors(changed)).toContain(`native-exception:${changed.rows[0].id}`);
    expect(inventoryErrors(changed)).toContain('native-exception authority');
  });
});

describe('portal surface registry covers every ADV tab', () => {
  it('maps every ADV_TAB_IDS entry to a registered operator surface', () => {
    expect(ADV_TAB_IDS.length).toBe(21);
    for (const tab of ADV_TAB_IDS) {
      const kind = ADV_TAB_SURFACE_KINDS[tab];
      expect(kind, `ADV tab "${tab}" has no portal surface kind`).toBeTruthy();
      expect(isOperatorSurfaceKind(kind), `kind "${kind}" for tab "${tab}" is not in OPERATOR_SURFACES`).toBe(true);
      expect(OPERATOR_SURFACES[kind]).toBeDefined();
    }
  });

  it('is a bijection: no two tabs share a kind, and every mapped kind resolves back to its tab', () => {
    const kinds = Object.values(ADV_TAB_SURFACE_KINDS);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const tab of ADV_TAB_IDS) {
      expect(advTabForSurface(ADV_TAB_SURFACE_KINDS[tab])).toBe(tab);
    }
  });

  it('renames only the kinds whose ADV id the portal already uses for another surface (D-005 / D-006)', () => {
    expect(ADV_TAB_SURFACE_KINDS.calendar).toBe('scheduled');
    expect(ADV_TAB_SURFACE_KINDS.plans).toBe('create');
    expect(ADV_TAB_SURFACE_KINDS.settings).toBe('adv-settings');
    expect(ADV_TAB_SURFACE_KINDS.harnesses).toBe('work');
    for (const tab of ADV_TAB_IDS) {
      if (tab === 'calendar' || tab === 'plans' || tab === 'settings' || tab === 'harnesses') continue;
      expect(ADV_TAB_SURFACE_KINDS[tab]).toBe(tab);
    }
  });

  it('gives a surface exactly the pot bar the operator gives its tab', () => {
    for (const tab of ADV_TAB_IDS) {
      const kind = ADV_TAB_SURFACE_KINDS[tab];
      expect(potScopeForSurface(kind)).toEqual(
        POT_BAR_TAB_IDS.has(tab) ? potBarModeForTab(tab) : { show: false, withStatus: false },
      );
    }
    // Non-ADV surfaces never get a pot bar; an unknown kind never throws.
    for (const kind of ['plans', 'inbox', 'desktops', 'cloud', 'cupboard', 'dev', 'support', 'settings', 'quick-panel', 'no-such-kind']) {
      expect(potScopeForSurface(kind)).toEqual({ show: false, withStatus: false });
      expect(advTabForSurface(kind)).toBeUndefined();
    }
  });

  /**
   * The desktop's global-shortcut palette (/quick-panel: prompts | brainstorm |
   * docs) reaches the portal as the `quick` shell PANEL, not a rail app
   * (portal-quick-panel-palette-2026-09-06 D-001) — so it is a registered
   * surface with no ADV tab behind it and no pot bar.
   */
  it('registers the quick-panel palette as a non-ADV surface (D-001)', () => {
    expect(isOperatorSurfaceKind('quick-panel')).toBe(true);
    expect(OPERATOR_SURFACES['quick-panel']).toBeDefined();
    expect(Object.values(ADV_TAB_SURFACE_KINDS)).not.toContain('quick-panel');
  });
});
