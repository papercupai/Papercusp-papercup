/**
 * Native, runtime-witnessed live readings for gate-repair-plane-on-current-build-2026-10-15
 * acceptance bars R-6 (AUTO-BAR-R-6-P-006) and R-7 (AUTO-BAR-R-7-P-003).
 *
 * Both bars are live-plane only. A committed psql reading imported through
 * testing:record-run carries no runtime witness, and instrument-provenance.ts refuses an
 * operational binding whose reading came from an untested script (an aggregate is exactly
 * where a wrong denominator hides). This module is the tested instrument: the reads and the
 * oracle live here, the oracle is pure and unit-tested, and executeOperationalRun witnesses
 * the database unit before and after execution.
 *
 * Lives outside record-run.ts for the reason native-check-consult-receipts.ts does: live spec
 * bindings pin that file (EI-26555275260059787).
 */

import { getOrgPg } from '@papercusp/db-org';
import { IDLE_ACTUATOR_PASS_MARKER } from '../../release/idle-repair-queue-actuator';
import { defaultGitRunner, type GitRunner } from '../plans/evidence-measurement-pin';
import { executeOperationalRun, resolveOperationalSourceRoot, type OperationalEvidenceArtifact } from './record-run';

type NativeCheckContext = Parameters<typeof executeOperationalRun>[1];
type NativeCheckExecution = Parameters<typeof executeOperationalRun>[2];
type Assertion = OperationalEvidenceArtifact['assertions'][number];

/** The committed check definition: this module (reads + oracle). */
export const GATE_REPAIR_PLANE_CHECK_PATH = 'packages/operator-core/lib/agent-tools/testing/native-check-gate-repair-plane.ts';
/** The file whose content proves which code wrote a pass record (R-6). */
export const IDLE_ACTUATOR_SOURCE_PATH = 'packages/operator-core/lib/release/idle-repair-queue-actuator.ts';
/** Serving identities (repair-limb-executor.ts / serving-host-identity.ts). */
export const BG_HOST_ID = 'port-3271';
export const RELEASE_HOST_ID = 'port-3070';
/** R-7 window: the :9071 proxy restart onto the routing build. */
export const R7_WINDOW_START = '2026-10-27T04:06:00Z';
/** R-7 falsifier: fewer selector-less calls than this reads unknown, not passed. */
export const R7_SELECTORLESS_FLOOR = 20;
/** Every phase a frozen repair queue can be in while it is open, i.e. while main is red. */
export const OPEN_QUEUE_PHASES: ReadonlySet<string> = new Set([
  'ready-to-test', 'blocked', 'ready-to-verify', 'awaiting-fixer', 'ready-to-promote',
]);

export const GATE_REPAIR_PLANE_READINGS = ['r6-pass-marker', 'r7-repair-queue-serving'] as const;
export type GateRepairPlaneReading = (typeof GATE_REPAIR_PLANE_READINGS)[number];

const add = (assertions: Assertion[], id: string, passed: boolean, evidence: string) =>
  assertions.push({ id, passed, evidence: evidence.slice(0, 2000) });

// ── R-7 ────────────────────────────────────────────────────────────────────────────

export interface RepairQueueServingCell {
  /** null when the dispatcher recorded no serving host — never coalesced away. */
  servingHost: string | null;
  hasBuildSelector: boolean;
  argsNull: boolean;
  n: number;
}

/**
 * R-7 oracle over one snapshot: the partition cells plus the filtered row count they must
 * sum to. A call with NULL args carries no selector, so it counts as selector-less; a
 * selector-less call with no recorded host cannot be proven off the release host, so it
 * fails the partition rather than silently dropping out of the denominator.
 */
export function judgeRepairQueueServing(input: {
  cells: RepairQueueServingCell[];
  total: number;
  floor?: number;
}): Assertion[] {
  const floor = input.floor ?? R7_SELECTORLESS_FLOOR;
  const assertions: Assertion[] = [];
  const sum = (cells: RepairQueueServingCell[]) => cells.reduce((acc, cell) => acc + cell.n, 0);
  const selectorless = input.cells.filter(cell => !cell.hasBuildSelector);
  const onRelease = selectorless.filter(cell => cell.servingHost === RELEASE_HOST_ID);
  const hostless = selectorless.filter(cell => cell.servingHost === null);
  const describe = input.cells.map(cell =>
    `(${cell.servingHost ?? '<null>'}, selector=${cell.hasBuildSelector}, argsNull=${cell.argsNull}) = ${cell.n}`).join('; ');
  const partitionSum = sum(input.cells);
  add(assertions, 'r7-partition-exhaustive', partitionSum === input.total && sum(hostless) === 0,
    `cells: ${describe || 'none'}; cells sum ${partitionSum} vs ${input.total} filtered rows; ` +
    `selector-less calls with no recorded serving host: ${sum(hostless)}`);
  add(assertions, 'r7-no-selectorless-call-on-release-host', sum(onRelease) === 0,
    `${sum(onRelease)} selector-less release:repair-queue call(s) served by ${RELEASE_HOST_ID} since ${R7_WINDOW_START}`);
  const count = sum(selectorless);
  add(assertions, 'r7-sample-above-floor', count >= floor,
    count >= floor
      ? `${count} selector-less calls since ${R7_WINDOW_START}, at or above the ${floor}-call floor`
      : `${count} selector-less calls since ${R7_WINDOW_START}, below the ${floor}-call floor: the reading is unknown, not passed`);
  return assertions;
}

// ── R-6 ────────────────────────────────────────────────────────────────────────────

export interface PassMarkerRecord {
  id: string;
  createdAt: string;
  hostId: string | null;
  executingBuildSha: string | null;
  queuePhase: string | null;
  candidate: string | null;
}

/** Per stamped sha: does the actuator file at that commit carry the marker (null = unreadable). */
export type MarkerContainment = Readonly<Record<string, boolean | null>>;

/**
 * The subject is the first record (records arrive oldest first) whose OWN stamped build
 * contains the marker; a record whose stamped sha lacks it is a dirty-bundle execution.
 */
export function findPassMarkerSubject(records: PassMarkerRecord[], containment: MarkerContainment): PassMarkerRecord | undefined {
  return records.find(record => record.executingBuildSha !== null && containment[record.executingBuildSha] === true);
}

export function judgeRepairPassMarker(input: {
  marker: string;
  records: PassMarkerRecord[];
  containment: MarkerContainment;
  /** main as of the subject record, and whether its actuator file carries the marker. */
  mainAtSubject: { sha: string | null; containsMarker: boolean | null } | null;
}): Assertion[] {
  const assertions: Assertion[] = [];
  const subject = findPassMarkerSubject(input.records, input.containment);
  add(assertions, 'r6-subject-carries-current-marker', subject !== undefined,
    subject
      ? `pipeline_events ${subject.id} (${subject.createdAt}) is the first of ${input.records.length} record(s) carrying marker ${input.marker} whose stamped build contains it`
      : `${input.records.length} record(s) carry marker ${input.marker}; none has a stamped build whose ${IDLE_ACTUATOR_SOURCE_PATH} contains it`);
  if (subject) {
    add(assertions, 'r6-subject-stamped-build-contains-marker', input.containment[subject.executingBuildSha!] === true,
      `executor.executingBuild.sha ${subject.executingBuildSha}: ${IDLE_ACTUATOR_SOURCE_PATH} carries the marker`);
    add(assertions, 'r6-subject-executor-is-bg-host', subject.hostId === BG_HOST_ID,
      `executor.hostId ${subject.hostId ?? '<none>'}; bg-host is ${BG_HOST_ID}`);
    const main = input.mainAtSubject;
    add(assertions, 'r6-main-lacks-marker-at-subject', main !== null && main.sha !== null && main.containsMarker === false,
      main?.sha
        ? `main at the subject record is ${main.sha}; marker present there: ${main.containsMarker === null ? 'unreadable' : main.containsMarker}`
        : 'main at the subject record could not be resolved');
    add(assertions, 'r6-main-red-at-subject', subject.queuePhase !== null && OPEN_QUEUE_PHASES.has(subject.queuePhase),
      `subject snapshot: frozen queue phase ${subject.queuePhase ?? '<none>'}, candidate ${subject.candidate ?? '<none>'}`);
  }
  const before = subject ? input.records.filter(record => record !== subject && record.createdAt <= subject.createdAt) : input.records;
  const bySha = new Map<string, number>();
  for (const record of before) bySha.set(record.executingBuildSha ?? '<unresolved>', (bySha.get(record.executingBuildSha ?? '<unresolved>') ?? 0) + 1);
  add(assertions, 'r6-residue-recorded', true,
    `${before.length} earlier marker record(s): ` + ([...bySha].map(([sha, n]) =>
      `${n} stamped ${sha} (contains marker: ${sha === '<unresolved>' ? 'n/a' : String(input.containment[sha] ?? 'unreadable')})`).join('; ') || 'none'));
  return assertions;
}

// ── reads ──────────────────────────────────────────────────────────────────────────

export interface ServerIdentity { database: string; port: number }

export interface GateRepairPlaneQueries {
  identity: () => Promise<ServerIdentity>;
  repairQueueServing: (workspaceId: string, since: string) => Promise<ServerIdentity & { cells: RepairQueueServingCell[]; total: number }>;
  passMarkerRecords: (workspaceId: string, marker: string) => Promise<ServerIdentity & { records: PassMarkerRecord[] }>;
}

/** Every reading runs in ONE read-only repeatable-read snapshot. */
function snapshot<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const { sql } = getOrgPg();
  return sql.begin('isolation level repeatable read, read only', async (tx) => {
    await tx`SET LOCAL statement_timeout = '15s'`;
    return fn(tx);
  }) as Promise<T>;
}

async function identityOf(tx: any): Promise<ServerIdentity> {
  const [row] = await tx`SELECT current_database() AS database, inet_server_port() AS port`;
  return { database: String(row?.database ?? ''), port: Number(row?.port) };
}

export const defaultGateRepairPlaneQueries: GateRepairPlaneQueries = {
  identity: () => snapshot(identityOf),
  repairQueueServing: (workspaceId, since) => snapshot(async (tx) => {
    const server = await identityOf(tx);
    const rows = await tx`
      SELECT serving_host, coalesce(args_json ? 'build', false) AS has_build_selector,
             (args_json IS NULL) AS args_null, count(*)::int AS n
        FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId} AND tool_name = 'release:repair-queue' AND invoked_at >= ${since}::timestamptz
       GROUP BY 1, 2, 3 ORDER BY 4 DESC`;
    const [total] = await tx`
      SELECT count(*)::int AS n FROM harness_shared.tool_invocations
       WHERE workspace_id = ${workspaceId} AND tool_name = 'release:repair-queue' AND invoked_at >= ${since}::timestamptz`;
    return { ...server, total: Number(total?.n ?? 0),
      cells: rows.map((row: any) => ({ servingHost: row.serving_host ?? null, hasBuildSelector: row.has_build_selector === true,
        argsNull: row.args_null === true, n: Number(row.n) })) };
  }),
  passMarkerRecords: (workspaceId, marker) => snapshot(async (tx) => {
    const server = await identityOf(tx);
    const rows = await tx`
      SELECT id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
             detail->'idleActuator'->'executor'->>'hostId' AS host_id,
             detail->'idleActuator'->'executor'->'executingBuild'->>'sha' AS sha,
             detail->'idleActuator'->'snapshot'->>'phase' AS phase,
             detail->'idleActuator'->'snapshot'->>'candidate' AS candidate
        FROM harness_shared.pipeline_events
       WHERE workspace_id = ${workspaceId} AND kind = 'green_checkpoint_repair_latency'
         AND detail->'idleActuator'->>'marker' = ${marker}
       ORDER BY created_at, id LIMIT 5000`;
    return { ...server, records: rows.map((row: any) => ({ id: row.id, createdAt: row.created_at, hostId: row.host_id ?? null,
      executingBuildSha: row.sha ?? null, queuePhase: row.phase ?? null, candidate: row.candidate ?? null })) };
  }),
};

/**
 * Does `path` at `sha` carry `marker`? A readable commit whose tree has no such path answers
 * false (a file that does not exist carries no marker; main predating the actuator file is the
 * live case). null only when the commit itself, or a path it does list, cannot be read.
 */
async function containsAt(git: GitRunner, root: string, sha: string, path: string, marker: string): Promise<boolean | null> {
  try { return (await git(root, ['show', `${sha}:${path}`])).includes(marker); }
  catch {
    try { return (await git(root, ['ls-tree', '--name-only', sha, '--', path])).trim() === '' ? false : null; }
    catch { return null; }
  }
}

/** main's tip as of `at` (first-parent history only: main moves by fast-forward). */
async function mainAt(git: GitRunner, root: string, at: string): Promise<string | null> {
  // Whole seconds: a fractional ISO stamp is not a format git's date parser documents.
  const before = at.replace(/\.\d+Z$/, 'Z');
  try { return (await git(root, ['rev-list', '-1', '--first-parent', `--before=${before}`, 'main'])).trim() || null; }
  catch { return null; }
}

// ── execution ──────────────────────────────────────────────────────────────────────

/** Execute one gate-repair-plane live reading against the operator database and record it. */
export async function executeGateRepairPlaneReading(
  reading: GateRepairPlaneReading,
  ctx: NativeCheckContext,
  deps?: {
    queries?: GateRepairPlaneQueries;
    git?: GitRunner;
    marker?: string;
    execution?: NativeCheckExecution;
  },
) {
  if (!GATE_REPAIR_PLANE_READINGS.includes(reading)) return { ok: false, error: 'unknown_reading' as const };
  const workspaceId = ctx.workspaceId?.trim();
  if (!workspaceId || workspaceId === '*') return { ok: false, error: 'workspace_required' as const };
  const queries = deps?.queries ?? defaultGateRepairPlaneQueries;
  const git = deps?.git ?? defaultGitRunner;
  const marker = deps?.marker ?? IDLE_ACTUATOR_PASS_MARKER;
  // The database unit is witnessed before execution, so identify the server first.
  let server: ServerIdentity;
  try { server = await queries.identity(); }
  catch { return { ok: false, error: 'operational_database_unavailable' as const }; }
  if (!server.database || !Number.isInteger(server.port) || server.port <= 0) {
    return { ok: false, error: 'operational_database_unavailable' as const };
  }
  const sameDatabase = (seen: ServerIdentity): Assertion => ({ id: 'scope:database-unchanged',
    passed: seen.database === server.database && seen.port === server.port,
    evidence: `witnessed ${server.database}@${server.port}; executed ${seen.database}@${seen.port}` });
  const r6 = reading === 'r6-pass-marker';
  return executeOperationalRun({ filePath: GATE_REPAIR_PLANE_CHECK_PATH,
    name: r6
      ? 'gate-repair-plane R-6: a bg-host repair pass record carries a marker main does not yet contain'
      : 'gate-repair-plane R-7: no selector-less release:repair-queue call is served by the release host',
    framework: 'operational',
    command: ['testing:record-native-check', 'gateRepairPlane', reading],
    runtimeUnits: [`postgres:${server.port}`],
    run: async () => {
      const assertions: Assertion[] = [];
      if (r6) {
        const root = await (deps?.execution?.sourceRoot ?? resolveOperationalSourceRoot)().catch(() => null);
        const { records, ...seen } = await queries.passMarkerRecords(workspaceId, marker);
        assertions.push(sameDatabase(seen));
        const containment: Record<string, boolean | null> = {};
        for (const sha of new Set(records.flatMap(record => record.executingBuildSha ? [record.executingBuildSha] : []))) {
          containment[sha] = root ? await containsAt(git, root, sha, IDLE_ACTUATOR_SOURCE_PATH, marker) : null;
        }
        const subject = findPassMarkerSubject(records, containment);
        const mainSha = subject && root ? await mainAt(git, root, subject.createdAt) : null;
        const mainAtSubject = subject
          ? { sha: mainSha, containsMarker: mainSha && root ? await containsAt(git, root, mainSha, IDLE_ACTUATOR_SOURCE_PATH, marker) : null }
          : null;
        assertions.push(...judgeRepairPassMarker({ marker, records, containment, mainAtSubject }));
      } else {
        const { cells, total, ...seen } = await queries.repairQueueServing(workspaceId, R7_WINDOW_START);
        assertions.push(sameDatabase(seen));
        assertions.push(...judgeRepairQueueServing({ cells, total }));
      }
      const failed = assertions.some(assertion => !assertion.passed);
      return { exitCode: failed ? 1 : 0, assertions,
        summary: failed ? `${reading} failed; inspect the recorded assertions.`
          : `${reading} passed in one read-only snapshot of ${server.database}@${server.port}.` };
    },
  }, ctx, deps?.execution);
}
