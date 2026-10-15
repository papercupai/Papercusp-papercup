/**
 * Production Cloud SQL provisioner (plan cloud-portal-public-release-2026-10-13, P-004).
 * Pins the D-004 shape (HA, PITR, deletion protection, private IP only, TLS only),
 * the drift detector `verify` relies on, the no-plaintext-password rule, and
 * provision-relay-vm.sh's "only not-found reads as absent" idempotency contract.
 */
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import {
  PROD_SPEC,
  describe as gcDescribe,
  flagNames,
  gcloudEnvFor,
  INSTANCE_CREATE_CMD,
  instanceCreateArgs,
  instanceDrift,
  jsonCells,
  judgeLogin,
  loginTargets,
  makeCtx,
  ownerRoleSql,
  judgeTlsProbe,
  privateIp,
  probeTls,
  readHostedOpsUrlReference,
  secretManagerEndpoint,
  stderrHead,
  TLS_PROBE_DONE,
  TLS_PROBE_VM,
  tlsProbeStartupScript,
  tlsProbeVmArgs,
  unknownFlags,
  up,
  verify,
  type GcloudResult,
  type GcloudRunner,
} from './provision-cloud-sql';
import { generatePassword, scramSha256Verifier, scramVerifierParts } from './scram';

const require = createRequire(import.meta.url);

/** A describe JSON that satisfies every D-004 / P-004 property. */
function conformingInstance(): Record<string, unknown> {
  return {
    databaseVersion: 'POSTGRES_18',
    region: 'us-central1',
    state: 'RUNNABLE',
    settings: {
      edition: 'ENTERPRISE',
      tier: 'db-custom-1-3840',
      availabilityType: 'REGIONAL',
      dataDiskType: 'PD_SSD',
      dataDiskSizeGb: '20',
      storageAutoResize: true,
      deletionProtectionEnabled: true,
      dataApiAccess: 'DISALLOW_DATA_API',
      databaseFlags: [{ name: 'cloudsql.iam_authentication', value: 'on' }],
      backupConfiguration: {
        enabled: true,
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: 7,
        backupRetentionSettings: { retainedBackups: 7 },
      },
      ipConfiguration: {
        ipv4Enabled: false,
        privateNetwork: 'projects/papercusp-cloud-prod/global/networks/pc-cloud-prod-net',
        sslMode: 'ENCRYPTED_ONLY',
        authorizedNetworks: [],
      },
    },
  };
}

suite('instanceCreateArgs', () => {
  const args = instanceCreateArgs(PROD_SPEC);
  it.each([
    '--database-version=POSTGRES_18',
    '--edition=ENTERPRISE',
    '--tier=db-custom-1-3840',
    '--region=us-central1',
    '--availability-type=REGIONAL',
    '--enable-point-in-time-recovery',
    '--retained-transaction-log-days=7',
    '--deletion-protection',
    '--no-assign-ip',
    '--ssl-mode=ENCRYPTED_ONLY',
    '--data-api-access=DISALLOW_DATA_API',
    '--storage-auto-increase',
    '--database-flags=cloudsql.iam_authentication=on',
  ])('creates the instance with %s', (flag) => {
    expect(args).toContain(flag);
  });
  it('attaches the instance to the production VPC only', () => {
    expect(args).toContain(`--network=projects/${PROD_SPEC.project}/global/networks/${PROD_SPEC.network}`);
    expect(args.some((a) => a.startsWith('--authorized-networks') || a === '--assign-ip')).toBe(false);
  });
  it('never puts a password in argv', () => {
    expect(args.some((a) => /password/i.test(a))).toBe(false);
  });
});

suite('instanceDrift', () => {
  it('reports nothing for a conforming instance', () => {
    expect(instanceDrift(conformingInstance(), PROD_SPEC)).toEqual([]);
  });
  const mutations: Array<[string, (i: Record<string, any>) => void, string]> = [
    ['a public IP', (i) => (i.settings.ipConfiguration.ipv4Enabled = true), 'no public IP (ipv4Enabled=false)'],
    ['zonal availability', (i) => (i.settings.availabilityType = 'ZONAL'), 'availabilityType=REGIONAL (HA)'],
    ['PITR off', (i) => (i.settings.backupConfiguration.pointInTimeRecoveryEnabled = false), 'point-in-time recovery enabled'],
    ['deletion protection off', (i) => (i.settings.deletionProtectionEnabled = false), 'deletionProtectionEnabled'],
    ['unencrypted connections allowed', (i) => (i.settings.ipConfiguration.sslMode = 'ALLOW_UNENCRYPTED_AND_ENCRYPTED'), 'sslMode=ENCRYPTED_ONLY'],
    ['the Data API left on', (i) => (i.settings.dataApiAccess = 'ALLOW_DATA_API'), 'Data API disallowed at rest'],
    ['an authorized network', (i) => (i.settings.ipConfiguration.authorizedNetworks = [{ value: '0.0.0.0/0' }]), 'no authorized networks'],
    ['a shorter log retention', (i) => (i.settings.backupConfiguration.transactionLogRetentionDays = 3), 'transactionLogRetentionDays=7'],
  ];
  it.each(mutations)('flags %s', (_name, mutate, expected) => {
    const inst = conformingInstance() as Record<string, any>;
    mutate(inst);
    expect(instanceDrift(inst, PROD_SPEC)).toEqual([expected]);
  });
});

suite('ownerRoleSql', () => {
  it('creates a non-superuser login role restricted to its own database', () => {
    const sql = ownerRoleSql('portal', scramSha256Verifier('pw-not-in-sql'));
    expect(sql.inPostgres).toMatch(/CREATE ROLE portal_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
    expect(sql.inPostgres).toMatch(/REVOKE ALL ON DATABASE portal FROM PUBLIC;/);
    expect(sql.inPostgres).toMatch(/GRANT CONNECT, CREATE, TEMPORARY ON DATABASE portal TO portal_owner;/);
    expect(sql.inPostgres).not.toContain('pw-not-in-sql');
  });
  it('refuses a plaintext password where a SCRAM verifier belongs', () => {
    expect(() => ownerRoleSql('portal', 'hunter2')).toThrow(/not a SCRAM-SHA-256 verifier/);
  });
  it('refuses an unsafe database name', () => {
    expect(() => ownerRoleSql('portal; DROP ROLE x', scramSha256Verifier('p'))).toThrow(/unsafe database name/);
  });
});

suite('judgeLogin', () => {
  const owner = { role: 'portal_owner', db: 'portal', createRole: false };
  const admin = { role: 'harness_admin', db: 'papercusp_hosted', createRole: true };
  const clean = (role: string, db: string, createrole: boolean, selfgrant = '') => ({
    user: role,
    db,
    super: false,
    createrole,
    replication: false,
    bypassrls: false,
    cloudsqlsuperuser: false,
    selfgrant,
  });

  it('passes a conforming owner and a conforming migration role', () => {
    expect(judgeLogin(clean('portal_owner', 'portal', false), owner)).toEqual([]);
    expect(judgeLogin(clean('harness_admin', 'papercusp_hosted', true, 'set, inherit'), admin)).toEqual([]);
  });
  // upsertRoleSql cannot reset these on an existing role, so verify is the only check on them.
  it.each(['super', 'replication', 'bypassrls', 'cloudsqlsuperuser'])('flags %s=true as over-privileged', (attr) => {
    expect(judgeLogin({ ...clean('portal_owner', 'portal', false), [attr]: true }, owner)).toEqual([
      expect.stringMatching(/^portal_owner is over-privileged/),
    ]);
  });
  it('flags a CREATEROLE owner and a migration role without CREATEROLE', () => {
    expect(judgeLogin(clean('portal_owner', 'portal', true), owner)).toEqual(['portal_owner has createrole=true, want false']);
    expect(judgeLogin(clean('harness_admin', 'papercusp_hosted', false, 'set, inherit'), admin)).toEqual([
      'harness_admin has createrole=false, want true',
    ]);
  });
  // Without it, migration 978 cannot SET ROLE to the hosted_* roles it just created (D-010).
  it('flags a migration role missing the createrole_self_grant setting', () => {
    expect(judgeLogin(clean('harness_admin', 'papercusp_hosted', true, ''), admin)).toEqual([
      'harness_admin has createrole_self_grant="", want "set, inherit"',
    ]);
  });
  it('flags a probe that ran as someone else or in another database', () => {
    expect(judgeLogin(clean('postgres', 'portal', false), owner)[0]).toMatch(/unexpected identity/);
  });
  const ops = { role: 'harness_ops', db: 'papercusp_hosted', createRole: false };
  const cleanOps = () => ({ ...clean('harness_ops', 'papercusp_hosted', false), createdb: false, memberships: false,
    databaseWrite: false, directDataAccess: false, unauditedFunctions: false, readOnly: 'on', transactionTimeout: '15min', connectionLimit: 2 });
  it('requires measured read-only ops privileges rather than accepting absent probe fields', () => {
    expect(judgeLogin(cleanOps(), ops)).toEqual([]);
    expect(judgeLogin(clean('harness_ops', 'papercusp_hosted', false), ops)).toEqual([expect.stringContaining('not restricted')]);
  });
  it.each(['createdb', 'memberships', 'databaseWrite', 'directDataAccess', 'unauditedFunctions'])('rejects ops %s privilege drift', (field) => {
    expect(judgeLogin({ ...cleanOps(), [field]: true }, ops)).toEqual([expect.stringContaining('not restricted')]);
  });
  it.each([['readOnly', 'off'], ['transactionTimeout', '0'], ['connectionLimit', -1]])('rejects ops %s limit drift', (field, value) => {
    expect(judgeLogin({ ...cleanOps(), [field]: value }, ops)).toEqual([expect.stringContaining('not restricted')]);
  });
  it('probes every owner and both hosted login roles, each with its own password secret', () => {
    expect(loginTargets(PROD_SPEC).map((t) => `${t.role}@${t.db}:${t.from}:${t.createRole}`)).toEqual([
      'papercusp_hosted_owner@papercusp_hosted:cloudsql-papercusp-hosted-owner-password:false',
      'portal_owner@portal:cloudsql-portal-owner-password:false',
      'dbos_system_owner@dbos_system:cloudsql-dbos-system-owner-password:false',
      'harness_admin@papercusp_hosted:cloudsql-harness-admin-password:true',
      'harness_app@papercusp_hosted:cloudsql-harness-app-password:false',
      'harness_ops@papercusp_hosted:cloudsql-harness-ops-password:false',
    ]);
  });
});

suite('scramSha256Verifier', () => {
  it('produces a verifier that pg’s independent SCRAM client authenticates against', async () => {
    const sasl = require('pg/lib/crypto/sasl.js') as {
      startSession: (m: string[]) => { clientNonce: string; response: string };
      continueSession: (s: unknown, password: string, serverData: string) => Promise<void> | void;
      finalizeSession: (s: unknown, serverData: string) => void;
    };
    const password = generatePassword();
    const parts = scramVerifierParts(password);
    const verifier = scramSha256Verifier(password, parts.salt, parts.iterations);
    const m = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier)!;
    const [salt, storedKey, serverKey] = [m[1]!, Buffer.from(m[2]!, 'base64'), Buffer.from(m[3]!, 'base64')];

    const session = sasl.startSession(['SCRAM-SHA-256']) as { clientNonce: string; response: string };
    const clientFirstBare = session.response.replace(/^n,,/, '');
    const serverFirst = `r=${session.clientNonce}srv-nonce-123,s=${salt},i=4096`;
    await sasl.continueSession(session, password, serverFirst);
    const clientFinal = session.response;
    const proof = Buffer.from(/,p=([^,]+)$/.exec(clientFinal)![1]!, 'base64');
    const authMessage = `${clientFirstBare},${serverFirst},${clientFinal.replace(/,p=[^,]+$/, '')}`;

    // Server side, using ONLY the stored verifier: recover ClientKey from the proof.
    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]!));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
    // And the client accepts the server signature derived from ServerKey.
    const serverSignature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
    expect(() => sasl.finalizeSession(session, `v=${serverSignature}`)).not.toThrow();
  });
  it('uses a fresh salt per call', () => {
    expect(scramSha256Verifier('same')).not.toBe(scramSha256Verifier('same'));
  });
});

/** Fake gcloud answering from a function, recording every argv. */
function fakeGcloud(answer: (args: readonly string[]) => GcloudResult) {
  const calls: Array<{ args: readonly string[]; input?: string; env?: Readonly<Record<string, string>> }> = [];
  const gcloud: GcloudRunner = async (args, opts) => {
    calls.push({ args, input: opts?.input, env: opts?.env });
    return answer(args);
  };
  return { gcloud, calls };
}
const ok = (stdout = '{}'): GcloudResult => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string): GcloudResult => ({ code: 1, stdout: '', stderr });
/** A `--help` page documenting exactly the flags the provisioner passes to instance create. */
const fullCreateHelp = flagNames(instanceCreateArgs(PROD_SPEC))
  .map((f) => `     --${f}`)
  .join('\n');

suite('describe (idempotency)', () => {
  const quiet = { log: () => {}, sleep: async () => {} };
  it('reads only a gcloud not-found as absent', async () => {
    const { gcloud } = fakeGcloud(() => err("ERROR: (gcloud.sql.instances.describe) The Cloud SQL instance does not exist."));
    expect(await gcDescribe(makeCtx({ gcloud, ...quiet }), ['sql', 'instances', 'describe', 'x'])).toBeNull();
  });
  it('retries a transient failure instead of reading it as absent', async () => {
    let n = 0;
    const { gcloud } = fakeGcloud(() => (++n === 1 ? err('ERROR: There was a problem refreshing your current auth tokens') : ok('{"name":"x"}')));
    expect(await gcDescribe(makeCtx({ gcloud, ...quiet }), ['sql', 'instances', 'describe', 'x'])).toEqual({ name: 'x' });
    expect(n).toBe(2);
  });
  it('throws (never "absent") when every attempt fails for another reason', async () => {
    const { gcloud, calls } = fakeGcloud(() => err('ERROR: 503 backend error'));
    await expect(gcDescribe(makeCtx({ gcloud, ...quiet }), ['sql', 'instances', 'describe', 'x'])).rejects.toThrow(/cannot tell whether it exists/);
    expect(calls).toHaveLength(3);
  });
});

suite('up --dry-run (plan)', () => {
  it('against a fresh org plans the whole stack, mutates nothing, and keeps secrets out of argv', async () => {
    const { gcloud, calls } = fakeGcloud((args) =>
      args.includes('--help')
        ? ok(fullCreateHelp)
        : err('ERROR: [x] does not have permission to access projects instance [p] (or it may not exist)'),
    );
    const ctx = makeCtx({ gcloud, dryRun: true, log: () => {}, sleep: async () => {} });
    await up(ctx);
    const plan = ctx.mutations.join('\n');
    for (const step of [
      'projects create papercusp-cloud-prod',
      'billing projects link papercusp-cloud-prod',
      'services enable compute.googleapis.com servicenetworking.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com',
      'compute networks create pc-cloud-prod-net',
      'services vpc-peerings connect',
      'secrets create cloudsql-postgres-password',
      'sql instances create pc-cloud-prod-pg',
      'sql databases create papercusp_hosted',
      'sql databases create dbos_system',
      '--data-api-access=ALLOW_DATA_API',
      'secrets create cloudsql-portal-owner-password',
      'secrets create cloudsql-portal-url',
      'secrets create cloudsql-harness-admin-password',
      'secrets create cloudsql-harness-app-password',
      'secrets create cloudsql-harness-ops-password',
      'execute-sql as postgres: create/alter roles harness_admin, harness_app, harness_zero',
      'secrets create cloudsql-harness-admin-url',
      'secrets create cloudsql-harness-app-url',
      'secrets create cloudsql-harness-ops-url',
    ]) {
      expect(plan).toContain(step);
    }
    // The Data API is switched back off after the bootstrap SQL.
    expect(ctx.mutations.at(-1)).toMatch(/--data-api-access=DISALLOW_DATA_API/);
    // Dry-run issued only reads.
    expect(calls.every((c) => /describe|list|--help/.test(c.args.join(' ')))).toBe(true);
    expect(calls.some((c) => c.input !== undefined)).toBe(false);
  });
});

suite('P013 pinned ops URL reference', () => {
  const resource = 'projects/123456/locations/us-central1/secrets/cloudsql-harness-ops-url/versions/7';
  const quiet = { log: () => {}, sleep: async () => {} };
  it('returns a pinned canonical reference using metadata reads only', async () => {
    const { gcloud, calls } = fakeGcloud((args) => args[0] === 'projects'
      ? ok(JSON.stringify({ projectId: PROD_SPEC.project, projectNumber: '123456' }))
      : ok(JSON.stringify({ name: resource, state: 'ENABLED' })));
    expect(await readHostedOpsUrlReference(makeCtx({ gcloud, ...quiet }))).toBe(`${['gcp', 'secret'].join('-')}:${resource}`);
    expect(calls.every(c => c.args.includes('describe') && !c.args.includes('access') && c.input === undefined)).toBe(true);
    expect(calls[1]?.env?.CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER).toBe('https://secretmanager.us-central1.rep.googleapis.com/');
  });
  it.each([
    [resource, 'DISABLED'],
    [resource.replace('/7', '/latest'), 'ENABLED'],
    [resource.replace('123456', 'papercusp-cloud-prod'), 'ENABLED'],
    [resource.replace('us-central1', 'europe-west1'), 'ENABLED'],
    [resource.replace('harness-ops', 'harness-admin'), 'ENABLED'],
  ])('refuses disabled, floating or wrong-resource metadata: %s %s', async (name, state) => {
    const { gcloud } = fakeGcloud((args) => args[0] === 'projects'
      ? ok(JSON.stringify({ projectId: PROD_SPEC.project, projectNumber: '123456' }))
      : ok(JSON.stringify({ name, state })));
    await expect(readHostedOpsUrlReference(makeCtx({ gcloud, ...quiet }))).rejects.toThrow('hosted_ops_secret_version_identity_invalid');
  });
});

suite('regional Secret Manager endpoint', () => {
  const regional = 'https://secretmanager.us-central1.rep.googleapis.com/';

  it('overrides the endpoint for secrets commands only', () => {
    expect(gcloudEnvFor(PROD_SPEC, ['secrets', 'describe', 'x', '--location=us-central1'])).toEqual({
      CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER: regional,
    });
    expect(gcloudEnvFor(PROD_SPEC, ['sql', 'instances', 'describe', 'x'])).toBeUndefined();
    expect(secretManagerEndpoint('europe-west1')).toBe('https://secretmanager.europe-west1.rep.googleapis.com/');
  });

  // The first live `up` (2026-10-14) died on `gcloud secrets describe --location=…` hitting the
  // GLOBAL endpoint: INVALID_ARGUMENT "does not match the expected format [projects/*/secrets/*]".
  it('sends every secrets call of a real run through the regional endpoint, and nothing else', async () => {
    const { gcloud, calls } = fakeGcloud((args) => {
      if (args.includes('--help')) return ok(fullCreateHelp);
      if (args[0] === 'projects' && args[1] === 'describe') return ok('{"projectId":"papercusp-cloud-prod"}');
      if (args.includes('list')) return ok('[]');
      return err('ERROR: NOT_FOUND: was not found');
    });
    const ctx = makeCtx({ gcloud, dryRun: true, log: () => {}, sleep: async () => {} });
    await up(ctx);
    const secretCalls = calls.filter((c) => c.args[0] === 'secrets');
    expect(secretCalls.length).toBeGreaterThan(0);
    for (const c of secretCalls) expect(c.env?.CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER).toBe(regional);
    expect(calls.filter((c) => c.args[0] !== 'secrets' && c.env !== undefined)).toEqual([]);
  });
});

suite('verify owns the Data API window', () => {
  it('detects ops access to the second other database even when the first refuses it', async () => {
    const { gcloud, calls } = fakeGcloud((args) => {
      if (args[0] === 'projects') return ok(JSON.stringify({ projectId: PROD_SPEC.project, projectNumber: '123456' }));
      if (args[0] === 'secrets' && args.includes('versions')) return ok(JSON.stringify({
        name: 'projects/123456/locations/us-central1/secrets/cloudsql-harness-ops-url/versions/1', state: 'ENABLED',
      }));
      if (args.includes('execute-sql')) {
        const user = args.find(a => a.startsWith('--user='))!.slice(7);
        const db = args.find(a => a.startsWith('--database='))!.slice(11);
        if (args.includes('--sql=SELECT 1')) return user === 'harness_ops' && db === 'dbos_system' ? ok() : err('permission denied');
        const probe = { user, db, super: false, createrole: user === 'harness_admin', replication: false,
          bypassrls: false, cloudsqlsuperuser: false, selfgrant: user === 'harness_admin' ? 'set, inherit' : '',
          createdb: false, memberships: false, databaseWrite: false, directDataAccess: false,
          unauditedFunctions: false, readOnly: 'on', transactionTimeout: '15min', connectionLimit: 2 };
        return ok(JSON.stringify({ j: JSON.stringify(probe) }));
      }
      if (args.includes('instances') && args.includes('describe')) return ok(JSON.stringify(conformingInstance()));
      if (args.includes('databases') && args.includes('list')) return ok(JSON.stringify(PROD_SPEC.databases.map(name => ({ name }))));
      return ok();
    });
    const report = await verify(makeCtx({ gcloud, log: () => {}, sleep: async () => {} }), { logins: true });
    expect(report.loginFailures).toEqual(['harness_ops could connect to dbos_system (CONNECT not restricted)']);
    expect(calls.filter(c => c.args.includes('--user=harness_ops') && c.args.includes('--sql=SELECT 1'))
      .map(c => c.args.find(a => a.startsWith('--database=')))).toEqual(['--database=portal', '--database=dbos_system']);
  });

  // The third live `up` (2026-10-14) reported "Data API disallowed at rest" on a conforming
  // instance: it described the instance for drift while the login checks held the API open.
  it('checks drift only after the window closes, so a conforming instance passes with logins on', async () => {
    let apiOn = false;
    const describedWhileOpen: boolean[] = [];
    const { gcloud } = fakeGcloud((args) => {
      const line = args.join(' ');
      if (line.includes('instances patch')) {
        apiOn = line.includes('--data-api-access=ALLOW_DATA_API');
        return ok();
      }
      if (line.includes('instances describe')) {
        describedWhileOpen.push(apiOn);
        const inst = conformingInstance();
        const settings = { ...(inst.settings as Record<string, unknown>), dataApiAccess: apiOn ? 'ALLOW_DATA_API' : 'DISALLOW_DATA_API' };
        return ok(JSON.stringify({ ...inst, ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.20.0.3' }], settings }));
      }
      if (line.includes('execute-sql')) return ok('{}');
      if (line.includes('databases list')) return ok(JSON.stringify(PROD_SPEC.databases.map((name) => ({ name }))));
      if (args.includes('list')) return ok('[]');
      return ok('{}');
    });
    const quiet = { log: () => {}, sleep: async () => {} };
    const report = await verify(makeCtx({ gcloud, ...quiet }), { logins: true });
    expect(report.instanceDrift).toEqual([]);
    expect(describedWhileOpen.at(-1)).toBe(false);
    expect(apiOn).toBe(false);

    // The defect lived in the CALLER: `up` wrapped verify inside its own bootstrap window.
    describedWhileOpen.length = 0;
    const httpPut = async () => ({ status: 200, text: '{}' });
    const upReport = await up(makeCtx({ gcloud, httpPut, ...quiet }));
    expect(upReport?.instanceDrift).toEqual([]);
    expect(describedWhileOpen.at(-1)).toBe(false);
    expect(apiOn).toBe(false);
  });
});

suite('gcloud flag preflight', () => {
  // Abridged from the real GA `gcloud sql instances create --help` (SDK 581), which documents
  // neither --allocated-ip-range-name nor --labels.
  const gaHelp = [
    '        [--[no-]assign-ip] [--async] [--audit-bucket-path=AUDIT_BUCKET_PATH]',
    '     --[no-]deletion-protection',
    '     --[no-]storage-auto-increase',
    '     --[no-]insights-config-enhanced-query-insights-enabled',
    '     --[no-]insights-config-query-insights-enabled',
    '     --database-version=DATABASE_VERSION; default="MYSQL_8_0"',
    '     --network=NETWORK',
    '    These flags are available to all commands: --access-token-file, --account,',
    '    --help, --impersonate-service-account, --log-http, --project, --quiet,',
  ].join('\n');

  it('names the flags the installed CLI does not document, accepting --[no-] forms and wide flags', () => {
    const args = [
      'sql', 'instances', 'create', 'x', '--project=p', '--quiet', '--no-assign-ip', '--deletion-protection',
      '--storage-auto-increase', '--insights-config-query-insights-enabled', '--database-version=POSTGRES_18',
      '--network=projects/p/global/networks/n', '--allocated-ip-range-name=r', '--labels=a=b',
    ];
    expect(unknownFlags(args, gaHelp)).toEqual(['allocated-ip-range-name', 'labels']);
  });

  it('does not let a longer documented flag vouch for a shorter one', () => {
    expect(unknownFlags(['--insights-config-query-insights'], '     --[no-]insights-config-query-insights-enabled')).toEqual([
      'insights-config-query-insights',
    ]);
  });

  it('recognizes flags in terminal-formatted gcloud help without accepting undocumented flags', () => {
    const help = [
      '    [\u001b[1m--network\u001b[m=\u001b[4mNETWORK\u001b[m]',
      '    [\u001b[1m--subnet\u001b[m=\u001b[4mSUBNET\u001b[m]',
      '    [\u001b[1m--service-account\u001b[m=ACCOUNT | \u001b[1m--no-service-account\u001b[m]',
      '    [\u001b[1m--scopes\u001b[m=SCOPE | \u001b[1m--no-scopes\u001b[m]',
      '    [\u001b[1m--labels\u001b[m=KEY=VALUE]',
      '    [\u001b[1m--metadata\u001b[m=KEY=VALUE]',
    ].join('\n');
    expect(unknownFlags([
      '--network=n', '--subnet=s', '--no-service-account', '--no-scopes',
      '--labels=a=b', '--metadata=startup-script=x', '--not-a-real-flag',
    ], help)).toEqual(['not-a-real-flag']);
  });

  it('creates the instance on the beta track, where every flag is documented', () => {
    expect(instanceCreateArgs(PROD_SPEC).slice(0, 4)).toEqual([...INSTANCE_CREATE_CMD]);
    expect(INSTANCE_CREATE_CMD[0]).toBe('beta');
  });

  // The second live `up` (2026-10-14) died on GA gcloud rejecting --allocated-ip-range-name and
  // --labels, after the plan had printed them as fine. `plan` must now refuse instead.
  it('refuses in plan, before planning the create, when the CLI would reject a flag', async () => {
    const { gcloud } = fakeGcloud((args) =>
      args.includes('--help') ? ok(gaHelp) : err('ERROR: [x] does not have permission (or it may not exist)'),
    );
    const ctx = makeCtx({ gcloud, dryRun: true, log: () => {}, sleep: async () => {} });
    await expect(up(ctx)).rejects.toThrow(/unknown to gcloud beta sql instances create: .*--allocated-ip-range-name.*--labels/);
    expect(ctx.mutations.some((m) => m.includes('sql instances create'))).toBe(false);
  });

  it('keeps the line after "unrecognized arguments:" in the error', () => {
    expect(stderrHead('ERROR: (gcloud.sql.instances.create) unrecognized arguments:\n  --labels=a=b \n\nTo search the help text')).toBe(
      'ERROR: (gcloud.sql.instances.create) unrecognized arguments: ⏎ --labels=a=b ⏎ To search the help text',
    );
  });
});

suite('jsonCells', () => {
  it('extracts JSON-object cells from ExecuteSql output', () => {
    const stdout = JSON.stringify({ results: [{ rows: [{ values: [{ value: '{"user":"portal_owner","super":false}' }] }] }] });
    expect(jsonCells(stdout)).toEqual([{ user: 'portal_owner', super: false }]);
  });
});

// SPEC-P-004: the instance refuses a non-TLS connection. Messages are libpq's real formats.
const REFUSED_PLAIN =
  'psql: error: connection to server at "10.20.0.3", port 5432 failed: FATAL:  pg_hba.conf rejects connection for host "10.60.0.2", user "portal_owner", database "portal", no encryption';
const AUTH_FAILED_TLS =
  'psql: error: connection to server at "10.20.0.3", port 5432 failed: FATAL:  password authentication failed for user "portal_owner"';
const TIMED_OUT = 'psql: error: connection to server at "10.20.0.3", port 5432 failed: timeout expired';
const serialWith = (plain: string, tls: string) =>
  `boot noise\nstartup-script: PCPROBE disable ${plain}\nstartup-script: PCPROBE require ${tls}\nstartup-script: ${TLS_PROBE_DONE}\n`;

suite('TLS probe verdict (SPEC-P-004)', () => {
  it('passes when plaintext is refused before authentication and TLS reaches it', () => {
    const v = judgeTlsProbe(serialWith(`rc=2 msg=${REFUSED_PLAIN}`, `rc=2 msg=${AUTH_FAILED_TLS}`));
    expect(v.reasons).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.plain).toEqual({ rc: 2, msg: REFUSED_PLAIN });
  });
  it.each([
    ['a plaintext connection that runs a query', `rc=0 msg=1`, `rc=2 msg=${AUTH_FAILED_TLS}`, /plaintext connection ran a query/],
    ['a plaintext connection that reaches password auth', `rc=2 msg=${AUTH_FAILED_TLS}`, `rc=2 msg=${AUTH_FAILED_TLS}`, /reached password authentication/],
    ['an unreachable server, which must never read as a refusal', `rc=2 msg=${TIMED_OUT}`, `rc=2 msg=${TIMED_OUT}`, /not refused by the server/],
    ['a VM without psql', 'rc=127 msg=bash: psql: command not found', 'rc=127 msg=bash: psql: command not found', /TLS control did not reach/],
  ])('fails on %s', (_name, plain, tls, reason) => {
    const v = judgeTlsProbe(serialWith(plain, tls));
    expect(v.ok).toBe(false);
    expect(v.reasons.join('\n')).toMatch(reason);
  });
  it('fails when the console carries no result at all', () => {
    expect(judgeTlsProbe('boot noise only').reasons).toEqual([
      'no sslmode=disable result on the serial console',
      'no sslmode=require result on the serial console',
    ]);
  });
});

suite('TLS probe VM and script', () => {
  it('runs the probe from the production subnet with no Google API access', () => {
    const args = tlsProbeVmArgs(PROD_SPEC, tlsProbeStartupScript('10.20.0.3', 'portal', 'portal_owner'));
    expect(args.slice(0, 4)).toEqual(['compute', 'instances', 'create', TLS_PROBE_VM]);
    expect(args).toEqual(
      expect.arrayContaining([
        `--network=${PROD_SPEC.network}`,
        `--subnet=${PROD_SPEC.subnet}`,
        `--zone=${PROD_SPEC.region}-a`,
        '--no-service-account',
        '--no-scopes',
        `--project=${PROD_SPEC.project}`,
      ]),
    );
    expect(args.find((a) => a.startsWith('--metadata='))).toMatch(/^--metadata=\^~\^startup-script=#!\/bin\/bash\n/);
    expect(() => tlsProbeVmArgs(PROD_SPEC, 'echo ~')).toThrow(/must not contain "~"/);
  });
  it('refuses a target or name that could break out of the conninfo string', () => {
    expect(() => tlsProbeStartupScript('10.0.0.1"; rm -rf /', 'portal', 'portal_owner')).toThrow(/non-IPv4/);
    expect(() => tlsProbeStartupScript('10.0.0.1', 'portal sslmode=disable', 'portal_owner')).toThrow(/unsafe/);
  });
  it('emits one judgeable line per mode when the real script runs against a stub psql', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-probe-'));
    try {
      // The stub answers like Cloud SQL with ENCRYPTED_ONLY, over TWO lines, so the script's
      // newline folding is exercised too.
      writeFileSync(
        join(dir, 'psql'),
        [
          '#!/bin/bash',
          'case "$1" in',
          `  *sslmode=disable*) printf '%s\\n%s\\n' "psql: error: connection to server failed:" "FATAL:  pg_hba.conf rejects connection, no encryption" >&2; exit 2;;`,
          `  *sslmode=require*) echo "psql: error: FATAL:  password authentication failed for user \\"portal_owner\\"" >&2; exit 2;;`,
          'esac',
        ].join('\n'),
        { mode: 0o755 },
      );
      writeFileSync(join(dir, 'apt-get'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      const script = join(dir, 'probe.sh');
      writeFileSync(script, tlsProbeStartupScript('10.20.0.3', 'portal', 'portal_owner'));
      const out = execFileSync('bash', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }).toString();
      expect(out).toContain(TLS_PROBE_DONE);
      const v = judgeTlsProbe(out);
      expect(v.reasons).toEqual([]);
      expect(v.plain?.msg).toMatch(/failed: FATAL: {2}pg_hba\.conf rejects connection, no encryption$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

suite('probeTls (fake gcloud)', () => {
  const quiet = { log: () => {}, sleep: async () => {} };
  const createHelp = flagNames(tlsProbeVmArgs(PROD_SPEC, 'x'))
    .map((f) => `     --${f}`)
    .join('\n');
  function probeGcloud(serial: () => GcloudResult) {
    let vmExists = false;
    return fakeGcloud((args) => {
      const cmd = args.slice(0, 3).join(' ');
      if (cmd === 'sql instances describe') return ok(JSON.stringify({ ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.20.0.3' }] }));
      if (args.includes('--help')) return ok(createHelp);
      if (cmd === 'compute instances describe') return vmExists ? ok(JSON.stringify({ name: TLS_PROBE_VM })) : err('ERROR: was not found');
      if (cmd === 'compute instances create') return (vmExists = true), ok('');
      if (cmd === 'compute instances delete') return (vmExists = false), ok('');
      if (cmd === 'compute instances get-serial-port-output') return serial();
      return err(`unexpected: ${args.join(' ')}`);
    });
  }
  /** The VM lifecycle calls, in order; the read-only `create --help` preflight is not one. */
  const verbs = (calls: Array<{ args: readonly string[] }>) =>
    calls
      .filter((c) => !c.args.includes('--help'))
      .map((c) => c.args.slice(0, 3).join(' '))
      .filter((v) => /create|delete|serial/.test(v));

  it('waits for the result, judges it, and deletes the VM', async () => {
    let reads = 0;
    const { gcloud, calls } = probeGcloud(() =>
      ++reads < 3 ? ok('still booting') : ok(serialWith(`rc=2 msg=${REFUSED_PLAIN}`, `rc=2 msg=${AUTH_FAILED_TLS}`)),
    );
    const v = await probeTls(makeCtx({ gcloud, ...quiet }));
    expect(v.ok).toBe(true);
    expect(verbs(calls)).toEqual([
      'compute instances create',
      'compute instances get-serial-port-output',
      'compute instances get-serial-port-output',
      'compute instances get-serial-port-output',
      'compute instances delete',
    ]);
  });
  it('still deletes the VM when no result ever arrives, and fails', async () => {
    const { gcloud, calls } = probeGcloud(() => ok('still booting'));
    const v = await probeTls(makeCtx({ gcloud, ...quiet }), { attempts: 3 });
    expect(v.ok).toBe(false);
    expect(v.reasons).toEqual(['the probe VM printed no result after 3 serial-console reads']);
    expect(verbs(calls).at(-1)).toBe('compute instances delete');
  });
  it('deletes a VM left behind by an interrupted run before probing', async () => {
    const { gcloud, calls } = fakeGcloud((args) => {
      const cmd = args.slice(0, 3).join(' ');
      if (cmd === 'sql instances describe') return ok(JSON.stringify({ ipAddresses: [{ type: 'PRIVATE', ipAddress: '10.20.0.3' }] }));
      if (args.includes('--help')) return ok(createHelp);
      if (cmd === 'compute instances describe') return ok(JSON.stringify({ name: TLS_PROBE_VM }));
      if (cmd === 'compute instances get-serial-port-output') return ok(serialWith(`rc=2 msg=${REFUSED_PLAIN}`, `rc=2 msg=${AUTH_FAILED_TLS}`));
      return ok('');
    });
    await probeTls(makeCtx({ gcloud, ...quiet }));
    expect(verbs(calls)[0]).toBe('compute instances delete');
    expect(verbs(calls)[1]).toBe('compute instances create');
  });
  it('reads the private address and refuses an instance without one', () => {
    expect(privateIp({ ipAddresses: [{ type: 'PRIMARY', ipAddress: '1.2.3.4' }, { type: 'PRIVATE', ipAddress: '10.20.0.3' }] })).toBe('10.20.0.3');
    expect(() => privateIp({ ipAddresses: [{ type: 'PRIMARY', ipAddress: '1.2.3.4' }] })).toThrow(/no PRIVATE ip/);
  });
});
