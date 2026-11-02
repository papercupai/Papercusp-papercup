/**
 * Runtime identity for live evidence whose runtime is a REMOTE managed resource.
 *
 * `measureRuntimeVintageEnvironment` (runtime-vintage.ts) can only pin a LOCAL process: a
 * runtime-vintage ledger row on this host with a live pid and a kernel identity. A live proof
 * against a cloud resource (e.g. a Cloud SQL instance that refuses plaintext connections) has
 * no such process, so its binding could never carry an environment fingerprint and every
 * clause whose truth lives on a cloud resource read as not-current forever (WI-6554700010011907).
 *
 * A remote runtime unit names the resource; its identity is READ from the provider's control
 * plane at bind time AND again, independently, at evaluation time. The identity hashes what
 * the proof depends on: which resource (self link + creation time, so a delete-and-recreate is
 * a different runtime), what it runs (engine and maintenance version) and its configuration
 * generation (`settings.settingsVersion`, bumped by Cloud SQL on every settings change). Any
 * change to those makes bound proof stale; a failed or ambiguous read is `null` (unknown),
 * never a pass.
 *
 * Local-only unit lists keep EXACTLY the fingerprint `measureRuntimeVintageEnvironment`
 * produces, so existing bindings do not go stale when this layer is introduced.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinModuleState } from '@papercusp/module-singleton';
import { parse as parseToml } from '@iarna/toml';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from './runtime-vintage';
import { getPosthogConfigWithSource } from './posthog-config';
import { readProcessIdentity } from './process-identity';

/** Reads one control-plane document; resolves the raw stdout, or null on any failure. */
export type RemoteDescribe = (argv: readonly string[]) => Promise<string | null>;

interface RemoteRuntimeProvider {
  /** Unit prefix, including the trailing colon. */
  prefix: string;
  /** argv for the describe call, or null when the unit is malformed. */
  describeArgv(unit: string): readonly string[] | null;
  /** Identity tuple from the describe document, or null when it does not identify a usable runtime. */
  identity(unit: string, doc: Record<string, unknown>): readonly unknown[] | null;
  /** Optional provider-native reader; explicit and global test seams override it. */
  describe?: RemoteDescribe;
}

// Project ids: 6-30 chars, lowercase letter first. Instance ids: lowercase letter first.
// Anchored and letter-first so no unit can smuggle a gcloud flag into argv.
const GCP_CLOUDSQL_UNIT = /^gcp-cloudsql:([a-z][a-z0-9-]{4,28}[a-z0-9])\/([a-z][a-z0-9-]{0,97}[a-z0-9]|[a-z])$/;

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const gcpCloudSql: RemoteRuntimeProvider = {
  prefix: 'gcp-cloudsql:',
  describeArgv(unit) {
    const m = GCP_CLOUDSQL_UNIT.exec(unit);
    if (!m) return null;
    return ['sql', 'instances', 'describe', m[2]!, `--project=${m[1]}`, '--format=json', '--quiet'];
  },
  identity(unit, doc) {
    const m = GCP_CLOUDSQL_UNIT.exec(unit);
    if (!m || doc.name !== m[2] || doc.project !== m[1] || doc.state !== 'RUNNABLE') return null;
    const settings = doc.settings && typeof doc.settings === 'object' ? (doc.settings as Record<string, unknown>) : null;
    const createTime = str(doc.createTime);
    const settingsVersion = str(settings?.settingsVersion);
    const databaseVersion = str(doc.databaseVersion);
    if (!createTime || !settingsVersion || !databaseVersion) return null;
    return [str(doc.selfLink), createTime, databaseVersion, str(doc.maintenanceVersion), settingsVersion];
  },
};

const POSTHOG_PROJECT_UNIT = /^posthog-project:([a-z0-9][a-z0-9.-]{0,252}(?::[1-9]\d{0,4})?)\/([1-9]\d{0,11})$/;
// Only configuration that affects this evidence plane; no personal credentials,
// usage counters or mutable request timestamps enter the identity.
const POSTHOG_IDENTITY_FIELDS = ['timezone', 'event_retention_months', 'events_retention_enforced',
  'autocapture_opt_out', 'autocapture_exceptions_opt_in', 'session_recording_opt_in',
  'session_recording_retention_period', 'session_replay_config', 'person_processing_opt_out'] as const;
const posthogProject: RemoteRuntimeProvider = {
  prefix: 'posthog-project:',
  describeArgv(unit) {
    const match = POSTHOG_PROJECT_UNIT.exec(unit);
    return match ? ['posthog-project', match[1]!, match[2]!] : null;
  },
  async describe(argv) {
    const [, host, id] = argv;
    const config = getPosthogConfigWithSource().config;
    if (!config || !host || !id) return null;
    let base: URL;
    try { base = new URL(config.host); } catch { return null; }
    // A unit can only read the already-configured destination, not an arbitrary
    // HTTP target. Keys stay server-side and redirects cannot widen the target.
    if (base.host !== host || base.username || base.password || !['https:', 'http:'].includes(base.protocol)) return null;
    try {
      const [project, capture] = await Promise.all([
        fetch(`${base.origin}/api/projects/${id}/`, { headers: { authorization: `Bearer ${config.personalApiKey}` },
          redirect: 'error', signal: AbortSignal.timeout(10_000) }),
        fetch(`${base.origin}/batch/`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }),
      ]);
      if (!project.ok || capture.status !== 400) return null;
      const doc = await project.json() as Record<string, unknown>;
      if (doc.api_token !== config.projectKey) return null;
      const safe: Record<string, unknown> = { id: doc.id, uuid: doc.uuid ?? null, organization: doc.organization,
        created_at: doc.created_at, captureStatus: capture.status };
      for (const field of POSTHOG_IDENTITY_FIELDS) safe[field] = doc[field] ?? null;
      return JSON.stringify(safe);
    } catch { return null; }
  },
  identity(unit, doc) {
    const match = POSTHOG_PROJECT_UNIT.exec(unit);
    const createdAt = str(doc.created_at), organization = str(doc.organization);
    if (!match || String(doc.id) !== match[2] || !createdAt || !Number.isFinite(Date.parse(createdAt)) ||
      !organization || doc.captureStatus !== 400 || !Number.isSafeInteger(doc.event_retention_months) ||
      typeof doc.events_retention_enforced !== 'boolean') return null;
    return [doc.id, doc.uuid ?? null, organization, createdAt,
      POSTHOG_IDENTITY_FIELDS.map(field => [field, doc[field] ?? null])];
  },
};

// Cloudflare Pages (WI-6554700010015755): account ids are 32 lowercase hex; project names are
// 1-58 chars of [a-z0-9-] with no leading or trailing dash. Anchored, so a unit cannot widen the
// request path.
const CLOUDFLARE_PAGES_UNIT = /^cloudflare-pages:([0-9a-f]{32})\/([a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?)$/;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

/** Server-side Pages API token: the operator env first, then the host token file Pages deploys use. */
async function cloudflarePagesToken(): Promise<string | null> {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    return (await readFile(join(homedir(), '.cloudflare-pages-token'), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);

const cloudflarePages: RemoteRuntimeProvider = {
  prefix: 'cloudflare-pages:',
  describeArgv(unit) {
    const match = CLOUDFLARE_PAGES_UNIT.exec(unit);
    return match ? ['cloudflare-pages', match[1]!, match[2]!] : null;
  },
  async describe(argv) {
    const [, account, project] = argv;
    if (!account || !project) return null;
    const token = await cloudflarePagesToken();
    if (!token) return null;
    try {
      const res = await fetch(`${CLOUDFLARE_API}/accounts/${account}/pages/projects/${project}`, {
        headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const body = record(await res.json());
      const result = body?.success === true ? record(body.result) : null;
      const deployment = record(result?.canonical_deployment);
      if (!result || !deployment) return null;
      const stage = record(deployment.latest_stage);
      const metadata = record(record(deployment.deployment_trigger)?.metadata);
      // Only what identifies the serving production deployment; the token, commit messages and
      // per-request timestamps never enter the identity document.
      return JSON.stringify({ id: result.id ?? null, name: result.name ?? null, created_on: result.created_on ?? null,
        deployment: { id: deployment.id ?? null, created_on: deployment.created_on ?? null,
          environment: deployment.environment ?? null, commit_hash: metadata?.commit_hash ?? null,
          stage: stage?.name ?? null, status: stage?.status ?? null } });
    } catch {
      return null;
    }
  },
  identity(unit, doc) {
    const match = CLOUDFLARE_PAGES_UNIT.exec(unit);
    const deployment = record(doc.deployment);
    const projectId = str(doc.id), createdOn = str(doc.created_on);
    const deploymentId = str(deployment?.id), deployedOn = str(deployment?.created_on);
    if (!match || doc.name !== match[2] || !projectId || !createdOn || !deploymentId || !deployedOn ||
      deployment?.environment !== 'production' || deployment.stage !== 'deploy' || deployment.status !== 'success') {
      return null;
    }
    // A new production deployment (or a recreated project) is a different runtime: bound live
    // proof against the old one goes stale.
    return [projectId, createdOn, deploymentId, deployedOn, str(deployment.commit_hash)];
  },
};

// Workers have their own deployment/version control plane. A Pages deployment (or token
// file) cannot identify a serving Worker. Keep account/script selectors path-safe.
const CLOUDFLARE_WORKER_UNIT = /^cloudflare-worker:([0-9a-f]{32})\/([a-z0-9_][a-z0-9_-]{0,62})$/;
const CLOUDFLARE_VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const timestamp = (value: unknown): string | null => {
  const text = str(value);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
};

function workerCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(workerCanonical).join(',')}]`;
  const obj = record(value);
  return obj ? `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${workerCanonical(obj[key])}`).join(',')}}`
    : JSON.stringify(value);
}

/** Config values are hashed here, never returned in a reader document or logged. Only
 * provider set-like collections are reordered; arrays inside JSON bindings retain meaning. */
function workerConfigDigest(config: Record<string, unknown>): string {
  const normalized = { ...config };
  for (const key of ['bindings', 'compatibility_flags', 'tail_consumers']) {
    if (Array.isArray(normalized[key])) normalized[key] = normalized[key].map(workerCanonical).sort();
  }
  return sha256(workerCanonical(normalized));
}

/** Read only unexpired local OAuth state; Wrangler still owns refresh and other auth modes. */
async function freshWranglerOAuthToken(): Promise<string | null> {
  // Preserve Wrangler's environment precedence and its non-default auth configuration.
  if (['CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL'].some(key => process.env[key]) ||
      (process.env.WRANGLER_API_ENVIRONMENT && process.env.WRANGLER_API_ENVIRONMENT !== 'production') ||
      (process.env.WRANGLER_COMPLIANCE_REGION && process.env.WRANGLER_COMPLIANCE_REGION !== 'public')) return null;
  try {
    const home = homedir();
    const legacy = join(home, '.wrangler');
    const legacyDirectory = await stat(legacy).then(info => info.isDirectory(), error => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    });
    const configHome = process.env.XDG_CONFIG_HOME || (process.platform === 'darwin' ? join(home, 'Library', 'Preferences')
      : process.platform === 'win32' ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'xdg.config')
      : join(home, '.config'));
    if (!legacyDirectory && !isAbsolute(configHome)) return null;
    // Matches Wrangler 4's getGlobalWranglerConfigPath/getAuthConfigFilePath. Do not
    // try the XDG file when a legacy directory exists, even if its file is missing.
    const config = parseToml(await readFile(join(legacyDirectory ? legacy : join(configHome, '.wrangler'),
      'config', 'default.toml'), 'utf8'));
    const token = str(config.oauth_token)?.trim();
    const expiry = config.expiration_time;
    const expiresAt = expiry instanceof Date ? expiry.getTime() : typeof expiry === 'string' ? Date.parse(expiry) : NaN;
    return token && Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000 ? token : null;
  } catch { return null; }
}

async function cloudflareWorkerToken(): Promise<string | null> {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const localOAuth = await freshWranglerOAuthToken();
  if (localOAuth) return localOAuth;
  // Reuse Wrangler's supported credential loader, including refresh of its OAuth state.
  // --no-install forbids fetching a CLI; captured stdout/stderr never leave this function.
  try {
    const raw = await new Promise<string>((accept, reject) => execFile('npx',
      ['--no-install', 'wrangler', 'auth', 'token', '--json'],
      { timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
      (error, stdout) => error ? reject(error) : accept(stdout)));
    const credentials = record(JSON.parse(raw));
    return credentials && ['api_token', 'oauth'].includes(String(credentials.type)) ? str(credentials.token) : null;
  } catch { return null; }
}

function workerDeployment(doc: unknown): Record<string, unknown> | null {
  const deployments = record(doc)?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) return null;
  const rows = deployments.map(record);
  if (rows.some(row => !row || !timestamp(row.created_on) || !CLOUDFLARE_VERSION_ID.test(String(row.id)))) return null;
  rows.sort((a, b) => Date.parse(String(b!.created_on)) - Date.parse(String(a!.created_on)));
  const current = rows[0]!;
  // Equal timestamps for different deployments cannot establish a unique serving version.
  if (rows.some(row => row!.id !== current.id && Date.parse(String(row!.created_on)) === Date.parse(String(current.created_on)))) return null;
  const versions = current.versions;
  if (!Array.isArray(versions) || versions.length === 0 || versions.length > 10) return null;
  const weights = versions.map(record);
  if (weights.some(v => !v || !CLOUDFLARE_VERSION_ID.test(String(v.version_id)) ||
    typeof v.percentage !== 'number' || !Number.isFinite(v.percentage) || v.percentage <= 0 || v.percentage > 100) ||
    new Set(weights.map(v => v!.version_id)).size !== weights.length ||
    Math.abs(weights.reduce((sum, v) => sum + Number(v!.percentage), 0) - 100) > 0.000001) return null;
  return { id: current.id, created_on: current.created_on,
    versions: weights.map(v => ({ version_id: v!.version_id, percentage: v!.percentage }))
      .sort((a, b) => String(a.version_id).localeCompare(String(b.version_id))) };
}

const cloudflareWorker: RemoteRuntimeProvider = {
  prefix: 'cloudflare-worker:',
  describeArgv(unit) {
    const match = CLOUDFLARE_WORKER_UNIT.exec(unit);
    return match ? ['cloudflare-worker', match[1]!, match[2]!] : null;
  },
  async describe(argv) {
    const [, account, script] = argv;
    const token = await cloudflareWorkerToken();
    if (!token || !account || !script) return null;
    const base = `${CLOUDFLARE_API}/accounts/${account}/workers/scripts/${script}`;
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` },
        redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Worker identity read failed');
      const body = record(await response.json());
      if (body?.success !== true || body.result == null) throw new Error('Worker identity unavailable');
      return body.result;
    };
    try {
      const [deploymentDoc, settingsDoc] = await Promise.all([get('/deployments'), get('/settings')]);
      const deployment = workerDeployment(deploymentDoc);
      const settings = record(settingsDoc);
      if (!deployment || !settings || !Array.isArray(settings.bindings)) return null;
      const settingsDigest = workerConfigDigest(settings);
      const versions = await Promise.all((deployment.versions as Array<{ version_id: string }>).map(async weight => {
        const version = record(await get(`/versions/${weight.version_id}`));
        const resources = record(version?.resources), metadata = record(version?.metadata);
        const scriptData = record(resources?.script), runtime = record(resources?.script_runtime);
        if (version?.id !== weight.version_id || !timestamp(metadata?.created_on) || !str(scriptData?.etag) ||
          !runtime || !str(runtime.compatibility_date) || !Array.isArray(resources?.bindings)) return null;
        return { id: version.id, created_on: metadata!.created_on, script_etag: scriptData!.etag,
          configDigest: workerConfigDigest({ ...runtime, bindings: resources!.bindings }) };
      }));
      if (versions.some(version => !version)) return null;
      // Re-read both mutable surfaces: a deploy or settings change during the measurement
      // makes it unknown, rather than constructing an identity that never served.
      const [afterDoc, settingsAfterDoc] = await Promise.all([get('/deployments'), get('/settings')]);
      const after = workerDeployment(afterDoc);
      const settingsAfter = record(settingsAfterDoc);
      if (!after || !settingsAfter || workerCanonical(after) !== workerCanonical(deployment) ||
        workerConfigDigest(settingsAfter) !== settingsDigest) return null;
      return JSON.stringify({ account, script, deployment, versions, settingsDigest });
    } catch { return null; }
  },
  identity(unit, doc) {
    const match = CLOUDFLARE_WORKER_UNIT.exec(unit);
    const deployment = workerDeployment({ deployments: [doc.deployment] });
    if (!match || doc.account !== match[1] || doc.script !== match[2] || !deployment ||
      !/^[a-f0-9]{64}$/.test(String(doc.settingsDigest)) || !Array.isArray(doc.versions)) return null;
    const versions = doc.versions.map(record);
    const weights = deployment.versions as Array<{ version_id: string }>;
    if (versions.length !== weights.length || new Set(versions.map(v => v?.id)).size !== versions.length ||
      versions.some(v => !v || !weights.some(w => w.version_id === v.id) || !timestamp(v.created_on) ||
        !str(v.script_etag) || !/^[a-f0-9]{64}$/.test(String(v.configDigest)))) return null;
    return [deployment, doc.settingsDigest, versions.map(v => [v!.id, v!.created_on, v!.script_etag, v!.configDigest])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))];
  },
};

// Reuse the external-runtime evaluator for the separately managed local daemon.
// Its own read-only socket answer supplies boot-captured source/compiler bytes;
// systemd selects the process and the kernel independently verifies its lifetime.
const focusedTsc: RemoteRuntimeProvider = {
  prefix: 'focused-tsc:',
  describeArgv: unit => unit === 'focused-tsc:installed' ? ['focused-tsc', 'installed'] : null,
  async describe() {
    try {
      const properties = await new Promise<string>((accept, reject) => execFile('systemctl',
        ['--user', 'show', 'papercup-tsc-service.service', '-p', 'WorkingDirectory', '-p', 'MainPID'],
        { timeout: 2_000, maxBuffer: 16_384 }, (error, stdout) => error ? reject(error) : accept(stdout)));
      const fields = Object.fromEntries(properties.trim().split('\n').map(line => {
        const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
      }));
      const root = fields.WorkingDirectory, pid = Number(fields.MainPID);
      if (!root || !isAbsolute(root) || !Number.isSafeInteger(pid) || pid < 1) return null;
      const processIdentity = readProcessIdentity(pid);
      if (!processIdentity) return null;
      const service = await import(pathToFileURL(resolve(root, 'scripts/lib/tsc-service.mjs')).href);
      const request = { operation: 'identity', root, project: resolve(root, 'packages/operator-core/tsconfig.json'),
        files: ['scripts/tsc-service/server.mjs'], scope: 'named' };
      const result = await service.requestTscService({ socketPath: service.tscServiceSocketPath(), request, timeoutMs: 2_000 });
      if (!result.ok || result.identityOnly !== true || result.runtime?.pid !== pid
        || readProcessIdentity(pid) !== processIdentity) return null;
      return JSON.stringify({ identity: result.identity, runtime: result.runtime, processIdentity });
    } catch { return null; }
  },
  identity(_unit, doc) {
    const identity = record(doc.identity), runtime = record(doc.runtime);
    const pid = runtime?.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) < 1 || !Number.isFinite(runtime?.startedAt)
      || Number(runtime?.startedAt) <= 0 || typeof doc.processIdentity !== 'string'
      || readProcessIdentity(Number(pid)) !== doc.processIdentity
      || !identity || typeof identity.root !== 'string' || !isAbsolute(identity.root)
      || !/^[a-f0-9]{64}$/.test(String(identity.serviceSourceSha256))
      || !/^[a-f0-9]{64}$/.test(String(identity.compilerArtifactsSha256))
      || !/^[a-f0-9]{64}$/.test(String(identity.projectConfigSha256))
      || !str(identity.compilerVersion) || !str(identity.compilerInstall)
      || !Array.isArray(identity.namedSources) || identity.namedSources.length !== 1
      || record(identity.namedSources[0])?.path !== 'scripts/tsc-service/server.mjs'
      || !/^[a-f0-9]{64}$/.test(String(record(identity.namedSources[0])?.sha256))) return null;
    return [identity, pid, runtime?.startedAt, doc.processIdentity];
  },
};

const PROVIDERS: readonly RemoteRuntimeProvider[] = [gcpCloudSql, posthogProject, cloudflarePages, cloudflareWorker, focusedTsc];

function providerFor(unit: string): RemoteRuntimeProvider | undefined {
  return PROVIDERS.find((provider) => unit.startsWith(provider.prefix));
}

/** True when the unit names a remote managed resource rather than a local runtime-vintage unit. */
export function isRemoteRuntimeUnit(unit: string): boolean {
  return providerFor(unit) !== undefined;
}

const DESCRIBE_TIMEOUT_MS = 30_000;

/** Default describe: the operator host's own gcloud credentials, bounded. */
export const gcloudDescribe: RemoteDescribe = (argv) =>
  new Promise((resolve) => {
    execFile('gcloud', [...argv], { timeout: DESCRIBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });

const state = pinModuleState('@papercusp/operator-core.remote-runtime-identity', () => ({
  describe: null as RemoteDescribe | null,
}));

/** Test seam: replace the control-plane reader for every caller (e.g. a fake gcloud). */
export function configureRemoteRuntimeDescribe(describe: RemoteDescribe): void {
  state.describe = describe;
}

export function resetRemoteRuntimeDescribe(): void {
  state.describe = null;
}

/** Identity digest of one remote runtime unit, or null when it cannot be established now. */
export async function measureRemoteRuntimeIdentity(
  unit: string,
  describe?: RemoteDescribe,
): Promise<string | null> {
  const provider = providerFor(unit);
  const argv = provider?.describeArgv(unit);
  if (!provider || !argv) return null;
  let raw: string | null;
  try { raw = await (describe ?? state.describe ?? provider.describe ?? gcloudDescribe)(argv); } catch { return null; }
  if (!raw) return null;
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const identity = provider.identity(unit, doc as Record<string, unknown>);
  if (!identity) return null;
  return createHash('sha256').update(JSON.stringify([`${provider.prefix}v1`, unit, ...identity])).digest('hex');
}

export interface RuntimeEnvironmentDeps {
  describe?: RemoteDescribe;
  /** Per-evaluation memo so a batch re-reads each remote resource once. */
  memo?: Map<string, Promise<string | null>>;
}

/**
 * Environment fingerprint for a binding's named runtime units, local and remote.
 * Local-only lists return `measureRuntimeVintageEnvironment` unchanged; any remote unit
 * folds its control-plane identity in, and any unit that cannot be established is null.
 */
export async function measureRuntimeEnvironment(
  rows: readonly RuntimeVintageRow[],
  units: readonly string[],
  deps: RuntimeEnvironmentDeps = {},
): Promise<string | null> {
  if (units.length === 0 || units.length > 32 || new Set(units).size !== units.length) return null;
  const remote = units.filter(isRemoteRuntimeUnit).sort();
  if (remote.length === 0) return measureRuntimeVintageEnvironment(rows, units);
  const local = units.filter((unit) => !isRemoteRuntimeUnit(unit));
  const localFingerprint = local.length > 0 ? measureRuntimeVintageEnvironment(rows, local) : null;
  if (local.length > 0 && localFingerprint === null) return null;
  const describe = deps.describe ?? state.describe ?? undefined;
  const identities = await Promise.all(remote.map((unit) => {
    const cached = deps.memo?.get(unit);
    if (cached) return cached;
    const measured = measureRemoteRuntimeIdentity(unit, describe);
    deps.memo?.set(unit, measured);
    return measured;
  }));
  if (identities.some((identity) => identity === null)) return null;
  return createHash('sha256')
    .update(JSON.stringify(['runtime-environment-v2', localFingerprint, remote.map((unit, i) => [unit, identities[i]])]))
    .digest('hex');
}
