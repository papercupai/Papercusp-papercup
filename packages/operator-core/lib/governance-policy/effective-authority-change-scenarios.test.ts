import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_KINDS, assessPermissionChange, evaluateEffectivePermission,
  type AuthoritySnapshot, type PermissionChangeInput, type PermissionPopulationProof, type PermissionRequest,
} from './effective-authority';

const request: PermissionRequest = {
  tool: 'store:write', action: 'record:write',
  resource: { kind: 'store', operation: 'write', target: 'contract-record' },
};
const proof: PermissionPopulationProof = {
  populationRevision: 'permissions:1', complete: true, population: ['read', 'write'], allowed: ['read', 'write'],
};
function change(): PermissionChangeInput {
  const policies = AUTHORITY_KINDS.filter(kind => kind !== 'vault').map(kind => ({
    kind, id: kind, revision: `${kind}:1`, state: 'present' as const,
    rules: kind === 'identity' ? { tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] } } : {},
  }));
  const current: AuthoritySnapshot = { required: policies.map(({ kind, id }) => ({ kind, id })), policies,
    contextRevision: 'no-active-vault:1', contextVaultIds: [] };
  const initial = evaluateEffectivePermission(current, request);
  expect(initial.allowed).toBe(true);
  return { current, request, expected: initial.revisions, before: proof, after: { ...proof, allowed: ['read'] },
    fixedFloors: [{ authority: { kind: 'platform', id: 'platform', revision: 'platform:1' }, permissions: proof }] };
}

describe('P-024 conservative authority change scenarios', () => {
  it.each(['revoked', 'expired', 'foreign-owner', 'replayed'] as const)(
    'a caller-supplied %s approval claim cannot replace the approval workflow', status => {
      const input = change();
      expect(assessPermissionChange(input).canApplyWithoutApproval).toBe(true);
      for (const kind of ['widening', 'unknown'] as const) {
        const result = assessPermissionChange({ ...input,
          before: kind === 'widening' ? input.after : { ...proof, complete: false }, after: proof,
          ...{ approval: { status, owner: 'caller-asserted-owner', approved: true, revisions: input.expected } },
        });
        expect(result).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: true,
          comparison: { kind }, code: 'approval-required' });
      }
    },
  );

  it('a shared-layer proof must retain every affected workspace in the population', () => {
    const input = change();
    const complete = { ...proof, population: ['workspace:a', 'workspace:b'], allowed: ['workspace:a', 'workspace:b'] };
    const shared = { ...input, before: complete, after: { ...complete, allowed: ['workspace:a'] },
      fixedFloors: [{ ...input.fixedFloors[0], permissions: complete }] };
    expect(assessPermissionChange(shared)).toMatchObject({ canApplyWithoutApproval: true, comparison: { kind: 'narrowing' } });
    expect(assessPermissionChange({ ...shared, after: { ...shared.after, population: ['workspace:a'] } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: false, comparison: { kind: 'unknown' }, code: 'floor-unavailable',
    });
    expect(assessPermissionChange({ ...shared, before: { ...complete, population: ['workspace:a'], allowed: ['workspace:a'] } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: true, comparison: { kind: 'unknown' }, code: 'approval-required',
    });
  });

  it('a successful assessment cannot be replayed as approval for a different change', () => {
    const input = change();
    const prior = assessPermissionChange(input);
    expect(prior.canApplyWithoutApproval).toBe(true);
    expect(assessPermissionChange({ ...input, before: input.after, after: input.before, ...{ approval: prior } })).toMatchObject({
      canApplyWithoutApproval: false, requiresOwnerApproval: true, comparison: { kind: 'widening' }, code: 'approval-required',
    });
  });
});
