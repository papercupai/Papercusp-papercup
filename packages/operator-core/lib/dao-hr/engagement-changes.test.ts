import { describe, it, expect } from 'vitest';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { equityArtifacts } from '../equity/runtime';
import type { HirePlan } from './onboarding';
import { buildFirePlan } from './engagement-changes';
const address = (n: number) => ('0x' + n.toString(16).padStart(40,'0')) as Address;
const plan = {chainId:1,equity:address(1),governor:address(2),timelock:address(3),wallet:address(4),personId:'PER-one',grantId:('0x'+'ab'.repeat(32)) as Hex} as HirePlan;
describe('engagement fire proposal', () => {
  it('binds one stopGrant to the exact signed engagement and grant', () => {
    const fire = buildFirePlan(plan,'contract-one');
    expect(fire.targets).toEqual([plan.equity]); expect(fire.values).toEqual(['0']);
    const decoded = decodeFunctionData({abi:equityArtifacts.contracts.PapercuspEquityV2.abi,data:fire.calldatas[0]!});
    expect(decoded.functionName).toBe('stopGrant');expect(decoded.args).toEqual([plan.grantId]);
    expect(buildFirePlan(plan,'other-contract').proposalId).not.toBe(fire.proposalId);
    expect(buildFirePlan({...plan,grantId:('0x'+'cd'.repeat(32)) as Hex},'contract-one').proposalId).not.toBe(fire.proposalId);
  });
});
