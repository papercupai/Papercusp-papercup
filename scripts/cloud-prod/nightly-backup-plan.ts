#!/usr/bin/env -S npx tsx
/** P-009 cloud-owned logical export configuration and provisioner. The pure
 * builder and `plan` mode change no resources/IAM/schedule. Reuses PROD_SPEC and the
 * Cloud SQL export API; runs outside the dev-box operator routine engine.
 * A separate project owns backup storage and workflow/scheduler identities.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { PROD_SPEC, realGcloud, type CloudSqlProdSpec, type GcloudRunner } from './provision-cloud-sql';

export const BACKUP_COMPLETION_METRIC = 'custom.googleapis.com/papercusp/backup/export_completed';
const expression = (value: string) => '${' + value + '}';

export interface BackupPlanOptions {
  backupProject: string;
  bucket: string;
  cloudSqlServiceAccount: string;
  /** Existing, owner-approved Cloud Monitoring notification channels. */
  notificationChannels: string[];
  /** P-011 must approve customer-data retention before this config is deployed. */
  retentionDays: number;
  spec?: CloudSqlProdSpec;
}

export function buildNightlyBackupPlan(options: BackupPlanOptions) {
  const spec = options.spec ?? PROD_SPEC;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.backupProject) || options.backupProject === spec.project)
    throw new Error('backup_project_must_be_separate');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket)) throw new Error('backup_bucket_invalid');
  if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(options.cloudSqlServiceAccount)) throw new Error('backup_sql_identity_invalid');
  if (!Number.isInteger(options.retentionDays) || options.retentionDays < 7 || options.retentionDays > 365) throw new Error('backup_retention_invalid');
  if (!options.notificationChannels.length || options.notificationChannels.some(ref => !new RegExp(`^projects/${options.backupProject}/notificationChannels/[0-9]+$`).test(ref)))
    throw new Error('backup_notification_channels_required');
  const workflow = 'pc-nightly-cloud-sql-export';
  const job = 'pc-nightly-cloud-sql-export';
  const exporter = `pc-backup-export@${options.backupProject}.iam.gserviceaccount.com`;
  const scheduler = `pc-backup-schedule@${options.backupProject}.iam.gserviceaccount.com`;
  const custodian = `pc-backup-custodian@${options.backupProject}.iam.gserviceaccount.com`;
  const workflowName = `projects/${options.backupProject}/locations/${spec.region}/workflows/${workflow}`;
  const sqlBase = `https://sqladmin.googleapis.com/sql/v1beta4/projects/${spec.project}`;
  const workflowSource = {
    main: { steps: [
      { initialize: { assign: [
        { databases: [...spec.databases] }, { bucket: options.bucket },
        { execution: expression('sys.get_env("GOOGLE_CLOUD_WORKFLOW_EXECUTION_ID")') },
      ] } },
      { exportDatabases: { for: { value: 'database', in: expression('databases'), steps: [
        { startExport: { call: 'http.post', args: {
          url: `${sqlBase}/instances/${spec.instance}/export`, auth: { type: 'OAuth2' },
          body: { exportContext: { fileType: 'SQL', databases: [expression('database')],
            uri: expression('"gs://" + bucket + "/" + execution + "/" + database + ".sql.gz"'), offload: false } },
        }, result: 'exportOperation' } },
        { setDeadline: { assign: [{ deadline: expression('sys.now() + 1800') }] } },
        { pollOperation: { call: 'http.get', args: {
          url: expression(JSON.stringify(`${sqlBase}/operations/`) + ' + exportOperation.body.name'), auth: { type: 'OAuth2' },
        }, result: 'operationState' } },
        { inspectOperation: { switch: [
          { condition: expression('map.get(operationState.body, "error") != null'), steps: [{ exportFailed: { raise: 'cloud_sql_export_failed' } }] },
          { condition: expression('operationState.body.status == "DONE"'), next: 'recordCompletion' },
          { condition: expression('sys.now() > deadline'), steps: [{ exportTimedOut: { raise: 'cloud_sql_export_deadline_exceeded' } }] },
        ] } },
        { sleepBeforePoll: { call: 'sys.sleep', args: { seconds: 15 }, next: 'pollOperation' } },
        // Only a settled successful operation produces the detector signal.
        { recordCompletion: { call: 'http.post', args: {
          url: `https://monitoring.googleapis.com/v3/projects/${options.backupProject}/timeSeries`, auth: { type: 'OAuth2' },
          body: { timeSeries: [{ metric: { type: BACKUP_COMPLETION_METRIC, labels: { database: expression('database') } },
            resource: { type: 'global', labels: { project_id: options.backupProject } }, metricKind: 'GAUGE', valueType: 'DOUBLE',
            points: [{ interval: { endTime: expression('time.format(sys.now())') }, value: { doubleValue: 1 } }],
          }] },
        } } },
      ] } } },
      { finished: { return: { exported: expression('databases'), execution: expression('execution') } } },
    ] },
  };
  const role = { title: 'Papercusp backup export only', stage: 'GA',
    includedPermissions: ['cloudsql.instances.export', 'cloudsql.instances.get', 'cloudsql.operations.get'] };
  // Workflows has project-level IAM, not a per-workflow policy API. Keep the
  // scheduler to creation only in this dedicated backup project.
  const invokerRole = { title: 'Papercusp backup execution only', stage: 'GA', includedPermissions: ['workflows.executions.create'] };
  const alertPolicies = spec.databases.map(database => ({
    displayName: `Production backup stale: ${database}`, enabled: true, combiner: 'OR',
    notificationChannels: options.notificationChannels,
    documentation: { mimeType: 'text/markdown', content: `No successful logical export for ${database} within 26 hours. Check the nightly workflow's failed execution and Cloud SQL operation. A stored object or attempted export is insufficient. Follow the P-009 backup runbook.` },
    conditions: [{ displayName: `No completed export: ${database}`, conditionAbsent: {
      filter: `metric.type="${BACKUP_COMPLETION_METRIC}" AND resource.type="global" AND metric.labels.database="${database}"`,
      duration: '93600s', aggregations: [{ alignmentPeriod: '60s', perSeriesAligner: 'ALIGN_MAX' }], trigger: { count: 1 },
    } }],
  }));
  const lifecycle = { rule: [{ action: { type: 'Delete' }, condition: { age: options.retentionDays } }] };
  const projectFlag = `--project=${options.backupProject}`;
  // These are argv arrays, never shell strings. No command exports credentials,
  // grants the hosted runtime access, or grants the exporter delete/restore rights.
  const commands = [
    ['services', 'enable', 'iam.googleapis.com', 'storage.googleapis.com', 'workflows.googleapis.com', 'workflowexecutions.googleapis.com', 'cloudscheduler.googleapis.com', 'monitoring.googleapis.com', projectFlag],
    ...['pc-backup-export', 'pc-backup-schedule', 'pc-backup-custodian'].map(name => ['iam', 'service-accounts', 'create', name, projectFlag]),
    ['storage', 'buckets', 'create', `gs://${options.bucket}`, projectFlag, `--location=${spec.region}`,
      '--uniform-bucket-level-access', '--public-access-prevention', `--retention-period=${options.retentionDays}d`, '--lifecycle-file=backup-lifecycle.json'],
    ['storage', 'buckets', 'add-iam-policy-binding', `gs://${options.bucket}`, `--member=serviceAccount:${options.cloudSqlServiceAccount}`, '--role=roles/storage.objectCreator'],
    ['storage', 'buckets', 'add-iam-policy-binding', `gs://${options.bucket}`, `--member=serviceAccount:${custodian}`, '--role=roles/storage.admin'],
    ['iam', 'roles', 'create', 'pcBackupExport', `--project=${spec.project}`, '--file=backup-export-role.json'],
    ['projects', 'add-iam-policy-binding', spec.project, `--member=serviceAccount:${exporter}`, `--role=projects/${spec.project}/roles/pcBackupExport`, '--condition=None'],
    ['projects', 'add-iam-policy-binding', options.backupProject, `--member=serviceAccount:${exporter}`, '--role=roles/monitoring.metricWriter', '--condition=None'],
    ['workflows', 'deploy', workflow, projectFlag, `--location=${spec.region}`, `--service-account=${exporter}`, '--source=backup-workflow.json', '--call-log-level=log-errors-only'],
    ['iam', 'roles', 'create', 'pcBackupInvoke', projectFlag, '--file=backup-invoke-role.json'],
    ['projects', 'add-iam-policy-binding', options.backupProject, `--member=serviceAccount:${scheduler}`, `--role=projects/${options.backupProject}/roles/pcBackupInvoke`, '--condition=None'],
    ['scheduler', 'jobs', 'create', 'http', job, projectFlag, `--location=${spec.region}`, '--schedule=0 7 * * *', '--time-zone=Etc/UTC',
      `--uri=https://workflowexecutions.googleapis.com/v1/${workflowName}/executions`, '--http-method=POST', '--message-body={}',
      `--oauth-service-account-email=${scheduler}`, '--max-retry-attempts=0'],
  ];
  return { mode: 'preview-only', backupProject: options.backupProject, bucket: options.bucket,
    identities: { exporter, scheduler, custodian, sqlWriter: options.cloudSqlServiceAccount },
    workflowSource, role, invokerRole, lifecycle, alertPolicies, commands,
    prerequisites: ['Existing separately administered backup project and billing attachment',
      'P-011 owner-approved retentionDays', 'Verified owner notification channels',
      'Idempotent provisioning + readback before applying commands',
      'Seed a successful export metric for each database, then prove the absence alarm',
      'Restore and verify one logical export; IAM and Cloud Scheduler readback'],
  };
}

export type BackupApi = (method: 'GET' | 'POST', url: string, body?: unknown) => Promise<{ status: number; body: any }>;
export interface BackupApproval {
  /** Addressable owner decisions, not booleans inferred from AUTO. */
  retentionDecisionRef: string;
  storageDecisionRef: string;
  backupAdminMember: string;
  /** Arming follows the first export, logical restore and delivered alarm. */
  activationEvidence?: { exportRestoreRef: string; alertDeliveryRef: string };
}

/** Extend the P-004 gcloud seam; no provider credentials enter files or receipts. */
export async function provisionNightlyBackups(options: BackupPlanOptions & {
  mode: 'plan' | 'up' | 'verify'; approval?: BackupApproval;
  gcloud?: GcloudRunner; api?: BackupApi;
}) {
  const plan = buildNightlyBackupPlan(options);
  const spec = options.spec ?? PROD_SPEC;
  const gcloud = options.gcloud ?? realGcloud;
  const approval = options.approval;
  const reference = (value: unknown) => typeof value === 'string' && value.trim().length > 5;
  if (options.mode !== 'plan' && (!reference(approval?.retentionDecisionRef) || !reference(approval?.storageDecisionRef) ||
      !/^(user|group):[^\s@]+@[^\s@]+$/.test(approval?.backupAdminMember ?? '')))
    throw new Error('backup_owner_decisions_required');
  const receipt = { mode: options.mode, project: plan.backupProject, bucket: plan.bucket,
    mutations: [] as string[], verified: [] as string[], scheduleArmed: false,
    pending: [] as string[] };
  const run = async (args: string[]) => {
    const r = await gcloud([...args, '--format=json', '--quiet']);
    if (r.code !== 0) throw new Error(`backup_command_failed:${args.slice(0, 3).join(':')}:${r.code}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const read = async (args: string[]) => {
    const r = await gcloud([...args, '--format=json', '--quiet']);
    if (r.code !== 0) {
      // An access denial is never absence and must never lead to a create.
      if (/NOT_FOUND|was not found|does not exist/i.test(r.stderr)) return null;
      throw new Error(`backup_read_failed:${args.slice(0, 3).join(':')}:${r.code}`);
    }
    return JSON.parse(r.stdout);
  };
  let api = options.api;
  if (!api) {
    const token = await gcloud(['auth', 'print-access-token']);
    if (token.code !== 0 || !token.stdout.trim()) throw new Error('backup_auth_failed');
    api = async (method, url, body) => {
      const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token.stdout.trim()}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
      return { status: response.status, body: await response.json() };
    };
  }
  const apiRead = async (url: string) => {
    const r = await api!('GET', url);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`backup_api_read_failed:${r.status}`);
    return r.body;
  };
  // Finish read-only identity, billing and recipient checks before any mutation.
  const project = await read(['projects', 'describe', plan.backupProject]);
  if (project?.projectId !== plan.backupProject || !/^[1-9][0-9]+$/.test(String(project?.projectNumber)) ||
      project?.lifecycleState !== 'ACTIVE' || project?.parent?.id !== spec.organizationId || project?.parent?.type !== 'organization')
    throw new Error('backup_project_identity_invalid');
  const billing = await read(['billing', 'projects', 'describe', plan.backupProject]);
  if (!billing?.billingEnabled || billing.billingAccountName !== `billingAccounts/${spec.billingAccount}`) throw new Error('backup_billing_invalid');
  const source = await read(['sql', 'instances', 'describe', spec.instance, `--project=${spec.project}`]);
  if (source?.name !== spec.instance || source?.project !== spec.project || source?.state !== 'RUNNABLE' ||
      source?.serviceAccountEmailAddress !== options.cloudSqlServiceAccount) throw new Error('backup_source_identity_invalid');
  const policy = await read(['projects', 'get-iam-policy', plan.backupProject]);
  const member = `serviceAccount:pc-hosted-control-plane@${spec.project}.iam.gserviceaccount.com`;
  if (policy?.bindings?.some((b: any) => b.members?.includes(member))) throw new Error('backup_hosted_runtime_access_forbidden');
  if (approval && !policy?.bindings?.some((b: any) => !b.condition &&
      ['roles/owner', 'roles/resourcemanager.projectIamAdmin'].includes(b.role) && b.members?.includes(approval.backupAdminMember)))
    throw new Error('backup_separate_administrator_required');
  for (const channel of options.notificationChannels) {
    const actual = await apiRead(`https://monitoring.googleapis.com/v3/${channel}`);
    if (actual?.name !== channel || !actual.enabled || actual.verificationStatus !== 'VERIFIED') throw new Error('backup_notification_channel_unverified');
  }
  receipt.verified.push('project-identity', 'billing', 'source-sql-writer', 'notification-channels', 'direct-project-iam-boundary');
  const dir = await mkdtemp(join(tmpdir(), 'pc-backup-config-'));
  try {
    const files: Record<string, unknown> = { 'backup-lifecycle.json': plan.lifecycle, 'backup-export-role.json': plan.role,
      'backup-invoke-role.json': plan.invokerRole, 'backup-workflow.json': plan.workflowSource };
    for (const [name, data] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(data), { mode: 0o600 });
    const materialize = (args: string[]) => args.map(arg => arg.replace(/=(backup-(?:lifecycle|export-role|invoke-role|workflow)\.json)$/, (_, name) => `=${join(dir, name)}`));
    const mutate = async (args: string[]) => {
      receipt.mutations.push(`gcloud ${args.join(' ')}`);
      if (options.mode === 'verify') throw new Error('backup_verify_mutation_forbidden');
      if (options.mode === 'up') await run(materialize(args));
    };
    const ensure = async (key: string, selector: string[], matches: (actual: any) => boolean, command: string[]) => {
      let actual = await read(selector);
      if (!actual) {
        await mutate(command);
        if (options.mode === 'plan') { receipt.pending.push(key); return; }
        actual = await read(selector);
      }
      if (!actual || !matches(actual)) throw new Error(`backup_resource_drift:${key}`);
      receipt.verified.push(key);
    };
    const bp = `--project=${plan.backupProject}`;
    const location = `--location=${spec.region}`;
    const commands = plan.commands;
    const services = await read(['services', 'list', '--enabled', bp]);
    const required = commands[0]!.slice(2, -1);
    if (required.some(service => !services?.some((s: any) => s.config?.name === service))) await mutate(commands[0]!);
    if (options.mode === 'up') {
      const enabled = await read(['services', 'list', '--enabled', bp]);
      if (required.some(service => !enabled?.some((s: any) => s.config?.name === service))) throw new Error('backup_service_readback_failed');
    }
    for (const [index, email] of Object.values(plan.identities).slice(0, 3).entries()) {
      await ensure(`identity:${email}`, ['iam', 'service-accounts', 'describe', email, bp],
        a => a.email === email && !a.disabled && [plan.backupProject, String(project.projectNumber)].some(p =>
          a.name?.startsWith(`projects/${p}/serviceAccounts/`)) && /^[1-9][0-9]+$/.test(String(a.uniqueId)), commands[index + 1]!);
    }
    await ensure('bucket', ['storage', 'buckets', 'describe', `gs://${plan.bucket}`, '--raw'], a =>
      a.name === plan.bucket && String(a.projectNumber) === String(project.projectNumber) && a.location?.toLowerCase() === spec.region &&
      a.iamConfiguration?.uniformBucketLevelAccess?.enabled === true && a.iamConfiguration?.publicAccessPrevention === 'enforced' &&
      Number(a.retentionPolicy?.retentionPeriod) === options.retentionDays * 86400 &&
      a.lifecycle?.rule?.length === 1 && a.lifecycle.rule[0]?.action?.type === 'Delete' &&
      a.lifecycle.rule[0]?.condition?.age === options.retentionDays && Object.keys(a.lifecycle.rule[0].condition).length === 1, commands[4]!);
    await ensure('export-role', ['iam', 'roles', 'describe', 'pcBackupExport', `--project=${spec.project}`], a =>
      !a.deleted && a.stage === 'GA' && [...(a.includedPermissions ?? [])].sort().join(',') === [...plan.role.includedPermissions].sort().join(','), commands[7]!);
    const binding = async (key: string, selector: string[], command: string[], backupBoundary = true) => {
      const wantedMember = command.find(a => a.startsWith('--member='))!.slice(9);
      const role = command.find(a => a.startsWith('--role='))!.slice(7);
      const matches = (p: any) => p?.bindings?.some((b: any) => b.role === role && !b.condition && b.members?.includes(wantedMember));
      let actual = await read(selector);
      if (backupBoundary && actual?.bindings?.some((b: any) => b.members?.includes(member))) throw new Error('backup_hosted_runtime_access_forbidden');
      if (!matches(actual)) {
        await mutate(command);
        if (options.mode === 'plan') { receipt.pending.push(key); return; }
        actual = await read(selector);
      }
      if (!matches(actual)) throw new Error(`backup_binding_readback_failed:${key}`);
      receipt.verified.push(key);
    };
    const bucketPolicy = ['storage', 'buckets', 'get-iam-policy', `gs://${plan.bucket}`];
    await binding('sql-object-creator', bucketPolicy, commands[5]!);
    await binding('backup-custodian', bucketPolicy, commands[6]!);
    await binding('exporter-sql-role', ['projects', 'get-iam-policy', spec.project], commands[8]!, false);
    await binding('exporter-metric-writer', ['projects', 'get-iam-policy', plan.backupProject], commands[9]!);
    await ensure('workflow', ['workflows', 'describe', 'pc-nightly-cloud-sql-export', bp, location], a =>
      a.state === 'ACTIVE' && [plan.backupProject, String(project.projectNumber)].some(p => a.serviceAccount === `projects/${p}/serviceAccounts/${plan.identities.exporter}`) &&
      JSON.stringify(JSON.parse(a.sourceContents)) === JSON.stringify(plan.workflowSource) && a.callLogLevel === 'LOG_ERRORS_ONLY', commands[10]!);
    await ensure('invoke-role', ['iam', 'roles', 'describe', 'pcBackupInvoke', bp], a =>
      !a.deleted && a.stage === 'GA' && a.includedPermissions?.length === 1 && a.includedPermissions[0] === 'workflows.executions.create', commands[11]!);
    await binding('scheduler-invoker', ['projects', 'get-iam-policy', plan.backupProject], commands[12]!);
    const monitoring = `https://monitoring.googleapis.com/v3/projects/${plan.backupProject}`;
    const descriptor = { type: BACKUP_COMPLETION_METRIC, metricKind: 'GAUGE', valueType: 'DOUBLE',
      labels: [{ key: 'database', valueType: 'STRING', description: 'Production database exported successfully' }] };
    let metric = await apiRead(`${monitoring}/metricDescriptors/${encodeURIComponent(BACKUP_COMPLETION_METRIC)}`);
    const post = async (url: string, body: unknown) => {
      receipt.mutations.push(`POST ${url}`);
      if (options.mode === 'verify') throw new Error('backup_verify_mutation_forbidden');
      if (options.mode === 'up') {
        const r = await api!('POST', url, body);
        if (r.status < 200 || r.status >= 300) throw new Error(`backup_api_write_failed:${r.status}`);
      }
    };
    if (!metric) {
      await post(`${monitoring}/metricDescriptors`, descriptor);
      if (options.mode === 'up') metric = await apiRead(`${monitoring}/metricDescriptors/${encodeURIComponent(BACKUP_COMPLETION_METRIC)}`);
    }
    if (metric && (metric.type !== descriptor.type || metric.metricKind !== descriptor.metricKind || metric.valueType !== descriptor.valueType ||
        metric.labels?.length !== 1 || metric.labels[0]?.key !== 'database')) throw new Error('backup_metric_descriptor_drift');
    if (!metric && options.mode !== 'plan') throw new Error('backup_metric_readback_failed');
    const list = await apiRead(`${monitoring}/alertPolicies?pageSize=1000`);
    if (list?.nextPageToken) throw new Error('backup_alert_inventory_incomplete');
    for (const expected of plan.alertPolicies) {
      const candidates = list?.alertPolicies?.filter((a: any) => a.displayName === expected.displayName) ?? [];
      if (candidates.length > 1) throw new Error('backup_duplicate_alert_policy');
      let actual = candidates[0];
      if (!actual) {
        await post(`${monitoring}/alertPolicies`, expected);
        if (options.mode === 'up') {
          const updated = await apiRead(`${monitoring}/alertPolicies?pageSize=1000`);
          const matches = updated?.alertPolicies?.filter((a: any) => a.displayName === expected.displayName) ?? [];
          if (updated?.nextPageToken || matches.length !== 1) throw new Error('backup_alert_readback_failed');
          actual = matches[0];
        }
      }
      const absent = actual?.conditions?.[0]?.conditionAbsent;
      const expectedAbsent = expected.conditions[0]!.conditionAbsent;
      if (actual && (actual.enabled !== true || actual.combiner !== 'OR' ||
          [...(actual.notificationChannels ?? [])].sort().join(',') !== [...expected.notificationChannels].sort().join(',') ||
          actual.conditions?.length !== 1 || absent?.filter !== expectedAbsent.filter || absent?.duration !== expectedAbsent.duration ||
          Number(absent?.trigger?.count) !== 1 || absent?.aggregations?.length !== 1 ||
          absent.aggregations[0].alignmentPeriod !== '60s' || absent.aggregations[0].perSeriesAligner !== 'ALIGN_MAX'))
        throw new Error('backup_alert_policy_drift');
      if (!actual && options.mode !== 'plan') throw new Error('backup_alert_readback_failed');
    }
    const jobRead = ['scheduler', 'jobs', 'describe', 'pc-nightly-cloud-sql-export', bp, location];
    const activation = approval?.activationEvidence;
    const job = await read(jobRead);
    if (!reference(activation?.exportRestoreRef) || !reference(activation?.alertDeliveryRef)) {
      if (job) throw new Error('backup_schedule_activation_evidence_missing');
      receipt.pending.push('schedule: export/restore and alarm-delivery evidence required');
      if (options.mode === 'verify') throw new Error('backup_schedule_not_armed');
    } else {
      await ensure('nightly-schedule', jobRead, a => a.state === 'ENABLED' && a.schedule === '0 7 * * *' && a.timeZone === 'Etc/UTC' &&
        a.httpTarget?.uri === commands[13]!.find(v => v.startsWith('--uri='))!.slice(6) && a.httpTarget?.httpMethod === 'POST' &&
        a.httpTarget?.oauthToken?.serviceAccountEmail === plan.identities.scheduler, commands[13]!);
      receipt.scheduleArmed = options.mode !== 'plan' || !!job;
    }
    return receipt;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Configuration and approval references arrive over stdin, never argv. */
export function parseBackupInvocation(argv: readonly string[], input: string): Parameters<typeof provisionNightlyBackups>[0] {
  if (argv.length !== 1 || !['plan', 'up', 'verify'].includes(argv[0]!)) throw new Error('backup_usage_plan_up_verify_stdin');
  const config = JSON.parse(input);
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('backup_configuration_invalid');
  // The CLI always uses the approved production specification; callers cannot
  // smuggle another source, transport, execution mode or provider into JSON.
  if (Object.keys(config).some(key => !['backupProject', 'bucket', 'cloudSqlServiceAccount', 'notificationChannels', 'retentionDays', 'approval'].includes(key)))
    throw new Error('backup_configuration_unknown_key');
  return { ...config, mode: argv[0] as 'plan' | 'up' | 'verify' };
}

if (isCliEntry(import.meta.url)) {
  (async () => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk.toString();
    console.log(JSON.stringify(await provisionNightlyBackups(parseBackupInvocation(process.argv.slice(2), input)), null, 2));
  })().catch(error => {
    console.error(error instanceof Error && /^backup_[a-z0-9_:-]+$/.test(error.message) ? error.message : 'backup_configuration_or_provider_failure');
    process.exitCode = 1;
  });
}
