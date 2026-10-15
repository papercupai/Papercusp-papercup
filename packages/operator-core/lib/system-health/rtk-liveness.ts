/**
 * RTK liveness alarm (WI-6554700010009291, owner directives #1759 / #1764).
 *
 * Both RTK seams (the native-Bash egress guard hook and capability:bash's
 * rtk-rewrite.ts) fail OPEN when the binary is missing: the command runs
 * verbatim and nothing errors. That is correct for any single command and
 * wrong for the fleet, because it makes removal invisible. RTK vanished once
 * that way: it lived in the Homebrew prefix, the prefix was rebuilt on
 * 2026-08-15, and nothing noticed until an agent stumbled on it weeks later.
 *
 * This check turns that silence into a standing alarm: a host where RTK cannot
 * be found, or where the binary no longer runs, opens a severe-event condition
 * until it recovers. It runs on the installed-hook-drift watchdog's hourly
 * timer (the installed rtk binary is part of the same installed agent runtime
 * the drift check covers), so no new scheduler is added.
 *
 * Deliberately NOT gated on the capability:bash kill-switch flag: the native
 * Bash hook calls rtk regardless of that flag, so a missing binary disables RTK
 * there either way. Turning RTK off for the fleet on purpose means removing it
 * from the install, which this alarm will then report; that is the point.
 *
 * A present binary is not proof that RTK runs. RTK was lost TWICE in 2026-08:
 * the binary went with the Homebrew rebuild, and separately the `rtk hook
 * claude` settings entry was deleted by an installer bug while nothing failed.
 * So a second condition watches the OUTCOME: rtk's own savings ledger. When the
 * newest day it recorded a command is more than RTK_RECORDING_STALE_MS old
 * while agents ran at least RTK_RECORDING_MIN_SHELL_CALLS capability:bash
 * commands in the last 24 h, every seam has stopped reaching rtk. A quiet host
 * and the kill-switch flag OFF are both reported as such and never alarm.
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';

import { resolveAlarm, type AlarmAttentionDeps } from '../alarm-attention';
import { broadcastSevereEvent } from '../severe-event-broadcast';
import { RTK_BIN_ENV, resolveRtkBin } from '../agent-tools/capability/rtk-rewrite';

export type RtkLiveness =
  | { ok: true; bin: string; version: string }
  | { ok: false; reason: 'missing' | 'not-runnable'; detail: string; bin?: string };

const VERSION_TIMEOUT_MS = 5_000;

/** Locate rtk the same way both seams do, then prove it runs. */
export function probeRtk(env: NodeJS.ProcessEnv = process.env): RtkLiveness {
  const bin = resolveRtkBin(env);
  if (!bin) {
    return {
      ok: false,
      reason: 'missing',
      detail: `no executable rtk at ${RTK_BIN_ENV}, ~/.local/bin/rtk or on PATH`,
    };
  }
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
  const version = /^rtk\s+(\S+)/.exec(String(run.stdout ?? '').trim())?.[1];
  if (run.error || run.status !== 0 || !version) {
    return {
      ok: false,
      reason: 'not-runnable',
      bin,
      detail: run.error ? run.error.message : `\`${bin} --version\` exited ${run.status} with ${JSON.stringify(String(run.stdout ?? '').slice(0, 120))}`,
    };
  }
  return { ok: true, bin, version };
}

/** A ledger whose newest day is older than this, while agents are busy, means no seam reaches rtk. */
export const RTK_RECORDING_STALE_MS = 48 * 60 * 60_000;
/** Below this many capability:bash calls in 24 h the host is quiet, and an old ledger proves nothing. */
export const RTK_RECORDING_MIN_SHELL_CALLS = 200;
const LEDGER_TIMEOUT_MS = 10_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export type RtkLedgerRead = { ok: true; lastDate: string | null } | { ok: false; detail: string };

/**
 * The newest day rtk's own ledger recorded a command on (YYYY-MM-DD), or null
 * for an empty ledger. Read through `rtk gain --daily --format json` rather than
 * rtk's sqlite file, so rtk's own path resolution (RTK_DB_PATH, platform dirs)
 * stays rtk's business.
 */
export function readRtkLastRecordedDate(bin: string): RtkLedgerRead {
  const run = spawnSync(bin, ['gain', '--daily', '--format', 'json'], { encoding: 'utf8', timeout: LEDGER_TIMEOUT_MS });
  if (run.error || run.status !== 0) {
    return { ok: false, detail: run.error ? run.error.message : `\`rtk gain\` exited ${run.status}` };
  }
  let parsed: { summary?: { total_commands?: unknown }; daily?: unknown };
  try {
    parsed = JSON.parse(String(run.stdout ?? ''));
  } catch {
    return { ok: false, detail: `\`rtk gain\` printed non-JSON: ${JSON.stringify(String(run.stdout ?? '').slice(0, 120))}` };
  }
  if (!Array.isArray(parsed?.daily)) {
    // An empty ledger may omit `daily`; a non-empty one without it is a format we do not know.
    return parsed?.summary?.total_commands === 0
      ? { ok: true, lastDate: null }
      : { ok: false, detail: '`rtk gain --daily --format json` has no daily array' };
  }
  let lastDate: string | null = null;
  for (const day of parsed.daily as Array<{ date?: unknown; commands?: unknown }>) {
    if (typeof day?.date !== 'string' || !ISO_DAY.test(day.date)) continue;
    if (typeof day.commands !== 'number' || day.commands <= 0) continue;
    if (lastDate === null || day.date > lastDate) lastDate = day.date;
  }
  return { ok: true, lastDate };
}

/** capability:bash calls in the last 24 h on this operator database: the activity that should feed rtk. */
export async function countRecentCapabilityBashCalls(): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.tool_invocations
     WHERE tool_name = 'capability:bash'
       AND invoked_at > now() - interval '24 hours'`;
  return Number(rows[0]?.n ?? 0);
}

export type RtkRecordingOutcome =
  | { recording: 'ok'; lastDate: string }
  | { recording: 'quiet'; lastDate: string | null; shellCalls: number }
  | { recording: 'flag-off'; lastDate: string | null }
  | { recording: 'stale'; lastDate: string | null; shellCalls: number }
  | { recording: 'unknown'; detail: string };

export interface RtkLivenessCheckDeps {
  probe: () => RtkLiveness;
  host: () => string;
  rail?: AlarmAttentionDeps;
  readLedger: (bin: string) => RtkLedgerRead;
  shellCalls: () => Promise<number>;
  flagEnabled: () => Promise<boolean>;
  now: () => number;
}

export type RtkLivenessOutcome =
  | { verdict: 'ok'; version: string; recording: RtkRecordingOutcome }
  | { verdict: 'missing' | 'not-runnable'; detail: string };

/** The condition key one host's RTK alarm lives under. */
export function rtkLivenessConditionKey(host: string): string {
  return `alarm:rtk-liveness:${encodeURIComponent(host)}`;
}

/** The condition key for "rtk is installed but no seam reaches it" on one host. */
export function rtkRecordingConditionKey(host: string): string {
  return `alarm:rtk-recording:${encodeURIComponent(host)}`;
}

async function broadcast(event: Parameters<typeof broadcastSevereEvent>[0], rail: AlarmAttentionDeps | undefined): Promise<void> {
  try {
    if (rail?.broadcast) await rail.broadcast(event);
    else await broadcastSevereEvent(event);
  } catch (e) {
    console.warn(`[rtk-liveness] condition broadcast failed (non-fatal): ${String(e)}`);
  }
}

/** Decide whether rtk is still being reached, from its ledger plus the host's shell activity. */
async function checkRtkRecording(bin: string, deps: RtkLivenessCheckDeps): Promise<RtkRecordingOutcome> {
  const key = rtkRecordingConditionKey(deps.host());
  let ledger: RtkLedgerRead;
  try {
    ledger = deps.readLedger(bin);
  } catch (e) {
    ledger = { ok: false, detail: `ledger read threw: ${String(e)}` };
  }
  // NOT MEASURED is reported as such and leaves the condition as it was: neither
  // an alarm (a false one is a bug) nor a resolve (that would hide a real one).
  if (!ledger.ok) {
    console.warn(`[rtk-liveness] rtk ledger not measured: ${ledger.detail}`);
    return { recording: 'unknown', detail: ledger.detail };
  }
  const cutoff = new Date(deps.now() - RTK_RECORDING_STALE_MS).toISOString().slice(0, 10);
  if (ledger.lastDate !== null && ledger.lastDate >= cutoff) {
    await resolveAlarm(key, 'rtk-recording', deps.rail);
    return { recording: 'ok', lastDate: ledger.lastDate };
  }
  let flagOn: boolean;
  let shellCalls: number;
  try {
    flagOn = await deps.flagEnabled();
    shellCalls = flagOn ? await deps.shellCalls() : 0;
  } catch (e) {
    console.warn(`[rtk-liveness] shell activity not measured: ${String(e)}`);
    return { recording: 'unknown', detail: `activity read failed: ${String(e)}` };
  }
  if (!flagOn) {
    await resolveAlarm(key, 'rtk-recording', deps.rail);
    return { recording: 'flag-off', lastDate: ledger.lastDate };
  }
  if (shellCalls < RTK_RECORDING_MIN_SHELL_CALLS) {
    await resolveAlarm(key, 'rtk-recording', deps.rail);
    return { recording: 'quiet', lastDate: ledger.lastDate, shellCalls };
  }
  await broadcast(
    {
      conditionKey: key,
      summary: `RTK is installed on ${deps.host()} but no shell command reaches it`,
      body:
        `rtk's ledger last recorded a command on ${ledger.lastDate ?? 'no day at all'}, while agents ran ` +
        `${shellCalls} capability:bash commands in the last 24 h.\n\n` +
        'Both seams fail open, so they are running every command uncompressed. Check that ' +
        '~/.papercusp/hooks/cc/pretooluse-restricted-egress-guard.mjs matches the repo copy and is wired in ' +
        '~/.claude/settings.json (re-run apps/operator/scripts/install-standalone-mcp.sh), and that the ' +
        'serving operator build contains capability/rtk-rewrite.ts. In August 2026 the `rtk hook claude` ' +
        'settings entry was deleted by an installer bug and nothing noticed. WI-6554700010009291.',
      oneShot: true,
    },
    deps.rail,
  );
  return { recording: 'stale', lastDate: ledger.lastDate, shellCalls };
}

export async function runRtkLivenessCheckOnce(
  overrides: Partial<RtkLivenessCheckDeps> = {},
): Promise<RtkLivenessOutcome> {
  const deps: RtkLivenessCheckDeps = {
    probe: () => probeRtk(),
    host: os.hostname,
    readLedger: readRtkLastRecordedDate,
    shellCalls: countRecentCapabilityBashCalls,
    flagEnabled: () => getFlag(FLAGS.CAPABILITY_BASH_RTK, 'system'),
    now: Date.now,
    ...overrides,
  };
  const key = rtkLivenessConditionKey(deps.host());
  let liveness: RtkLiveness;
  try {
    liveness = deps.probe();
  } catch (e) {
    liveness = { ok: false, reason: 'not-runnable', detail: `probe threw: ${String(e)}` };
  }
  if (liveness.ok) {
    await resolveAlarm(key, 'rtk-liveness', deps.rail);
    return { verdict: 'ok', version: liveness.version, recording: await checkRtkRecording(liveness.bin, deps) };
  }
  const event = {
    conditionKey: key,
    summary: `RTK output compression is OFF on ${deps.host()}: rtk ${liveness.reason === 'missing' ? 'is missing' : 'does not run'}`,
    body:
      `${liveness.detail}.\n\n` +
      'Both RTK seams (the native-Bash egress guard hook and capability:bash) fail open, so every ' +
      'agent shell command is running UNCOMPRESSED and nothing else reports it. This is how RTK was ' +
      'lost on 2026-08-15 (a Homebrew prefix rebuild).\n\n' +
      'Fix: `bash apps/operator/scripts/install-rtk.sh` (pinned, sha256-verified; installs to ' +
      '~/.local/bin/rtk). WI-6554700010009291.',
    oneShot: true,
  };
  await broadcast(event, deps.rail);
  return { verdict: liveness.reason, detail: liveness.detail };
}
