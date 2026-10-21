/**
 * Recover a result-door spill path that a caller retyped by hand.
 *
 * Agents copy scratch cursors (`papercusp://scratch/<ws>/<tool>/<run>/<basename>`
 * or the matching `~/.papercusp/scratch/...` file path) out of a truncated result
 * and paste them into `capability:read`. Measured on 2026-10-20 (plan
 * bug-inflow-one-problem-one-row-2026-10-18, R-8 / D-008): most `read_failed`
 * ENOENT reads of a result-door spill named a path that was never handed out —
 * a changed character in the run-id UUID, the checkout directory name
 * (`papercupai-workspace`) in place of the workspace id, or the retired
 * `~/.papercup` root — while the real spill sat on disk under the cursor the
 * tool had returned. The refusal said only "ENOENT", so the caller had no way
 * back and the error was counted as a structural tool defect.
 *
 * `findMistypedScratchSpill` finds the ONE spill that the caller most likely
 * meant: same tool directory and same timestamped `result-door-*` basename,
 * under the requested workspace or any other workspace directory, in a run
 * directory whose id is the requested one or a near-copy of it. It returns null
 * whenever the match is not unique, so it never guesses between candidates.
 * The read handler reports the match as a cursor; it does not read the other
 * file on the caller's behalf.
 */
import { opendir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SCRATCH_SCHEME, scratchRoot } from './scratch-uri';

/** A result-door spill basename carries a millisecond timestamp, so it is near-unique. */
const SPILL_BASENAME = /^result-door-\d{10,}[A-Za-z0-9._-]*$/;
const RECOVERABLE_RESULT_DOOR_BASENAME =
  /^result-door-(\d{10,})(?:-([a-f\d]{8}))?(?:\.(spill|md))?$/i;
const SEGMENT = /^[A-Za-z0-9._:-]+$/;
/** Roots a caller may have written: the current one and the retired `.papercup` one. */
const SCRATCH_ROOT_MARKERS = ['/.papercusp/scratch/', '/.papercup/scratch/'] as const;
/** Upper bound on run directories stat-ed per workspace (the scan is on an error path). */
export const MAX_CANDIDATE_RUN_DIRS = 64;
/** Bound directory entries inspected per candidate run on this error path. */
const MAX_CANDIDATE_DIRECTORY_ENTRIES = 256;
/** A near-copy UUID keeps at least this many of its 36 characters in place. */
export const MIN_MATCHING_RUN_ID_CHARS = 24;

export interface ScratchSpillAddress {
  workspaceId: string;
  toolName: string;
  runId: string;
  basename: string;
}

export interface RecoveredScratchSpill extends ScratchSpillAddress {
  /** Absolute filesystem path of the spill that exists. */
  path: string;
  /** The same spill as a `papercusp://scratch/...` URI. */
  uri: string;
}

function isSafeSegment(segment: string): boolean {
  return SEGMENT.test(segment) && segment !== '.' && segment !== '..';
}

/**
 * Parse a scratch URI or filesystem path into its four segments. Returns null
 * for anything that is not a result-door spill address, including a path that
 * would leave the scratch root.
 */
export function parseScratchSpillAddress(requested: string): ScratchSpillAddress | null {
  const norm = requested.replace(/\\/g, '/');
  let rest: string | null = null;
  if (norm.startsWith(`${SCRATCH_SCHEME}/`)) {
    rest = norm.slice(SCRATCH_SCHEME.length + 1);
  } else {
    const root = `${scratchRoot().replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    if (norm.startsWith(root)) {
      rest = norm.slice(root.length);
    } else {
      for (const marker of SCRATCH_ROOT_MARKERS) {
        const at = norm.indexOf(marker);
        if (at >= 0) {
          rest = norm.slice(at + marker.length);
          break;
        }
      }
    }
  }
  if (rest === null) return null;
  const segments = rest.split('/');
  if (segments.length !== 4 || !segments.every(isSafeSegment)) return null;
  const [workspaceId, toolName, runId, basename] = segments;
  if (!SPILL_BASENAME.test(basename)) return null;
  return { workspaceId, toolName, runId, basename };
}

function positionalMatches(a: string, b: string): number {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) n++;
  return n;
}

/** True when `candidate` is the requested run id or a hand-copied near-copy of it. */
export function runIdLooksLike(requested: string, candidate: string): boolean {
  if (candidate === requested) return true;
  if (candidate.length !== requested.length || requested.length < 12) return false;
  if (candidate.slice(0, 8) === requested.slice(0, 8)) return true;
  if (candidate.slice(-12) === requested.slice(-12)) return true;
  return positionalMatches(requested, candidate) >= MIN_MATCHING_RUN_ID_CHARS;
}

/**
 * Result-door timestamps are exact; only recover a missing .spill/.md suffix
 * or one mistyped character in the eight-hex random suffix. Callers still
 * refuse when more than one existing file satisfies this narrow match.
 */
function resultDoorBasenameLooksLike(requested: string, candidate: string): boolean {
  if (requested === candidate) return true;
  const wanted = RECOVERABLE_RESULT_DOOR_BASENAME.exec(requested);
  const found = RECOVERABLE_RESULT_DOOR_BASENAME.exec(candidate);
  if (!wanted || !found || wanted[1] !== found[1]) return false;
  if (wanted[3] && found[3] && wanted[3].toLowerCase() !== found[3].toLowerCase()) return false;

  const wantedId = wanted[2]?.toLowerCase() ?? '';
  const foundId = found[2]?.toLowerCase() ?? '';
  if (wantedId === foundId) return true;
  if (!wantedId || !foundId) return false;

  let differences = 0;
  for (let i = 0; i < wantedId.length; i++) {
    if (wantedId[i] !== foundId[i]) differences++;
    if (differences > 1) return false;
  }
  return differences === 1;
}

async function listDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listMatchingEntryNames(path: string, requested: string): Promise<string[] | null> {
  const directory = await opendir(path).catch(() => null);
  if (!directory) return [];
  const matches: string[] = [];
  let inspected = 0;
  try {
    for await (const entry of directory) {
      inspected++;
      if (inspected > MAX_CANDIDATE_DIRECTORY_ENTRIES) return null;
      if (!entry.isFile() || !resultDoorBasenameLooksLike(requested, entry.name)) continue;
      matches.push(entry.name);
      if (matches.length > 1) return null;
    }
  } catch {
    return [];
  }
  return matches;
}

/**
 * Find the single existing spill a mistyped scratch path most likely names.
 * Returns null when the input is not a spill address, when nothing matches,
 * or when more than one spill matches.
 */
export async function findMistypedScratchSpill(requested: string): Promise<RecoveredScratchSpill | null> {
  const address = parseScratchSpillAddress(requested);
  if (!address) return null;
  const root = scratchRoot();
  const otherWorkspaces = (await listDirectories(root))
    .filter((ws) => ws !== address.workspaceId && isSafeSegment(ws))
    .sort();
  const matches = new Map<string, RecoveredScratchSpill>();
  for (const workspaceId of [address.workspaceId, ...otherWorkspaces]) {
    const toolDir = join(root, workspaceId, address.toolName);
    const runs = (await listDirectories(toolDir))
      .filter((run) => isSafeSegment(run) && runIdLooksLike(address.runId, run))
      // The exact run id first, then the closest copies.
      .sort((a, b) => positionalMatches(address.runId, b) - positionalMatches(address.runId, a))
      .slice(0, MAX_CANDIDATE_RUN_DIRS);
    for (const runId of runs) {
      const runDir = join(toolDir, runId);
      const exactPath = join(runDir, address.basename);
      const basenames = (await isFile(exactPath))
        ? [address.basename]
        : await listMatchingEntryNames(runDir, address.basename);
      if (basenames === null) return null;
      for (const basename of basenames) {
        const path = join(runDir, basename);
        if (!(await isFile(path))) continue;
        matches.set(path, {
          workspaceId,
          toolName: address.toolName,
          runId,
          basename,
          path,
          uri: `${SCRATCH_SCHEME}/${workspaceId}/${address.toolName}/${runId}/${basename}`,
        });
        if (matches.size > 1) return null;
      }
    }
  }
  const [only] = matches.values();
  return only ?? null;
}
