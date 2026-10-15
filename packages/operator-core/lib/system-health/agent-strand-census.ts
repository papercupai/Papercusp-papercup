/**
 * agent-strand-census — the standing count behind P-011(b) of plan
 * parked-agent-census-resumption-and-root-cause-2026-10-09.
 *
 * Two populations of agents stop moving work without any surface saying so:
 *
 *   WEDGED    a session whose live psu host reports a condition that stops it taking a turn
 *             (dead auth, quota/403, an unbound respawn successor, deliveries stuck pending).
 *             The presence oracle judges these as `suspect` + `wedged` (P-011(a), D-011);
 *             this module only COUNTS that verdict, by class.
 *   STRANDED  an autonomous session that holds work, has its loop disarmed, and has nothing
 *             that can wake it. That is exactly `evaluateSilentHalt`'s `halted` verdict
 *             (D-006, D-008), so this module runs the real sweep in dry-run mode and counts
 *             its `halted` list. It never re-derives "wake source".
 *
 * Neither class was alarmed on while 61 loops stalled for days: the per-session machinery
 * (the pickup sweep, silent-halt's per-owner page) handles one victim at a time, and nothing
 * counted the population. A count over threshold is the signal that the per-session remedies
 * are not keeping up — usually one correlated cause (a quota-walled account, a bad launcher
 * generation) behind many victims. The alarm itself lives in `liveness-alarm.ts`
 * (`agents-wedged` / `agents-stranded`), read from the coordination panel.
 *
 * Import-light on purpose: `liveness-alarm.ts` imports the thresholds from here, so every heavy
 * reader is a lazy dynamic import inside `readAgentStrandCensus`.
 */
import type { LivenessSubject, LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import type { PickupRecoverable } from '../events/await/turn-proof';

/**
 * Wedged sessions at or above this count raise `agents-wedged`. Measured 2026-10-11T03:10Z over
 * the live roster: 40 of 414 sessions wedged (28 quota-blocked, 8 pending-turn-stuck, 4 unbound
 * successor) while nothing alarmed. Single wedges are the pickup sweep's job; ten at once is a
 * shared cause the per-session recovery is not clearing.
 */
export const AGENT_WEDGED_ALARM_THRESHOLD = 10;

/**
 * Stranded sessions at or above this count raise `agents-stranded`. silent-halt already pages
 * the owner per halted session (capped at 5 pages a sweep), so this count is the backstop for
 * when that cap, or the pages, are not being acted on.
 */
export const AGENT_STRANDED_ALARM_THRESHOLD = 5;

/** Owner ids carried in the panel for drill-down. Counts are always complete; samples are not. */
export const AGENT_STRAND_SAMPLE_SIZE = 8;

export const WEDGE_CLASSES: readonly PickupRecoverable[] = [
  'auth-blocked',
  'quota-blocked',
  'unbound-successor',
  'pending-turn-stuck',
];

export interface AgentStrandHealth {
  /** Sessions the oracle judged this tick (non-cup presence rows). */
  checked: number;
  /** Sessions whose verdict carries `wedged` (P-011(a)). */
  wedged: number;
  wedgedByClass: Record<PickupRecoverable, number>;
  wedgedSample: string[];
  /** Autonomous claim holders with no wake source: silent-halt's `halted` verdict. */
  stranded: number;
  strandedSample: string[];
  /**
   * The wedged read failed this tick. `wedged` is then 0 by construction and MUST NOT be read
   * as a recovery: the alarm treats `agents-wedged` as unobservable.
   */
  wedgedUnreadable: boolean;
  /** Same, for the stranded (silent-halt dry-run) read. */
  strandedUnreadable: boolean;
}

function emptyByClass(): Record<PickupRecoverable, number> {
  return { 'auth-blocked': 0, 'quota-blocked': 0, 'unbound-successor': 0, 'pending-turn-stuck': 0 };
}

/**
 * Pure: fold the oracle's verdicts and silent-halt's halted list into the panel shape. `null`
 * for either input means that read failed, which is reported as unreadable rather than zero.
 */
export function summarizeAgentStrand(
  verdicts: ReadonlyMap<string, Pick<LivenessVerdict, 'wedged'>> | null,
  halted: readonly string[] | null,
): AgentStrandHealth {
  const wedgedByClass = emptyByClass();
  const wedgedOwners: string[] = [];
  if (verdicts) {
    for (const [ownerId, v] of verdicts) {
      if (v.wedged == null) continue;
      wedgedOwners.push(ownerId);
      wedgedByClass[v.wedged] = (wedgedByClass[v.wedged] ?? 0) + 1;
    }
  }
  wedgedOwners.sort();
  const strandedOwners = [...new Set(halted ?? [])].sort();
  return {
    checked: verdicts?.size ?? 0,
    wedged: wedgedOwners.length,
    wedgedByClass,
    wedgedSample: wedgedOwners.slice(0, AGENT_STRAND_SAMPLE_SIZE),
    stranded: strandedOwners.length,
    strandedSample: strandedOwners.slice(0, AGENT_STRAND_SAMPLE_SIZE),
    wedgedUnreadable: verdicts == null,
    strandedUnreadable: halted == null,
  };
}

/** `quota-blocked 28, pending-turn-stuck 8` — non-zero classes only, largest first. */
export function formatWedgedByClass(byClass: Readonly<Record<string, number>>): string {
  return Object.entries(byClass)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
}

export interface AgentStrandCensusDeps {
  /** The roster to judge. Defaults to the workspace's presence rows. */
  readSubjects?: (workspaceId: string) => Promise<LivenessSubject[]>;
  /** The oracle. Defaults to `resolveSessionStates` with the host-condition leg ON. */
  resolveStates?: (subjects: readonly LivenessSubject[]) => Promise<Map<string, LivenessVerdict>>;
  /** silent-halt's halted owners. Defaults to `sweepSilentHalts({ dryRun: true })`. */
  readHalted?: (workspaceId: string) => Promise<string[]>;
}

async function defaultReadSubjects(workspaceId: string): Promise<LivenessSubject[]> {
  const { listPresence } = await import('../agent-tools/coordination/presence');
  const rows = await listPresence({ workspaceId });
  return rows
    .filter((p) => p.agentRole !== 'cup')
    .map((p) => ({
      ownerId: p.ownerId,
      heartbeatAt: p.heartbeatAt ?? null,
      stale: p.stale ?? null,
      host: p.host ?? null,
      pid: p.pid ?? null,
      source: p.source ?? null,
      agentRole: p.agentRole ?? null,
    }));
}

async function defaultResolveStates(subjects: readonly LivenessSubject[]): Promise<Map<string, LivenessVerdict>> {
  const { resolveSessionStates } = await import('../agent-tools/coordination/liveness-oracle');
  // hostCondition is explicit, not inherited from psuHostPositiveAuthority's default: this census
  // exists to count the leg's verdict, so a future change to that default must not blind it.
  return resolveSessionStates(subjects, { psuHostPositiveAuthority: true, hostCondition: true });
}

async function defaultReadHalted(workspaceId: string): Promise<string[]> {
  const { sweepSilentHalts } = await import('../harness/routines/silent-halt-reconcile');
  const result = await sweepSilentHalts({ workspaceId, dryRun: true });
  return result.halted;
}

/**
 * Read both populations. Each leg is fail-soft and reports its own failure: a census that could
 * not read is UNREADABLE, never a confident zero.
 */
export async function readAgentStrandCensus(
  workspaceId: string,
  deps: AgentStrandCensusDeps = {},
): Promise<AgentStrandHealth> {
  const readSubjects = deps.readSubjects ?? defaultReadSubjects;
  const resolveStates = deps.resolveStates ?? defaultResolveStates;
  const readHalted = deps.readHalted ?? defaultReadHalted;
  const [verdicts, halted] = await Promise.all([
    readSubjects(workspaceId)
      .then((subjects) => resolveStates(subjects))
      .catch((e: unknown) => {
        console.warn(`[agent-strand-census] wedged read failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }),
    readHalted(workspaceId).catch((e: unknown) => {
      console.warn(`[agent-strand-census] stranded read failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }),
  ]);
  return summarizeAgentStrand(verdicts, halted);
}
