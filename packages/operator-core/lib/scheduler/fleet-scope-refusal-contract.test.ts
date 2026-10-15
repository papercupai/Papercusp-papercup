/**
 * WI-10005197: every fleet-admission refusal says what would LIFT it. The `Record` key type in
 * `FLEET_SCOPE_REFUSAL_LIFT` is the compile-time guard (a new code without a lift fails to
 * compile); this pins the runtime half — each code yields a non-empty, actor-attributed
 * contract that carries what the gate compared, without altering any admission decision.
 */
import { describe, expect, it } from 'vitest';
import { fleetScopeRefusalContract, type FleetScopeContext } from './fleet-scope-admission';

const scope = {
  ownerId: 'su-member',
  fleetSlug: 'drain-fleet',
  fleetRole: 'member',
  workspaceId: 'ws-1',
  record: { source: 'fleet', revision: 3, spec: { specId: 'spec-a', revision: 3 } },
} as unknown as FleetScopeContext;

const CODES = ['fleet_scope_missing', 'fleet_scope_violation', 'fleet_winding_down'] as const;

describe('fleetScopeRefusalContract', () => {
  it.each(CODES)('%s carries a lift condition, an actor, and what the gate compared', (code) => {
    const contract = fleetScopeRefusalContract(code, scope);
    expect(contract.liftsWhen.length).toBeGreaterThan(20);
    expect(contract.whoCanMakeItTrue.length).toBeGreaterThan(0);
    expect(contract.observed).toMatchObject({ fleet: 'drain-fleet', member: 'su-member' });
    expect(contract.observed.spec).toEqual(expect.stringContaining('spec-a'));
  });

  it('merges the site-specific observation over the scope-derived one', () => {
    const contract = fleetScopeRefusalContract('fleet_scope_violation', scope, {
      workItem: 'WI-1',
      itemKind: 'bug',
    });
    expect(contract.observed).toMatchObject({ fleet: 'drain-fleet', workItem: 'WI-1', itemKind: 'bug' });
  });

  it('names the real recovery tools, so the refusal is actionable rather than tribal knowledge', () => {
    expect(fleetScopeRefusalContract('fleet_scope_missing', scope).liftsWhen).toContain('scheduler:set_claim_spec');
    expect(fleetScopeRefusalContract('fleet_scope_violation', scope).liftsWhen).toContain('scheduler:preview_spec_delta');
    expect(fleetScopeRefusalContract('fleet_winding_down', scope).liftsWhen).toContain('fleet:resume');
  });
});
