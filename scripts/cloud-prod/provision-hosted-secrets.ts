#!/usr/bin/env -S npx tsx
/** P-008: regional app secrets and per-secret IAM, extending the P-004 gcloud seam.
 * `plan` is read-only; `up` creates the runtime identity and fresh cookie secrets;
 * `verify` checks the enabled versions and access bindings. Provider keys must be
 * newly issued by their providers: this CLI never silently copies dev credentials.
 * Values travel only over stdin; the receipt contains resource names, never values.
 */
import { randomBytes } from 'node:crypto';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { PROD_SPEC, realGcloud, gcloudEnvFor, type GcloudRunner } from './provision-cloud-sql';

export const HOSTED_RUNTIME_ACCOUNT = 'pc-hosted-control-plane';
export const HOSTED_DELEGATION_BINDINGS = [
  { project: 'papercusp-org-identity', role: 'roles/iam.serviceAccountCreator' },
  { project: 'papercusp-org-identity', role: 'roles/iam.serviceAccountTokenCreator' },
  { project: 'papercusp-hosted-workspaces', role: 'roles/iam.roleViewer' },
  { project: 'papercusp-hosted-workspaces', role: 'roles/resourcemanager.projectIamAdmin',
    condition: {
      title: 'd399-hosting-reservations-only',
      description: 'D-399: the control plane may grant only the two Papercusp-hosted workspace roles',
      expression: "api.getAttribute('iam.googleapis.com/modifiedGrantsByRole', []).hasOnly(['projects/papercusp-hosted-workspaces/roles/papercuspHostedWorkspaceHost', 'projects/papercusp-hosted-workspaces/roles/papercuspHostedWorkspaceObserver'])",
    } },
] as const;
export const HOSTED_SECRETS = [
  { name: 'hosted-session-cookie', env: 'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF', generated: true },
  { name: 'workos-cookie-password', env: 'WORKOS_COOKIE_PASSWORD_REF', generated: true },
  { name: 'workos-api-key', env: 'WORKOS_API_KEY_REF', generated: false },
  { name: 'workos-webhook-secret', env: 'WORKOS_WEBHOOK_SECRET_REF', generated: false },
  { name: 'stripe-secret-key', env: 'PAPERCUSP_STRIPE_SECRET_KEY_REF', generated: false },
  { name: 'stripe-webhook-secret', env: 'PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF', generated: false },
] as const;

export interface HostedSecretsReceipt {
  projectNumber: string;
  serviceAccount: string;
  readyForRuntime: boolean;
  secrets: Array<{ name: string; reference: string; accessBound: boolean }>;
  delegationBindings: Array<{ project: string; role: string; bound: boolean; conditional: boolean }>;
  pendingProviderRotation: string[];
  mutations: string[];
}

interface Options {
  mode: 'plan' | 'up' | 'verify';
  gcloud?: GcloudRunner;
  /** Newly issued provider values supplied by trusted server-side composition.
   * Never put them in argv, a tree file or the receipt. Existing secrets are immutable.
   */
  providerValues?: Readonly<Partial<Record<(typeof HOSTED_SECRETS)[number]['name'], string>>>;
  generate?: () => string;
}

const absent = /NOT_FOUND|was not found|does not exist/i;

/** Keep actionable codes without exposing provider response text. */
export function safeProvisioningError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^hosted_secret_[a-z_]+(?::[a-z0-9-]+)*$/.test(message) ? message : 'hosted_secret_unclassified_failure';
}

export async function provisionHostedSecrets(options: Options): Promise<HostedSecretsReceipt> {
  const gcloud = options.gcloud ?? realGcloud;
  const scope = [`--project=${PROD_SPEC.project}`, '--quiet'];
  const loc = `--location=${PROD_SPEC.region}`;
  const run = async (args: string[], input?: string) => {
    const result = await gcloud([...args, ...scope], { env: gcloudEnvFor(PROD_SPEC, args), ...(input === undefined ? {} : { input }) });
    // A provider error can echo its input. Never return stderr or payloads.
    if (result.code !== 0) throw new Error(`hosted_secret_command_failed:${args.slice(0, 3).join(':')}:${result.code}`);
    return result.stdout;
  };
  const read = async (args: string[]) => {
    const result = await gcloud([...args, '--format=json', ...scope], { env: gcloudEnvFor(PROD_SPEC, args) });
    if (result.code !== 0) {
      if (absent.test(result.stderr)) return null;
      throw new Error(`hosted_secret_read_failed:${args.slice(0, 3).join(':')}:${result.code}`);
    }
    return JSON.parse(result.stdout);
  };
  const project = await read(['projects', 'describe', PROD_SPEC.project]);
  const projectNumber = String(project?.projectNumber ?? '');
  if (!/^[1-9][0-9]*$/.test(projectNumber) || project.projectId !== PROD_SPEC.project) throw new Error('hosted_secret_project_identity_invalid');
  const email = `${HOSTED_RUNTIME_ACCOUNT}@${PROD_SPEC.project}.iam.gserviceaccount.com`;
  const receipt: HostedSecretsReceipt = { projectNumber, serviceAccount: email, readyForRuntime: false, secrets: [], delegationBindings: [], pendingProviderRotation: [], mutations: [] };
  const mutate = async (args: string[], input?: string) => {
    receipt.mutations.push(`gcloud ${args.join(' ')}${input === undefined ? '' : ' <stdin>'}`);
    if (options.mode === 'up') return run(args, input);
    if (options.mode === 'verify') throw new Error('hosted_secret_verify_mutation_forbidden');
    return '';
  };
  const account = await read(['iam', 'service-accounts', 'describe', email]);
  if (!account) {
    if (options.mode === 'verify') throw new Error('hosted_secret_runtime_identity_missing');
    await mutate(['iam', 'service-accounts', 'create', HOSTED_RUNTIME_ACCOUNT,
      '--display-name=Papercusp production hosted control plane']);
  } else if (account.disabled || account.email !== email) throw new Error('hosted_secret_runtime_identity_invalid');

  for (const secret of HOSTED_SECRETS) {
    const resource = `projects/${projectNumber}/locations/${PROD_SPEC.region}/secrets/${secret.name}`;
    const existing = await read(['secrets', 'describe', secret.name, loc]);
    let version: string;
    if (existing) {
      if (existing.name !== resource) throw new Error('hosted_secret_resource_identity_invalid');
      const versions = await read(['secrets', 'versions', 'list', secret.name, loc, '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1']);
      const match = Array.isArray(versions) && versions[0]?.name?.match(/\/versions\/([1-9][0-9]*)$/);
      if (!match || versions[0].name !== `${resource}/versions/${match[1]}`) throw new Error('hosted_secret_enabled_version_missing');
      version = match[1];
    } else {
      const supplied = options.providerValues?.[secret.name];
      if (!secret.generated && !supplied) {
        receipt.pendingProviderRotation.push(secret.name);
        continue;
      }
      if (options.mode === 'verify') throw new Error(`hosted_secret_missing:${secret.name}`);
      const value = secret.generated ? (options.generate ?? (() => randomBytes(48).toString('base64url')))() : supplied!;
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 65_536) throw new Error('hosted_secret_value_invalid');
      await mutate(['secrets', 'create', secret.name, loc,
        '--labels=papercusp-plan=cloud-portal-public-release,papercusp-role=cloud-prod', '--data-file=-', '--format=json'], value);
      if (options.mode === 'up') {
        // A create response may retain the request's project alias. Use canonical
        // remote readback, as the runtime resolver does, instead of trusting it.
        const stored = await read(['secrets', 'describe', secret.name, loc]);
        const versions = await read(['secrets', 'versions', 'list', secret.name, loc, '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1']);
        if (stored?.name !== resource || versions?.[0]?.name !== `${resource}/versions/1`) throw new Error('hosted_secret_create_readback_failed');
      }
      version = '1';
    }
    let accessBound = false;
    if (existing || options.mode === 'up') {
      const policy = await read(['secrets', 'get-iam-policy', secret.name, loc]);
      accessBound = policy?.bindings?.some((b: { role: string; members: string[]; condition?: unknown }) =>
        b.role === 'roles/secretmanager.secretAccessor' && !b.condition && b.members?.includes(`serviceAccount:${email}`)) ?? false;
    }
    if (!accessBound) {
      if (options.mode === 'verify') throw new Error(`hosted_secret_access_binding_missing:${secret.name}`);
      await mutate(['secrets', 'add-iam-policy-binding', secret.name, loc,
        `--member=serviceAccount:${email}`, '--role=roles/secretmanager.secretAccessor', '--condition=None']);
      if (options.mode === 'up') {
        const policy = await read(['secrets', 'get-iam-policy', secret.name, loc]);
        accessBound = policy?.bindings?.some((b: { role: string; members: string[]; condition?: unknown }) =>
          b.role === 'roles/secretmanager.secretAccessor' && !b.condition && b.members?.includes(`serviceAccount:${email}`)) ?? false;
        if (!accessBound) throw new Error('hosted_secret_access_binding_readback_failed');
      }
    }
    receipt.secrets.push({ name: secret.name, reference: `${['gcp', 'secret'].join('-')}:${resource}/versions/${version}`, accessBound });
  }
  // Extend the existing D-397 organization chain and D-399 conditional hosting
  // grants to the attached VM identity. Never mint another long-lived key.
  for (const binding of HOSTED_DELEGATION_BINDINGS) {
    const condition = 'condition' in binding ? binding.condition : undefined;
    const matches = (policy: any) => policy?.bindings?.some((b: any) =>
      b.role === binding.role && b.members?.includes(`serviceAccount:${email}`) &&
      (condition ? b.condition?.expression === condition.expression : !b.condition)) ?? false;
    const policy = await read(['projects', 'get-iam-policy', binding.project]);
    if (condition && policy?.bindings?.some((b: any) => b.role === binding.role && b.members?.includes(`serviceAccount:${email}`) && b.condition?.expression !== condition.expression)) {
      throw new Error('hosted_secret_delegation_overbroad_binding');
    }
    let bound = matches(policy);
    if (!bound) {
      if (options.mode === 'verify') throw new Error('hosted_secret_delegation_binding_missing');
      // gcloud's alternate delimiter preserves commas in the CEL expression.
      const conditionArg = condition ? `^~^title=${condition.title}~description=${condition.description}~expression=${condition.expression}` : 'None';
      await mutate(['projects', 'add-iam-policy-binding', binding.project,
        `--member=serviceAccount:${email}`, `--role=${binding.role}`, `--condition=${conditionArg}`]);
      if (options.mode === 'up') {
        bound = matches(await read(['projects', 'get-iam-policy', binding.project]));
        if (!bound) throw new Error('hosted_secret_delegation_binding_readback_failed');
      }
    }
    receipt.delegationBindings.push({ project: binding.project, role: binding.role, bound, conditional: !!condition });
  }
  receipt.readyForRuntime = receipt.pendingProviderRotation.length === 0 && receipt.secrets.every(s => s.accessBound) && receipt.delegationBindings.every(b => b.bound);
  return receipt;
}

export async function main(args: string[]): Promise<number> {
  const mode = args[0];
  if (!['plan', 'up', 'verify'].includes(mode!) || args.length !== 1) {
    process.stderr.write('usage: provision-hosted-secrets.ts plan | up | verify\n');
    return 2;
  }
  const receipt = await provisionHostedSecrets({ mode: mode as Options['mode'] });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  return mode === 'verify' && !receipt.readyForRuntime ? 3 : 0;
}

if (isCliEntry(import.meta.url)) main(process.argv.slice(2)).then(code => process.exit(code), error => {
  process.stderr.write(`${safeProvisioningError(error)}; reconcile remote state before retrying\n`);
  process.exit(1);
});
