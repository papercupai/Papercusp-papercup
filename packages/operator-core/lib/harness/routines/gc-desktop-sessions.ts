/**
 * `gc-desktop-sessions` — the periodic sweep that applies the desktop lifecycle
 * ladder to real sessions. (agent-virtual-desktops-2026-08-23 P-005 / WI-40868.)
 *
 * The DECISION lives in `desktop/desktop-lifecycle.ts` as a pure function; this
 * file is the ACTUATION and the safety envelope around it, deliberately shaped
 * like `gc-verify-instances` (TTL, per-run cap, protected-display refusal,
 * dry-run, host-local scope) because the blast radius is the same class: an
 * unattended sweep that suspends and destroys real processes.
 *
 * ## The ordering that matters: THAW BEFORE YOU KILL
 *
 * `killTask` does not thaw a frozen cgroup, and a signal into a frozen cgroup is
 * QUEUED rather than delivered — the processes are stopped at the scheduler and
 * cannot run a handler. Terminating a frozen session without thawing it first
 * therefore looks like a slow shutdown that never completes: the call reports
 * "signalled", the scope never empties, and the display stays held. Every reap of
 * a frozen session thaws first. `reapDesktopSession` is the only place that
 * knows this, on purpose.
 *
 * ## Row-versus-reality, restated
 *
 * The row is a RECORD, never proof (D-004). So this sweep only ever writes the
 * row AFTER the actuation it describes reported success. A row that says `frozen`
 * over a running cgroup misreports a spinning guest as suspended — which is worse
 * than not sweeping at all, because it is a lie the next reader trusts.
 */
import {
  classifyDesktopSession,
  type DesktopLifecycleAction,
  type DesktopVerdict,
} from '../../desktop/desktop-lifecycle';
import {
  closeDesktopSession,
  getDesktopSession,
  isTerminalDesktopState,
  listGovernableDesktopSessions,
  markDesktopFrozen,
  markDesktopIdle,
  type DesktopSessionRecord,
} from '../../desktop/desktop-session-registry';
import { freezeTask, thawTask, killTask, type ControlOutcome } from '../../task-manager/control';
import { resolveSessionStates } from '../../agent-tools/coordination/liveness-oracle';

/** Sessions acted on per run. A cap exists for the same reason gc-verify-instances
 *  has one: if a bug (or a genuinely bad day) makes everything look reapable, the
 *  damage is bounded to one pass and a human sees the log before the second. */
export const DESKTOP_GC_MAX_PER_RUN_DEFAULT = 25;

export interface GcDesktopSessionsOptions {
  /** Report what WOULD happen without freezing, thawing, killing or writing. */
  dryRun?: boolean;
  maxPerRun?: number;
  /** Injectable clock for deterministic tests. */
  now?: number;
  /** Govern another host's rows. Almost always wrong — see
   *  `listGovernableDesktopSessions` — and exists for tests and for a future
   *  host-local agent that identifies itself with an explicit ref. */
  hostRef?: string | null;
  /** Injected seams so the tests never touch a cgroup or a database. */
  deps?: Partial<GcDesktopSessionsDeps>;
}

export interface GcDesktopSessionsDeps {
  list: typeof listGovernableDesktopSessions;
  freeze: (taskId: string) => Promise<ControlOutcome>;
  thaw: (taskId: string) => Promise<ControlOutcome>;
  kill: (taskId: string) => Promise<ControlOutcome>;
  /** `notActiveAfter` is the scan snapshot's activity clock: the row write refuses
   *  when the desktop was touched since (DesktopActivityGuard). */
  markIdle: (id: string, notActiveAfter: Date) => Promise<boolean>;
  markFrozen: (id: string, notActiveAfter: Date) => Promise<boolean>;
  close: (id: string) => Promise<boolean>;
  /** Re-read one row immediately before acting on it (terminal rows included), so
   *  a desktop driven since the scan is not frozen or killed off a stale snapshot. */
  reread: (session: DesktopSessionRecord) => Promise<DesktopSessionRecord | undefined>;
  /** P-004 / D-007: the ONE liveness oracle's sessionState per agent owner, so an
   *  agent-scoped desktop is reaped once its owning session has ended. */
  ownerSessionStates: (ownerIds: readonly string[]) => Promise<Map<string, string | null>>;
}

async function defaultOwnerSessionStates(ownerIds: readonly string[]): Promise<Map<string, string | null>> {
  const verdicts = await resolveSessionStates(
    ownerIds.map((ownerId) => ({ ownerId })),
    { hydratePerId: true },
  );
  return new Map([...verdicts].map(([id, v]) => [id, v.sessionState ?? null]));
}

function defaultDeps(): GcDesktopSessionsDeps {
  return {
    list: listGovernableDesktopSessions,
    freeze: (taskId) => freezeTask(taskId),
    thaw: (taskId) => thawTask(taskId),
    // SIGTERM with escalation: a desktop's X server and its apps get a chance to
    // exit cleanly, and the cgroup kill takes whatever ignores it.
    //
    // `includeSubtree` is REQUIRED, not a nicety. A desktop's window manager and
    // apps are enrolled as CHILD tasks with their own transient scopes (see
    // desktop-provisioner), so a bare kill would take the X server and leave them
    // behind. In practice most X clients then die of their own accord when the
    // display vanishes — but "most" is not a teardown guarantee, and the one that
    // ignores the I/O error is exactly the runaway this sweep exists to reclaim.
    kill: (taskId) => killTask(taskId, { escalateAfterMs: 5_000, includeSubtree: true }),
    markIdle: (id, notActiveAfter) => markDesktopIdle(id, undefined, { notActiveAfter }),
    markFrozen: (id, notActiveAfter) => markDesktopFrozen(id, undefined, { notActiveAfter }),
    close: (id) => closeDesktopSession(id, 'released').then((ok) => ok),
    reread: (s) => getDesktopSession({ workspaceId: s.workspaceId, id: s.id, includeTerminal: true }),
    ownerSessionStates: defaultOwnerSessionStates,
  };
}

export interface GovernedDesktop {
  id: string;
  kind: string;
  display: string;
  scope: string;
  scopeRef: string;
  /** What the ladder decided. */
  action: DesktopLifecycleAction;
  reason: string;
  /** True when the governor declined to touch a protected/out-of-scope session. */
  refused?: boolean;
  /** Present when the decision could not be carried out. The action is reported
   *  as ATTEMPTED and the row is left alone — never written as if it worked. */
  failed?: string;
  /** True when the row changed. */
  applied?: boolean;
  /** Present when the snapshot verdict was NOT carried out because the live row
   *  disagreed at actuation time — most often a computer verb drove the desktop
   *  after the scan. A race the sweep noticed, not a failure. */
  stoodDown?: string;
}

export interface GcDesktopSessionsResult {
  scanned: number;
  idled: number;
  frozen: number;
  reaped: number;
  refused: number;
  failed: number;
  /** Verdicts dropped because the live row disagreed at actuation time. */
  stoodDown: number;
  dryRun: boolean;
  sessions: GovernedDesktop[];
}

/** The ladder's verdict for one row, plus P-004's owner-ended reap override. */
function verdictFor(
  session: DesktopSessionRecord,
  nowMs: number,
  ownerStates: ReadonlyMap<string, string | null>,
): DesktopVerdict {
  const verdict = classifyDesktopSession(session, nowMs);
  if (
    session.scope === 'agent' &&
    !verdict.refused &&
    verdict.action !== 'reap' &&
    ownerStates.get(session.scopeRef) === 'ended'
  ) {
    return { ...verdict, action: 'reap', reason: `owning agent session ${session.scopeRef} has ended` };
  }
  return verdict;
}

/**
 * Why NOT to carry out `verdict` after all — or null to proceed.
 *
 * Re-reads the row and stands down when it is gone or terminal, when its activity
 * clock moved past the snapshot (someone drove it), or when re-judging the live
 * row gives a different action (a viewer bound, a state moved). An unreadable row
 * also stands down: deferring a demotion one sweep costs minutes of idle CPU, and
 * acting blind can kill a desktop mid-verb.
 *
 * This shrinks the race from the whole sweep to the gap between this read and the
 * actuation (milliseconds). The freeze path closes that gap with the guarded row
 * write and thaw-back; a reap that loses it still kills, and the driver sees its
 * desktop vanish — the same outcome as a reap one sweep earlier.
 */
async function recheckBeforeActing(
  session: DesktopSessionRecord,
  verdict: DesktopVerdict,
  d: GcDesktopSessionsDeps,
  nowMs: number,
  ownerStates: ReadonlyMap<string, string | null>,
): Promise<string | null> {
  let fresh: DesktopSessionRecord | undefined;
  try {
    fresh = await d.reread(session);
  } catch (err) {
    return `could not re-read the row before acting (${String(err)}) — deferred to the next sweep`;
  }
  if (!fresh) return 'row gone since the scan';
  if (isTerminalDesktopState(fresh.state)) return `row already ${fresh.state} since the scan`;
  if (new Date(fresh.lastActiveAt).getTime() > new Date(session.lastActiveAt).getTime()) {
    return `driven since the scan (last active ${new Date(fresh.lastActiveAt).toISOString()}) — a computer verb is using it`;
  }
  const again = verdictFor(fresh, nowMs, ownerStates);
  if (again.action !== verdict.action) {
    return `re-judged as ${again.action} on the live row (${again.reason})`;
  }
  return null;
}

/**
 * Reap one session: thaw (if frozen) → kill the subtree → close the row.
 *
 * Returns the failure string, or null on success. The row is closed even when the
 * kill fails, and that is deliberate: a session whose task is unkillable is worse
 * as an open row (it keeps its display reserved in the uniqueness index, so no
 * future lease can use that display) than as a closed row with a loud log line.
 * The failure is REPORTED either way — this is a documented trade, not a swallow.
 */
async function reapDesktopSession(
  session: DesktopSessionRecord,
  d: GcDesktopSessionsDeps,
): Promise<string | null> {
  let failure: string | null = null;

  if (session.taskId) {
    if (session.state === 'frozen') {
      // ⚠ Not optional. A SIGTERM into a frozen cgroup is queued, never handled.
      const thawed = await d.thaw(session.taskId);
      if (!thawed.ok) {
        failure = `thaw failed before kill (${thawed.error}${thawed.detail ? `: ${thawed.detail}` : ''})`;
      }
    }
    const killed = await d.kill(session.taskId);
    if (!killed.ok) {
      const k = `kill failed (${killed.error}${killed.detail ? `: ${killed.detail}` : ''})`;
      failure = failure ? `${failure}; ${k}` : k;
    }
  } else {
    // Honest about the limit rather than silently closing a row over live
    // processes: an unenrolled session is reapable as a RECORD only.
    failure = 'no task_id — closed the record, but its processes were not reclaimed';
  }

  await d.close(session.id);
  return failure;
}

/**
 * One sweep. Idempotent, and safe to run concurrently with itself (every write is
 * a state-guarded UPDATE, so a double-freeze is a no-op rather than a conflict).
 */
export async function gcDesktopSessions(
  opts: GcDesktopSessionsOptions = {},
): Promise<GcDesktopSessionsResult> {
  const d = { ...defaultDeps(), ...(opts.deps ?? {}) };
  const dryRun = opts.dryRun === true;
  const maxPerRun =
    Number.isFinite(opts.maxPerRun) && (opts.maxPerRun ?? 0) > 0
      ? (opts.maxPerRun as number)
      : DESKTOP_GC_MAX_PER_RUN_DEFAULT;
  const nowMs = opts.now ?? Date.now();

  const sessions = await d.list({ hostRef: opts.hostRef ?? null });
  const out: GovernedDesktop[] = [];
  let idled = 0;
  let frozen = 0;
  let reaped = 0;
  let refused = 0;
  let failed = 0;
  let stoodDown = 0;
  let acted = 0;

  // Only agent-scoped desktops die with their owner; ask the oracle only when there
  // are some, and an unreadable oracle leaves the ladder to decide as before.
  const agentOwners = [...new Set(sessions.filter((s) => s.scope === 'agent').map((s) => s.scopeRef))];
  let ownerStates = new Map<string, string | null>();
  if (agentOwners.length > 0) {
    try {
      ownerStates = await d.ownerSessionStates(agentOwners);
    } catch {
      ownerStates = new Map();
    }
  }

  for (const session of sessions) {
    const verdict = verdictFor(session, nowMs, ownerStates);
    const base: GovernedDesktop = {
      id: session.id,
      kind: session.kind,
      display: session.display,
      scope: session.scope,
      scopeRef: session.scopeRef,
      action: verdict.action,
      reason: verdict.reason,
      ...(verdict.refused ? { refused: true } : {}),
    };

    if (verdict.refused) refused += 1;
    if (verdict.action === 'keep') {
      // Only surface the interesting non-actions: a refusal must stay visible, a
      // merely-busy desktop is noise in an hourly log.
      if (verdict.refused) out.push(base);
      continue;
    }

    // The cap bounds ACTIONS, not the scan: everything is still classified and
    // reported, so a capped run says what it did not get to rather than hiding it.
    if (acted >= maxPerRun) {
      out.push({ ...base, failed: `deferred — per-run cap of ${maxPerRun} reached` });
      continue;
    }

    if (dryRun) {
      out.push(base);
      acted += 1;
      if (verdict.action === 'idle') idled += 1;
      if (verdict.action === 'freeze') frozen += 1;
      if (verdict.action === 'reap') reaped += 1;
      continue;
    }

    // The verdict came from the snapshot taken at the top of the sweep. By now the
    // freezes and kills of earlier rows (each up to seconds) have run, and a
    // computer verb may have driven this desktop in between — acting on the stale
    // verdict would freeze or kill it mid-verb (WI-10006636). Re-read and re-judge.
    const standDown = await recheckBeforeActing(session, verdict, d, nowMs, ownerStates);
    if (standDown) {
      stoodDown += 1;
      out.push({ ...base, stoodDown: standDown });
      continue;
    }

    acted += 1;
    if (verdict.action === 'idle') {
      const ok = await d.markIdle(session.id, session.lastActiveAt);
      if (ok) idled += 1;
      out.push({ ...base, applied: ok });
      continue;
    }

    if (verdict.action === 'freeze') {
      if (!session.taskId) {
        // Reported, not silently skipped: an unenrolled desktop is the one case
        // where the governor can SEE the waste and cannot stop it, and that is
        // worth a line so someone fixes the enrolment.
        failed += 1;
        out.push({ ...base, failed: 'no task_id — cannot freeze an unenrolled desktop' });
        continue;
      }
      const res = await d.freeze(session.taskId);
      if (!res.ok) {
        failed += 1;
        out.push({
          ...base,
          failed: `freeze failed (${res.error}${res.detail ? `: ${res.detail}` : ''})`,
        });
        continue;
      }
      // Row written only after the freezer said yes — and only if nobody drove the
      // desktop while the freezer ran (the guard compares the activity clock).
      if (await d.markFrozen(session.id, session.lastActiveAt)) {
        frozen += 1;
        out.push({ ...base, applied: true });
        continue;
      }
      // Refused. If the row still says ready/idle, a verb touched it inside the
      // freeze window: thaw it back, because no driver thaws a desktop whose row
      // says `ready`, and its input would hang. If another sweep already RECORDED
      // the freeze (row `frozen`), leave it — thawing would make that row a lie.
      const after = await d.reread(session).catch(() => undefined);
      if (after && after.state === 'frozen') {
        out.push({ ...base, applied: false, stoodDown: 'freeze already recorded by a concurrent sweep' });
        continue;
      }
      const back = await d.thaw(session.taskId);
      stoodDown += 1;
      if (!back.ok) failed += 1;
      out.push({
        ...base,
        applied: false,
        stoodDown: 'driven while the freezer ran — thawed back',
        ...(back.ok
          ? {}
          : { failed: `thaw-back failed (${back.error}${back.detail ? `: ${back.detail}` : ''}) — processes may be suspended under a live row` }),
      });
      continue;
    }

    // reap
    const failure = await reapDesktopSession(session, d);
    reaped += 1;
    if (failure) failed += 1;
    out.push({ ...base, applied: true, ...(failure ? { failed: failure } : {}) });
  }

  return {
    scanned: sessions.length,
    idled,
    frozen,
    reaped,
    refused,
    failed,
    stoodDown,
    dryRun,
    sessions: out,
  };
}
