import { describe, expect, it, vi } from 'vitest';
import { observeHostedBillingFailure, logHostedBillingFailure } from '@papercusp/operator-core/lib/auth/hosted/billing/billing-recovery';
import { BILLING_FAILURE_LOG_ID, BILLING_FAILURE_LOG_PATTERN, buildBillingFailureAlertPlan,
  buildBillingFailureCollectorPlan, verifyBillingFailureAlertConfiguration,
  verifyBillingFailureCollectorConfiguration } from './billing-alert-plan';
import { PROD_SPEC, type GcloudRunner } from './provision-cloud-sql';
import type { BackupApi } from './nightly-backup-plan';

const input = { vmName: 'pc-hosted-control-plane', instanceId: '123456789123', zone: 'us-central1-a',
  notificationChannels: ['projects/papercusp-cloud-prod/notificationChannels/123'] };
const policyRef = 'projects/papercusp-cloud-prod/alertPolicies/456';

function provider() {
  const vm = { name: input.vmName, id: input.instanceId, status: 'RUNNING',
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROD_SPEC.project}/zones/${input.zone}/instances/${input.vmName}`,
    serviceAccounts: [{ email: `pc-hosted-control-plane@${PROD_SPEC.project}.iam.gserviceaccount.com` }] };
  const channel = { name: input.notificationChannels[0], enabled: true, verificationStatus: 'VERIFIED' };
  const policy: any = { name: policyRef, ...buildBillingFailureAlertPlan(input).alertPolicy };
  const gcloud = vi.fn<GcloudRunner>(async () => ({ code: 0, stdout: JSON.stringify(vm), stderr: '' }));
  const api = vi.fn<BackupApi>(async (_method, url) => ({ status: 200,
    body: url.endsWith('/notificationChannels/123') ? channel : policy }));
  return { vm, channel, policy, gcloud, api };
}

describe('production billing log alarm preparation', () => {
  it('matches the actual rollback-safe logger and rejects payload-bearing or forged marker lines', async () => {
    const captured: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => captured.push(args.join(' ')));
    try {
      await observeHostedBillingFailure(logHostedBillingFailure, 'endpoint-store-unavailable', 'evt_Valid123');
      await observeHostedBillingFailure(logHostedBillingFailure, 'undelivered', 'evt_bad customer@example.test');
    } finally { spy.mockRestore(); }
    const matcher = new RegExp(BILLING_FAILURE_LOG_PATTERN);
    expect(captured.every(line => matcher.test(line))).toBe(true);
    expect(captured[1]).toContain('"eventId":null');
    expect(captured.join('\n')).not.toContain('customer@example.test');
    for (const line of [
      'ordinary hosted error: customer@example.test',
      '[hosted-billing-observation] {"failureClass":"other","eventId":null}',
      '[hosted-billing-observation] {"failureClass":"undelivered","eventId":null,"body":"private"}',
      '[hosted-billing-observation] {"failureClass":"undelivered","eventId":"evt_bad customer@example.test"}',
      'prefix ' + captured[0],
    ]) expect(matcher.test(line)).toBe(false);
  });

  it('refuses unpinned runtimes and cross-project/missing recipients before producing config', () => {
    for (const patch of [{ instanceId: 'vm-name' }, { zone: 'europe-west1-a' }, { vmName: 'bad\" OR true' },
      { notificationChannels: [] }, { notificationChannels: ['projects/other/notificationChannels/123'] }])
      expect(() => buildBillingFailureAlertPlan({ ...input, ...patch })).toThrow();
    const filter = buildBillingFailureAlertPlan(input).alertPolicy.conditions[0]!.conditionMatchedLog.filter;
    expect(filter).toContain('resource.labels.instance_id="123456789123"');
    expect(filter).toContain('resource.labels.project_id="papercusp-cloud-prod"');
    expect(filter).toContain('logName="projects/papercusp-cloud-prod/logs/papercusp_hosted_billing"');
  });

  it('verifies provider readback while leaving collection and actual delivery explicitly unproven', async () => {
    const p = provider();
    const out = await verifyBillingFailureAlertConfiguration({ ...input, policyRef }, p);
    expect(out.status).toBe('configuration-verified');
    expect(out.notVerified).toEqual(['collector-config', 'log-ingestion', 'incident-creation', 'recipient-delivery']);
    expect(p.gcloud.mock.calls[0]![0]).toEqual(['compute', 'instances', 'describe', input.vmName,
      '--project=papercusp-cloud-prod', '--zone=us-central1-a', '--format=json']);
    expect(p.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it.each(['id', 'account', 'project'] as const)('rejects %s identity substitution before monitoring reads', async kind => {
    const p = provider();
    if (kind === 'id') p.vm.id = '999';
    if (kind === 'account') p.vm.serviceAccounts[0]!.email = 'default@developer.gserviceaccount.com';
    if (kind === 'project') p.vm.selfLink = p.vm.selfLink.replace('papercusp-cloud-prod', 'other');
    await expect(verifyBillingFailureAlertConfiguration({ ...input, policyRef }, p)).rejects.toThrow('identity_mismatch');
    expect(p.api).not.toHaveBeenCalled();
  });

  it('fails closed on disabled/unverified recipients and API errors without a write or fallback', async () => {
    const p = provider(); p.channel.verificationStatus = 'UNVERIFIED';
    await expect(verifyBillingFailureAlertConfiguration({ ...input, policyRef }, p)).rejects.toThrow('channel_unverified');
    const failed = provider(); failed.api.mockResolvedValue({ status: 403, body: {} });
    await expect(verifyBillingFailureAlertConfiguration({ ...input, policyRef }, failed)).rejects.toThrow('read_failed:403');
    expect(failed.api).toHaveBeenCalledTimes(1);
  });

  it.each(['scope', 'disabled', 'recipients', 'extra-condition', 'rate-limit'] as const)('refuses %s policy drift', async kind => {
    const p = provider();
    if (kind === 'scope') p.policy.conditions[0].conditionMatchedLog.filter = 'resource.type="gce_instance"';
    if (kind === 'disabled') p.policy.enabled = false;
    if (kind === 'recipients') p.policy.notificationChannels = [];
    if (kind === 'extra-condition') p.policy.conditions.push({ conditionMatchedLog: { filter: 'true' } });
    if (kind === 'rate-limit') p.policy.alertStrategy.notificationRateLimit.period = '3600s';
    await expect(verifyBillingFailureAlertConfiguration({ ...input, policyRef }, p)).rejects.toThrow('policy_drift');
    expect(p.api.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('selects the hosted USER journal unit and disables the inherited syslog forwarding pipeline', () => {
    const plan = buildBillingFailureCollectorPlan(input);
    const { logging } = JSON.parse(plan.configText);
    expect(logging.receivers).toEqual({ [BILLING_FAILURE_LOG_ID]: { type: 'systemd_journald' } });
    expect(logging.service.pipelines.default_pipeline.receivers).toEqual([]);
    const filter = logging.processors.billing_only.match_any[0];
    expect(filter).toBe('NOT (jsonPayload._SYSTEMD_USER_UNIT = "papercusp-hosted-control-plane.service" AND jsonPayload.MESSAGE =~ '
      + JSON.stringify(BILLING_FAILURE_LOG_PATTERN) + ')');
    expect(filter).not.toContain('jsonPayload._SYSTEMD_UNIT =');
    expect(logging.service.pipelines.billing_failures.processors).toEqual(['billing_only', 'billing_fields']);
    expect(logging.processors.billing_fields.fields['jsonPayload.message']).toEqual({ move_from: 'jsonPayload.MESSAGE' });
    expect(logging.processors.billing_fields.fields['jsonPayload._CMDLINE']).toEqual({ omit_if: 'jsonPayload._CMDLINE:*' });
    expect(plan.logName).toBe(buildBillingFailureAlertPlan(input).logName);
    expect(verifyBillingFailureCollectorConfiguration(input, logging ? { logging } : null).notVerified)
      .toContain('effective-merged-config');
  });

  it.each(['broader-filter', 'extra-pipeline', 'syslog-default', 'processor-order', 'command-leak', 'wrong-log'] as const)(
    'rejects %s collector drift before configuration acceptance', kind => {
      const { config } = buildBillingFailureCollectorPlan(input);
      const actual: any = JSON.parse(JSON.stringify(config));
      if (kind === 'broader-filter') actual.logging.processors.billing_only.match_any = ['NOT jsonPayload.MESSAGE:*'];
      if (kind === 'extra-pipeline') actual.logging.service.pipelines.unreviewed = { receivers: [BILLING_FAILURE_LOG_ID] };
      if (kind === 'syslog-default') delete actual.logging.service.pipelines.default_pipeline;
      if (kind === 'processor-order') actual.logging.service.pipelines.billing_failures.processors.reverse();
      if (kind === 'command-leak') delete actual.logging.processors.billing_fields.fields['jsonPayload._CMDLINE'];
      if (kind === 'wrong-log') actual.logging.service.pipelines.billing_failures.receivers = ['syslog'];
      expect(() => verifyBillingFailureCollectorConfiguration(input, actual)).toThrow('billing_collector_config_drift');
    });

  it('accepts key reordering and refuses an unpinned collector runtime without calling a provider', () => {
    const { config } = buildBillingFailureCollectorPlan(input);
    const logging = { service: config.logging.service, processors: config.logging.processors,
      receivers: config.logging.receivers };
    expect(verifyBillingFailureCollectorConfiguration(input, { logging }).verified).toEqual(['supplied-user-configuration']);
    expect(() => buildBillingFailureCollectorPlan({ ...input, instanceId: 'unmeasured' })).toThrow('runtime_identity_invalid');
    expect(() => verifyBillingFailureCollectorConfiguration(input, null)).toThrow('billing_collector_config_drift');
  });
});
