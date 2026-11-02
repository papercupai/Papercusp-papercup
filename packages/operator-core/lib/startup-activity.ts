/** Concrete device observations over the existing schedule inventory; no service mutations. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getOrgPg } from '@papercusp/db-org';
import type { Sql, TransactionSql } from 'postgres';
import { activeWorkspaceId } from './workspace-registry';
import { readOperatorState } from './operator-state-pg';
import { z } from 'zod';
import {
  collectStartupActivity,
  STARTUP_ACTIVITY_ENTRYPOINTS,
  startupHistorySchema,
  startupPolicySchema,
  type ScheduleInventoryDeps,
  type StartupActivityAdapters,
  type StartupActivityFeature,
  type StartupCensusDisposition,
  type StartupActivityHistoryEntry,
  type StartupActivityPolicy,
} from './schedule-inventory';

type NativeProbe = (command: string, args: readonly string[]) => Promise<string>;
const probe: NativeProbe = (command, args) => new Promise((resolve, reject) => {
  execFile(command, [...args], { timeout: 3_000, maxBuffer: 16_384, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(new Error('Native startup observation unavailable'));
    else resolve(stdout);
  });
});

const opaque = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const linuxEntrypoints = ['linux-user-service', 'linux-package-install'];
const macEntrypoints = ['mac-boot-install', 'mac-service-template', 'mac-current-service-template'];

const historyRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const historyAction = 'background-activity';
const validFeatureId = /^activity-[a-f0-9]{64}$/;
const persistedHistorySchema = startupHistorySchema.extend({
  featureId: startupHistorySchema.shape.featureId.regex(validFeatureId),
  actor: startupHistorySchema.shape.actor.regex(/^(user|system):[a-f0-9]{64}$/),
  trigger: startupHistorySchema.shape.trigger.regex(/^(manual|login|boot|timer|event|supervisor|upgrade|repair|settings|pause-expiry)$/),
  source: startupHistorySchema.shape.source.unwrap(),
  reason: startupHistorySchema.shape.reason.unwrap(),
});

/** Extend the existing pause row, rather than introducing a second preference store. */
export const savedBackgroundActivitySchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  automatic: z.boolean(),
  pausedUntil: z.string().datetime({ offset: true }).nullable(),
  features: z.record(z.string().regex(validFeatureId), startupPolicySchema.passthrough()).default({}),
}).passthrough();

export const savedStartupActivityStateSchema = z.object({
  paused: z.boolean().optional(),
  backgroundActivity: savedBackgroundActivitySchema.optional(),
}).passthrough();

/** Expiry is evaluated at admission/read time, including the first read after an offline restart. */
export function startupPauseIsActive(paused: boolean | undefined, until: string | null, now = Date.now()): boolean {
  return until !== null ? Date.parse(until) > now : paused === true;
}

/** Project saved preference only: this read never asserts that dispatch obeyed it. */
export function savedStartupActivityPolicy(feature: Readonly<StartupActivityFeature>, state: unknown, workspace: string, now = Date.now()): StartupActivityPolicy {
  if (feature.scope.kind === 'device') return { ...feature.desired };
  if (feature.scope.kind !== 'workspace') return { ...feature.desired };
  if (!workspace.trim() || feature.scope.id !== workspace) throw new Error('Startup policy scope unavailable');
  const row = savedStartupActivityStateSchema.parse(state ?? {});
  const saved = row.backgroundActivity;
  const override = saved?.features[feature.id];
  const workspacePause = startupPauseIsActive(row.paused, saved?.pausedUntil ?? null, now);
  const featurePause = startupPauseIsActive(override?.paused, override?.pausedUntil ?? null, now);
  const deadlines = [workspacePause ? saved?.pausedUntil ?? null : undefined,
    featurePause ? override?.pausedUntil ?? null : undefined].filter(deadline => deadline !== undefined);
  const pausedUntil = deadlines.includes(null) ? null
    : deadlines.length ? deadlines.reduce((latest, deadline) => Date.parse(deadline!) > Date.parse(latest!) ? deadline : latest)! : null;
  return {
    automatic: saved?.automatic === false ? false : override?.automatic ?? feature.desired.automatic,
    paused: workspacePause || featurePause,
    pausedUntil,
    revision: saved?.revision ?? null,
  };
}

/** Extend existing audit records; strip undeclared fields before they reach storage. */
export async function recordStartupActivityHistory(
  entry: StartupActivityHistoryEntry,
  actorIdentity: string,
  actorKind: 'user' | 'system' = 'user',
  transaction?: { sql: Sql | TransactionSql; workspaceId: string },
): Promise<void> {
  if (!actorIdentity.trim()) throw new Error('Startup history requires actor identity');
  const safe = persistedHistorySchema.parse({ ...entry, actor: `${actorKind}:${opaque([actorIdentity])}` });
  if (safe.operation === 'policy-change' && (!safe.previous || !safe.resulting
    || safe.resulting.revision === null || safe.resulting.revision <= (safe.previous.revision ?? -1)))
    throw new Error('Policy history requires previous and resulting revisions');
  const sql = transaction?.sql ?? getOrgPg().sql;
  const workspace = transaction?.workspaceId ?? activeWorkspaceId();
  if (!workspace.trim() || workspace === '*') throw new Error('Startup history requires workspace identity');
  await sql`
    INSERT INTO harness_shared.audit_log (id, ts, actor, action, subject, details, workspace_id)
    VALUES (${randomUUID()}, ${new Date(safe.at).getTime()}, ${safe.actor}, ${historyAction}, ${safe.featureId},
      ${JSON.stringify({ startupActivity: safe })}::text::jsonb, ${workspace})`;
}

/** Trusted in-process workspace scope plus opaque feature identity; no caller-supplied workspace. */
export async function readStartupActivityHistory(featureIds: readonly string[], limit = 100): Promise<StartupActivityHistoryEntry[]> {
  const workspace = activeWorkspaceId();
  if (!workspace.trim()) throw new Error('Startup history requires workspace identity');
  if (featureIds.some(id => !validFeatureId.test(id))) throw new Error('Invalid startup feature identity');
  if (!featureIds.length) return [];
  const bound = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.floor(limit))) : 100;
  const { sql } = getOrgPg();
  const rows = await sql<{ entry: unknown }[]>`
    SELECT details->'startupActivity' AS entry FROM harness_shared.audit_log
    WHERE workspace_id = ${workspace} AND action = ${historyAction}
      AND subject = ANY(${[...new Set(featureIds)]})
      AND ts >= ${Date.now() - historyRetentionMs} AND ts <= ${Date.now()}
    ORDER BY ts DESC, id DESC LIMIT ${bound}`;
  return rows.map(row => {
    const parsed = persistedHistorySchema.safeParse(row.entry);
    if (!parsed.success || !featureIds.includes(parsed.data.featureId)) throw new Error('Startup history record unavailable');
    return parsed.data;
  });
}

/** Query only this process's OS user; never accept a target account or a shell command. */
export async function readNativeStartupActivity(options: {
  platform?: NodeJS.Platform;
  deviceId?: string;
  uid?: number;
  probe?: NativeProbe;
} = {}): Promise<{ features: StartupActivityFeature[]; unavailable: string[] }> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? userInfo().uid;
  const deviceId = options.deviceId ?? `device-${opaque([hostname(), uid, userInfo().username])}`;
  const run = options.probe ?? probe;
  const unavailable: string[] = [];
  const base = (key: string, name: string, purpose: string, trigger: string, entrypointIds: string[]): StartupActivityFeature => ({
    id: `activity-${opaque([deviceId, key])}`, name, purpose, trigger, entrypointIds,
    origin: 'native', scope: { kind: 'device', id: deviceId }, dependencies: null,
    desired: { automatic: null, pausedUntil: null, revision: null }, observed: 'unknown',
    // Starting the service is local; its child features disclose their own network/spend.
    network: 'local', spend: 'none', resources: { cpuUsec: null, rssBytes: null, costCents: null },
  });
  const server = base('server', 'Papercusp server', 'Runs local Papercusp services and makes background features available.',
    'OS user service start', ['native-server', ...(platform === 'linux' ? linuxEntrypoints : [])]);
  const login = base('login', 'Start at sign-in', 'Starts Papercusp for this OS user when they sign in.',
    'OS user sign-in', ['native-login']);
  const boot = base('boot', 'Start before sign-in', 'Makes the installed Papercusp service available before sign-in.',
    'Device boot', platform === 'linux' ? ['linux-boot-opt-in'] : platform === 'darwin' ? macEntrypoints : []);
  login.dependencies = [server.id];
  boot.dependencies = [server.id];
  if (platform !== 'linux') {
    // The native desktop must supply plugin/OS readback. A backend process is
    // insufficient evidence of either a login registration or a boot service.
    unavailable.push('native-registration', 'native-service', 'native-boot');
    return { features: [server, login, boot], unavailable };
  }
  let enabled: boolean | null = null;
  await Promise.all([
    (async () => {
      try {
        const output = await run('systemctl', ['--user', 'show', 'papercusp-server.service', '--no-pager',
          '--property=LoadState,UnitFileState,ActiveState,CPUUsageNSec']);
        const values = new Map(output.trim().split('\n').map(line => {
          const split = line.indexOf('=');
          return [line.slice(0, split), line.slice(split + 1)];
        }));
        const load = values.get('LoadState');
        const unitFile = values.get('UnitFileState');
        if (load === 'not-found') enabled = false;
        else if (load === 'loaded') {
          if (unitFile === 'enabled') enabled = true;
          else if (['disabled', 'masked', 'masked-runtime'].includes(unitFile ?? '')) enabled = false;
        }
        if (enabled === null) unavailable.push('native-registration');
        const active = values.get('ActiveState');
        server.observed = active === 'active' ? 'running'
          : active === 'inactive' || active === 'failed' ? 'idle' : 'unknown';
        if (server.observed === 'unknown') unavailable.push('native-service');
        const measurement = (key: string): number | null => {
          const raw = values.get(key);
          if (!raw || !/^\d+$/.test(raw)) return null;
          const value = Number(raw);
          return Number.isSafeInteger(value) ? value : null;
        };
        // systemd's max uint64 is an unavailable sentinel, not a resource sample.
        const cpuNsec = measurement('CPUUsageNSec');
        server.resources.cpuUsec = cpuNsec === null ? null : cpuNsec / 1_000;
        // MemoryCurrent includes page cache and is not RSS; leave RSS unmeasured.
      } catch { unavailable.push('native-registration', 'native-service'); }
      login.desired.automatic = enabled;
    })(),
    (async () => {
      try {
        const linger = (await run('loginctl', ['show-user', String(uid), '--property=Linger', '--value'])).trim();
        if (linger === 'yes' || linger === 'no') return linger === 'yes';
      } catch { /* Report only the failed source, never process stderr or arguments. */ }
      unavailable.push('native-boot');
      return null;
    })().then(linger => {
      // Save this independent observation until both probes finish below.
      boot.desired.automatic = linger;
    }),
  ]);
  const linger = boot.desired.automatic;
  boot.desired.automatic = enabled === false || linger === false ? false
    : enabled === true && linger === true ? true : null;
  // A boot/login registration never measures a running invocation of its own.
  return { features: [server, login, boot], unavailable: [...new Set(unavailable)].sort() };
}

/** Link actual writers; absent dynamic registrations remain explicit gaps. */
export function startupActivityCensus(features: readonly StartupActivityFeature[], platform = process.platform): StartupCensusDisposition[] {
  return STARTUP_ACTIVITY_ENTRYPOINTS.flatMap((entry): StartupCensusDisposition[] => {
    if ('notApplicableReason' in entry) return []; // The central collector already owns these dispositions.
    if ((entry.id.startsWith('linux-') && platform !== 'linux') || (entry.id.startsWith('mac-') && platform !== 'darwin'))
      return [{ id: entry.id, kind: 'not-applicable', reason: `This registration writer targets ${entry.id.startsWith('linux-') ? 'Linux' : 'macOS'}; this device runs ${platform === 'linux' ? 'Linux' : platform}.` }];
    const featureIds = features.filter(feature => feature.entrypointIds.includes(entry.id)).map(feature => feature.id);
    return featureIds.length ? [{ id: entry.id, kind: 'checked', featureIds }] : [];
  });
}

/** Production entrypoint for settings/tools; policy/history use their lifecycle adapters. */
export async function collectCurrentStartupActivity(deps: Partial<ScheduleInventoryDeps> = {}, adapters: StartupActivityAdapters = {}) {
  const native = adapters.native ? null : await readNativeStartupActivity();
  // Read lazily and once per snapshot. A failed read stays rejected for every
  // workspace row; device observations do not depend on a database being online.
  let saved: Promise<unknown> | undefined;
  const policy = adapters.policy ?? (async (feature: Readonly<StartupActivityFeature>) => {
    const workspace = activeWorkspaceId();
    const row = feature.scope.kind === 'workspace'
      ? await (saved ??= readOperatorState('operator_paused', workspace, { fresh: true })) : null;
    return savedStartupActivityPolicy(feature, row, workspace);
  });
  const snapshot = await collectStartupActivity(deps, {
    ...adapters,
    deviceId: adapters.deviceId ?? native?.features[0]?.scope.id ?? undefined,
    native: adapters.native ?? (async () => native!.features),
    census: adapters.census ?? (async features => startupActivityCensus(features)),
    history: adapters.history ?? readStartupActivityHistory,
    policy,
  });
  snapshot.unavailable = [...new Set([...snapshot.unavailable, ...(native?.unavailable ?? [])])].sort();
  return snapshot;
}
