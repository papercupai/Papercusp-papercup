import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNightlyBackupPlan, BACKUP_COMPLETION_METRIC, provisionNightlyBackups, parseBackupInvocation, type BackupApi } from './nightly-backup-plan';
import { PROD_SPEC, type GcloudRunner } from './provision-cloud-sql';

const input = { backupProject:'papercusp-cloud-backup',bucket:'papercusp-cloud-backup-exports',
  cloudSqlServiceAccount:'p46711101119-ook5aw@gcp-sa-cloud-sql.iam.gserviceaccount.com',
  notificationChannels:['projects/papercusp-cloud-backup/notificationChannels/123'],retentionDays:7 };

describe('independent backup storage boundary', () => {
  it('refuses production-project storage and missing alert recipients before producing a plan', () => {
    expect(()=>buildNightlyBackupPlan({...input,backupProject:'papercusp-cloud-prod'})).toThrow('separate');
    expect(()=>buildNightlyBackupPlan({...input,notificationChannels:[]})).toThrow('notification_channels');
    expect(()=>buildNightlyBackupPlan({...input,notificationChannels:['projects/other/notificationChannels/123']})).toThrow('notification_channels');
  });
  it('separates scheduler, exporter, SQL writer and custodian without private keys or hosted-runtime grants', () => {
    const plan=buildNightlyBackupPlan(input);
    expect(new Set(Object.values(plan.identities)).size).toBe(4);
    const commands=plan.commands.map(c=>c.join(' '));
    expect(commands.some(c=>c.includes('roles/storage.objectCreator'))).toBe(true);
    expect(commands.some(c=>c.includes('pc-backup-custodian')&&c.includes('roles/storage.admin'))).toBe(true);
    expect(commands.some(c=>/keys create|pc-hosted-control-plane|roles\/editor|roles\/owner/.test(c))).toBe(false);
    expect(plan.role.includedPermissions).not.toContain('cloudsql.instances.delete');
    expect(plan.role.includedPermissions).not.toContain('cloudsql.instances.restoreBackup');
    expect(plan.invokerRole.includedPermissions).toEqual(['workflows.executions.create']);
    expect(plan.commands.some(c => c[0] === 'workflows' && c[1]!.includes('iam-policy'))).toBe(false);
  });
});

describe('export completion detector', () => {
  it('does not signal completion until a successful DONE operation; bounds polling', () => {
    const plan=buildNightlyBackupPlan(input);
    const iteration=plan.workflowSource.main.steps[1]!.exportDatabases!.for.steps;
    const switchStep=iteration[3]!.inspectOperation!.switch;
    expect(switchStep[0]!.steps).toMatchObject([{ exportFailed: { raise: 'cloud_sql_export_failed' } }]);
    expect(switchStep[1]!.next).toBe('recordCompletion');
    expect(switchStep[2]!.steps).toMatchObject([{ exportTimedOut: { raise: 'cloud_sql_export_deadline_exceeded' } }]);
    expect(JSON.stringify(iteration[5])).toContain(BACKUP_COMPLETION_METRIC);
    expect(plan.alertPolicies).toHaveLength(3);
    expect(plan.alertPolicies.every(p=>p.enabled&&p.conditions[0]!.conditionAbsent.duration==='93600s')).toBe(true);
  });
  it('uses unique gzipped SQL exports and enumerates every production database', () => {
    const plan=buildNightlyBackupPlan(input);
    expect(plan.workflowSource.main.steps[0]!.initialize!.assign[0]!.databases).toEqual(['papercusp_hosted','portal','dbos_system']);
    const exportContext=plan.workflowSource.main.steps[1]!.exportDatabases!.for.steps[0]!.startExport!.args.body.exportContext;
    expect(exportContext.uri).toContain('execution');
    expect(exportContext.uri).toContain('.sql.gz');
    expect(exportContext.offload).toBe(false);
    expect(plan.commands.at(-1)).toContain('--schedule=0 7 * * *');
  });
});

const approval = { retentionDecisionRef: 'owner-decision:retention', storageDecisionRef: 'owner-decision:backup-storage',
  backupAdminMember: 'group:backup-admins@example.test',
  activationEvidence: { exportRestoreRef: 'evidence:logical-restore', alertDeliveryRef: 'evidence:delivered-alarm' } };

/** Stateful provider double: reads reflect mutations and canonical API identities,
 * rather than returning the expected config independently of what was written. */
function provider() {
  const plan = buildNightlyBackupPlan(input);
  const resources = new Map<string, any>();
  const policies = new Map<string, any>([
    [input.backupProject, { bindings: [{ role: 'roles/owner', members: [approval.backupAdminMember] }] }],
    [PROD_SPEC.project, { bindings: [] }], [input.bucket, { bindings: [] }], ['workflow', { bindings: [] }],
  ]);
  const mutations: string[][] = [];
  let enabled = false;
  let metric: any = null;
  const alerts: any[] = [];
  const absent = () => ({ code: 1, stdout: '', stderr: 'NOT_FOUND' });
  const json = (value: any) => value ? ({ code: 0, stdout: JSON.stringify(value), stderr: '' }) : absent();
  const gcloud: GcloudRunner = async args => {
    const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
    const prefix = args.slice(0, 3).join(' ');
    if (prefix === 'projects describe papercusp-cloud-backup') return json({ projectId: input.backupProject, projectNumber: '123456789', lifecycleState: 'ACTIVE', parent: { type: 'organization', id: PROD_SPEC.organizationId } });
    if (prefix === 'billing projects describe') return json({ billingEnabled: true, billingAccountName: `billingAccounts/${PROD_SPEC.billingAccount}` });
    if (prefix === 'sql instances describe') return json({ project: PROD_SPEC.project, name: PROD_SPEC.instance, state: 'RUNNABLE', serviceAccountEmailAddress: input.cloudSqlServiceAccount });
    if (prefix === 'services list --enabled') return json(enabled ? plan.commands[0]!.slice(2, -1).map(name => ({ config: { name } })) : []);
    if (args[0] === 'projects' && args[1] === 'get-iam-policy') return json(policies.get(args[2]!));
    if (prefix === 'storage buckets get-iam-policy') return json(policies.get(input.bucket));
    if (prefix === 'iam service-accounts describe') return json(resources.get(args[3]!));
    if (prefix === 'storage buckets describe') return json(resources.get('bucket'));
    if (prefix === 'iam roles describe') return json(resources.get(args[3]!));
    if (prefix === 'workflows describe pc-nightly-cloud-sql-export') return json(resources.get('workflow'));
    if (prefix === 'scheduler jobs describe') return json(resources.get('job'));
    mutations.push([...args]);
    if (args[0] === 'services' && args[1] === 'enable') enabled = true;
    else if (prefix === 'iam service-accounts create') {
      const email = `${args[3]}@${input.backupProject}.iam.gserviceaccount.com`;
      resources.set(email, { email, name: `projects/${input.backupProject}/serviceAccounts/123456789123`, uniqueId: '123456789123' });
    } else if (prefix === 'storage buckets create') resources.set('bucket', {
      name: input.bucket, projectNumber: '123456789', location: PROD_SPEC.region.toUpperCase(),
      iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
      retentionPolicy: { retentionPeriod: String(Number(flag('retention-period')!.replace('d', '')) * 86400) },
      lifecycle: JSON.parse(readFileSync(flag('lifecycle-file')!, 'utf8')),
    });
    else if (prefix === 'iam roles create') resources.set(args[3]!, JSON.parse(readFileSync(flag('file')!, 'utf8')));
    else if (args.includes('add-iam-policy-binding')) {
      const key = args[0] === 'projects' ? args[2]! : args[0] === 'storage' ? input.bucket : 'workflow';
      policies.get(key).bindings.push({ role: flag('role'), members: [flag('member')] });
    } else if (prefix === 'workflows deploy pc-nightly-cloud-sql-export') resources.set('workflow', {
      state: 'ACTIVE', serviceAccount: `projects/123456789/serviceAccounts/${flag('service-account')}`,
      sourceContents: readFileSync(flag('source')!, 'utf8'), callLogLevel: 'LOG_ERRORS_ONLY',
    });
    else if (prefix === 'scheduler jobs create') resources.set('job', {
      state: 'ENABLED', schedule: flag('schedule'), timeZone: flag('time-zone'),
      httpTarget: { uri: flag('uri'), httpMethod: flag('http-method'), oauthToken: { serviceAccountEmail: flag('oauth-service-account-email') } },
    });
    else throw new Error(`Unexpected provider mutation: ${args.join(' ')}`);
    return json({});
  };
  const api: BackupApi = async (method, url, body) => {
    if (url.includes('/notificationChannels/')) return { status: 200, body: { name: input.notificationChannels[0], enabled: true, verificationStatus: 'VERIFIED' } };
    if (method === 'POST') {
      mutations.push([method, url]);
      if (url.endsWith('/metricDescriptors')) metric = body;
      else if (url.endsWith('/alertPolicies')) alerts.push({ ...(body as any), name: `projects/${input.backupProject}/alertPolicies/${alerts.length + 1}` });
      else throw new Error(`Unexpected API mutation: ${url}`);
      return { status: 200, body: {} };
    }
    if (url.includes('/metricDescriptors/')) return { status: metric ? 200 : 404, body: metric };
    if (url.includes('/alertPolicies?')) return { status: 200, body: { alertPolicies: alerts } };
    throw new Error(`Unexpected API read: ${url}`);
  };
  return { gcloud, api, resources, policies, mutations, alerts };
}

describe('idempotent backup provisioning and readback', () => {
  it('takes config over stdin while refusing a substituted production target or transport', () => {
    expect(parseBackupInvocation(['plan'], JSON.stringify(input)).mode).toBe('plan');
    expect(() => parseBackupInvocation(['drill'], JSON.stringify(input))).toThrow('usage');
    expect(() => parseBackupInvocation(['up'], JSON.stringify({ ...input, spec: { project: 'other' } }))).toThrow('unknown_key');
    expect(() => parseBackupInvocation(['up'], JSON.stringify({ ...input, mode: 'plan' }))).toThrow('unknown_key');
  });
  it('creates resources once, verifies canonical provider reads, then reruns without mutations', async () => {
    const p = provider();
    const options = { ...input, ...p, approval, mode: 'up' as const };
    const first = await provisionNightlyBackups(options);
    expect(first.scheduleArmed).toBe(true);
    expect(p.alerts).toHaveLength(3);
    expect(p.resources.get('bucket').retentionPolicy.retentionPeriod).toBe('604800');
    const created = p.mutations.length;
    expect(created).toBeGreaterThan(10);
    expect((await provisionNightlyBackups(options)).mutations).toEqual([]);
    expect((await provisionNightlyBackups({ ...options, mode: 'verify' })).scheduleArmed).toBe(true);
    expect(p.mutations).toHaveLength(created);
  });
  it('preview reads resources but creates nothing; owner approval is mandatory for up', async () => {
    const p = provider();
    const preview = await provisionNightlyBackups({ ...input, ...p, mode: 'plan' });
    expect(preview.pending.length).toBeGreaterThan(0);
    expect(p.mutations).toEqual([]);
    await expect(provisionNightlyBackups({ ...input, ...p, mode: 'up' })).rejects.toThrow('owner_decisions');
    expect(p.mutations).toEqual([]);
  });
  it('does not arm a schedule without restore and detector evidence', async () => {
    const p = provider();
    const result = await provisionNightlyBackups({ ...input, ...p, approval: { ...approval, activationEvidence: undefined }, mode: 'up' });
    expect(result.scheduleArmed).toBe(false);
    expect(p.resources.has('job')).toBe(false);
    expect(result.pending).toContain('schedule: export/restore and alarm-delivery evidence required');
  });
  it('treats access denial as unknown, never as absence', async () => {
    const p = provider();
    const gcloud: GcloudRunner = async (args, opts) => args[0] === 'iam' && args[1] === 'service-accounts' && args[2] === 'describe'
      ? { code: 1, stdout: '', stderr: 'PERMISSION_DENIED' } : p.gcloud(args, opts);
    await expect(provisionNightlyBackups({ ...input, ...p, gcloud, approval, mode: 'up' })).rejects.toThrow('backup_read_failed');
    expect(p.mutations.some(a => a[0] === 'iam')).toBe(false);
  });
  it('refuses source identity or alert recipient mismatches before changing anything', async () => {
    const p = provider();
    await expect(provisionNightlyBackups({ ...input, ...p, cloudSqlServiceAccount: 'wrong@gcp-sa-cloud-sql.iam.gserviceaccount.com', approval, mode: 'up' })).rejects.toThrow('source_identity');
    const api: BackupApi = async (method, url, body) => url.includes('/notificationChannels/')
      ? { status: 200, body: { name: input.notificationChannels[0], enabled: true, verificationStatus: 'UNVERIFIED' } } : p.api(method, url, body);
    await expect(provisionNightlyBackups({ ...input, ...p, api, approval, mode: 'up' })).rejects.toThrow('channel_unverified');
    expect(p.mutations).toEqual([]);
  });
  it('keeps the hosted identity out of backup storage while allowing its legitimate production project grants', async () => {
    const p = provider();
    const member = `serviceAccount:pc-hosted-control-plane@${PROD_SPEC.project}.iam.gserviceaccount.com`;
    p.policies.get(PROD_SPEC.project).bindings.push({ role: 'roles/logging.logWriter', members: [member] });
    await expect(provisionNightlyBackups({ ...input, ...p, approval, mode: 'up' })).resolves.toMatchObject({ scheduleArmed: true });
    p.policies.get(input.bucket).bindings.push({ role: 'roles/storage.objectViewer', members: [member] });
    const previous = p.mutations.length;
    await expect(provisionNightlyBackups({ ...input, ...p, approval, mode: 'verify' })).rejects.toThrow('runtime_access_forbidden');
    expect(p.mutations).toHaveLength(previous);
  });
  it('refuses drift without overwriting the bucket or weakening retention', async () => {
    const p = provider();
    const options = { ...input, ...p, approval, mode: 'up' as const };
    await provisionNightlyBackups(options);
    const created = p.mutations.length;
    p.resources.get('bucket').retentionPolicy.retentionPeriod = '0';
    await expect(provisionNightlyBackups(options)).rejects.toThrow('resource_drift:bucket');
    expect(p.mutations).toHaveLength(created);
  });
  it('requires actual creation readback and refuses duplicate alert policies', async () => {
    const p = provider();
    const options = { ...input, ...p, approval, mode: 'up' as const };
    const gcloud: GcloudRunner = async (args, opts) => {
      const result = await p.gcloud(args, opts);
      if (args.slice(0, 3).join(' ') === 'storage buckets create') p.resources.delete('bucket');
      return result;
    };
    await expect(provisionNightlyBackups({ ...options, gcloud })).rejects.toThrow('resource_drift:bucket');
    await provisionNightlyBackups(options);
    p.alerts.push({ ...p.alerts[0] });
    await expect(provisionNightlyBackups(options)).rejects.toThrow('duplicate_alert_policy');
  });
});
