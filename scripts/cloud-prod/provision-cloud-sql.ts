#!/usr/bin/env -S npx tsx
/**
 * Production Postgres for the hosted control plane and portal, as code
 * (plan cloud-portal-public-release-2026-10-13, P-004; shape = D-004, project = D-007;
 * hosted control plane roles = P-005 / D-010, SQL in role-sql.ts).
 *
 *   plan     print every mutation `up` would make, change nothing
 *   up       idempotently create the project, network, private services access,
 *            secrets, Cloud SQL instance, databases, per-database owner roles and the
 *            hosted roles (harness_admin, harness_app, harness_zero, harness_ops), then verify.
 *            Safe to re-run: existing resources are left alone.
 *   verify   check the live instance against the spec (drift = non-zero exit).
 *            `verify --logins` also proves each owner and hosted role can log in to its
 *            own database and NOT to the others (briefly enables the Data API).
 *   probe-tls  from a throwaway VM inside the VPC, prove the instance refuses a plaintext
 *            (sslmode=disable) connection before authentication; the VM is always deleted.
 *   status   one-line instance summary
 *
 * Secrets: every password is generated here, written to a REGIONAL Secret Manager
 * secret through stdin, and never placed in argv. Roles are created with a locally
 * computed SCRAM-SHA-256 verifier (scram.ts), so the SQL text sent to the ExecuteSql
 * API never contains a plaintext password. The Data API (ExecuteSql) is enabled only
 * while `up` / `verify --logins` run their SQL, then disabled again.
 *
 * Same pattern as scripts/relay/provision-relay-vm.sh: only gcloud's "not found" reads
 * as absent; any other describe failure is retried and then fatal.
 */
import { execFile } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { assertPinnedGcpSecretReference } from '@papercusp/operator-core/lib/inference-gateway/egress-providers/secret-ref';
import {
  assertIdent,
  assertScramVerifier,
  HOSTED_DATABASE,
  HOSTED_ROLES,
  HOSTED_OPS_ROLE,
  hostedPasswordSecret,
  hostedUrlSecret,
  productionRoleSql,
  upsertRoleSql,
} from './role-sql';
import { generatePassword, scramSha256Verifier } from './scram';

export interface CloudSqlProdSpec {
  organizationId: string;
  billingAccount: string;
  project: string;
  projectName: string;
  region: string;
  network: string;
  subnet: string;
  subnetRange: string;
  psaRange: string;
  psaPrefixLength: number;
  instance: string;
  databaseVersion: string;
  edition: 'ENTERPRISE';
  tier: string;
  storageGb: number;
  backupStartTime: string;
  transactionLogDays: number;
  retainedBackups: number;
  maintenanceDay: string;
  maintenanceHour: number;
  databases: readonly string[];
  labels: Readonly<Record<string, string>>;
}

export const PROD_SPEC: CloudSqlProdSpec = {
  organizationId: '118335394393',
  billingAccount: '0113AC-50E9A0-8BB71D',
  project: process.env.CLOUD_PROD_PROJECT ?? 'papercusp-cloud-prod',
  projectName: 'Papercusp cloud production',
  region: 'us-central1',
  network: 'pc-cloud-prod-net',
  subnet: 'pc-cloud-prod-subnet',
  subnetRange: '10.60.0.0/24',
  psaRange: 'pc-cloud-prod-psa',
  psaPrefixLength: 20,
  instance: 'pc-cloud-prod-pg',
  databaseVersion: 'POSTGRES_18',
  edition: 'ENTERPRISE',
  tier: 'db-custom-1-3840',
  storageGb: 20,
  backupStartTime: '07:00',
  transactionLogDays: 7,
  retainedBackups: 7,
  maintenanceDay: 'SUN',
  maintenanceHour: 8,
  databases: ['papercusp_hosted', 'portal', 'dbos_system'],
  labels: { 'papercusp-role': 'cloud-prod', 'papercusp-plan': 'cloud-portal-public-release' },
};

export const REQUIRED_SERVICES = [
  'compute.googleapis.com',
  'servicenetworking.googleapis.com',
  'sqladmin.googleapis.com',
  'secretmanager.googleapis.com',
] as const;

export const ROOT_SECRET = 'cloudsql-postgres-password';
export const ownerRole = (db: string) => `${db}_owner`;
export const ownerPasswordSecret = (db: string) => `cloudsql-${db.replace(/_/g, '-')}-owner-password`;
export const urlSecret = (db: string) => `cloudsql-${db.replace(/_/g, '-')}-url`;

// ── gcloud seam ──────────────────────────────────────────────────────────────

export interface GcloudResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GcloudRunner = (
  args: readonly string[],
  opts?: { input?: string; env?: Readonly<Record<string, string>> },
) => Promise<GcloudResult>;
export type HttpPut = (url: string, token: string, body: unknown) => Promise<{ status: number; text: string }>;

export interface Ctx {
  spec: CloudSqlProdSpec;
  gcloud: GcloudRunner;
  httpPut: HttpPut;
  dryRun: boolean;
  /** Mutations performed (or, in dry-run, planned), as human-readable argv lines. */
  mutations: string[];
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** Upper bound for one gcloud call; `sql instances create` for a regional HA instance takes ~10–20 min. */
export const GCLOUD_TIMEOUT_MS = 45 * 60 * 1000;

export const realGcloud: GcloudRunner = (args, opts) =>
  new Promise((resolve) => {
    const env = opts?.env ? { ...process.env, ...opts.env } : process.env;
    const child = execFile('gcloud', [...args], { maxBuffer: 32 * 1024 * 1024, timeout: GCLOUD_TIMEOUT_MS, env }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    if (opts?.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });

export const realHttpPut: HttpPut = async (url, token, body) => {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

const NOT_FOUND = /was not found|not found|NOT_FOUND|does not exist|or it may not exist/i;

function proj(ctx: Ctx): string[] {
  return [`--project=${ctx.spec.project}`, '--quiet'];
}

/**
 * Every secret here is REGIONAL (`--location`), and regional secrets are served only by the
 * regional endpoint. Without this override gcloud sends `secrets …` to the global endpoint,
 * which rejects the regional resource name with INVALID_ARGUMENT "does not match the expected
 * format [projects/*\/secrets/*]" — the first live `up` (2026-10-14) died on exactly that.
 */
export const secretManagerEndpoint = (region: string) => `https://secretmanager.${region}.rep.googleapis.com/`;

/** Extra environment one gcloud invocation needs; undefined when it needs none. */
export function gcloudEnvFor(spec: CloudSqlProdSpec, args: readonly string[]): Record<string, string> | undefined {
  return args[0] === 'secrets'
    ? { CLOUDSDK_API_ENDPOINT_OVERRIDES_SECRETMANAGER: secretManagerEndpoint(spec.region) }
    : undefined;
}

/** The one path to ctx.gcloud, so no call site can forget a per-command environment. */
function callGcloud(ctx: Ctx, args: readonly string[], opts?: { input?: string }): Promise<GcloudResult> {
  const env = gcloudEnvFor(ctx.spec, args);
  return ctx.gcloud(args, env ? { ...opts, env } : opts);
}

async function run(ctx: Ctx, args: readonly string[], opts?: { input?: string }): Promise<GcloudResult> {
  const r = await callGcloud(ctx, args, opts);
  if (r.code !== 0) throw new Error(`gcloud ${args.join(' ')} failed (exit ${r.code}): ${stderrHead(r.stderr)}`);
  return r;
}

/**
 * The first few non-empty stderr lines. One line is not enough: gcloud prints
 * "unrecognized arguments:" and names the offending flags on the NEXT line.
 */
export function stderrHead(s: string, lines = 4): string {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join(' ⏎ ');
}

/** Flag names (without `--` or `=value`) in an argv, in order. */
export function flagNames(args: readonly string[]): string[] {
  return args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')[0]!);
}

/**
 * Flags in `args` that `helpText` (the command's own `--help`) does not document.
 * `--no-x` is known when help shows `--[no-]x`; gcloud-wide flags such as --project and
 * --quiet are listed in every command's help under GCLOUD WIDE FLAGS.
 */
export function unknownFlags(args: readonly string[], helpText: string): string[] {
  const plainHelp = stripVTControlCharacters(helpText);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return flagNames(args).filter((name) => {
    const base = name.startsWith('no-') ? name.slice(3) : name;
    const documented = new RegExp(`(^|[\\s\\[,])--(\\[no-\\])?(${escape(name)}|${escape(base)})(?![\\w-])`, 'm');
    return !documented.test(plainHelp);
  });
}

/** Refuse, before any mutation, an argv the installed gcloud would reject. Read-only; runs in `plan` too. */
export async function preflightFlags(ctx: Ctx, command: readonly string[], args: readonly string[]): Promise<void> {
  const help = await run(ctx, [...command, '--help']);
  const unknown = unknownFlags(args, help.stdout);
  if (unknown.length) {
    throw new Error(`flag(s) unknown to gcloud ${command.join(' ')}: ${unknown.map((f) => `--${f}`).join(', ')}`);
  }
}

/** A write. In dry-run it is only recorded. `input` is never logged. */
async function mutate(ctx: Ctx, args: readonly string[], opts?: { input?: string }): Promise<GcloudResult> {
  ctx.mutations.push(`gcloud ${args.join(' ')}${opts?.input !== undefined ? ' <stdin: secret>' : ''}`);
  if (ctx.dryRun) return { code: 0, stdout: '', stderr: '' };
  return run(ctx, args, opts);
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim()) ?? '').trim();
}

/**
 * Describe for existence. Resolves the parsed JSON when present, null only when gcloud
 * says the resource is not found; any other failure is retried 3× and then thrown.
 */
export async function describe(ctx: Ctx, args: readonly string[]): Promise<Record<string, unknown> | null> {
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await callGcloud(ctx, [...args, '--format=json']);
    if (r.code === 0) return r.stdout.trim() ? (JSON.parse(r.stdout) as Record<string, unknown>) : {};
    if (NOT_FOUND.test(r.stderr)) return null;
    last = firstLine(r.stderr);
    ctx.log(`describe failed (attempt ${attempt}/3): ${last}`);
    if (attempt < 3) await ctx.sleep(5000);
  }
  throw new Error(`cannot tell whether it exists: gcloud ${args.join(' ')}: ${last}`);
}

// ── pure spec → argv / drift ─────────────────────────────────────────────────

export function labelArg(labels: Readonly<Record<string, string>>): string {
  return `--labels=${Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')}`;
}

/**
 * The BETA track on purpose: GA `gcloud sql instances create` (SDK 581) rejects
 * `--allocated-ip-range-name` and `--labels` as "unrecognized arguments" — the second live
 * `up` (2026-10-14) died on exactly that. `preflightFlags` checks every flag below against the
 * installed CLI's own --help before anything is created, so `plan` catches the next mismatch.
 */
export const INSTANCE_CREATE_CMD = ['beta', 'sql', 'instances', 'create'] as const;

export function instanceCreateArgs(spec: CloudSqlProdSpec): string[] {
  return [
    ...INSTANCE_CREATE_CMD,
    spec.instance,
    `--project=${spec.project}`,
    '--quiet',
    `--database-version=${spec.databaseVersion}`,
    `--edition=${spec.edition}`,
    `--tier=${spec.tier}`,
    `--region=${spec.region}`,
    '--availability-type=REGIONAL',
    '--storage-type=SSD',
    `--storage-size=${spec.storageGb}`,
    '--storage-auto-increase',
    `--backup-start-time=${spec.backupStartTime}`,
    `--retained-backups-count=${spec.retainedBackups}`,
    '--enable-point-in-time-recovery',
    `--retained-transaction-log-days=${spec.transactionLogDays}`,
    '--deletion-protection',
    '--no-assign-ip',
    `--network=projects/${spec.project}/global/networks/${spec.network}`,
    `--allocated-ip-range-name=${spec.psaRange}`,
    '--ssl-mode=ENCRYPTED_ONLY',
    '--database-flags=cloudsql.iam_authentication=on',
    '--data-api-access=DISALLOW_DATA_API',
    `--maintenance-window-day=${spec.maintenanceDay}`,
    `--maintenance-window-hour=${spec.maintenanceHour}`,
    '--insights-config-query-insights-enabled',
    labelArg(spec.labels),
  ];
}

type Json = Record<string, unknown>;
const at = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Json)[k] : undefined), o);

/**
 * Every property D-004 / P-004 requires, checked against `gcloud sql instances describe`
 * JSON. Returns the failed checks; empty = conforms.
 */
export function instanceDrift(inst: Json, spec: CloudSqlProdSpec): string[] {
  const s = (inst.settings ?? {}) as Json;
  const flags = (at(s, 'databaseFlags') as Array<{ name?: string; value?: string }> | undefined) ?? [];
  const checks: Array<[string, boolean]> = [
    [`databaseVersion=${spec.databaseVersion}`, inst.databaseVersion === spec.databaseVersion],
    [`region=${spec.region}`, inst.region === spec.region],
    [`edition=${spec.edition}`, s.edition === spec.edition],
    [`tier=${spec.tier}`, s.tier === spec.tier],
    ['availabilityType=REGIONAL (HA)', s.availabilityType === 'REGIONAL'],
    ['dataDiskType=PD_SSD', s.dataDiskType === 'PD_SSD'],
    [`dataDiskSizeGb>=${spec.storageGb}`, Number(s.dataDiskSizeGb) >= spec.storageGb],
    ['storageAutoResize', s.storageAutoResize === true],
    ['backups enabled', at(s, 'backupConfiguration', 'enabled') === true],
    ['point-in-time recovery enabled', at(s, 'backupConfiguration', 'pointInTimeRecoveryEnabled') === true],
    [
      `transactionLogRetentionDays=${spec.transactionLogDays}`,
      Number(at(s, 'backupConfiguration', 'transactionLogRetentionDays')) === spec.transactionLogDays,
    ],
    [
      `retainedBackups>=${spec.retainedBackups}`,
      Number(at(s, 'backupConfiguration', 'backupRetentionSettings', 'retainedBackups')) >= spec.retainedBackups,
    ],
    ['deletionProtectionEnabled', s.deletionProtectionEnabled === true],
    ['no public IP (ipv4Enabled=false)', at(s, 'ipConfiguration', 'ipv4Enabled') === false],
    [
      `private network=${spec.network}`,
      String(at(s, 'ipConfiguration', 'privateNetwork') ?? '').endsWith(`/networks/${spec.network}`),
    ],
    ['sslMode=ENCRYPTED_ONLY', at(s, 'ipConfiguration', 'sslMode') === 'ENCRYPTED_ONLY'],
    ['no authorized networks', ((at(s, 'ipConfiguration', 'authorizedNetworks') as unknown[]) ?? []).length === 0],
    ['cloudsql.iam_authentication=on', flags.some((f) => f.name === 'cloudsql.iam_authentication' && f.value === 'on')],
    ['Data API disallowed at rest', at(s, 'dataApiAccess') !== 'ALLOW_DATA_API'],
    ['state=RUNNABLE', inst.state === 'RUNNABLE'],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

/**
 * Bootstrap SQL for one database's owner role. Contains a SCRAM verifier, never a password.
 * Re-runnable as Cloud SQL's non-superuser `postgres`: see upsertRoleSql (role-sql.ts).
 */
export function ownerRoleSql(db: string, verifier: string): { inPostgres: string; inDatabase: string } {
  assertIdent('database', db);
  assertScramVerifier('ownerRoleSql', verifier);
  const role = ownerRole(db);
  const inPostgres = [
    upsertRoleSql({ name: role, login: true, connectionLimit: 100, verifier }),
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${role};`,
  ].join('\n');
  const inDatabase = `GRANT USAGE, CREATE ON SCHEMA public TO ${role};`;
  return { inPostgres, inDatabase };
}

/** ExecuteSql JSON carries row values as strings; pull out every JSON-object cell. */
export function jsonCells(stdout: string): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        out.push(JSON.parse(v) as Json);
      } catch {
        /* not a JSON cell */
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(stdout));
  } catch {
    /* non-JSON output */
  }
  return out;
}

// ── ensure steps ─────────────────────────────────────────────────────────────

const secretVersion = (spec: CloudSqlProdSpec, secret: string) =>
  `projects/${spec.project}/locations/${spec.region}/secrets/${secret}/versions/latest`;

async function ensureProject(ctx: Ctx): Promise<void> {
  const { spec } = ctx;
  const p = await describe(ctx, ['projects', 'describe', spec.project]);
  if (!p) {
    await mutate(ctx, [
      'projects',
      'create',
      spec.project,
      `--organization=${spec.organizationId}`,
      `--name=${spec.projectName}`,
      labelArg(spec.labels),
      '--quiet',
    ]);
  }
  const billing = await describe(ctx, ['billing', 'projects', 'describe', spec.project]);
  if (!billing || billing.billingEnabled !== true) {
    await mutate(ctx, ['billing', 'projects', 'link', spec.project, `--billing-account=${spec.billingAccount}`, '--quiet']);
  }
}

async function ensureServices(ctx: Ctx): Promise<void> {
  const r = ctx.dryRun
    ? { code: 0, stdout: '[]', stderr: '' }
    : await callGcloud(ctx, ['services', 'list', '--enabled', ...proj(ctx), '--format=json']);
  const enabled = new Set<string>();
  if (r.code === 0) {
    for (const s of JSON.parse(r.stdout || '[]') as Array<{ config?: { name?: string } }>) {
      if (s.config?.name) enabled.add(s.config.name);
    }
  }
  const missing = REQUIRED_SERVICES.filter((s) => !enabled.has(s));
  if (missing.length) await mutate(ctx, ['services', 'enable', ...missing, ...proj(ctx)]);
}

async function ensureNetwork(ctx: Ctx): Promise<void> {
  const { spec } = ctx;
  if (!(await describe(ctx, ['compute', 'networks', 'describe', spec.network, ...proj(ctx)]))) {
    await mutate(ctx, ['compute', 'networks', 'create', spec.network, '--subnet-mode=custom', ...proj(ctx)]);
  }
  const subnetArgs = ['compute', 'networks', 'subnets', 'describe', spec.subnet, `--region=${spec.region}`, ...proj(ctx)];
  if (!(await describe(ctx, subnetArgs))) {
    await mutate(ctx, [
      'compute',
      'networks',
      'subnets',
      'create',
      spec.subnet,
      `--network=${spec.network}`,
      `--region=${spec.region}`,
      `--range=${spec.subnetRange}`,
      '--enable-private-ip-google-access',
      ...proj(ctx),
    ]);
  }
}

async function ensurePrivateServicesAccess(ctx: Ctx): Promise<void> {
  const { spec } = ctx;
  if (!(await describe(ctx, ['compute', 'addresses', 'describe', spec.psaRange, '--global', ...proj(ctx)]))) {
    await mutate(ctx, [
      'compute',
      'addresses',
      'create',
      spec.psaRange,
      '--global',
      '--purpose=VPC_PEERING',
      `--prefix-length=${spec.psaPrefixLength}`,
      `--network=${spec.network}`,
      ...proj(ctx),
    ]);
  }
  const peerings = ctx.dryRun
    ? []
    : (JSON.parse(
        (await run(ctx, ['services', 'vpc-peerings', 'list', `--network=${spec.network}`, ...proj(ctx), '--format=json']))
          .stdout || '[]',
      ) as Array<{ service?: string; reservedPeeringRanges?: string[] }>);
  const connected = peerings.some(
    (p) => p.service === 'services/servicenetworking.googleapis.com' && (p.reservedPeeringRanges ?? []).includes(spec.psaRange),
  );
  if (!connected) {
    await mutate(ctx, [
      'services',
      'vpc-peerings',
      'connect',
      '--service=servicenetworking.googleapis.com',
      `--ranges=${spec.psaRange}`,
      `--network=${spec.network}`,
      ...proj(ctx),
    ]);
  }
}

/**
 * Ensure a regional secret exists and return its current value. A new secret gets
 * `generate()`'s value through stdin. In dry-run a placeholder is returned.
 */
async function ensureSecret(ctx: Ctx, name: string, generate: () => string): Promise<string> {
  const { spec } = ctx;
  const loc = `--location=${spec.region}`;
  const existing = ctx.dryRun && !(await canDescribeProject(ctx)) ? null : await describe(ctx, ['secrets', 'describe', name, loc, ...proj(ctx)]);
  if (existing) {
    if (ctx.dryRun) return 'dry-run-existing-secret';
    const r = await run(ctx, ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, loc, ...proj(ctx)]);
    return r.stdout;
  }
  const value = generate();
  await mutate(ctx, ['secrets', 'create', name, loc, labelArg(spec.labels), '--data-file=-', ...proj(ctx)], { input: value });
  return value;
}

/** In dry-run against a project that does not exist yet, skip describes inside it. */
async function canDescribeProject(ctx: Ctx): Promise<boolean> {
  return (await describe(ctx, ['projects', 'describe', ctx.spec.project])) !== null;
}

async function ensureInstance(ctx: Ctx, rootPassword: string): Promise<void> {
  const { spec } = ctx;
  const inst = await describe(ctx, ['sql', 'instances', 'describe', spec.instance, ...proj(ctx)]);
  if (!inst) {
    const args = instanceCreateArgs(spec);
    await preflightFlags(ctx, INSTANCE_CREATE_CMD, args);
    await mutate(ctx, args);
  }
  // Set the built-in postgres password through the REST body, never argv. Idempotent.
  ctx.mutations.push(`PUT sqladmin users?name=postgres (password from secret ${ROOT_SECRET})`);
  if (ctx.dryRun) return;
  const token = (await run(ctx, ['auth', 'print-access-token'])).stdout.trim();
  const url = `https://sqladmin.googleapis.com/v1/projects/${spec.project}/instances/${spec.instance}/users?name=postgres`;
  const res = await ctx.httpPut(url, token, { name: 'postgres', password: rootPassword });
  if (res.status < 200 || res.status >= 300) throw new Error(`set postgres password: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  const op = (JSON.parse(res.text) as { name?: string }).name;
  if (op) await run(ctx, ['sql', 'operations', 'wait', op, '--timeout=600', ...proj(ctx)]);
}

async function ensureDatabases(ctx: Ctx): Promise<void> {
  const { spec } = ctx;
  const have = new Set<string>();
  if (!ctx.dryRun) {
    const r = await run(ctx, ['sql', 'databases', 'list', `--instance=${spec.instance}`, ...proj(ctx), '--format=json']);
    for (const d of JSON.parse(r.stdout || '[]') as Array<{ name?: string }>) if (d.name) have.add(d.name);
  }
  for (const db of spec.databases) {
    if (!have.has(db)) await mutate(ctx, ['sql', 'databases', 'create', db, `--instance=${spec.instance}`, ...proj(ctx)]);
  }
}

async function setDataApi(ctx: Ctx, allow: boolean): Promise<void> {
  await mutate(ctx, [
    'sql',
    'instances',
    'patch',
    ctx.spec.instance,
    `--data-api-access=${allow ? 'ALLOW_DATA_API' : 'DISALLOW_DATA_API'}`,
    ...proj(ctx),
  ]);
}

export async function executeSql(
  ctx: Ctx,
  user: string,
  secret: string,
  database: string,
  sql: string,
): Promise<GcloudResult> {
  return callGcloud(ctx, [
    'sql',
    'instances',
    'execute-sql',
    ctx.spec.instance,
    `--user=${user}`,
    `--password-secret-version=${secretVersion(ctx.spec, secret)}`,
    `--database=${database}`,
    `--sql=${sql}`,
    ...proj(ctx),
    '--format=json',
  ]);
}

async function ensureOwnerRoles(ctx: Ctx, rootPassword: string): Promise<void> {
  const { spec } = ctx;
  for (const db of spec.databases) {
    const password = await ensureSecret(ctx, ownerPasswordSecret(db), () => generatePassword());
    const sql = ownerRoleSql(db, scramSha256Verifier(password));
    ctx.mutations.push(`execute-sql as postgres: create/alter role ${ownerRole(db)}, restrict CONNECT on ${db}`);
    if (!ctx.dryRun) {
      for (const [database, text] of [
        ['postgres', sql.inPostgres],
        [db, sql.inDatabase],
      ] as const) {
        const r = await executeSql(ctx, 'postgres', ROOT_SECRET, database, text);
        if (r.code !== 0) throw new Error(`bootstrap SQL for ${db} failed: ${firstLine(r.stderr)}`);
      }
    }
    await ensureUrlSecret(ctx, urlSecret(db), ownerRole(db), db, password);
  }
  void rootPassword;
}

/**
 * D-010: the hosted control plane's migration role (harness_admin), runtime role (harness_app)
 * and the NOLOGIN harness_zero the migrations name, plus P-013's dedicated audited reader
 * and the extensions harness_admin cannot create itself. The ops URL stays a separate
 * pinned reference; its accessor IAM and session admission are not granted here.
 */
async function ensureHostedRoles(ctx: Ctx): Promise<void> {
  const { admin, app, zero } = HOSTED_ROLES;
  const adminPassword = await ensureSecret(ctx, hostedPasswordSecret(admin), () => generatePassword());
  const appPassword = await ensureSecret(ctx, hostedPasswordSecret(app), () => generatePassword());
  const opsPassword = await ensureSecret(ctx, hostedPasswordSecret(HOSTED_OPS_ROLE), () => generatePassword());
  const sql = productionRoleSql({
    adminVerifier: scramSha256Verifier(adminPassword),
    appVerifier: scramSha256Verifier(appPassword),
    opsVerifier: scramSha256Verifier(opsPassword),
  });
  ctx.mutations.push(
    `execute-sql as postgres: create/alter roles ${admin}, ${app}, ${zero}, ${HOSTED_OPS_ROLE}; privileges and extensions on ${HOSTED_DATABASE}`,
  );
  if (!ctx.dryRun) {
    for (const [database, text] of [
      ['postgres', sql.inPostgres],
      [HOSTED_DATABASE, sql.inDatabase],
      [HOSTED_DATABASE, sql.extensions],
    ] as const) {
      const r = await executeSql(ctx, 'postgres', ROOT_SECRET, database, text);
      if (r.code !== 0) throw new Error(`hosted role bootstrap failed in ${database}: ${firstLine(r.stderr)}`);
    }
  }
  await ensureUrlSecret(ctx, hostedUrlSecret(admin), admin, HOSTED_DATABASE, adminPassword);
  await ensureUrlSecret(ctx, hostedUrlSecret(app), app, HOSTED_DATABASE, appPassword);
  await ensureUrlSecret(ctx, hostedUrlSecret(HOSTED_OPS_ROLE), HOSTED_OPS_ROLE, HOSTED_DATABASE, opsPassword);
}

async function ensureUrlSecret(ctx: Ctx, secret: string, role: string, db: string, password: string): Promise<void> {
  const { spec } = ctx;
  let ip = '<private-ip>';
  if (!ctx.dryRun) {
    const inst = await describe(ctx, ['sql', 'instances', 'describe', spec.instance, ...proj(ctx)]);
    ip = privateIp(inst ?? {});
  }
  await ensureSecret(ctx, secret, () => `postgresql://${role}:${encodeURIComponent(password)}@${ip}:5432/${db}?sslmode=require`);
}

// ── verification ─────────────────────────────────────────────────────────────

export interface VerifyReport {
  instanceDrift: string[];
  missingDatabases: string[];
  missingSecrets: string[];
  loginFailures: string[];
  /** Canonical pinned reference only. No URL value or IAM grant is returned. */
  opsUrlReference: string | null;
  secretReferenceFailures: string[];
}

/** Read metadata, never the URL value, to pin P-013's dedicated connection secret. */
export async function readHostedOpsUrlReference(ctx: Ctx): Promise<string> {
  const project = await describe(ctx, ['projects', 'describe', ctx.spec.project]);
  const projectNumber = String(project?.projectNumber ?? '');
  if (project?.projectId !== ctx.spec.project || !/^[1-9][0-9]*$/.test(projectNumber)) {
    throw new Error('hosted_ops_secret_project_identity_invalid');
  }
  const version = await describe(ctx, ['secrets', 'versions', 'describe', 'latest',
    `--secret=${hostedUrlSecret(HOSTED_OPS_ROLE)}`, `--location=${ctx.spec.region}`, ...proj(ctx)]);
  const resource = `projects/${projectNumber}/locations/${ctx.spec.region}/secrets/${hostedUrlSecret(HOSTED_OPS_ROLE)}/versions/`;
  const name = String(version?.name ?? '');
  if (version?.state !== 'ENABLED' || !name.startsWith(resource) || !/^[1-9][0-9]*$/.test(name.slice(resource.length))) {
    throw new Error('hosted_ops_secret_version_identity_invalid');
  }
  const reference = `${['gcp', 'secret'].join('-')}:${name}`;
  assertPinnedGcpSecretReference(reference);
  return reference;
}

/**
 * Owns the Data API window: login checks run inside it, and the instance is described for
 * drift only AFTER it closes. Describing inside the window always failed "Data API disallowed
 * at rest" — the third live `up` (2026-10-14) did exactly that on a conforming instance.
 */
export async function verify(ctx: Ctx, opts: { logins: boolean }): Promise<VerifyReport> {
  const { spec } = ctx;
  const describeInstance = () => describe(ctx, ['sql', 'instances', 'describe', spec.instance, ...proj(ctx)]);
  const report: VerifyReport = { instanceDrift: [], missingDatabases: [], missingSecrets: [], loginFailures: [], opsUrlReference: null, secretReferenceFailures: [] };
  if (!(await describeInstance())) {
    report.instanceDrift = ['instance does not exist'];
    return report;
  }
  if (opts.logins) report.loginFailures = await withDataApi(ctx, () => verifyLogins(ctx));
  const inst = await describeInstance();
  report.instanceDrift = inst ? instanceDrift(inst, spec) : ['instance does not exist'];
  if (!inst) return report;
  const dbs = JSON.parse(
    (await run(ctx, ['sql', 'databases', 'list', `--instance=${spec.instance}`, ...proj(ctx), '--format=json'])).stdout || '[]',
  ) as Array<{ name?: string }>;
  report.missingDatabases = spec.databases.filter((d) => !dbs.some((x) => x.name === d));
  const secrets = [
    ROOT_SECRET,
    ...spec.databases.flatMap((d) => [ownerPasswordSecret(d), urlSecret(d)]),
    ...[HOSTED_ROLES.admin, HOSTED_ROLES.app, HOSTED_OPS_ROLE].flatMap((r) => [hostedPasswordSecret(r), hostedUrlSecret(r)]),
  ];
  for (const s of secrets) {
    if (!(await describe(ctx, ['secrets', 'describe', s, `--location=${spec.region}`, ...proj(ctx)]))) report.missingSecrets.push(s);
  }
  if (!report.missingSecrets.includes(hostedUrlSecret(HOSTED_OPS_ROLE))) {
    try { report.opsUrlReference = await readHostedOpsUrlReference(ctx); }
    catch { report.secretReferenceFailures.push('harness_ops URL requires an enabled canonical pinned Secret Manager version'); }
  }
  return report;
}

/** What one login probe saw; ExecuteSql returns it as a single JSON cell. */
export interface LoginProbe {
  user?: unknown;
  db?: unknown;
  super?: unknown;
  createrole?: unknown;
  replication?: unknown;
  bypassrls?: unknown;
  cloudsqlsuperuser?: unknown;
  selfgrant?: unknown;
  createdb?: unknown;
  memberships?: unknown;
  databaseWrite?: unknown;
  directDataAccess?: unknown;
  unauditedFunctions?: unknown;
  readOnly?: unknown;
  transactionTimeout?: unknown;
  connectionLimit?: unknown;
}

// Only the two verified extension-owned statistics views are exempt from the
// customer-data ACL check. The real-PG suite proves their SQL text privacy.
export const LOGIN_PROBE_SQL =
  `SELECT json_build_object('user', current_user, 'db', current_database(), 'super', r.rolsuper, 'createrole', r.rolcreaterole, 'replication', r.rolreplication, 'bypassrls', r.rolbypassrls, 'cloudsqlsuperuser', pg_has_role(current_user, 'cloudsqlsuperuser', 'MEMBER'), 'selfgrant', current_setting('createrole_self_grant'),
    'createdb', r.rolcreatedb, 'memberships', EXISTS (SELECT 1 FROM pg_auth_members WHERE member = r.oid),
    'databaseWrite', has_database_privilege(current_user, current_database(), 'CREATE') OR has_database_privilege(current_user, current_database(), 'TEMPORARY'),
    'directDataAccess', EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')
      AND NOT (c.relkind = 'v' AND c.relname IN ('pg_stat_statements', 'pg_stat_statements_info') AND EXISTS (SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e' AND e.extname = 'pg_stat_statements'))
      AND (has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))),
    'unauditedFunctions', EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND NOT (n.nspname = 'papercusp_auth' AND p.proname = 'read_hosted_customer_export_rows_audited' AND oidvectortypes(p.proargtypes) = 'text, text, uuid, text, uuid') AND has_function_privilege(current_user, p.oid, 'EXECUTE')),
    'readOnly', current_setting('default_transaction_read_only'), 'transactionTimeout', current_setting('transaction_timeout'), 'connectionLimit', r.rolconnlimit)::text AS j FROM pg_roles r WHERE r.rolname = current_user`;

/**
 * Judge one login probe. The attributes upsertRoleSql cannot reset on an existing role
 * (superuser, replication, bypassrls) are checked here instead; `createRole` is what the role
 * should hold, and a CREATEROLE role must carry D-010's self-grant setting.
 */
export function judgeLogin(cell: LoginProbe, want: { role: string; db: string; createRole: boolean }): string[] {
  const failures: string[] = [];
  const seen = JSON.stringify(cell);
  if (cell.user !== want.role || cell.db !== want.db) failures.push(`${want.role}@${want.db}: unexpected identity ${seen}`);
  if (cell.super !== false || cell.replication !== false || cell.bypassrls !== false || cell.cloudsqlsuperuser !== false) {
    failures.push(`${want.role} is over-privileged: ${seen}`);
  }
  if (cell.createrole !== want.createRole) failures.push(`${want.role} has createrole=${String(cell.createrole)}, want ${want.createRole}`);
  if (want.createRole && cell.selfgrant !== 'set, inherit') {
    failures.push(`${want.role} has createrole_self_grant=${JSON.stringify(cell.selfgrant)}, want "set, inherit"`);
  }
  if (want.role === HOSTED_OPS_ROLE && (cell.createdb !== false || cell.memberships !== false || cell.databaseWrite !== false ||
      cell.directDataAccess !== false || cell.unauditedFunctions !== false || cell.readOnly !== 'on' ||
      cell.transactionTimeout !== '15min' || cell.connectionLimit !== 2)) {
    failures.push(`${want.role} is not restricted to audited read-only access: ${seen}`);
  }
  return failures;
}

/** Every login `verify --logins` exercises: the owners, then the hosted roles (D-010). */
export function loginTargets(spec: CloudSqlProdSpec): Array<{ role: string; from: string; db: string; createRole: boolean }> {
  const hosted = (role: string, createRole: boolean) => ({ role, from: hostedPasswordSecret(role), db: HOSTED_DATABASE, createRole });
  return [
    ...spec.databases.map((db) => ({ role: ownerRole(db), from: ownerPasswordSecret(db), db, createRole: false })),
    hosted(HOSTED_ROLES.admin, true),
    hosted(HOSTED_ROLES.app, false),
    hosted(HOSTED_OPS_ROLE, false),
  ];
}

/** Each role logs in to its own database, is not over-privileged, and is refused elsewhere. */
async function verifyLogins(ctx: Ctx): Promise<string[]> {
  const { spec } = ctx;
  const failures: string[] = [];
  for (const { role, from, db, createRole } of loginTargets(spec)) {
    const r = await executeSql(ctx, role, from, db, LOGIN_PROBE_SQL);
    const cell = jsonCells(r.stdout)[0];
    if (r.code !== 0 || !cell) {
      failures.push(`${role} cannot log in to ${db}: ${firstLine(r.stderr) || 'no result'}`);
      continue;
    }
    failures.push(...judgeLogin(cell, { role, db, createRole }));
    for (const other of spec.databases.filter((d) => d !== db)) {
      const x = await executeSql(ctx, role, from, other, 'SELECT 1');
      if (x.code === 0 && !/permission denied|not permitted|denied/i.test(x.stdout + x.stderr)) {
        failures.push(`${role} could connect to ${other} (CONNECT not restricted)`);
      }
    }
  }
  return failures;
}

function reportFailures(r: VerifyReport): string[] {
  return [
    ...r.instanceDrift.map((d) => `instance: ${d}`),
    ...r.missingDatabases.map((d) => `missing database: ${d}`),
    ...r.missingSecrets.map((s) => `missing secret: ${s}`),
    ...r.loginFailures.map((l) => `login: ${l}`),
    ...r.secretReferenceFailures.map((s) => `secret reference: ${s}`),
  ];
}

/** Run `fn` with the Data API allowed, always disallowing it again afterwards. */
async function withDataApi<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  await setDataApi(ctx, true);
  try {
    return await fn();
  } finally {
    await setDataApi(ctx, false);
  }
}

export async function up(ctx: Ctx): Promise<VerifyReport | null> {
  await ensureProject(ctx);
  await ensureServices(ctx);
  await ensureNetwork(ctx);
  await ensurePrivateServicesAccess(ctx);
  const rootPassword = await ensureSecret(ctx, ROOT_SECRET, () => generatePassword());
  await ensureInstance(ctx, rootPassword);
  await ensureDatabases(ctx);
  const bootstrapRoles = async () => {
    await ensureOwnerRoles(ctx, rootPassword);
    await ensureHostedRoles(ctx);
  };
  if (ctx.dryRun) {
    await setDataApi(ctx, true);
    await bootstrapRoles();
    await setDataApi(ctx, false);
    return null;
  }
  await withDataApi(ctx, bootstrapRoles);
  return verify(ctx, { logins: true });
}

// ── live TLS probe (SPEC-P-004) ──────────────────────────────────────────────
//
// `sslMode=ENCRYPTED_ONLY` read back by `verify` is a setting, not behaviour. This probe
// exercises the behaviour: a throwaway VM inside the production VPC (the instance has no
// public IP) connects twice with the same WRONG password, once with sslmode=disable and once
// with sslmode=require. TLS is the only variable. A server that accepted plaintext would
// answer both with "password authentication failed"; one that requires TLS refuses the
// plaintext attempt before authentication, so no credential could make it run a query.
// The TLS attempt reaching password authentication proves the server was reachable, so a
// network failure can never pass as a refusal. No real secret reaches the VM.

export const TLS_PROBE_VM = 'pc-cloud-prod-tls-probe';
export const TLS_PROBE_DB = 'portal';
/** No role has this password; the probe learns WHERE the server refuses, never logs in. */
export const TLS_PROBE_WRONG_PASSWORD = 'pcprobe-wrong-password';
export const TLS_PROBE_DONE = 'PCPROBE-DONE';
export const tlsProbeZone = (spec: CloudSqlProdSpec) => `${spec.region}-a`;

export function privateIp(inst: Record<string, unknown>): string {
  const addrs = (inst.ipAddresses as Array<{ type?: string; ipAddress?: string }> | undefined) ?? [];
  const ip = addrs.find((a) => a.type === 'PRIVATE')?.ipAddress ?? '';
  if (!ip) throw new Error('instance has no PRIVATE ip address');
  return ip;
}

/** Startup script for the probe VM; the metadata script runner copies its stdout to the serial console. */
export function tlsProbeStartupScript(ip: string, db: string, user: string): string {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`refusing a non-IPv4 probe target: ${ip}`);
  if (![db, user].every((n) => /^[a-z_][a-z0-9_]*$/.test(n))) throw new Error('unsafe probe database/user name');
  return [
    '#!/bin/bash',
    'export DEBIAN_FRONTEND=noninteractive',
    'apt-get update -qq >/dev/null 2>&1',
    'apt-get install -y -qq postgresql-client >/dev/null 2>&1',
    'probe() {',
    `  out=$(PGCONNECT_TIMEOUT=20 psql "host=${ip} port=5432 dbname=${db} user=${user} password=${TLS_PROBE_WRONG_PASSWORD} sslmode=$1" -Atc "select 1" 2>&1)`,
    '  rc=$?',
    '  echo "PCPROBE $1 rc=$rc msg=$(printf %s "$out" | tr "\\n" " " | cut -c1-400)"',
    '}',
    'probe disable',
    'probe require',
    `echo ${TLS_PROBE_DONE}`,
    '',
  ].join('\n');
}

export const TLS_PROBE_CREATE_CMD = ['compute', 'instances', 'create'] as const;

/**
 * e2-micro, no service account and no scopes (the VM calls no Google API), on the production
 * subnet. It keeps the default ephemeral external IP only so apt can fetch psql; the custom VPC
 * has no ingress rule, so nothing can connect to it. `^~^` switches gcloud's dict delimiter so
 * the script's commas survive.
 */
export function tlsProbeVmArgs(spec: CloudSqlProdSpec, script: string): string[] {
  if (script.includes('~')) throw new Error('probe script must not contain "~" (the --metadata delimiter)');
  return [
    ...TLS_PROBE_CREATE_CMD,
    TLS_PROBE_VM,
    `--zone=${tlsProbeZone(spec)}`,
    '--machine-type=e2-micro',
    '--image-family=debian-12',
    '--image-project=debian-cloud',
    `--network=${spec.network}`,
    `--subnet=${spec.subnet}`,
    '--no-service-account',
    '--no-scopes',
    '--shielded-secure-boot',
    labelArg({ ...spec.labels, 'papercusp-purpose': 'tls-probe' }),
    `--metadata=^~^startup-script=${script}`,
    `--project=${spec.project}`,
    '--quiet',
  ];
}

export interface TlsProbeAttempt {
  rc: number;
  msg: string;
}
export interface TlsProbeVerdict {
  ok: boolean;
  reasons: string[];
  plain?: TlsProbeAttempt;
  tls?: TlsProbeAttempt;
}

const AUTH_FAILED = /password authentication failed/i;

/** Judge the probe from the VM's serial console. Pure, so every failure mode is unit-tested. */
export function judgeTlsProbe(serial: string): TlsProbeVerdict {
  const attempt = (mode: string): TlsProbeAttempt | undefined => {
    const m = new RegExp(`PCPROBE ${mode} rc=(\\d+) msg=(.*)$`, 'm').exec(serial);
    return m ? { rc: Number(m[1]), msg: m[2]!.trim() } : undefined;
  };
  const plain = attempt('disable');
  const tls = attempt('require');
  const reasons: string[] = [];
  if (!plain) reasons.push('no sslmode=disable result on the serial console');
  else if (plain.rc === 0) reasons.push(`a plaintext connection ran a query: ${plain.msg}`);
  else if (AUTH_FAILED.test(plain.msg)) reasons.push(`a plaintext connection reached password authentication: ${plain.msg}`);
  else if (!/FATAL/.test(plain.msg)) reasons.push(`the plaintext attempt was not refused by the server, so it proves nothing: ${plain.msg}`);
  if (!tls) reasons.push('no sslmode=require result on the serial console');
  else if (!AUTH_FAILED.test(tls.msg)) reasons.push(`the TLS control did not reach password authentication, so the server was not shown reachable: ${tls.msg}`);
  return { ok: reasons.length === 0, reasons, plain, tls };
}

/** Create the probe VM, wait for its result, and ALWAYS delete it again. */
export async function probeTls(ctx: Ctx, opts: { attempts?: number; pollMs?: number } = {}): Promise<TlsProbeVerdict> {
  const { spec } = ctx;
  const inst = await describe(ctx, ['sql', 'instances', 'describe', spec.instance, ...proj(ctx)]);
  if (!inst) throw new Error('instance does not exist');
  const createArgs = tlsProbeVmArgs(spec, tlsProbeStartupScript(privateIp(inst), TLS_PROBE_DB, ownerRole(TLS_PROBE_DB)));
  await preflightFlags(ctx, TLS_PROBE_CREATE_CMD, createArgs);
  const vm = [TLS_PROBE_VM, `--zone=${tlsProbeZone(spec)}`, ...proj(ctx)];
  const deleteIfPresent = async () => {
    if (await describe(ctx, ['compute', 'instances', 'describe', ...vm])) await mutate(ctx, ['compute', 'instances', 'delete', ...vm]);
  };
  // A VM left by an interrupted run would replay a stale result; start clean.
  await deleteIfPresent();
  try {
    // Inside the try: a create that fails part-way can still leave a VM behind.
    await mutate(ctx, createArgs);
    const attempts = opts.attempts ?? 40;
    for (let i = 1; i <= attempts; i++) {
      const r = await callGcloud(ctx, ['compute', 'instances', 'get-serial-port-output', ...vm]);
      if (r.code === 0 && r.stdout.includes(TLS_PROBE_DONE)) return judgeTlsProbe(r.stdout);
      if (i < attempts) await ctx.sleep(opts.pollMs ?? 15_000);
    }
    return { ok: false, reasons: [`the probe VM printed no result after ${attempts} serial-console reads`] };
  } finally {
    await deleteIfPresent();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    spec: PROD_SPEC,
    gcloud: realGcloud,
    httpPut: realHttpPut,
    dryRun: false,
    mutations: [],
    log: (m) => process.stderr.write(`[cloud-sql] ${m}\n`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    ...overrides,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0] ?? 'plan';
  if (cmd === 'plan') {
    const ctx = makeCtx({ dryRun: true });
    await up(ctx);
    for (const m of ctx.mutations) process.stdout.write(`${m}\n`);
    process.stdout.write(`${ctx.mutations.length} planned step(s) for project ${ctx.spec.project}\n`);
    return 0;
  }
  if (cmd === 'up' || cmd === 'verify') {
    const ctx = makeCtx();
    const logins = cmd === 'up' || argv.includes('--logins');
    const report = cmd === 'up' ? await up(ctx) : await verify(ctx, { logins });
    for (const m of ctx.mutations) ctx.log(`did: ${m}`);
    const failures = report ? reportFailures(report) : [];
    if (failures.length) {
      for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
      return 1;
    }
    process.stdout.write(`OK ${ctx.spec.project}/${ctx.spec.instance} conforms (logins checked: ${logins})\n`);
    return 0;
  }
  if (cmd === 'probe-tls') {
    const ctx = makeCtx();
    const v = await probeTls(ctx);
    for (const m of ctx.mutations) ctx.log(`did: ${m.split('\n')[0]}`);
    process.stdout.write(`plaintext (sslmode=disable): rc=${v.plain?.rc ?? '-'} ${v.plain?.msg ?? '(no result)'}\n`);
    process.stdout.write(`TLS control (sslmode=require): rc=${v.tls?.rc ?? '-'} ${v.tls?.msg ?? '(no result)'}\n`);
    if (!v.ok) {
      for (const r of v.reasons) process.stdout.write(`FAIL ${r}\n`);
      return 1;
    }
    process.stdout.write(`OK ${ctx.spec.project}/${ctx.spec.instance} refuses non-TLS connections before authentication\n`);
    return 0;
  }
  if (cmd === 'status') {
    const ctx = makeCtx();
    const inst = await describe(ctx, ['sql', 'instances', 'describe', ctx.spec.instance, ...proj(ctx)]);
    process.stdout.write(
      inst
        ? `${ctx.spec.instance}: ${String(inst.state)} ${String(inst.databaseVersion)} ${JSON.stringify(inst.ipAddresses ?? [])}\n`
        : `${ctx.spec.instance}: absent\n`,
    );
    return 0;
  }
  process.stderr.write('usage: provision-cloud-sql.ts plan | up | verify [--logins] | probe-tls | status\n');
  return 2;
}

if (isCliEntry(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`[cloud-sql] ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
