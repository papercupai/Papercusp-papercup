import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { loadChainForWorkspace, upsertLayer } from './store';
import {
  assessPermissionChange, evaluateEffectivePermission, revalidateEffectivePermission,
  type AuthorityPolicy, type AuthoritySnapshot, type PermissionPopulationProof, type PermissionRequest,
} from './effective-authority';

// Contract fixtures only. P-002 owns approval application; P-005 owns production
// loaders and effect adapters. Nothing here asserts those integrations exist.
let sql: postgres.Sql;
const request: PermissionRequest = {
  tool: 'store:write', action: 'record:write',
  resource: { kind: 'store', operation: 'write', target: 'contract-record' },
};
const proof: PermissionPopulationProof = {
  populationRevision: 'permissions:1', complete: true,
  population: ['read', 'write'], allowed: ['read', 'write'],
};

beforeAll(async () => {
  const uri = await getTestPg();
  const dbName = `idopcontract_${randomBytes(5).toString('hex')}`;
  const admin = postgres(uri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally { await admin.end({ timeout: 5 }); }
  const destination = new URL(uri);
  destination.pathname = `/${dbName}`;
  sql = postgres(destination.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe('CREATE SCHEMA harness_shared');
  await sql.unsafe(readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1497-governance-policy-layers.sql', import.meta.url), 'utf8'));
  await sql.unsafe('CREATE TABLE harness_shared.idop_contract_effects (target text NOT NULL)');
}, 60_000);

afterAll(async () => { await sql?.end({ timeout: 5 }); });
beforeEach(async () => {
  await sql.unsafe(`TRUNCATE harness_shared.governance_policy_layer_versions,
    harness_shared.governance_policy_layers, harness_shared.idop_contract_effects`);
  const common = { actor: 'contract-test', reason: 'contract calibration', rules: {} };
  await upsertLayer({ ...common, layerId: 'org', level: 'organization', scopeRef: 'org', parentLayerId: null }, sql);
  await upsertLayer({ ...common, layerId: 'dept', level: 'department', scopeRef: 'dept', parentLayerId: 'org' }, sql);
  await upsertLayer({ ...common, layerId: 'workspace', level: 'workspace', scopeRef: 'workspace', parentLayerId: 'dept' }, sql);
});

async function snapshot(db: postgres.Sql = sql, workspaceId = 'workspace'): Promise<AuthoritySnapshot> {
  const stored = await loadChainForWorkspace(workspaceId, db);
  const fixed: AuthorityPolicy[] = [
    { kind: 'identity', id: 'identity', revision: 'identity:1', state: 'present',
      rules: { tools: { allow: ['*'] }, actions: { allow: ['*'] }, resources: { allow: ['*'] } } },
    { kind: 'user', id: 'user', revision: 'user:1', state: 'present', rules: {} },
    { kind: 'platform', id: 'platform', revision: 'platform:1', state: 'present', rules: {} },
  ];
  // The fixture declares its expected store population independently of a read.
  // A missing/malformed chain cannot silently remove a required authority.
  return {
    required: [...fixed.map(({ kind, id }) => ({ kind, id })),
      { kind: 'organization', id: 'org' }, { kind: 'department', id: 'dept' },
      { kind: 'workspace', id: workspaceId }],
    policies: [...fixed, ...(stored.status === 'ok' ? stored.chain.map(row => ({
      kind: row.level, id: row.layerId, revision: `${row.version}:${row.contentHash}`,
      state: 'present' as const, rules: row.rules,
    })) : [])],
    contextRevision: 'no-active-vault:1', contextVaultIds: [],
  };
}

async function editDepartment(rules: AuthorityPolicy['rules']) {
  return upsertLayer({ layerId: 'dept', level: 'department', scopeRef: 'dept', parentLayerId: 'org',
    rules: rules!, actor: 'contract-test', reason: 'stored authority cutover', expectedVersion: 1 }, sql);
}

async function effects() {
  return sql<{ target: string }[]>`SELECT target FROM harness_shared.idop_contract_effects`;
}

describe('P-024 required store authority contract', () => {
  it('a verified no-active-vault control permits the contract effect', async () => {
    const current = await snapshot();
    const initial = evaluateEffectivePermission(current, request);
    expect(initial.allowed).toBe(true);
    const checked = revalidateEffectivePermission(current, request, initial.revisions);
    expect(checked.allowed).toBe(true);
    if (checked.allowed) await sql`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
    expect(await effects()).toEqual([{ target: 'contract-record' }]);
  });

  it.each(['missing', 'unreadable', 'empty-allowlist', 'stale'] as const)(
    'stored %s authority refuses before the contract effect', async failure => {
      const initial = evaluateEffectivePermission(await snapshot(), request);
      expect(initial.allowed).toBe(true);
      if (failure === 'missing') {
        await sql`UPDATE harness_shared.governance_policy_layers SET scope_ref = 'other-workspace' WHERE layer_id = 'workspace'`;
        expect((await loadChainForWorkspace('workspace', sql)).status).toBe('none');
      }
      else if (failure === 'unreadable') {
        await sql.unsafe(`UPDATE harness_shared.governance_policy_layers
          SET rules = '{"tools":{"allow":42}}'::jsonb WHERE layer_id = 'dept'`);
        expect((await loadChainForWorkspace('workspace', sql)).status).toBe('malformed');
      } else await editDepartment(failure === 'empty-allowlist' ? { tools: { allow: [] } } : {});
      const decision = await sql.begin(async tx => {
        const current = await snapshot(tx as unknown as postgres.Sql);
        expect(evaluateEffectivePermission(current, request).allowed).toBe(failure === 'stale');
        const checked = revalidateEffectivePermission(current, request, initial.revisions);
        if (checked.allowed) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return checked;
      });
      expect(decision).toMatchObject({ allowed: false, request,
        code: failure === 'stale' ? 'authority-stale' : failure === 'empty-allowlist' ? 'denied' : 'authority-unavailable' });
      expect(await effects()).toEqual([]);
    },
  );

  it.each(['resources', 'egress'] as const)('an empty %s allowlist refuses the resolved contract effect', async category => {
    const scopedRequest = { ...request, constraints: { egress: ['https://contract-recipient.example'] } };
    const initial = evaluateEffectivePermission(await snapshot(), scopedRequest);
    expect(initial.allowed).toBe(true);
    await editDepartment({ [category]: { allow: [] } });
    const checked = await sql.begin(async tx => {
      const current = await snapshot(tx as unknown as postgres.Sql);
      const direct = evaluateEffectivePermission(current, scopedRequest);
      expect(direct).toMatchObject({ allowed: false, code: 'denied', decidingAuthority: { id: 'dept' } });
      expect(direct.trace).toContainEqual(expect.objectContaining({ category, outcome: 'not-allowed' }));
      const decision = revalidateEffectivePermission(current, scopedRequest, initial.revisions);
      if (decision.allowed) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
      return decision;
    });
    expect(checked.allowed).toBe(false);
    expect(await effects()).toEqual([]);
  });
});

describe('P-024 conservative change with stored authority', () => {
  it.each(['narrowing', 'neutral', 'widening', 'unknown'] as const)(
    'a %s comparison controls application in the contract transaction', async kind => {
      const current = await snapshot();
      const initial = evaluateEffectivePermission(current, request);
      expect(initial.allowed).toBe(true);
      const before = kind === 'widening' ? { ...proof, allowed: ['read'] }
        : kind === 'unknown' ? { ...proof, complete: false } : proof;
      const after = kind === 'narrowing' ? { ...proof, allowed: ['read'] } : proof;
      const assessment = await sql.begin(async tx => {
        const result = assessPermissionChange({ current: await snapshot(tx as unknown as postgres.Sql), request,
          expected: initial.revisions, before, after,
          fixedFloors: [{ authority: { kind: 'platform', id: 'platform', revision: 'platform:1' }, permissions: proof }] });
        if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return result;
      });
      const permitted = kind === 'narrowing' || kind === 'neutral';
      expect(assessment).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: permitted,
        requiresOwnerApproval: !permitted, code: permitted ? 'allowed-without-approval' : 'approval-required' });
      expect(await effects()).toEqual(permitted ? [{ target: 'contract-record' }] : []);
    },
  );

  it('a stored revision change refuses a replayed before-image even when the current edit is allowed', async () => {
    const before = await snapshot();
    const initial = evaluateEffectivePermission(before, request);
    expect(initial.allowed).toBe(true);
    await editDepartment({});
    const current = await snapshot();
    expect(evaluateEffectivePermission(current, request).allowed).toBe(true);
    const assessment = assessPermissionChange({ current, request, expected: initial.revisions,
      before: proof, after: { ...proof, allowed: ['read'] },
      fixedFloors: [{ authority: { kind: 'platform', id: 'platform', revision: 'platform:1' }, permissions: proof }] });
    expect(assessment).toMatchObject({ canApplyWithoutApproval: false, code: 'stale-before-state' });
    expect(await effects()).toEqual([]);
  });

  it.each(['revoked', 'expired', 'foreign-owner', 'replayed'] as const)(
    'a caller-supplied %s approval claim cannot apply a stored widening or unknown change', async status => {
      const current = await snapshot();
      const initial = evaluateEffectivePermission(current, request);
      expect(initial.allowed).toBe(true);
      for (const kind of ['widening', 'unknown'] as const) {
        const assessment = await sql.begin(async tx => {
          const input = {
            current: await snapshot(tx as unknown as postgres.Sql), request, expected: initial.revisions,
            before: kind === 'widening' ? { ...proof, allowed: ['read'] } : { ...proof, complete: false },
            after: proof,
            fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' }, permissions: proof }],
            // P-002 must load authentic receipts. The pure contract accepts no
            // caller approval channel, including apparently structured claims.
            approval: { status, owner: 'caller-asserted-owner', approved: true, revisions: initial.revisions },
          };
          const result = assessPermissionChange(input);
          if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
          return result;
        });
        expect(assessment).toMatchObject({ comparison: { kind }, canApplyWithoutApproval: false,
          requiresOwnerApproval: true, code: 'approval-required' });
        expect(await effects()).toEqual([]);
      }
    },
  );

  it('a shared department change cannot omit another workspace from its impact proof', async () => {
    await upsertLayer({ layerId: 'other-workspace', level: 'workspace', scopeRef: 'other-workspace', parentLayerId: 'dept',
      rules: {}, actor: 'contract-test', reason: 'shared authority impact fixture' }, sql);
    const first = await snapshot();
    const second = await snapshot(sql, 'other-workspace');
    expect(first.policies.find(policy => policy.id === 'dept')).toEqual(second.policies.find(policy => policy.id === 'dept'));
    expect(evaluateEffectivePermission(second, request).allowed).toBe(true);
    const initial = evaluateEffectivePermission(first, request);
    const complete = { ...proof, population: ['workspace/read', 'other-workspace/read'], allowed: ['workspace/read', 'other-workspace/read'] };
    const input = { current: first, request, expected: initial.revisions, before: complete,
      after: { ...complete, allowed: ['workspace/read'] },
      fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' }, permissions: complete }] };
    expect(assessPermissionChange(input)).toMatchObject({ canApplyWithoutApproval: true, comparison: { kind: 'narrowing' } });
    for (const omitted of ['before', 'after'] as const) {
      const result = await sql.begin(async tx => {
        const assessment = assessPermissionChange({ ...input, current: await snapshot(tx as unknown as postgres.Sql),
          [omitted]: { ...input[omitted], population: ['workspace/read'], allowed: ['workspace/read'] } });
        if (assessment.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
        return assessment;
      });
      expect(result).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: omitted === 'before',
        comparison: { kind: 'unknown' }, code: omitted === 'before' ? 'approval-required' : 'floor-unavailable' });
    }
    expect(await effects()).toEqual([]);
  });

  it('a prior successful narrowing assessment cannot authorize a different widening', async () => {
    const current = await snapshot();
    const initial = evaluateEffectivePermission(current, request);
    const input = { current, request, expected: initial.revisions, before: proof, after: { ...proof, allowed: ['read'] },
      fixedFloors: [{ authority: { kind: 'platform' as const, id: 'platform', revision: 'platform:1' }, permissions: proof }] };
    const prior = assessPermissionChange(input);
    expect(prior.canApplyWithoutApproval).toBe(true);
    const replay = await sql.begin(async tx => {
      const result = assessPermissionChange({ ...input, current: await snapshot(tx as unknown as postgres.Sql),
        before: input.after, after: proof, ...{ approval: prior } });
      if (result.canApplyWithoutApproval) await tx`INSERT INTO harness_shared.idop_contract_effects VALUES (${request.resource.target})`;
      return result;
    });
    expect(replay).toMatchObject({ canApplyWithoutApproval: false, requiresOwnerApproval: true,
      comparison: { kind: 'widening' }, code: 'approval-required' });
    expect(await effects()).toEqual([]);
  });
});
