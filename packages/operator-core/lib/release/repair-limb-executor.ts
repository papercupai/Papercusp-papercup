/**
 * repair-limb-executor — the identity a gate-repair limb stamps on every record it writes.
 *
 * gate-repair-plane-on-current-build-2026-10-15 R-1/R-2: the repair limbs (idle repair-queue
 * actuator, lost-run alarm, frozen-queue fixer dispatch) execute on bg-host (D-001/D-002), and
 * every record they write must name the build that wrote it. The build comes from the WRITING
 * PROCESS's own `getBuildInfo()` — never a git HEAD read at write time, which describes the
 * checkout rather than the loaded bytes (build-info.ts, EI-21647996938145436).
 *
 * The host id is the process's serving identity (`port-3070`, `port-3271`, else `pid-<n>`), and
 * `processId` disambiguates two generations of one service overlapping during a restart.
 */
import { getResolvedBuild, type BuildShaSource, type ResolvedBuild } from '../build-info';
import { getServingHostIdentity, type ServingHostIdentity } from '../serving-host-identity';

type BuildResolution = Pick<ResolvedBuild, 'sha' | 'shaSource'>;

export interface ExecutingBuild {
  /** The writing process's loaded source sha; null when the source is dirty or unresolved. */
  sha: string | null;
  source: BuildShaSource;
}

export interface RepairLimbExecutor {
  hostId: string;
  processId: string | null;
  executingBuild: ExecutingBuild;
}

const SOURCES: ReadonlySet<string> = new Set<BuildShaSource>(['baked', 'env', 'git', 'dirty', 'unresolved']);

/** A dirty/unresolved build never carries a commit sha. */
export function executingBuildFrom(info: BuildResolution): ExecutingBuild {
  const sha = typeof info.sha === 'string' ? info.sha.trim() : '';
  if (info.shaSource === 'dirty') return { sha: null, source: 'dirty' };
  if (!sha || info.shaSource === 'unresolved' || !SOURCES.has(info.shaSource)) {
    return { sha: null, source: 'unresolved' };
  }
  return { sha, source: info.shaSource };
}

export function repairLimbExecutorFrom(
  host: Pick<ServingHostIdentity, 'host' | 'processId'>,
  info: BuildResolution,
): RepairLimbExecutor {
  return { hostId: host.host, processId: host.processId ?? null, executingBuild: executingBuildFrom(info) };
}

/**
 * This process's executor stamp. Both inputs are resolved once per process and cached; the
 * build is the same cached resolution `getBuildInfo()` projects, so the sha is identical.
 */
export function currentRepairLimbExecutor(): RepairLimbExecutor {
  return repairLimbExecutorFrom(getServingHostIdentity(), getResolvedBuild());
}

/**
 * Lenient read-back of a persisted stamp. Attribution is evidence, not control state, so a
 * malformed stamp reads as absent rather than invalidating the record that carries it.
 */
export function parseRepairLimbExecutor(value: unknown): RepairLimbExecutor | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.hostId !== 'string' || !row.hostId.trim()) return undefined;
  const build = row.executingBuild as Record<string, unknown> | null | undefined;
  if (!build || typeof build !== 'object' || typeof build.source !== 'string' || !SOURCES.has(build.source)) {
    return undefined;
  }
  const sha = build.sha === null ? null : typeof build.sha === 'string' && build.sha.trim() ? build.sha : undefined;
  const unattributable = build.source === 'dirty' || build.source === 'unresolved';
  if (sha === undefined || (sha === null) !== unattributable) return undefined;
  return {
    hostId: row.hostId,
    processId: typeof row.processId === 'string' ? row.processId : null,
    executingBuild: { sha, source: build.source as BuildShaSource },
  };
}

/** Same writer? Host AND process must match: a restart overlap is two executors on one host. */
export function sameRepairLimbExecutor(a: RepairLimbExecutor, b: RepairLimbExecutor): boolean {
  return a.hostId === b.hostId && a.processId === b.processId;
}
