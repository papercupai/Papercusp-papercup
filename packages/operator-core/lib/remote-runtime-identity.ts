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
import { pinModuleState } from '@papercusp/module-singleton';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from './runtime-vintage';
import { getPosthogConfigWithSource } from './posthog-config';

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

const PROVIDERS: readonly RemoteRuntimeProvider[] = [gcpCloudSql, posthogProject];

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
