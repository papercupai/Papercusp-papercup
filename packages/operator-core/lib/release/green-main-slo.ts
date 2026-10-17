/**
 * green-main-slo — P-016 (green-main-cycle-time-2026-10-08, owner-approved D-021 fix 3).
 *
 * One PURE function turns the gate's own ledgers into the green-main SLO: six metrics, each
 * computed from a NAMED population, plus the breaches that must alert or page. IO lives with
 * the callers: the watchdog pass reads the inputs and delivers pages, and the /admin/git
 * snapshot renders the same object, so the page and the panel can never disagree.
 *
 * Populations (a metric computed from any other population is a defect, per AUTO-BAR-R-13):
 *  - timeSinceGreen   now − `gate_health.lastGreenAt` (the gate's last GREEN verdict).
 *  - timeSinceVerdict now − newest verdict-bearing green_checkpoint ledger row (green OR red).
 *  - roundCycleTime   gaps between consecutive `convergenceRounds[].atMs` of the live frozen
 *                     queue: how long one repair round takes, admission to next verdict.
 *  - queueIdle        the live queue's waits with NOTHING in flight, from `frozenRepairLatency`:
 *                     a red waiting for a fixer, or an admitted head waiting for its run to start.
 *                     Time spent inside a running suite is not idle and is not counted.
 *  - roundsToConverge the live queue's recorded rounds. While a queue is open it has NOT
 *                     converged, so the figure is "rounds so far" and says so (`converged:false`).
 *  - redAddingAdmissions  admissions whose next round recorded MORE failures than the round
 *                     before them. Attribution is per admission WINDOW (every admission between
 *                     two rounds shares that window's outcome); `attribution:'window'` says so.
 *  - perSyncRedRate   git-sync batches the sync-batch delta check judged red, over the batches
 *                     it judged (`syncTalliesFromDeltaCoverage`). Unjudged batches are in neither
 *                     count. One row per fleet when attributed; today one `fleet: null` row
 *                     covering every agent, because the check's ticks carry no agent (D-031).
 *
 * Pages (AUTO-BAR-R-14): main red ≥ 12h, or no verdict of any kind ≥ 6h. Each breach carries an
 * EPISODE key derived from the clock that started it (`lastGreenAt` / `lastVerdictAt`), so a
 * caller delivering through `notifyAttentionOnce({ dedupeKey })` pages exactly once per episode:
 * never zero times, never every tick (the 2026-10-06..08 flood was ~100 owner pages a day).
 */
import {
  frozenRepairLatency,
  type FrozenCandidateRepairQueue,
  type FrozenRepairLatencySource,
} from './frozen-candidate-repair-queue';
import type { GateNonVerdictReasons } from './gate-fire-ledger';
import { classifyGateOutcomeStatus, isGateFireId, VERDICT_BEARING_STATUSES } from './gate-fire-ledger';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';
import type { Sql } from 'postgres';
import type { FrozenRepairProgress } from './freeze-disposition';

const HOUR_MS = 60 * 60 * 1000;

/** R19's sealed join, prepared from original events, admission audits and run logs.
 * These fields are NOT a provenance certificate. Before grading, independently verify
 * every source reference, its immutable bytes, and the complete source census. In
 * particular, a phase display or a caller-authored join cannot prove execution.
 */
export interface GreenMainPreflightJoin {
  workspaceId: string;
  installSlug: string;
  windowStartMs: number;
  windowEndMs: number;
  population: {
    status: 'complete' | 'capped' | 'unavailable' | 'invalid';
    total: number | null;
    /** Hash of the retained original event/audit/log population, not current gate state. */
    sha256: string;
  };
  rounds: Array<{
    candidate: string;
    openedAtMs: number;
    round: number;
    previousHead: string;
    previousVerdictAtMs: number;
    head: string;
    verdictAtMs: number;
    snapshotId: string;
    checkpoint: {
      eventId: string;
      workspaceId: string;
      installSlug: string;
      head: string;
      runId: string;
      verdictAtMs: number;
      logRef: string;
      logSha256: string;
      /** Original execution/log identity; never a display-prefix expansion. */
      logHead: string;
      logRunId: string;
      /** The original log must establish passed/failed execution, not merely a stamp. */
      preflightStatus: 'passed' | 'failed' | 'skipped' | 'unknown';
      phases: Array<{ phase: string; ms: number }>;
    };
    admissions: Array<{
      fromRepairHead: string;
      toRepairHead: string;
      atMs: number;
      /** Reconciled-from-ref records are not original admissions. */
      provenance?: string;
    }>;
    /** Exactly one persisted original audit per admission; unmatched audits stay here. */
    audits: Array<{
      id: string;
      atMs: number;
      candidate: string;
      from: string;
      to: string;
      persisted: boolean;
      paths: string[];
      unchanged: string[];
    }>;
  }>;
}

/** Verify the already-sealed R19 join without reading or operating the live gate.
 * Missing/inconsistent evidence is unknown; only a completely qualified pair can
 * establish the duration outcome. This does not establish P035's implementation,
 * source authenticity, or any improvement over an earlier run.
 */
export function evaluateGreenMainPreflightJoin(input: GreenMainPreflightJoin, observedAtMs = Date.now()) {
  const fullHead = (value: string) => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
  const digest = (value: string) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0;
  const clock = (value: number) => Number.isSafeInteger(value) && value >= 0;
  const path = (value: string) => text(value) && value === value.trim() &&
    !value.includes('\\') && !value.includes('\0') && !value.startsWith('/') &&
    !/^[a-z]:/i.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  const reasons: string[] = [];
  if (!text(input.workspaceId) || !text(input.installSlug) || !clock(input.windowStartMs) ||
      !clock(input.windowEndMs) || input.windowStartMs >= input.windowEndMs ||
      !clock(observedAtMs) || input.windowEndMs > observedAtMs) reasons.push('invalid-scope-or-window');
  if (input.population.status !== 'complete' || input.population.total !== input.rounds.length ||
      input.rounds.length !== 2 || !digest(input.population.sha256)) reasons.push('incomplete-two-round-population');
  const eventIds = new Set<string>(), runIds = new Set<string>(), auditIds = new Set<string>();
  const measured: Array<{ round: number; head: string; admittedPaths: string[]; preflightMs: number }> = [];
  for (const round of input.rounds) {
    const checkpoint = round.checkpoint;
    if (!fullHead(round.candidate) || !fullHead(round.previousHead) || !fullHead(round.head) ||
        !clock(round.openedAtMs) || !clock(round.previousVerdictAtMs) || !clock(round.verdictAtMs) ||
        round.openedAtMs > round.previousVerdictAtMs || round.previousVerdictAtMs >= round.verdictAtMs ||
        round.verdictAtMs < input.windowStartMs || round.verdictAtMs > input.windowEndMs ||
        !Number.isSafeInteger(round.round) || round.round < 2 || !text(round.snapshotId)) {
      reasons.push('invalid-original-round');
    }
    if (!text(checkpoint.eventId) || eventIds.has(checkpoint.eventId) || !text(checkpoint.runId) ||
        runIds.has(checkpoint.runId) || checkpoint.workspaceId !== input.workspaceId ||
        checkpoint.installSlug !== input.installSlug || checkpoint.head !== round.head ||
        checkpoint.verdictAtMs !== round.verdictAtMs || checkpoint.logHead !== round.head ||
        checkpoint.logRunId !== checkpoint.runId || !text(checkpoint.logRef) || !digest(checkpoint.logSha256)) {
      reasons.push('checkpoint-log-identity-mismatch');
    }
    eventIds.add(checkpoint.eventId);
    runIds.add(checkpoint.runId);
    const phases = checkpoint.phases.filter(phase => phase.phase === 'early-typecheck-preflight');
    if (!['passed', 'failed'].includes(checkpoint.preflightStatus) || phases.length !== 1 ||
        !clock(phases[0]?.ms as number)) reasons.push('preflight-not-originally-measured');
    const paths = new Set<string>();
    const heads = new Set([round.previousHead]);
    let head = round.previousHead, admittedAtMs = round.previousVerdictAtMs;
    if (!round.admissions.length || round.audits.length !== round.admissions.length) reasons.push('non-bijective-admission-audits');
    for (const admission of round.admissions) {
      if (admission.provenance !== undefined || !clock(admission.atMs) || admission.atMs <= round.previousVerdictAtMs ||
          admission.atMs < admittedAtMs || admission.atMs > round.verdictAtMs ||
          admission.fromRepairHead !== head || !fullHead(admission.toRepairHead) || heads.has(admission.toRepairHead)) {
        reasons.push('broken-original-admission-chain');
      }
      const matches = round.audits.filter(audit => audit.candidate === round.candidate &&
        audit.from === admission.fromRepairHead && audit.to === admission.toRepairHead);
      if (matches.length !== 1) reasons.push('non-bijective-admission-audits');
      for (const audit of matches) {
        if (!text(audit.id) || auditIds.has(audit.id) || !audit.persisted || !clock(audit.atMs) ||
            audit.atMs < admission.atMs || audit.atMs > round.verdictAtMs ||
            !audit.paths.length || !audit.paths.every(path) || !audit.unchanged.every(path) ||
            new Set(audit.paths).size !== audit.paths.length || new Set(audit.unchanged).size !== audit.unchanged.length ||
            audit.unchanged.some(item => audit.paths.includes(item))) reasons.push('invalid-original-path-audit');
        auditIds.add(audit.id);
        for (const item of audit.paths) paths.add(item);
      }
      admittedAtMs = admission.atMs;
      head = admission.toRepairHead;
      heads.add(head);
    }
    if (head !== round.head) reasons.push('admission-chain-does-not-reach-verdict');
    if (phases.length === 1 && phases[0]!.ms > round.verdictAtMs - admittedAtMs) reasons.push('phase-exceeds-original-round-window');
    if (paths.size === 0 || paths.size > 20) reasons.push('admitted-path-population-outside-bar');
    measured.push({ round: round.round, head: round.head, admittedPaths: [...paths].sort(), preflightMs: phases[0]?.ms ?? NaN });
  }
  const [before, after] = input.rounds;
  if (!before || !after || before.candidate !== after.candidate || before.openedAtMs !== after.openedAtMs ||
      after.round !== before.round + 1 || after.previousHead !== before.head ||
      after.previousVerdictAtMs !== before.verdictAtMs) reasons.push('not-one-adjacent-repair-pair');
  const qualified = reasons.length === 0;
  const withinLimit = qualified && measured.every(round => round.preflightMs <= 600_000);
  return { verdict: !qualified ? 'unknown' as const : withinLimit ? 'healthy' as const : 'broken' as const,
    rounds: measured, reasons: [...new Set(reasons)], populationSha256: input.population.sha256,
    assertions: [
      { id: 'original-preflight-join-qualified', passed: qualified, evidence: reasons.join('; ') || 'Exact original adjacent pair, complete admission/audit and checkpoint/log identities.' },
      { id: 'two-small-repair-preflights-at-most-ten-minutes', passed: withinLimit,
        evidence: qualified ? measured.map(round => `round=${round.round}; paths=${round.admittedPaths.length}; preflight_ms=${round.preflightMs}`).join('; ') : 'unknown: original receipt join is incomplete' },
    ] };
}

/**
 * Native R12 receipt preparation: resolve the immutable full-file-set ABBA artifacts,
 * then record the exact manifest/pins/population under the existing native executor.
 * This does not launch a comparison or satisfy D020. Its input producer still needs
 * original full-gate selection, complete runtime closure and all four real cohorts.
 * Pure fixture proofs and historical 32-file calibration never supply those inputs.
 */
export async function executeGreenMainThroughputComparison(args: {
  workspaceId: string; harnessSlug: string; projectDir: string; runtimeUnits: string[];
  evidenceRoot: string;
  pins: import('../../../../scripts/lib/budgeted-task-scheduler.mjs').BudgetedTaskComparisonArtifactPins;
}) {
  // Pin the scope before even the dynamic imports yield. The executor brackets
  // execution asynchronously; a caller must not replace the original population
  // between its command receipt and the artifact reader's later IO.
  const input = { ...args, runtimeUnits: [...args.runtimeUnits], pins: structuredClone(args.pins) };
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  const { readBudgetedTaskComparisonArtifacts, evaluateBudgetedTaskComparison } =
    await import('../../../../scripts/lib/budgeted-task-scheduler.mjs');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/green-main-slo.ts',
    name: 'Original immutable full-gate throughput comparison', framework: 'operational',
    command: ['executeGreenMainThroughputComparison', input.workspaceId, input.harnessSlug,
      input.evidenceRoot, input.pins.manifest.ref, input.pins.manifest.sha256,
      input.pins.source.ref, input.pins.dependencies.ref, input.pins.runtimeClosure.ref,
      ...input.pins.cohorts.flatMap(pin => [pin.ref, pin.sha256])], runtimeUnits: input.runtimeUnits,
    run: async () => {
      const original = await readBudgetedTaskComparisonArtifacts(input.evidenceRoot, input.pins);
      const evaluation = evaluateBudgetedTaskComparison(original.manifest, original.cohorts);
      return { exitCode: evaluation.assertions.every(assertion => assertion.passed) ? 0 : 1,
        assertions: evaluation.assertions.map(assertion => ({ id: assertion.name, passed: assertion.passed,
          evidence: `manifest=${original.manifest.manifestSha256}; population=${original.populationSha256}` })),
        summary: `Original throughput artifacts: manifest_sha256=${original.manifest.manifestSha256}; ` +
          `file_set_sha256=${original.manifest.fileSetSha256}; original_population_sha256=${original.populationSha256}; ` +
          `files=${original.manifest.selection.files.length}; baseline_wall_ms=${evaluation.baselineWallMs}; ` +
          `candidate_wall_ms=${evaluation.candidateWallMs}; ratio=${evaluation.ratio}. ` +
          'No cohort launch or policy promotion; statistical semantics await complete outside-lineage BAR review.' };
    },
  }, input);
}

/** Original snapshots only; no current gate read, verdict or queue mutation. */
export async function readGreenMainRepairRoundWindow(sql: Sql,
  scope: { workspaceId: string; installSlug: string },
  window: { windowStartMs: number; windowEndMs: number; maxRows?: number }): Promise<PipelineEventWindowRead> {
  const { windowStartMs, windowEndMs } = window;
  const maxRows = window.maxRows ?? 10_000;
  const base = { windowStartMs, windowEndMs, total: null, rows: [] };
  if (!scope.workspaceId.trim() || !scope.installSlug.trim() ||
      !Number.isSafeInteger(windowStartMs) || windowStartMs < 0 ||
      !Number.isSafeInteger(windowEndMs) || windowStartMs >= windowEndMs ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
    return { ...base, status: 'invalid', reason: 'Exact scope, finite window and bounded population are required.' };
  }
  try {
    const rows = await sql<{ id: string; status: string; detail: Record<string, unknown>;
      created_at: Date | string; population_count: string | number }[]>`
      WITH predecessor AS (
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'green_checkpoint_repair_latency' AND created_at <= ${new Date(windowStartMs)}
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), population AS (
        SELECT * FROM predecessor
        UNION ALL
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'green_checkpoint_repair_latency'
          AND (created_at > ${new Date(windowStartMs)} OR
            (created_at = (SELECT created_at FROM predecessor) AND id > (SELECT id FROM predecessor)))
          AND created_at <= ${new Date(windowEndMs)}
      )
      SELECT id::text, status, detail, created_at, count(*) OVER () AS population_count
      FROM population ORDER BY created_at, id LIMIT ${maxRows + 1}`;
    const total = rows.length ? Number(rows[0]!.population_count) : 0;
    if (!Number.isSafeInteger(total) || total < rows.length ||
        (total <= maxRows && total !== rows.length) || rows.some(row => Number(row.population_count) !== total)) {
      return { ...base, status: 'unavailable', reason: 'Historical population count is inconsistent.' };
    }
    return { windowStartMs, windowEndMs, total, status: total > maxRows ? 'capped' : 'complete',
      reason: total > maxRows ? 'Historical population exceeds the row budget.' : null,
      rows: rows.slice(0, maxRows).map(row => ({ id: row.id, kind: 'green_checkpoint_repair_latency',
        status: row.status, detail: row.detail, createdAtMs: new Date(row.created_at).getTime() })) };
  } catch (error) {
    return { ...base, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Completed round intervals from original snapshots, matching the SLO panel's
 * consecutive-round population. Does not qualify an unfinished round, idle time,
 * alarm delivery, the seven-day soak or shipment. Missing legacy data stays unknown.
 */
export function evaluateGreenMainRepairRoundWindow(history: PipelineEventWindowRead, observedAtMs = Date.now()) {
  const windowValid = Number.isSafeInteger(history.windowStartMs) && history.windowStartMs >= 0 &&
    Number.isSafeInteger(history.windowEndMs) && history.windowEndMs > history.windowStartMs &&
    Number.isSafeInteger(observedAtMs) && observedAtMs >= history.windowEndMs;
  const complete = history.status === 'complete' && history.total === history.rows.length && history.rows.length > 0 &&
    new Set(history.rows.map(row => row.id)).size === history.rows.length;
  const cycles = new Map<string, Map<number, { round: number; head: string; atMs: number }>>();
  let qualified = complete;
  for (const row of history.rows) {
    const detail = row.detail;
    const progress = detail?.repairProgress as { phase?: unknown; rounds?: unknown } | undefined;
    const openedAtMs = (detail?.repairLatency as { stamps?: { openedAtMs?: unknown } } | undefined)?.stamps?.openedAtMs;
    if (!row.id?.trim() || row.kind !== 'green_checkpoint_repair_latency' ||
        !['converging', 'held', 'retired'].includes(row.status) ||
        !Number.isSafeInteger(row.createdAtMs) || row.createdAtMs > history.windowEndMs ||
        !Number.isSafeInteger(detail?.observedAtMs) || (detail.observedAtMs as number) > row.createdAtMs ||
        typeof detail?.candidate !== 'string' || !detail.candidate.trim() ||
        !Number.isSafeInteger(openedAtMs) || (openedAtMs as number) < 0 ||
        (openedAtMs as number) > (detail.observedAtMs as number) ||
        !['ready-to-test', 'awaiting-fixer', 'ready-to-verify', 'ready-to-promote', 'blocked'].includes(String(progress?.phase)) ||
        !Array.isArray(progress?.rounds)) { qualified = false; continue; }
    const key = JSON.stringify([detail.candidate, openedAtMs]);
    const rounds = cycles.get(key) ?? new Map();
    const snapshotOrdinals = new Set<number>();
    for (const raw of progress.rounds) {
      const round = raw as { round: number; head: string; atMs: number } | null;
      if (!round || !Number.isSafeInteger(round.round) || round.round < 1 ||
          snapshotOrdinals.has(round.round) || typeof round.head !== 'string' || !round.head.trim() ||
          !Number.isSafeInteger(round.atMs) || round.atMs < (openedAtMs as number) ||
          round.atMs > (detail.observedAtMs as number)) { qualified = false; continue; }
      snapshotOrdinals.add(round.round);
      const prior = rounds.get(round.round);
      if (prior && (prior.head !== round.head || prior.atMs !== round.atMs)) qualified = false;
      rounds.set(round.round, { round: round.round, head: round.head, atMs: round.atMs });
    }
    cycles.set(key, rounds);
  }
  const intervals: Array<{ cycle: string; fromRound: number; toRound: number; durationMs: number }> = [];
  for (const [cycle, rounds] of cycles) {
    const ordered = [...rounds.values()].sort((a, b) => a.round - b.round);
    if (!ordered.length || ordered[0]!.round !== 1) qualified = false;
    for (let i = 1; i < ordered.length; i++) {
      const before = ordered[i - 1]!, after = ordered[i]!;
      if (after.round !== before.round + 1 || after.atMs <= before.atMs) qualified = false;
      if (after.atMs >= history.windowStartMs && after.atMs <= history.windowEndMs) {
        intervals.push({ cycle, fromRound: before.round, toRound: after.round, durationMs: after.atMs - before.atMs });
      }
    }
  }
  const admissible = windowValid && complete && qualified && intervals.length > 0;
  return { intervals, eventIds: history.rows.map(row => row.id), assertions: [
    { id: 'bounded-repair-round-window', passed: windowValid, evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}; observed=${observedAtMs}` },
    { id: 'complete-repair-round-population', passed: complete, evidence: `read=${history.status}; population=${history.total}; rows=${history.rows.length}` },
    { id: 'original-consecutive-repair-rounds', passed: complete && qualified, evidence: 'Original queue identity, ordinal and clock; missing/capped/conflicting snapshots do not qualify.' },
    { id: 'nonempty-completed-repair-rounds', passed: admissible, evidence: `intervals=${intervals.length}` },
    { id: 'completed-repair-rounds-at-most-45min', passed: admissible && intervals.every(round => round.durationMs <= 45 * 60_000), evidence: `max=${intervals.length ? Math.max(...intervals.map(round => round.durationMs)) : 'unknown'}ms` },
  ] };
}

/**
 * Admission-to-verdict clocks, distinct from the panel's consecutive-red gaps.
 * Pending work stays in the population; retirement never manufactures a verdict.
 * An open queue needs an original observation at the window end, with no grace tick.
 */
export function evaluateGreenMainAdmissionWindow(history: PipelineEventWindowRead, observedAtMs = Date.now()) {
  const roundEvaluation = evaluateGreenMainRepairRoundWindow(history, observedAtMs);
  const bounded = roundEvaluation.assertions[0]!.passed;
  const complete = roundEvaluation.assertions[1]!.passed;
  let original = roundEvaluation.assertions[2]!.passed;
  const cycles = new Map<string, { candidate: string; openedAtMs: number;
    admissions: Map<string, { atMs: number; fromRepairHead: string; toRepairHead: string }>;
    verdicts: Map<string, { head: string; atMs: number; ordinal: number }>;
    latest: { observedAtMs: number; terminal: boolean; retired: boolean; heads: string[] };
  }>();
  const rows = [...history.rows].sort((a, b) => a.createdAtMs - b.createdAtMs);
  for (const row of rows) {
    const progress = row.detail?.repairProgress as FrozenRepairProgress | undefined;
    const chain = progress?.admissionHistory;
    const openedAtMs = (row.detail?.repairLatency as { stamps?: { openedAtMs?: number } } | undefined)?.stamps?.openedAtMs;
    const candidate = row.detail?.candidate;
    const at = row.detail?.observedAtMs;
    if (!chain || chain.version !== 1 || typeof chain.repairHead !== 'string' || !chain.repairHead.trim() ||
        !Array.isArray(chain.admissions) || !Array.isArray(progress?.rounds) ||
        typeof candidate !== 'string' || !candidate.trim() || !Number.isSafeInteger(openedAtMs) ||
        !Number.isSafeInteger(at)) { original = false; continue; }
    const key = JSON.stringify([candidate, openedAtMs]);
    const heads = [candidate];
    let priorAt = openedAtMs as number;
    let chainValid = true;
    for (const admission of chain.admissions) {
      if (!admission || !Number.isSafeInteger(admission.atMs) || admission.atMs < priorAt || admission.atMs > (at as number) ||
          admission.fromRepairHead !== heads[heads.length - 1] ||
          typeof admission.toRepairHead !== 'string' || !admission.toRepairHead.trim() ||
          heads.includes(admission.toRepairHead) || admission.provenance !== undefined) { chainValid = false; break; }
      priorAt = admission.atMs;
      heads.push(admission.toRepairHead);
    }
    if (!chainValid || heads[heads.length - 1] !== chain.repairHead) { original = false; continue; }
    const terminal = row.status === 'retired' || progress.phase === 'ready-to-promote';
    const cycle = cycles.get(key) ?? { candidate, openedAtMs: openedAtMs as number,
      admissions: new Map(), verdicts: new Map(),
      latest: { observedAtMs: at as number, terminal, retired: row.status === 'retired', heads },
    };
    if ((at as number) < cycle.latest.observedAtMs ||
        (cycle.latest.terminal && !terminal) || cycle.latest.heads.some((head, i) => heads[i] !== head)) original = false;
    for (const admission of chain.admissions) {
      const prior = cycle.admissions.get(admission.toRepairHead);
      if (prior && (prior.atMs !== admission.atMs || prior.fromRepairHead !== admission.fromRepairHead)) original = false;
      cycle.admissions.set(admission.toRepairHead, admission);
    }
    for (const verdict of progress.rounds) {
      if (!verdict || !Number.isSafeInteger(verdict.atMs) || !Number.isSafeInteger(verdict.round) ||
          typeof verdict.head !== 'string') { original = false; continue; }
      if (!heads.includes(verdict.head) ||
          verdict.atMs < (chain.admissions.find(a => a.toRepairHead === verdict.head)?.atMs ?? (openedAtMs as number))) original = false;
      cycle.verdicts.set(JSON.stringify([verdict.head, verdict.atMs]), { head: verdict.head, atMs: verdict.atMs, ordinal: verdict.round });
    }
    if (progress.phase === 'ready-to-promote') {
      const verdictAt = (row.detail.repairLatency as { stamps?: { lastVerdictAtMs?: unknown } })?.stamps?.lastVerdictAtMs;
      if (!Number.isSafeInteger(verdictAt) || (verdictAt as number) < priorAt || (verdictAt as number) > (at as number)) original = false;
      else cycle.verdicts.set(JSON.stringify([chain.repairHead, verdictAt]), { head: chain.repairHead, atMs: verdictAt as number,
        ordinal: Math.max(0, ...progress.rounds.filter(r => r && Number.isSafeInteger(r.round)).map(r => r.round)) + 1 });
    }
    cycle.latest = { observedAtMs: at as number, terminal, retired: row.status === 'retired', heads };
    cycles.set(key, cycle);
  }
  const admissions: Array<{ cycle: string; head: string; admittedAtMs: number;
    verdictHead: string | null; verdictRound: number | null; verdictAtMs: number | null; durationMs: number; pending: boolean }> = [];
  let endCovered = cycles.size > 0;
  for (const [key, cycle] of cycles) {
    if (!cycle.latest.terminal && cycle.latest.observedAtMs < history.windowEndMs) endCovered = false;
    if (cycle.latest.retired && cycle.latest.observedAtMs < history.windowStartMs) continue;
    for (const admission of cycle.admissions.values()) {
      const index = cycle.latest.heads.indexOf(admission.toRepairHead);
      const verdict = [...cycle.verdicts.values()].filter(v => v.atMs >= admission.atMs &&
        cycle.latest.heads.indexOf(v.head) >= index).sort((a, b) => a.atMs - b.atMs)[0];
      if (verdict && verdict.atMs < history.windowStartMs) continue;
      admissions.push({ cycle: key, head: admission.toRepairHead, admittedAtMs: admission.atMs,
        verdictHead: verdict?.head ?? null, verdictRound: verdict?.ordinal ?? null, verdictAtMs: verdict?.atMs ?? null, pending: !verdict,
        durationMs: (verdict?.atMs ?? (cycle.latest.retired ? cycle.latest.observedAtMs : history.windowEndMs)) - admission.atMs });
    }
  }
  const admissible = bounded && complete && original && endCovered && admissions.length > 0;
  // Several admissions before one verdict constitute ONE round. Counting each
  // admission would let one tested batch satisfy the five-consecutive-round bar.
  const completedRounds = new Map<string, { cycle: string; ordinal: number; durationMs: number }>();
  for (const admission of admissions.filter(a => !a.pending)) {
    const key = JSON.stringify([admission.cycle, admission.verdictHead, admission.verdictAtMs]);
    const prior = completedRounds.get(key);
    completedRounds.set(key, { cycle: admission.cycle, ordinal: admission.verdictRound!,
      durationMs: Math.max(prior?.durationMs ?? 0, admission.durationMs) });
  }
  const fiveConsecutive = [...cycles.keys()].some(key => {
    const ordinals = [...completedRounds.values()].filter(r => r.cycle === key).map(r => r.ordinal).sort((a, b) => a - b);
    let streak = 0;
    return ordinals.some((ordinal, i) => {
      streak = i > 0 && ordinal === ordinals[i - 1]! + 1 ? streak + 1 : 1;
      return streak >= 5;
    });
  });
  const durations = [...completedRounds.values()].map(round => round.durationMs).sort((a, b) => a - b);
  const medianMs = durations.length ? (durations[Math.floor((durations.length - 1) / 2)]! + durations[Math.floor(durations.length / 2)]!) / 2 : null;
  return { admissions, completedRounds: [...completedRounds.values()], medianMs, eventIds: history.rows.map(row => row.id), assertions: [
    { id: 'bounded-admission-window', passed: bounded, evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}` },
    { id: 'complete-admission-snapshot-population', passed: complete, evidence: `read=${history.status}; rows=${history.rows.length}; total=${history.total}` },
    { id: 'original-complete-admission-chains', passed: complete && original, evidence: 'Exact original head chain and clocks; legacy, reconstructed, trimmed and conflicting history fails.' },
    { id: 'admission-lifetimes-cover-window-end', passed: endCovered, evidence: 'Each queue has an original terminal or end observation; retirement does not imply a verdict.' },
    { id: 'nonempty-admission-round-population', passed: admissible, evidence: `admissions=${admissions.length}` },
    { id: 'admission-rounds-at-most-45min', passed: admissible && admissions.every(a => a.durationMs <= 45 * 60_000), evidence: `pending=${admissions.filter(a => a.pending).length}` },
    { id: 'all-admission-rounds-have-verdicts', passed: admissible && admissions.every(a => !a.pending), evidence: 'Unfinished or retired work remains explicit.' },
    { id: 'at-least-five-consecutive-admission-rounds', passed: admissible && fiveConsecutive, evidence: 'Five distinct, consecutive completed verdict ordinals in one unbroken queue chain.' },
    { id: 'admission-round-median-at-most-45min', passed: admissible && medianMs !== null && medianMs <= 45 * 60_000, evidence: `median=${medianMs ?? 'unknown'}ms` },
  ] };
}

export async function executeGreenMainAdmissionWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/green-main-slo.ts',
    name: 'Original admission-to-verdict and pending-round history', framework: 'operational',
    command: ['executeGreenMainAdmissionWindow', args.workspaceId, args.installSlug, String(args.windowStartMs), String(args.windowEndMs)],
    runtimeUnits: args.runtimeUnits, run: async () => {
      const history = await readGreenMainRepairRoundWindow(sql, args, args);
      const evaluation = evaluateGreenMainAdmissionWindow(history);
      return { exitCode: evaluation.assertions.every(a => a.passed) ? 0 : 1, assertions: evaluation.assertions,
        summary: `Original admission population: ${evaluation.admissions.length}; window=${args.windowStartMs}..${args.windowEndMs}; ` +
          `original_population_sha256=${createHash('sha256').update(JSON.stringify(history)).digest('hex')}. ` +
          'No current-gate operation, idle-actuator, alarm-delivery, seven-day or shipment claim.' };
    },
  }, args);
}

export async function executeGreenMainRepairRoundWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/green-main-slo.ts',
    name: 'Original completed repair-round history', framework: 'operational',
    command: ['executeGreenMainRepairRoundWindow', args.workspaceId, args.installSlug,
      String(args.windowStartMs), String(args.windowEndMs)], runtimeUnits: args.runtimeUnits,
    run: async () => {
      const history = await readGreenMainRepairRoundWindow(sql, args, args);
      const evaluation = evaluateGreenMainRepairRoundWindow(history);
      return { exitCode: evaluation.assertions.every(assertion => assertion.passed) ? 0 : 1,
        assertions: evaluation.assertions,
        summary: `Completed round history only: workspace=${args.workspaceId}; install=${args.installSlug}; ` +
          `window=${args.windowStartMs}..${args.windowEndMs}; intervals=${evaluation.intervals.length}; ` +
          `original_population_sha256=${createHash('sha256').update(JSON.stringify(history)).digest('hex')}. ` +
          'Open rounds, idle actuators, alarms and shipment require separate evidence.' };
    },
  }, args);
}

/** Original red-to-green history only. This never reads or operates the current gate. */
export async function readGreenMainRecoveryWindow(sql: Sql,
  scope: { workspaceId: string; installSlug: string },
  window: { windowStartMs: number; windowEndMs: number; maxRows?: number }): Promise<PipelineEventWindowRead> {
  const { windowStartMs, windowEndMs } = window;
  const maxRows = window.maxRows ?? 10_000;
  const base = { windowStartMs, windowEndMs, total: null, rows: [] };
  if (!scope.workspaceId.trim() || !scope.installSlug.trim() ||
      !Number.isSafeInteger(windowStartMs) || windowStartMs < 0 ||
      !Number.isSafeInteger(windowEndMs) || windowStartMs >= windowEndMs ||
      !Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 50_000) {
    return { ...base, status: 'invalid', reason: 'Exact scope, finite window and bounded population are required.' };
  }
  const greenStatuses = VERDICT_BEARING_STATUSES.filter(status => classifyGateOutcomeStatus(status) === 'verdict-green');
  try {
    // Start at the last green, not the last verdict: repeated reds must not
    // shorten a boundary-crossing outage. Count and rows share one snapshot.
    const rows = await sql<{ id: string; status: string; detail: Record<string, unknown>;
      created_at: Date | string; population_count: string | number }[]>`
      WITH predecessor AS (
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'green_checkpoint' AND status = ANY(${greenStatuses}::text[])
          AND created_at <= ${new Date(windowStartMs)}
        ORDER BY created_at DESC, id DESC LIMIT 1
      ), population AS (
        SELECT * FROM predecessor
        UNION ALL
        SELECT id, status, detail, created_at FROM harness_shared.pipeline_events
        WHERE workspace_id = ${scope.workspaceId} AND install_slug = ${scope.installSlug}
          AND kind = 'green_checkpoint'
          AND (created_at > COALESCE((SELECT created_at FROM predecessor), ${new Date(windowStartMs)})
            OR (created_at = (SELECT created_at FROM predecessor) AND id > (SELECT id FROM predecessor)))
          AND created_at <= ${new Date(windowEndMs)}
      )
      SELECT id::text, status, detail, created_at, count(*) OVER () AS population_count
      FROM population ORDER BY created_at, id LIMIT ${maxRows + 1}`;
    const total = rows.length ? Number(rows[0]!.population_count) : 0;
    if (!Number.isSafeInteger(total) || total < rows.length ||
        (total <= maxRows && total !== rows.length) || rows.some(row => Number(row.population_count) !== total)) {
      return { ...base, status: 'unavailable', reason: 'Historical population count is inconsistent.' };
    }
    return { windowStartMs, windowEndMs, total, status: total > maxRows ? 'capped' : 'complete',
      reason: total > maxRows ? 'Historical population exceeds the row budget.' : null,
      rows: rows.slice(0, maxRows).map(row => ({ id: row.id, kind: 'green_checkpoint', status: row.status,
        detail: row.detail, createdAtMs: new Date(row.created_at).getTime() })) };
  } catch (error) {
    return { ...base, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Goal's recovery-time portion. Median defines typical and nearest-rank defines p90;
 * those statistical choices still require the pending outside-lineage BAR review.
 * No repair-round, idle-actuator, alarm, invariant-soak or shipment assertion is implied.
 */
export function evaluateGreenMainRecoveryWindow(history: PipelineEventWindowRead, observedAtMs = Date.now()) {
  const order = (a: PipelineEventWindowRead['rows'][number], b: PipelineEventWindowRead['rows'][number]) =>
    a.createdAtMs - b.createdAtMs || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  const rows = [...history.rows].sort(order);
  const windowValid = Number.isSafeInteger(history.windowStartMs) && history.windowStartMs >= 0 &&
    Number.isSafeInteger(history.windowEndMs) && history.windowEndMs > history.windowStartMs &&
    Number.isSafeInteger(observedAtMs) && observedAtMs >= history.windowEndMs;
  const complete = history.status === 'complete' && history.total === rows.length && rows.length > 0 &&
    new Set(rows.map(row => row.id)).size === rows.length && rows.every(row =>
      typeof row.id === 'string' && row.id.trim().length > 0 && row.kind === 'green_checkpoint' &&
      Number.isSafeInteger(row.createdAtMs) && row.createdAtMs >= 0 && row.createdAtMs <= history.windowEndMs);
  const groups = new Map<string, typeof rows>();
  let qualified = complete;
  for (const row of rows) {
    const fireId = row.detail?.gateFireId;
    if (!isGateFireId(fireId) || classifyGateOutcomeStatus(row.status) === 'unknown') { qualified = false; continue; }
    const group = groups.get(fireId) ?? [];
    group.push(row); groups.set(fireId, group);
  }
  const verdicts: typeof rows = [];
  for (const group of groups.values()) {
    const measured = group.filter(row => ['verdict-red', 'verdict-green', 'promotion-failed'].includes(classifyGateOutcomeStatus(row.status)));
    // A scheduled fallback may repeat a producer's terminal receipt. Collapse
    // only identical measured run/source/status; conflicting receipts stay red.
    const identities = measured.map(row => JSON.stringify([row.status, row.detail.runId, row.detail.candidate,
      row.detail.frozenCandidate, row.detail.repairHead, row.detail.verdictProvenance]));
    if (new Set(identities).size > 1) qualified = false;
    if (measured.length) verdicts.push(measured[0]!);
  }
  verdicts.sort(order);
  const boundaryKnown = verdicts.length > 0 && verdicts[0]!.createdAtMs <= history.windowStartMs &&
    classifyGateOutcomeStatus(verdicts[0]!.status) === 'verdict-green';
  const episodes: Array<{ redEventId: string; greenEventId: string; redAtMs: number; greenAtMs: number; durationMs: number }> = [];
  let openRed: (typeof rows)[number] | undefined;
  for (const row of verdicts) {
    const cls = classifyGateOutcomeStatus(row.status);
    if (cls === 'verdict-red') openRed ??= row;
    else if (cls === 'verdict-green' && openRed) {
      episodes.push({ redEventId: openRed.id, greenEventId: row.id, redAtMs: openRed.createdAtMs,
        greenAtMs: row.createdAtMs, durationMs: row.createdAtMs - openRed.createdAtMs });
      openRed = undefined;
    }
  }
  const durations = episodes.map(episode => episode.durationMs).sort((a, b) => a - b);
  const medianMs = median(durations);
  const p90Ms = durations.length ? durations[Math.ceil(durations.length * 0.9) - 1]! : null;
  const admissible = windowValid && complete && qualified && boundaryKnown && !openRed && episodes.length > 0;
  return { episodes, openRedEventId: openRed?.id ?? null, medianMs, p90Ms, eventIds: rows.map(row => row.id), assertions: [
    { id: 'bounded-recovery-window', passed: windowValid, evidence: `start=${history.windowStartMs}; end=${history.windowEndMs}; observed=${observedAtMs}` },
    { id: 'complete-recovery-population', passed: complete, evidence: `read=${history.status}; population=${history.total}; rows=${rows.length}; ${history.reason ?? 'no read error'}` },
    { id: 'qualified-recovery-verdicts', passed: complete && qualified, evidence: 'Original fire identities and known statuses; duplicate measured receipts must agree.' },
    { id: 'recovery-left-boundary-known', passed: complete && qualified && boundaryKnown, evidence: `predecessor=${verdicts[0]?.id ?? 'none'}` },
    { id: 'all-red-episodes-closed', passed: complete && qualified && boundaryKnown && !openRed, evidence: `open-red=${openRed?.id ?? 'none'}` },
    { id: 'nonempty-recovery-sample', passed: admissible, evidence: `episodes=${episodes.length}` },
    { id: 'recovery-median-at-most-4h', passed: admissible && medianMs !== null && medianMs <= 4 * HOUR_MS, evidence: `median=${medianMs ?? 'unknown'}ms; episodes=${episodes.length}` },
    { id: 'recovery-p90-at-most-8h', passed: admissible && p90Ms !== null && p90Ms <= 8 * HOUR_MS, evidence: `nearest-rank-p90=${p90Ms ?? 'unknown'}ms; episodes=${episodes.length}` },
  ] };
}

/** Fresh native measurement of archived recovery history, with original population identity. */
export async function executeGreenMainRecoveryWindow(sql: Sql, args: {
  workspaceId: string; harnessSlug: string; projectDir: string; installSlug: string;
  runtimeUnits: string[]; windowStartMs: number; windowEndMs: number;
}) {
  const { createHash } = await import('node:crypto');
  const { executeOperationalRun } = await import('../agent-tools/testing/record-run');
  return executeOperationalRun({ filePath: 'packages/operator-core/lib/release/green-main-slo.ts',
    name: 'Original red-to-green recovery history', framework: 'operational',
    command: ['executeGreenMainRecoveryWindow', args.workspaceId, args.installSlug,
      String(args.windowStartMs), String(args.windowEndMs)], runtimeUnits: args.runtimeUnits,
    run: async () => {
      const history = await readGreenMainRecoveryWindow(sql, args, args);
      const evaluation = evaluateGreenMainRecoveryWindow(history);
      return { exitCode: evaluation.assertions.every(assertion => assertion.passed) ? 0 : 1,
        assertions: evaluation.assertions,
        summary: `Recovery history only: workspace=${args.workspaceId}; install=${args.installSlug}; ` +
          `window=${args.windowStartMs}..${args.windowEndMs}; episodes=${evaluation.episodes.length}; ` +
          `original_population_sha256=${createHash('sha256').update(JSON.stringify(history)).digest('hex')}; ` +
          `first=${evaluation.eventIds[0] ?? 'none'}; last=${evaluation.eventIds.at(-1) ?? 'none'}. ` +
          'Median/nearest-rank semantics await BAR review; other runtime targets require separate evidence.' };
    },
  }, args);
}

/** SLO thresholds. Pages are the owner-approved D-021 values; the alert targets are D-030. */
export const GREEN_MAIN_SLO_DEFAULTS = {
  /** Owner page: main has had no green verdict for this long. */
  redPageMs: 12 * HOUR_MS,
  /** Owner page: the gate has rendered no verdict of any kind for this long. */
  noVerdictPageMs: 6 * HOUR_MS,
  /** Alert: the newest repair round took longer than this. */
  roundCycleAlertMs: 2 * HOUR_MS,
  /** Alert: the live queue has sat idle (nothing in flight) longer than this. */
  queueIdleAlertMs: 1 * HOUR_MS,
  /** Alert: a fleet's per-sync red rate exceeds this fraction... */
  perSyncRedRateAlert: 0.2,
  /** ...over at least this many judged batches (one red in two batches is not a rate). */
  perSyncRedMinBatches: 5,
  /** P-029: repeated terminal skips/aborts of one reason in a rolling day. */
  nonVerdictReasonMinCount: 6,
} as const;

export type GreenMainSloThresholds = { -readonly [K in keyof typeof GREEN_MAIN_SLO_DEFAULTS]?: number };

/** The live frozen queue fields the SLO reads. A full `FrozenCandidateRepairQueue` satisfies it. */
export type GreenMainSloQueue = FrozenRepairLatencySource &
  Pick<FrozenCandidateRepairQueue, 'candidate'> &
  Partial<Pick<FrozenCandidateRepairQueue, 'admissions'>>;

/** One fleet's sync-batch tally from the sync-batch delta check. `fleet: null` = no fleet. */
export interface SyncBatchFleetTally {
  fleet: string | null;
  /** Newest measured judged-batch clock; missing clocks cannot establish recovery. */
  observedAtMs?: number;
  /** Batches the check judged (evaluated green or red). */
  judgedBatches: number;
  /** Of those, batches it judged red. */
  redBatches: number;
}

/**
 * Per-sync tallies from the sync-batch delta check's OWN coverage ledger
 * (`routines(name='sync-batch-delta-check').metadata.sync_delta.coverage.ticks`, 24h retention).
 * A judged batch is a tick whose status is `green` or `red`; every other status (skipped,
 * up-to-date, nothing-selected, radius-too-wide, leg-timeout, missed-opportunity) judged no
 * change and is in neither count. Ticks carry no agent attribution, so the tally covers every
 * agent (`fleet: null`); a per-fleet split needs the check to record each window's
 * Papercusp-Agent trailers (D-031). Null when the ledger is absent or malformed: unknown, never [].
 */
export function syncTalliesFromDeltaCoverage(syncDelta: unknown): SyncBatchFleetTally[] | null {
  if (!syncDelta || typeof syncDelta !== 'object') return null;
  const coverage = (syncDelta as { coverage?: unknown }).coverage;
  if (!coverage || typeof coverage !== 'object') return null;
  const ticks = (coverage as { ticks?: unknown }).ticks;
  if (!Array.isArray(ticks)) return null;
  let judgedBatches = 0;
  let redBatches = 0;
  let observedAtMs: number | undefined;
  let clocksComplete = true;
  for (const tick of ticks) {
    const status = tick && typeof tick === 'object' ? (tick as { status?: unknown }).status : undefined;
    if (status !== 'green' && status !== 'red') continue;
    judgedBatches += 1;
    if (status === 'red') redBatches += 1;
    const atMs = (tick as { atMs?: unknown }).atMs;
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs <= 0) clocksComplete = false;
    else observedAtMs = Math.max(observedAtMs ?? 0, atMs);
  }
  return [{ fleet: null, judgedBatches, redBatches,
    ...(clocksComplete && observedAtMs !== undefined ? { observedAtMs } : {}) }];
}

export interface GreenMainSloInput {
  installSlug: string;
  nowMs: number;
  /** `gate_health.lastGreenAt`; null when the gate has never recorded a green. */
  lastGreenAtMs: number | null;
  /** Newest verdict-bearing green_checkpoint ledger row (green or red); null when none. */
  lastVerdictAtMs: number | null;
  /** The live frozen repair queue, or null when none is open. */
  queue: GreenMainSloQueue | null;
  /** Per-fleet sync tallies over the delta check's retained window; omit when unreadable. */
  syncTallies?: readonly SyncBatchFleetTally[] | null;
  nonVerdictReasons?: GateNonVerdictReasons | null;
}

export interface PerSyncRedRate {
  fleet: string | null;
  judgedBatches: number;
  redBatches: number;
  /** redBatches / judgedBatches; null when nothing was judged. */
  rate: number | null;
}

export interface RedAddingAdmissions {
  /** Admissions whose window ended in a round with more failures than the round before it. */
  count: number;
  /** Admissions that have a following round to judge them (the denominator). */
  judged: number;
  /** `toRepairHead` of each red-adding admission, oldest first. */
  heads: string[];
  attribution: 'window';
}

export interface GreenMainSloMetrics {
  timeSinceGreenMs: number | null;
  timeSinceVerdictMs: number | null;
  roundCycleTime: { lastMs: number | null; medianMs: number | null; intervals: number };
  queueIdleMs: number | null;
  roundsToConverge: { rounds: number; converged: false } | null;
  redAddingAdmissions: RedAddingAdmissions | null;
  /** null when the sync tallies were unreadable — never an empty list standing in for "unknown". */
  perSyncRedRate: PerSyncRedRate[] | null;
  nonVerdictReasons: GateNonVerdictReasons | null;
}

export type GreenMainSloBreachMetric =
  | 'time-since-green'
  | 'time-since-verdict'
  | 'round-cycle-time'
  | 'queue-idle'
  | 'red-adding-admission'
  | 'per-sync-red-rate'
  | 'non-verdict-reason';

export interface GreenMainSloBreach {
  metric: GreenMainSloBreachMetric;
  /** Exact queue or fleet subject; independent of the legacy notification episode key. */
  subject?: string | null;
  /** `page` = owner page (notifyAttention); `alert` = attention item at normal importance. */
  severity: 'page' | 'alert';
  value: number;
  threshold: number;
  /** Stable for one breach episode: the dedupe key a once-only delivery must use. */
  episodeKey: string;
  title: string;
  detail: string;
}

export interface GreenMainSlo {
  installSlug: string;
  computedAtMs: number;
  metrics: GreenMainSloMetrics;
  breaches: GreenMainSloBreach[];
  thresholds: typeof GREEN_MAIN_SLO_DEFAULTS;
}

const hours = (ms: number): string => `${(ms / HOUR_MS).toFixed(1)}h`;

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function redAddingAdmissions(queue: GreenMainSloQueue): RedAddingAdmissions {
  const rounds = [...(queue.convergenceRounds ?? [])].sort((a, b) => a.atMs - b.atMs);
  const admissions = [...(queue.admissions ?? [])].sort((a, b) => a.atMs - b.atMs);
  const heads: string[] = [];
  let judged = 0;
  for (const admission of admissions) {
    const before = rounds.filter((r) => r.atMs <= admission.atMs).at(-1);
    const after = rounds.find((r) => r.atMs > admission.atMs);
    if (!before || !after) continue;
    judged += 1;
    if (after.failingCount > before.failingCount) heads.push(admission.toRepairHead);
  }
  return { count: heads.length, judged, heads, attribution: 'window' };
}

export function computeGreenMainSlo(input: GreenMainSloInput, thresholds: GreenMainSloThresholds = {}): GreenMainSlo {
  const t = { ...GREEN_MAIN_SLO_DEFAULTS, ...thresholds } as typeof GREEN_MAIN_SLO_DEFAULTS;
  const { nowMs, queue, installSlug } = input;

  const timeSinceGreenMs = input.lastGreenAtMs === null ? null : Math.max(0, nowMs - input.lastGreenAtMs);
  const timeSinceVerdictMs = input.lastVerdictAtMs === null ? null : Math.max(0, nowMs - input.lastVerdictAtMs);

  const roundTimes = [...(queue?.convergenceRounds ?? [])].map((r) => r.atMs).sort((a, b) => a - b);
  const intervals = roundTimes.slice(1).map((at, i) => at - roundTimes[i]);
  const roundCycleTime = { lastMs: intervals.at(-1) ?? null, medianMs: median(intervals), intervals: intervals.length };

  let queueIdleMs: number | null = null;
  if (queue) {
    const latency = frozenRepairLatency(queue, nowMs);
    queueIdleMs = latency.redAwaitingFixerMs ?? latency.admitAwaitingResumeRunStartMs ?? 0;
  }

  const roundsToConverge = queue
    ? { rounds: (queue.convergenceRounds ?? []).reduce((max, r) => Math.max(max, r.round), 0), converged: false as const }
    : null;
  const admissions = queue ? redAddingAdmissions(queue) : null;

  const perSyncRedRate =
    input.syncTallies == null
      ? null
      : input.syncTallies.map((tally) => ({
          fleet: tally.fleet,
          judgedBatches: tally.judgedBatches,
          redBatches: tally.redBatches,
          rate: tally.judgedBatches > 0 ? tally.redBatches / tally.judgedBatches : null,
        }));

  const breaches: GreenMainSloBreach[] = [];
  const key = (metric: GreenMainSloBreachMetric, episode: string | number): string =>
    `green-main-slo:${installSlug}:${metric}:${episode}`;

  if (timeSinceGreenMs !== null && input.lastGreenAtMs !== null && timeSinceGreenMs >= t.redPageMs) {
    breaches.push({
      metric: 'time-since-green',
      severity: 'page',
      value: timeSinceGreenMs,
      threshold: t.redPageMs,
      episodeKey: key('time-since-green', input.lastGreenAtMs),
      title: `Main has been red ${hours(timeSinceGreenMs)} on ${installSlug}`,
      detail: `No green verdict since ${new Date(input.lastGreenAtMs).toISOString()} (SLO page at ${hours(t.redPageMs)}).`,
    });
  }
  // A gate that has never rendered a verdict is a fresh install, not a silent gate (the same
  // rule the stall watchdog follows); only a verdict that existed and then stopped pages.
  if (timeSinceVerdictMs !== null && input.lastVerdictAtMs !== null && timeSinceVerdictMs >= t.noVerdictPageMs) {
    breaches.push({
      metric: 'time-since-verdict',
      severity: 'page',
      value: timeSinceVerdictMs,
      threshold: t.noVerdictPageMs,
      episodeKey: key('time-since-verdict', input.lastVerdictAtMs),
      title: `No gate verdict for ${hours(timeSinceVerdictMs)} on ${installSlug}`,
      detail: `The gate has rendered no verdict (green or red) since ${new Date(input.lastVerdictAtMs).toISOString()} (SLO page at ${hours(t.noVerdictPageMs)}).`,
    });
  }
  if (queue && roundCycleTime.lastMs !== null && roundCycleTime.lastMs > t.roundCycleAlertMs) {
    const lastRound = (queue.convergenceRounds ?? []).reduce((max, r) => Math.max(max, r.round), 0);
    breaches.push({
      metric: 'round-cycle-time',
      subject: queue.candidate,
      severity: 'alert',
      value: roundCycleTime.lastMs,
      threshold: t.roundCycleAlertMs,
      episodeKey: key('round-cycle-time', `${queue.candidate}:${lastRound}`),
      title: `Repair round ${lastRound} took ${hours(roundCycleTime.lastMs)} on ${installSlug}`,
      detail: `Frozen candidate ${queue.candidate.slice(0, 12)}: the newest round interval exceeds the ${hours(t.roundCycleAlertMs)} target.`,
    });
  }
  if (queue && queueIdleMs !== null && queueIdleMs > t.queueIdleAlertMs) {
    const latency = frozenRepairLatency(queue, nowMs);
    const idleSince = latency.redAwaitingFixerMs !== null ? latency.stamps.lastRedAtMs : latency.stamps.lastAdmittedAtMs;
    breaches.push({
      metric: 'queue-idle',
      subject: queue.candidate,
      severity: 'alert',
      value: queueIdleMs,
      threshold: t.queueIdleAlertMs,
      episodeKey: key('queue-idle', `${queue.candidate}:${idleSince ?? 'unknown'}`),
      title: `Frozen repair queue idle ${hours(queueIdleMs)} on ${installSlug}`,
      detail:
        latency.redAwaitingFixerMs !== null
          ? `The newest red has waited ${hours(queueIdleMs)} for a fixer.`
          : `The newest admission has waited ${hours(queueIdleMs)} for its verification run to start.`,
    });
  }
  for (const head of admissions?.heads ?? []) {
    breaches.push({
      metric: 'red-adding-admission',
      subject: queue?.candidate,
      severity: 'alert',
      value: 1,
      threshold: 0,
      episodeKey: key('red-adding-admission', head),
      title: `A round after admission recorded more failures on ${installSlug}`,
      detail: `The first round after admitting ${head.slice(0, 12)} reported more failing tests than the preceding round; this time-window signal shows association, not that the admission caused the increase.`,
    });
  }
  for (const rate of perSyncRedRate ?? []) {
    if (rate.rate === null || rate.judgedBatches < t.perSyncRedMinBatches || rate.rate <= t.perSyncRedRateAlert) continue;
    breaches.push({
      metric: 'per-sync-red-rate',
      subject: rate.fleet,
      severity: 'alert',
      value: rate.rate,
      threshold: t.perSyncRedRateAlert,
      episodeKey: key('per-sync-red-rate', `${rate.fleet ?? 'all'}:${Math.floor(nowMs / (24 * HOUR_MS))}`),
      title: `${rate.fleet ?? 'All agents'}: ${Math.round(rate.rate * 100)}% of syncs red on ${installSlug}`,
      detail: `${rate.redBatches} of ${rate.judgedBatches} judged git-sync batches went red (target ≤ ${Math.round(t.perSyncRedRateAlert * 100)}%).`,
    });
  }

  for (const row of input.nonVerdictReasons?.reasons ?? []) {
    if (row.count < t.nonVerdictReasonMinCount) continue;
    breaches.push({
      metric: 'non-verdict-reason',
      subject: row.reason,
      severity: 'alert',
      value: row.count,
      threshold: t.nonVerdictReasonMinCount,
      episodeKey: key('non-verdict-reason', `${row.reason}:${Math.floor(nowMs / 86_400_000)}`),
      title: `${row.reason}: ${row.count} non-verdict gate outcomes on ${installSlug}`,
      detail: `${row.count} terminal outcomes with this reason in the last 24h (follow-up at ${t.nonVerdictReasonMinCount}). Repair this recurring reason without starting a parallel gate run.`,
    });
  }

  return {
    installSlug,
    computedAtMs: nowMs,
    metrics: {
      timeSinceGreenMs,
      timeSinceVerdictMs,
      roundCycleTime,
      queueIdleMs,
      roundsToConverge,
      redAddingAdmissions: admissions,
      perSyncRedRate,
      nonVerdictReasons: input.nonVerdictReasons ?? null,
    },
    breaches,
    thresholds: t,
  };
}
