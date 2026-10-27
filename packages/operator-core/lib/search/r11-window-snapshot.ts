/** Read-only, repeatable-read evidence capture for plan shared-vector-search-libraries P-008 R-11. */
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { executeGovernedByteProcess } from '../../../../scripts/lib/governed-test-process.mjs';
import type { getOrgPg } from '@papercusp/db-org';
import {
  TARGETS,
  activeRecipeVersion,
  eligiblePredicateSql,
  modeColOf,
  profileColOf,
  recipeColOf,
  stalePredicateSql,
  type BackfillTarget,
} from './embed-backfill';
import { resolveProseProfileSelection } from './prose-vector-dims';

type Sql = ReturnType<typeof getOrgPg>['sql'];
type Profile = Parameters<typeof resolveProseProfileSelection>[1];

/** Preserve canonical defaults while allowing an admitted evidence volume. */
export function r11PreservationRoots(repoRoot: string, primaryDirectory: string,
  env: Record<string, string | undefined> = process.env) {
  const recoveryRoot = env.R11_RECOVERY_ROOT ?? resolve(repoRoot, '.papercusp/evidence/r11-recovery');
  const journalRoot = env.R11_JOURNAL_ROOT ?? resolve(repoRoot, '.papercusp/evidence/r11-journals');
  // Both copies must survive removal of the entire primary directory.
  r11JournalDirectory(primaryDirectory, recoveryRoot);
  r11JournalDirectory(primaryDirectory, journalRoot);
  return { recoveryRoot, journalRoot };
}

/** Key recovery bytes by the full frozen path, so separate windows cannot collide. */
export function r11RecoveryPath(path: string, recoveryRoot: string): string {
  if (!isAbsolute(path) || !isAbsolute(recoveryRoot)) throw new Error('Snapshot paths must be absolute');
  const recovery = join(recoveryRoot, createHash('sha256').update(resolve(path)).digest('hex'));
  if (resolve(path) === recovery) throw new Error('Recovery copy must be independent');
  return recovery;
}

function publishImmutableBytes(path: string, bytes: Buffer): void {
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    linkSync(temp, path);
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { unlinkSync(temp); }
}

/** A successful capture requires independent, durable bytes before primary publication. */
export function publishR11SnapshotBytes(path: string, bytes: Buffer, recoveryRoot: string): string {
  if (bytes.length > R11_JOURNAL_MAX_BYTES) throw new Error('Snapshot exceeds frozen evidence file cap');
  const recovery = r11RecoveryPath(path, recoveryRoot);
  mkdirSync(recoveryRoot, { recursive: true, mode: 0o700 });
  publishImmutableBytes(recovery, bytes);
  publishImmutableBytes(path, bytes);
  return recovery;
}

/** Only a missing primary permits recovery; conflicting or corrupt bytes are never hidden. */
export function readR11SnapshotBytes(path: string, recoveryRoot: string): Buffer {
  const recovery = r11RecoveryPath(path, recoveryRoot);
  try {
    const primary = readFileSync(path);
    if (existsSync(recovery) && !primary.equals(readFileSync(recovery))) {
      throw new Error('Primary and recovery snapshot bytes disagree');
    }
    return primary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFileSync(recovery);
  }
}
export type R11Stage = 'preflight' | 'T0' | 'Tcut' | 'T1';
export interface R11Row { key: string; stale: boolean; recency: string | null }
export interface R11TargetSnapshot {
  table: string;
  embedCol: string;
  keyCols: string[];
  predicateHash: string;
  rows: R11Row[];
}
export interface R11SystemJournalSuppressionNotice {
  cursor: string;
  realtimeTimestamp: string;
  message: string;
  suppressedCount: number;
}
export interface R11SystemJournalSuppressionEvidence {
  status: 'complete' | 'unavailable';
  windowStart: string;
  windowEnd: string;
  checkedAt: string;
  rawOutput: string;
  rawOutputBytes: number;
  rawOutputSha256: string;
  notices: R11SystemJournalSuppressionNotice[];
  error?: string;
}
export interface R11Snapshot {
  stage: R11Stage;
  capturedAt: string;
  mode: string;
  profileId: string;
  targets: R11TargetSnapshot[];
  systemJournalSuppression?: R11SystemJournalSuppressionEvidence;
}

function parseR11SystemJournalSuppressionOutput(rawOutput: string, windowStart: string, windowEnd: string): {
  notices: R11SystemJournalSuppressionNotice[];
  error?: string;
} {
  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { notices: [], error: 'Invalid frozen system-journal window' };
  }

  const notices: R11SystemJournalSuppressionNotice[] = [];
  for (const [index, line] of rawOutput.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      entry = parsed as Record<string, unknown>;
    } catch {
      return { notices: [], error: `Malformed system-journal JSON record at line ${index + 1}` };
    }
    if (typeof entry.MESSAGE !== 'string') {
      return { notices: [], error: `System-journal record at line ${index + 1} has no MESSAGE` };
    }
    const message = entry.MESSAGE;
    if (!/\bsuppressed\b/i.test(message) || !message.includes('user@1000.service')) {
      return { notices: [], error: `Unexpected system-journal record returned by the suppression query at line ${index + 1}` };
    }

    const match = /^Suppressed\s+(\d+)\s+messages?\s+from\s+user@1000\.service\s*$/i.exec(message);
    if (!match) return { notices: [], error: `Unrecognized user@1000.service suppression notice at line ${index + 1}` };
    const suppressedCount = Number(match[1]);
    const cursor = entry.__CURSOR;
    const realtimeTimestamp = entry.__REALTIME_TIMESTAMP;
    const occurredAtMs = typeof realtimeTimestamp === 'string' ? Number(realtimeTimestamp) / 1000 : NaN;
    if (!Number.isSafeInteger(suppressedCount) || suppressedCount <= 0 || typeof cursor !== 'string' || !cursor ||
        typeof realtimeTimestamp !== 'string' || !Number.isFinite(occurredAtMs) || occurredAtMs < startMs || occurredAtMs > endMs) {
      return { notices: [], error: `Incomplete or out-of-window user@1000.service suppression notice at line ${index + 1}` };
    }
    notices.push({ cursor, realtimeTimestamp, message, suppressedCount });
  }
  return { notices };
}

/** Read and preserve the host journal's suppression records for the exact frozen window. */
export async function captureR11SystemJournalSuppression(
  windowStart: string,
  windowEnd: string,
  executeProcess: typeof executeGovernedByteProcess = executeGovernedByteProcess,
  now: () => number = Date.now,
): Promise<R11SystemJournalSuppressionEvidence> {
  const buildEvidence = (status: R11SystemJournalSuppressionEvidence['status'], rawOutput: string,
    notices: R11SystemJournalSuppressionNotice[], error?: string): R11SystemJournalSuppressionEvidence => ({
    status, windowStart, windowEnd, checkedAt: new Date(now()).toISOString(), rawOutput,
    rawOutputBytes: Buffer.byteLength(rawOutput),
    rawOutputSha256: createHash('sha256').update(rawOutput).digest('hex'), notices,
    ...(error ? { error } : {}),
  });

  const startMs = Date.parse(windowStart);
  const endMs = Date.parse(windowEnd);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return buildEvidence('unavailable', '', [], 'Invalid frozen system-journal window');
  }

  let result: Awaited<ReturnType<typeof executeGovernedByteProcess>>;
  try {
    result = await executeProcess('journalctl', [
      '--system', '--no-pager', '--output=json', `--since=${windowStart}`, `--until=${windowEnd}`,
      '--grep=Suppressed.*user@1000\\.service',
    ], new Uint8Array(), { namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    return buildEvidence('unavailable', '', [], `journalctl could not be run: ${error instanceof Error ? error.message : String(error)}`);
  }

  const rawOutput = typeof result.stdout === 'string' ? result.stdout : '';
  if (result.error || result.status !== 0 || result.signal || result.stderr.trim()) {
    const detail = result.error?.code ?? result.stderr.trim() ?? '';
    return buildEvidence('unavailable', rawOutput, [],
      `journalctl did not provide a complete system-journal read${detail ? ` (${detail})` : ` (status ${result.status ?? result.signal ?? 'unknown'})`}`);
  }
  const parsed = parseR11SystemJournalSuppressionOutput(rawOutput, windowStart, windowEnd);
  if (parsed.error) return buildEvidence('unavailable', rawOutput, [], parsed.error);
  return buildEvidence('complete', rawOutput, parsed.notices);
}

export interface R11TimerSpec {
  stage: 'Tcut' | 'T1';
  unit: string;
  at: string;
}

/** Bound each evidence file even if a frozen snapshot fails or its owner exits. */
export const R11_JOURNAL_MAX_BYTES = 8 * 1024 ** 3;

/** Four snapshots (preflight + three frozen stages), two durable copies, three journals.
 * Immutable publication hard-links its temporary inode, so rename/link publication
 * does not allocate another full file. Retained preflight is deliberately included.
 */
export function r11DiskAllocations(primaryDirectory: string,
  preservation: { recoveryRoot: string; journalRoot: string }) {
  return [
    { path: primaryDirectory, bytes: 4 * R11_JOURNAL_MAX_BYTES },
    { path: preservation.recoveryRoot, bytes: 4 * R11_JOURNAL_MAX_BYTES },
    { path: preservation.journalRoot, bytes: 3 * R11_JOURNAL_MAX_BYTES },
  ];
}

/** Resolve existing ancestors too: a not-yet-created child may sit behind a symlink. */
function physicalDestination(path: string): string {
  let ancestor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor));
      ancestor = parent;
    }
  }
}

/** Journal streams must survive deletion of the primary snapshot directory. */
export function r11JournalDirectory(primaryDirectory: string, preservationRoot: string): string {
  if (![primaryDirectory, preservationRoot].every(isAbsolute)) {
    throw new Error('Journal directories must be absolute');
  }
  const primary = resolve(primaryDirectory);
  const root = resolve(preservationRoot);
  for (const [parent, child] of [[primary, root], [physicalDestination(primary), physicalDestination(root)]]) {
    const withinPrimary = relative(parent, child);
    if (!withinPrimary || (!withinPrimary.startsWith('../') && withinPrimary !== '..')) {
      throw new Error('Journal preservation must be outside the primary directory');
    }
  }
  return join(root, createHash('sha256').update(primary).digest('hex'));
}

export interface R11CaptureRuntime {
  repoRoot: string;
  tsx: string;
  script: string;
  journalDirectory?: string;
  recoveryRoot?: string;
  journalRoot?: string;
  journalPreparation?: boolean;
  journalSinceMs?: number;
  preparedJournals?: R11PreparedJournals;
  t0At?: string;
  preparedJournalsPath?: string;
}

export interface R11PreparedJournals {
  specs: R11TimerSpec[];
  sinceMs: number;
  captures: Array<{ unit: string; path: string; show: string }>;
}

const journalProperties = ['ActiveState', 'SubState', 'Result', 'NRestarts', 'MainPID',
  'InvocationID', 'ExecMainStartTimestamp', 'ExecMainStartTimestampUSec', 'RuntimeMaxUSec', 'LimitFSIZE'];
const property = (show: string, key: string) => show.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

function verifyPreparedJournal(show: string, prior: string, t0At: string) {
  const start = Date.parse(property(show, 'ExecMainStartTimestamp') ?? '');
  if (property(show, 'ActiveState') !== 'active' || property(show, 'NRestarts') !== '0' ||
      !Number.isFinite(start) || start > Date.parse(t0At) ||
      !/^[1-9]\d*$/.test(property(show, 'MainPID') ?? '') ||
      !/^[a-f0-9]{32}$/.test(property(show, 'InvocationID') ?? '') ||
      ['MainPID', 'InvocationID', 'ExecMainStartTimestamp'].some((key) => property(show, key) !== property(prior, key))) {
    throw new Error('Prepared journal identity changed or was not active before T0');
  }
}

/** Observe live identities at the frozen boundary before slow database work. */
export async function captureR11JournalBoundary(prepared: R11PreparedJournals, t0At: string, t1At: string,
  executeProcess: typeof executeGovernedByteProcess = executeGovernedByteProcess, now = Date.now) {
  const deadline = Date.parse(t1At);
  if (!Number.isFinite(deadline) || prepared.captures.length !== 3) throw new Error('Invalid journal boundary');
  const observations = [];
  for (const follower of prepared.captures) {
    const result = await executeProcess('systemctl', ['--user', 'show', `${follower.unit}.service`,
      ...journalProperties.flatMap((key) => ['-p', key])], new Uint8Array(),
    { namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
    const observedAt = now();
    if (observedAt < deadline || observedAt > deadline + 60_000) throw new Error('Journal boundary observation missed T1');
    if (result.error || result.status !== 0) throw new Error('Journal boundary process read failed');
    verifyPreparedJournal(result.stdout, follower.show, t0At);
    observations.push({ unit: follower.unit, path: follower.path, observedAt: new Date(observedAt).toISOString(), show: result.stdout });
  }
  // Hash each finite prefix as it exists at observation, even while the same
  // producer continues appending. Never load up to 8 GiB into memory.
  const files = [];
  for (const observation of observations) {
    const bytes = statSync(observation.path).size;
    if (bytes > R11_JOURNAL_MAX_BYTES) throw new Error('Journal exceeded capture cap');
    const hash = createHash('sha256');
    if (bytes) for await (const chunk of createReadStream(observation.path, { start: 0, end: bytes - 1 })) hash.update(chunk);
    files.push({ ...observation, bytes, sha256: hash.digest('hex') });
  }
  return { t1At, files };
}

/** The expiry timer is independent of the database snapshot service. */
export function buildR11JournalCapturePlan(
  specs: readonly R11TimerSpec[], directory: string, nowMs = Date.now(), sinceMs?: number,
) {
  const end = specs.find((spec) => spec.stage === 'T1');
  const deadline = end ? Date.parse(end.at) : NaN;
  if (!end || !/^r11-p008-t1-\d+$/.test(end.unit) || !Number.isFinite(deadline) || deadline <= nowMs) {
    throw new Error('Journal capture requires a future frozen T1 deadline');
  }
  if (!isAbsolute(directory) || /[\r\n\0]/.test(directory)) {
    throw new Error('Journal capture requires an absolute output directory');
  }
  const remainingSec = Math.ceil((deadline - nowMs) / 1000);
  const windowStartSec = sinceMs === undefined ? Math.floor(deadline / 1000) - 24 * 60 * 60 : Math.floor(sinceMs / 1000);
  const stamp = end.unit.slice('r11-p008-t1-'.length);
  const captures = [
    { kind: 'bg', journalUnit: 'papercusp-bg-host.service', journalArgs: ['--no-tail', `--since=@${windowStartSec}`, '--grep=embed-backfill'] },
    { kind: 'bg-all', journalUnit: 'papercusp-bg-host.service', journalArgs: ['--no-tail', `--since=@${windowStartSec}`] },
    // Preserve the last existing event as the predeclared sidecar anchor.
    { kind: 'sidecar-anchored', journalUnit: 'papercup-embed-sidecar.service', journalArgs: ['-n', '1'] },
  ].map(({ kind, journalUnit, journalArgs }) => {
    const unit = `r11-p008-journal-${stamp}-${kind}`;
    const path = join(directory, `${unit}.jsonl`);
    return { unit, path, command: ['--user', `--unit=${unit}`,
      `--property=RuntimeMaxSec=${remainingSec}`, '--property=TimeoutStopSec=10s',
      `--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`, '--property=UMask=0077',
      // systemd expands percent specifiers in output paths.
      `--property=StandardOutput=append:${path.replaceAll('%', '%%')}`,
      '/usr/bin/journalctl', '--user', '-f', '-o', 'json', `--unit=${journalUnit}`, ...journalArgs] };
  });
  const expiryUnit = `r11-p008-journal-expiry-${stamp}`;
  // Keep producers alive through the boundary observation and the final
  // journald flush. Parsing still ends at T1; this is a bounded evidence tail.
  const stopAt = `${new Date(deadline + 10 * 60_000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return { deadline: new Date(deadline).toISOString(), captures, expiryUnit,
    expiryCommand: ['--user', `--unit=${expiryUnit}`, `--on-calendar=${stopAt}`,
      '--timer-property=AccuracySec=1s', '/usr/bin/systemctl', '--user', 'stop',
      ...captures.map(({ unit }) => `${unit}.service`)] };
}

/** Build the exact user timer command, including each stage's frozen inputs. */
export function buildR11SystemdRunArgs(
  spec: R11TimerSpec,
  paths: { t0: string; cut: string; t1: string },
  runtime: R11CaptureRuntime,
): string[] {
  const args = spec.stage === 'Tcut'
    ? ['Tcut', paths.cut, paths.t0]
    : ['T1', paths.t1, paths.t0, paths.cut, ...(runtime.preparedJournalsPath ? [runtime.preparedJournalsPath] : [])];
  return ['--user', `--unit=${spec.unit}`, `--on-calendar=${spec.at}`,
    `--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`, '--property=UMask=0077',
    '--timer-property=AccuracySec=1s', `--working-directory=${runtime.repoRoot}`,
    '/usr/bin/bash', '-c', 'set -a; . ./apps/operator/.env.local; set +a; exec "$@"',
    'r11-capture', ...(runtime.recoveryRoot || runtime.journalRoot ? ['/usr/bin/env'] : []),
    ...(runtime.recoveryRoot ? [`R11_RECOVERY_ROOT=${runtime.recoveryRoot}`] : []),
    ...(runtime.journalRoot ? [`R11_JOURNAL_ROOT=${runtime.journalRoot}`] : []),
    runtime.tsx, runtime.script, ...args];
}

/** Freeze both one-shot deadlines from the database timestamp in the T0 receipt. */
export function buildR11TimerSpecs(t0: R11Snapshot): [R11TimerSpec, R11TimerSpec] {
  if (t0.stage !== 'T0') throw new Error('Timer scheduling requires a T0 snapshot');
  const start = Date.parse(t0.capturedAt);
  if (!Number.isFinite(start)) throw new Error('T0 has an invalid database timestamp');
  const stamp = Math.floor(start / 1000);
  const format = (offsetMs: number) => `${new Date(start + offsetMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return [
    { stage: 'Tcut', unit: `r11-p008-tcut-${stamp}`, at: format((24 * 60 - 10) * 60_000) },
    { stage: 'T1', unit: `r11-p008-t1-${stamp}`, at: format(24 * 60 * 60_000) },
  ];
}

/** Arm each frozen timer through the maintained process receipt and roll back on failure. */
export async function scheduleR11Timers(
  specs: readonly R11TimerSpec[],
  paths: Parameters<typeof buildR11SystemdRunArgs>[1],
  runtime: Parameters<typeof buildR11SystemdRunArgs>[2],
  dryRun = false,
  executeProcess: typeof executeGovernedByteProcess = executeGovernedByteProcess,
  now: () => number = Date.now,
) {
  const armed: string[] = [];
  const timers: Array<R11TimerSpec & {
    kind?: 'journal' | 'journal-expiry'; path?: string; show?: string; command?: string[];
  }> = [];
  const run = async (executable: string, args: string[]) => {
    const result = await executeProcess(executable, args, new Uint8Array(), {
      namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(`${executable} failed (${result.error?.code ?? result.signal ?? result.status}): ${result.stderr}`);
    }
    return result.stdout;
  };
  try {
    if (runtime.journalDirectory) {
      const capture = buildR11JournalCapturePlan(specs, runtime.journalDirectory, now(), runtime.journalSinceMs);
      const prepared = runtime.preparedJournals;
      if (prepared) {
        if (!runtime.t0At || !Number.isFinite(Date.parse(runtime.t0At)) || prepared.sinceMs > Date.parse(runtime.t0At)) {
          throw new Error('Prepared journals require the actual T0 timestamp');
        }
        const original = buildR11JournalCapturePlan(prepared.specs, runtime.journalDirectory, now(), prepared.sinceMs);
        if (prepared.captures.length !== 3 || original.captures.some((follower, index) =>
          follower.unit !== prepared.captures[index]?.unit || follower.path !== prepared.captures[index]?.path) ||
          Date.parse(original.deadline) < Date.parse(capture.deadline) + 10 * 60_000) {
          throw new Error('Prepared journals do not cover the frozen window');
        }
        capture.captures = original.captures;
        capture.expiryCommand.splice(-3, 3, ...original.captures.map(({ unit }) => `${unit}.service`));
      }
      if (!dryRun) {
        // Arm the stop first: a failed Tcut/T1 service must not leave followers running.
        await run('systemd-run', capture.expiryCommand);
        armed.push(`${capture.expiryUnit}.timer`);
        const expiry = await run('systemctl', ['--user', 'show', `${capture.expiryUnit}.timer`,
          '-p', 'ActiveState', '-p', 'Unit']);
        if (!expiry.includes('ActiveState=active') || !expiry.includes(`Unit=${capture.expiryUnit}.service`)) {
          throw new Error(`Journal expiry ${capture.expiryUnit} was not armed`);
        }
        timers.push({ stage: 'T1', kind: 'journal-expiry', unit: capture.expiryUnit,
          at: capture.deadline, command: capture.expiryCommand, show: expiry });
        for (const follower of capture.captures) {
          if (now() >= Date.parse(capture.deadline)) throw new Error('Frozen T1 expired during journal admission');
          if (!prepared) {
            await run('systemd-run', follower.command);
            armed.push(`${follower.unit}.service`);
          }
          const show = await run('systemctl', ['--user', 'show', `${follower.unit}.service`,
            ...journalProperties.flatMap((key) => ['-p', key])]);
          if (now() >= Date.parse(capture.deadline) || !show.includes('ActiveState=active') ||
              !/^RuntimeMaxUSec=(?!infinity|0(?:\s|$)).+/m.test(show) ||
              !show.includes(`LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`)) {
            throw new Error(`Journal capture ${follower.unit} was not bounded and active`);
          }
          if (prepared) verifyPreparedJournal(show, prepared.captures.find(({ unit }) => unit === follower.unit)!.show, runtime.t0At!);
          if (runtime.journalPreparation) verifyPreparedJournal(show, show, new Date(now()).toISOString());
          timers.push({ stage: 'T1', kind: 'journal', unit: follower.unit, path: follower.path,
            at: capture.deadline, command: follower.command, show });
        }
      } else {
        timers.push({ stage: 'T1', kind: 'journal-expiry', unit: capture.expiryUnit,
          at: capture.deadline, command: capture.expiryCommand });
        for (const follower of capture.captures) {
          timers.push({ stage: 'T1', kind: 'journal', unit: follower.unit, path: follower.path,
            at: capture.deadline, command: follower.command });
        }
      }
    }
    for (const spec of runtime.journalPreparation ? [] : specs) {
      const command = buildR11SystemdRunArgs(spec, paths, runtime);
      if (dryRun) {
        timers.push({ ...spec, command });
        continue;
      }
      await run('systemd-run', command);
      armed.push(`${spec.unit}.timer`);
      const show = await run('systemctl', ['--user', 'show', `${spec.unit}.timer`,
        '-p', 'ActiveState', '-p', 'NextElapseUSecRealtime', '-p', 'Unit']);
      if (!show.includes('ActiveState=active') || !show.includes(`Unit=${spec.unit}.service`)) {
        throw new Error(`Timer ${spec.unit} was not armed: ${show}`);
      }
      timers.push({ ...spec, show });
    }
  } catch (error) {
    for (const unit of armed) {
      try { await run('systemctl', ['--user', 'stop', unit]); } catch { /* preserve the first error */ }
    }
    throw error;
  }
  return timers;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Uses the same target registry and eligibility/staleness builders as the live sweep. */
export function buildR11TargetQuery(
  target: BackfillTarget,
  columns: Set<string>,
  mode: string,
  profile: Profile,
): { query: string; params: Array<string | number>; predicateHash: string } {
  for (const col of [target.embedCol, ...target.keyCols]) {
    if (!columns.has(col)) throw new Error(`${target.table}: missing required column ${col}`);
  }
  const spaceAware = columns.has(modeColOf(target));
  const profileAware = columns.has(profileColOf(target));
  const recipeVersion = activeRecipeVersion(target, columns.has(recipeColOf(target)));
  const selection = profileAware ? resolveProseProfileSelection(mode, profile) : null;
  if (profileAware && !selection) throw new Error(`${target.table}: incompatible profile ${profile.profileId}`);

  const params: Array<string | number> = [];
  const bind = (value: string | number) => { params.push(value); return `$${params.length}`; };
  const modeExpr = spaceAware ? bind(mode) : 'NULL';
  const profileExpr = selection ? bind(selection.profileId) : null;
  const recipeExpr = recipeVersion === null ? null : bind(recipeVersion);
  const stale = stalePredicateSql(target, spaceAware, modeExpr, recipeExpr,
    selection ? { profileExpr: profileExpr!, legacyModeCompatible: selection.legacyMode === mode } : undefined);
  const eligible = eligiblePredicateSql(target);
  const key = `jsonb_build_array(${target.keyCols.join(', ')})::text`;
  const recency = target.recencyCol && columns.has(target.recencyCol)
    ? `${target.recencyCol}::text` : 'NULL::text';
  const query = `SELECT ${key} AS row_key, (${stale}) AS stale, ${recency} AS recency
    FROM ${target.table} WHERE ${eligible} ORDER BY ${target.keyCols.join(', ')}`;
  return { query, params, predicateHash: sha256(JSON.stringify({ query, mode, profileId: profile.profileId, params })) };
}

export function selectR11StageRows(
  stage: R11Stage, current: R11Row[], t0?: R11Row[], cut?: R11Row[],
): R11Row[] {
  if (stage === 'Tcut') {
    if (!t0) throw new Error('Tcut requires the frozen T0 keys');
    const old = new Set(t0.map((row) => row.key));
    return current.filter((row) => !old.has(row.key));
  }
  if (stage === 'T1') {
    if (!t0 || !cut) throw new Error('T1 requires the frozen T0 and Tcut cohorts');
    const cohort = new Set([...t0.filter((row) => row.stale), ...cut].map((row) => row.key));
    return current.filter((row) => cohort.has(row.key));
  }
  return current;
}

export async function captureR11Snapshot(
  sql: Sql, stage: R11Stage, resolved: { mode: string; profile: Profile },
  prior: { t0?: R11Snapshot; cut?: R11Snapshot } = {},
): Promise<R11Snapshot> {
  return sql.begin(async (tx) => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clock = await tx.unsafe<Array<{ captured_at: Date | string }>>('SELECT transaction_timestamp() AS captured_at');
    const capturedAt = clock[0]?.captured_at ? new Date(clock[0].captured_at).toISOString() : null;
    if (!capturedAt) throw new Error('Postgres transaction timestamp unavailable');
    const targets: R11TargetSnapshot[] = [];
    for (const target of TARGETS) {
      const [schema, table] = target.table.split('.');
      if (!schema || !table) throw new Error(`Invalid target table: ${target.table}`);
      const found = await tx.unsafe<Array<{ column_name: string }>>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2',
        [schema, table],
      );
      const { query, params, predicateHash } = buildR11TargetQuery(
        target, new Set(found.map((row) => row.column_name)), resolved.mode, resolved.profile,
      );
      const rows = await tx.unsafe<Array<{ row_key: string; stale: boolean; recency: string | null }>>(query, params);
      const priorTarget = (snapshot?: R11Snapshot) => {
        const match = snapshot?.targets.find((entry) => entry.table === target.table && entry.embedCol === target.embedCol);
        if (snapshot && !match) throw new Error(`${target.table}: target absent from prior snapshot`);
        return match;
      };
      const current = rows.map((row) => ({ key: row.row_key, stale: row.stale, recency: row.recency }));
      targets.push({
        table: target.table,
        embedCol: target.embedCol,
        keyCols: [...target.keyCols],
        predicateHash,
        rows: selectR11StageRows(stage, current, priorTarget(prior.t0)?.rows, priorTarget(prior.cut)?.rows),
      });
    }
    return { stage, capturedAt, mode: resolved.mode, profileId: resolved.profile.profileId, targets };
  });
}

export interface R11TargetResult {
  table: string;
  t0Stale: number;
  t0Retained: number;
  t0Embedded: number;
  inWindowEligible: number;
  inWindowRetained: number;
  inWindowEmbedded: number;
  passed: boolean;
}

/** Pure cutoff comparison. A removed/re-scoped row is absent from T1's eligible map. */
export function evaluateR11Snapshots(t0: R11Snapshot, cut: R11Snapshot, t1: R11Snapshot): {
  verdict: 'healthy' | 'failed' | 'inconclusive';
  targets: R11TargetResult[];
  reason: string;
} {
  if (t0.stage !== 'T0' || cut.stage !== 'Tcut' || t1.stage !== 'T1') throw new Error('Wrong snapshot stage order');
  const targetIds = (s: R11Snapshot) => s.targets.map((t) => `${t.table}.${t.embedCol}`).join('|');
  if (targetIds(t0) !== targetIds(cut) || targetIds(t0) !== targetIds(t1)) throw new Error('TARGETS changed during window');
  if (t0.targets.some((target, i) => target.predicateHash !== cut.targets[i]!.predicateHash ||
      target.predicateHash !== t1.targets[i]!.predicateHash)) {
    return { verdict: 'inconclusive', targets: [], reason: 'A target predicate or embedding profile changed during the window' };
  }
  const start = Date.parse(t0.capturedAt);
  const cutAt = Date.parse(cut.capturedAt);
  const endAt = Date.parse(t1.capturedAt);
  const cutOffset = cutAt - start;
  const endOffset = endAt - start;
  if (![start, cutAt, endAt].every(Number.isFinite) || cutAt <= start || endAt <= cutAt ||
      Math.abs(cutOffset - (24 * 60 - 10) * 60_000) > 60_000 ||
      Math.abs(endOffset - 24 * 60 * 60_000) > 60_000) {
    return { verdict: 'inconclusive', targets: [], reason: 'A cutoff capture missed its predeclared deadline by over 60 seconds' };
  }
  const targets = t0.targets.map((startTarget, i): R11TargetResult => {
    const cutTarget = cut.targets[i]!;
    const endTarget = t1.targets[i]!;
    const endRows = new Map(endTarget.rows.map((row) => [row.key, row]));
    const t0StaleRows = startTarget.rows.filter((row) => row.stale);
    const t0Retained = t0StaleRows.filter((row) => endRows.has(row.key));
    const t0Embedded = t0Retained.filter((row) => !endRows.get(row.key)!.stale).length;
    const inWindowRows = cutTarget.rows;
    const inWindowRetained = inWindowRows.filter((row) => endRows.has(row.key));
    const inWindowEmbedded = inWindowRetained.filter((row) => !endRows.get(row.key)!.stale).length;
    return {
      table: startTarget.table, t0Stale: t0StaleRows.length, t0Retained: t0Retained.length,
      t0Embedded, inWindowEligible: inWindowRows.length, inWindowRetained: inWindowRetained.length,
      inWindowEmbedded,
      passed: (t0StaleRows.length === 0 || t0Embedded > 0) && inWindowEmbedded === inWindowRetained.length,
    };
  });
  if (targets.every((target) => target.t0Stale === 0)) {
    return { verdict: 'inconclusive', targets, reason: 'All T0 stale cohorts were empty' };
  }
  if (targets.some((target) => target.t0Stale > 0 && target.t0Retained === 0)) {
    return { verdict: 'inconclusive', targets, reason: 'A target lost every originally stale eligible row before T1, so clause 1 is unproven' };
  }
  const suppressionEvidence = t1.systemJournalSuppression;
  if (!suppressionEvidence || suppressionEvidence.status !== 'complete' ||
      suppressionEvidence.windowStart !== t0.capturedAt || suppressionEvidence.windowEnd !== t1.capturedAt ||
      !Number.isFinite(Date.parse(suppressionEvidence.checkedAt)) || typeof suppressionEvidence.rawOutput !== 'string' ||
      suppressionEvidence.rawOutputBytes !== Buffer.byteLength(suppressionEvidence.rawOutput) ||
      suppressionEvidence.rawOutputSha256 !== createHash('sha256').update(suppressionEvidence.rawOutput).digest('hex') ||
      !Array.isArray(suppressionEvidence.notices)) {
    return { verdict: 'inconclusive', targets, reason: 'Host system-journal suppression evidence is missing, malformed, or incomplete for [T0,T1]' };
  }
  const parsedSuppression = parseR11SystemJournalSuppressionOutput(
    suppressionEvidence.rawOutput, t0.capturedAt, t1.capturedAt);
  const recordedNoticesMatch = !parsedSuppression.error &&
    suppressionEvidence.notices.length === parsedSuppression.notices.length &&
    suppressionEvidence.notices.every((notice, index) => {
      const parsed = parsedSuppression.notices[index];
      return !!parsed && notice?.cursor === parsed.cursor && notice?.realtimeTimestamp === parsed.realtimeTimestamp &&
        notice?.message === parsed.message && notice?.suppressedCount === parsed.suppressedCount;
    });
  if (!recordedNoticesMatch) {
    return { verdict: 'inconclusive', targets, reason: 'Host system-journal suppression evidence is malformed or does not match its preserved output' };
  }
  if (parsedSuppression.notices.length > 0) {
    return { verdict: 'inconclusive', targets,
      reason: `Host system journal recorded ${parsedSuppression.notices.length} suppression notice(s) for user@1000.service during [T0,T1]` };
  }
  return targets.every((target) => target.passed)
    ? { verdict: 'healthy', targets, reason: 'All nonempty retained cohorts met the progress rule' }
    : { verdict: 'failed', targets, reason: 'At least one retained cohort missed its progress rule' };
}
