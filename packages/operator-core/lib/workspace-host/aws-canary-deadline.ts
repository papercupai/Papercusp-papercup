/**
 * Finite AWS trial deadline foundation (P-544). Reuses Systems Manager Automation
 * and the provider's managed-resource tags; no guest timer or controller loop.
 *
 * This is a plan, NOT a launch authorization. The caller must install/read back
 * the IAM cutoff and immutable document, then observe this exact execution
 * sleeping before launching anything. The positive fixture stays closed until
 * that production integration and its live proof exist.
 */
import { createHash } from 'node:crypto';
import { AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS, awsWorkspaceHostManagedFilters } from './aws-safety';
import { HOSTED_AWS_REGION } from './hosted-aws-host-stack';

export interface AwsCanaryDeadlineInput {
  accountId: string;
  region: string;
  workspaceId: string;
  runId: string;
  workloadDeadlineAt: string;
  teardownDeadlineAt: string;
  cleanupRoleArn: string;
}

// SSM executeScript has a 600 second ceiling. Leave another minute for the
// transition from the absolute-time sleep and service-side execution startup.
export const AWS_CANARY_CLEANUP_BUDGET_MS = 660_000;
export const AWS_CANARY_CREATION_SETTLE_MS = 300_000;

/** Executed by SSM's Python runtime, never by the workspace guest. */
export const AWS_CANARY_CLEANUP_SCRIPT = `
def cleanup(events, context):
    import boto3
    import time
    from botocore.config import Config
    from botocore.exceptions import ClientError

    region = events['region']
    config = Config(connect_timeout=5, read_timeout=10, retries={'total_max_attempts': 1})
    if boto3.client('sts', region_name=region, config=config).get_caller_identity()['Account'] != events['accountId']:
        raise RuntimeError('canary cleanup account mismatch')
    ec2 = boto3.client('ec2', region_name=region, config=config)
    filters = events['filters']
    expected = {f['Name'][4:]: f['Values'][0] for f in filters}
    end = min(time.monotonic() + 540, time.monotonic() + max(0, events['deadlineEpoch'] - time.time()))
    retryable = {'Throttling', 'ThrottlingException', 'RequestLimitExceeded', 'ServiceUnavailable',
                 'InternalError', 'VolumeInUse', 'IncorrectState', 'DependencyViolation', 'SnapshotInUse'}
    absent = {'InvalidInstanceID.NotFound', 'InvalidVolume.NotFound', 'InvalidSnapshot.NotFound',
              'InvalidSpotInstanceRequestID.NotFound'}

    def check_time():
        if time.monotonic() >= end:
            raise RuntimeError('canary cleanup deadline reached; residue unverified')

    def pages(operation, key, **extra):
        token = None
        seen = set()
        values = []
        while True:
            check_time()
            args = dict(Filters=filters, **extra)
            if token:
                args['NextToken'] = token
            page = getattr(ec2, operation)(**args)
            values.extend(page.get(key, []))
            token = page.get('NextToken')
            if not token:
                return values
            if token in seen:
                raise RuntimeError('canary cleanup pagination cycle')
            seen.add(token)

    def owned(item):
        tags = {tag['Key']: tag['Value'] for tag in item.get('Tags', [])}
        return all(tags.get(key) == value for key, value in expected.items())

    def mutate(operation, **args):
        check_time()
        try:
            getattr(ec2, operation)(**args)
        except ClientError as error:
            if error.response['Error']['Code'] not in absent:
                raise

    clean_reads = 0
    while True:
        check_time()
        try:
            # A persistent spot request can replace a terminated VM. Cancel all
            # requests first, and prove cancellation in a new census before VMs.
            spots = [x for x in pages('describe_spot_instance_requests', 'SpotInstanceRequests')
                     if owned(x) and x.get('State') in ('open', 'active', 'disabled')]
            if spots:
                clean_reads = 0
                for item in spots:
                    mutate('cancel_spot_instance_requests', SpotInstanceRequestIds=[item['SpotInstanceRequestId']])
                time.sleep(2)
                continue
            instances = [x for reservation in pages('describe_instances', 'Reservations')
                         for x in reservation.get('Instances', [])
                         if owned(x) and x.get('State', {}).get('Name') != 'terminated']
            for item in instances:
                if item.get('State', {}).get('Name') != 'shutting-down':
                    mutate('terminate_instances', InstanceIds=[item['InstanceId']])
            volumes = [x for x in pages('describe_volumes', 'Volumes') if owned(x) and x.get('State') != 'deleted']
            for item in volumes:
                if item.get('State') == 'available':
                    mutate('delete_volume', VolumeId=item['VolumeId'])
            snapshots = [x for x in pages('describe_snapshots', 'Snapshots', OwnerIds=[events['accountId']]) if owned(x)]
            for item in snapshots:
                mutate('delete_snapshot', SnapshotId=item['SnapshotId'])
            if not instances and not volumes and not snapshots:
                # No create/start is authorized after the cutoff. This fresh,
                # complete four-kind census is the only successful terminal.
                clean_reads += 1
                # EC2 inventory is eventually consistent. Keep sweeping through
                # the settlement window for creates admitted before the cutoff;
                # an early empty read must not retire the independent cleanup.
                if time.time() >= events['settleEpoch'] and clean_reads >= 2:
                    return {'complete': True, 'residue': []}
            else:
                clean_reads = 0
        except ClientError as error:
            clean_reads = 0
            if error.response['Error']['Code'] not in retryable:
                raise
        time.sleep(2)
`;

function instant(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error('AWS canary deadline requires canonical UTC timestamps');
  }
  return parsed;
}

/** AWS may reorder JSON object keys in IAM/SSM readbacks. Array order remains significant. */
export function canonicalAwsCanaryJson(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, ordered(child)])) : item;
  return JSON.stringify(ordered(value));
}

export function planAwsCanaryDeadline(input: AwsCanaryDeadlineInput, nowMs = Date.now()) {
  if (!/^\d{12}$/.test(input.accountId) || !HOSTED_AWS_REGION.test(input.region)) {
    throw new Error('AWS canary account or region invalid');
  }
  // with-test-pg owns the isolated runtime identity used by the genuine hosted
  // fixture. Keep that exact private namespace alongside the standalone fixture.
  const privateWorkspace = /^hosted-fixture-[a-zA-Z0-9_-]{8,120}$/.test(input.workspaceId) ||
    /^test-runtime-[a-z0-9-]+$/.test(input.workspaceId);
  if (!/^[a-zA-Z0-9_-]{8,120}$/.test(input.runId) || !privateWorkspace) {
    throw new Error('AWS canary requires a run id and dedicated private fixture workspace');
  }
  if (!new RegExp(`^arn:aws:iam::${input.accountId}:role/[a-zA-Z0-9_+=,.@/-]+$`).test(input.cleanupRoleArn)) {
    throw new Error('AWS canary cleanup role must belong to the exact account');
  }
  const cutoff = instant(input.workloadDeadlineAt);
  const deadline = instant(input.teardownDeadlineAt);
  if (cutoff <= nowMs || cutoff - nowMs > 604_799_000 || deadline - cutoff < AWS_CANARY_CLEANUP_BUDGET_MS) {
    throw new Error('AWS canary needs a future cutoff within seven days and the full cleanup reserve');
  }
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const documentName = `papercusp-canary-${createHash('sha256').update(input.runId).digest('hex').slice(0, 32)}`;
  const clientToken = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  const filters = awsWorkspaceHostManagedFilters(input.workspaceId);
  const document = {
    schemaVersion: '0.3',
    description: `Finite Papercusp trial ${input.runId}; deadline ${input.teardownDeadlineAt}`,
    assumeRole: input.cleanupRoleArn,
    mainSteps: [
      { name: 'AwaitCreationCutoff', action: 'aws:sleep', inputs: { Timestamp: input.workloadDeadlineAt } },
      { name: 'CleanupManagedResources', action: 'aws:executeScript', timeoutSeconds: 600, isEnd: true,
        inputs: { Runtime: 'python3.11', Handler: 'cleanup', Script: AWS_CANARY_CLEANUP_SCRIPT,
          InputPayload: { accountId: input.accountId, region: input.region, filters,
            settleEpoch: (cutoff + AWS_CANARY_CREATION_SETTLE_MS) / 1000, deadlineEpoch: deadline / 1000 } } },
    ],
  };
  // Attach this as an identity policy on the dedicated trial launcher role,
  // never as a stand-alone session policy (a deny-only session policy allows nothing).
  const launcherDeadlineDenyPolicy = { Version: '2012-10-17', Statement: [
    { Sid: 'NoCreationAfterTrialCutoff', Effect: 'Deny',
      Action: ['ec2:RunInstances', 'ec2:CreateVolume', 'ec2:CreateSnapshot', 'ec2:StartInstances',
        'ec2:RequestSpotInstances', 'ec2:RequestSpotFleet', 'ec2:CreateFleet', 'ec2:CopySnapshot'],
      Resource: '*', Condition: { DateGreaterThanEquals: { 'aws:CurrentTime': input.workloadDeadlineAt } } },
    { Sid: 'NoRetaggingTrialResources', Effect: 'Deny', Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
      Resource: '*', Condition: { Null: { 'ec2:CreateAction': 'true' } } },
  ] };
  const tagConditions = Object.fromEntries(Object.entries(AWS_WORKSPACE_HOST_MANAGED_TAG_KEYS)
    .filter(([name]) => name !== 'hostId')
    .map(([name, key]) => [`ec2:ResourceTag/${key}`, name === 'managed' ? 'true' : input.workspaceId]));
  const cleanupPolicy = { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeSnapshots',
      'ec2:DescribeSpotInstanceRequests'], Resource: '*' },
    { Effect: 'Allow', Action: ['ec2:TerminateInstances', 'ec2:DeleteVolume',
      'ec2:CancelSpotInstanceRequests'],
      Resource: ['instance', 'volume', 'spot-instances-request']
        .map(kind => `arn:aws:ec2:${input.region}:${input.accountId}:${kind}/*`),
      Condition: { StringEquals: tagConditions } },
    // AWS snapshot ARNs have an EMPTY account segment. Pin ownership through
    // ec2:Owner instead (official EC2 service authorization resource schema).
    { Effect: 'Allow', Action: ['ec2:DeleteSnapshot'],
      Resource: `arn:aws:ec2:${input.region}::snapshot/*`,
      Condition: { StringEquals: { ...tagConditions, 'ec2:Owner': input.accountId } } },
  ] };
  return { input: { ...input }, documentName, documentVersion: '1', document, clientToken,
    contentSha256: createHash('sha256').update(canonicalAwsCanaryJson(document)).digest('hex'),
    launcherDeadlineDenyPolicy, cleanupPolicy };
}

export type AwsCanaryDeadlinePlan = ReturnType<typeof planAwsCanaryDeadline>;

/** Refuses a stale/different document or an execution that is not already waiting. */
export function assertAwsCanaryDeadlineSleeping(plan: AwsCanaryDeadlinePlan, evidence: {
  accountId: string; region: string; documentName: string; documentVersion: string; content: string;
  executionId: string; executionStatus: string;
  currentStep: { name: string; action: string; status: string };
}, nowMs = Date.now()): void {
  const sameContent = createHash('sha256').update(canonicalAwsCanaryJson(JSON.parse(evidence.content))).digest('hex') === plan.contentSha256;
  if (!sameContent || evidence.accountId !== plan.input.accountId || evidence.region !== plan.input.region ||
      evidence.documentName !== plan.documentName || evidence.documentVersion !== plan.documentVersion ||
      !/^[a-f0-9-]{36}$/.test(evidence.executionId) ||
      evidence.executionStatus !== 'InProgress' || evidence.currentStep.name !== 'AwaitCreationCutoff' ||
      evidence.currentStep.action !== 'aws:sleep' || evidence.currentStep.status !== 'InProgress' ||
      nowMs >= instant(plan.input.workloadDeadlineAt)) {
    throw new Error('AWS canary independent deadline is not verified sleeping for this exact trial');
  }
}
