import { describe, expect, it } from 'vitest';
import { HOSTED_RUNTIME_ACCOUNT, HOSTED_SECRETS, HOSTED_DELEGATION_BINDINGS, provisionHostedSecrets, safeProvisioningError } from './provision-hosted-secrets';
import { PROD_SPEC, type GcloudRunner } from './provision-cloud-sql';

const projectNumber = '46711101119';
const email = `${HOSTED_RUNTIME_ACCOUNT}@${PROD_SPEC.project}.iam.gserviceaccount.com`;
const resource = (name: string) => `projects/${projectNumber}/locations/${PROD_SPEC.region}/secrets/${name}`;
function fixture(opts: { existing?: boolean; bound?: boolean; readError?: boolean; wrongProject?: boolean; disabled?: boolean; aliasCreate?: boolean; noVersion?: boolean; overbroadAdmin?: boolean } = {}) {
  const calls: Array<{ args: readonly string[]; input?: string; env?: Readonly<Record<string, string>> }> = [];
  const secrets = new Set<string>(opts.existing ? HOSTED_SECRETS.map(s => s.name) : []);
  const bound = new Set<string>(opts.bound ? HOSTED_SECRETS.map(s => s.name) : []);
  const newlyCreated = new Set<string>();
  const delegationBound = new Set(opts.bound ? HOSTED_DELEGATION_BINDINGS.map(b => `${b.project}:${b.role}`) : []);
  let account = opts.existing ?? false;
  const ok = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  const missing = { code: 1, stdout: '', stderr: 'NOT_FOUND' };
  const gcloud: GcloudRunner = async (args, options) => {
    calls.push({ args, ...options });
    if (args[0] === 'projects') {
      if (args[1] === 'describe') return ok({ projectId: opts.wrongProject ? 'other' : PROD_SPEC.project, projectNumber });
      if (args[1] === 'add-iam-policy-binding') {
        delegationBound.add(`${args[2]}:${args.find(a => a.startsWith('--role='))!.slice(7)}`);
        return ok({});
      }
      return ok({ bindings: HOSTED_DELEGATION_BINDINGS.filter(b => b.project === args[2] && delegationBound.has(`${b.project}:${b.role}`))
        .map(b => ({ role: b.role, members: [`serviceAccount:${email}`], ...('condition' in b && !opts.overbroadAdmin ? { condition: b.condition } : {}) })) });
    }
    if (args[0] === 'iam') {
      if (args[2] === 'create') { account = true; return ok({ email }); }
      return account ? ok({ email, disabled: opts.disabled }) : missing;
    }
    const name = args[2] === 'list' ? args[3]! : args[2]!;
    if (args[1] === 'describe') {
      if (opts.readError) return { code: 1, stdout: '', stderr: 'PERMISSION_DENIED contains-sensitive-provider-response' };
      return secrets.has(name) ? ok({ name: resource(name) }) : missing;
    }
    if (args[1] === 'create') {
      secrets.add(name); newlyCreated.add(name);
      return ok({ name: opts.aliasCreate ? resource(name).replace(projectNumber, PROD_SPEC.project) : resource(name) });
    }
    if (args[1] === 'versions') return ok(opts.noVersion ? [] : [{ name: `${resource(name)}/versions/${newlyCreated.has(name) ? '1' : '7'}`, state: 'ENABLED' }]);
    if (args[1] === 'add-iam-policy-binding') { bound.add(name); return ok({}); }
    if (args[1] === 'get-iam-policy') return ok({ bindings: bound.has(name)
      ? [{ role: 'roles/secretmanager.secretAccessor', members: [`serviceAccount:${email}`] }] : [] });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { gcloud, calls };
}

describe('P-008 regional hosted secrets', () => {
  it('plans identity, cookie secrets and scoped access without making writes', async () => {
    const f = fixture();
    const r = await provisionHostedSecrets({ mode: 'plan', gcloud: f.gcloud });
    expect(f.calls.some(c => ['create', 'add-iam-policy-binding'].includes(c.args[1]!) || c.args[2] === 'create')).toBe(false);
    expect(r.mutations).toHaveLength(9);
    expect(r.pendingProviderRotation).toEqual(['workos-api-key', 'workos-webhook-secret', 'stripe-secret-key', 'stripe-webhook-secret']);
    expect(r.readyForRuntime).toBe(false);
  });

  it('generates fresh cookie values only over stdin and verifies per-secret IAM', async () => {
    const f = fixture();
    const sensitive = 'fresh-cookie-material-that-must-never-be-logged';
    const r = await provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud, generate: () => sensitive });
    expect(r.secrets).toHaveLength(2);
    expect(r.secrets.every(s => s.accessBound && s.reference.endsWith('/versions/1'))).toBe(true);
    expect(JSON.stringify(r)).not.toContain(sensitive);
    expect(f.calls.filter(c => c.input).map(c => c.input)).toEqual([sensitive, sensitive]);
    for (const c of f.calls) {
      expect(c.args.join(' ')).not.toContain(sensitive);
      if (c.args[0] === 'secrets') expect(c.env?.CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER).toBe('https://secretmanager.us-central1.rep.googleapis.com/');
      if (c.args[0] === 'secrets' && c.args[1] === 'add-iam-policy-binding') expect(c.args).toContain('--condition=None');
    }
    expect(f.calls.some(c => c.args[0] === 'projects' && c.args.includes('--role=roles/secretmanager.secretAccessor'))).toBe(false);
    expect(r.delegationBindings).toHaveLength(4);
    expect(r.delegationBindings.every(b => b.bound)).toBe(true);
    const adminGrant = f.calls.find(c => c.args.includes('--role=roles/resourcemanager.projectIamAdmin'))!;
    expect(adminGrant.args.find(a => a.startsWith('--condition='))).toContain(".hasOnly(['projects/papercusp-hosted-workspaces/roles/papercuspHostedWorkspaceHost', 'projects/papercusp-hosted-workspaces/roles/papercuspHostedWorkspaceObserver'])");
  });

  it('reuses pinned enabled versions without rotating existing credentials', async () => {
    const f = fixture({ existing: true, bound: true });
    const r = await provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud, generate: () => { throw new Error('must not generate'); } });
    expect(r.mutations).toEqual([]);
    expect(r.secrets).toHaveLength(6);
    expect(r.secrets.every(s => s.reference.endsWith('/versions/7'))).toBe(true);
    expect(f.calls.some(c => c.args.includes('access'))).toBe(false);
  });

  it('reads every existing secret and binding during verification without mutation', async () => {
    const f = fixture({ existing: true, bound: true });
    const r = await provisionHostedSecrets({ mode: 'verify', gcloud: f.gcloud });
    expect(r.secrets).toHaveLength(6);
    expect(r.readyForRuntime).toBe(true);
    expect(f.calls.filter(c => c.args[0] === 'secrets' && c.args[1] === 'get-iam-policy')).toHaveLength(6);
  });

  it('refuses an existing unconditional hosting-admin grant instead of hiding it with another binding', async () => {
    const f = fixture({ existing: true, bound: true, overbroadAdmin: true });
    await expect(provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud })).rejects.toThrow('delegation_overbroad_binding');
    expect(f.calls.some(c => c.args[1] === 'add-iam-policy-binding')).toBe(false);
  });

  it('accepts newly issued provider values only through the server composition seam', async () => {
    const f = fixture();
    const providerValues = Object.fromEntries(HOSTED_SECRETS.filter(s => !s.generated)
      .map(s => [s.name, `fresh-provider-material-for-${s.name}-not-for-logging`]));
    const r = await provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud, providerValues });
    expect(r.readyForRuntime).toBe(true);
    expect(r.pendingProviderRotation).toEqual([]);
    expect(r.secrets).toHaveLength(6);
    for (const value of Object.values(providerValues)) expect(JSON.stringify(r)).not.toContain(value);
  });

  it('uses canonical remote readback when create returns a project alias', async () => {
    const f = fixture({ aliasCreate: true });
    const r = await provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud });
    expect(r.secrets.every(s => s.reference.includes(`projects/${projectNumber}/`))).toBe(true);
  });

  it('refuses a create acknowledgement without an enabled version', async () => {
    const f = fixture({ noVersion: true });
    await expect(provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud })).rejects.toThrow('create_readback_failed');
    expect(f.calls.some(c => c.args[1] === 'add-iam-policy-binding')).toBe(false);
  });

  it('preserves safe command failure codes while suppressing provider response text', () => {
    expect(safeProvisioningError(new Error('hosted_secret_command_failed:secrets:create:hosted-session-cookie:1')))
      .toBe('hosted_secret_command_failed:secrets:create:hosted-session-cookie:1');
    expect(safeProvisioningError(new Error('sensitive provider body'))).toBe('hosted_secret_unclassified_failure');
  });

  it('fails closed on a missing access binding during verification', async () => {
    const f = fixture({ existing: true });
    await expect(provisionHostedSecrets({ mode: 'verify', gcloud: f.gcloud })).rejects.toThrow('access_binding_missing');
    expect(f.calls.some(c => c.args[1] === 'add-iam-policy-binding')).toBe(false);
  });

  it('does not mistake permission denial for absence or disclose the provider body', async () => {
    const f = fixture({ readError: true });
    await expect(provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud })).rejects.toThrow('hosted_secret_read_failed');
    expect(f.calls.some(c => c.args[0] === 'secrets' && c.args[1] === 'create')).toBe(false);
  });

  it.each([{ wrongProject: true }, { existing: true, disabled: true }])('refuses an unexpected project or disabled runtime identity', async opts => {
    const f = fixture(opts);
    await expect(provisionHostedSecrets({ mode: 'up', gcloud: f.gcloud })).rejects.toThrow(/identity_invalid/);
    expect(f.calls.some(c => c.args[1] === 'create' || c.args[2] === 'create')).toBe(false);
  });
});
