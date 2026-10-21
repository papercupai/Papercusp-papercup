/**
 * Plan slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 #D-065 (WI-6554700010019417).
 *
 * A review-mode (fork) pot's gate judges only the fork's own delta (#D-064), but its NON-TEST
 * gate legs (`lint:tsc`, `<ws> :: lint:*`, …) run over the whole tree, so every leg the
 * upstream gate is itself red on is red on the fork too. Without this step a fork pot can
 * never reach green while its upstream is red, whatever the fork's own change does.
 *
 * Rule: a fork gate failure is INHERITED (non-blocking) when it is a non-test leg AND the
 * upstream gate's own MEASURED result shows that same leg id red. Tests never inherit: the
 * fork's test radius is its own delta and must pass on its own. Everything else fails closed:
 * no upstream install named, no measured upstream result, a stale result, or a read error all
 * leave the fork's red exactly as measured.
 *
 * Reused rather than re-derived:
 *  - entry classification is `classifyRepairSignatureEntry` (the repair queue's own vocabulary);
 *  - the upstream result is the `gate_health` jsonb the upstream install's gate already writes
 *    (`repairTickLegs` from an awaiting-fixer hold tick, else `failingTests` when
 *    `failingTestsMeasured` is true — see release-actions.ts, the only writers of both).
 *
 * Known limit (disclosed in #D-065): granularity is the leg id, the same as repair signatures,
 * so a NEW error inside a leg upstream already fails is not detected here. Upstream's own gate
 * still judges the merged change before upstream main moves.
 */
import { classifyRepairSignatureEntry, parseRepairTaskId } from './frozen-candidate-repair-queue';

/** Env var naming the upstream install whose gate result a fork pot's gate may inherit legs
 *  from. Set by hive-release-env.ts from the pot setting `hiveGit.upstreamInstall`. */
export const GATE_UPSTREAM_INSTALL_ENV = 'PAPERCUSP_GATE_UPSTREAM_INSTALL';

/** An upstream measurement older than this is not trusted: nothing inherits from it. */
export const UPSTREAM_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const INSTALL_SLUG_SHAPE = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** The upstream install named in the gate's env, or null when absent or malformed. */
export function upstreamInstallFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env[GATE_UPSTREAM_INSTALL_ENV] ?? '').trim();
  return INSTALL_SLUG_SHAPE.test(raw) ? raw : null;
}

/** True for a script name that runs tests (`test`, `test:*`). */
function isTestScript(script: string): boolean {
  return script === 'test' || script.startsWith('test:');
}

/**
 * PURE: may this failing entry be inherited from upstream? Only non-test gate legs:
 * a `lint-leg`, or a `<ws> :: <script>` workspace task whose script is not a test or a seed.
 * Test files, bare workspace names (their test task), seeds, the build sentinel and
 * unplaceable post-suite ids never inherit.
 */
export function isInheritableGateEntry(rawId: string): boolean {
  const entry = classifyRepairSignatureEntry(rawId);
  if (entry.kind === 'lint-leg') return true;
  if (entry.kind !== 'workspace-task') return false;
  const task = parseRepairTaskId(entry.id);
  return task !== null && !isTestScript(task.script);
}

export type UpstreamResultSource = 'repairTickLegs' | 'failingTests';

export interface UpstreamGateResult {
  source: UpstreamResultSource;
  /** Every id the upstream measurement shows red. */
  failing: string[];
  observedAtMs: number;
}

export type UpstreamGateResultRead =
  | { ok: true; result: UpstreamGateResult }
  | { ok: false; reason: 'no-gate-health' | 'unmeasured' | 'unknown-age' | 'stale' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

function finiteMs(v: unknown): number | null {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * PURE: the upstream gate's measured failing set, from its `gate_health` jsonb.
 *
 * Source order (#D-065): `repairTickLegs` when present (measured at upstream's repairHead;
 * a leg counts red when its status is `fail` or `errored`, the writer's own definition of
 * failing), unioned with its `failingSignatures`; else `failingTests` ONLY when
 * `failingTestsMeasured === true`. `failingTests` with `failingTestsMeasured:false` is a
 * carried name list, not a measurement, and is never used.
 */
export function upstreamGateResultFromGateHealth(
  gateHealth: unknown,
  nowMs: number,
  maxAgeMs: number = UPSTREAM_RESULT_MAX_AGE_MS,
): UpstreamGateResultRead {
  if (!isRecord(gateHealth)) return { ok: false, reason: 'no-gate-health' };
  let candidate: { source: UpstreamResultSource; failing: string[]; observedAtMs: number | null } | null = null;
  const tick = gateHealth.repairTickLegs;
  if (isRecord(tick)) {
    const legs = Array.isArray(tick.legs) ? tick.legs.filter(isRecord) : [];
    const failing = new Set(stringList(tick.failingSignatures));
    for (const leg of legs) {
      if (typeof leg.id === 'string' && (leg.status === 'fail' || leg.status === 'errored')) failing.add(leg.id.trim());
    }
    if (legs.length > 0 || failing.size > 0) {
      candidate = { source: 'repairTickLegs', failing: [...failing], observedAtMs: finiteMs(tick.atMs) };
    }
  }
  if (!candidate && gateHealth.failingTestsMeasured === true && Array.isArray(gateHealth.failingTests)) {
    candidate = {
      source: 'failingTests',
      failing: stringList(gateHealth.failingTests),
      observedAtMs: finiteMs(gateHealth.observedAt),
    };
  }
  if (!candidate) return { ok: false, reason: 'unmeasured' };
  if (candidate.observedAtMs === null) return { ok: false, reason: 'unknown-age' };
  if (nowMs - candidate.observedAtMs > maxAgeMs) return { ok: false, reason: 'stale' };
  return { ok: true, result: { ...candidate, observedAtMs: candidate.observedAtMs } };
}

/** PURE: split the fork's failing entries into still-blocking and inherited-from-upstream. */
export function partitionUpstreamInherited(
  failingTests: readonly string[],
  upstream: Pick<UpstreamGateResult, 'failing'>,
): { blocking: string[]; inherited: string[] } {
  const upstreamRed = new Set(upstream.failing.map((s) => s.trim()));
  const blocking: string[] = [];
  const inherited: string[] = [];
  for (const entry of failingTests) {
    (isInheritableGateEntry(entry) && upstreamRed.has(entry.trim()) ? inherited : blocking).push(entry);
  }
  return { blocking, inherited };
}

export interface UpstreamInheritanceOutcome {
  /** `applied` = a measured upstream result was compared (inherited may still be empty). */
  status: 'applied' | 'skipped';
  reason?: string;
  blocking: string[];
  inherited: string[];
  source?: UpstreamResultSource;
  observedAtMs?: number;
  /** The audit line the gate logs, `UPSTREAM_INHERITED …`. */
  logLine: string;
}

/** Reads the upstream install's `gate_health` jsonb (null when the row or field is absent). */
export type ReadUpstreamGateHealth = (target: { workspaceId: string; installSlug: string }) => Promise<unknown>;

/** The one Postgres read: the upstream install's green-checkpoint `gate_health`. Same row key
 *  as release-actions.ts's gate_health writers. */
export const readUpstreamGateHealth: ReadUpstreamGateHealth = async (target) => {
  const { getOrgPg } = await import('@papercusp/db-org');
  const rows = await getOrgPg().sql<{ gate_health: unknown }[]>`
    SELECT metadata->'gate_health' AS gate_health
      FROM harness_shared.routines
     WHERE install_slug = ${target.installSlug}
       AND target_role = 'system:green-checkpoint'
       AND workspace_id = ${target.workspaceId}
     LIMIT 1`;
  return rows[0]?.gate_health ?? null;
};

/**
 * Apply #D-065 to a fork gate's failing set. Never throws: any failure is a `skipped` outcome
 * that keeps every entry blocking.
 */
export async function inheritUpstreamGateLegs(input: {
  failingTests: readonly string[];
  upstreamInstall: string;
  workspaceId: string;
  nowMs: number;
  read?: ReadUpstreamGateHealth;
  maxAgeMs?: number;
}): Promise<UpstreamInheritanceOutcome> {
  const all = [...input.failingTests];
  const skip = (reason: string): UpstreamInheritanceOutcome => ({
    status: 'skipped',
    reason,
    blocking: all,
    inherited: [],
    logLine: `UPSTREAM_INHERITED blocking=${all.length} inherited=0 upstream=${input.upstreamInstall} skipped=${reason}`,
  });
  let gateHealth: unknown;
  try {
    gateHealth = await (input.read ?? readUpstreamGateHealth)({
      workspaceId: input.workspaceId,
      installSlug: input.upstreamInstall,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return skip(`read-failed:${message.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const read = upstreamGateResultFromGateHealth(gateHealth, input.nowMs, input.maxAgeMs);
  if (!read.ok) return skip(read.reason);
  const { blocking, inherited } = partitionUpstreamInherited(all, read.result);
  return {
    status: 'applied',
    blocking,
    inherited,
    source: read.result.source,
    observedAtMs: read.result.observedAtMs,
    logLine:
      `UPSTREAM_INHERITED blocking=${blocking.length} inherited=${inherited.length} ` +
      `upstream=${input.upstreamInstall} source=${read.result.source} observedAt=${read.result.observedAtMs}`,
  };
}
