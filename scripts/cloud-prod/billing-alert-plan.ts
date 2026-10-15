/** P-016 Cloud Monitoring configuration. Extends the P-004 gcloud identity
 * and P-009 monitoring API seams; creates no resources, schedule or messages.
 * A collector must forward only the bounded billing marker to LOG_ID before
 * this policy is installed. Configuration readback is not delivery proof.
 * Provider contract: cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.alertPolicies
 */
import type { HostedBillingFailureClass } from '@papercusp/operator-core/lib/auth/hosted/billing/billing-recovery';
import { PROD_SPEC, type CloudSqlProdSpec, type GcloudRunner } from './provision-cloud-sql';
import type { BackupApi } from './nightly-backup-plan';
import { isDeepStrictEqual } from 'node:util';

export const BILLING_FAILURE_LOG_ID = 'papercusp_hosted_billing';
// Record exhaustiveness makes a new runtime failure class a compile failure
// here until its production alarm contract is reviewed.
const failureClasses: Record<HostedBillingFailureClass, true> = {
  'endpoint-store-unavailable': true, 'permanent-rejection': true,
  'customer-unmapped': true, 'replay-mismatch': true, 'undelivered': true,
  'provider-unavailable': true, 'recovery-unavailable': true, 'budget-exhausted': true,
};
export const BILLING_FAILURE_LOG_PATTERN = '^\\[hosted-billing-observation\\] '
  + '\\{"failureClass":"(' + Object.keys(failureClasses).join('|') + ')"'
  + ',"eventId":(null|"evt_[A-Za-z0-9]+")\\}$';

export interface BillingAlertOptions {
  vmName: string;
  /** Numeric instance identity from Compute Engine readback, never a name. */
  instanceId: string;
  zone: string;
  /** Existing owner-approved channels; no address or credential is accepted. */
  notificationChannels: string[];
  spec?: CloudSqlProdSpec;
}

type BillingRuntimeOptions = Omit<BillingAlertOptions, 'notificationChannels'>;

function billingRuntimeSpec(options: BillingRuntimeOptions) {
  const spec = options.spec ?? PROD_SPEC;
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(spec.project)
      || !/^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(options.vmName)
      || !/^[1-9][0-9]{0,19}$/.test(options.instanceId)
      || !new RegExp('^' + spec.region + '-[a-z]$').test(options.zone))
    throw new Error('billing_alert_runtime_identity_invalid');
  return spec;
}

export function buildBillingFailureAlertPlan(options: BillingAlertOptions) {
  const spec = billingRuntimeSpec(options);
  const channels = [...new Set(options.notificationChannels)].sort();
  if (!channels.length || channels.some(ref => !new RegExp(
    '^projects/' + spec.project + '/notificationChannels/[0-9]+$').test(ref)))
    throw new Error('billing_alert_notification_channels_required');
  const logName = `projects/${spec.project}/logs/${BILLING_FAILURE_LOG_ID}`;
  const filter = [
    'resource.type="gce_instance"',
    `resource.labels.project_id=${JSON.stringify(spec.project)}`,
    `resource.labels.instance_id=${JSON.stringify(options.instanceId)}`,
    `resource.labels.zone=${JSON.stringify(options.zone)}`,
    `logName=${JSON.stringify(logName)}`,
    `(textPayload =~ ${JSON.stringify(BILLING_FAILURE_LOG_PATTERN)} OR jsonPayload.message =~ ${JSON.stringify(BILLING_FAILURE_LOG_PATTERN)})`,
  ].join(' AND ');
  const alertPolicy = {
    displayName: 'Production hosted billing delivery or reconciliation failure',
    enabled: true, combiner: 'OR', notificationChannels: channels,
    // LogMatch accepts exactly one condition and requires a notification limit.
    conditions: [{ displayName: 'Bounded billing failure observation', conditionMatchedLog: { filter } }],
    alertStrategy: { notificationRateLimit: { period: '300s' }, notificationPrompts: ['OPENED'], autoClose: '3600s' },
    documentation: { mimeType: 'text/markdown', content:
      'Inspect the bounded failure class and event ID in the matching log. Reconcile through system:hosted-billing-reconcile; preserve signed webhook bytes and API provenance. A closed incident or successful repair is not proof that the original webhook arrived. Never copy payloads, credentials or thrown errors into an incident.' },
    userLabels: { 'papercusp-plan': 'cloud-portal-public-release', 'papercusp-item': 'p-016' },
  };
  return { mode: 'preview-only' as const, project: spec.project, vmName: options.vmName,
    instanceId: options.instanceId, zone: options.zone, logName, alertPolicy,
    prerequisites: [
      'Read back the production VM identity and dedicated runtime service account',
      'Select existing owner-approved VERIFIED notification channels',
      'Configure and validate a collector that exports only the bounded marker to this exact log',
      'Install this policy and read it back before injecting a private detector failure',
      'Verify log ingestion, incident creation and actual recipient delivery; configuration alone is insufficient',
    ] };
}

/** Prepare the maintained Ops Agent's journald receiver rather than a new
 * forwarding process. The hosted unit is a USER service, so _SYSTEMD_USER_UNIT
 * is the identity field; _SYSTEMD_UNIT would select its user-manager parent.
 * The receiver preserves system journal metadata. Drop command/source-location
 * fields, and admit MESSAGE only when the entire bounded marker matches.
 *
 * Ops Agent merges its built-in defaults with this file. An empty default
 * pipeline is necessary: adding a narrow pipeline alone also exports syslog.
 * The receiver id becomes the Cloud Logging log id used by the alert policy.
 * Current provider sources: GoogleCloudPlatform/ops-agent confgenerator/
 * logging_receivers.go, logging_processors.go and logging_modify_fields.go.
 * Installation still requires the actual pinned agent's config validation.
 */
export function buildBillingFailureCollectorPlan(options: BillingRuntimeOptions) {
  const spec = billingRuntimeSpec(options);
  const unit = 'papercusp-hosted-control-plane.service';
  const keep = `jsonPayload._SYSTEMD_USER_UNIT = ${JSON.stringify(unit)} AND jsonPayload.MESSAGE =~ ${JSON.stringify(BILLING_FAILURE_LOG_PATTERN)}`;
  const config = {
    logging: {
      receivers: { [BILLING_FAILURE_LOG_ID]: { type: 'systemd_journald' } },
      processors: {
        billing_only: { type: 'exclude_logs', match_any: [`NOT (${keep})`] },
        billing_fields: { type: 'modify_fields', fields: {
          'jsonPayload.message': { move_from: 'jsonPayload.MESSAGE' },
          'jsonPayload._CMDLINE': { omit_if: 'jsonPayload._CMDLINE:*' },
          'jsonPayload.CODE_FILE': { omit_if: 'jsonPayload.CODE_FILE:*' },
          'jsonPayload.CODE_FUNC': { omit_if: 'jsonPayload.CODE_FUNC:*' },
          'jsonPayload.CODE_LINE': { omit_if: 'jsonPayload.CODE_LINE:*' },
          'sourceLocation.file': { omit_if: 'sourceLocation.file:*' },
          'sourceLocation.func': { omit_if: 'sourceLocation.func:*' },
          'sourceLocation.line': { omit_if: 'sourceLocation.line:*' },
          severity: { static_value: 'ERROR' },
        } },
      },
      service: { pipelines: {
        default_pipeline: { receivers: [] as string[] },
        billing_failures: { receivers: [BILLING_FAILURE_LOG_ID], processors: ['billing_only', 'billing_fields'] },
      } },
    },
  };
  return { mode: 'preview-only' as const, project: spec.project, vmName: options.vmName,
    instanceId: options.instanceId, zone: options.zone, unit,
    logName: `projects/${spec.project}/logs/${BILLING_FAILURE_LOG_ID}`,
    config, configText: JSON.stringify(config, null, 2) + '\n',
    prerequisites: [
      'Read back the exact production VM and dedicated runtime identity before installing',
      'Confirm this user unit runs on that VM and its stderr reaches the system journal',
      'Validate this configuration with the installed pinned Ops Agent before restarting it',
      'Review the complete effective merged logging config; reject any additional forwarding pipeline',
      'Verify bounded log ingestion, incident creation and approved recipient delivery separately',
    ] };
}

/** Compare a parsed, COMPLETE user configuration, not a substring or fragment.
 * No remote command, write, restart or notification is performed. Runtime and
 * effective built-in configuration remain separate acceptance obligations. */
export function verifyBillingFailureCollectorConfiguration(options: BillingRuntimeOptions, actual: unknown) {
  const plan = buildBillingFailureCollectorPlan(options);
  if (!isDeepStrictEqual(actual, plan.config)) throw new Error('billing_collector_config_drift');
  return { status: 'configuration-verified' as const, instanceId: plan.instanceId, logName: plan.logName,
    verified: ['supplied-user-configuration'],
    notVerified: ['vm-identity', 'installed-agent-validation', 'effective-merged-config', 'collector-running',
      'log-ingestion', 'incident-creation', 'recipient-delivery'] };
}

/** Read-only verification on the existing provider seams. Intentionally has no
 * up/arm mode: installation and an outward detector probe need their own grant. */
export async function verifyBillingFailureAlertConfiguration(options: BillingAlertOptions & { policyRef: string },
  deps: { gcloud: GcloudRunner; api: BackupApi }) {
  const plan = buildBillingFailureAlertPlan(options);
  const spec = options.spec ?? PROD_SPEC;
  if (!new RegExp('^projects/' + spec.project + '/alertPolicies/[0-9]+$').test(options.policyRef))
    throw new Error('billing_alert_policy_identity_invalid');
  const result = await deps.gcloud(['compute', 'instances', 'describe', options.vmName,
    `--project=${spec.project}`, `--zone=${options.zone}`, '--format=json']);
  if (result.code !== 0) throw new Error('billing_alert_vm_read_failed');
  const vm = JSON.parse(result.stdout);
  const runtimeAccount = `pc-hosted-control-plane@${spec.project}.iam.gserviceaccount.com`;
  if (vm.name !== options.vmName || String(vm.id) !== options.instanceId || vm.status !== 'RUNNING'
      || vm.selfLink !== `https://www.googleapis.com/compute/v1/projects/${spec.project}/zones/${options.zone}/instances/${options.vmName}`
      || vm.serviceAccounts?.length !== 1 || vm.serviceAccounts[0]?.email !== runtimeAccount)
    throw new Error('billing_alert_vm_identity_mismatch');
  const read = async (ref: string) => {
    const r = await deps.api('GET', `https://monitoring.googleapis.com/v3/${ref}`);
    if (r.status !== 200) throw new Error(`billing_alert_read_failed:${r.status}`);
    return r.body;
  };
  for (const ref of plan.alertPolicy.notificationChannels) {
    const channel = await read(ref);
    if (channel?.name !== ref || channel.enabled !== true || channel.verificationStatus !== 'VERIFIED')
      throw new Error('billing_alert_channel_unverified');
  }
  const actual = await read(options.policyRef);
  const wanted = plan.alertPolicy;
  if (actual?.name !== options.policyRef || actual.enabled !== true || actual.combiner !== wanted.combiner
      || actual.conditions?.length !== 1
      || actual.conditions[0]?.conditionMatchedLog?.filter !== wanted.conditions[0]!.conditionMatchedLog.filter
      || Object.keys(actual.conditions[0] ?? {}).some(k => k.startsWith('condition') && k !== 'conditionMatchedLog')
      || JSON.stringify([...(actual.notificationChannels ?? [])].sort()) !== JSON.stringify(wanted.notificationChannels)
      || actual.alertStrategy?.notificationRateLimit?.period !== wanted.alertStrategy.notificationRateLimit.period
      || actual.alertStrategy?.autoClose !== wanted.alertStrategy.autoClose
      || JSON.stringify(actual.alertStrategy?.notificationPrompts) !== JSON.stringify(wanted.alertStrategy.notificationPrompts))
    throw new Error('billing_alert_policy_drift');
  return { status: 'configuration-verified' as const, policyRef: options.policyRef,
    instanceId: options.instanceId, logName: plan.logName,
    verified: ['vm-identity', 'runtime-account', 'notification-channels', 'alert-policy'],
    notVerified: ['collector-config', 'log-ingestion', 'incident-creation', 'recipient-delivery'] };
}
