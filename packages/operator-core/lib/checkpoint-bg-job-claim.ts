/**
 * checkpoint-bg-job-claim — detect an UNVERIFIABLE background-job claim inside a
 * checkpoint (EI-18654296679612119).
 *
 * A checkpoint that reports "verification is running in bg job <id> (log
 * /tmp/foo.log), will complete once clean" reads as "basically done, just
 * wait for green" to whoever inherits the item — but native background-job
 * bookkeeping (Bash `run_in_background`/`TaskOutput`, or an ad-hoc
 * `cmd & echo $!` job) lives in the WRITER'S OWN process/shell, not anywhere
 * papercusp persists (EI-16611, see
 * cold-loop-wake-kills-native-background-bash-tasks). The instant that
 * process is replaced — session teardown, a loop/carry respawn, a
 * compaction, or simply the writer moving on — the referenced job can die
 * silently (SIGHUP) with no trace left in the checkpoint text itself. A log
 * that stopped growing with no errors LOOKS clean but is genuinely
 * ambiguous: "finished cleanly" and "was killed mid-run" are
 * indistinguishable without checking the runner's own completion marker AND
 * the OS-level liveness of the referenced pid/job.
 *
 * Confirmed live 2026-07-25 (WI-5778): a checkpoint only ~41s old still
 * referenced two background jobs that had ALREADY died — both underlying OS
 * processes had exited, and neither log reached a real completion marker.
 * Absolute recency (checkpointAgeMs) gave no signal here; only actually
 * checking `ps -p <pid>` and diffing the log's tail against the runner
 * script's own success/failure strings caught it.
 *
 * This is a cheap, PURE, warn-only heuristic (mirrors
 * {@link ./checkpoint-staleness}'s `computeCheckpointStaleness`): it cannot
 * itself know whether the referenced job is still alive — that requires an
 * OS-level check (`ps`/`kill -0`) only the reader, in their own shell, can
 * perform — so it flags the CLAIM SHAPE ("this checkpoint leans on a
 * background job as evidence") and tells the reader exactly what to go
 * verify, instead of letting the prose be trusted at face value.
 */

/**
 * Match a checkpoint that cites detached/session-local execution as evidence of
 * work still in flight. A generic statement that a server-side operation may
 * continue "in the background" is not enough: it does not imply a process owned
 * by the checkpoint writer. A handle-shaped `task_id`/`bash_id` is also not
 * enough by itself: checkpoints can contain historical task-ledger rows, including
 * explicit evidence that the task is stranded and has no live PID or log. Bare
 * handles count only when their clause also says the reader is waiting for output.
 */
/**
 * WI-38297 — WIDENED, because the original alternation MISSED the single most common
 * real-world phrasing and therefore never fired on the items it was built to catch.
 * `background` was only recognized when IMMEDIATELY followed by job/task/process/
 * verification, but agents overwhelmingly write "<cmd> running in background (bash id
 * <id>)" — the noun never appears. Measured 2026-08-12 against the actual stranded
 * checkpoints:
 *
 *   "test:affected running in background (bash id bx76day3h) — will report+complete
 *    once it finishes."                        WI-5895, open 17 days   → MISSED
 *   "tsc --noEmit running in background to confirm no type errors;
 *    awaiting result before considering this done."   WI-3561, 34 days → MISSED
 *   "read task id bf5ryqqze output when it lands. If green -> complete"
 *                                              WI-3578, 34 days       → MISSED
 *
 * So every pickup-path warning (work_items:get / claim / scheduler:get_next) stayed
 * silent on exactly the checkpoints whose promised result could never arrive. Added
 * "running in (the) background" (the detached-execution wording in those checkpoints),
 * and the `bash id` / `task id` forms when followed by a handle-shaped token — a
 * checkpoint citing a native handle is citing a reference that cannot outlive its
 * author's process, which is the whole point. A bare SQL column such as `RETURNING
 * task_id` does not name such a handle. Generic "may continue in the background" wording
 * is excluded because it also describes server-side deferred work, not only a
 * writer-owned process.
 *
 * A later false alarm showed why the handle and noun patterns must stay claim-shaped:
 * a checkpoint can quote a historical task ID, then say "no background job to await"
 * after an exact ledger read reports `state=stranded`, `livePids=null`, and
 * `logPath=null`. Those phrases do not claim active detached work. A bare task handle
 * now needs same-clause pending-output language; explicit launch/background wording,
 * a background handle, or an in-flight job phrase still fires. Negated phrases such
 * as "not running in the background" are excluded.
 *
 * The detector is warn-only and cannot establish that a referenced process is live or
 * owned by the current reader. Keep the negative controls ("this task is about…",
 * "filed a follow-up job in the queue", historical/terminal task rows) pinned below.
 */
const BG_JOB_REFERENCE_RE =
  /\b(?:running|executing|launched|started)\s+in\s+(?:the\s+)?background\b|\brun_in_background\b|\b(?:kicked off|started|launched|spawned)\s+(?:an?\s+)?background\s+(?:job|task|process|verification)s?\b|\bbackground\s+verification\s+jobs?\s+in[- ]?flight\b|\b(?:in[- ]?flight|inflight)\s+(?:verification|job|task)s?\b/i;

// Native task IDs are generated handles (typically mixed letters and digits);
// requiring the value after the label prevents a generic SQL `task_id` column
// from being treated as an in-flight job. Bash IDs also include numeric PIDs.
const TASK_JOB_HANDLE_RE =
  /\btask[_\s-]?id\s*(?:[:=#]\s*)?(?:[a-z0-9_-]*[a-z][a-z0-9_-]*\d[a-z0-9_-]*|\d{4,})\b/i;
const BASH_JOB_HANDLE_RE =
  /\bbash[_\s-]?id\s*(?:[:=#]\s*)?(?:[a-z0-9_-]*[a-z][a-z0-9_-]*\d[a-z0-9_-]*|\d{4,})\b/i;
const BG_JOB_HANDLE_RE =
  /\b(?:bg\s*jobs?|background\s+(?:job|task|process|verification)s?)\s*(?:id\s*)?(?:[:=#]\s*)?(?:[a-z0-9_-]*[a-z][a-z0-9_-]*\d[a-z0-9_-]*|\d{4,})\b/i;
const PENDING_HANDLE_CONTEXT_RE =
  /\b(?:waiting|awaiting)\s+(?:for\s+)?(?:the\s+)?(?:job|task|process|output|result|verdict)\b|\bwhen\s+(?:it|the\s+(?:output|result|job|task))\s+(?:lands|arrives|finishes|completes|returns)\b|\b(?:once|after)\s+(?:it|the\s+(?:job|task|process|output|result))\s+(?:lands|arrives|finishes|completes|returns)\b|\bfor\s+(?:the\s+)?(?:verdict|output|result)\b|\bif\s+green\s*(?:->|→|then)\b/i;
const NEGATED_PREFIX_RE =
  /\b(?:no|not|never|without|isn't|is not|wasn't|was not|doesn't|does not|didn't|did not|cannot|can't)(?:\s+(?:any|a|an|the|live|active|longer|still|currently|yet)){0,3}\s*$/i;

function clauses(text: string): string[] {
  return text.split(/[\r\n.!?;]+/).map((part) => part.trim()).filter(Boolean);
}

function hasUnnegatedMatch(text: string, pattern: RegExp): boolean {
  const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
  return [...text.matchAll(matcher)].some((match) => {
    const prefix = text.slice(0, match.index ?? 0);
    return !NEGATED_PREFIX_RE.test(prefix);
  });
}

function hasPendingHandleClaim(text: string): boolean {
  return clauses(text).some(
    (clause) =>
      (hasUnnegatedMatch(clause, TASK_JOB_HANDLE_RE) || hasUnnegatedMatch(clause, BASH_JOB_HANDLE_RE)) &&
      hasUnnegatedMatch(clause, PENDING_HANDLE_CONTEXT_RE),
  );
}

export interface BgJobCheckpointWarning {
  /** True when the checkpoint text cites a background job/task as evidence. */
  detected: boolean;
  /** Present only when `detected` — never asserts the job is dead, points the
   *  reader at the OS-level check that would prove it one way or the other. */
  reason?: string;
}

export function detectBgJobCheckpointClaim(
  checkpoint: string | null | undefined,
): BgJobCheckpointWarning {
  const text = (checkpoint ?? '').trim();
  if (
    !text ||
    (!clauses(text).some(
      (clause) =>
        hasUnnegatedMatch(clause, BG_JOB_REFERENCE_RE) || hasUnnegatedMatch(clause, BG_JOB_HANDLE_RE),
    ) &&
      !hasPendingHandleClaim(text))
  ) {
    return { detected: false };
  }
  return {
    detected: true,
    reason:
      'This checkpoint cites a background job/task as evidence — background-job bookkeeping lives ' +
      "in the WRITER'S OWN process/shell (not anywhere papercusp persists) and can die silently " +
      '(session teardown, a loop/carry respawn, a compaction) with no trace left in the checkpoint ' +
      'text (EI-16611 / EI-18654296679612119). Do NOT trust "verification in progress" or "will ' +
      'complete once clean" at face value: verify the referenced pid/job is still alive ' +
      '(`ps -p <pid>` or the job-status tool that started it) AND check the log for the ' +
      "runner's OWN completion marker — a log that simply stopped growing with no errors is " +
      'ambiguous (clean finish vs killed mid-run), not proof of success.',
  };
}
