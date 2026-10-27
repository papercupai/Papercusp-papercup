/** P019: deterministic measurements over recorded provider exposures and activity.
 * Extends the push outcomes plane; this module never turns missing telemetry into
 * a negative, or server placement into a client receipt. Collection/registration
 * remains a separate caller responsibility.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { wilsonInterval } from '@papercusp/bench-metrics';
import { canonicalPushActivityTool, pushActivityRepoPath, shellSearchPatterns } from './native-adoption';
import { collectReuseSourcePopulation, decodeReuseCallColumns, serializeReuseCallColumns,
  summarizeReuseCallColumns, REUSE_CALL_COLUMNS, REUSE_PARENT_OLD_SPACE_MB } from './reuse-source-population';
export { buildReuseSourcePopulation, collectReuseSourcePopulation } from './reuse-source-population';

export const REUSE_OBSERVATION_MS = 30 * 60_000;
export const REUSE_OBSERVATION_INVOCATIONS = 20;
export const REUSE_EFFICACY_HORIZON_MS = 28 * 86_400_000;
export const REUSE_EFFICACY_MATURITY_MS = 14 * 86_400_000;
export const REUSE_MEASUREMENT_INSTRUMENT_KEYS = {
  redundancy: 'code-intel:reuse-redundancy-per-1000-lines',
  searchBeforeWrite: 'code-intel:reuse-search-before-write',
  crossFileCalls: 'code-intel:reuse-cross-file-call-ratio',
  providerOutcomes: 'code-intel:reuse-provider-outcomes',
} as const;
export type ReuseMetric = keyof typeof REUSE_MEASUREMENT_INSTRUMENT_KEYS;

/** Hash the eligible work-item, not its invocation: retries stay in the same arm. */
export function reuseHoldout(workItem: string, provider: string): boolean {
  if (!workItem.trim() || !provider.trim()) throw new Error('Exact work-item and provider required');
  const hash = createHash('sha256').update(`reuse-provider-holdout-v1\0${provider}\0${workItem}`).digest('hex');
  return Number.parseInt(hash.slice(0, 8), 16) % 10 === 0;
}

export interface ReuseMeasurementExposure {
  id: string;
  workspaceId: string;
  owner: string;
  invocation: string;
  workItem: string;
  provider: string;
  at: string;
  issued: boolean;
  /** Only an independently captured client receipt can set this true. */
  clientReceipt: { ref: string; observedAt: string } | null;
  selector: { paths: string[]; symbols: string[] };
}
export interface ReuseMeasurementActivity {
  id: string;
  workspaceId: string;
  owner: string;
  at: string;
  tool: string;
  status: string | null;
  detail: Record<string, unknown> | null;
  harness?: string | null;
  truncated?: boolean;
}
export interface ReuseMeasuredWindow {
  exposure: ReuseMeasurementExposure;
  holdout: boolean;
  start: string;
  end: string;
  endedBy: 'invocations' | 'time' | 'open';
  complete: boolean;
  issued: boolean;
  delivered: boolean | null;
  actedOn: boolean | null;
  grepAfterPush: boolean | null;
  activityIds: string[];
}

const time = (value: string): number => {
  const n = Date.parse(value);
  if (!Number.isFinite(n)) throw new Error('Valid recorded timestamp required');
  return n;
};
const fileTools = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'mcp__papercusp-su__capability_read',
  'mcp__papercusp-su__capability_edit', 'mcp__papercusp-su__capability_write']);
const grepTools = new Set(['Grep', 'mcp__papercusp-su__capability_grep']);
const shellTools = new Set(['Bash', 'exec_command', 'mcp__papercusp-su__capability_bash']);

/** An explicit complete activity census is necessary for either negative.
 * A later positive still qualifies when another activity in the window is opaque.
 */
export function measureReuseWindow(input: {
  exposure: ReuseMeasurementExposure;
  activities: readonly ReuseMeasurementActivity[];
  now: string;
  activityCensusComplete: boolean;
  repoRoots?: ReadonlyMap<string, string>;
}): ReuseMeasuredWindow {
  const e = input.exposure, start = time(e.at), now = time(input.now);
  if (!e.id || !e.workspaceId || !e.owner || !e.invocation) throw new Error('Recorded exposure identity required');
  if (now < start) throw new Error('Observation cannot precede exposure');
  const holdout = reuseHoldout(e.workItem, e.provider);
  if (holdout && e.issued) throw new Error('A held-out exposure cannot be issued');
  const unique = new Map<string, ReuseMeasurementActivity>();
  for (const a of input.activities) {
    const at = time(a.at);
    if (a.workspaceId !== e.workspaceId || a.owner !== e.owner || at <= start || at > Math.min(now, start + REUSE_OBSERVATION_MS)) continue;
    if (!a.id) throw new Error('Recorded activity id required');
    const prior = unique.get(a.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(a)) throw new Error('Conflicting activity identity');
    unique.set(a.id, a);
  }
  const sorted = [...unique.values()].sort((a, b) => time(a.at) - time(b.at)
    || (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)
      ? (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0) : a.id.localeCompare(b.id)));
  const activities = sorted.slice(0, REUSE_OBSERVATION_INVOCATIONS);
  const endedBy = activities.length === REUSE_OBSERVATION_INVOCATIONS ? 'invocations'
    : now >= start + REUSE_OBSERVATION_MS ? 'time' : 'open';
  const end = endedBy === 'invocations' ? time(activities.at(-1)!.at) : Math.min(now, start + REUSE_OBSERVATION_MS);
  const paths = new Set(e.selector.paths), symbols = new Set(e.selector.symbols);
  let acted = false, grep = false, opaque = false;
  for (const a of activities) {
    if (a.truncated) { opaque = true; continue; }
    if (a.status !== 'ok') { if (a.status === null) opaque = true; continue; }
    const tool = canonicalPushActivityTool(a.tool), detail = a.detail;
    if (!detail) { opaque = true; continue; }
    if (fileTools.has(tool)) {
      const path = pushActivityRepoPath(detail, a.harness, input.repoRoots);
      if (path === null) opaque = true;
      else acted ||= paths.has(path);
    } else if (grepTools.has(tool)) {
      if (typeof detail.pattern !== 'string' || detail.pattern.length >= 500) opaque = true;
      else if (symbols.has(detail.pattern) || paths.has(detail.pattern)) grep = true;
      else if (!/^[\w./-]+$/.test(detail.pattern)) opaque = true;
    } else if (shellTools.has(tool)) {
      const command = detail.command ?? detail.cmd;
      if (typeof command !== 'string' || command.length >= 4_000) opaque = true;
      else {
        const patterns = shellSearchPatterns(command);
        // Complex regexes are observable searches, but not evidence of a negative
        // for a particular provider selector.
        for (const pattern of patterns) {
          if (symbols.has(pattern) || paths.has(pattern)) grep = true;
          else if (!/^[\w./-]+$/.test(pattern)) opaque = true;
        }
      }
    }
  }
  const complete = input.activityCensusComplete && endedBy !== 'open' && !opaque;
  const receipt = e.clientReceipt;
  const delivered = receipt?.ref.trim() && time(receipt.observedAt) >= start && time(receipt.observedAt) <= now ? true : null;
  return { exposure: e, holdout, start: new Date(start).toISOString(), end: new Date(end).toISOString(), endedBy,
    complete, issued: e.issued, delivered, actedOn: acted ? true : complete && paths.size > 0 ? false : null,
    grepAfterPush: grep ? true : complete && (symbols.size > 0 || paths.size > 0) ? false : null,
    activityIds: activities.map(a => a.id) };
}

/** Each denominator has an explicit disjoint unknown partition. */
export function summarizeReuseWindows(windows: readonly ReuseMeasuredWindow[]) {
  const unique = new Map<string, ReuseMeasuredWindow>();
  for (const w of windows) {
    const prior = unique.get(w.exposure.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(w)) throw new Error('Conflicting exposure identity');
    unique.set(w.exposure.id, w);
  }
  const byProvider: Record<string, { issued: number; delivered: number; deliveryUnknown: number;
    actedOn: { positive: number; negative: number; unknown: number };
    grepAfterPush: { positive: number; negative: number; unknown: number } }> = {};
  for (const w of unique.values()) {
    const p = byProvider[w.exposure.provider] ??= { issued: 0, delivered: 0, deliveryUnknown: 0,
      actedOn: { positive: 0, negative: 0, unknown: 0 }, grepAfterPush: { positive: 0, negative: 0, unknown: 0 } };
    p.issued += Number(w.issued);
    p.delivered += Number(w.delivered === true);
    p.deliveryUnknown += Number(w.delivered === null);
    for (const key of ['actedOn', 'grepAfterPush'] as const) p[key][w[key] === true ? 'positive' : w[key] === false ? 'negative' : 'unknown']++;
  }
  return byProvider;
}

/** Inputs must come from complete, named source populations; absent is not zero. */
export function measureReuseMetrics(input: {
  addedNonGeneratedLines: number | null;
  duplicateAddedLines: number | null;
  workItems: readonly { id: string; eligible: boolean; firstWriteAt: string | null; successfulSearchAt: string | null; complete: boolean }[];
  calls: readonly { id: string; resolved: boolean; from: string; to: string | null }[];
  lineCensusComplete: boolean;
  callCensusComplete: boolean;
}, callColumns?: unknown) {
  const integer = (n: number | null) => n !== null && Number.isSafeInteger(n) && n >= 0;
  if (input.addedNonGeneratedLines !== null && !integer(input.addedNonGeneratedLines)
    || input.duplicateAddedLines !== null && !integer(input.duplicateAddedLines)) throw new Error('Nonnegative line counts required');
  if (input.addedNonGeneratedLines !== null && input.duplicateAddedLines !== null
    && input.duplicateAddedLines > input.addedNonGeneratedLines) throw new Error('Duplicate added lines exceed added population');
  if (new Set(input.workItems.map(x => x.id)).size !== input.workItems.length
    || new Set(input.calls.map(x => x.id)).size !== input.calls.length) throw new Error('Duplicate population identities');
  const eligible = input.workItems.filter(x => x.eligible);
  const observed = eligible.filter(x => x.complete && x.firstWriteAt !== null);
  const searched = observed.filter(x => x.successfulSearchAt !== null && time(x.successfulSearchAt) < time(x.firstWriteAt!));
  if (callColumns !== undefined && input.calls.length) throw new Error('Ambiguous call census encodings');
  const resolved = callColumns === undefined ? input.calls.filter(x => x.resolved && x.to !== null) : [];
  const census = callColumns === undefined
    ? { count: input.calls.length, resolved: resolved.length, crossFile: resolved.filter(x => x.from !== x.to).length }
    : summarizeReuseCallColumns(callColumns);
  return {
    redundancy: { unit: 'duplicate-added-lines-per-1000-added-non-generated-lines',
      numerator: input.duplicateAddedLines, denominator: input.addedNonGeneratedLines,
      value: input.lineCensusComplete && input.addedNonGeneratedLines && input.duplicateAddedLines !== null
        ? 1_000 * input.duplicateAddedLines / input.addedNonGeneratedLines : null },
    searchBeforeWrite: { unit: 'eligible-work-item-fraction', numerator: searched.length, denominator: observed.length,
      unknown: eligible.length - observed.length, value: observed.length ? searched.length / observed.length : null },
    crossFileCalls: { unit: 'resolved-call-fraction', numerator: census.crossFile, denominator: census.resolved,
      unknown: census.count - census.resolved,
      value: input.callCensusComplete && census.resolved ? census.crossFile / census.resolved : null },
  };
}

export type ReuseMetricPopulation = Parameters<typeof measureReuseMetrics>[0];


/** A source-wide parse cannot run on the operator event loop. Reuse the
 * maintained finite worker; a timeout/failure is unknown, never an inline retry.
 */
export async function collectReuseSourcePopulationOffthread(root: string, start: string, end: string,
  options: import('./first-party-callers-offthread').FirstPartyCallersRunOptions = {}) {
  const result = await collectReuseSourcePopulationReply(root, start, end, options);
  result.population.calls = await decodeReuseCallColumns(result.packedCalls);
  return result.population;
}

async function collectReuseSourcePopulationReply(root: string, start: string, end: string,
  options: import('./first-party-callers-offthread').FirstPartyCallersRunOptions = {}) {
  const { codeIntelWorkerRequest } = await import('./first-party-callers-offthread');
  type Reply = { kind: 'reuse-source-population'; ok: boolean;
    population?: Awaited<ReturnType<typeof collectReuseSourcePopulation>>; packedCalls?: unknown; error?: string };
  // The supervising process owns the spill root: even a killed or timed-out
  // worker cannot strand its immutable captures outside the worker lifetime.
  const captureRoot = mkdtempSync(join(tmpdir(), 'reuse-source-worker-'));
  try {
    const result = await codeIntelWorkerRequest<Reply>({ kind: 'reuse-source-population', root, start, end, captureRoot,
      callCensusEncoding: REUSE_CALL_COLUMNS }, {
      accept: (value: unknown): value is Reply => typeof value === 'object' && value !== null
        && (value as Reply).kind === 'reuse-source-population' && typeof (value as Reply).ok === 'boolean',
      fail: error => ({ kind: 'reuse-source-population', ok: false, error }),
    }, { sourceLoader: true, ...options, heapMb: Math.min(options.heapMb ?? REUSE_PARENT_OLD_SPACE_MB, REUSE_PARENT_OLD_SPACE_MB) });
    if (!result.ok || !result.population) throw new Error(result.error ?? 'Worker source population unavailable');
    return { population: result.population, packedCalls: result.packedCalls };
  } finally { rmSync(captureRoot, { recursive: true, force: true }); }
}

/** Successful native searches and writes are attributed only to the current,
 * exact assignment interval. Missing complete client telemetry cannot vote no.
 */
export async function collectRecordedReuseMetrics(sql: Sql, scope: {
  workspaceId: string; harnessSlug: string; windowStart: string; windowEnd: string;
}, loadSource?: () => ReturnType<typeof collectReuseSourcePopulation>,
completeActivityCensuses: readonly { ref: string; owner: string; start: string; end: string }[] = []) {
  const { loadHarnessRegistry } = await import('../harness-registry');
  const root = loadSource ? null : (await loadHarnessRegistry(scope.workspaceId)).projects.find(p => p.slug === scope.harnessSlug)?.path;
  if (!loadSource && !root) throw new Error('Registered repository required');
  const reply = loadSource ? null : await collectReuseSourcePopulationReply(root!, scope.windowStart, scope.windowEnd);
  const source = loadSource ? await loadSource() : reply!.population;
  const callColumns = reply ? serializeReuseCallColumns(reply.packedCalls) : undefined;
  const rows = await sql<{ id: string; taken_by: string; taken_at: string | Date; ambiguous: boolean; activities: ReuseMeasurementActivity[] }[]>`
    SELECT w.feature_id AS id, w.taken_by, w.taken_at,
      EXISTS(SELECT 1 FROM harness_shared.work_items other WHERE other.workspace_id=w.workspace_id
        AND other.harness_slug=w.harness_slug AND other.taken_by=w.taken_by AND other.feature_id<>w.feature_id) AS ambiguous,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id::text, 'workspaceId', a.workspace_id,
        'owner', a.owner_id, 'at', a.created_at, 'tool', a.tool_name, 'status', a.status, 'detail', a.detail)
        ORDER BY a.created_at, a.id) FROM harness_shared.agent_activity a
        WHERE a.workspace_id = w.workspace_id AND a.owner_id = w.taken_by AND a.harness_slug = w.harness_slug
          AND a.kind = 'tool' AND a.phase = 'post' AND a.created_at >= w.taken_at
          AND a.created_at < ${scope.windowEnd}::timestamptz), '[]'::jsonb) AS activities
    FROM harness_shared.work_items w WHERE w.workspace_id = ${scope.workspaceId} AND w.harness_slug = ${scope.harnessSlug}
      AND w.taken_by IS NOT NULL AND w.taken_at >= ${scope.windowStart}::timestamptz
      AND w.item_kind IN ('change','bug','feature')
      AND w.taken_at < ${scope.windowEnd}::timestamptz ORDER BY w.feature_id LIMIT 1001`;
  if (rows.length > 1000) throw new Error('Assignment census exceeds bounded collector');
  const workItems = rows.map(row => {
    const writes = row.activities.filter(a => a.status === 'ok' && /^(Edit|Write|MultiEdit|mcp__papercusp-su__capability_(edit|write))$/.test(canonicalPushActivityTool(a.tool)));
    const searches = row.activities.filter(a => a.status === 'ok' && (grepTools.has(canonicalPushActivityTool(a.tool))
      || ['graph:query', 'lsp:query', 'code:pack'].includes(a.tool.replace(/^mcp__papercusp[-_]su__/, '').replace('_', ':'))
      || shellTools.has(canonicalPushActivityTool(a.tool)) && shellSearchPatterns(String(a.detail?.command ?? a.detail?.cmd ?? '')).length > 0));
    const firstWriteAt = writes[0] ? new Date(time(writes[0].at)).toISOString() : null;
    const successfulSearchAt = searches[0] ? new Date(time(searches[0].at)).toISOString() : null;
    const census = completeActivityCensuses.some(c => c.ref.trim() && c.owner === row.taken_by
      && time(c.start) <= new Date(row.taken_at).getTime() && time(c.end) >= time(scope.windowEnd));
    return { id: row.id, eligible: true, firstWriteAt, successfulSearchAt,
      complete: !row.ambiguous && census && firstWriteAt !== null };
  });
  const population: ReuseMetricPopulation = { ...source, workItems };
  const sourceRefs = [...source.sourceRefs, ...completeActivityCensuses.map(c=>c.ref),
    ...rows.map(r => `assignment:${r.id}:${new Date(r.taken_at).toISOString()}`),
    ...rows.flatMap(r => r.activities.map(a => `agent-activity:${a.id}`))];
  const payload = JSON.stringify({ schema: 'reuse-metrics-v1', harness: scope.harnessSlug,
    windowStart: new Date(time(scope.windowStart)).toISOString(), windowEnd: new Date(time(scope.windowEnd)).toISOString(),
    sourceRefs, population, method: source.method, ...(callColumns ? { callColumns } : {}) });
  const subject = JSON.stringify({ schema: 'reuse-metrics-ref-v1', harness: scope.harnessSlug,
    windowStart: new Date(time(scope.windowStart)).toISOString(), windowEnd: new Date(time(scope.windowEnd)).toISOString(),
    sha256: createHash('sha256').update(payload).digest('hex') });
  await sql`INSERT INTO harness_shared.code_intel_reuse_measurements (workspace_id, owner_id, turn_id, kind, subject, payload)
    VALUES (${scope.workspaceId}, 'system:reuse-measurement', ${scope.windowEnd}, 'reuse-metrics', ${subject}, ${payload})
    ON CONFLICT (workspace_id, owner_id, epoch, kind, subject) DO NOTHING`;
  if (reply) population.calls = await decodeReuseCallColumns(reply.packedCalls);
  return { population, sourceRefs };
}

/** Efficacy decisions preserve both outcomes and both arms; unknowns never vote. */
export function evaluateReuseProvider(input: {
  provider: string; workspaceId: string; experimentStartedAt: string; now: string; windows: readonly ReuseMeasuredWindow[];
}) {
  const now = time(input.now), start = time(input.experimentStartedAt);
  if (start > now) throw new Error('Experiment starts after observation');
  const rows = input.windows.filter(w => w.exposure.provider === input.provider && w.exposure.workspaceId === input.workspaceId
    && time(w.exposure.at) >= Math.max(start, now - REUSE_EFFICACY_HORIZON_MS) && time(w.end) <= now && w.endedBy !== 'open');
  for (const w of rows) {
    if (w.holdout !== reuseHoldout(w.exposure.workItem, input.provider) || w.holdout && w.issued
      || time(w.start) !== time(w.exposure.at) || time(w.end) < time(w.start)
      || time(w.end) > time(w.start) + REUSE_OBSERVATION_MS) throw new Error('Invalid recorded exposure cohort or window');
  }
  // Also rejects contradictory repeated evidence before any denominator is used.
  summarizeReuseWindows(rows);
  const distinct = [...new Map(rows.map(w => [w.exposure.id, w])).values()];
  const arms = Object.fromEntries(([false, true] as const).map(holdout => {
    const arm = distinct.filter(w => w.holdout === holdout);
    return [holdout ? 'holdout' : 'treatment', Object.fromEntries((['actedOn', 'grepAfterPush'] as const).map(key => {
      const observed = arm.filter(w => typeof w[key] === 'boolean');
      const positive = observed.filter(w => w[key] === true).length;
      return [key, { observed: observed.length, unknown: arm.length - observed.length,
        interval: observed.length ? wilsonInterval(positive, observed.length, 0.95) : null }];
    }))];
  })) as Record<'treatment' | 'holdout', Record<'actedOn' | 'grepAfterPush', {
    observed: number; unknown: number; interval: ReturnType<typeof wilsonInterval> | null }>>;
  const mature = now - start >= REUSE_EFFICACY_MATURITY_MS
    && Object.values(arms).every(a => Object.values(a).every(metric => metric.observed >= 100));
  const ineffective = mature && (['actedOn', 'grepAfterPush'] as const).every(key =>
    arms.treatment[key].interval!.upper <= arms.holdout[key].interval!.lower);
  return { provider: input.provider, mature, confidence: mature ? 'measured' as const : 'unknown' as const,
    action: ineffective ? 'disable' as const : 'keep' as const, reversible: true, arms,
    evidenceIds: distinct.map(w => w.exposure.id).sort(),
    reason: !mature ? 'Insufficient age or observed population; retain provider.'
      : ineffective ? 'Treatment has no improvement over holdout for both Wilson95% outcomes.' : 'Disable condition not established.' };
}

/** Apply only the recomputed mature decision, preserving the exact evidence and
 * reversal before changing the maintained flag. A saved recommendation is never
 * sufficient authority for an action. Unknown or beneficial data does no write.
 */
export async function applyReuseProviderDecision(sql: Sql, input: Parameters<typeof evaluateReuseProvider>[0],
  setEnabled?: (provider: string, enabled: boolean) => Promise<{ ok: boolean; reason?: string }>) {
  const decision = evaluateReuseProvider(input);
  if (decision.action !== 'disable') return { ...decision, applied: false };
  const { REUSE_PROVIDER_FLAGS } = await import('./reuse-brief-providers');
  if (!Object.hasOwn(REUSE_PROVIDER_FLAGS, input.provider)) throw new Error('Registered provider required');
  const flag = REUSE_PROVIDER_FLAGS[input.provider as keyof typeof REUSE_PROVIDER_FLAGS];
  const payload = JSON.stringify({ schema: 'reuse-provider-action-v1', workspaceId: input.workspaceId,
    at: input.now, decision, reversal: { flag, enabled: true } });
  const subject = JSON.stringify({ schema: 'reuse-provider-action-ref-v1', provider: input.provider,
    sha256: createHash('sha256').update(payload).digest('hex') });
  await sql`INSERT INTO harness_shared.code_intel_reuse_measurements (workspace_id, owner_id, turn_id, kind, subject, payload)
    VALUES (${input.workspaceId}, 'system:reuse-measurement', ${input.now}, 'reuse-provider-action', ${subject}, ${payload})
    ON CONFLICT (workspace_id, owner_id, epoch, kind, subject) DO NOTHING`;
  const result = await (setEnabled ? setEnabled(input.provider, false)
    : (await import('@papercusp/flags/server')).setFlagOverride(flag, false));
  if (!result.ok) throw new Error(`Provider disable failed: ${result.reason ?? 'unavailable flag store'}`);
  return { ...decision, applied: true, reversal: { flag, enabled: true } };
}

/** Read fixture or collector records from the reuse-measurement ledger
 * (harness_shared.code_intel_reuse_measurements), under exact scope. Measurement
 * records are not deliveries, so they never live in the delivered-push log
 * (code_intel_pushes; SPEC-P-006-C, EI-27013395716645252).
 * No read of an arbitrary server response claims a complete client activity census.
 */
export async function readRecordedReuseWindows(sql: Sql, input: { workspaceId: string; start: string; end: string }) {
  if (!input.workspaceId.trim() || time(input.start) >= time(input.end)) throw new Error('Exact workspace and half-open window required');
  const rows = await sql<{ subject: string; owner_id: string; payload: string | null }[]>`SELECT DISTINCT ON
      (COALESCE(subject::jsonb->>'exposureId', subject::jsonb->'observation'->'exposure'->>'id'))
      subject, owner_id, payload FROM harness_shared.code_intel_reuse_measurements
    WHERE workspace_id = ${input.workspaceId} AND kind = 'reuse-measurement'
      AND recorded_at >= ${input.start}::timestamptz AND recorded_at < ${input.end}::timestamptz
    ORDER BY COALESCE(subject::jsonb->>'exposureId', subject::jsonb->'observation'->'exposure'->>'id'), id DESC`;
  return rows.map(row => {
    const envelope = JSON.parse(row.subject);
    const referenced = envelope.schema === 'reuse-measurement-ref-v1';
    if (referenced && (!row.payload || createHash('sha256').update(row.payload).digest('hex') !== envelope.sha256))
      throw new Error('Reuse measurement payload digest mismatch');
    const record = referenced ? JSON.parse(row.payload!) : envelope;
    const observation = record.observation;
    if (record.schema !== 'reuse-measurement-v1' || observation?.exposure?.workspaceId !== input.workspaceId
      || referenced && envelope.exposureId !== observation.exposure.id
      || observation.exposure.owner !== row.owner_id || !Array.isArray(observation.activities)
      || typeof observation.activityCensusComplete !== 'boolean' || typeof observation.now !== 'string'
      || !Array.isArray(record.sourceRefs) || !record.sourceRefs.length
      || !record.sourceRefs.every((ref: unknown) => typeof ref === 'string' && ref.trim()))
      throw new Error('Invalid scoped reuse measurement record');
    // Recompute from recorded events on EVERY read. A stored rating or summary
    // is never its own measurement evidence.
    return measureReuseWindow({ ...observation, repoRoots: observation.repoRoots
      ? new Map(Object.entries(observation.repoRoots) as [string, string][]) : undefined });
  });
}

/** Collect the actual persisted exposure and post-tool rows, including controls.
 * Existing activity reporting does not certify an exhaustive client census, so
 * this collector can prove positives but never manufactures a negative. Receipt
 * acknowledgement also stays unknown until an independent receipt source exists.
 * Recollection appends raw source evidence; readers choose the latest exposure
 * edition and recompute rather than replaying a previously saved rating.
 */
export async function collectRecordedReuseWindows(sql: Sql, input: {
  workspaceId: string; harnessSlug: string; start: string; end: string; now: string;
  repoRoots?: ReadonlyMap<string, string>;
}) {
  const now = time(input.now);
  if (!input.workspaceId.trim() || !input.harnessSlug.trim() || time(input.start) >= time(input.end)
    || time(input.end) > now) throw new Error('Exact scope and closed collection window required');
  const { REUSE_PROVIDER_POLICY } = await import('./reuse-brief-providers');
  const providers = Object.keys(REUSE_PROVIDER_POLICY);
  const legs = providers.flatMap(provider => [`reuse-${provider}`, `reuse-holdout-${provider}`]);
  const rows = await sql<{ id: string; owner_id: string; epoch: number; turn_id: string; leg: string;
    subject: string; pushed_at: Date | string; chars: number; activities: ReuseMeasurementActivity[] }[]>`
    SELECT p.id::text, p.owner_id, p.epoch, p.turn_id, p.leg, p.subject, p.pushed_at, p.chars,
      COALESCE((SELECT jsonb_agg(a.row ORDER BY a.created_at, a.id) FROM (
        SELECT a.id, a.created_at, jsonb_build_object('id', a.id::text, 'workspaceId', a.workspace_id,
          'owner', a.owner_id, 'at', a.created_at, 'tool', a.tool_name, 'status', a.status,
          'detail', a.detail, 'harness', a.harness_slug) AS row
        FROM harness_shared.agent_activity a WHERE a.workspace_id = p.workspace_id AND a.owner_id = p.owner_id
          AND a.kind = 'tool' AND a.phase = 'post' AND a.created_at > p.pushed_at
          AND a.created_at <= LEAST(${input.now}::timestamptz, p.pushed_at + interval '30 minutes')
        ORDER BY a.created_at, a.id LIMIT 20
      ) a), '[]'::jsonb) AS activities
    FROM harness_shared.code_intel_pushes p WHERE p.workspace_id = ${input.workspaceId}
      AND p.leg = ANY(${legs}::text[])
      AND p.pushed_at >= ${input.start}::timestamptz AND p.pushed_at < ${input.end}::timestamptz
    ORDER BY p.id LIMIT 1001`;
  // Never publish a partial population as a complete collection. The caller
  // can partition the same half-open window into smaller intervals.
  if (rows.length > 1000) throw new Error('Collection exceeds 1000 exposures; partition the time window');
  const windows: ReuseMeasuredWindow[] = [], recorded: string[] = [];
  const rejected: { ref: string; reason: string }[] = [];
  for (const row of rows) {
    const ref = `code-intel-push:${row.id}`;
    let record: Record<string, any>;
    try { record = JSON.parse(row.subject); }
    catch { rejected.push({ ref, reason: 'Invalid exposure metadata' }); continue; }
    if (record.harness !== input.harnessSlug) continue;
    const provider = record.provider;
    if (record.schema !== 'reuse-brief-v1' || !providers.includes(provider)
      || typeof record.workItem !== 'string' || !record.workItem.trim()
      || typeof record.invocation !== 'string' || !record.invocation.trim()
      || !record.sourceVersion || !record.indexVersion || !Array.isArray(record.selector?.paths)
      || !Array.isArray(record.selector?.symbols)
      || ![...record.selector.paths, ...record.selector.symbols].every(x => typeof x === 'string' && x.trim())) {
      rejected.push({ ref, reason: 'Missing scoped exposure identity or provider selector' }); continue;
    }
    const held = reuseHoldout(record.workItem, provider), issued = row.chars > 0;
    if (record.cohort !== (held ? 'holdout' : 'treatment') || held === issued
      || row.leg !== (held ? `reuse-holdout-${provider}` : `reuse-${provider}`)
      || held && record.outcome !== 'holdout') {
      rejected.push({ ref, reason: 'Exposure disagrees with preregistered arm' }); continue;
    }
    const exposure: ReuseMeasurementExposure = { id: ref, workspaceId: input.workspaceId, owner: row.owner_id,
      invocation: record.invocation, workItem: record.workItem, provider,
      at: row.pushed_at instanceof Date ? row.pushed_at.toISOString() : new Date(time(row.pushed_at)).toISOString(), issued,
      clientReceipt: null, selector: record.selector };
    const observation = { exposure, activities: row.activities,
      now: new Date(Math.min(now, time(exposure.at) + REUSE_OBSERVATION_MS)).toISOString(),
      activityCensusComplete: false,
      ...(input.repoRoots ? { repoRoots: Object.fromEntries(input.repoRoots) } : {}) };
    windows.push(measureReuseWindow({ ...observation, repoRoots: input.repoRoots }));
    const payload = JSON.stringify({ schema: 'reuse-measurement-v1',
      sourceRefs: [ref, ...row.activities.map(a => `agent-activity:${a.id}`)], observation });
    // subject participates in the measurement ledger's B-tree unique key. Keep
    // that key small even for twenty high-entropy tool details; the
    // hash-verified raw record goes in the unindexed payload column.
    const subject = JSON.stringify({ schema: 'reuse-measurement-ref-v1', exposureId: ref,
      sha256: createHash('sha256').update(payload).digest('hex') });
    const result = await sql<{ id: string }[]>`INSERT INTO harness_shared.code_intel_reuse_measurements
      (workspace_id, owner_id, epoch, turn_id, kind, subject, payload, recorded_at)
      VALUES (${input.workspaceId}, ${row.owner_id}, ${row.epoch}, ${row.turn_id}, 'reuse-measurement', ${subject}, ${payload}, ${exposure.at}::timestamptz)
      ON CONFLICT (workspace_id, owner_id, epoch, kind, subject) DO NOTHING RETURNING id::text`;
    recorded.push(...result.map(r => r.id));
  }
  return { windows, recorded, rejected };
}

/** Registered remeasurement consumes raw population snapshots, never saved scores.
 * Exact window equality prevents a partial population from rating a wider window.
 * A collector may replace a snapshot by appending a newer exact-window record.
 */
export async function measureRecordedReuseMetric(sql: Sql, scope: {
  workspaceId: string; harnessSlug?: string; windowStart: string; windowEnd: string;
}, metric: ReuseMetric): Promise<{ verdict: 'pass' | 'unknown'; value?: number; detail: string }> {
  if (!scope.workspaceId.trim() || !scope.harnessSlug?.trim()
    || time(scope.windowStart) >= time(scope.windowEnd)) return { verdict: 'unknown', detail: 'Exact workspace, harness and valid window required.' };
  if (metric === 'providerOutcomes') {
    const { loadHarnessRegistry } = await import('../harness-registry');
    const { REUSE_PROVIDER_POLICY, REUSE_PROVIDER_FLAGS } = await import('./reuse-brief-providers');
    const roots = new Map<string, string>();
    try {
      for (const project of (await loadHarnessRegistry(scope.workspaceId)).projects)
        if (project.path) roots.set(project.slug, project.path);
    } catch { /* Absolute paths remain unknown when the registry is unavailable. */ }
    const collected = await collectRecordedReuseWindows(sql, { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      start: scope.windowStart, end: scope.windowEnd, now: scope.windowEnd, repoRoots: roots });
    const windows = (await readRecordedReuseWindows(sql, { workspaceId: scope.workspaceId,
      start: scope.windowStart, end: scope.windowEnd })).filter(w => collected.windows.some(row => row.exposure.id === w.exposure.id));
    const byProvider = summarizeReuseWindows(windows), providers = Object.keys(REUSE_PROVIDER_POLICY);
    const notObserved = providers.filter(provider => !byProvider[provider]);
    const recommendations = await Promise.all(providers.map(async provider => {
      const first = windows.filter(w => w.exposure.provider === provider).map(w => w.exposure.at).sort()[0] ?? scope.windowEnd;
      return { ...await applyReuseProviderDecision(sql, { workspaceId: scope.workspaceId, provider, windows,
        experimentStartedAt: first, now: scope.windowEnd }),
      reversal: { flag: REUSE_PROVIDER_FLAGS[provider as keyof typeof REUSE_PROVIDER_FLAGS], enabled: true } };
    }));
    return { verdict: notObserved.length || collected.rejected.length ? 'unknown' : 'pass',
      detail: JSON.stringify({ scope, byProvider, notObserved, recommendations, rejected: collected.rejected,
        sourceRefs: windows.map(w => w.exposure.id),
        cannotObserve: ['No independent client receipt source is registered; delivery remains unknown.',
          'Activity ledger completeness is not certified; absent follow-through remains unknown.'] }) };
  }
  const readPopulation = async () => await sql<{ subject: string; suggested_call: string | null }[]>`SELECT subject, payload AS suggested_call
    FROM harness_shared.code_intel_reuse_measurements
    WHERE workspace_id = ${scope.workspaceId} AND kind = 'reuse-metrics'
      AND subject::jsonb->>'schema' IN ('reuse-metrics-v1', 'reuse-metrics-ref-v1')
      AND subject::jsonb->>'harness' = ${scope.harnessSlug!}
      AND subject::jsonb->>'windowStart' = ${new Date(time(scope.windowStart)).toISOString()}
      AND subject::jsonb->>'windowEnd' = ${new Date(time(scope.windowEnd)).toISOString()}
    ORDER BY id DESC LIMIT 1`;
  let rows = await readPopulation();
  if (!rows.length) {
    try {
      await collectRecordedReuseMetrics(sql, { ...scope, harnessSlug: scope.harnessSlug });
      rows = await readPopulation();
    } catch (error) { return { verdict: 'unknown', detail: `Raw collection unavailable: ${error instanceof Error ? error.message : 'unknown cause'}` }; }
  }
  if (!rows.length) return { verdict: 'unknown', detail: 'No raw exact-window population has been recorded; absence is not zero.' };
  try {
    const envelope = JSON.parse(rows[0]!.subject), raw = rows[0]!.suggested_call;
    if (envelope.schema === 'reuse-metrics-ref-v1' && (!raw
      || createHash('sha256').update(raw).digest('hex') !== envelope.sha256)) throw new Error('Raw population digest mismatch');
    const record = envelope.schema === 'reuse-metrics-ref-v1' ? JSON.parse(raw!) : envelope;
    if (record.schema !== 'reuse-metrics-v1' || record.harness !== scope.harnessSlug
      || record.windowStart !== new Date(time(scope.windowStart)).toISOString()
      || record.windowEnd !== new Date(time(scope.windowEnd)).toISOString()) throw new Error('Raw population scope mismatch');
    if (!Array.isArray(record.sourceRefs) || !record.sourceRefs.length
      || !record.sourceRefs.every((ref: unknown) => typeof ref === 'string' && ref.trim())
      || !Array.isArray(record.population?.workItems) || !Array.isArray(record.population?.calls)
      || typeof record.population.lineCensusComplete !== 'boolean' || typeof record.population.callCensusComplete !== 'boolean') {
      return { verdict: 'unknown', detail: 'Raw source references and completeness declarations required.' };
    }
    const result = measureReuseMetrics(record.population, record.callColumns)[metric];
    if (result.value === null || metric === 'searchBeforeWrite' && 'unknown' in result && result.unknown > 0) {
      return { verdict: 'unknown', detail: JSON.stringify({ metric, measurement: result, sourceRefs: record.sourceRefs }) };
    }
    // Registry units are count/%: preserve the Design's canonical fraction and
    // denominator in detail, and explicitly convert fraction -> percent here.
    return { verdict: 'pass', value: metric === 'redundancy' ? result.value : 100 * result.value,
      detail: JSON.stringify({ metric, measurement: result, ledgerUnit: metric === 'redundancy' ? 'count-per-1000-lines' : '%',
        sourceRefs: record.sourceRefs }) };
  } catch {
    return { verdict: 'unknown', detail: 'Recorded population is invalid; no fallback to a saved score.' };
  }
}
