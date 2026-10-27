/**
 * Production adapters for the campaign runner (code-cleanup-campaigns-2026-10-26 P-009; D-015, D-016).
 *
 * - `workItemThrottleStore`: the campaign's regression-throttle state lives on its runner work-item,
 *   under `payload.codeCleanupThrottle` (D-016). An absent state is the initial one; a malformed
 *   state throws, so a stored trip is never silently read as "not throttled".
 * - `nativeCampaignRoundDeps`: binds `planCampaignRound` to the divergence-bug store, the
 *   diverged-copy filer, the repo checkout, git ordering for the coverage map, the lock store and
 *   edit ledger, and the throttle store. Live lock acquisition is injected: without an acquirer
 *   every admission is refused with the reason, so only a dry round can run unwired.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { nativeAdmissionReaders, type AdmissionDeps } from './admission';
import type { CampaignReview } from './campaign-plan';
import type { CampaignRoundDeps, CampaignThrottleStore } from './campaign-runner';
import { fileDivergedCopyBugs } from './divergence';
import { nativeExecutorDeps } from './executor';
import { parseCleanupBatchRecord, readLandedCleanupBatches, type LandedBatchRow } from './outcome';
import { initialThrottleState, resetRegressionThrottle, type CampaignThrottleState, type GateRed, type LandedBatch,
  type ThrottleResetResult } from './throttle';
import { nativeDivergenceBugLookup, nativeMemberHistory, type MemberHistoryLookup } from './triage';
import type { TestCoverageSnapshot } from '@papercusp/test-config/test-coverage-map';

/** Payload key on the runner work-item holding the throttle state (D-016). */
export const CAMPAIGN_THROTTLE_PAYLOAD_KEY = 'codeCleanupThrottle';
/** Payload key on the runner work-item naming the campaign it runs. */
export const CAMPAIGN_ID_PAYLOAD_KEY = 'codeCleanupCampaign';

const REVIEWS: readonly CampaignReview[] = ['off', 'required'];
const isReview = (v: unknown): v is CampaignReview => typeof v === 'string' && (REVIEWS as readonly string[]).includes(v);

/** JSON form of the throttle state: dates as ISO strings. */
export function serializeThrottleState(state: CampaignThrottleState): Record<string, unknown> {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    throttled: state.throttled, review: state.review, reviewBeforeTrip: state.reviewBeforeTrip,
    trippedAt: iso(state.trippedAt), resetAt: iso(state.resetAt), resetBy: state.resetBy,
  };
}

/** Read a stored throttle state. `undefined`/`null` = never stored: the initial state. */
export function parseThrottleState(raw: unknown, defaultReview: CampaignReview): CampaignThrottleState {
  if (raw === undefined || raw === null) return initialThrottleState(defaultReview);
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Stored campaign throttle state is not an object');
  const o = raw as Record<string, unknown>;
  const date = (key: string): Date | null => {
    const v = o[key];
    if (v === null || v === undefined) return null;
    const d = typeof v === 'string' ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) throw new Error(`Stored campaign throttle state has an invalid ${key}`);
    return d;
  };
  if (typeof o.throttled !== 'boolean') throw new Error('Stored campaign throttle state has no throttled flag');
  if (!isReview(o.review)) throw new Error('Stored campaign throttle state has an invalid review setting');
  if (o.reviewBeforeTrip !== null && o.reviewBeforeTrip !== undefined && !isReview(o.reviewBeforeTrip)) {
    throw new Error('Stored campaign throttle state has an invalid reviewBeforeTrip');
  }
  if (o.resetBy !== null && o.resetBy !== undefined && typeof o.resetBy !== 'string') {
    throw new Error('Stored campaign throttle state has an invalid resetBy');
  }
  return {
    throttled: o.throttled, review: o.review, reviewBeforeTrip: (o.reviewBeforeTrip ?? null) as CampaignReview | null,
    trippedAt: date('trippedAt'), resetAt: date('resetAt'), resetBy: (o.resetBy ?? null) as string | null,
  };
}

/** Row access for the runner work-item; `merge` returns the number of rows updated. */
export interface RunnerItemRows {
  read(itemId: string): Promise<{ payload: unknown } | null>;
  merge(itemId: string, key: string, value: Record<string, unknown>): Promise<number>;
}

export interface ThrottleStoreScope {
  workspaceId: string;
  harness: string;
  /** The campaign's runner work-item (D-016). */
  runnerItemId: string;
  /** The campaign's review setting before any trip. */
  defaultReview: CampaignReview;
}

function nativeRunnerItemRows(scope: { workspaceId: string; harness: string }): RunnerItemRows {
  const sql = async () => (await import('@papercusp/db-org')).getOrgPg().sql;
  return {
    async read(itemId) {
      const db = await sql();
      const rows = await db<{ payload: unknown }[]>`
        SELECT payload FROM harness_shared.work_items
         WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness} AND feature_id = ${itemId}`;
      return rows[0] ?? null;
    },
    async merge(itemId, key, value) {
      const db = await sql();
      const res = await db`
        UPDATE harness_shared.work_items
           SET payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(${key}::text, ${db.json(value as never)}::jsonb),
               updated_ts = ${Date.now()}
         WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.harness} AND feature_id = ${itemId}`;
      return res.count;
    },
  };
}

/** The throttle store over the campaign's runner work-item payload (D-016). */
export function workItemThrottleStore(scope: ThrottleStoreScope, deps: { rows?: RunnerItemRows } = {}): CampaignThrottleStore {
  if (!scope.runnerItemId.trim()) throw new Error('Campaign throttle store needs a runner work-item id');
  const rows = deps.rows ?? nativeRunnerItemRows(scope);
  const runnerPayload = async (campaignId: string): Promise<Record<string, unknown>> => {
    const row = await rows.read(scope.runnerItemId);
    if (!row) throw new Error(`Campaign runner work-item ${scope.runnerItemId} not found`);
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown> : {};
    const owner = payload[CAMPAIGN_ID_PAYLOAD_KEY];
    if (typeof owner === 'string' && owner !== campaignId) {
      throw new Error(`Runner work-item ${scope.runnerItemId} runs campaign ${owner}, not ${campaignId}`);
    }
    return payload;
  };
  return {
    async load(campaignId) {
      const payload = await runnerPayload(campaignId);
      return parseThrottleState(payload[CAMPAIGN_THROTTLE_PAYLOAD_KEY], scope.defaultReview);
    },
    async save(campaignId, state) {
      await runnerPayload(campaignId);
      const n = await rows.merge(scope.runnerItemId, CAMPAIGN_THROTTLE_PAYLOAD_KEY, serializeThrottleState(state));
      if (n !== 1) throw new Error(`Campaign throttle save updated ${n} rows on ${scope.runnerItemId}`);
    },
  };
}

/**
 * The owner's reset of a throttled campaign (P-008 R-9, D-013): load the stored state, apply
 * `resetRegressionThrottle` (which refuses any principal that is not `admin:*`/`user:*`, and a
 * campaign that is not throttled), and save only a successful reset. The caller supplies the
 * principal from its authenticated human surface; an agent's MCP identity never qualifies.
 */
export async function resetCampaignThrottle(input: {
  store: CampaignThrottleStore; campaignId: string; principal: string; now: Date;
}): Promise<ThrottleResetResult> {
  const result = resetRegressionThrottle(await input.store.load(input.campaignId), input.principal, input.now);
  if (result.ok) await input.store.save(input.campaignId, result.state);
  return result;
}

/** Read a file relative to `root`; a path outside it, or an unreadable file, reads as null. */
export function repoFileReader(root: string): (path: string) => Promise<string | null> {
  const base = resolve(root);
  return async (path) => {
    if (isAbsolute(path)) return null;
    const abs = resolve(base, path);
    const rel = relative(base, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    try { return await readFile(abs, 'utf8'); } catch { return null; }
  };
}

const unwiredAcquire: AdmissionDeps['acquire'] = async () =>
  ({ ok: false, detail: 'no lock acquirer wired for a live round: run the round dry, or inject an acquirer' });

/**
 * Live-round acquirer for a round whose edits an agent applies (D-017): admission has already
 * checked the batch's files against live locks and the edit ledger; the locks themselves are
 * taken on the edit path (the PreToolUse lock hook or locks:acquire) when the agent applies the
 * planned edits. The returned lock id says so, so no caller mistakes it for a held lock.
 */
export const editPathAcquire: AdmissionDeps['acquire'] = async (batch) =>
  ({ ok: true, lockId: `edit-path:${batch.id}` });

/** A landed batch work-item: the outcome reader's row plus the files the edit ledger saw it edit. */
export function landedBatchesFromRows(rows: readonly LandedBatchRow[], campaignId: string,
  editedFiles: ReadonlyMap<string, readonly string[]>): LandedBatch[] {
  const out: LandedBatch[] = [];
  for (const row of rows) {
    const parsed = parseCleanupBatchRecord(row.record);
    if (!parsed.ok || parsed.record.campaign !== campaignId) continue;
    out.push({
      batchId: parsed.record.batchId, workItemId: row.workItemId, linesRemoved: parsed.record.linesRemoved,
      editedFiles: [...new Set(editedFiles.get(row.workItemId) ?? [])].sort(),
    });
  }
  return out;
}

/** One failing CI test run the throttle may attribute. */
export interface GateRedRow { id: string | number; filePath: string; finishedAt: Date | string }

/**
 * Gate reds with their ledger-mode radius: the files a coverage snapshot saw the failing test
 * execute, plus the test file itself. A test with no snapshot has only itself as radius, so it is
 * attributed only when a batch edited the test file; that undercount is reported by the caller.
 */
export function gateRedsFromRows(rows: readonly GateRedRow[],
  snapshots: readonly Pick<TestCoverageSnapshot, 'testFile' | 'sources'>[]): GateRed[] {
  const radius = new Map<string, Set<string>>();
  for (const s of snapshots) {
    const set = radius.get(s.testFile) ?? new Set<string>();
    for (const src of s.sources) set.add(src.path);
    radius.set(s.testFile, set);
  }
  return rows.map(r => {
    const at = r.finishedAt instanceof Date ? r.finishedAt : new Date(r.finishedAt);
    if (Number.isNaN(at.getTime())) throw new Error(`Gate red ${r.id} has an invalid finish time`);
    return { id: String(r.id), testFile: r.filePath, at,
      affectedRadius: [...new Set([r.filePath, ...(radius.get(r.filePath) ?? [])])].sort() };
  });
}

/** The landed batches and gate reds the round's throttle attributes, read from Postgres. */
export async function readNativeThrottleInputs(scope: {
  workspaceId: string; harness: string; root: string; campaignId: string; windowStart: Date; windowEnd: Date;
}): Promise<{ landed: LandedBatch[]; reds: GateRed[]; redsWithoutRadius: number }> {
  const [{ getOrgPg }, { readTestCoverage }] = await Promise.all([
    import('@papercusp/db-org'), import('@papercusp/test-config/test-coverage-store')]);
  const { sql } = getOrgPg();
  const rows = await readLandedCleanupBatches(sql as never, { workspaceId: scope.workspaceId, harnessSlug: scope.harness,
    windowStart: scope.windowStart.toISOString(), windowEnd: scope.windowEnd.toISOString() });
  const ids = rows.map(r => r.workItemId);
  const edits = ids.length ? await sql<{ work_item_id: string; file: string }[]>`
    SELECT DISTINCT work_item_id, file FROM harness_shared.edit_attribution_ledger
     WHERE workspace_id = ${scope.workspaceId} AND work_item_id = ANY(${ids})` : [];
  const byItem = new Map<string, string[]>();
  for (const e of edits) byItem.set(e.work_item_id, [...(byItem.get(e.work_item_id) ?? []), e.file]);
  const landed = landedBatchesFromRows(rows, scope.campaignId, byItem);
  if (!landed.length) return { landed, reds: [], redsWithoutRadius: 0 };
  const since = new Date(Math.min(...rows.map(r => r.closedTs)));
  // The gate writes its CI rows with no workspace or harness (NULL), so NULL scope counts as
  // this tree's gate. One red per test file per judged commit: re-runs of one failure are one red.
  const redRows = await sql<{ id: string; file_path: string; finished_at: Date }[]>`
    SELECT DISTINCT ON (file_path, commit_sha) id::text AS id, file_path, finished_at
      FROM harness_shared.test_runs
     WHERE source = 'ci' AND worktree_dirty = false AND status IN ('fail', 'error')
       AND (workspace_id IS NULL OR workspace_id = ${scope.workspaceId})
       AND (harness_slug IS NULL OR harness_slug = ${scope.harness})
       AND finished_at >= ${since} AND finished_at < ${scope.windowEnd}
     ORDER BY file_path, commit_sha, finished_at`;
  const edited = [...new Set(landed.flatMap(b => b.editedFiles ?? []))].slice(0, 50);
  const snapshots = edited.length ? await readTestCoverage(sql, scope.workspaceId, scope.harness, scope.root, edited) : [];
  const reds = gateRedsFromRows(redRows.map(r => ({ id: r.id, filePath: r.file_path, finishedAt: r.finished_at })), snapshots);
  const covered = new Set(snapshots.map(s => s.testFile));
  return { landed, reds, redsWithoutRadius: reds.filter(r => !covered.has(r.testFile)).length };
}

/** Production deps for `planCampaignRound` (D-015). */
export function nativeCampaignRoundDeps(scope: ThrottleStoreScope & {
  root: string;
  acquire?: AdmissionDeps['acquire'];
  /** Pass the lookup a caller already used (its per-range cache then serves this round too). */
  memberHistory?: MemberHistoryLookup;
}): CampaignRoundDeps {
  const where = { workspaceId: scope.workspaceId, harness: scope.harness };
  return {
    divergenceBug: nativeDivergenceBugLookup(where),
    memberHistory: scope.memberHistory ?? nativeMemberHistory(scope.root),
    fileDiverged: holds => fileDivergedCopyBugs(holds, where),
    readFile: repoFileReader(scope.root),
    executor: nativeExecutorDeps(scope.root),
    admission: { ...nativeAdmissionReaders({ workspaceId: scope.workspaceId }), acquire: scope.acquire ?? unwiredAcquire },
    throttle: workItemThrottleStore(scope),
  };
}
