import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AWS_CANARY_CLEANUP_SCRIPT, assertAwsCanaryDeadlineSleeping, planAwsCanaryDeadline } from './aws-canary-deadline';

const now = Date.parse('2026-10-23T03:00:00.000Z');
const input = { accountId: '413781344298', region: 'us-east-2', workspaceId: 'hosted-fixture-p544-trial',
  runId: 'p544-trial-20261023', workloadDeadlineAt: '2026-10-23T03:30:00.000Z',
  teardownDeadlineAt: '2026-10-23T03:41:00.000Z', cleanupRoleArn: 'arn:aws:iam::413781344298:role/TrialCleanup' };

describe('AWS finite trial deadline foundation', () => {
  it('pins one absolute cleanup execution across retries and changes identity if a deadline moves', () => {
    const plan = planAwsCanaryDeadline(input, now);
    expect(planAwsCanaryDeadline(input, now + 1000)).toEqual(plan);
    const changed = planAwsCanaryDeadline({ ...input, teardownDeadlineAt: '2026-10-23T03:42:00.000Z' }, now);
    expect(changed.documentName).toBe(plan.documentName);
    expect(changed.clientToken).not.toBe(plan.clientToken);
    expect(changed.contentSha256).not.toBe(plan.contentSha256);
    expect(plan.document.mainSteps[0].inputs).toEqual({ Timestamp: input.workloadDeadlineAt });
  });

  it.each([
    { accountId: 'wrong' }, { region: 'cn-north-1' }, { workspaceId: 'production' },
    { workspaceId: 'test-runtime-' }, { workspaceId: 'test-runtime-private/production' },
    { workspaceId: 'test-runtime-PRIVATE' },
    { cleanupRoleArn: 'arn:aws:iam::123456789012:role/Other' },
    { workloadDeadlineAt: '2026-10-23T02:59:00.000Z' },
    { workloadDeadlineAt: '2026-10-23T03:30:00-04:00' },
    { teardownDeadlineAt: '2026-10-23T03:40:59.999Z' },
    { workloadDeadlineAt: '2026-11-01T03:30:00.000Z', teardownDeadlineAt: '2026-11-01T03:41:00.000Z' },
  ])('refuses unsafe identity, scope or timing: %j', change => {
    expect(() => planAwsCanaryDeadline({ ...input, ...change }, now)).toThrow();
  });

  it('requires the exact immutable document and a genuinely running sleep before launch', () => {
    const plan = planAwsCanaryDeadline(input, now);
    const proof = { accountId: input.accountId, region: input.region, documentName: plan.documentName,
      documentVersion: '1', content: JSON.stringify(plan.document),
      executionId: '11111111-1111-4111-a111-111111111111', executionStatus: 'InProgress',
      currentStep: { name: 'AwaitCreationCutoff', action: 'aws:sleep', status: 'InProgress' } };
    expect(() => assertAwsCanaryDeadlineSleeping(plan, proof, now)).not.toThrow();
    for (const mutation of [{ region: 'us-east-1' }, { accountId: '123456789012' }, { documentVersion: '$LATEST' },
      { executionStatus: 'Pending' }, { content: '{}' },
      { currentStep: { ...proof.currentStep, name: 'CleanupManagedResources' } }]) {
      expect(() => assertAwsCanaryDeadlineSleeping(plan, { ...proof, ...mutation }, now)).toThrow();
    }
    expect(() => assertAwsCanaryDeadlineSleeping(plan, proof, Date.parse(input.workloadDeadlineAt))).toThrow();
    expect(() => assertAwsCanaryDeadlineSleeping(plan, { ...proof,
      content: JSON.stringify(Object.fromEntries(Object.entries(plan.document).reverse())) }, now)).not.toThrow();
  });

  it('scopes cleanup IAM to the exact account, region and immutable managed tags', () => {
    const plan = planAwsCanaryDeadline(input, now);
    const cleanup = plan.cleanupPolicy.Statement[1];
    expect(cleanup.Resource).toEqual(['instance', 'volume', 'spot-instances-request']
      .map(kind => `arn:aws:ec2:us-east-2:413781344298:${kind}/*`));
    expect(cleanup.Condition).toEqual({ StringEquals: {
      'ec2:ResourceTag/papercusp:managed': 'true', 'ec2:ResourceTag/papercusp:workspace-id': input.workspaceId } });
    expect(plan.cleanupPolicy.Statement[2]).toMatchObject({ Action: ['ec2:DeleteSnapshot'],
      Resource: 'arn:aws:ec2:us-east-2::snapshot/*', Condition: { StringEquals: { 'ec2:Owner': input.accountId } } });
    expect(plan.launcherDeadlineDenyPolicy.Statement[0].Condition).toEqual({
      DateGreaterThanEquals: { 'aws:CurrentTime': input.workloadDeadlineAt } });
    expect(plan.launcherDeadlineDenyPolicy.Statement[1].Action).toContain('ec2:DeleteTags');
  });

  it.each(['normal', 'throttled', 'late-create', 'foreign-account', 'pagination-cycle', 'access-denied', 'residue'])
  ('executes the actual SSM cleanup script against a paginated provider: %s', scenario => {
    const harness = `
import json, sys, types
case = sys.argv[1]
log = []
clock = [0]
class ClientError(Exception):
    def __init__(self, code): self.response = {'Error': {'Code': code}}
class World:
    spot, vm, volume, snapshot = True, True, True, True
    throttled = False
    late_started = False
    def get_caller_identity(self): return {'Account': 'wrong' if case == 'foreign-account' else '413781344298'}
    def describe_spot_instance_requests(self, **kw):
        if case == 'access-denied': raise ClientError('AccessDenied')
        return {'SpotInstanceRequests': [{'SpotInstanceRequestId':'sir-1', 'State':'active', 'Tags':tags}] if self.spot else []}
    def cancel_spot_instance_requests(self, **kw):
        log.append(['cancel', kw['SpotInstanceRequestIds']])
        if case == 'throttled' and not self.throttled:
            self.throttled = True
            raise ClientError('RequestLimitExceeded')
        self.spot = False
    def describe_instances(self, **kw):
        assert not self.spot
        if case == 'late-create' and clock[0] >= 100 and not self.late_started:
            self.vm = True
            self.late_started = True
        if case == 'pagination-cycle': return {'NextToken':'cycle'}
        if 'NextToken' not in kw: return {'NextToken':'page2', 'Reservations':[{'Instances':[{'InstanceId':'i-foreign','State':{'Name':'running'},'Tags':[]}]}]}
        return {'Reservations':[{'Instances':[{'InstanceId':'i-1','State':{'Name':'running'},'Tags':tags}]}] if self.vm else []}
    def terminate_instances(self, **kw):
        log.append(['terminate', kw['InstanceIds']]); self.vm = False
    def describe_volumes(self, **kw):
        return {'Volumes':[{'VolumeId':'vol-1','State':'available','Tags':tags}]} if self.volume else {}
    def delete_volume(self, **kw):
        log.append(['volume',kw['VolumeId']])
        if case != 'residue': self.volume = False
    def describe_snapshots(self, **kw):
        assert kw['OwnerIds'] == ['413781344298']
        return {'Snapshots':[{'SnapshotId':'snap-1','Tags':tags}]} if self.snapshot else {}
    def delete_snapshot(self, **kw): log.append(['snapshot',kw['SnapshotId']]); self.snapshot = False
world = World()
tags = [{'Key':'papercusp:managed','Value':'true'},{'Key':'papercusp:workspace-id','Value':'hosted-fixture-p544-trial'}]
sys.modules['boto3'] = types.SimpleNamespace(client=lambda *a, **k: world)
sys.modules['botocore'] = types.ModuleType('botocore')
sys.modules['botocore.config'] = types.SimpleNamespace(Config=lambda **k: k)
sys.modules['botocore.exceptions'] = types.SimpleNamespace(ClientError=ClientError)
import time
time.monotonic = lambda: clock[0]
time.time = lambda: clock[0]
def sleep(n): clock[0] += n
time.sleep = sleep
exec(sys.stdin.read())
try:
    result = cleanup({'region':'us-east-2','accountId':'413781344298','deadlineEpoch':660,'settleEpoch':300,
        'filters':[{'Name':'tag:papercusp:managed','Values':['true']},{'Name':'tag:papercusp:workspace-id','Values':['hosted-fixture-p544-trial']}]}, None)
    print(json.dumps({'result':result,'log':log,'finishedAt':clock[0]}))
except Exception as error:
    print(json.dumps({'error':str(error),'log':log}))
`;
    const child = spawnSync('python3', ['-c', harness, scenario], { input: AWS_CANARY_CLEANUP_SCRIPT,
      encoding: 'utf8', timeout: 5000 });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout);
    if (scenario === 'normal' || scenario === 'throttled' || scenario === 'late-create') {
      expect(result.result).toEqual({ complete: true, residue: [] });
      expect(result.finishedAt).toBeGreaterThanOrEqual(300);
      if (scenario === 'late-create') {
        expect(result.log.filter(([op]: string[]) => op === 'terminate')).toHaveLength(2);
      }
      expect(result.log.findIndex(([op]: string[]) => op === 'cancel')).toBeLessThan(
        result.log.findIndex(([op]: string[]) => op === 'terminate'));
      expect(result.log).toContainEqual(['terminate', ['i-1']]);
      expect(result.log).not.toContainEqual(['terminate', ['i-foreign']]);
      expect(result.log).toContainEqual(['volume', 'vol-1']);
      expect(result.log).toContainEqual(['snapshot', 'snap-1']);
    } else {
      expect(result.error).toBeTruthy();
      expect(result.result).toBeUndefined();
      if (scenario === 'foreign-account' || scenario === 'access-denied') expect(result.log).toEqual([]);
    }
  });
});
