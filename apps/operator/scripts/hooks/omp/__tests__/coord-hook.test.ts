/**
 * Unit tests for the OMP coord hook's pure helpers — formatting only.
 * The HTTP / handler-registration paths are integration concerns,
 * verified at deploy against a live OMP runtime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  promises as fs,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNativeTranscriptMarker } from '../../../../scripts/psu-pty-host.mjs';

import { ompSessionsLinkArgsSchema } from '@papercusp/operator-core/lib/agent-tools/omp/sessions';
import {
  FIXTURE_DIR as SUBSTITUTION_FIXTURE_DIR,
  loadPairFixtures,
  selectEnforceableFixtures,
} from "@papercusp/operator-core/lib/bash-substitution/corpus";
import { deriveSubstitutionPrefilterHeads } from "@papercusp/operator-core/lib/bash-substitution/routing-table";

import {
  buildActivityArgs,
  consumeActivityHookBundle,
  buildDisplayTitleOsc,
  buildObjectiveTitleOsc,
  callMcpTool,
  emitStatusDisplay,
  statusNoticeKey,
  ttyCandidates,
  writeOscTitle,
  _resetStatusNoticeDedup,
  resolveHookWorkspace,
  collapseDigestNotifies,
  destructiveGitCommandOp,
  destructiveGitDenyReason,
  systemdExitCommandOp,
  systemdExitDenyReason,
  detectSymlinkedPaths,
  reportActivity,
  reportActivityResult,
  reportLifecycle,
  stageActivityReport,
  launchProseBudgetForResult,
  runLaunchProseBudgetHook,
  extractPathsFromToolInput,
  formatBusyRefusal,
  formatInboxDelta,
  formatSymlinkRefusal,
  formatTurnStartReminder,
  isVertexGemini31ProRequest,
  reserveVertexGeminiRequestStart,
  vertexGeminiRequestStartReservation,
  VERTEX_GEMINI_REQUEST_START_INTERVAL_MS,
  VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS,
  isBareVertexSharedCapacity429,
  vertexSharedCapacityRetrySlot,
  vertexSharedCapacityRetryTargetMs,
  vertexSharedCapacityRetrySmoothingMs,
  VERTEX_SHARED_CAPACITY_RETRY_MAX_ADDED_MS,
  isNativeToolSearch,
  extractToolSearchQuery,
  formatToolFindRedirect,
  buildToolFindRedirect,
  IDENTICAL_CALL_LOOP_LIMIT,
  toolCallLoopKey,
  noteToolCallRepeat,
  resetToolCallLoopState,
  loopBreakReason,
  sessionRepeatKey,
  SESSION_REPEAT_LIMIT,
  noteSessionRepeat,
  resetSessionRepeatRun,
  sessionRepeatReason,
  SHELL_CALLS_PER_TURN_LIMIT,
  isShellTool,
  noteShellCall,
  shellBudgetReason,
  FLEET_LAUNCH_CALLS_PER_SESSION,
  isFleetLaunchCall,
  resetFleetLaunchBudget,
  fleetLaunchBudgetReason,
  isLocalModel,
  getOwnLaunchedModel,
  fleetLaunchMemberModel,
  fleetLaunchModelReason,
  isClaimNextCall,
  claimNextBlockReason,
  isAgentSession,
  isEvalCall,
  evalBlockReason,
  EVAL_BLOCK_ESCALATE_AFTER,
  noteEvalBlock,
  resetEvalBlockBudget,
  EVAL_BLOCK_KILL_AFTER,
  setHaltForTest,
  isAskCall,
  askBlockReason,
  isIrcCall,
  ircBlockReason,
  isMcpEndpointCurl,
  mcpCurlBlockReason,
  MCP_CURL_BLOCK_ESCALATE_AFTER,
  noteMcpCurlBlock,
  resetMcpCurlBudget,
  MCP_CURL_BLOCK_KILL_AFTER,
  isMcpToolViaBash,
  extractMcpToolViaBash,
  nativeMcpToolName,
  mcpToolViaBashReason,
  MCP_TOOL_VIA_BASH_ESCALATE_AFTER,
  noteMcpToolViaBashBlock,
  resetMcpToolViaBashBudget,
  REFLEXIVE_BLOCK_KILL_AFTER,
  REFLEXIVE_BLOCK_ESCALATE_AFTER,
  noteReflexiveBlock,
  resetReflexiveBlockBudget,
  isTodoCall,
  todoLoopReason,
  TODO_LOOP_LIMIT,
  TODO_LOOP_ESCALATE_AFTER,
  noteTodoCall,
  resetTodoLoopState,
  STALL_WATCHDOG_MS,
  STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS,
  pokeStallWatchdog,
  disarmStallWatchdog,
  noteStallToolInFlight,
  _stallWatchdogArmed,
  hookOwnerId,
  linkAdvSessionFromContext,
  ensureNativeSessionOnDisk,
  onSessionShutdown,
  onSessionStart,
  withDeadline,
  onToolCall,
  onToolResult,
  onTurnStart,
  OS_SCHEDULER_CMD_RE,
  isOsSchedulerCommand,
  isReadOnlySchedulerInvocation,
  osSchedulerDenyReason,
  tauriSubcommand,
  tauriHasExplicitTarget,
  tauriTargetDenial,
  stripShellQuotes,
  summarisePlanEvents,
  _resetHookOwnerIdForTests,
  _resetMidTurnCursorForTests,
  _resetToolCallCacheForTests,
  setDeclarationRegeneratorForTests,
  _resetDegradedNotifiedForTests,
  _resetActivityReportDedupeForTests,
  _resetNativeSessionIdForTests,
  extractOmpMessageText,
  readLastOmpAssistantText,
  looksLikeUnstructuredOwnerAsk,
  reportTurnAskIngest,
  _resetOpenAskGatesForTests,
  SUBSTITUTION_PREFILTER_HEADS,
  SUBSTITUTION_PHRASE_RE,
  RESOURCE_PREFILTER_RE,
  SUBST_SPLIT_RE,
  SUBST_RUNNER_RE,
  SUBST_ENV_RE,
  substitutionAtoms,
  substitutionAtomHead,
  substitutionPrefilterHit,
  resourcePrefilterHit,
  checkCommandVerdict,
  formatSubstitutionLines,
  hasInvokeEnvelope,
  substitutionDenyReason,
  substitutionAdvisoryText,
  TOOLS_INVOKE_FALLBACK_HINT,
  resourceBlockReason,
  stageSubstitutionAdvisory,
  drainSubstitutionAdvisory,
  OMP_BASH_TOOL,
  RTK_GUARD_MODULE,
  importRtkRewriter,
  ompBashRtkResult,
  rtkGuardModuleCandidates,
  type RtkRewriteSync,
  type InboxEntry,
} from '../coord-hook';
// The audited shell pairs, so the pre-filter guard below can read each pair's VERDICT
// instead of inferring enforceability from a fixture filename.
import { BASH_GATE_PAIRS } from '@papercusp/operator-core/lib/bash-substitution/pairs/index';
import { clearAdvisoryStash, takeAdvisories } from '../non-preempting-delivery';

const OBSERVED_BARE_VERTEX_429 =
  'Google API error (429): Resource exhausted. Please try again later. ' +
  'Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.';

// ── native-scheduler lockout (native-scheduler-lockout-2026-06-09 P-010) ─────

// hookOwnerId now PREFERS PAPERCUSP_SID; the dev/CI env may carry a real one, which would make the
// minted-`omp-…`-owner assertions throughout this suite see a `su-…` owner instead. Clear it by
// default so the suite runs in the deterministic minted-fallback mode; the single PAPERCUSP_SID-path
// test in the hookOwnerId describe sets it explicitly within its own body.
const _origPaperSidForSuite = process.env.PAPERCUSP_SID;
// isAgentSession() (WI-2350) also treats PAPERCUSP_AGENT==='omp' as an agent
// session. Clear it by default so the "owner session, marker unset" tests
// throughout the suite see isAgentSession()===false; tests that want the omp
// signal set it explicitly within their own body.
const _origPaperAgentForSuite = process.env.PAPERCUSP_AGENT;
// WI-10004632 (same class as WI-10003698): psu sessions export
// PAPERCUSP_CANONICAL_TREE=<the real staging checkout>. Inherited, it makes the
// hook's worktree guard (canonicalTreeRoot) refuse every fixture workspace the
// suite builds under a temp dir — 12 false reds in an agent shell, 0 with it
// unset. Default it to unset (=> <ws>/papercusp); a test that needs it sets it.
const _origCanonicalTreeForSuite = process.env.PAPERCUSP_CANONICAL_TREE;
beforeEach(() => {
  delete process.env.PAPERCUSP_SID;
  delete process.env.PAPERCUSP_AGENT;
  delete process.env.PAPERCUSP_CANONICAL_TREE;
  clearAdvisoryStash();
});
afterEach(() => {
  if (_origPaperSidForSuite === undefined) delete process.env.PAPERCUSP_SID;
  else process.env.PAPERCUSP_SID = _origPaperSidForSuite;
  if (_origPaperAgentForSuite === undefined) delete process.env.PAPERCUSP_AGENT;
  else process.env.PAPERCUSP_AGENT = _origPaperAgentForSuite;
  if (_origCanonicalTreeForSuite === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
  else process.env.PAPERCUSP_CANONICAL_TREE = _origCanonicalTreeForSuite;
});

describe('bare Vertex shared-capacity retry smoothing (WI-38388)', () => {
  const controlSid = 'su-43aed89f-3b8d-4fa5-aaa1-836bc7803a74';
  const treatmentSid = 'su-09381a7b-4fee-456e-9725-6a70b53e56ab';

  it('matches only the observed bare Vertex 429 shape', () => {
    expect(isBareVertexSharedCapacity429(OBSERVED_BARE_VERTEX_429)).toBe(true);
    expect(
      isBareVertexSharedCapacity429(
        OBSERVED_BARE_VERTEX_429.replace(
          'Please try again later.',
          'Quota exceeded; your limit will reset tomorrow.',
        ),
      ),
    ).toBe(false);
    expect(
      isBareVertexSharedCapacity429('Google API error (429): Resource exhausted. Please try again later.'),
    ).toBe(false);
    expect(
      isBareVertexSharedCapacity429(
        'OpenAI API error (429): Resource exhausted. Please try again later. ' +
          'https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429',
      ),
    ).toBe(false);
  });

  it('is deterministic per session, exponential by attempt, and bounded', () => {
    expect(vertexSharedCapacityRetrySlot(controlSid)).toBe(vertexSharedCapacityRetrySlot(controlSid));
    const targets = [1, 2, 3, 4, 99].map((attempt) =>
      vertexSharedCapacityRetryTargetMs(attempt, controlSid),
    );
    expect(targets[1]).toBeGreaterThan(targets[0]);
    expect(targets[2]).toBeGreaterThan(targets[1]);
    expect(targets[3]).toBe(targets[2]);
    expect(targets[4]).toBe(targets[2]);

    const added = vertexSharedCapacityRetrySmoothingMs(
      {
        type: 'auto_retry_start',
        attempt: 99,
        maxAttempts: 100,
        delayMs: 0,
        errorMessage: OBSERVED_BARE_VERTEX_429,
      },
      controlSid,
    );
    expect(added).toBeLessThanOrEqual(VERTEX_SHARED_CAPACITY_RETRY_MAX_ADDED_MS);
  });

  it('keeps the two observed simultaneous OMP subjects in distinct stable slots', () => {
    const controlSlot = vertexSharedCapacityRetrySlot(controlSid);
    const treatmentSlot = vertexSharedCapacityRetrySlot(treatmentSid);
    expect(controlSlot).not.toBe(treatmentSlot);

    const event = {
      type: 'auto_retry_start' as const,
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      errorMessage: OBSERVED_BARE_VERTEX_429,
    };
    const separationMs = Math.abs(
      vertexSharedCapacityRetrySmoothingMs(event, controlSid) -
        vertexSharedCapacityRetrySmoothingMs(event, treatmentSid),
    );
    expect(separationMs).toBeGreaterThanOrEqual(2_000);
  });

  it('subtracts OMP native delay and does not touch unrelated retries', () => {
    const targetMs = vertexSharedCapacityRetryTargetMs(1, controlSid);
    const baseEvent = {
      type: 'auto_retry_start' as const,
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      errorMessage: OBSERVED_BARE_VERTEX_429,
    };
    expect(vertexSharedCapacityRetrySmoothingMs(baseEvent, controlSid)).toBe(targetMs - 500);
    expect(
      vertexSharedCapacityRetrySmoothingMs({ ...baseEvent, delayMs: targetMs + 1 }, controlSid),
    ).toBe(0);
    expect(
      vertexSharedCapacityRetrySmoothingMs(
        { ...baseEvent, errorMessage: 'Google API error (503): model overloaded' },
        controlSid,
      ),
    ).toBe(0);
  });
});

describe('proactive Vertex Gemini 3.1 Pro request-start smoothing', () => {
  it('matches only the exact provider + model pair that reproduced shared-capacity bursts', () => {
    expect(
      isVertexGemini31ProRequest({
        provider: 'google-vertex',
        id: 'gemini-3.1-pro-preview',
      }),
    ).toBe(true);
    expect(
      isVertexGemini31ProRequest({
        provider: 'google',
        id: 'gemini-3.1-pro-preview',
      }),
    ).toBe(false);
    expect(
      isVertexGemini31ProRequest({
        provider: 'google-vertex',
        id: 'gemini-3.1-flash-preview',
      }),
    ).toBe(false);
    expect(isVertexGemini31ProRequest(undefined)).toBe(false);
  });

  it('reserves a 5s-spaced queue while staying below the OMP handler ceiling', () => {
    const nowMs = 1_000_000;
    const first = vertexGeminiRequestStartReservation(nowMs, null);
    const second = vertexGeminiRequestStartReservation(nowMs, first.nextStartAtMs);
    const third = vertexGeminiRequestStartReservation(nowMs, second.nextStartAtMs);

    expect([first.waitMs, second.waitMs, third.waitMs]).toEqual([
      0,
      VERTEX_GEMINI_REQUEST_START_INTERVAL_MS,
      VERTEX_GEMINI_REQUEST_START_INTERVAL_MS * 2,
    ]);

    const saturated = vertexGeminiRequestStartReservation(
      nowMs,
      nowMs + VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS + VERTEX_GEMINI_REQUEST_START_INTERVAL_MS,
    );
    expect(saturated).toMatchObject({
      waitMs: VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS,
      saturated: true,
    });

    const corruptFuture = vertexGeminiRequestStartReservation(
      nowMs,
      nowMs + VERTEX_GEMINI_REQUEST_START_MAX_WAIT_MS + VERTEX_GEMINI_REQUEST_START_INTERVAL_MS + 1,
    );
    expect(corruptFuture).toMatchObject({ waitMs: 0, saturated: false });
  });

  it('serializes concurrent reservations through shared local state', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'vertex-request-pacing-'));
    try {
      const nowMs = 2_000_000;
      const reservations = await Promise.all([
        reserveVertexGeminiRequestStart(stateDir, nowMs),
        reserveVertexGeminiRequestStart(stateDir, nowMs),
        reserveVertexGeminiRequestStart(stateDir, nowMs),
      ]);
      expect(reservations.map((reservation) => reservation?.waitMs).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
        0,
        VERTEX_GEMINI_REQUEST_START_INTERVAL_MS,
        VERTEX_GEMINI_REQUEST_START_INTERVAL_MS * 2,
      ]);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// NB: this describe pins the RAW ANCHOR only — "is a scheduler binary at command
// position", which is deliberately blind to the subcommand. It therefore still
// matches `crontab -l`, while `isOsSchedulerCommand` (the matcher the guard
// actually uses) exempts that read per EI-20419484186942049. The split is the
// point: the anchor finds candidates, the matcher classifies them.
describe('OS_SCHEDULER_CMD_RE (command-position OS-scheduler match)', () => {
  it('matches schedulers at command position, incl. compound + sudo forms', () => {
    for (const cmd of [
      'crontab -e',
      'crontab',
      'at 10pm -f job.sh',
      'batch < jobs.txt',
      'systemd-run --on-calendar=daily echo hi',
      'cd /tmp && crontab newtab',
      'git status; crontab -l',
      'echo done | at midnight',
      'sudo crontab -u root -e',
      'true\ncrontab -l',
    ]) {
      expect(cmd).toMatch(OS_SCHEDULER_CMD_RE);
    }
  });

  it('never matches prose args, mid-word hits, or lookalike commands', () => {
    for (const cmd of [
      'cat file.txt',
      'atuin search foo',
      'attach session-3',
      'echo "look at this"',
      'git commit -m "fix crontab docs"', // 'crontab' not at command position
      'ls -la',
      'systemctl --user restart papercup-staging-api.service', // systemctl ≠ systemd-run
    ]) {
      expect(cmd).not.toMatch(OS_SCHEDULER_CMD_RE);
    }
  });
});

describe('isOsSchedulerCommand — quote-aware matcher (EI-9937)', () => {
  it('does NOT trip on `;&|` that live INSIDE a quoted argument', () => {
    // These are read-only greps/seds where the scheduler tokens (and the pipe/
    // semicolon before them) are literal DATA inside a quoted regex/pattern —
    // no OS schedule is created. The raw anchor false-positives; the matcher must not.
    for (const cmd of [
      'grep -E "crontab|at|batch|systemd-run" packages/operator-core/lib/code-run-batch-nudge.ts',
      'grep -nE "at|batch" code-run-batch-nudge.ts',
      "grep -rn 'foo|batch' packages/operator-core/lib/",
      "sed -E 's/(a|batch)/x/' code-run-batch-nudge.ts",
      'echo "run this; batch job"',
      'wc -l packages/operator-core/lib/code-run-batch-nudge.ts',
    ]) {
      expect(isOsSchedulerCommand(cmd)).toBe(false);
    }
  });

  it('STILL denies a genuine scheduler at command position (quote-stripping never weakens the guard)', () => {
    for (const cmd of [
      'crontab -e',
      'batch < jobs.txt',
      'systemd-run --on-calendar=daily echo hi',
      'echo done | at midnight',
      'sudo crontab -u root -e',
      // an unquoted operator before the token is a REAL separator → still denied
      'echo "done; ok" && crontab -e',
      "grep -E 'a|b' f.txt | crontab -",
    ]) {
      expect(isOsSchedulerCommand(cmd)).toBe(true);
    }
  });

  it('ignores scheduler words inside interpreter heredocs but scans shell heredocs', () => {
    expect(
      isOsSchedulerCommand(`python3 - <<'PY'\nrows = []\nbatch = [r["txt"] for r in rows]\nPY`),
    ).toBe(false);
    expect(
      isOsSchedulerCommand(`cat <<'SH' | bash\nbatch < jobs.txt\nSH`),
    ).toBe(true);
  });
});

describe('native-scheduler lockout: systemd-run blocks timers, not transient units (EI-21924747520941481)', () => {
  const TRANSIENT_UNITS = [
    'systemd-run ./thing.sh',
    'systemd-run --scope ./heavy.sh',
    'systemd-run --pipe --wait --property=NoNewPrivileges=yes ./probe.sh',
    'systemd-run -p CPUQuota=200% node_modules/.bin/vitest run',
    'systemd-run --property=MemoryMax=4G npm run build',
    'sudo systemd-run --scope --collect ./probe.sh',
  ];
  const SCHEDULES = [
    'systemd-run --on-calendar=daily echo hi',
    'systemd-run --on-active=30m ./wake.sh',
    'systemd-run --on-boot=5m ./wake.sh',
    'systemd-run --on-startup=5m ./wake.sh',
    'systemd-run --on-unit-active=5m ./wake.sh',
    'systemd-run --on-unit-inactive=5m ./wake.sh',
    'systemd-run --timer-property=AccuracySec=1s --on-calendar=daily ./wake.sh',
  ];

  it('allows transient services, scopes, --pipe, and resource-control properties', () => {
    for (const cmd of TRANSIENT_UNITS) expect(isOsSchedulerCommand(cmd)).toBe(false);
  });

  it('denies every explicit systemd timer form', () => {
    for (const cmd of SCHEDULES) expect(isOsSchedulerCommand(cmd)).toBe(true);
  });

  it('does not treat a timer-looking payload after `--` as a systemd timer', () => {
    expect(isOsSchedulerCommand('systemd-run --scope -- echo --on-calendar=daily')).toBe(false);
  });

  it('keeps the schedule refusal pointed at pot:declare-wake', () => {
    const reason = osSchedulerDenyReason(SCHEDULES[0]);
    expect(reason).toMatch(/must not create OS schedules/);
    expect(reason).toMatch(/pot:declare-wake/);
  });

  it('keeps non-systemd schedulers denied', () => {
    for (const cmd of ['crontab -e', 'echo done | at midnight', 'batch < jobs.txt']) {
      expect(isOsSchedulerCommand(cmd)).toBe(true);
    }
  });
});

describe('read-only listings are exempt from the lockout (EI-20419484186942049)', () => {
  // The lockout exists to stop an agent CREATING a schedule the hive's
  // pause/status/liveness machinery cannot see. A pure LISTING creates nothing,
  // so blocking it bought no safety and taught agents to route around the rail —
  // observed live: the reporter dropped a `crontab -l` audit of a reconciler's
  // entry and verified it indirectly through journal output instead.
  //
  // MIRROR: the same classification lives in the Claude/Codex shell hook
  // (scripts/hooks/cc/pretooluse-bash-resource-gate.sh). Fix one, fix both.
  const READS = [
    'crontab -l',
    'git status; crontab -l',
    'crontab -l | grep session-archive',
    'find . -name x.ts && crontab -l',
    'crontab -u root -l',
    'crontab -l -u root',
    'sudo crontab -l',
    'at -l', // `atq` spelled differently
    'true\ncrontab -l',
    // EI-21934170410740770: a REDIRECTION is decoration, not an argument. The
    // allowlist regex is $-anchored, so every one of these used to deny — while
    // the refusal text promised listings pass, and re-running "the listing form
    // on its own" (its advertised remedy) denied a second time.
    'crontab -l 2>&1 | head -20', // the reported shape
    'crontab -l 2>/dev/null',
    'crontab -l > /tmp/out.txt',
    'crontab -l >> /tmp/out.txt',
    'crontab -l 1>/tmp/a 2>/tmp/b',
    'sudo crontab -l 2>&1 | head -5',
    'crontab -u root -l 2>/dev/null',
    'git status; crontab -l 2>&1 | wc -l',
  ];

  // The exemption is an ALLOWLIST. These are the shapes that LOOK adjacent to a
  // read and must still deny — they are what stops the fix from becoming a hole.
  const WRITES = [
    'crontab -u bob', // -u WITHOUT -l is the stdin-install form
    'crontab', // bare: stdin install
    'crontab -', // explicit stdin install
    'crontab -r',
    'crontab -e',
    'crontab my-jobs.txt',
    'crontab -l -e', // a read token does not launder a write
    'crontab -l && crontab -e',
    'crontab -l; crontab -r',
    'crontab -l | crontab -', // listing piped INTO an install
    // EI-21934170410740770: stripping redirections must stay fail-CLOSED. These
    // are the two shapes where a redirection genuinely CREATES a schedule, so
    // they must keep denying even though a read flag sits beside them.
    'crontab < jobs.txt', // stdin redirect IS the install vector
    'crontab -u bob < jobs.txt',
    'crontab -l > /var/spool/cron/crontabs/bob', // writes bob's crontab directly
    'crontab -l > /etc/cron.d/evil',
    'crontab -l >> /etc/crontab',
    'crontab -l 2>&1 | crontab -', // redirect on the read does not launder the install
  ];

  it('classifies a bare listing invocation as read-only', () => {
    // The classifier sees ONE invocation (the guard splits compounds for it),
    // so feed it single segments here rather than deriving them from the
    // compound forms above.
    for (const seg of ['crontab -l', 'crontab -u root -l', 'crontab -l -u root', 'sudo crontab -l', 'at -l']) {
      expect(isReadOnlySchedulerInvocation(seg)).toBe(true);
    }
    for (const seg of ['crontab', 'crontab -', 'crontab -e', 'crontab -r', 'crontab -u bob', 'crontab jobs.txt', 'at midnight']) {
      expect(isReadOnlySchedulerInvocation(seg)).toBe(false);
    }
  });

  // EI-21934170410740770 — the classifier never sees `crontab -l 2>&1`. The
  // guard splits compounds on [;&|\n], and the `&` inside `2>&1` is one of
  // those, so the segment handed to the classifier is the TRUNCATED
  // `crontab -l 2>` — a dangling operator with no target. Pinned explicitly
  // because a fix that only handled well-formed redirections would pass every
  // other test here and still deny the exact reported command.
  it('classifies a segment truncated mid-redirection as read-only', () => {
    for (const seg of ['crontab -l 2>', 'crontab -l 1>', 'crontab -l >', 'sudo crontab -l 2>']) {
      expect(isReadOnlySchedulerInvocation(seg)).toBe(true);
    }
    // Fail-closed: a truncated segment with no read flag is still an install.
    for (const seg of ['crontab 2>', 'crontab -u bob 2>']) {
      expect(isReadOnlySchedulerInvocation(seg)).toBe(false);
    }
  });

  it('allows every read through the matcher the guard uses', () => {
    for (const cmd of READS) expect(isOsSchedulerCommand(cmd)).toBe(false);
  });

  it('STILL denies every mutating form — the allowlist is not a hole', () => {
    for (const cmd of WRITES) expect(isOsSchedulerCommand(cmd)).toBe(true);
  });

  it('the refusal names the read/write boundary, so the rail teaches instead of just blocking', () => {
    const reason = osSchedulerDenyReason('crontab -e');
    expect(reason).toMatch(/crontab -l/);
    expect(reason).toMatch(/CREATING or MODIFYING/);
  });
});

describe('tauri-agent-tools target guard (EI-10939)', () => {
  // See the Claude/Codex mirror in cc/__tests__/bash-resource-gate.test.ts — same
  // contract, driven through the shell hook there and the TS predicate here.
  //
  // The load-bearing case is the FIRST test: with exactly ONE live bridge there is
  // no ambiguity to detect — and on this box that one bridge WAS the owner's own
  // papercusp-desktop. An ambiguity-only guard sails straight through it.
  let dir = '';
  const LIVE_A = process.pid; // this process — definitely alive
  const LIVE_B = process.ppid;
  // Linux documents pid_max as one greater than the maximum allocatable PID, so
  // it cannot collide with a live process even on a high-churn fleet host.
  const DEAD = (() => {
    try { return Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()); } catch { return 2_147_483_647; }
  })();

  const writeBridge = (pid: number, port: number) =>
    writeFileSync(join(dir, `tauri-dev-bridge-${pid}.token`), JSON.stringify({ port, token: `t-${pid}`, pid }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tat-omp-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a MUTATING command with ONE live bridge is still refused — "unambiguous" is exactly how the owner\'s window gets driven', () => {
    writeBridge(LIVE_A, 46423);
    const reason = tauriTargetDenial(`tauri-agent-tools eval 'document.title'`, dir);
    expect(reason).toMatch(/DRIVES a webview but does not say WHICH/);
    expect(reason).toMatch(new RegExp(`--pid ${LIVE_A}`)); // names the candidate
  });

  it('every mutating verb is covered', () => {
    writeBridge(LIVE_A, 46423);
    for (const cmd of [
      `tauri-agent-tools click '#send'`,
      `tauri-agent-tools type '#in' hi`,
      'tauri-agent-tools navigate /settings',
      'tauri-agent-tools invoke some_cmd',
      `tauri-agent-tools select '#d' v`,
      `tauri-agent-tools focus '#e'`,
      'tauri-agent-tools scroll --to 400',
      `tauri-agent-tools eval 'x'`,
    ]) {
      expect(tauriTargetDenial(cmd, dir), cmd).toMatch(/DRIVES a webview/);
    }
  });

  it('an explicitly aimed command passes', () => {
    writeBridge(LIVE_A, 46423);
    for (const cmd of [
      `tauri-agent-tools eval --pid 999 'x'`,
      `tauri-agent-tools click --pid=999 '#b'`,
      `tauri-agent-tools eval --port 46423 --token abc 'x'`,
    ]) {
      expect(tauriTargetDenial(cmd, dir), cmd).toBeNull();
    }
  });

  it('a READ command is allowed when unambiguous, refused when 2+ bridges are live', () => {
    writeBridge(LIVE_A, 46423);
    expect(tauriTargetDenial('tauri-agent-tools dom body', dir)).toBeNull();
    writeBridge(LIVE_B, 43929);
    const reason = tauriTargetDenial('tauri-agent-tools dom body', dir);
    expect(reason).toMatch(/2 bridges are live/);
    expect(reason).toMatch(new RegExp(`--pid ${LIVE_A}`));
    expect(reason).toMatch(new RegExp(`--pid ${LIVE_B}`));
  });

  it('a stale token from a dead app is not a candidate (and not ambiguity)', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(DEAD, 111);
    expect(tauriTargetDenial('tauri-agent-tools dom body', dir)).toBeNull();
  });

  it('never gates discovery / bridge-free commands — `probe` is the ANSWER to the deny', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(LIVE_B, 43929); // maximally ambiguous
    for (const cmd of [
      'tauri-agent-tools probe',
      'tauri-agent-tools list-windows',
      'tauri-agent-tools info',
      'tauri-agent-tools forensics --identifier ai.papercup',
      'tauri-agent-tools app-paths --identifier ai.papercup',
      'tauri-agent-tools --help',
      'tauri-agent-tools',
    ]) {
      expect(tauriTargetDenial(cmd, dir), cmd).toBeNull();
    }
  });

  it('allows when no bridge is live — nothing to hit; the tool prints its own error', () => {
    expect(tauriTargetDenial(`tauri-agent-tools eval 'x'`, dir)).toBeNull();
  });

  it('guards a full-path invocation (the binary is a global install)', () => {
    writeBridge(LIVE_A, 46423);
    expect(
      tauriTargetDenial(`/home/linuxbrew/.linuxbrew/bin/tauri-agent-tools click '#b'`, dir),
    ).toMatch(/DRIVES a webview/);
  });

  it('a quoted prose mention is not an invocation (no false deny)', () => {
    writeBridge(LIVE_A, 46423);
    expect(
      tauriTargetDenial('echo "you could run tauri-agent-tools eval document.title"', dir),
    ).toBeNull();
  });

  it('parses the subcommand and the explicit-target flags', () => {
    expect(tauriSubcommand(`tauri-agent-tools eval 'x'`)).toBe('eval');
    expect(tauriSubcommand('tauri-agent-tools --json dom body')).toBe('dom');
    expect(tauriSubcommand('tauri-agent-tools --help')).toBeNull();
    expect(tauriSubcommand('ls -la')).toBeNull();
    expect(tauriHasExplicitTarget('tauri-agent-tools eval --pid 12 x')).toBe(true);
    expect(tauriHasExplicitTarget('tauri-agent-tools eval --port 1 --token t x')).toBe(true);
    // a port with no token still falls into first-match discovery → not explicit
    expect(tauriHasExplicitTarget('tauri-agent-tools eval --port 1 x')).toBe(false);
    expect(tauriHasExplicitTarget(`tauri-agent-tools eval 'x'`)).toBe(false);
  });
});

describe('stripShellQuotes (EI-9937)', () => {
  it('replaces quoted spans with a space, leaving unquoted operators intact', () => {
    expect(stripShellQuotes('grep -E "at|batch" f')).toBe('grep -E   f');
    expect(stripShellQuotes("grep -rn 'a|b' d/")).toBe('grep -rn   d/');
    expect(stripShellQuotes('echo x && crontab -e')).toBe('echo x && crontab -e');
  });

  it('handles a backslash-escaped quote inside a double-quoted span', () => {
    expect(stripShellQuotes('echo "a \\" b" && crontab')).toBe('echo   && crontab');
  });

  it('drops an unterminated quote (only ever more permissive)', () => {
    expect(stripShellQuotes('grep "batch')).toBe('grep ');
  });
});

// ── destructive tree-wide git guard (EI-2376 follow-up (a)) ──────────────────
// TypeScript mirror of the Claude+Codex shell hook's Python guard
// (pretooluse-bash-resource-gate.sh) — see its own bash-resource-gate.test.ts
// for the shell-side coverage of the identical cases.

describe('destructiveGitCommandOp (command-position destructive git match)', () => {
  it.each([
    ['bare reset --hard', 'git reset --hard', 'git reset --hard'],
    ['reset --hard HEAD', 'git reset --hard HEAD', 'git reset --hard'],
    ['reset --hard a remote ref', 'git reset --hard origin/staging', 'git reset --hard'],
    ['clean -f', 'git clean -f', 'git clean -f'],
    ['clean -fd', 'git clean -fd', 'git clean -f'],
    ['clean -fdx', 'git clean -fdx', 'git clean -f'],
    ['checkout .', 'git checkout .', 'git checkout/restore .'],
    ['checkout -- .', 'git checkout -- .', 'git checkout/restore .'],
    ['checkout :/ (repo-root pathspec)', 'git checkout :/', 'git checkout/restore .'],
    ['restore .', 'git restore .', 'git checkout/restore .'],
    ['bare stash', 'git stash', 'git stash'],
    ['stash save', 'git stash save "wip"', 'git stash'],
    ['stash push (no explicit path)', 'git stash push', 'git stash'],
    ['sudo-prefixed reset --hard', 'sudo git reset --hard', 'git reset --hard'],
    ['compound && reset --hard', 'cd /tmp && git reset --hard', 'git reset --hard'],
    ['compound ; clean -f', 'git status ; git clean -f', 'git clean -f'],
    ['newline-separated stash', 'git status\ngit stash', 'git stash'],
    ['git -C <dir> reset --hard', 'git -C /some/repo reset --hard', 'git reset --hard'],
    // EI-18215743778965613 (self-caught 2026-07-20): `pop`/`apply` and a scoped
    // `push -- <path>` used to be exempted — but the stash is a SINGLE shared
    // LIFO stack, so a scoped push followed by `pop` popped an UNRELATED entry,
    // conflicting in files never touched by the caller.
    ['stash pop', 'git stash pop', 'git stash'],
    ['stash apply', 'git stash apply', 'git stash'],
    ['stash push with an explicit `--` path (no longer exempt)', 'git stash push -- path/to/file.ts', 'git stash'],
  ])('flags %s', (_label, command, expectedOp) => {
    expect(destructiveGitCommandOp(command)).toBe(expectedOp);
  });

  it.each([
    ['checkout of an explicit single file', 'git checkout -- path/to/file.ts'],
    ['restore of an explicit single file', 'git restore path/to/file.ts'],
    ['stash list', 'git stash list'],
    ['stash show', 'git stash show'],
    ['stash drop', 'git stash drop'],
    ['stash branch', 'git stash branch wip-x'],
    ['stash clear', 'git stash clear'],
    ['clean dry-run (no f flag)', 'git clean -n'],
    ['reset (no --hard)', 'git reset HEAD~1'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['ordinary status', 'git status'],
    ['ordinary diff', 'git diff --stat'],
    ['"reset --hard" only in a commit message, not command position', 'git commit -m "docs: explain git reset --hard"'],
    ['"git reset --hard" inside a string arg, not command position', 'echo "git reset --hard"'],
  ])('never flags %s', (_label, command) => {
    expect(destructiveGitCommandOp(command)).toBeNull();
  });
});

describe('destructiveGitDenyReason', () => {
  it('names the op + the single-file escape hatch', () => {
    const reason = destructiveGitDenyReason('git reset --hard');
    expect(reason).toContain('shared-tree guard');
    expect(reason).toContain('git reset --hard');
    expect(reason).toContain('git checkout -- <that.one.file>');
  });
});

describe('systemdExitCommandOp (EI-13135, command-position systemd exit/kill match)', () => {
  // See the Claude/Codex mirror in cc/__tests__/bash-resource-gate.test.ts — same
  // contract, driven through the shell hook there and the TS predicate here.
  it.each([
    ['systemctl --user exit', 'systemctl --user exit', 'systemctl --user exit'],
    ['systemctl exit (no --user flag)', 'systemctl exit', 'systemctl --user exit'],
    ['systemctl --user start exit.target', 'systemctl --user start exit.target', 'systemctl --user exit'],
    ['systemctl --user halt', 'systemctl --user halt', 'systemctl --user halt/poweroff'],
    ['systemctl --user poweroff', 'systemctl --user poweroff', 'systemctl --user halt/poweroff'],
    ['loginctl terminate-user', 'loginctl terminate-user someuser', 'loginctl terminate-user/kill-user'],
    ['loginctl kill-user', 'loginctl kill-user 1000', 'loginctl terminate-user/kill-user'],
    ['systemctl stop user@<uid>.service', 'systemctl stop user@1000.service', 'systemctl stop/kill user@<uid>.service'],
    ['systemctl kill user@<uid>.service', 'systemctl kill user@1000.service', 'systemctl stop/kill user@<uid>.service'],
    ['sudo-prefixed exit', 'sudo systemctl --user exit', 'systemctl --user exit'],
    ['compound && exit', 'cd /tmp && systemctl --user exit', 'systemctl --user exit'],
    ['compound ; halt', 'echo done ; systemctl --user halt', 'systemctl --user halt/poweroff'],
    ['newline-separated', 'true\nsystemctl --user exit', 'systemctl --user exit'],
    ['rtk-wrapped', 'rtk systemctl --user exit', 'systemctl --user exit'],
    ['time-wrapped', 'time systemctl --user exit', 'systemctl --user exit'],
    ['env-wrapped', 'env FOO=bar systemctl --user exit', 'systemctl --user exit'],
  ])('flags %s', (_label, command, expectedOp) => {
    expect(systemdExitCommandOp(command)).toBe(expectedOp);
  });

  it.each([
    ['status is not exit', 'systemctl --user status papercup-staging-api.service'],
    ['restart a real service is not exit', 'systemctl --user restart papercup-staging-api.service'],
    ['stop a real service is not the user@ class', 'systemctl --user stop papercup-vite.service'],
    ['"exit" only in a commit message, not command position', 'git commit -m "handle process exit"'],
    ['"systemctl --user exit" inside a quoted string, not command position', 'echo "systemctl --user exit"'],
    ['a stop of an unrelated numbered service (not user@)', 'systemctl stop worker@1000.service'],
    ['ordinary command', 'ls -la'],
  ])('never flags %s', (_label, command) => {
    expect(systemdExitCommandOp(command)).toBeNull();
  });
});

describe('systemdExitDenyReason (EI-13135)', () => {
  it('names the op + the incident + the blessed alternative', () => {
    const reason = systemdExitDenyReason('systemctl --user exit');
    expect(reason).toContain('EI-13135');
    expect(reason).toContain('systemctl --user exit');
    expect(reason).toContain('dev:restart');
  });
});

describe('onToolCall systemd exit/kill guard (EI-13135, UNCONDITIONAL — no agent marker needed)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    delete process.env.PAPERCUSP_AGENT_SESSION; // prove it fires WITHOUT the marker
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('blocks systemctl --user exit with NO agent-session marker set', async () => {
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'exit-1',
      input: { command: 'systemctl --user exit' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('EI-13135');
  });

  it('blocks even WITH the agent-session marker set (unconditional, not an OR-gate on it)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'exit-2',
      input: { command: 'loginctl kill-user 1000' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('EI-13135');
  });

  it('allows an ordinary systemctl status call', async () => {
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'exit-3',
      input: { command: 'systemctl --user status papercup-staging-api.service' },
    });
    expect(r.block).toBeUndefined();
  });

  it('covers the `shell` tool-name spelling too, not just `bash` (EI-18695939815676668)', async () => {
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'shell',
      toolCallId: 'exit-4',
      input: { command: 'systemctl --user exit' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('EI-13135');
  });
});

describe('onToolCall destructive-git guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('blocks a destructive tree-wide git command when the agent-session marker is set', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-1',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('shared-tree guard');
  });

  it('allows a safe single-file git command in agent sessions', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-2',
      input: { command: 'git checkout -- path/to/file.ts' },
    });
    expect(r.block).toBeUndefined();
  });

  it("never fires for the owner's own sessions (marker unset — D-003 exemption mirrors the scheduler lockout)", async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'git-3',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBeUndefined();
  });
});

// ── doom-loop breaker (ornith-reliability-2026-07-03 / EI-7076 + EI-7092) ────

describe('toolCallLoopKey (stable, sorted, bounded, never-throws)', () => {
  it('is identical for the same tool + same args regardless of key order', () => {
    const a = toolCallLoopKey('resolve', { action: 'apply', reason: 'go' });
    const b = toolCallLoopKey('resolve', { reason: 'go', action: 'apply' });
    expect(a).toBe(b);
  });
  it('lowercases the tool name (case-insensitive match)', () => {
    expect(toolCallLoopKey('Bash', { command: 'ls' })).toBe(toolCallLoopKey('bash', { command: 'ls' }));
  });
  it('differs when args differ', () => {
    expect(toolCallLoopKey('bash', { command: 'find a' })).not.toBe(
      toolCallLoopKey('bash', { command: 'find b' }),
    );
  });
  it('caps the arg blob so a huge input cannot blow memory', () => {
    const huge = 'x'.repeat(100_000);
    expect(toolCallLoopKey('bash', { command: huge }).length).toBeLessThan(2100);
  });
  it('never throws on an unserializable (circular) input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => toolCallLoopKey('resolve', circular)).not.toThrow();
    expect(toolCallLoopKey('resolve', circular)).toContain('unserializable');
  });
  it('treats undefined input as empty (a repeat of no-args still detects)', () => {
    expect(toolCallLoopKey('resolve', undefined)).toBe(toolCallLoopKey('resolve', {}));
  });
});

describe('noteToolCallRepeat + resetToolCallLoopState (consecutive-run counter)', () => {
  beforeEach(() => resetToolCallLoopState());
  it('increments only while the key is unchanged, resets on a new key', () => {
    const k1 = toolCallLoopKey('resolve', { action: 'apply', reason: 'x' });
    expect(noteToolCallRepeat(k1)).toBe(1);
    expect(noteToolCallRepeat(k1)).toBe(2);
    expect(noteToolCallRepeat(k1)).toBe(3);
    const k2 = toolCallLoopKey('read', { path: 'a.ts' });
    expect(noteToolCallRepeat(k2)).toBe(1); // different key → run resets
    expect(noteToolCallRepeat(k1)).toBe(1); // back to k1 is a fresh run (non-consecutive)
  });
  it('resetToolCallLoopState clears the run so the next call is length 1', () => {
    const k = toolCallLoopKey('resolve', {});
    noteToolCallRepeat(k);
    noteToolCallRepeat(k);
    resetToolCallLoopState();
    expect(noteToolCallRepeat(k)).toBe(1);
  });
});

describe('sessionRepeatKey + noteSessionRepeat (session-cumulative repeat breaker #9)', () => {
  beforeEach(() => resetSessionRepeatRun());
  it('ignores the noise `i`/intent field so prose-only tweaks key the same', () => {
    const a = sessionRepeatKey('plans:get', { i: 'read the plan', slug: 's', mode: 'full' });
    const b = sessionRepeatKey('plans:get', { i: 'read the plan WITH harness papercusp', slug: 's', mode: 'full' });
    expect(a).toBe(b); // only `i` differs → same key
  });
  it('still distinguishes calls that differ in a REAL arg', () => {
    const a = sessionRepeatKey('plans:get', { slug: 's', mode: 'full' });
    const b = sessionRepeatKey('plans:get', { slug: 's', mode: 'full', harness: 'papercusp' });
    expect(a).not.toBe(b); // adding the harness arg is a genuinely different call
  });
  it('counts consecutive same-key calls and resets on a genuinely different call', () => {
    const k1 = sessionRepeatKey('plans:get', { slug: 's', mode: 'full' });
    expect(noteSessionRepeat(k1)).toBe(1);
    expect(noteSessionRepeat(k1)).toBe(2);
    const k2 = sessionRepeatKey('read', { path: 'a.ts' });
    expect(noteSessionRepeat(k2)).toBe(1); // different call → run resets
    expect(noteSessionRepeat(k1)).toBe(1); // back to k1 is a fresh run
  });
  it('the reason tells the model to read the error + pass the missing arg as a TOP-LEVEL arg', () => {
    const r = sessionRepeatReason('plans:get', SESSION_REPEAT_LIMIT);
    expect(r).toContain('repeat-breaker');
    expect(r).toContain('harness');
    expect(r).toContain('TOP-LEVEL');
  });
});

describe('onToolCall session-repeat breaker (agent sessions only, SURVIVES turn boundaries — mode #9)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetSessionRepeatRun();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetSessionRepeatRun();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // The iter25 shape: plans:get with a VARYING prose `i`, identical real args, EACH its own turn
  // (resetToolCallLoopState between calls simulates turn_start). The turn-scoped breaker resets every
  // turn; only the session-cumulative breaker catches this.
  const plansGet = (i: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_plans_get',
      toolCallId: `pg${i}`,
      input: { i: `read the plan attempt ${i}`, slug: 'ornith-comprehension-test-2026-07-04', mode: 'full' },
    });

  it('blocks the cross-turn plans:get loop that the turn-scoped breaker misses (harness_required 58×)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
      resetToolCallLoopState(); // a fresh turn each call → the turn-scoped breaker never accumulates
      expect((await plansGet(n)).block).toBeUndefined();
    }
    resetToolCallLoopState();
    const over = await plansGet(SESSION_REPEAT_LIMIT);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('repeat-breaker');
  });

  it('a genuinely different call between repeats RESETS the run (varied work never trips)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
      resetToolCallLoopState();
      expect((await plansGet(n)).block).toBeUndefined();
    }
    // A different tool call resets the session-repeat run…
    resetToolCallLoopState();
    await onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'r', input: { file_path: '/x' } });
    // …so the next plans:get starts a fresh run and is NOT blocked.
    resetToolCallLoopState();
    expect((await plansGet(100)).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 0; n < SESSION_REPEAT_LIMIT + 4; n++) {
      resetToolCallLoopState();
      expect((await plansGet(n)).block).toBeUndefined();
    }
  });

  it('feeds the SHARED reflexive backstop — a pure repeat-loop HALTS (naming repeat)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Warm-up to the limit (allowed), then the blocked calls feed the shared backstop.
      for (let n = 0; n < SESSION_REPEAT_LIMIT - 1; n++) {
        resetToolCallLoopState();
        await plansGet(n);
      }
      for (let n = 0; n < REFLEXIVE_BLOCK_KILL_AFTER - 1; n++) {
        resetToolCallLoopState();
        expect((await plansGet(1000 + n)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      resetToolCallLoopState();
      expect((await plansGet(2000)).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('repeat');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('loopBreakReason (family-specific steer)', () => {
  it('redirects a resolve loop to plans:get / tools:invoke', () => {
    const r = loopBreakReason('resolve', 3);
    expect(r).toContain('loop-breaker');
    expect(r).toContain('3 times in a row');
    expect(r).toContain('plans:get');
    expect(r).toContain('tools:invoke');
  });
  it('redirects a shell loop to the read/grep/ls tools', () => {
    const r = loopBreakReason('bash', 4);
    expect(r).toMatch(/read|grep|ls/);
    expect(r).toContain('do not loop');
  });
  it('falls back to a generic change-your-approach steer', () => {
    const r = loopBreakReason('read', 3);
    expect(r).toContain('change your approach');
  });
});

describe('onToolCall doom-loop breaker (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const resolveCall = () =>
    onToolCall({
      type: 'tool_call',
      toolName: 'resolve',
      toolCallId: 'r',
      input: { action: 'apply', reason: 'Invoking plans:get to read the plan.' },
    });

  it('blocks the Nth identical resolve call (the EI-7076 leader loop) and passes the first two', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await resolveCall()).block).toBeUndefined(); // #1
    expect((await resolveCall()).block).toBeUndefined(); // #2
    const third = await resolveCall(); // #3 → blocked
    expect(third.block).toBe(true);
    expect(third.reason).toContain('plans:get');
    // and it keeps blocking while the loop continues
    expect((await resolveCall()).block).toBe(true);
  });

  it('blocks an identical bash find-flail (the EI-7092 member loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const findCall = () =>
      onToolCall({
        type: 'tool_call',
        toolName: 'bash',
        toolCallId: 'f',
        input: { command: 'find /repo -name design.tsx' },
      });
    await findCall();
    await findCall();
    const r = await findCall();
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/read|grep|ls/);
  });

  it('does NOT trip when the identical run is interrupted by a different call', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    await resolveCall(); // #1
    await resolveCall(); // #2
    // a different tool resets the consecutive run
    await onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'x', input: { path: 'a.ts' } });
    expect((await resolveCall()).block).toBeUndefined(); // fresh run → #1, not blocked
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let i = 0; i < IDENTICAL_CALL_LOOP_LIMIT + 2; i++) {
      expect((await resolveCall()).block).toBeUndefined();
    }
  });

  it('a specific guard (destructive git) still wins at call #1, before the loop threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'g',
      input: { command: 'git reset --hard' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('shared-tree guard'); // git message, not the loop message
  });
});

describe('isAgentSession (guard gating, WI-2350)', () => {
  const prev = { s: process.env.PAPERCUSP_AGENT_SESSION, a: process.env.PAPERCUSP_AGENT };
  afterEach(() => {
    if (prev.s === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prev.s;
    if (prev.a === undefined) delete process.env.PAPERCUSP_AGENT;
    else process.env.PAPERCUSP_AGENT = prev.a;
  });
  it('true when the canonical marker is set', () => {
    delete process.env.PAPERCUSP_AGENT;
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect(isAgentSession()).toBe(true);
  });
  it('true for an omp session even WITHOUT the marker (the run-3b backstop)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'omp';
    expect(isAgentSession()).toBe(true);
  });
  it('false for an owner session — neither signal (D-003)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    delete process.env.PAPERCUSP_AGENT;
    expect(isAgentSession()).toBe(false);
  });
  it('false for a non-omp agent (claude/codex) without the marker', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'claude';
    expect(isAgentSession()).toBe(false);
  });
  it('a guard fires for an omp session with ONLY PAPERCUSP_AGENT set (marker absent — the exact run-3b bug)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT = 'omp';
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    // The eval block (a marker-gated guard) must now trip even though the
    // canonical marker was never set — this is what was inert in run-3b.
    const r = await onToolCall({ type: 'tool_call', toolName: 'eval', toolCallId: 'e', input: { code: 'x' } });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('eval-blocked');
  });
});

describe('isEvalCall + evalBlockReason (eval doom-loop guard, WI-2299)', () => {
  it('matches a raw eval/python code-exec tool in every spelling', () => {
    expect(isEvalCall('eval')).toBe(true);
    expect(isEvalCall('eval_tool')).toBe(true);
    expect(isEvalCall('run_python')).toBe(true);
    expect(isEvalCall('python')).toBe(true);
    expect(isEvalCall('EVAL')).toBe(true); // case-insensitive
    expect(isEvalCall('mcp__ollama_cc:eval')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up legitimately-namespaced verbs or unrelated tools', () => {
    expect(isEvalCall('code:run')).toBe(false); // bare verb `run`, not `runpython`
    expect(isEvalCall('code_run')).toBe(false);
    expect(isEvalCall('plans:get')).toBe(false);
    expect(isEvalCall('bash')).toBe(false);
    expect(isEvalCall('tools:invoke')).toBe(false);
    expect(isEvalCall('evaluate')).toBe(false); // not an exact bare match
    expect(isEvalCall('')).toBe(false);
  });
  it('the reason redirects onto the native tool / tools:invoke / Bash triad', () => {
    const r = evalBlockReason();
    expect(r).toContain('eval-blocked');
    expect(r).toContain('tools:invoke');
    expect(r).toContain('Bash');
    expect(r).toContain('NATIVELY');
  });
  it('escalates to a hard, copy-pasteable directive once the block is ignored past the threshold', () => {
    // At/under the threshold: the polite triad steer (no STOP).
    expect(evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER)).toContain('NATIVELY');
    expect(evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER)).not.toContain('STOP');
    // Past it: a hard STOP naming the run length, with the literal plans:get / tools:invoke next-action.
    const hard = evalBlockReason(EVAL_BLOCK_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('plans:get');
    expect(hard).toContain('tools:invoke');
    expect(hard).toContain(`×${EVAL_BLOCK_ESCALATE_AFTER + 1}`);
  });
  it('noteEvalBlock is session-cumulative and resetEvalBlockBudget clears it', () => {
    resetEvalBlockBudget();
    expect(noteEvalBlock()).toBe(1);
    expect(noteEvalBlock()).toBe(2);
    resetEvalBlockBudget();
    expect(noteEvalBlock()).toBe(1);
  });
});

describe('onToolCall eval guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetEvalBlockBudget();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetEvalBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const evalCall = (code: string) =>
    onToolCall({ type: 'tool_call', toolName: 'eval', toolCallId: 'e', input: { code } });

  it('blocks an eval call on #1 — even with DIFFERENT code each time (non-adjacent runs)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // The consecutive-identical loop-breaker would NEVER catch this (each call differs);
    // the tool-name block must fire on the very first call.
    const first = await evalCall('plans.get(slug="x")');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('eval-blocked');
    const second = await evalCall('plans.get(slug="y")'); // different code
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < EVAL_BLOCK_ESCALATE_AFTER + 2; i++) {
      const r = await evalCall(`attempt_${i}()`); // DIFFERENT code each time — non-adjacent runs
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    // Past the threshold the steer becomes the hard, copy-pasteable STOP directive.
    expect(reason).toContain('STOP');
    expect(reason).toContain('plans:get');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await evalCall('anything')).block).toBeUndefined();
  });

  it('leaves a legitimate namespaced tool (code:run) alone', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'code:run',
      toolCallId: 'c',
      input: { code: 'ok' },
    });
    expect(r.block).toBeUndefined();
  });

  it('structurally HALTS the session after EVAL_BLOCK_KILL_AFTER cumulative blocked evals (iter14 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls 1..K-1 are blocked but must NOT halt yet — prose escalation gets its chance first.
      for (let i = 0; i < EVAL_BLOCK_KILL_AFTER - 1; i++) {
        const r = await evalCall(`attempt_${i}()`); // different code each time — non-adjacent runs
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // Call #K: still blocked AND the structural halt fires exactly once, naming the run length.
      const kth = await evalCall('attempt_final()');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(EVAL_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < EVAL_BLOCK_KILL_AFTER + 3; i++) {
        const r = await evalCall(`owner_${i}()`);
        expect(r.block).toBeUndefined(); // an owner's eval is never even blocked, let alone halted
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isMcpEndpointCurl + mcpCurlBlockReason (MCP-endpoint-curl guard, ornith mode #3 / WI-2382)', () => {
  it('matches an agent curling the MCP endpoint in the shapes a model copies from mcp.json', () => {
    // the exact endpoint path
    expect(isMcpEndpointCurl('curl http://127.0.0.1:9071/api/mcp')).toBe(true);
    // the superuser query param (MCP-only), on any host
    expect(isMcpEndpointCurl('curl "http://localhost:3070/api/mcp?superuser=1&client=x"')).toBe(true);
    // the bundle-server port alone
    expect(isMcpEndpointCurl('curl -s http://127.0.0.1:9071/')).toBe(true);
    // a POST with a bearer + JSON-RPC body, uppercased, still matches on /api/mcp
    expect(
      isMcpEndpointCurl(
        'CURL -X POST http://127.0.0.1:9071/api/mcp -H "Authorization: Bearer PCVq" -d \'{"method":"tools/call"}\'',
      ),
    ).toBe(true);
    // a /mcp path on a local operator port (no /api prefix)
    expect(isMcpEndpointCurl('curl localhost:3170/mcp')).toBe(true);
    // wget / xh / httpie clients, and curl after a shell separator
    expect(isMcpEndpointCurl('wget http://127.0.0.1:9071/api/mcp -O -')).toBe(true);
    expect(isMcpEndpointCurl('cd /tmp && curl http://localhost:9071/api/mcp')).toBe(true);
    expect(isMcpEndpointCurl('xh POST 127.0.0.1:9071/api/mcp')).toBe(true);
  });
  it('ALSO matches the python/node HTTP-client evasion (iter24: curl blocked → python urllib)', () => {
    // The exact iter24 shape: python3 -c "import urllib.request; …Request('…/api/mcp?superuser=1')"
    expect(
      isMcpEndpointCurl(
        `python3 -c "import json, urllib.request; urllib.request.Request('http://localhost:3070/api/mcp?superuser=1', data=b'{}')"`,
      ),
    ).toBe(true);
    // requests, httpx, node fetch, aiohttp — any scripting client hitting the MCP endpoint
    expect(isMcpEndpointCurl(`python3 -c "import requests; requests.post('http://127.0.0.1:9071/api/mcp', json={})"`)).toBe(true);
    expect(isMcpEndpointCurl(`python3 -c "import httpx; httpx.post('http://localhost:3070/mcp')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "fetch('http://localhost:3070/api/mcp?superuser=1')"`)).toBe(true);
  });
  it('ALSO matches the Node built-in http module evasion (iter28: fetch/curl blocked → require("http"))', () => {
    // The exact iter28 shape: node -e "const http = require('http'); http.request(…/api/mcp…)"
    expect(
      isMcpEndpointCurl(
        `cd /repo && node -e "const http = require('http'); const req = http.request('http://127.0.0.1:9071/api/mcp', {method:'POST'})"`,
      ),
    ).toBe(true);
    // https module + .get(, double-quoted require, and the node: scheme form
    expect(isMcpEndpointCurl(`node -e "const https=require(\\"https\\"); https.request('http://localhost:3070/api/mcp?superuser=1')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "require('node:http').get('http://127.0.0.1:9071/api/mcp')"`)).toBe(true);
    expect(isMcpEndpointCurl(`node -e "http.get('http://localhost:3170/mcp')"`)).toBe(true);
  });
  it('a scripting HTTP client to a NON-MCP target is still not matched (marker still required)', () => {
    expect(isMcpEndpointCurl(`python3 -c "import requests; requests.get('https://api.github.com')"`)).toBe(false);
    expect(
      isMcpEndpointCurl(`python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:3070/api/health')"`),
    ).toBe(false);
    // Node http module to a NON-MCP local route (health check) — client present, no marker → not matched
    expect(isMcpEndpointCurl(`node -e "require('http').get('http://127.0.0.1:3070/api/health')"`)).toBe(false);
  });
  it('does NOT match a legitimate external curl or a non-MCP local API probe', () => {
    expect(isMcpEndpointCurl('curl https://api.github.com/repos/x/y')).toBe(false);
    expect(isMcpEndpointCurl('curl -s https://example.com/mcp-docs')).toBe(false); // remote host, mcp-docs not a /mcp path
    expect(isMcpEndpointCurl('curl http://127.0.0.1:3070/api/health')).toBe(false); // operator health, not MCP
    expect(isMcpEndpointCurl('echo "see http://127.0.0.1:9071/api/mcp for the endpoint"')).toBe(false); // no client verb
    expect(isMcpEndpointCurl('git commit -m "wire /api/mcp curl helper"')).toBe(false); // curl is prose, not a client verb
    expect(isMcpEndpointCurl('')).toBe(false);
    expect(isMcpEndpointCurl('ls -la')).toBe(false);
  });
  it('the reason tells the model the tools are TOOLS, not an HTTP endpoint (the live-validated rescue)', () => {
    const r = mcpCurlBlockReason();
    expect(r).toContain('mcp-curl-blocked');
    expect(r).toContain('TOOLS you call directly');
    expect(r).toContain('tools:invoke');
    expect(r).toContain('plans:get');
  });
  it('escalates to a hard, copy-pasteable directive once the block is ignored past the threshold', () => {
    // At/under the threshold: the polite redirect (no STOP).
    expect(mcpCurlBlockReason(MCP_CURL_BLOCK_ESCALATE_AFTER)).not.toContain('STOP');
    // Past it: a hard STOP naming the run length, with the literal tools:invoke next-action.
    const hard = mcpCurlBlockReason(MCP_CURL_BLOCK_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('tools:invoke');
    expect(hard).toContain(`×${MCP_CURL_BLOCK_ESCALATE_AFTER + 1}`);
  });
  it('noteMcpCurlBlock is session-cumulative and resetMcpCurlBudget clears it', () => {
    resetMcpCurlBudget();
    expect(noteMcpCurlBlock()).toBe(1);
    expect(noteMcpCurlBlock()).toBe(2);
    resetMcpCurlBudget();
    expect(noteMcpCurlBlock()).toBe(1);
  });
});

describe('onToolCall MCP-endpoint-curl guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetMcpCurlBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetMcpCurlBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const curlCall = (command: string) =>
    onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'mc', input: { command } });

  it('blocks a curl-the-MCP-endpoint bash command on #1 — even with a DIFFERENT body each time (non-adjacent runs)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // The consecutive-identical loop-breaker would never catch this (each JSON body differs);
    // the command-content block must fire on the very first call.
    const first = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"name":"plans:get"}\'');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('mcp-curl-blocked');
    const second = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"name":"coord:orient"}\'');
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < MCP_CURL_BLOCK_ESCALATE_AFTER + 2; i++) {
      const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"attempt":${i}}'`); // different body each time
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    expect(reason).toContain('STOP');
    expect(reason).toContain('tools:invoke');
  });

  it('leaves a legitimate non-MCP bash command alone (operator health probe)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await curlCall('curl -s http://127.0.0.1:3070/api/health');
    expect(r.block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await curlCall('curl http://127.0.0.1:9071/api/mcp');
    expect(r.block).toBeUndefined();
  });

  it('structurally HALTS the session after MCP_CURL_BLOCK_KILL_AFTER cumulative blocked curls (mode #3 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls 1..K-1 are blocked but must NOT halt yet — prose escalation gets its chance first.
      for (let i = 0; i < MCP_CURL_BLOCK_KILL_AFTER - 1; i++) {
        const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"i":${i}}'`); // different body each time
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // Call #K: still blocked AND the structural halt fires exactly once, naming the run length.
      const kth = await curlCall('curl http://127.0.0.1:9071/api/mcp -d \'{"i":"final"}\'');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(MCP_CURL_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < MCP_CURL_BLOCK_KILL_AFTER + 3; i++) {
        const r = await curlCall(`curl http://127.0.0.1:9071/api/mcp -d '{"i":${i}}'`);
        expect(r.block).toBeUndefined(); // an owner's curl is never even blocked, let alone halted
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isMcpToolViaBash + mcpToolViaBashReason (MCP-tool-via-bash guard, ornith mode #7 / WI-2382)', () => {
  it('matches a papercusp group:verb typed as a shell command (with or without args, after a separator)', () => {
    expect(isMcpToolViaBash('fleet:launch-on-plan')).toBe(true);
    expect(isMcpToolViaBash('fleet:launch-on-plan --count 2')).toBe(true);
    expect(isMcpToolViaBash('plans:get {slug:"x", harness:"papercusp"}')).toBe(true);
    expect(isMcpToolViaBash('tools:invoke {name:"fleet:launch-on-plan"}')).toBe(true);
    expect(isMcpToolViaBash('coord:send')).toBe(true);
    expect(isMcpToolViaBash('work_items:list')).toBe(true);
    expect(isMcpToolViaBash('memory:remember')).toBe(true);
    expect(isMcpToolViaBash('pot:status')).toBe(true); // post pot-rename cutover (was 'hive'; hive:* now 404)
    expect(isMcpToolViaBash('cd /tmp && plans:get')).toBe(true); // command position after &&
  });
  it('does NOT false-positive on ordinary shell commands or a colon that is not a tool name', () => {
    expect(isMcpToolViaBash('curl http://127.0.0.1:9071/api/mcp')).toBe(false); // URL, not group:verb at cmd pos
    expect(isMcpToolViaBash("sed 's:a:b:g' file")).toBe(false); // sed is the command; colon is not a tool
    expect(isMcpToolViaBash('echo fleet:launch-on-plan')).toBe(false); // merely echoing, not invoking
    expect(isMcpToolViaBash('git log --oneline')).toBe(false);
    expect(isMcpToolViaBash('time: 5')).toBe(false); // group not a known MCP group
    expect(isMcpToolViaBash('note:todo fix later')).toBe(false);
    expect(isMcpToolViaBash('ls -la')).toBe(false);
    expect(isMcpToolViaBash('')).toBe(false);
  });
  it('the reason says call it as a DIRECT tool (not bash) and escalates to a hard STOP', () => {
    const base = mcpToolViaBashReason();
    expect(base).toContain('mcp-tool-via-bash');
    expect(base).toContain('tools:invoke');
    expect(base).toContain('fleet:launch-on-plan');
    expect(base).not.toContain('STOP —');
    const hard = mcpToolViaBashReason(MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain(`×${MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1}`);
  });
  it('names the EXACT native tool name when the group:verb is known (iter32→33 fix)', () => {
    // both branches (soft + escalated) must carry the native-name hint
    const soft = mcpToolViaBashReason(1, 'plans:get');
    expect(soft).toContain('mcp__papercusp_su_plans_get');
    expect(soft).toContain('plans:get');
    const hard = mcpToolViaBashReason(MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 1, 'fleet:launch-on-plan');
    expect(hard).toContain('mcp__papercusp_su_fleet_launch_on_plan');
    // without a group:verb the hint is absent (no dangling `mcp__` text)
    expect(mcpToolViaBashReason(1)).not.toContain('mcp__papercusp_su_');
  });
  it('noteMcpToolViaBashBlock is session-cumulative and resetMcpToolViaBashBudget clears it', () => {
    resetMcpToolViaBashBudget();
    expect(noteMcpToolViaBashBlock()).toBe(1);
    expect(noteMcpToolViaBashBlock()).toBe(2);
    resetMcpToolViaBashBudget();
    expect(noteMcpToolViaBashBlock()).toBe(1);
  });
});

describe('extractMcpToolViaBash + nativeMcpToolName (native-tool-name bridge, WI-2382 iter32→33)', () => {
  it('extract returns the normalized group:verb for a known MCP group typed as bash', () => {
    expect(extractMcpToolViaBash('plans:get {slug:"x"}')).toBe('plans:get');
    expect(extractMcpToolViaBash('cd /tmp && fleet:launch-on-plan --count 2')).toBe('fleet:launch-on-plan');
    expect(extractMcpToolViaBash('WORK_ITEMS:CLAIM')).toBe('work_items:claim'); // normalized to lowercase
  });
  it('extract returns null for non-tool colons and unknown groups (parity with isMcpToolViaBash)', () => {
    expect(extractMcpToolViaBash("sed 's:a:b:g' file")).toBeNull();
    expect(extractMcpToolViaBash('time: 5')).toBeNull(); // not a known MCP group
    expect(extractMcpToolViaBash('echo plans:get')).toBeNull(); // not at command position
    expect(extractMcpToolViaBash('ls -la')).toBeNull();
    // isMcpToolViaBash is exactly (extract !== null)
    expect(isMcpToolViaBash('plans:get')).toBe(extractMcpToolViaBash('plans:get') !== null);
    expect(isMcpToolViaBash('time: 5')).toBe(extractMcpToolViaBash('time: 5') !== null);
  });
  it('nativeMcpToolName flattens group:verb (colon + hyphens → underscores) to the omp-exposed name', () => {
    expect(nativeMcpToolName('plans:get')).toBe('mcp__papercusp_su_plans_get');
    expect(nativeMcpToolName('plans:set-status')).toBe('mcp__papercusp_su_plans_set_status');
    expect(nativeMcpToolName('fleet:launch-on-plan')).toBe('mcp__papercusp_su_fleet_launch_on_plan');
    expect(nativeMcpToolName('work_items:claim')).toBe('mcp__papercusp_su_work_items_claim');
    expect(nativeMcpToolName('TOOLS:FIND')).toBe('mcp__papercusp_su_tools_find'); // case-normalized
  });
});

describe('onToolCall MCP-tool-via-bash guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetMcpToolViaBashBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetMcpToolViaBashBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const bashCall = (command: string) =>
    onToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'mb', input: { command } });

  it('blocks fleet:launch-on-plan typed as bash on #1 — even with DIFFERENT args each time (the iter21 loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const first = await bashCall('fleet:launch-on-plan --count 2 --agent omp');
    expect(first.block).toBe(true);
    expect(first.reason).toContain('mcp-tool-via-bash');
    const second = await bashCall('tools:invoke {name:"fleet:launch-on-plan", args:{count:3}}');
    expect(second.block).toBe(true);
  });

  it('escalates the block after the session ignores it past the threshold (session-cumulative)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < MCP_TOOL_VIA_BASH_ESCALATE_AFTER + 2; i++) {
      const r = await bashCall(`plans:get {attempt:${i}}`); // different each time — dodges the identical breaker
      expect(r.block).toBe(true);
      reason = r.reason ?? '';
    }
    expect(reason).toContain('STOP');
    expect(reason).toContain('tools:invoke');
  });

  it('the block reason names the EXACT native tool for the group:verb the model typed (iter32→33 fix)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await bashCall('plans:get {slug:"ornith-comprehension-test-2026-07-04", harness:"papercusp"}');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('mcp__papercusp_su_plans_get');
  });

  it('leaves a legitimate bash command alone', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await bashCall('ls -la apps/operator/lib/llm-testing/fixtures/')).block).toBeUndefined();
    expect((await bashCall("sed -i 's/BROKEN/FIXED/' file.txt")).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await bashCall('fleet:launch-on-plan --count 2')).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — the doom-loop HALTS after the threshold (naming mcp-bash)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        const r = await bashCall(`fleet:launch-on-plan --attempt ${i}`); // different each time
        expect(r.block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await bashCall('fleet:launch-on-plan --final');
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
      expect(halts[0]).toContain('mcp-bash');
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await bashCall(`fleet:launch-on-plan --i ${i}`)).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('noteReflexiveBlock + resetReflexiveBlockBudget (shared reflexive-block backstop, iter16 / WI-2382)', () => {
  afterEach(() => resetReflexiveBlockBudget());
  it('is session-cumulative across tools and reset clears it', () => {
    resetReflexiveBlockBudget();
    expect(noteReflexiveBlock('irc')).toBe(1);
    expect(noteReflexiveBlock('ask')).toBe(2); // shared — counts across reflexive tools
    resetReflexiveBlockBudget();
    expect(noteReflexiveBlock('irc')).toBe(1);
  });
  it('halts exactly on the Kth call, not before, naming the offending tool', () => {
    resetReflexiveBlockBudget();
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) noteReflexiveBlock('irc');
      expect(halts).toHaveLength(0);
      noteReflexiveBlock('irc');
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('irc');
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('stall watchdog (ornith failure mode #5 — silence, not a loop / WI-2382)', () => {
  // The watchdog uses real timers; fake them so a test asserts the ~6-min halt
  // without waiting, and swap the halt seam so it never SIGTERMs the runner.
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  let halts: string[];
  let prevHalt: (reason: string) => void;
  beforeEach(() => {
    vi.useFakeTimers();
    disarmStallWatchdog();
    noteStallToolInFlight(false);
    halts = [];
    prevHalt = setHaltForTest((r) => halts.push(r));
    process.env.PAPERCUSP_AGENT_SESSION = '1'; // agent session — watchdog is armable
  });
  afterEach(() => {
    disarmStallWatchdog();
    noteStallToolInFlight(false);
    setHaltForTest(prevHalt);
    vi.useRealTimers();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('arms on poke and halts after STALL_WATCHDOG_MS of silence (the wedge)', () => {
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(true);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0); // not yet
    vi.advanceTimersByTime(1);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toContain('stall-watchdog');
    expect(_stallWatchdogArmed()).toBe(false); // cleared itself on halt
  });

  it('a poke before the deadline RESETS the countdown (progress = no halt)', () => {
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    pokeStallWatchdog(); // an event landed just in time
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0); // the reset gave it a fresh full window
    vi.advanceTimersByTime(1);
    expect(halts).toHaveLength(1);
  });

  it('EXTENDS (does not kill) while a legit tool is in flight, up to the cap', () => {
    noteStallToolInFlight(true); // a long build/test is running
    pokeStallWatchdog();
    // Each window elapses but the tool is still in flight → extend, not halt.
    for (let i = 0; i < STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS; i++) {
      vi.advanceTimersByTime(STALL_WATCHDOG_MS);
      expect(halts).toHaveLength(0);
    }
    // One more window past the extension cap → a hung tool still halts.
    vi.advanceTimersByTime(STALL_WATCHDOG_MS);
    expect(halts).toHaveLength(1);
    expect(halts[0]).toContain('stall-watchdog');
  });

  it('a finished long tool is NOT killed, but a later stall still is', () => {
    noteStallToolInFlight(true);
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS); // one extension (tool still running)
    expect(halts).toHaveLength(0);
    // tool_result fires: clear in-flight + rearm — the slow tool completed cleanly.
    noteStallToolInFlight(false);
    pokeStallWatchdog();
    vi.advanceTimersByTime(STALL_WATCHDOG_MS - 1);
    expect(halts).toHaveLength(0);
    vi.advanceTimersByTime(1); // now genuinely wedged between events
    expect(halts).toHaveLength(1);
  });

  it('is NEVER armed for the owner’s own sessions (marker unset — D-003)', () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * (STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS + 5));
    expect(halts).toHaveLength(0);
  });

  it('disarm clears an armed watchdog so it cannot fire (clean shutdown)', () => {
    pokeStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(true);
    disarmStallWatchdog();
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * 2);
    expect(halts).toHaveLength(0);
  });

  it('turn lifecycle: disarmed on turn_end → an idle wait-for-input NEVER halts (iter18 false-positive fix)', () => {
    // Reproduce the iter18 kill: a leader runs a kickoff turn (turn_start + a
    // tool call), then cleanly ENDS the turn (turn_end → disarm) and idles
    // waiting for its routing decision. That idle is silence-identical to a
    // wedge but is legitimate, so it must NOT halt. Mirrors the register()
    // wiring: turn_start/tool_* → poke, turn_end → disarmStallWatchdog.
    pokeStallWatchdog(); // turn_start
    noteStallToolInFlight(true);
    pokeStallWatchdog(); // tool_call (read the plan)
    noteStallToolInFlight(false);
    pokeStallWatchdog(); // tool_result
    expect(_stallWatchdogArmed()).toBe(true);
    disarmStallWatchdog(); // turn_end — clean stop; the leader now idles for input
    expect(_stallWatchdogArmed()).toBe(false);
    vi.advanceTimersByTime(STALL_WATCHDOG_MS * (STALL_WATCHDOG_MAX_INFLIGHT_EXTENSIONS + 3));
    expect(halts).toHaveLength(0); // an idle wait after a clean turn_end never fires
  });
});

describe('isAskCall + askBlockReason (interactive ask-gate guard, ornith iter10 / WI-2382)', () => {
  it('matches the bare `ask` builtin in every spelling, strips a group prefix', () => {
    expect(isAskCall('ask')).toBe(true);
    expect(isAskCall('ASK')).toBe(true); // case-insensitive
    expect(isAskCall('x:ask')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up unrelated tools whose name merely contains "ask"', () => {
    expect(isAskCall('task')).toBe(false);
    expect(isAskCall('taskcreate')).toBe(false);
    expect(isAskCall('coord:ask-owner')).toBe(false); // bare verb `askowner`, not `ask`
    expect(isAskCall('plans:get')).toBe(false);
    expect(isAskCall('')).toBe(false);
  });
  it('the reason redirects to a TEXT routing gate + coord:ask-owner', () => {
    const r = askBlockReason();
    expect(r).toContain('ask-blocked');
    expect(r).toContain('TEXT');
    expect(r).toContain('coord:ask-owner');
  });
});

describe('onToolCall ask guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  const prevArgv = process.argv;
  beforeEach(() => {
    process.argv = ['bun', 'omp'];
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    process.argv = prevArgv;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const askCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'a', input: { questions: [] } });

  it('blocks an `ask` call on #1 for an agent session, redirecting to a text gate', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await askCall();
    expect(r.block).toBe(true);
    expect(r.reason).toContain('ask-blocked');
    expect(r.reason).toContain('coord:ask-owner');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await askCall()).block).toBeUndefined();
  });

  it('allows a native question through the attached rpc-ui transport', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--mode', 'rpc-ui'];
    const result = await onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'rpc-question',
      input: { questions: [] } }, { hasUI: true });
    expect(result.block).toBeUndefined();
  });

  it.each(['rpc', 'text'])('keeps unanswered native questions blocked in %s mode', async (mode) => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--mode', mode];
    const result = await onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'no-question-ui',
      input: { questions: [] } }, { hasUI: true });
    expect(result.reason).toContain('ask-blocked');
  });

  it('requires an attached UI context even when rpc-ui was requested', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--mode', 'rpc-ui'];
    expect((await askCall()).reason).toContain('ask-blocked');
  });

  it('leaves the `task`-family and coord:ask-owner tools to their own handling (no ask sweep)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // coord:ask-owner is the SANCTIONED durable path — it must NOT be swept up by the ask guard.
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'coord:ask-owner',
      toolCallId: 'q',
      input: { question: 'ok' },
    });
    expect(r.reason ?? '').not.toContain('ask-blocked');
  });

  it('escalates the block message once the session ignores it past the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < REFLEXIVE_BLOCK_ESCALATE_AFTER + 2; i++) reason = (await askCall()).reason ?? '';
    expect(reason).toContain('STOP');
  });

  it('structurally HALTS the session after REFLEXIVE_BLOCK_KILL_AFTER blocked ask calls (iter16 / WI-2382)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await askCall()).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await askCall();
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await askCall()).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isIrcCall + ircBlockReason (native irc-distraction guard, ornith iter11 / WI-2382)', () => {
  it('matches the bare `irc` builtin in every spelling, strips a group prefix', () => {
    expect(isIrcCall('irc')).toBe(true);
    expect(isIrcCall('IRC')).toBe(true); // case-insensitive
    expect(isIrcCall('x:irc')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up unrelated tools whose name merely contains "irc"', () => {
    expect(isIrcCall('circ')).toBe(false);
    expect(isIrcCall('irc_send')).toBe(false); // bare verb `ircsend`, not `irc`
    expect(isIrcCall('search')).toBe(false);
    expect(isIrcCall('plans:get')).toBe(false);
    expect(isIrcCall('')).toBe(false);
  });
  it('the reason redirects to coord:presence + the kickoff plan read', () => {
    const r = ircBlockReason();
    expect(r).toContain('irc-blocked');
    expect(r).toContain('coord:presence');
    expect(r).toContain('plans:get');
  });
});

describe('onToolCall irc guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const ircCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'irc', toolCallId: 'i', input: {} });
  const askCall = () =>
    onToolCall({ type: 'tool_call', toolName: 'ask', toolCallId: 'a', input: { questions: [] } });

  it('blocks an `irc` call on #1 for an agent session, redirecting to coord:presence', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await ircCall();
    expect(r.block).toBe(true);
    expect(r.reason).toContain('irc-blocked');
    expect(r.reason).toContain('coord:presence');
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    expect((await ircCall()).block).toBeUndefined();
  });

  it('escalates the block message once the session ignores it past the threshold (the iter16 loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < REFLEXIVE_BLOCK_ESCALATE_AFTER + 2; i++) reason = (await ircCall()).reason ?? '';
    expect(reason).toContain('STOP');
    expect(reason).toContain('plans:get');
  });

  it('structurally HALTS the session after REFLEXIVE_BLOCK_KILL_AFTER blocked irc calls (iter16 / WI-2382 — the 482× loop)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await ircCall()).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      const kth = await ircCall();
      expect(kth.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain(String(REFLEXIVE_BLOCK_KILL_AFTER));
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('the backstop is SHARED across reflexive tools — a mixed irc+ask loop still halts at the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Alternate irc/ask; neither alone reaches the threshold, but the shared counter does.
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        await (i % 2 === 0 ? ircCall() : askCall());
      }
      expect(halts).toHaveLength(0);
      await askCall(); // the Kth reflexive block overall
      expect(halts).toHaveLength(1);
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await ircCall()).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isTodoCall + todoLoopReason (todo doom-loop guard, ornith iter19 / WI-2382)', () => {
  it('matches the legit todo tool in every spelling, strips a group prefix', () => {
    expect(isTodoCall('todo')).toBe(true);
    expect(isTodoCall('todo_write')).toBe(true);
    expect(isTodoCall('todowrite')).toBe(true);
    expect(isTodoCall('TodoWrite')).toBe(true); // case-insensitive
    expect(isTodoCall('x:todo')).toBe(true); // strips a group prefix
  });
  it('does NOT sweep up the already-blocked task* panel tools or unrelated names', () => {
    expect(isTodoCall('task')).toBe(false);
    expect(isTodoCall('taskcreate')).toBe(false);
    expect(isTodoCall('taskupdate')).toBe(false);
    expect(isTodoCall('todos')).toBe(false); // bare verb `todos`, not `todo`/`todowrite`
    expect(isTodoCall('plans:get')).toBe(false);
    expect(isTodoCall('')).toBe(false);
  });
  it('the reason redirects to the next real action (plans:get) and escalates to a hard STOP', () => {
    const base = todoLoopReason(TODO_LOOP_LIMIT + 1);
    expect(base).toContain('todo-loop');
    expect(base).toContain('plans:get');
    expect(base).not.toContain('STOP —');
    const hard = todoLoopReason(TODO_LOOP_ESCALATE_AFTER + 1);
    expect(hard).toContain('STOP');
    expect(hard).toContain('plans:get');
  });
});

describe('onToolCall todo guard (agent sessions only)', () => {
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetTodoLoopState();
  });
  afterEach(() => {
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetTodoLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // VARIED input each call — the whole point: the generic identical-call breaker cannot catch a
  // todo loop whose list keeps CHANGING (iter19's leader rewrote its list every turn), so these must
  // accumulate on the input-agnostic counter, not the identical-repeat one. Vary the list LENGTH
  // (`(i % 3) + 1` → 1,2,3,1,2,3…, never 3 consecutive equal): toolCallLoopKey uses a replacer array
  // that strips nested object keys, so ONLY a top-level-visible change (list length) makes the keys
  // differ — matching how a real rewrite loop slips past the identical-repeat breaker.
  const todoCall = (i: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'todo_write',
      toolCallId: `t${i}`,
      input: {
        todos: Array.from({ length: (i % 3) + 1 }, (_, k) => ({ content: `s${k}`, status: 'pending' })),
      },
    });
  const productiveCall = (i: number) =>
    onToolCall({ type: 'tool_call', toolName: 'read', toolCallId: `r${i}`, input: { file_path: `/x/${i}` } });

  it('allows the first TODO_LOOP_LIMIT todo calls, then blocks with an input-agnostic redirect', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) {
      expect((await todoCall(i)).block).toBeUndefined();
    }
    const over = await todoCall(TODO_LOOP_LIMIT);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('todo-loop');
  });

  it('a productive non-todo tool call RESETS the run (legit interleaved todos never trip)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    // Right up to the limit…
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) expect((await todoCall(i)).block).toBeUndefined();
    // …then a real action resets it, so the next full run of todos is allowed again.
    expect((await productiveCall(0)).block).toBeUndefined();
    for (let i = 0; i < TODO_LOOP_LIMIT; i++) {
      expect((await todoCall(100 + i)).block).toBeUndefined();
    }
    // Only a run with NO productive call between finally trips.
    expect((await todoCall(200)).block).toBe(true);
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let i = 0; i < TODO_LOOP_LIMIT + 5; i++) {
      expect((await todoCall(i)).block).toBeUndefined();
    }
  });

  it('escalates the message to a hard STOP once the session ignores it past the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    let reason = '';
    for (let i = 0; i < TODO_LOOP_ESCALATE_AFTER + 1; i++) reason = (await todoCall(i)).reason ?? '';
    expect(reason).toContain('STOP');
  });

  it('feeds the SHARED reflexive-block backstop — a pure todo loop HALTS after the threshold', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Warm-up: the allowed calls do NOT feed the backstop.
      for (let i = 0; i < TODO_LOOP_LIMIT; i++) await todoCall(i);
      // Now the blocked calls each note a reflexive block; one short of the kill threshold.
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await todoCall(1000 + i)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      // The Kth reflexive block halts the runaway.
      expect((await todoCall(2000)).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('todo');
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('never HALTS the owner’s own session even far past the kill threshold (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < TODO_LOOP_LIMIT + REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await todoCall(i)).block).toBeUndefined();
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
    }
  });

  it('noteTodoCall / resetTodoLoopState behave as a simple counter (unit)', () => {
    resetTodoLoopState();
    expect(noteTodoCall()).toBe(1);
    expect(noteTodoCall()).toBe(2);
    resetTodoLoopState();
    expect(noteTodoCall()).toBe(1);
  });
});

describe('isShellTool + shellBudgetReason (per-turn shell budget)', () => {
  it('recognizes bash/shell (case-insensitive), not other tools', () => {
    expect(isShellTool('bash')).toBe(true);
    expect(isShellTool('Bash')).toBe(true);
    expect(isShellTool('shell')).toBe(true);
    expect(isShellTool('read')).toBe(false);
    expect(isShellTool('resolve')).toBe(false);
  });
  it('the steer says converge-or-report and keeps non-shell tools open', () => {
    const r = shellBudgetReason(41);
    expect(r).toContain('41 shell commands');
    expect(r).toMatch(/converg|report/i);
    expect(r).toContain('Non-shell tools remain available');
  });
});

describe('onToolCall shell budget (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // A distinct bash command each call, so the identical-repeat breaker never fires
  // and we isolate the budget (the EI-7092 wandering-search shape).
  const wanderingBash = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: `b${n}`,
      input: { command: `grep -rn "sym_${n}" /repo` },
    });

  it('allows shell calls up to the budget, blocks the one past it with a converge steer', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT; n++) {
      expect((await wanderingBash(n)).block).toBeUndefined();
    }
    const over = await wanderingBash(SHELL_CALLS_PER_TURN_LIMIT + 1);
    expect(over.block).toBe(true);
    expect(over.reason).toContain('shell-budget');
  });

  it('non-shell tools stay OPEN after the budget is spent (so the model can still report/finish)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 3; n++) await wanderingBash(n);
    const read = await onToolCall({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'r',
      input: { path: 'a.ts' },
    });
    expect(read.block).toBeUndefined();
  });

  it('resets per turn — a fresh turn restores the full shell budget', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 1; n++) await wanderingBash(n);
    resetToolCallLoopState(); // turn_start
    expect((await wanderingBash(999)).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 1; n <= SHELL_CALLS_PER_TURN_LIMIT + 5; n++) {
      expect((await wanderingBash(n)).block).toBeUndefined();
    }
  });
});

describe('isFleetLaunchCall + fleetLaunchBudgetReason (session fleet-launch budget)', () => {
  it('recognizes every surface spelling of the launch verb', () => {
    expect(isFleetLaunchCall('mcp__papercusp_su_fleet_launch_on_plan', {})).toBe(true);
    expect(isFleetLaunchCall('fleet:launch-on-plan', {})).toBe(true);
    expect(isFleetLaunchCall('fleet_launch_on_plan', {})).toBe(true);
    expect(
      isFleetLaunchCall('mcp__papercusp_su_tools_invoke', { name: 'fleet:launch-on-plan' }),
    ).toBe(true);
    expect(isFleetLaunchCall('mcp__papercusp_su_tools_invoke', { name: 'plans:get' })).toBe(false);
    expect(isFleetLaunchCall('fleet_status', {})).toBe(false);
    expect(isFleetLaunchCall('bash', { command: 'fleet_launch_on_plan' })).toBe(false);
  });
  it('the steer says supervise-instead and forbids re-calling', () => {
    const r = fleetLaunchBudgetReason(3);
    expect(r).toContain('fleet-launch budget');
    expect(r).toContain('fleet:status');
    expect(r).toMatch(/do not re-call/i);
  });
});

describe('onToolCall fleet-launch budget (agent sessions only, session-cumulative)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
    resetFleetLaunchBudget();
    resetReflexiveBlockBudget(); // the budget block now feeds the shared reflexive backstop (gap A)
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetToolCallLoopState();
    resetFleetLaunchBudget();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  // Run-10 shape: launch re-calls INTERLEAVED with loop:checkpoint, so the
  // consecutive-identical breaker never sees a run — only the budget catches it.
  const launchCall = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_fleet_launch_on_plan',
      toolCallId: `fl${n}`,
      input: { name: 'ornith-verify-2', plan: 'p', count: 2, i: `attempt ${n}` },
    });
  const checkpointCall = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_loop_checkpoint',
      toolCallId: `cp${n}`,
      input: { did: `d${n}` },
    });

  it('run-10: blocks the launch call past the session budget even when interleaved', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    expect((await launchCall(1)).block).toBeUndefined();
    expect((await checkpointCall(1)).block).toBeUndefined();
    expect((await launchCall(2)).block).toBeUndefined();
    expect((await checkpointCall(2)).block).toBeUndefined();
    const third = await launchCall(3);
    expect(third.block).toBe(true);
    expect(third.reason).toContain('fleet-launch budget');
  });

  it('the budget survives turn_start (session-cumulative, not per-turn)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    await launchCall(1);
    await launchCall(2);
    resetToolCallLoopState(); // turn_start resets ONLY the turn-scoped counters
    const third = await launchCall(3);
    expect(third.block).toBe(true);
  });

  it('catches the tools:invoke-wrapped launch too', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const wrapped = (n: number) =>
      onToolCall({
        type: 'tool_call',
        toolName: 'mcp__papercusp_su_tools_invoke',
        toolCallId: `w${n}`,
        input: { name: 'fleet:launch-on-plan', args: { plan: 'p', count: 2, i: `a${n}` } },
      });
    expect((await wrapped(1)).block).toBeUndefined();
    expect((await wrapped(2)).block).toBeUndefined();
    expect((await wrapped(3)).block).toBe(true);
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    for (let n = 1; n <= FLEET_LAUNCH_CALLS_PER_SESSION + 3; n++) {
      expect((await launchCall(n)).block).toBeUndefined();
    }
  });

  // gap A (ornith iter35, 2026-07-05 / WI-2382): the budget guard was the ONE repeat-class
  // guard NOT wired to the shared reflexive backstop, so a leader that reflexively re-issued
  // the launch PAST the budget was blocked every time yet NEVER self-terminated. Vary a
  // NON-noise field (`plan`) each call so the session-repeat breaker (which strips only the
  // noise fields) never fires first — isolating the budget guard's OWN reflexive feed.
  const variedLaunch = (n: number) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_fleet_launch_on_plan',
      toolCallId: `vfl${n}`,
      input: { name: 'ornith-verify-2', plan: `plan-${n}`, count: 2 },
    });

  it('gap A: a launch doom-loop PAST the budget feeds the shared reflexive backstop and HALTS', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Calls #1-2 are within budget: allowed, and must NOT feed the reflexive halt.
      expect((await variedLaunch(1)).block).toBeUndefined();
      expect((await variedLaunch(2)).block).toBeUndefined();
      // Each over-budget launch is blocked AND feeds the shared backstop. The halt fires on
      // the REFLEXIVE_BLOCK_KILL_AFTER-th blocked launch (call #(2+KILL_AFTER)), not before.
      for (let k = 3; k <= 1 + REFLEXIVE_BLOCK_KILL_AFTER; k++) {
        const r = await variedLaunch(k);
        expect(r.block).toBe(true);
        expect(r.reason).toContain('fleet-launch budget');
      }
      expect(halts).toHaveLength(0);
      const halting = await variedLaunch(2 + REFLEXIVE_BLOCK_KILL_AFTER);
      expect(halting.block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('reflexive-block doom-loop');
      expect(halts[0]).toContain('fleet-launch');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isLocalModel / getOwnLaunchedModel / fleetLaunchMemberModel (fleet-launch model guard #8)', () => {
  it('isLocalModel recognizes local/gateway specs, not cloud', () => {
    expect(isLocalModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true);
    expect(isLocalModel('ollama/llama3')).toBe(true);
    expect(isLocalModel('some-ORNITH-build')).toBe(true); // case-insensitive
    expect(isLocalModel('maxwell1500')).toBe(true);
    expect(isLocalModel('claude')).toBe(false);
    expect(isLocalModel('opus:high')).toBe(false);
    expect(isLocalModel('sonnet')).toBe(false);
    expect(isLocalModel(undefined)).toBe(false);
    expect(isLocalModel('')).toBe(false);
  });
  it('getOwnLaunchedModel reads --model / --model= from argv (fail-open when absent)', () => {
    const orig = process.argv;
    try {
      process.argv = ['bun', 'omp', '--model', 'ollama-cc/maxwell1500/ornith-35b:IQ3_M'];
      expect(getOwnLaunchedModel()).toBe('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
      process.argv = ['bun', 'omp', '--model=opus:high'];
      expect(getOwnLaunchedModel()).toBe('opus:high');
      process.argv = ['bun', 'omp', '--no-lsp'];
      expect(getOwnLaunchedModel()).toBeUndefined();
    } finally {
      process.argv = orig;
    }
  });
  it('fleetLaunchMemberModel extracts from direct + tools:invoke-wrapped args', () => {
    expect(fleetLaunchMemberModel({ model: 'x' })).toBe('x');
    expect(fleetLaunchMemberModel({ name: 'fleet:launch-on-plan', args: { model: 'y' } })).toBe('y');
    expect(fleetLaunchMemberModel({ name: 'fleet:launch-on-plan', args: { count: 2 } })).toBeUndefined();
    expect(fleetLaunchMemberModel(undefined)).toBeUndefined();
  });
  it('fleetLaunchModelReason names the own model + the required arg', () => {
    const r = fleetLaunchModelReason('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
    expect(r).toContain('fleet-launch model guard');
    expect(r).toContain('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
    expect(r).toContain('model:');
  });
});

describe('onToolCall fleet-launch member-model guard (ornith mode #8 / WI-2382)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  const prevArgv = process.argv;
  const ORNITH = 'ollama-cc/maxwell1500/ornith-35b:IQ3_M';
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetFleetLaunchBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.argv = prevArgv;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    resetFleetLaunchBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const withOwnModel = (m: string) => {
    process.argv = ['bun', '/home/x/.bun/bin/omp', '--no-lsp', '--model', m];
  };
  const launch = (args: Record<string, unknown>) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: 'fl',
      input: { name: 'fleet:launch-on-plan', args },
    });

  it('blocks a local-model agent that launches WITHOUT a local member model (the iter22 bug)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await launch({ name: 'f', plan: 'p', count: 2, agent: 'omp' }); // no model
    expect(r.block).toBe(true);
    expect(r.reason).toContain('fleet-launch model guard');
    expect(r.reason).toContain(ORNITH);
  });

  it('also blocks when the launch pins a CLOUD member model', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p', model: 'claude' })).block).toBe(true);
  });

  it('ALLOWS the launch when a local member model is pinned', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p', agent: 'omp', model: ORNITH })).block).toBeUndefined();
  });

  it('does NOT fire for a CLOUD-model omp session (own model not local)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel('opus:high');
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('does NOT fire when the own model is undetectable — fail-open (no --model in argv)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--no-lsp'];
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    withOwnModel(ORNITH);
    expect((await launch({ name: 'f', plan: 'p' })).block).toBeUndefined();
  });

  it('does NOT consume the fleet-launch budget on a wrong-model block (a corrected retry stays possible)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    // 3 wrong-model attempts (varied fleet name so the generic identical-call breaker doesn't
    // short-circuit them) — all model-blocked, none reach the budget counter…
    for (let i = 0; i < 3; i++) expect((await launch({ name: 'wm' + i, plan: 'p' })).block).toBe(true);
    // …so a correct launch is still allowed (budget of 2 not yet spent).
    expect((await launch({ name: 'ok1', plan: 'p', model: ORNITH })).block).toBeUndefined();
    expect((await launch({ name: 'ok2', plan: 'p', model: ORNITH })).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — a persistent wrong-model loop HALTS (naming fleet-model)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      // Varied fleet name each call so the generic identical-call breaker never short-circuits them
      // (each must reach the #8 guard, which feeds the shared reflexive backstop).
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await launch({ name: 'f' + i, plan: 'p' })).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      expect((await launch({ name: 'f-final', plan: 'p' })).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('fleet-model');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('isClaimNextCall + claimNextBlockReason (backlog-wandering containment #11 / WI-2382)', () => {
  it('matches claim_next in direct + tools:invoke-wrapped spellings', () => {
    expect(isClaimNextCall('mcp__papercusp_su_work_items_claim_next', {})).toBe(true);
    expect(isClaimNextCall('work_items:claim_next', {})).toBe(true);
    expect(isClaimNextCall('work-items-claim-next', {})).toBe(true);
    expect(
      isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'work_items:claim_next' }),
    ).toBe(true);
    expect(isClaimNextCall('tools:invoke', { name: 'work_items:claim_next' })).toBe(true);
  });
  it('does NOT match the by-id claim path or unrelated tools', () => {
    // work_items:claim (specific assigned item) stays open — it is NOT claim_next.
    expect(isClaimNextCall('work_items:claim', {})).toBe(false);
    expect(isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'work_items:claim' })).toBe(false);
    expect(isClaimNextCall('work_items:claim_replica', {})).toBe(false);
    expect(isClaimNextCall('plans:get', {})).toBe(false);
    expect(isClaimNextCall('mcp__papercusp_su_tools_invoke', { name: 'plans:get' })).toBe(false);
    // a bash command merely mentioning claim_next is not a claim_next tool call
    expect(isClaimNextCall('bash', { command: 'echo claim_next' })).toBe(false);
  });
  it('claimNextBlockReason steers to the assigned plan + names the by-id escape hatch', () => {
    const r = claimNextBlockReason();
    expect(r).toContain('claim_next');
    expect(r).toContain('plans:get');
    expect(r).toContain('work_items:claim');
    expect(r).toContain('WI-2046');
  });
});

describe('onToolCall claim_next containment guard (ornith mode #11 / WI-2382)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  const prevArgv = process.argv;
  const ORNITH = 'ollama-cc/maxwell1500/ornith-35b:IQ3_M';
  beforeEach(() => {
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.argv = prevArgv;
    resetToolCallLoopState();
    resetReflexiveBlockBudget();
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  const withOwnModel = (m: string) => {
    process.argv = ['bun', '/home/x/.bun/bin/omp', '--no-lsp', '--model', m];
  };
  const claimNext = (id: string) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: id,
      input: { name: 'work_items:claim_next', args: {} },
    });

  it('blocks claim_next for a LOCAL-model agent session (the iter27 WI-2046 bug)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await claimNext('cn1');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('claim_next');
    expect(r.reason).toContain('plans:get');
  });

  it('ALLOWS the by-id claim path for the same local-model session', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'mcp__papercusp_su_tools_invoke',
      toolCallId: 'cbyid',
      input: { name: 'work_items:claim', args: { id: 'WI-2046' } },
    });
    expect(r.block).toBeUndefined();
  });

  it('does NOT fire for a CLOUD-model omp session (own model not local)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel('opus:high');
    expect((await claimNext('cn-cloud')).block).toBeUndefined();
  });

  it('does NOT fire when the own model is undetectable — fail-open (no --model in argv)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    process.argv = ['bun', 'omp', '--no-lsp'];
    expect((await claimNext('cn-noarg')).block).toBeUndefined();
  });

  it('never fires for the owner’s own sessions (marker unset — D-003)', async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    withOwnModel(ORNITH);
    expect((await claimNext('cn-owner')).block).toBeUndefined();
  });

  it('feeds the SHARED reflexive backstop — a persistent claim_next loop HALTS (naming claim-next)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    withOwnModel(ORNITH);
    const halts: string[] = [];
    const prevHalt = setHaltForTest((reason) => halts.push(reason));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 1; i++) {
        expect((await claimNext('cn-loop' + i)).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
      expect((await claimNext('cn-final')).block).toBe(true);
      expect(halts).toHaveLength(1);
      expect(halts[0]).toContain('claim-next');
    } finally {
      setHaltForTest(prevHalt);
    }
  });
});

describe('onToolCall native-scheduler guard (agent sessions only)', () => {
  const originalFetch = global.fetch;
  const prevMarker = process.env.PAPERCUSP_AGENT_SESSION;
  beforeEach(() => {
    // The allow paths fall through to the fire-and-forget activity report —
    // stub fetch so no test ever touches the network.
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevMarker === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
    else process.env.PAPERCUSP_AGENT_SESSION = prevMarker;
  });

  it('blocks an OS-scheduler bash command when the agent-session marker is set', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-1',
      input: { command: 'cd /tmp && crontab evil-tab' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('pot:declare-wake');
  });

  it('covers bash variants (bash_interactive etc.) via the prefix match', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash_interactive',
      toolCallId: 'sched-2',
      input: { command: 'at 5pm' },
    });
    expect(r.block).toBe(true);
  });

  it('allows non-scheduler commands in agent sessions', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-3',
      input: { command: 'git status' },
    });
    expect(r.block).toBeUndefined();
  });

  it("never fires for the owner's own sessions (marker unset — D-003)", async () => {
    delete process.env.PAPERCUSP_AGENT_SESSION;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 'sched-4',
      input: { command: 'crontab -l' },
    });
    expect(r.block).toBeUndefined();
  });

  it('covers the `shell` tool-name spelling too, not just `bash` (EI-18695939815676668)', async () => {
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'shell',
      toolCallId: 'sched-5',
      input: { command: 'cd /tmp && crontab evil-tab' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('pot:declare-wake');
  });
});

/**
 * Build a temp papercup-style workspace with one `.git` worktree and a
 * cleanup fn. The hook resolves a path's worktree by walking up to
 * `.git`, gated on that worktree being a direct child of
 * PAPERCUSP_WORKSPACE_ROOT (mirrors the cc hook), so fixtures need a real
 * on-disk `.git`. The base is realpath'd so the dirname/workspace
 * comparison is symlink-stable (macOS tmpdir is symlinked).
 */
async function makeWorktreeFixture(): Promise<{
  workspace: string;
  repo: string;
  cleanup: () => Promise<void>;
}> {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'omp-hook-ws-')),
  );
  const repo = join(base, 'papercusp'); // canonical staging tree (worktree guard default: <ws>/papercusp)
  await fs.mkdir(join(repo, '.git'), { recursive: true });
  await fs.writeFile(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return {
    workspace: base,
    repo,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

describe('formatTurnStartReminder', () => {
  it('returns "" when there is nothing to surface', () => {
    expect(
      formatTurnStartReminder({
        ownerId: 'a',
        inbox: [],
        heldLocks: [],
        changedPlans: [],
      }),
    ).toBe('');
  });

  it('renders escalations first within the inbox', () => {
    const inbox: InboxEntry[] = [
      {
        ts: '2026-05-20T00:00:00Z',
        msg_id: 'm1',
        from: 'B',
        kind: 'message',
        summary: 'hi',
      },
      {
        ts: '2026-05-20T00:00:01Z',
        msg_id: 'm2',
        from: 'C',
        kind: 'escalation',
        severity: 'blocker',
        summary: 'urgent',
      },
    ];
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox,
      heldLocks: [],
      changedPlans: [],
    });
    expect(out).toContain('<system-reminder type="coord">');
    expect(out).toContain('Inbox — 2 unread');
    // escalation should appear before the plain message line in output order
    expect(out.indexOf('escalation:blocker')).toBeLessThan(
      out.indexOf('[message from B]'),
    );
  });

  it('truncates long lists and surfaces a "… and N more" hint for locks', () => {
    const heldLocks = Array.from({ length: 8 }, (_, i) => ({
      path: `apps/operator/x${i}.ts`,
    }));
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox: [],
      heldLocks,
      changedPlans: [],
    });
    expect(out).toContain('currently hold 8 locks');
    expect(out).toContain('… and 3 more');
  });

  it('renders changed-plans block when present', () => {
    const out = formatTurnStartReminder({
      ownerId: 'A',
      inbox: [],
      heldLocks: [],
      changedPlans: [
        { plan_slug: 'foo-2026-05-20', events: ['decision_added', 'now_updated'] },
      ],
    });
    expect(out).toContain('Plans changed since you last read');
    expect(out).toContain('foo-2026-05-20 — decision_added, now_updated');
  });
});

describe('register (OMP adapter)', () => {
  it('makes a managed seed natively readable before any assistant response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-seed-persistence-'));
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    const marker = '⟦turn-origin:session-port nonce:13710410db2a0c23⟧';
    const sinceMs = Date.now() - 1000;
    const userRow = { type: 'message', timestamp: new Date().toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `${marker}\nseed` }] } };
    // OMP's fresh SessionManager buffers entries until an assistant exists,
    // unless ensureOnDisk has enabled persistence. Exercise that boundary
    // with the production host reader, including a negative lazy control.
    const lazySession = (name: string) => {
      const agentDir = join(root, name);
      const sessionDir = join(agentDir, 'sessions');
      mkdirSync(sessionDir, { recursive: true });
      const file = join(sessionDir, 'native.jsonl');
      const entries: unknown[] = [];
      let eager = false;
      const write = () => writeFileSync(file, entries.map(row => JSON.stringify(row)).join('\n') + '\n');
      return {
        file, env: { PI_CODING_AGENT_DIR: agentDir },
        appendUser() { entries.push(userRow); if (eager) write(); },
        async ensureOnDisk() { eager = true; write(); },
      };
    };
    try {
      const control = lazySession('lazy-control');
      control.appendUser();
      expect(findNativeTranscriptMarker({ agent: 'omp', env: control.env, marker, sinceMs })).toBeNull();
      const session = lazySession('managed-target');
      await onSessionStart({ sessionManager: session });
      session.appendUser();
      expect(findNativeTranscriptMarker({ agent: 'omp', env: session.env, marker, sinceMs })).toBe(session.file);
      await expect(ensureNativeSessionOnDisk({ sessionManager: {} })).resolves.toBe(false);
    } finally {
      global.fetch = originalFetch;
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Smoke test for the corrected OMP HookAPI contract (verified
   * 2026-05-20 against @oh-my-pi/pi-coding-agent installed version):
   *
   *   - session_start / turn_start handler return values are DISCARDED
   *   - tool_call may return ToolCallEventResult to block
   *   - model-facing advisories are stashed for the tool_result seam
   */
  it('subscribes the eight coordination, provider-pacing, and retry lifecycle handlers', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ msg: unknown; opts?: unknown }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: unknown, opts?: unknown) => {
        sent.push({ msg, opts });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);
    expect([...subs.keys()].sort()).toEqual([
      'auto_retry_start',
      'before_provider_request',
      'session_shutdown',
      'session_start',
      'tool_call',
      'tool_result',
      'turn_end',
      'turn_start',
    ]);
    // tool_call handler permits an empty edit (no path → nothing to
    // claim → fall through). file-locking #2 covers the real busy /
    // unreachable / release paths in their own describe blocks.
    const block = await subs.get('tool_call')!(
      { type: 'tool_call', toolName: 'edit', toolCallId: 't1', input: {} },
      {},
    );
    expect(block).toEqual({});
  });

  it('awaits only the computed smoothing interval for a bare Vertex 429', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.PAPERCUSP_SID = 'su-43aed89f-3b8d-4fa5-aaa1-836bc7803a74';
    _resetHookOwnerIdForTests();
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: vi.fn(),
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);
    const event = {
      type: 'auto_retry_start' as const,
      attempt: 1,
      maxAttempts: 10,
      delayMs: 500,
      errorMessage: OBSERVED_BARE_VERTEX_429,
    };
    const expectedMs = vertexSharedCapacityRetrySmoothingMs(event, process.env.PAPERCUSP_SID);
    let settled = false;
    const pending = Promise.resolve(subs.get('auto_retry_start')!(event, {})).then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(expectedMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(settled).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[coord-retry] smoothing bare Vertex'));
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('has no model-facing pi.sendMessage call site and imports the shared delivery seam', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../coord-hook.ts'), 'utf8');
    expect(source).toContain("from './non-preempting-delivery'");
    expect(source).not.toMatch(/pi\??\.sendMessage\s*\(/);
  });

  it('operator unreachable with no coord work sends no hidden reminder (F-H4)', async () => {
    // No operator configured in the unit-test env (no PAPERCUSP_*_URL),
    // so probeOperator() → false → the turn resolves to DETACHED mode.
    // Detached is a supported mode, not a failure. Empty detached turns
    // must not send a hidden reminder: OMP treats sendMessage() as a
    // conversation event, which can otherwise auto-continue forever.
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ content: unknown }> = [];
    const notifications: Array<{ message: string; type?: string }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { content: unknown }) => {
        sent.push({ content: msg.content });
      },
    };
    const prevCoordDir = process.env.PAPERCUSP_COORD_DIR;
    const tmpCoordDir = await fs.mkdtemp(join(tmpdir(), 'coord-hook-empty-'));
    process.env.PAPERCUSP_COORD_DIR = tmpCoordDir;
    // The hook reaches the operator via these env vars (callMcpTool). On a dev
    // box one is set + a real operator is up, so the probe would succeed and
    // read live coord data — defeating the "no operator → detached" premise.
    // Clear them so the turn deterministically resolves to DETACHED.
    const opEnvKeys = ['PAPERCUSP_BUNDLE_URL', 'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_API_BASE'] as const;
    const prevOpEnv = Object.fromEntries(opEnvKeys.map((k) => [k, process.env[k]]));
    for (const k of opEnvKeys) delete process.env[k];
    try {
      const { default: register } = await import('../coord-hook');
      register(pi as never);
      const ctx = {
        hasUI: true,
        ui: {
          notify: (message: string, type?: string) => {
            notifications.push({ message, type });
          },
        },
      };
      await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 0, timestamp: 0 }, ctx);
      expect(sent).toEqual([]);
      // Detached is not an error — no warning notification.
      expect(notifications.length).toBe(0);
    } finally {
      if (prevCoordDir === undefined) delete process.env.PAPERCUSP_COORD_DIR;
      else process.env.PAPERCUSP_COORD_DIR = prevCoordDir;
      for (const k of opEnvKeys) {
        if (prevOpEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevOpEnv[k];
      }
      await fs.rm(tmpCoordDir, { recursive: true, force: true });
    }
  });
});

// WI-1082: when the operator is reachable but a coordination READ is intermittently
// slow (e.g. a bg-host restart-loop), onTurnStart returns degraded:true. Re-injecting
// the degraded notice EVERY such turn spams the model + TUI and, in an auto-continuing
// omp session, drives a self-reinforcing turn loop (one user session logged 79 notices
// in 170s). The notice is now EDGE-TRIGGERED: surfaced once per slow streak, re-armed
// only after coordination recovers.
describe('degraded notice is edge-triggered (WI-1082 — no per-turn spam / loop)', () => {
  const originalFetch = global.fetch;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevToken = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  let inboxFails = true;
  function installFetch() {
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      // probeOperator → reachable (so the turn stays ATTACHED, not DETACHED).
      if (u.includes('/api/health')) return { ok: true, text: async () => 'ok' };
      const body = init?.body ? JSON.parse(init.body) : {};
      const tool = body?.params?.name as string | undefined;
      // coord:inbox returns null (not ok) → degraded; everything else succeeds.
      if (tool === 'coord:inbox' && inboxFails) {
        return { ok: false, text: async () => 'err' };
      }
      const payload =
        tool === 'coord:inbox'
          ? { ok: true, entries: [] }
          : { ok: true, entries: [], events: [], active_locks: [], watermark: {} };
      return {
        ok: true,
        text: async () =>
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
      };
    }) as unknown as typeof fetch;
  }
  beforeEach(() => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-degr';
    inboxFails = true;
    _resetHookOwnerIdForTests();
    _resetDegradedNotifiedForTests();
    installFetch();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevToken === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    _resetHookOwnerIdForTests();
    _resetDegradedNotifiedForTests();
  });

  it('surfaces the degraded notice ONCE across a streak, and re-arms after recovery', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ content: string }> = [];
    const delivered: string[] = [];
    const notifications: Array<{ message: string }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { content: unknown }) => {
        sent.push({ content: String(msg.content) });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);
    const ctx = {
      hasUI: true,
      ui: { notify: (message: string) => notifications.push({ message }) },
    };
    const drain = () => {
      const text = takeAdvisories();
      if (text) delivered.push(text);
    };
    const degradedNotes = () =>
      delivered.filter((text) => text.includes('coordination read was slow')).length;

    // 3 consecutive degraded turns → exactly ONE degraded notice + ONE TUI notification.
    for (let i = 0; i < 3; i++) {
      await subs.get('turn_start')!({ type: 'turn_start', turnIndex: i, timestamp: 0 }, ctx);
      drain();
    }
    expect(degradedNotes()).toBe(1);
    expect(sent).toEqual([]);
    expect(notifications.length).toBe(1);

    // Operator recovers → a healthy turn re-arms the latch (still just one notice).
    inboxFails = false;
    await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 3, timestamp: 0 }, ctx);
    drain();
    expect(degradedNotes()).toBe(1);

    // Slow again → a fresh streak surfaces exactly one MORE notice (re-armed).
    inboxFails = true;
    await subs.get('turn_start')!({ type: 'turn_start', turnIndex: 4, timestamp: 0 }, ctx);
    drain();
    expect(degradedNotes()).toBe(2);
    expect(notifications.length).toBe(2);
  });
});

describe('probeOperator', () => {
  it('returns false when no operator URL is configured', async () => {
    const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
    const prevOp = process.env.PAPERCUSP_OPERATOR_URL;
    delete process.env.PAPERCUSP_BUNDLE_URL;
    delete process.env.PAPERCUSP_OPERATOR_URL;
    const { probeOperator } = await import('../coord-hook');
    expect(await probeOperator(200)).toBe(false);
    if (prevBundle !== undefined) process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevOp !== undefined) process.env.PAPERCUSP_OPERATOR_URL = prevOp;
  });
});

describe('summarisePlanEvents', () => {
  it('groups plan_event entries by plan_slug, preserving order', () => {
    const events: InboxEntry[] = [
      // not a plan_event — ignored
      { ts: 't', msg_id: 'a', from: 's', kind: 'message' },
      // plan_event lines (the hook gets them in the inbox stream)
      {
        ts: 't',
        msg_id: 'b',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p1',
        ...({ event: 'created' } as Record<string, unknown>),
      } as InboxEntry,
      {
        ts: 't',
        msg_id: 'c',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p1',
        ...({ event: 'now_updated' } as Record<string, unknown>),
      } as InboxEntry,
      {
        ts: 't',
        msg_id: 'd',
        from: 's',
        kind: 'plan_event',
        plan_slug: 'p2',
        ...({ event: 'created' } as Record<string, unknown>),
      } as InboxEntry,
    ];
    const out = summarisePlanEvents(events);
    expect(out).toEqual([
      { plan_slug: 'p1', events: ['created', 'now_updated'] },
      { plan_slug: 'p2', events: ['created'] },
    ]);
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking-improvements #2 — onToolCall / onToolResult enforcement
// ────────────────────────────────────────────────────────────────────

describe('extractPathsFromToolInput (file-locking #2)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;
  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fx.cleanup();
  });

  it('claims `path` from a write tool input', () => {
    expect(
      extractPathsFromToolInput('write', { path: join(repo, 'a.ts') }),
    ).toEqual(['a.ts']);
  });

  it('accepts path | file_path | filePath for edit', () => {
    expect(
      extractPathsFromToolInput('edit', { path: join(repo, 'a.ts') }),
    ).toEqual(['a.ts']);
    expect(
      extractPathsFromToolInput('edit', { file_path: join(repo, 'b.ts') }),
    ).toEqual(['b.ts']);
    expect(
      extractPathsFromToolInput('edit', { filePath: join(repo, 'c.ts') }),
    ).toEqual(['c.ts']);
  });

  it('claims every literal path from ast_edit, drops globs', () => {
    expect(
      extractPathsFromToolInput('ast_edit', {
        paths: [
          join(repo, 'a.ts'),
          join(repo, 'dir/*.ts'),
          join(repo, 'b.ts'),
          join(repo, 'x?.ts'),
        ],
        ops: [],
      }),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('drops paths outside any coordinated worktree', () => {
    // No git repo above /etc on this host.
    expect(
      extractPathsFromToolInput('write', { path: '/etc/passwd' }),
    ).toEqual([]);
    // The worktree root itself is never claimed.
    expect(extractPathsFromToolInput('write', { path: repo })).toEqual([]);
  });

  it('keys sibling worktrees by the same repo-relative path (cross-worktree contention)', async () => {
    const repo2 = join(fx.workspace, 'papercup-topic');
    await fs.mkdir(join(repo2, '.git'), { recursive: true });
    await fs.writeFile(join(repo2, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const k1 = extractPathsFromToolInput('write', {
      path: join(repo, 'apps/foo.ts'),
    });
    const k2 = extractPathsFromToolInput('write', {
      path: join(repo2, 'apps/foo.ts'),
    });
    expect(k1).toEqual(['apps/foo.ts']);
    expect(k2).toEqual(['apps/foo.ts']); // same key → the two edits contend
  });

  it('retains a valid nested submodule and keys paths relative to it', async () => {
    // The nested `.git` entry is a file, as it is for a real submodule. The
    // enclosing canonical checkout owns worktree policy, while the nested
    // repository owns the physical coordination domain.
    const nested = join(repo, 'libs', 'sub');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(join(nested, '.git'), 'gitdir: /nonexistent\n');
    expect(
      extractPathsFromToolInput('write', { path: join(nested, 'x.ts') }),
    ).toEqual(['x.ts']);
  });

  it('returns [] for non-file-editing tools', () => {
    expect(extractPathsFromToolInput('bash', { command: 'ls' })).toEqual([]);
    expect(
      extractPathsFromToolInput('read', { path: join(repo, 'a.ts') }),
    ).toEqual([]);
  });

  it('returns [] for malformed input (non-string path)', () => {
    expect(extractPathsFromToolInput('write', { path: 42 })).toEqual([]);
    expect(extractPathsFromToolInput('write', {})).toEqual([]);
    expect(
      extractPathsFromToolInput('ast_edit', { paths: [null, 7, ''] }),
    ).toEqual([]);
  });
});

describe('formatBusyRefusal (file-locking #2)', () => {
  it('renders the holder line + three retry options', () => {
    const out = formatBusyRefusal([
      {
        path: 'a.ts',
        owner: 'pus-1',
        owner_label: 'A',
        intent: 'editing',
        expires_ts: '2026-05-20T10:00:00Z',
      },
    ]);
    expect(out).toContain('a.ts');
    expect(out).toContain('A');
    expect(out).toContain('"editing"');
    expect(out).toContain('2026-05-20T10:00:00Z');
    expect(out).toMatch(/Options.*\(1\).*\(2\).*\(3\)/s);
    expect(out).toContain('tools:invoke {name:"locks:acquire"');
    expect(out).toContain('paths:["a.ts"]');
    expect(out).toContain('wake_on_grant:true');
  });

  it('truncates after 5 entries with a "... and N more" line', () => {
    const busy = Array.from({ length: 8 }, (_, i) => ({
      path: `p${i}.ts`,
      owner_label: 'X',
      intent: 'i',
      expires_ts: 't',
    }));
    const out = formatBusyRefusal(busy);
    expect(out).toContain('... and 3 more');
    expect(out).toContain('p4.ts');
    expect(out).not.toContain('p5.ts');
  });
});

describe('onToolCall / onToolResult (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevWorkspacesRoot = process.env.PAPERCUSP_WORKSPACES_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_WORKSPACES_ROOT = join(fx.workspace, 'managed-workspaces');
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-test';
    _resetToolCallCacheForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevWorkspacesRoot === undefined) delete process.env.PAPERCUSP_WORKSPACES_ROOT;
    else process.env.PAPERCUSP_WORKSPACES_ROOT = prevWorkspacesRoot;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    await fx.cleanup();
  });

  function mockMcpResponse(payload: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
          },
        }),
    })) as unknown as typeof fetch;
  }

  it('returns {} + acquires NO lock when the tool has no claimable path', async () => {
    // The activity bridge now reports EVERY tool call (a fire-and-forget
    // activity:report), so a non-edit tool DOES reach the operator — but it must
    // still acquire NO lock. Assert on the lock call, not on "fetch never fired".
    const names: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      names.push((JSON.parse(init.body) as { params: { name: string } }).params.name);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: 't1',
      input: { command: 'ls' },
    });
    expect(r).toEqual({});
    // Let the fire-and-forget activity report settle, then assert no lock was taken.
    await new Promise((res) => setTimeout(res, 20));
    expect(names).not.toContain('locks:acquire');
  });

  it('blocks Claude task-panel and subagent Task tools and points agents at todo_write', async () => {
    for (const toolName of ['TaskUpdate', 'task']) {
      let called = false;
      global.fetch = (async () => {
        called = true;
        throw new Error('should not call');
      }) as unknown as typeof fetch;
      const r = await onToolCall({
        type: 'tool_call',
        toolName,
        toolCallId: 't-task',
        input: { taskId: '1', status: 'in_progress' },
      });
      expect(r.block).toBe(true);
      expect(r.reason).toMatch(/todo_write/i);
      expect(called).toBe(false);
    }
  });

  it('feeds the shared reflexive backstop so a reflexive task-loop HALTS + redirects to fleet:launch-on-plan (mode #10)', async () => {
    const prev = process.env.PAPERCUSP_AGENT_SESSION;
    process.env.PAPERCUSP_AGENT_SESSION = '1';
    resetReflexiveBlockBudget();
    global.fetch = (async () => ({ ok: true, text: async () => '{}' })) as unknown as typeof fetch;
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      const taskCall = () =>
        onToolCall({ type: 'tool_call', toolName: 'task', toolCallId: 'tk', input: { description: 'spawn a worker' } });
      const first = await taskCall();
      expect(first.block).toBe(true);
      expect(first.reason).toContain('fleet:launch-on-plan'); // the delegating leader is pointed at the RIGHT tool
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER - 2; i++) expect((await taskCall()).block).toBe(true);
      expect(halts).toHaveLength(0);
      await taskCall(); // the REFLEXIVE_BLOCK_KILL_AFTER-th blocked task call
      expect(halts).toHaveLength(1);
    } finally {
      setHaltForTest(prevHalt);
      resetReflexiveBlockBudget();
      if (prev === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
      else process.env.PAPERCUSP_AGENT_SESSION = prev;
    }
  });

  it('blocks task for the owner too but NEVER halts them (marker unset — D-003)', async () => {
    const prev = process.env.PAPERCUSP_AGENT_SESSION;
    delete process.env.PAPERCUSP_AGENT_SESSION;
    resetReflexiveBlockBudget();
    const halts: string[] = [];
    const prevHalt = setHaltForTest((r) => halts.push(r));
    try {
      for (let i = 0; i < REFLEXIVE_BLOCK_KILL_AFTER + 3; i++) {
        expect((await onToolCall({ type: 'tool_call', toolName: 'task', toolCallId: 'tk', input: {} })).block).toBe(true);
      }
      expect(halts).toHaveLength(0);
    } finally {
      setHaltForTest(prevHalt);
      resetReflexiveBlockBudget();
      if (prev === undefined) delete process.env.PAPERCUSP_AGENT_SESSION;
      else process.env.PAPERCUSP_AGENT_SESSION = prev;
    }
  });

  it('caches lock_id on ok and releases on tool_result', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload =
        body.params.name === 'locks:acquire'
          ? { ok: true, lock_id: 'L-1', expires_ts: 't', held: ['a.ts'] }
          : { ok: true };
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
            },
          }),
      };
    }) as unknown as typeof fetch;

    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-1',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    expect(r).toEqual({});
    // The activity bridge also fires a fire-and-forget activity:report on every tool
    // call, so filter to the lock calls to assert the lock behavior precisely.
    const lockCalls = () => calls.filter((c) => c.name.startsWith('locks:'));
    expect(lockCalls()).toHaveLength(1);
    expect(lockCalls()[0].name).toBe('locks:acquire');
    expect((lockCalls()[0].args as { paths: string[] }).paths).toEqual(['a.ts']);

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(lockCalls()).toHaveLength(2);
    expect(lockCalls()[1].name).toBe('locks:release');
    expect((lockCalls()[1].args as { lock_id: string }).lock_id).toBe('L-1');

    // Second release on the same toolCallId is a no-op (cache cleared).
    await onToolResult({ type: 'tool_result', toolCallId: 'tc-1' });
    expect(lockCalls()).toHaveLength(2);
  });

  it('passes the physical nested-repository domain through acquire and release', async () => {
    const nested = join(repo, 'libs', 'sub');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(join(nested, '.git'), 'gitdir: /nonexistent\n');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-nested', held: ['x.ts'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;

    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-nested-domain',
      input: { path: join(nested, 'x.ts'), content: 'x' },
    });
    expect(r).toEqual({});
    const lockCalls = () => calls.filter((call) => call.name.startsWith('locks:'));
    expect(lockCalls()).toHaveLength(1);
    expect(lockCalls()[0]).toMatchObject({
      name: 'locks:acquire',
      args: {
        paths: ['x.ts'],
        coordination_domain: await fs.realpath(nested),
      },
    });

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-nested-domain' });
    expect(lockCalls()).toHaveLength(2);
    expect(lockCalls()[1]).toMatchObject({
      name: 'locks:release',
      args: { lock_id: 'L-nested', coordination_domain: await fs.realpath(nested) },
    });
  });

  it('passes a managed suite app repository domain through acquire and release', async () => {
    const portal = join(
      process.env.PAPERCUSP_WORKSPACES_ROOT!,
      'papercusp-workspace',
      '.papercusp',
      'apps',
      'portal',
    );
    const target = join(portal, 'packages', 'contracts', 'src', 'index.ts');
    await fs.mkdir(join(portal, '.git'), { recursive: true });
    await fs.writeFile(join(portal, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, 'export {};\n');

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-suite-app', held: ['packages/contracts/src/index.ts'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;

    expect(await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-suite-app',
      input: { path: target, content: 'export const value = 1;' },
    })).toEqual({});

    const lockCalls = () => calls.filter((call) => call.name.startsWith('locks:'));
    expect(lockCalls()[0]).toMatchObject({
      name: 'locks:acquire',
      args: {
        paths: ['packages/contracts/src/index.ts'],
        coordination_domain: await fs.realpath(portal),
      },
    });

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-suite-app' });
    expect(lockCalls()[1]).toMatchObject({
      name: 'locks:release',
      args: { lock_id: 'L-suite-app', coordination_domain: await fs.realpath(portal) },
    });
  });

  it('omits coordination_domain when one edit spans mixed repository roots', async () => {
    const nested = join(repo, 'libs', 'sub');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(join(nested, '.git'), 'gitdir: /nonexistent\n');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-mixed', held: ['a.ts', 'x.ts'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;

    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'multi_edit',
      toolCallId: 'tc-mixed-domain',
      input: { paths: [join(repo, 'a.ts'), join(nested, 'x.ts')] },
    });
    expect(r).toEqual({});
    const acquire = calls.find((call) => call.name === 'locks:acquire');
    expect(acquire?.args.paths).toEqual(['a.ts', 'x.ts']);
    expect(acquire?.args).not.toHaveProperty('coordination_domain');

    await onToolResult({ type: 'tool_result', toolCallId: 'tc-mixed-domain' });
    const release = calls.find((call) => call.name === 'locks:release');
    expect(release?.args).not.toHaveProperty('coordination_domain');
  });

  it('blocks with a formatted reason on busy', async () => {
    global.fetch = mockMcpResponse({
      ok: false,
      busy: [
        {
          path: 'a.ts',
          owner: 'pus-other',
          owner_label: 'OTHER',
          intent: 'editing',
          expires_ts: '2026-05-20T10:00:00Z',
        },
      ],
    });
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-2',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/a\.ts/);
    expect(r.reason).toMatch(/OTHER/);
    expect(r.reason).toMatch(/Options/);
  });

  it('fails open when the operator is unreachable', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const errs: unknown[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a);
    };
    try {
      const r = await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'tc-3',
        input: { path: join(repo, 'a.ts'), content: 'x' },
      });
      expect(r).toEqual({}); // fail open
      expect(errs.some((e) => String(e).includes('fail-open'))).toBe(true);
    } finally {
      console.error = origErr;
    }
  });

  it('onToolResult is a no-op for a toolCallId we never acquired', async () => {
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await onToolResult({ type: 'tool_result', toolCallId: 'never' });
    expect(called).toBe(false);
  });

  it('retains disconnected lock observations until the existing activity heartbeat accepts them', async () => {
    _resetActivityReportDedupeForTests();
    const priorDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = join(fx.workspace, 'hook-markers');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let offline = true;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const request = JSON.parse(init.body).params;
      calls.push({ name: request.name, args: request.arguments });
      if (offline) throw new Error('ECONNREFUSED');
      const payload = request.name === 'locks:acquire'
        ? { ok: true, lock_id: 'observed-lock' }
        : { ok: true, hook_fallbacks_accepted: request.arguments.hook_fallbacks?.length ?? 0 };
      return { ok: true, text: async () => JSON.stringify({ result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }) };
    }) as unknown as typeof fetch;
    const edit = (id: string) => ({ type: 'tool_call' as const, toolName: 'write', toolCallId: id,
      input: { path: join(repo, 'a.ts'), content: 'x' } });
    try {
      const first = edit('disconnected');
      expect(await onToolCall(first)).toEqual({});
      expect(calls.map(call => call.name)).toEqual(['locks:acquire']); // no reporting RPC on the edit path
      stageActivityReport(first);
      expect(await reportActivityResult({ type: 'tool_result', toolCallId: first.toolCallId })).toBeNull();
      const missed = calls.at(-1)!.args.hook_fallbacks as Array<Record<string, unknown>>;
      expect(missed).toHaveLength(1);
      expect(missed[0]).toMatchObject({ eligible: 1, applied: 0, reason: 'lock-transport-unavailable' });
      offline = false;
      const second = edit('recovered');
      expect(await onToolCall(second)).toEqual({});
      stageActivityReport(second);
      await reportActivityResult({ type: 'tool_result', toolCallId: second.toolCallId });
      const delivered = calls.at(-1)!.args.hook_fallbacks as Array<Record<string, unknown>>;
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toEqual(missed[0]); // original outage time survives retry
      expect(delivered[1]).toMatchObject({ eligible: 1, applied: 1, reason: 'applied' });
      await reportActivity({ type: 'tool_call', toolName: 'read', toolCallId: 'drained', input: {} });
      expect(calls.at(-1)!.args).not.toHaveProperty('hook_fallbacks');
    } finally {
      errors.mockRestore();
      _resetActivityReportDedupeForTests();
      if (priorDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
      else process.env.PAPERCUSP_LOCKS_CACHE_DIR = priorDir;
    }
  });

  it('forwards positive native edit proof with exact acquired paths', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-proof', held: ['a.ts', 'b.ts'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;

    await onToolCall({
      type: 'tool_call',
      toolName: 'multi_edit',
      toolCallId: 'tc-proof',
      input: { paths: [join(repo, 'a.ts'), join(repo, 'b.ts')] },
    });
    await onToolResult({
      type: 'tool_result',
      toolCallId: 'tc-proof',
      content: { success: true },
    });

    const release = calls.find((call) => call.name === 'locks:release');
    expect(release?.args).toMatchObject({
      lock_id: 'L-proof',
      native_edit_proof: {
        success: true,
        source: 'omp',
        tool: 'multi_edit',
        paths: ['a.ts', 'b.ts'],
      },
    });
  });

  it('regenerates an edited declaration source before releasing its OMP lock', async () => {
    const order: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      if (body.params.name === 'locks:release') order.push('release');
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-declaration', held: ['scripts/input.mjs'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;
    const previous = setDeclarationRegeneratorForTests(async (root, paths) => {
      order.push(`regenerate:${root}:${paths.join(',')}`);
    });
    try {
      await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'tc-declaration',
        input: { path: join(repo, 'scripts/input.mjs'), content: 'export const x = 1;' },
      });
      await onToolResult({
        type: 'tool_result',
        toolCallId: 'tc-declaration',
        content: { success: true },
      });
      expect(order).toEqual([
        `regenerate:${await fs.realpath(repo)}:scripts/input.mjs`,
        'release',
      ]);
    } finally {
      setDeclarationRegeneratorForTests(previous);
    }
  });

  it('still releases the OMP lock when declaration regeneration fails', async () => {
    const calls: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: { name: string } };
      calls.push(body.params.name);
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-declaration-fail', held: ['scripts/input.mjs'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;
    const previous = setDeclarationRegeneratorForTests(async () => {
      throw new Error('synthetic declaration failure');
    });
    try {
      await onToolCall({
        type: 'tool_call', toolName: 'write', toolCallId: 'tc-declaration-fail',
        input: { path: join(repo, 'scripts/input.mjs'), content: 'x' },
      });
      await onToolResult({
        type: 'tool_result', toolCallId: 'tc-declaration-fail', content: { success: true },
      });
      expect(calls).toContain('locks:release');
    } finally {
      setDeclarationRegeneratorForTests(previous);
    }
  });

  it('releases after a failed native result without attaching edit proof', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      const payload = body.params.name === 'locks:acquire'
        ? { ok: true, lock_id: 'L-failed', held: ['a.ts'] }
        : { ok: true };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
      };
    }) as unknown as typeof fetch;

    await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-proof-failed',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    await onToolResult({
      type: 'tool_result',
      toolCallId: 'tc-proof-failed',
      content: { ok: false, error: 'write failed' },
    });

    const release = calls.find((call) => call.name === 'locks:release');
    expect(release?.args).toMatchObject({ lock_id: 'L-failed' });
    expect(release?.args).not.toHaveProperty('native_edit_proof');
  });
});

// ────────────────────────────────────────────────────────────────────
// worktree discipline — only the canonical staging tree is editable
// ────────────────────────────────────────────────────────────────────

describe('onToolCall worktree guard (single-tree discipline)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevCanon = process.env.PAPERCUSP_CANONICAL_TREE;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;

  beforeEach(async () => {
    fx = await makeWorktreeFixture(); // fx.repo = <base>/papercusp (the canonical tree)
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    delete process.env.PAPERCUSP_CANONICAL_TREE; // default → <ws>/papercusp = fx.repo
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-wt';
    _resetToolCallCacheForTests();
    // Any acquire is granted, so the canonical-allow path resolves to {} (not blocked).
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, lock_id: 'L' }) }] },
        }),
    })) as unknown as typeof fetch;
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevCanon === undefined) delete process.env.PAPERCUSP_CANONICAL_TREE;
    else process.env.PAPERCUSP_CANONICAL_TREE = prevCanon;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    await fx.cleanup();
  });

  it('denies an edit in a stray sibling worktree (e.g. papercup-staging)', async () => {
    const stray = join(fx.workspace, 'papercup-staging');
    await fs.mkdir(join(stray, '.git'), { recursive: true });
    await fs.writeFile(join(stray, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-stray',
      input: { path: join(stray, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('worktree guard');
    expect(r.reason).toContain('canonical staging tree');
  });

  it('allows an edit in the canonical staging tree', async () => {
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-canon',
      input: { path: join(fx.repo, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBeUndefined(); // guard passes → lock granted → {}
  });

  it.each([
    { name: 'no-remotes', config: '[core]\nrepositoryformatversion = 0\n', blocked: false },
    { name: 'other-origin', config: '[remote "origin"]\nurl = https://example.test/independent.git\n', blocked: false },
    { name: 'same-origin', config: '[remote "origin"]\nurl = https://example.test/canonical.git\n', blocked: true },
    { name: 'non-origin-remote', config: '[remote "upstream"]\nurl = https://example.test/independent.git\n', blocked: true },
    { name: 'unreadable-config', config: null, blocked: true },
  ])('coordinates independent-root edits conservatively: $name', async ({ name, config, blocked }) => {
    await fs.writeFile(join(fx.repo, '.git', 'config'), '[remote "origin"]\nurl = https://example.test/canonical.git\n');
    const sibling = join(fx.workspace, name);
    await fs.mkdir(join(sibling, '.git'), { recursive: true });
    await fs.writeFile(join(sibling, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    if (config !== null) await fs.writeFile(join(sibling, '.git', 'config'), config);
    const r = await onToolCall({
      type: 'tool_call', toolName: 'write', toolCallId: `root-${name}`,
      input: { path: join(sibling, 'x.ts'), content: 'x' },
    });
    expect(r.block === true).toBe(blocked);
    if (blocked) expect(r.reason).toContain('worktree guard');
  });

  it('still refuses a canonical linked worktree when the common repository has no remotes', async () => {
    await fs.writeFile(join(fx.repo, '.git', 'config'), '[core]\nrepositoryformatversion = 0\n');
    const sibling = join(fx.workspace, 'linked-no-remotes');
    const metadata = join(fx.repo, '.git', 'worktrees', 'linked-no-remotes');
    await fs.mkdir(sibling, { recursive: true });
    await fs.mkdir(metadata, { recursive: true });
    await fs.writeFile(join(metadata, 'commondir'), '../..\n');
    await fs.writeFile(join(sibling, '.git'), `gitdir: ${metadata}\n`);
    const r = await onToolCall({
      type: 'tool_call', toolName: 'write', toolCallId: 'linked-no-remotes',
      input: { path: join(sibling, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('LINKED WORKTREE');
  });

  it('allows an edit in a .papercusp/worktrees isolation tree', async () => {
    // Migration/synthesis isolation worktrees live under
    // <canonical>/.papercusp/worktrees/<name> — a non-workspace-root parent, so
    // extractLockTargets never keeps them and the guard never fires. They must
    // pass (guarding them would break those roles).
    const iso = join(fx.repo, '.papercusp', 'worktrees', 'iso-1');
    await fs.mkdir(join(iso, '.git'), { recursive: true });
    await fs.writeFile(join(iso, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'wt-iso',
      input: { path: join(iso, 'x.ts'), content: 'x' },
    });
    expect(r.block).toBeUndefined(); // isolation tree → guard passes → not blocked
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking-improvements #3 — fail-open health marker
// ────────────────────────────────────────────────────────────────────

describe('recordHookSuccess / recordHookError (file-locking #3)', () => {
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-cache-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
  });
  afterEach(async () => {
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('recordHookSuccess writes last-success.json with a ts', async () => {
    const { recordHookSuccess } = await import('../coord-hook');
    await recordHookSuccess();
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-success.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    expect(Object.keys(rec)).toEqual(['ts']);
  });

  it('recordHookError writes last-error.json with the plan-spec shape', async () => {
    const { recordHookError } = await import('../coord-hook');
    await recordHookError({
      handler: 'tool_call',
      phase: 'connect',
      detail: 'down',
    });
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    expect(rec.handler).toBe('tool_call');
    expect(rec.phase).toBe('connect');
    expect(rec.detail).toBe('down');
    expect(rec.operator_url).toBe('http://operator.test');
  });

  it('creates the cache directory if missing', async () => {
    const nested = join(dir, 'deep', 'nested');
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = nested;
    const { recordHookSuccess } = await import('../coord-hook');
    await recordHookSuccess();
    expect(
      JSON.parse(await fs.readFile(join(nested, 'last-success.json'), 'utf8')),
    ).toHaveProperty('ts');
  });

  it('does not throw when the cache dir is unwritable', async () => {
    // Point the cache dir UNDER a regular file: mkdir(recursive) then
    // fails fast and deterministically with ENOTDIR, which writeMarker
    // swallows. (A /proc path is "unwritable" too but mkdir can hang on
    // it indefinitely — ENOTDIR is the clean, instant signal.)
    const asFile = join(dir, 'not-a-dir');
    await fs.writeFile(asFile, 'x');
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = join(asFile, 'cannot-write');
    const { recordHookSuccess, recordHookError } = await import('../coord-hook');
    await expect(recordHookSuccess()).resolves.toBeUndefined();
    await expect(
      recordHookError({ handler: 'tool_result', phase: 'http', detail: 'x' }),
    ).resolves.toBeUndefined();
  });
});

describe('onToolCall writes the health markers (file-locking #3)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevDir = process.env.PAPERCUSP_LOCKS_CACHE_DIR;
  let dir: string;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;

  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    dir = await fs.mkdtemp(join(tmpdir(), 'su-locks-cache-flow-'));
    process.env.PAPERCUSP_LOCKS_CACHE_DIR = dir;
    _resetToolCallCacheForTests();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevDir === undefined) delete process.env.PAPERCUSP_LOCKS_CACHE_DIR;
    else process.env.PAPERCUSP_LOCKS_CACHE_DIR = prevDir;
    await fs.rm(dir, { recursive: true, force: true });
    await fx.cleanup();
  });

  it('writes last-success.json on a successful acquire', async () => {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  lock_id: 'L-ok',
                  expires_ts: 't',
                  held: ['a.ts'],
                }),
              },
            ],
          },
        }),
    })) as unknown as typeof fetch;
    await onToolCall({
      type: 'tool_call',
      toolName: 'write',
      toolCallId: 'tc-ok',
      input: { path: join(repo, 'a.ts'), content: 'x' },
    });
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-success.json'), 'utf8'),
    );
    expect(typeof rec.ts).toBe('string');
    // No error file written on the happy path.
    await expect(
      fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('writes last-error.json (phase=connect) when the operator is unreachable', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const origErr = console.error;
    console.error = () => {};
    try {
      await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'tc-err',
        input: { path: join(repo, 'a.ts'), content: 'x' },
      });
    } finally {
      console.error = origErr;
    }
    const rec = JSON.parse(
      await fs.readFile(join(dir, 'last-error.json'), 'utf8'),
    );
    expect(rec.handler).toBe('tool_call');
    expect(rec.phase).toBe('connect');
    expect(typeof rec.ts).toBe('string');
  });
});

// ────────────────────────────────────────────────────────────────────
// file-locking #2 audit fixes — per-process owner id, session_shutdown
// ────────────────────────────────────────────────────────────────────

describe('hookOwnerId — per-process coordination owner (file-locking #2)', () => {
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  const prevPaperSid = process.env.PAPERCUSP_SID;
  beforeEach(() => {
    // The minted-id path is the FALLBACK (only when there is no PAPERCUSP_SID); clear it so the
    // minted cases below exercise that fallback rather than the now-preferred PAPERCUSP_SID path.
    delete process.env.PAPERCUSP_SID;
    _resetHookOwnerIdForTests();
  });
  afterEach(() => {
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    if (prevPaperSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = prevPaperSid;
    _resetHookOwnerIdForTests();
  });

  it('PREFERS PAPERCUSP_SID (the psu adv-session id) so the operator resolves the workspace via the adv-row', () => {
    process.env.PAPERCUSP_SID = 'su-abc-123';
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe('su-abc-123');
  });

  it('mints omp-<session>-<pid> from PAPERCUSP_AUTH_SESSION_ID when no PAPERCUSP_SID', () => {
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-abc';
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe(`omp-pus-abc-${process.pid}`);
  });

  it('falls back to a random session part when no env session id', () => {
    delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    _resetHookOwnerIdForTests();
    const id = hookOwnerId();
    expect(id).toMatch(new RegExp(`^omp-[a-z0-9]+-${process.pid}$`));
  });

  it('is stable across calls within the process', () => {
    _resetHookOwnerIdForTests();
    expect(hookOwnerId()).toBe(hookOwnerId());
  });

  it('always ends with the real pid (distinguishes sibling shells) in the minted fallback', () => {
    _resetHookOwnerIdForTests();
    expect(hookOwnerId().endsWith(`-${process.pid}`)).toBe(true);
  });
});

describe('callMcpTool passes ?client=<owner> (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevSuperuser = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_AUTH_SESSION_ID;
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevSuperuser === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevSuperuser;
    if (prevSid === undefined) delete process.env.PAPERCUSP_AUTH_SESSION_ID;
    else process.env.PAPERCUSP_AUTH_SESSION_ID = prevSid;
    _resetHookOwnerIdForTests();
  });

  it('appends the minted owner as a client query param', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_AUTH_SESSION_ID = 'pus-xyz';
    _resetHookOwnerIdForTests();
    let seenUrl = '';
    global.fetch = (async (url: unknown) => {
      seenUrl = String(url);
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:declare-intent', { intent: 'x' });
    expect(seenUrl).toContain('power_user=1');
    expect(seenUrl).toContain(
      `client=${encodeURIComponent(`omp-pus-xyz-${process.pid}`)}`,
    );
  });

  it('falls back to the superuser MCP route for /adv engineer launches', async () => {
    delete process.env.PAPERCUSP_BUNDLE_URL;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    _resetHookOwnerIdForTests();
    let seenUrl = '';
    let auth = '';
    global.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      seenUrl = String(url);
      auth = String(init?.headers?.Authorization ?? '');
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:declare-intent', { intent: 'x' });
    expect(seenUrl).toContain('superuser=1');
    expect(auth).toBe('Bearer su-token');
  });

  // Regression: @modelcontextprotocol/sdk's Streamable HTTP transport
  // frames responses as `event: message\ndata: <json>\n\n`. An earlier
  // parser only handled the case where `data:` was the first byte and
  // silently returned null on every coord call — flipping the hook into
  // `degraded` every turn and spamming the model + TUI with the
  // "coordination call failed this turn" reminder.
  it('parses SSE responses that lead with an `event: message` line', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n',
    })) as unknown as typeof fetch;
    const out = await callMcpTool('coord:inbox', {});
    expect(out).toEqual({ ok: true });
  });
});

// WI-1081: callMcpTool's fetch had NO timeout, so a slow/wedged operator (e.g. a
// bg-host restart-loop) blocked the OMP extension handler until OMP's framework
// timeout KILLED it — 30s session_start / 2s turn_start — a launch stall + an
// "Extension error: handler timed out", with no graceful degrade. callMcpTool now
// bounds every fetch with an AbortController (default 6s; turn_start passes ~1s) so
// a hung operator returns null FAST → the hook's normal degraded path.
describe('callMcpTool fetch timeout (WI-1081 — no-hang guard)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  beforeEach(() => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    _resetHookOwnerIdForTests();
  });

  it('passes an AbortSignal to fetch so a hung call can be cancelled', async () => {
    let sawSignal = false;
    global.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    await callMcpTool('coord:inbox', {});
    expect(sawSignal).toBe(true);
  });

  it('returns null (not a hang) when the operator never responds and the timeout fires', async () => {
    // Simulate a wedged operator: fetch resolves ONLY when its AbortSignal fires.
    global.fetch = ((_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (sig)
          sig.addEventListener('abort', () => {
            const e = new Error('The operation was aborted');
            (e as { name: string }).name = 'AbortError';
            reject(e);
          });
        // never resolves on its own — only the abort path completes it
      })) as unknown as typeof fetch;
    const started = Date.now();
    const out = await callMcpTool('coord:inbox', {}, { timeoutMs: 40 });
    const elapsed = Date.now() - started;
    expect(out).toBeNull();
    // bounded by the 40ms budget, NOT a multi-second/30s hang
    expect(elapsed).toBeLessThan(1500);
  });

  it('still returns the parsed value when the response arrives within the budget', async () => {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}}\n\n',
    })) as unknown as typeof fetch;
    const out = await callMcpTool('coord:inbox', {}, { timeoutMs: 5000 });
    expect(out).toEqual({ ok: true });
  });
});

describe('linkAdvSessionFromContext — ADV row linkage', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevAdvSessionId = process.env.PAPERCUSP_ADV_SESSION_ID;

  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevAdvSessionId === undefined) delete process.env.PAPERCUSP_ADV_SESSION_ID;
    else process.env.PAPERCUSP_ADV_SESSION_ID = prevAdvSessionId;
    _resetHookOwnerIdForTests();
  });

  it('calls omp:sessions link with the current OMP session id and file path', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true,"result":"linked"}' }] },
          }),
      };
    }) as unknown as typeof fetch;

    await linkAdvSessionFromContext({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });

    expect(calls).toEqual([
      {
        name: 'omp:sessions',
        args: {
          op: 'link',
          advSessionId: 42,
          sessionId: '019ab123',
          filePath: '/home/user/.omp/agent/sessions/-repo/session.jsonl',
          cwd: '/repo',
        },
      },
    ]);
    expect(ompSessionsLinkArgsSchema.safeParse(calls[0]?.args).success).toBe(true);
  });

  it('does nothing without a launcher-provided ADV session id', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    delete process.env.PAPERCUSP_ADV_SESSION_ID;
    let called = false;
    global.fetch = (async () => {
      called = true;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;

    await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });

    expect(called).toBe(false);
  });

  it('stops retrying once the ADV link result is conflict', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    let linkCalls = 0;
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        params?: { name?: string };
      };
      if (body.params?.name === 'omp:sessions') {
        linkCalls += 1;
      }
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: '{"ok":false,"result":"conflict","error":"adv_session_already_linked_to_different_omp_session"}' },
              ],
            },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    const first = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });
    const second = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(linkCalls).toBe(1);
  });

  it('stops retrying once the ADV link tool reports a deterministic schema error', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    let linkCalls = 0;
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as {
        params?: { name?: string };
      };
      if (body.params?.name === 'omp:sessions') linkCalls += 1;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'invalid_args: Unrecognized key: "futureField"' }],
            },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    const first = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });
    const second = await linkAdvSessionFromContext({
      sessionManager: { getSessionId: () => '019ab123' },
    });

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(linkCalls).toBe(1);
  });

  it('re-probes immediately on turn start when an ADV link is still missing', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    let healthChecks = 0;
    const calls: string[] = [];
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith('/api/health')) {
        healthChecks += 1;
        return { ok: healthChecks >= 2 } as Response;
      }
      const body = JSON.parse(init?.body ?? '{}') as {
        params?: { name?: string };
      };
      const name = body.params?.name ?? '';
      calls.push(name);
      const resultText =
        name === 'omp:sessions'
          ? '{"ok":true,"result":"linked"}'
          : name === 'coord:watermark'
            ? '{"watermark":{}}'
            : name === 'coord:inbox'
              ? '{"entries":[]}'
              : name === 'locks:queue'
                ? '{"active_locks":[]}'
                : name === 'coord:plan-events'
                  ? '{"events":[]}'
                  : '{"ok":true}';
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: resultText }] },
          }),
      } as Response;
    }) as unknown as typeof fetch;

    await onSessionStart({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });
    const turn = await onTurnStart({
      cwd: '/repo',
      sessionManager: {
        getSessionId: () => '019ab123',
        getSessionFile: () => '/home/user/.omp/agent/sessions/-repo/session.jsonl',
      },
    });

    expect(turn.mode).toBe('attached');
    expect(healthChecks).toBe(2);
    expect(calls).toContain('omp:sessions');
  });
});

describe('withDeadline — handler wall-clock cap (WI-3147)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves normally (via the promise path) when the work settles before the deadline', async () => {
    let done = false;
    await withDeadline(
      Promise.resolve().then(() => {
        done = true;
      }),
      20_000,
    );
    expect(done).toBe(true);
  });

  it('resolves at the deadline when the work never settles — graceful degrade, never a framework kill', async () => {
    vi.useFakeTimers();
    let settled = false;
    // A wedged operator: the inner promise NEVER settles (models the event-loop-starvation
    // case where even the per-call 6s AbortController guard slips past its budget).
    const p = withDeadline(new Promise<void>(() => {}), 20_000).then(() => {
      settled = true;
    });
    // Just before the deadline: still pending.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    // Past the deadline: withDeadline resolves on its own, so the handler always returns.
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe(true);
  });

  it('never surfaces an unhandled rejection when the losing (deadline-won) promise later rejects', async () => {
    vi.useFakeTimers();
    let rej!: (e: unknown) => void;
    const hang = new Promise<void>((_resolve, reject) => {
      rej = reject;
    });
    const p = withDeadline(hang, 1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(p).resolves.toBeUndefined();
    // The losing promise rejects AFTER we stopped awaiting it — must not throw / go unhandled.
    rej(new Error('late failure'));
    await Promise.resolve();
    await Promise.resolve();
  });
});

describe('onSessionStart — concurrent + bounded (WI-3147)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevAdv = process.env.PAPERCUSP_ADV_SESSION_ID;

  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevAdv === undefined) delete process.env.PAPERCUSP_ADV_SESSION_ID;
    else process.env.PAPERCUSP_ADV_SESSION_ID = prevAdv;
    _resetHookOwnerIdForTests();
    _resetToolCallCacheForTests();
    vi.useRealTimers();
  });

  it('dispatches the ADV link and declare-intent CONCURRENTLY (a serial impl could not have both in flight)', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    const started: string[] = [];
    const releasers: Array<() => void> = [];
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      const name =
        (JSON.parse(init?.body ?? '{}') as { params?: { name?: string } }).params?.name ?? '';
      started.push(name);
      // Hold BOTH coord calls open — a purely sequential onSessionStart would never
      // START the second before the first resolved, so it could never reach 2 in flight.
      await new Promise<void>((resolve) => releasers.push(resolve));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true,"result":"linked"}' }] },
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const p = onSessionStart({
      cwd: '/repo',
      sessionManager: { getSessionId: () => '019ab123' },
    });
    // Flush microtasks so refreshMode + the concurrent Promise.all have dispatched both fetches.
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual(expect.arrayContaining(['omp:sessions', 'coord:declare-intent']));
    expect(started.length).toBe(2);
    releasers.forEach((fn) => fn());
    await p;
  });

  it('returns even when a coord call hangs — the deadline keeps it under pi’s 30s cap', async () => {
    vi.useFakeTimers();
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    global.fetch = (async (url: unknown) => {
      if (String(url).endsWith('/api/health')) return { ok: true } as Response;
      // The coord fetch never settles AND ignores the abort signal (starvation case).
      return new Promise(() => {}) as unknown as Response;
    }) as unknown as typeof fetch;

    let settled = false;
    const p = onSessionStart({
      cwd: '/repo',
      sessionManager: { getSessionId: () => '019ab123' },
    }).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(19_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(settled).toBe(true);
  });

  it('makes NO coord calls in detached mode (operator unreachable)', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_ADV_SESSION_ID = '42';
    const coordCalls: string[] = [];
    global.fetch = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith('/api/health')) return { ok: false } as Response;
      const name =
        (JSON.parse(init?.body ?? '{}') as { params?: { name?: string } }).params?.name ?? '';
      coordCalls.push(name);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] },
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await onSessionStart({
      cwd: '/repo',
      sessionManager: { getSessionId: () => '019ab123' },
    });
    expect(coordCalls).toEqual([]);
  });
});

describe('onSessionShutdown — defensive lock release (file-locking #2)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    _resetToolCallCacheForTests();
  });

  it('calls locks:release with all_mine:true', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    const calls: Array<{ name: string; args: unknown }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as {
        params: { name: string; arguments: unknown };
      };
      calls.push({ name: body.params.name, args: body.params.arguments });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] },
          }),
      };
    }) as unknown as typeof fetch;
    await onSessionShutdown();
    // Shutdown now ALSO reports a "■ session ended" lifecycle row to the activity
    // bridge before the lock backstop — assert on the lock call specifically.
    const release = calls.find((c) => c.name === 'locks:release');
    expect(release).toBeTruthy();
    expect(release!.args).toEqual({ all_mine: true });
    const lifecycle = calls.find((c) => c.name === 'activity:report');
    expect((lifecycle!.args as { kind: string; summary: string })).toMatchObject({ kind: 'lifecycle', summary: '■ session ended' });
  });
});

describe('extractPathsFromToolInput backslash consistency (file-locking #2)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;
  let fx: Awaited<ReturnType<typeof makeWorktreeFixture>>;
  let repo: string;
  beforeEach(async () => {
    fx = await makeWorktreeFixture();
    repo = fx.repo;
    process.env.PAPERCUSP_WORKSPACE_ROOT = fx.workspace;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fx.cleanup();
  });

  it('skips backslash paths (the server rejects them — path-normalize.ts)', () => {
    expect(
      extractPathsFromToolInput('write', { path: `${repo}/apps\\foo.ts` }),
    ).toEqual([]);
  });

  it('still canonicalizes ./ // and trailing slash via resolve()', () => {
    expect(
      extractPathsFromToolInput('write', { path: `${repo}/./apps//foo.ts` }),
    ).toEqual(['apps/foo.ts']);
  });
});

describe('detectSymlinkedPaths / formatSymlinkRefusal (file-locking #1)', () => {
  let root: string;
  let wsBase: string;
  const prevWs = process.env.PAPERCUSP_WORKSPACE_ROOT;

  beforeEach(async () => {
    // `root` is a worktree (has .git) under a workspace base, so the
    // onToolCall test below resolves it through the same find_repo_root
    // + workspace gate as production; the direct detectSymlinkedPaths
    // tests only need `root` to be a real dir.
    wsBase = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), 'su-symlink-ws-')),
    );
    root = join(wsBase, 'papercup');
    await fs.mkdir(join(root, '.git'), { recursive: true });
    await fs.writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await fs.mkdir(join(root, 'apps'), { recursive: true });
    await fs.writeFile(join(root, 'apps', 'real.ts'), 'x');
    process.env.PAPERCUSP_WORKSPACE_ROOT = wsBase;
  });
  afterEach(async () => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ROOT;
    else process.env.PAPERCUSP_WORKSPACE_ROOT = prevWs;
    await fs.rm(wsBase, { recursive: true, force: true });
  });

  it('passes a plain non-symlinked path', () => {
    expect(detectSymlinkedPaths(['apps/real.ts'], root)).toEqual([]);
  });

  it('passes a not-yet-existent leaf (new file via write)', () => {
    expect(detectSymlinkedPaths(['apps/brand-new.ts'], root)).toEqual([]);
  });

  it('flags a symlinked file pointing at a real repo file', async () => {
    await fs.symlink(
      join(root, 'apps', 'real.ts'),
      join(root, 'apps', 'link.ts'),
    );
    expect(detectSymlinkedPaths(['apps/link.ts'], root)).toEqual([
      { given: 'apps/link.ts', real: 'apps/real.ts' },
    ]);
  });

  it('flags a path whose directory component is a symlink', async () => {
    await fs.symlink(join(root, 'apps'), join(root, 'aliasdir'));
    expect(detectSymlinkedPaths(['aliasdir/real.ts'], root)).toEqual([
      { given: 'aliasdir/real.ts', real: 'apps/real.ts' },
    ]);
  });

  it('flags a symlink that escapes the repo entirely', async () => {
    const outside = await fs.mkdtemp(join(tmpdir(), 'su-outside-'));
    await fs.writeFile(join(outside, 'ext.ts'), 'x');
    await fs.symlink(
      join(outside, 'ext.ts'),
      join(root, 'apps', 'escape.ts'),
    );
    const hits = detectSymlinkedPaths(['apps/escape.ts'], root);
    expect(hits).toHaveLength(1);
    expect(hits[0].given).toBe('apps/escape.ts');
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('fails open when the root is not a real directory', () => {
    expect(
      detectSymlinkedPaths(['apps/real.ts'], '/no/such/root/here'),
    ).toEqual([]);
  });

  it('does not flag paths when the repo root itself is under a symlink', async () => {
    // A symlinked *root* must not make every path look symlinked —
    // both root and path canonicalize the same way.
    const linkRoot = join(tmpdir(), `su-rootlink-${Date.now()}-${process.pid}`);
    await fs.symlink(root, linkRoot);
    expect(detectSymlinkedPaths(['apps/real.ts'], linkRoot)).toEqual([]);
    await fs.rm(linkRoot, { force: true });
  });

  it('formatSymlinkRefusal names each aliased path and its real target', () => {
    const msg = formatSymlinkRefusal([
      { given: 'apps/link.ts', real: 'apps/real.ts' },
    ]);
    expect(msg).toMatch(/refused/i);
    expect(msg).toMatch(/symlink/i);
    expect(msg).toMatch(/apps\/link\.ts/);
    expect(msg).toMatch(/apps\/real\.ts/);
  });

  it('onToolCall blocks a symlinked target before contacting the operator', async () => {
    await fs.symlink(
      join(root, 'apps', 'real.ts'),
      join(root, 'apps', 'link.ts'),
    );
    // PAPERCUSP_WORKSPACE_ROOT is set by beforeEach so `root` resolves as
    // a coordinated worktree.
    const origFetch = global.fetch;
    let fetched = false;
    global.fetch = (async () => {
      fetched = true;
      throw new Error('should not contact operator on a symlink refusal');
    }) as unknown as typeof fetch;
    try {
      const r = await onToolCall({
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'sym-1',
        input: { path: join(root, 'apps', 'link.ts'), content: 'x' },
      });
      expect(r.block).toBe(true);
      expect(r.reason).toMatch(/symlink/i);
      expect(fetched).toBe(false);
    } finally {
      global.fetch = origFetch;
    }
  });
});

describe('formatInboxDelta (mid-turn coord delivery — DUMB PIPE, P-009)', () => {
  // Formatting/capping/collapse now live server-side in coord:inbox's
  // `injection` (coord-schema.renderInjection); this hook only wraps the
  // server-rendered string in the OMP coord envelope.
  it('returns "" for an empty/blank injection', () => {
    expect(formatInboxDelta('')).toBe('');
    expect(formatInboxDelta('   \n  ')).toBe('');
  });

  it('wraps the server-rendered positional injection verbatim in a coord system-reminder', () => {
    const injection = '[coord+1]\n> peerA grabbed feature-claim.ts';
    expect(formatInboxDelta(injection)).toBe(
      `<system-reminder type="coord">\n${injection}\n</system-reminder>`,
    );
  });

  it('does not re-format, re-cap, or append a footer (the server owns all of that)', () => {
    const injection = '[coord+9]\n…+1 older\n> a x\n^ b y';
    const out = formatInboxDelta(injection);
    expect(out).toContain('[coord+9]');
    expect(out).not.toMatch(/coord:send/); // footer is in the prompt legend now
    expect(out).not.toContain('new coordination message'); // no hook-side header
  });
});

describe('mid-turn coord delivery uses followUp, not steer (ornith-coord-inbox-flood-livelock)', () => {
  const originalFetch = global.fetch;
  const prevOp = process.env.PAPERCUSP_OPERATOR_URL;

  const mockMcp = (payload: unknown): typeof fetch =>
    (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
        }),
    })) as unknown as typeof fetch;

  beforeEach(() => {
    _resetHookOwnerIdForTests();
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:3070';
  });
  afterEach(() => {
    _resetHookOwnerIdForTests();
    _resetMidTurnCursorForTests(undefined);
    global.fetch = originalFetch;
    if (prevOp === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOp;
  });

  /**
   * Regression guard for the coord-inbox-flood LIVELOCK (fact
   * `ornith-coord-inbox-flood-livelock`, 2026-07-04). `deliverAs:'steer'`
   * routes the coord delta to omp's steering queue, which ABORTS the in-flight
   * tool ("Skipped due to queued user message"). Under a busy fleet's ambient
   * `*` broadcast flood + a slow local model, every tool is aborted before it
   * finishes → the session never makes progress. Mid-turn coord awareness must
   * therefore be appended to the completed tool result, never queued through
   * any sendMessage delivery mode.
   */
  it('appends the coord delta to the tool result without queueing a message', async () => {
    const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
    const sent: Array<{ msg: { customType?: string }; opts?: { deliverAs?: string } }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        subs.set(event, handler);
      },
      sendMessage: (msg: { customType?: string }, opts?: { deliverAs?: string }) => {
        sent.push({ msg, opts });
      },
    };
    const { default: register } = await import('../coord-hook');
    register(pi as never);

    _resetMidTurnCursorForTests('2026-06-01T00:00:00Z');
    global.fetch = mockMcp({
      ok: true,
      hook_bundle: {
        schemaVersion: 'activity-hook-bundle-v1',
        generation: 'host-a:42',
        changed: true,
        complete: true,
        surfaces: {
          inbox: {
            entries: [
              { ts: '2026-06-01T00:05:00Z', msg_id: 'm1', from: 'peer-X', kind: 'message', summary: 'ambient broadcast' },
            ],
            injection: '[coord+1]\n- peerX ambient broadcast',
            summary: { newest_ts: '2026-06-01T00:05:00Z' },
          },
          glance: { display: { title: 'su-abc', notice: null } },
        },
      },
    });

    await subs.get('tool_call')!({ type: 'tool_call', toolName: 'read', toolCallId: 'tc-1', input: {} }, {});
    const result = await subs.get('tool_result')!(
      { type: 'tool_result', toolCallId: 'tc-1', content: 'ORIGINAL' },
      {},
    );

    expect(sent).toEqual([]);
    expect(result).toEqual({
      content:
        'ORIGINAL\n\n<system-reminder type="coord">\n[coord+1]\n- peerX ambient broadcast\n</system-reminder>',
    });
  });

  it('uses the staged edit input for the budget advisory and skips failed edits', async () => {
    const call = { type: 'tool_call' as const, toolName: 'edit', toolCallId: 'budget-edit', input: { path: 'apps/operator/prompts/example.md' } };
    stageActivityReport(call);
    const run = vi.fn(async () => 'overlay over by 4 B');
    expect(await launchProseBudgetForResult({ type: 'tool_result', toolCallId: call.toolCallId, content: { ok: false } }, run)).toBe('');
    expect(run).not.toHaveBeenCalled();
    expect(await launchProseBudgetForResult({ type: 'tool_result', toolCallId: call.toolCallId, content: 'Successfully edited' }, run)).toContain('over by 4 B');
    expect(run).toHaveBeenCalledWith(call);
    expect(await launchProseBudgetForResult({ type: 'tool_result', toolCallId: 'not-staged', content: 'ok' }, run)).toBe('');
  });

  it.each([
    ['missing', undefined, 'not installed'],
    ['cannot load', 'throw new Error("hook load failed");', 'could not load'],
    ['subprocess failure', 'export function shouldCheck(){return true;} if (process.argv[1]?.endsWith("posttooluse-launch-prose-budget-nudge.mjs")) process.exit(1);', 'hook failed'],
  ])('reports an explicit NOT checked signal when the budget hook is %s', async (_name, source, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'omp-budget-hook-failure-'));
    const hook = join(root, '.papercusp/hooks/cc/posttooluse-launch-prose-budget-nudge.mjs');
    const previousHome = process.env.HOME;
    try {
      mkdirSync(dirname(hook), { recursive: true });
      if (source !== undefined) writeFileSync(hook, source);
      process.env.HOME = root;
      const call = { type: 'tool_call' as const, toolName: 'edit', toolCallId: 'budget-failure', input: { path: 'apps/operator/prompts/example.md' } };
      stageActivityReport(call);
      const verdict = await launchProseBudgetForResult({ type: 'tool_result', toolCallId: call.toolCallId, content: 'EDIT SUCCEEDED' });
      expect(verdict).toContain('launch-prose budget NOT checked');
      expect(verdict).toContain(expected);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delivers shared hook output from the registered OMP result handler', async () => {
    const root = mkdtempSync(join(tmpdir(), 'omp-budget-hook-'));
    const hook = join(root, '.papercusp/hooks/cc/posttooluse-launch-prose-budget-nudge.mjs');
    const previousHome = process.env.HOME;
    try {
      mkdirSync(dirname(hook), { recursive: true });
      writeFileSync(hook, 'export function shouldCheck(){return true;} if(process.argv[1]?.endsWith("posttooluse-launch-prose-budget-nudge.mjs")){process.stdin.resume(); process.stdin.on("end",()=>console.log(JSON.stringify({hookSpecificOutput:{additionalContext:"budget breach: overlay over by 4 B"}})));}');
      process.env.HOME = root;
      const subs = new Map<string, (e: unknown, ctx?: unknown) => unknown>();
      const sendMessage = vi.fn();
      const { default: register } = await import('../coord-hook');
      register({ on: (name: string, handler: (e: unknown, ctx?: unknown) => unknown) => subs.set(name, handler), sendMessage } as never);
      const call = { type: 'tool_call' as const, toolName: 'edit', toolCallId: 'budget-wire', input: { path: 'apps/operator/prompts/example.md' } };
      stageActivityReport(call);
      global.fetch = mockMcp({ ok: true });
      const result = await subs.get('tool_result')!({ type: 'tool_result', toolCallId: call.toolCallId, content: 'EDIT SUCCEEDED' }, {});
      expect(result).toEqual({ content: expect.stringContaining('EDIT SUCCEEDED\n\nbudget breach: overlay over by 4 B') });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await runLaunchProseBudgetHook({ ...call, toolName: 'read' })).toBe('');
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('collapseDigestNotifies (coordination-substrate Phase 2, D-006)', () => {
  const notify = (over: Partial<InboxEntry>): InboxEntry => ({
    ts: '2026-06-04T00:00:00.000Z',
    msg_id: 'm',
    from: 'substrate',
    kind: 'notify',
    ...over,
  });

  it('passes full-mode notifies through untouched', () => {
    const entries = [notify({ summary: 'a', subject: 'feature:F-1' }), notify({ summary: 'b', subject: 'issue:I-1' })];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.summary)).toEqual(['a', 'b']);
  });

  it('coalesces same-subject digest notifies into one line with a count + latest summary', () => {
    const entries = [
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → validating', ts: '2026-06-04T00:00:01.000Z' }),
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → passed', ts: '2026-06-04T00:00:03.000Z' }),
      notify({ subject: 'feature:F-1', digest: true, summary: 'F-1 → reviewing', ts: '2026-06-04T00:00:02.000Z' }),
    ];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toContain('×3');
    expect(out[0].summary).toContain('latest: F-1 → passed'); // newest ts wins
  });

  it('keeps distinct subjects separate and leaves a lone digest as a plain line', () => {
    const entries = [
      notify({ subject: 'feature:F-1', digest: true, summary: 'one' }),
      notify({ subject: 'plan:p', digest: true, summary: 'two' }),
    ];
    const out = collapseDigestNotifies(entries);
    expect(out).toHaveLength(2);
    expect(out.every((e) => !(e.summary ?? '').includes('×'))).toBe(true);
  });

  it('does not collapse full notifies even with the same subject', () => {
    const entries = [
      notify({ subject: 'feature:F-1', summary: 'x' }),
      notify({ subject: 'feature:F-1', summary: 'y' }),
    ];
    expect(collapseDigestNotifies(entries)).toHaveLength(2);
  });
});

describe('formatTurnStartReminder — digest notify coalescing', () => {
  it('renders coalesced digest notifies as a single ×N line', () => {
    const out = formatTurnStartReminder({
      ownerId: 'me',
      heldLocks: [],
      changedPlans: [],
      inbox: [
        { ts: '2026-06-04T00:00:01.000Z', msg_id: '1', from: 'substrate', kind: 'notify', subject: 'feature:F-1', digest: true, summary: 'F-1 a' },
        { ts: '2026-06-04T00:00:02.000Z', msg_id: '2', from: 'substrate', kind: 'notify', subject: 'feature:F-1', digest: true, summary: 'F-1 b' },
      ],
    });
    expect(out).toContain('×2');
    // one coalesced notify line, not two
    expect(out.match(/\[notify\]/g) ?? []).toHaveLength(1);
  });
});

// ── activity bridge — the OMP in-process port (papercusp-worker-integration) ──
describe('buildActivityArgs (OMP activity port)', () => {
  beforeEach(() => {
    _resetHookOwnerIdForTests();
    _resetActivityReportDedupeForTests();
  });

  it('forwards a completed tool call (server derives the summary) with agent=omp + phase=post', () => {
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'edit', toolCallId: 'tc1', input: { path: '/repo/a.ts' } });
    expect(args).toMatchObject({ agent: 'omp', phase: 'post', tool_name: 'edit', tool_use_id: 'tc1', tool_input: { path: '/repo/a.ts' } });
    expect(typeof args.owner).toBe('string');
    expect(String(args.owner)).toMatch(/^omp-/); // hookOwnerId shape
    expect(args).not.toHaveProperty('todos');
  });

  it('forwards the active harness scope when the OMP session provides one', () => {
    const previous = process.env.PAPERCUSP_HARNESS_SLUG;
    process.env.PAPERCUSP_HARNESS_SLUG = 'papercusp';
    try {
      expect(buildActivityArgs({ type: 'tool_call', toolName: 'edit', toolCallId: 'scoped', input: {} }))
        .toMatchObject({ harness_slug: 'papercusp' });
    } finally {
      if (previous === undefined) delete process.env.PAPERCUSP_HARNESS_SLUG;
      else process.env.PAPERCUSP_HARNESS_SLUG = previous;
    }
  });

  it('caps long string inputs + collapses arrays/objects so the report stays small', () => {
    const args = buildActivityArgs({
      type: 'tool_call', toolName: 'write', toolCallId: 'tc2',
      input: { path: '/x', content: 'y'.repeat(900), extra: [1, 2], obj: { a: 1 } },
    });
    const ti = args.tool_input as Record<string, unknown>;
    expect((ti.content as string).length).toBe(501); // 500 + ellipsis
    expect(ti.extra).toBe('[2 items]');
    expect(ti.obj).toBe('[object]');
    expect(ti.path).toBe('/x');
  });

  it('forwards a todo_write list as `todos` (uncapped, sliced) so the server summarises kind=todos', () => {
    const args = buildActivityArgs({
      type: 'tool_call', toolName: 'todo_write', toolCallId: 'tc3',
      input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] },
    });
    expect(args.todos).toHaveLength(2);
    expect(args).not.toHaveProperty('tool_input');
  });

  it('caps a giant todo list to 100 items', () => {
    const todos = Array.from({ length: 150 }, (_, i) => ({ content: `t${i}`, status: 'pending' }));
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'todo_write', toolCallId: 'tc4', input: { todos } });
    expect((args.todos as unknown[]).length).toBe(100);
  });

  it('a non-todo tool with no input still forwards an empty capped input', () => {
    const args = buildActivityArgs({ type: 'tool_call', toolName: 'bash', toolCallId: 'tc5', input: {} });
    expect(args.tool_input).toEqual({});
    expect(args.tool_name).toBe('bash');
  });

  it("forwards PAPERCUSP_ROLE and falls back to PAPERCUSP_AGENT_ROLE", () => {
    const previousRole = process.env.PAPERCUSP_ROLE;
    const previousAgentRole = process.env.PAPERCUSP_AGENT_ROLE;
    try {
      process.env.PAPERCUSP_ROLE = "judge";
      delete process.env.PAPERCUSP_AGENT_ROLE;
      expect(
        buildActivityArgs({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "role-1",
          input: {},
        }),
      ).toMatchObject({ role: "judge" });

      delete process.env.PAPERCUSP_ROLE;
      process.env.PAPERCUSP_AGENT_ROLE = "worker";
      expect(
        buildActivityArgs({
          type: "tool_call",
          toolName: "bash",
          toolCallId: "role-2",
          input: {},
        }),
      ).toMatchObject({ role: "worker" });
    } finally {
      if (previousRole === undefined) delete process.env.PAPERCUSP_ROLE;
      else process.env.PAPERCUSP_ROLE = previousRole;
      if (previousAgentRole === undefined)
        delete process.env.PAPERCUSP_AGENT_ROLE;
      else process.env.PAPERCUSP_AGENT_ROLE = previousAgentRole;
    }
  });

  it('suppresses burst-duplicate reports for the same OMP tool call', async () => {
    const originalFetch = global.fetch;
    const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
    const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    const posts: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      posts.push((JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } }).params);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    try {
      const event = { type: 'tool_call' as const, toolName: 'ask', toolCallId: 'a', input: { questions: [] } };
      await reportActivity(event);
      await reportActivity(event);
      await reportActivity({ ...event, toolCallId: 'b' });
      expect(posts.map((p) => p.arguments.tool_use_id)).toEqual(['a', 'b']);
    } finally {
      global.fetch = originalFetch;
      if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL; else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
      if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN; else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    }
  });

  it('uses one post-tool activity RPC and never emits separate inbox/glance RPCs for N quiet calls', async () => {
    const originalFetch = global.fetch;
    const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
    const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    const posts: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const post = (JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } }).params;
      posts.push(post);
      const cursor = (post.arguments.hook_bundle as { generation?: string | null } | undefined)?.generation;
      const hookBundle = cursor
        ? { schemaVersion: 'activity-hook-bundle-v1', generation: 'host-a:42', changed: false, complete: true }
        : {
            schemaVersion: 'activity-hook-bundle-v1', generation: 'host-a:42', changed: true, complete: true,
            surfaces: {
              inbox: { entries: [], injection: '', summary: { newest_ts: null } },
              glance: { display: { title: 'su-abc', notice: null } },
            },
          };
      return {
        ok: true,
        text: async () => JSON.stringify({
          jsonrpc: '2.0', id: 1,
          result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, hook_bundle: hookBundle }) }] },
        }),
      };
    }) as unknown as typeof fetch;
    try {
      _resetMidTurnCursorForTests('2026-06-01T00:00:00Z');
      for (let i = 0; i < 20; i += 1) {
        stageActivityReport({ type: 'tool_call', toolName: 'read', toolCallId: `quiet-${i}`, input: { path: `f${i}` } });
        const bundle = await reportActivityResult({ type: 'tool_result', toolCallId: `quiet-${i}` });
        await consumeActivityHookBundle(bundle);
      }
      expect(posts).toHaveLength(20);
      expect(new Set(posts.map((p) => p.name))).toEqual(new Set(['activity:report']));
      expect(posts.every((p) => (p.arguments.hook_bundle as { since_ts?: string }).since_ts === '2026-06-01T00:00:00Z')).toBe(true);
    } finally {
      global.fetch = originalFetch;
      if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL; else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
      if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN; else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    }
  });
});

describe('reportLifecycle (OMP session lifecycle → activity bridge)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;

  beforeEach(() => {
    _resetHookOwnerIdForTests();
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL; else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN; else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
  });

  async function capture(phase: 'start' | 'shutdown') {
    let posted: { name: string; arguments: Record<string, unknown> } | null = null;
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      posted = (JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } }).params;
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }) };
    }) as unknown as typeof fetch;
    await reportLifecycle(phase);
    return posted as { name: string; arguments: Record<string, unknown> } | null;
  }

  it('reports a "▶ session started" lifecycle row on start (agent=omp, kind=lifecycle)', async () => {
    const p = await capture('start');
    expect(p?.name).toBe('activity:report');
    expect(p?.arguments).toMatchObject({ agent: 'omp', kind: 'lifecycle', summary: '▶ session started' });
    expect(String(p?.arguments.owner)).toMatch(/^omp-/);
  });

  it("forwards the fine-grained launch role on lifecycle reports", async () => {
    const previousRole = process.env.PAPERCUSP_ROLE;
    const previousAgentRole = process.env.PAPERCUSP_AGENT_ROLE;
    try {
      process.env.PAPERCUSP_ROLE = "judge";
      delete process.env.PAPERCUSP_AGENT_ROLE;
      const p = await capture("start");
      expect(p?.arguments).toMatchObject({ role: "judge" });
    } finally {
      if (previousRole === undefined) delete process.env.PAPERCUSP_ROLE;
      else process.env.PAPERCUSP_ROLE = previousRole;
      if (previousAgentRole === undefined)
        delete process.env.PAPERCUSP_AGENT_ROLE;
      else process.env.PAPERCUSP_AGENT_ROLE = previousAgentRole;
    }
  });

  it('reports a "■ session ended" lifecycle row on shutdown', async () => {
    const p = await capture('shutdown');
    expect(p?.arguments).toMatchObject({ kind: 'lifecycle', summary: '■ session ended' });
  });
});

describe('activity:report verified native session query context (EI-24818103845663728)', () => {
  const originalFetch = global.fetch;
  const envKeys = [
    'PAPERCUSP_BUNDLE_URL',
    'PAPERCUSP_BUNDLE_ACCESS_TOKEN',
    'PAPERCUSP_NATIVE_SESSION_ID',
    'PAPERCUSP_ADV_SESSION_ID',
  ] as const;
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    previousEnv.clear();
    for (const key of envKeys) previousEnv.set(key, process.env[key]);
    _resetHookOwnerIdForTests();
    _resetActivityReportDedupeForTests();
    _resetNativeSessionIdForTests();
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    delete process.env.PAPERCUSP_NATIVE_SESSION_ID;
    delete process.env.PAPERCUSP_ADV_SESSION_ID;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetActivityReportDedupeForTests();
    _resetNativeSessionIdForTests();
    _resetHookOwnerIdForTests();
  });

  it('binds pre, post, and lifecycle report requests to the session_start native id', async () => {
    const nativeSessionId = 'native session/+1';
    const calls: Array<{
      url: string;
      params: { name: string; arguments: Record<string, unknown> };
    }> = [];
    global.fetch = (async (input: unknown, init?: { body?: string }) => {
      if (!init?.body) return { ok: true };
      const request = JSON.parse(init.body) as {
        params: { name: string; arguments: Record<string, unknown> };
      };
      calls.push({ url: String(input), params: request.params });
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: '{"ok":true}' }] },
          }),
      };
    }) as unknown as typeof fetch;

    await onSessionStart({ sessionManager: { getSessionId: () => nativeSessionId } });
    await reportActivity({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'pre-1',
      input: { path: 'a.ts' },
    });
    stageActivityReport({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'post-1',
      input: { path: 'b.ts' },
    });
    await reportActivityResult({ type: 'tool_result', toolCallId: 'post-1' });
    await reportLifecycle('shutdown');

    const reports = calls.filter((call) => call.params.name === 'activity:report');
    expect(reports).toHaveLength(4); // session start, pre-tool, post-tool, and shutdown
    expect(reports.map((call) => call.params.arguments.tool_use_id)).toContain('pre-1');
    expect(reports.map((call) => call.params.arguments.tool_use_id)).toContain('post-1');
    expect(reports.map((call) => call.params.arguments.summary)).toContain('▶ session started');
    expect(reports.map((call) => call.params.arguments.summary)).toContain('■ session ended');
    for (const call of reports) {
      const url = new URL(call.url);
      expect(url.searchParams.getAll('native_session')).toEqual([nativeSessionId]);
      expect(url.searchParams.get('origin')).toBe('hook');
      expect(url.searchParams.get('client')).toMatch(/^omp-/);
      expect(call.params.arguments).not.toHaveProperty('native_session');
    }

    const declaration = calls.find((call) => call.params.name === 'coord:declare-intent');
    expect(declaration).toBeDefined();
    expect(new URL(declaration!.url).searchParams.has('native_session')).toBe(false);
  });
});

describe('buildObjectiveTitleOsc (OMP objective → terminal title, P-004)', () => {
  const ESC = '\x1b]0;';
  const BEL = '\x07';

  it('wraps a real objective in an OSC-0 set-title escape — the SHARED legacy shape, no 🔭 (WI-1383525 GAP 3)', () => {
    // The Claude/Codex scripts' term_title dropped the 🔭 marker (WI-1963 #3:
    // "objective-only renders identically (id + objective, no 🔭 in the title)");
    // the OMP fallback now renders the same shape so the three pipes agree.
    expect(buildObjectiveTitleOsc('wire objective display')).toBe(`${ESC}wire objective display${BEL}`);
  });

  it('leads with the agent papercusp id (short su- + 5 hex) when an id is passed, objective after', () => {
    expect(buildObjectiveTitleOsc('wire the title id', 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93')).toBe(
      `${ESC}su-fcdb9 · wire the title id${BEL}`,
    );
  });

  it('with an id but no objective, the title is just the id (the terminal always shows its owner)', () => {
    const id = 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93';
    expect(buildObjectiveTitleOsc(null, id)).toBe(`${ESC}su-fcdb9${BEL}`);
    expect(buildObjectiveTitleOsc('', id)).toBe(`${ESC}su-fcdb9${BEL}`);
  });

  it('the fallback chain absences (null / undefined / blank) all yield no escape', () => {
    expect(buildObjectiveTitleOsc(null)).toBe('');
    expect(buildObjectiveTitleOsc(undefined)).toBe('');
    expect(buildObjectiveTitleOsc('')).toBe('');
    expect(buildObjectiveTitleOsc('   ')).toBe('');
  });

  it('a non-string objective is treated as absent (fail-open against a malformed payload)', () => {
    expect(buildObjectiveTitleOsc(42 as unknown as string)).toBe('');
    expect(buildObjectiveTitleOsc({} as unknown as string)).toBe('');
  });

  it('clips a long objective with an ellipsis so it cannot overflow the title bar', () => {
    const long = 'implement the cross-CLI session objective display across every fleet client right now';
    const osc = buildObjectiveTitleOsc(long);
    expect(osc.startsWith(ESC)).toBe(true);
    expect(osc.endsWith(BEL)).toBe(true);
    expect(osc).toContain('…');
    // The title text (between the introducer and BEL) stays bounded — the python
    // term_title clip is 40 code points + '…', and the port must match it exactly.
    const inner = osc.slice(ESC.length, -1);
    expect(inner).toBe(`${[...long].slice(0, 40).join('')}…`);
    expect([...inner].length).toBe(41);
  });

  it('strips embedded control chars that could break out of the OSC string', () => {
    // A BEL or ESC inside the objective must not terminate / re-open the escape.
    const osc = buildObjectiveTitleOsc('evil\x07title\x1bhere');
    expect(osc).toBe(`${ESC}eviltitlehere${BEL}`);
    // Exactly one BEL (the terminator) and one ESC (the introducer).
    expect([...osc].filter((c) => c === BEL)).toHaveLength(1);
    expect([...osc].filter((c) => c === '\x1b')).toHaveLength(1);
  });
});

describe('ttyCandidates + writeOscTitle — the OMP twin of pc_tty.py (WI-3665)', () => {
  it('orders candidates test-seam → PAPERCUSP_TTY (owned) → /dev/tty (controlling)', () => {
    expect(
      ttyCandidates({ PAPERCUSP_OBJECTIVE_TTY: '/tmp/seam', PAPERCUSP_TTY: '/dev/pts/24' }),
    ).toEqual(['/tmp/seam', '/dev/pts/24', '/dev/tty']);
  });

  it('falls back to /dev/tty alone when nothing is exported (a plain non-psu omp run)', () => {
    expect(ttyCandidates({})).toEqual(['/dev/tty']);
  });

  it('ignores blank/whitespace env values rather than trying to open them', () => {
    expect(ttyCandidates({ PAPERCUSP_TTY: '   ' })).toEqual(['/dev/tty']);
  });

  it('writes the escape to the OWNED terminal when the controlling one is gone (the bug)', async () => {
    // The setsid'd case: /dev/tty is unopenable, PAPERCUSP_TTY must carry the write.
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-'));
    const owned = join(dir, 'owned.tty');
    await fs.writeFile(owned, '');
    const osc = buildDisplayTitleOsc('👑 windows-parity 🟦 · su-9859e');
    await expect(writeOscTitle(osc, { PAPERCUSP_TTY: owned })).resolves.toBe(true);
    expect(await fs.readFile(owned, 'utf8')).toBe(osc);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('skips a stale candidate and lands on the next one', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-'));
    const owned = join(dir, 'owned.tty');
    await fs.writeFile(owned, '');
    const osc = buildDisplayTitleOsc('su-9859e');
    // The seam points at a path in a directory that does not exist → unopenable → skipped.
    await expect(
      writeOscTitle(osc, {
        PAPERCUSP_OBJECTIVE_TTY: join(dir, 'no-such-dir', 'x.tty'),
        PAPERCUSP_TTY: owned,
      }),
    ).resolves.toBe(true);
    expect(await fs.readFile(owned, 'utf8')).toBe(osc);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves false — never throws — when no terminal accepts the write (headless bee)', async () => {
    await expect(
      // Inject candidates so the assertion is stable when the test runner itself has a
      // controlling /dev/tty (a PTY must not turn this headless case into a false green).
      writeOscTitle(
        '\x1b]0;x\x07',
        { PAPERCUSP_TTY: '/nonexistent/x.tty' },
        ['/nonexistent/x.tty'],
      ),
    ).resolves.toBe(false);
  });

  it('an empty escape writes nothing at all (no title ⇒ no syscall)', async () => {
    await expect(writeOscTitle('', { PAPERCUSP_TTY: '/nonexistent/x' })).resolves.toBe(false);
  });
});

// Mirrors coord-hook.ts's private ttyClaimFilename — the claim filename is derived from the
// FULL device path (not just its basename), so a test claim must be written under the same
// transform or the code looks in the wrong place and (correctly, per fail-open) finds nothing.
const claimFilename = (ttyPath: string) => ttyPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+/, '');

describe('writeOscTitle — the EI-10377 claim check (pty minor-number recycling)', () => {
  it('a claim naming a DIFFERENT session blocks the write to PAPERCUSP_TTY (the on-camera bug)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-claim-'));
    const claimsDir = join(dir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });
    const owned = join(dir, 'recycled.tty');
    await fs.writeFile(owned, '');
    // A NEW session (windows-parity's own relaunch, or an unrelated one) claimed this
    // recycled path — our stale env still spells the same path, but it's no longer ours.
    await fs.writeFile(join(claimsDir, claimFilename(owned)), 'su-someone-else');
    const osc = buildDisplayTitleOsc('👑 windows-parity 🟦 · su-9859e');
    await writeOscTitle(osc, {
      PAPERCUSP_TTY: owned,
      PAPERCUSP_SID: 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353',
      PAPERCUSP_TTY_CLAIMS_DIR: claimsDir,
    });
    // The load-bearing assertion: the recycled path itself was never touched — whether
    // writeOscTitle then fell through to this test process's OWN /dev/tty (environment-
    // dependent; harmless here) is not what this guards against.
    expect(await fs.readFile(owned, 'utf8')).toBe('');
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a claim naming OUR OWN session still lands the write', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-claim-'));
    const claimsDir = join(dir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });
    const owned = join(dir, 'mine.tty');
    await fs.writeFile(owned, '');
    const sid = 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353';
    await fs.writeFile(join(claimsDir, claimFilename(owned)), sid);
    const osc = buildDisplayTitleOsc('su-9859e');
    const wrote = await writeOscTitle(osc, {
      PAPERCUSP_TTY: owned,
      PAPERCUSP_SID: sid,
      PAPERCUSP_TTY_CLAIMS_DIR: claimsDir,
    });
    expect(wrote).toBe(true);
    expect(await fs.readFile(owned, 'utf8')).toBe(osc);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('no claim on record fails OPEN — a session that predates the registry keeps working', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-claim-'));
    const owned = join(dir, 'unclaimed.tty');
    await fs.writeFile(owned, '');
    const osc = buildDisplayTitleOsc('su-9859e');
    const wrote = await writeOscTitle(osc, {
      PAPERCUSP_TTY: owned,
      PAPERCUSP_SID: 'su-9859ea5e-926d-4c65-b8fb-4d7c25a21353',
      PAPERCUSP_TTY_CLAIMS_DIR: join(dir, 'no-such-claims-dir'),
    });
    expect(wrote).toBe(true);
    expect(await fs.readFile(owned, 'utf8')).toBe(osc);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('no PAPERCUSP_SID also fails OPEN — nothing to compare the claim against', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'omp-tty-claim-'));
    const claimsDir = join(dir, 'claims');
    await fs.mkdir(claimsDir, { recursive: true });
    const owned = join(dir, 'nosid.tty');
    await fs.writeFile(owned, '');
    await fs.writeFile(join(claimsDir, claimFilename(owned)), 'su-someone-else');
    const osc = buildDisplayTitleOsc('x');
    const wrote = await writeOscTitle(osc, {
      PAPERCUSP_TTY: owned,
      PAPERCUSP_TTY_CLAIMS_DIR: claimsDir,
    });
    expect(wrote).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('buildDisplayTitleOsc + statusNoticeKey (single-source display pipe, 2026-07-05)', () => {
  const ESC = '\x1b]0;';
  const BEL = '\x07';

  it('wraps the server-rendered title VERBATIM — no local re-assembly', () => {
    expect(buildDisplayTitleOsc('👑 roman 🟪 · ⟳1m · su-abc12 · 🔭 wire the pipe')).toBe(
      `${ESC}👑 roman 🟪 · ⟳1m · su-abc12 · 🔭 wire the pipe${BEL}`,
    );
  });

  it('absent / blank / non-string title → no escape (falls through to the legacy render)', () => {
    expect(buildDisplayTitleOsc(null)).toBe('');
    expect(buildDisplayTitleOsc(undefined)).toBe('');
    expect(buildDisplayTitleOsc('   ')).toBe('');
    expect(buildDisplayTitleOsc(42 as unknown as string)).toBe('');
  });

  it('strips control chars that could break out of the OSC string', () => {
    const osc = buildDisplayTitleOsc('safe\x1b]0;pwn\x07 title');
    expect(osc).toBe(`${ESC}safe]0;pwn title${BEL}`);
    expect([...osc].filter((c) => c === BEL)).toHaveLength(1);
    expect([...osc].filter((c) => c === '\x1b')).toHaveLength(1);
  });

  it('statusNoticeKey: id|text, "tip" fallback id, empty when there is nothing to show', () => {
    expect(statusNoticeKey({ id: 'wake-mode-manual', text: '💡 back to auto' })).toBe('wake-mode-manual|💡 back to auto');
    expect(statusNoticeKey({ text: '💡 anon tip' })).toBe('tip|💡 anon tip');
    expect(statusNoticeKey({ id: 'x', text: '   ' })).toBe('');
    expect(statusNoticeKey(null)).toBe('');
    expect(statusNoticeKey(undefined)).toBe('');
  });
});

describe('emitStatusDisplay (OMP display pipe: title verbatim + 💡 notice on change)', () => {
  const originalFetch = global.fetch;
  const prevOperator = process.env.PAPERCUSP_OPERATOR_URL;
  const prevToken = process.env.PAPERCUSP_SUPERUSER_TOKEN;
  const prevSid = process.env.PAPERCUSP_SID;
  const prevTty = process.env.PAPERCUSP_OBJECTIVE_TTY;
  let ttyFile = '';
  let payload: Record<string, unknown> = {};

  function installFetch() {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}\n\n`,
    })) as unknown as typeof fetch;
  }

  beforeEach(async () => {
    process.env.PAPERCUSP_OPERATOR_URL = 'http://operator.test';
    process.env.PAPERCUSP_SUPERUSER_TOKEN = 'su-token';
    process.env.PAPERCUSP_SID = 'su-fcdb9bd8-dcf5-4a20-b5a6-ba78d1f2eb93';
    ttyFile = join(tmpdir(), `omp-display-tty-${Math.random().toString(36).slice(2)}`);
    process.env.PAPERCUSP_OBJECTIVE_TTY = ttyFile;
    payload = { ok: true };
    _resetHookOwnerIdForTests();
    _resetStatusNoticeDedup();
    installFetch();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    if (prevOperator === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperator;
    if (prevToken === undefined) delete process.env.PAPERCUSP_SUPERUSER_TOKEN;
    else process.env.PAPERCUSP_SUPERUSER_TOKEN = prevToken;
    if (prevSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = prevSid;
    if (prevTty === undefined) delete process.env.PAPERCUSP_OBJECTIVE_TTY;
    else process.env.PAPERCUSP_OBJECTIVE_TTY = prevTty;
    _resetHookOwnerIdForTests();
    _resetStatusNoticeDedup();
    await fs.rm(ttyFile, { force: true });
  });

  it('writes display.title VERBATIM as OSC-0 (display wins over a local objective)', async () => {
    payload = {
      ok: true,
      self: { objective: 'LOCAL objective (must not render)' },
      display: { title: '👑 f 🟦 · ⏸ ✉3 · su-abc12', statusline: [], notice: null },
    };
    await emitStatusDisplay();
    expect(await fs.readFile(ttyFile, 'utf8')).toBe('\x1b]0;👑 f 🟦 · ⏸ ✉3 · su-abc12\x07');
  });

  it('no display block (older operator) → the legacy objective title fallback', async () => {
    payload = { ok: true, self: { objective: 'legacy obj' } };
    await emitStatusDisplay();
    expect(await fs.readFile(ttyFile, 'utf8')).toBe(
      buildObjectiveTitleOsc('legacy obj', process.env.PAPERCUSP_SID),
    );
  });

  it('delivers a NEW notice to the model + human, DEDUPES repeats, re-emits on CHANGE', async () => {
    const sent: Array<{ customType: string; content: string }> = [];
    const notes: Array<{ m: string; t?: string }> = [];
    const pi = { sendMessage: (m: { customType: string; content: string }) => { sent.push(m); } };
    const ctx = { hasUI: true, ui: { notify: (m: string, t?: string) => { notes.push({ m, t }); } } };
    payload = {
      ok: true,
      display: { title: 'su-abc12', statusline: [], notice: { id: 'wake-mode-manual', text: '💡 back to auto: coord:wake-mode mode=auto' } },
    };
    await emitStatusDisplay(pi as never, ctx);
    expect(sent).toHaveLength(0);
    const first = takeAdvisories();
    expect(first).toContain('papercusp-status-tip');
    expect(first).toContain('💡 back to auto: coord:wake-mode mode=auto');
    expect(first).toContain('coord:glance for detail');
    expect(notes).toEqual([{ m: '💡 back to auto: coord:wake-mode mode=auto', t: 'info' }]);
    // Same notice again → deduped (no spam on every turn).
    await emitStatusDisplay(pi as never, ctx);
    expect(takeAdvisories()).toBeNull();
    expect(notes).toHaveLength(1);
    // A CHANGED notice re-emits.
    payload = {
      ok: true,
      display: { title: 'su-abc12', statusline: [], notice: { id: 'governor-paused', text: '💡 governor paused' } },
    };
    await emitStatusDisplay(pi as never, ctx);
    expect(takeAdvisories()).toContain('governor paused');
  });

  it('no notice → nothing sent, no ui.notify (title leg still runs)', async () => {
    const sent: unknown[] = [];
    const pi = { sendMessage: (m: unknown) => { sent.push(m); } };
    payload = { ok: true, display: { title: 'su-abc12', statusline: [], notice: null } };
    await emitStatusDisplay(pi as never, { hasUI: false });
    expect(sent).toHaveLength(0);
    expect(await fs.readFile(ttyFile, 'utf8')).toBe('\x1b]0;su-abc12\x07');
  });

  it('a ui-less ctx (headless omp) still injects the model-facing notice', async () => {
    const sent: Array<{ content: string }> = [];
    const pi = { sendMessage: (m: { content: string }) => { sent.push(m); } };
    payload = { ok: true, display: { title: null, statusline: [], notice: { id: 't', text: '💡 headless tip' } } };
    await emitStatusDisplay(pi as never, undefined);
    expect(sent).toHaveLength(0);
    expect(takeAdvisories()).toContain('headless tip');
  });
});

describe('resolveHookWorkspace (robust workspace resolution)', () => {
  const prevWs = process.env.PAPERCUSP_WORKSPACE;
  const prevHome = process.env.PAPERCUSP_HOME;
  afterEach(() => {
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE; else process.env.PAPERCUSP_WORKSPACE = prevWs;
    if (prevHome === undefined) delete process.env.PAPERCUSP_HOME; else process.env.PAPERCUSP_HOME = prevHome;
  });
  it('prefers PAPERCUSP_WORKSPACE when set', () => {
    process.env.PAPERCUSP_WORKSPACE = 'ws-env';
    process.env.PAPERCUSP_HOME = '/home/u/.papercusp-workspaces/ws-path/.papercusp';
    expect(resolveHookWorkspace()).toBe('ws-env');
  });
  it('derives the workspace from the .papercusp-workspaces/<ws>/ session path when no env var', () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    process.env.PAPERCUSP_HOME = '/home/u/.papercusp-workspaces/papercusp-workspace/.papercusp';
    expect(resolveHookWorkspace()).toBe('papercusp-workspace');
  });
  it('returns a string (empty) when neither env nor a workspace path is present', () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    process.env.PAPERCUSP_HOME = '/home/u/not/a/workspace';
    expect(typeof resolveHookWorkspace()).toBe('string');
  });
});

describe('callMcpTool workspace scoping (scoped-superuser clamp fix)', () => {
  const originalFetch = global.fetch;
  const prevWs = process.env.PAPERCUSP_WORKSPACE;
  let headers: Record<string, string> = {};
  beforeEach(() => {
    headers = {};
    global.fetch = (async (_url: unknown, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }),
      };
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE;
    else process.env.PAPERCUSP_WORKSPACE = prevWs;
  });

  it('sends x-papercusp-workspace from PAPERCUSP_WORKSPACE so the superuser clamp resolves the call', async () => {
    process.env.PAPERCUSP_WORKSPACE = 'papercusp-workspace';
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x' });
    expect(headers['x-papercusp-workspace']).toBe('papercusp-workspace');
  });

  it('honors an explicit workspace override', async () => {
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x', workspace: 'ws-override' });
    expect(headers['x-papercusp-workspace']).toBe('ws-override');
  });

  it('omits the header when no workspace is resolvable (no worse than before)', async () => {
    delete process.env.PAPERCUSP_WORKSPACE;
    await callMcpTool('coord:inbox', {}, { mcpUrl: 'http://op/api/mcp?superuser=1', bearer: 'x', workspace: '' });
    expect(headers['x-papercusp-workspace']).toBeUndefined();
  });
});

// ── search_tool_bm25 off-ramp closure (weak-model-tool-tier-2026-07-01 / ornith) ──────────────
// The trimmed surface gives a weak/local model tools:find + tools:invoke as its ONLY discovery
// path; onToolCall blocks OMP's native search_tool_bm25 for agent sessions and redirects to
// tools:find. These cover the pure pieces (the I/O redirect buildToolFindRedirect is verified at
// deploy against a live operator, per this file's header).

describe('isNativeToolSearch', () => {
  it('matches OMP native search_tool_bm25 case-insensitively', () => {
    expect(isNativeToolSearch('search_tool_bm25')).toBe(true);
    expect(isNativeToolSearch('SEARCH_TOOL_BM25')).toBe(true);
  });
  it('does not match our discovery tools or anything else', () => {
    expect(isNativeToolSearch('tools:find')).toBe(false);
    expect(isNativeToolSearch('tools:invoke')).toBe(false);
    expect(isNativeToolSearch('coord:send')).toBe(false);
    expect(isNativeToolSearch('bash')).toBe(false);
    expect(isNativeToolSearch('search')).toBe(false);
  });
});

describe('extractToolSearchQuery', () => {
  it('reads the canonical query field (trimmed)', () => {
    expect(extractToolSearchQuery({ query: '  feature flags  ' })).toBe('feature flags');
  });
  it('tolerates the alternate field names OMP might use', () => {
    expect(extractToolSearchQuery({ keyword: 'spawn a worker' })).toBe('spawn a worker');
    expect(extractToolSearchQuery({ q: 'locks' })).toBe('locks');
  });
  it('falls back to the first non-empty string value for an unknown field', () => {
    expect(extractToolSearchQuery({ somethingElse: 'send message' })).toBe('send message');
  });
  it('returns empty string when there is no usable query', () => {
    expect(extractToolSearchQuery({})).toBe('');
    expect(extractToolSearchQuery(undefined)).toBe('');
    expect(extractToolSearchQuery({ query: '   ' })).toBe('');
    expect(extractToolSearchQuery({ limit: 5 })).toBe('');
  });
});

describe('formatToolFindRedirect', () => {
  it('renders the tools:find matches inline as the suggestion (first description line only)', () => {
    const reason = formatToolFindRedirect('spawn a worker', [
      { tool: 'cup:spawn', description: 'Spawn one agent of a role into a harness.\nMore detail.' },
      { tool: 'work_items:claim_next', description: 'Claim the oldest unclaimed work-item.' },
    ]);
    expect(reason).toContain('search_tool_bm25 is disabled');
    expect(reason).toContain('tools:find');
    expect(reason).toContain('• cup:spawn — Spawn one agent of a role into a harness.');
    expect(reason).toContain('• work_items:claim_next');
    expect(reason).toContain('tools:invoke');
    // first line of the description only — never the whole multi-line schema dump
    expect(reason).not.toContain('More detail.');
  });
  it('degrades to a plain instruction when tools:find returned no matches', () => {
    const reason = formatToolFindRedirect('nonsense zzz', []);
    expect(reason).toContain('no matches');
    expect(reason).toContain('tools:find');
    expect(reason).not.toContain('•');
  });
  it('handles a missing query without crashing (still redirects)', () => {
    const reason = formatToolFindRedirect('', [{ tool: 'x' }]);
    expect(reason).toContain('search_tool_bm25 is disabled');
    expect(reason).toContain('tools:find("<what you need>")');
    expect(reason).not.toContain('• x');
  });
  it('skips hits with no tool name', () => {
    const reason = formatToolFindRedirect('q', [{ description: 'no name' }, { tool: 'coord:send' }]);
    expect(reason).toContain('• coord:send');
    expect(reason).not.toContain('no name');
  });
});

// P-011 (fuzzy-tool-name-resolution-2026-07-02 / D-012): the I/O half of the bm25→tools:find
// on-ramp. A native search_tool_bm25 call must be SERVED by tools:find (query extracted from the
// call, JSON format forced, matches rendered inline) — and degrade, never throw, on transport failure.
describe('buildToolFindRedirect (bm25 → tools:find on-ramp, I/O)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    _resetHookOwnerIdForTests();
  });

  it('runs tools:find with the model\'s own query (format json) and renders the hits inline', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
    let sent: { params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } } = {};
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      sent = JSON.parse(String(init?.body));
      const payload = { hits: [{ tool: 'coord:send', description: 'Send a coord message.\nmore' }] };
      return {
        ok: true,
        text: async () =>
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }),
      };
    }) as unknown as typeof fetch;
    const reason = await buildToolFindRedirect({ query: 'send a message to a peer' });
    expect(sent.params?.name).toBe('tools:find');
    expect(sent.params?.arguments).toMatchObject({ query: 'send a message to a peer' });
    expect(sent.params?._meta).toEqual({ format: 'json' });
    expect(reason).toContain('• coord:send — Send a coord message.');
    expect(reason).toContain('tools:invoke');
    expect(reason).not.toContain('more');
  });

  it('degrades to the plain instruction (never throws) when the operator is unreachable', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
    global.fetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reason = await buildToolFindRedirect({ query: 'anything' });
    expect(reason).toContain('search_tool_bm25 is disabled');
    expect(reason).toContain('no matches');
  });

  it('makes no tools:find call when the native call carried no usable query', async () => {
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    _resetHookOwnerIdForTests();
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return { ok: true, text: async () => '{}' };
    }) as unknown as typeof fetch;
    const reason = await buildToolFindRedirect({ limit: 5 });
    expect(calls).toBe(0);
    expect(reason).toContain('tools:find("<what you need>")');
  });
});

// ── unstructured owner-ask detection + ingest (owner-inbox-single-pane-2026-07-17 P-004) ──

describe('extractOmpMessageText', () => {
  it('returns a plain string content unchanged', () => {
    expect(extractOmpMessageText('hello')).toBe('hello');
  });
  it('joins text/input_text/output_text blocks, skipping other block types', () => {
    expect(
      extractOmpMessageText([
        { type: 'text', text: 'line one' },
        { type: 'tool_use', id: 'x' },
        { type: 'output_text', text: 'line two' },
      ]),
    ).toBe('line one\nline two');
  });
  it('returns empty string for null/undefined/non-array/non-string content', () => {
    expect(extractOmpMessageText(null)).toBe('');
    expect(extractOmpMessageText(undefined)).toBe('');
    expect(extractOmpMessageText(42)).toBe('');
    expect(extractOmpMessageText([{ type: 'tool_use' }])).toBe('');
  });
});

describe('looksLikeUnstructuredOwnerAsk', () => {
  it('trips on a short standalone last-line question', () => {
    expect(looksLikeUnstructuredOwnerAsk('So, should I ship the migration now or wait?')).toBe(true);
    expect(
      looksLikeUnstructuredOwnerAsk(
        'I finished the audit.\n\nWant me to proceed with the breaking change or hold off?',
      ),
    ).toBe(true);
  });
  it('does not trip when an <ask> block is already present', () => {
    expect(looksLikeUnstructuredOwnerAsk('<ask question="proceed?" />')).toBe(false);
  });
  it('does not trip when a <report> block is present', () => {
    expect(looksLikeUnstructuredOwnerAsk('<report>done</report>\nAll good?')).toBe(false);
  });
  it('does not trip when the text already routes via coord:escalate / coord:ask-owner', () => {
    expect(looksLikeUnstructuredOwnerAsk('Filed via coord:escalate with two options.')).toBe(false);
    expect(looksLikeUnstructuredOwnerAsk('Asked the owner via coord:ask-owner.')).toBe(false);
  });
  it('does not trip on empty text', () => {
    expect(looksLikeUnstructuredOwnerAsk('')).toBe(false);
    expect(looksLikeUnstructuredOwnerAsk('   ')).toBe(false);
  });
  it('does not trip on a long multi-clause sentence ending in "?" (conservative)', () => {
    const longLine = `${'x'.repeat(310)}?`;
    expect(looksLikeUnstructuredOwnerAsk(longLine)).toBe(false);
  });
  it('does not trip on prose with no trailing question', () => {
    expect(looksLikeUnstructuredOwnerAsk('Deployed the fix and verified it in staging.')).toBe(false);
  });
  it('does not trip on a code-fence or comment line ending in "?"', () => {
    expect(looksLikeUnstructuredOwnerAsk('```\nregex.test(x)?\n```')).toBe(false);
  });
});

describe('readLastOmpAssistantText (bounded tail read over an OMP-shaped transcript)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omp-ask-transcript-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the LAST assistant message text, skipping a trailing user line', async () => {
    const file = join(dir, 't1.jsonl');
    writeFileSync(
      file,
      [
        { type: 'message', message: { role: 'user', content: 'hi' }, timestamp: '2026-07-17T00:00:00Z' },
        {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Should I proceed?' }] },
          timestamp: '2026-07-17T00:00:01Z',
        },
        { type: 'message', message: { role: 'user', content: 'not yet' }, timestamp: '2026-07-17T00:00:02Z' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    // The trailing line is a USER turn; the reader must walk back to the last ASSISTANT one.
    expect(await readLastOmpAssistantText(file)).toBe('Should I proceed?');
  });

  it('returns "" for a missing file (no throw)', async () => {
    expect(await readLastOmpAssistantText(join(dir, 'does-not-exist.jsonl'))).toBe('');
  });

  it('returns "" when no assistant message line is present', async () => {
    const file = join(dir, 'no-assistant.jsonl');
    writeFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'hi' } })}\n`);
    expect(await readLastOmpAssistantText(file)).toBe('');
  });

  it('skips malformed / non-JSON lines without throwing', async () => {
    const file = join(dir, 'malformed.jsonl');
    writeFileSync(
      file,
      [
        'not json at all',
        JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'ok?' } }),
      ].join('\n') + '\n',
    );
    expect(await readLastOmpAssistantText(file)).toBe('ok?');
  });
});

describe('reportTurnAskIngest (OMP turn_end ask ingest + followUp nudge)', () => {
  const originalFetch = global.fetch;
  const prevBundle = process.env.PAPERCUSP_BUNDLE_URL;
  const prevToken = process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omp-ask-ingest-'));
    process.env.PAPERCUSP_BUNDLE_URL = 'http://operator.test';
    process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = 't';
    _resetOpenAskGatesForTests();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    if (prevBundle === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundle;
    if (prevToken === undefined) delete process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN;
    else process.env.PAPERCUSP_BUNDLE_ACCESS_TOKEN = prevToken;
    _resetOpenAskGatesForTests();
  });

  function fakeCtx(sessionId: string, filePath?: string) {
    return {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => filePath,
      },
    };
  }

  function writeAssistantTurn(file: string, text: string) {
    writeFileSync(
      file,
      `${JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`,
    );
  }

  it('returns no nudge and calls nothing when there is no session id / transcript path', async () => {
    const calls: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { params: { name: string } }).params.name);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }) };
    }) as unknown as typeof fetch;
    expect(await reportTurnAskIngest(fakeCtx('', undefined))).toEqual({ nudge: '' });
    expect(await reportTurnAskIngest({})).toEqual({ nudge: '' });
    expect(calls).toEqual([]);
  });

  it('posts kind:"ask" + returns a nudge when the turn ends in an unstructured question', async () => {
    const file = join(dir, 'ask.jsonl');
    writeAssistantTurn(file, 'Should I ship the breaking migration now, or wait for review?');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
      calls.push({ name: body.params.name, args: body.params.arguments });
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }) };
    }) as unknown as typeof fetch;

    const { nudge } = await reportTurnAskIngest(fakeCtx('sess-1', file));
    expect(nudge).toMatch(/coord:escalate/);
    const ingestCall = calls.find((c) => c.name === 'sessions:ingest-gate-event');
    expect(ingestCall).toBeDefined();
    expect(ingestCall?.args).toMatchObject({ sessionId: 'sess-1', client: 'omp', kind: 'ask' });
    expect(typeof ingestCall?.args.refId).toBe('string');
    expect((ingestCall?.args.refId as string).length).toBeGreaterThan(0);
  });

  it('reuses the SAME refId across consecutive turns that keep ending in an unstructured ask', async () => {
    const file = join(dir, 'ask2.jsonl');
    writeAssistantTurn(file, 'Ship now or wait?');
    const refIds: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
      if (body.params.name === 'sessions:ingest-gate-event') refIds.push(body.params.arguments.refId as string);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }) };
    }) as unknown as typeof fetch;

    await reportTurnAskIngest(fakeCtx('sess-2', file));
    await reportTurnAskIngest(fakeCtx('sess-2', file));
    expect(refIds).toHaveLength(2);
    expect(refIds[0]).toBe(refIds[1]);
  });

  it('closes the gate (kind:"cleared", same refId) once a later turn no longer looks like an unstructured ask', async () => {
    const file = join(dir, 'ask3.jsonl');
    writeAssistantTurn(file, 'Ship now or wait?');
    const events: Array<{ kind: string; refId: string }> = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { params: { name: string; arguments: Record<string, unknown> } };
      if (body.params.name === 'sessions:ingest-gate-event') {
        events.push({ kind: body.params.arguments.kind as string, refId: body.params.arguments.refId as string });
      }
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }) };
    }) as unknown as typeof fetch;

    await reportTurnAskIngest(fakeCtx('sess-3', file));
    writeAssistantTurn(file, 'Filed via coord:escalate with two options.');
    await reportTurnAskIngest(fakeCtx('sess-3', file));
    // let the fire-and-forget "cleared" call settle
    await new Promise((res) => setTimeout(res, 20));

    expect(events[0]).toMatchObject({ kind: 'ask' });
    const cleared = events.find((e) => e.kind === 'cleared');
    expect(cleared).toBeDefined();
    expect(cleared?.refId).toBe(events[0].refId);
  });

  it('returns no nudge and calls nothing (no gate to close) when the turn never looked like an ask', async () => {
    const file = join(dir, 'noask.jsonl');
    writeAssistantTurn(file, 'Deployed and verified in staging.');
    const calls: string[] = [];
    global.fetch = (async (_url: unknown, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { params: { name: string } }).params.name);
      return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{}' }] } }) };
    }) as unknown as typeof fetch;

    const { nudge } = await reportTurnAskIngest(fakeCtx('sess-4', file));
    expect(nudge).toBe('');
    expect(calls).not.toContain('sessions:ingest-gate-event');
  });
});

// ── bash→tool substitution gate, OMP path (bash-to-tool-substitution-2026-07-26, P-017) ──
//
// This is a PARITY suite, not a fresh one. D-005 makes the two hook paths carry
// every rule ("a guard fixed in one path must be fixed in both, since
// Claude/Codex hit THIS one and OMP hits that one"), and a rule enforced on only
// one path produces exactly the asymmetry that decision exists to prevent — "it
// blocked me yesterday but not today". So the cases below deliberately mirror
// bash-resource-gate.test.ts's: the same pre-filter corpus, the same fixture
// replay, the same tier semantics. They diverge only where the MECHANISMS
// genuinely differ (`advise` rides out as a staged followUp here, as
// additionalContext there) — and where they must NOT diverge, a test asserts it
// mechanically rather than trusting two files to be edited together.

const SHELL_HOOK_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../cc/pretooluse-bash-resource-gate.sh',
);
describe("substitutionPrefilterHit (OMP pre-filter — decides who pays the round-trip)", () => {
  // A pre-filter MISS is the silent failure this whole describe exists for: no
  // error, no log, just an advisory that never fires for the commands its rule
  // was written for.
  it.each([
    ["sed range read", "sed -n '1,80p' packages/foo.ts"],
    ["sed behind a cd", "cd /repo && sed -n '1,80p' packages/foo.ts"],
    ["cat a file", "cat packages/operator-core/lib/foo.ts"],
    ["head a file", "head -n 20 packages/foo.ts"],
    ["tail a file", "tail -n 50 packages/foo.ts"],
    ["psql select", 'psql -d papercusp -c "SELECT 1"'],
    ["behind sudo", "sudo sed -n '1,5p' /etc/hosts"],
    ["behind sudo -n", "sudo -n cat /etc/hosts"],
    ["behind an env assignment", "FOO=bar cat notes.txt"],
    ["behind nohup", "nohup tail -f log.txt"],
    ["behind timeout", "timeout 5s cat notes.txt"],
    ["second atom in a pipeline", "echo hi; cat notes.txt"],
    ["second atom behind &&", "npm run lint && cat notes.txt"],
    ["an absolute path to the verb", "/usr/bin/cat notes.txt"],
  ])("claims %s", (_label, command) => {
    expect(substitutionPrefilterHit(command)).toBe(true);
  });

  it.each([
    ["a plain listing", "ls -la"],
    ["a word merely CONTAINING a verb", "echo concatenate the duplicates"],
    ["a path merely containing a verb", "node scripts/cat-herder.mjs"],
    ["an unrelated npm script", "npm run lint"],
    // The head here must be one the pre-filter does NOT claim, or this case stops
    // testing what it names. It used to be `grep -n cat notes.txt`, which became a
    // FALSE case the moment `grep` was added to SUBSTITUTION_PREFILTER_HEADS for
    // code-search.definition-lookup: the assertion then failed on `grep` being a
    // legitimately-claimed head, not on `cat`-as-an-argument. `rg` keeps the shape
    // (claimed verb appearing only as an argument) with an unclaimed head.
    ["a verb only as an argument", "rg -n cat notes.txt"],
    ["an empty command", ""],
  ])("does NOT claim %s (no round-trip)", (_label, command) => {
    expect(substitutionPrefilterHit(command)).toBe(false);
  });

  it("never throws on pathological input (a pre-filter bug must not wedge a command)", () => {
    for (const cmd of [
      "|||",
      ";;;",
      "$(",
      "`",
      "FOO=",
      "sudo ",
      "\n\n",
      "((((",
    ]) {
      expect(() => substitutionPrefilterHit(cmd)).not.toThrow();
    }
  });

  // THE ANTI-DRIFT GUARD, and the reason the heads live in a hand-written set:
  // a shell registry pair whose verb is missing from it is enforced nowhere
  // while every other test in this file stays green. Replays the REAL shell
  // atoms behind each recorded equivalence verdict — the same frozen corpus those
  // verdicts were computed from. SQL-corpus pairs are deliberately not included:
  // fixtures contain raw SELECT statements, not shell atoms, and they never
  // reach this OMP shell pre-filter. Add a shell pair without adding its verb
  // and this goes red.
  //
  // Scoped to the ENFORCEABLE pairs. A `not-a-substitute` pair (P-008's
  // `ps`/`pgrep`) is dropped by `matchCommandToSubstitutions` unconditionally
  // per D-007, so its atoms can never produce an advisory no matter what the
  // pre-filter does — admitting them would buy nothing and charge every `ps`
  // call on the box an HTTP round-trip to be told nothing. The exclusion reads
  // the VERDICT off the pair rather than keying on a filename, so it cannot
  // drift from what the matcher actually enforces.
  it("every atom behind an ENFORCEABLE equivalence verdict passes the pre-filter", () => {
    // Selection is SHARED with the cc hook's mirror of this guard
    // (`selectEnforceableFixtures`) so the two cannot drift — see
    // EI-18699117901393768. D-005 duplicates the pre-filter across the HOOKS;
    // it does not require their tests to re-derive which fixtures to replay.
    const { files, expected } = selectEnforceableFixtures(BASH_GATE_PAIRS);
    // Exact, not `> 0`: a filter that silently dropped fixtures would make this
    // guard vacuously green — the same "passes while testing nothing" failure
    // the scoping itself is meant to avoid.
    expect(files.length, "a fixture is missing for some enforceable pair").toBe(
      expected,
    );

    const missed: string[] = [];
    let atoms = 0;
    for (const file of files) {
      const fixture = JSON.parse(
        readFileSync(join(SUBSTITUTION_FIXTURE_DIR, file), "utf8"),
      ) as { sample: { atom: string }[] };
      for (const { atom } of fixture.sample) {
        atoms += 1;
        if (!substitutionPrefilterHit(atom)) missed.push(`${file}: ${atom}`);
      }
    }
    expect(atoms).toBeGreaterThan(0);
    expect(
      missed,
      `pre-filter dropped atoms a registry rule claims:\n${missed.join("\n")}`,
    ).toEqual([]);
  });

  // The replay above proves every FROZEN atom clears the hook. It cannot prove
  // optional bare spellings that the regex accepts but the corpus happened not
  // to contain (`npx vitest` → `vitest`, `npx tsc` → `tsc`). The generator now
  // derives those obligations by progressively stripping accepted leading
  // tokens. Exact equality here closes both drift directions without another
  // defensive-head allowlist to maintain by hand.
  it("matches the complete head set derived from audited pairs and fixtures", () => {
    const derived = deriveSubstitutionPrefilterHeads(
      loadPairFixtures(BASH_GATE_PAIRS),
    );
    expect(derived).toEqual(expect.arrayContaining(["npx", "vitest", "tsc"]));
    expect([...SUBSTITUTION_PREFILTER_HEADS].sort()).toEqual(derived);
  });
});

describe("cross-path parity with the shell hook (D-005 — the duplicated pre-filter)", () => {
  // D-002 keeps the RULES in Postgres so neither hook hardcodes patterns. The
  // pre-filter is the one thing genuinely duplicated (each hook must run it with
  // no imports), so it is the one thing that can drift — and drift here is
  // invisible: the command still runs, it just stops reaching the operator on
  // ONE path. These assertions are the mechanical form of "fix one, fix both".
  const shellHook = readFileSync(SHELL_HOOK_PATH, "utf8");

  /** The raw source of a `NAME = re.compile(r'...')` pattern in the shell hook. */
  const pyRaw = (name: string): string => {
    const m = new RegExp(
      `${name} = re\\.compile\\(\\s*r'([\\s\\S]*?)'\\)`,
    ).exec(shellHook);
    expect(m, `could not find ${name} in ${SHELL_HOOK_PATH}`).not.toBeNull();
    return m![1];
  };

  it("the atom-head set matches the shell hook byte-for-byte", () => {
    const m = /_SUBSTITUTION_HEADS = frozenset\(\(([^)]*)\)\)/.exec(shellHook);
    expect(
      m,
      "could not find _SUBSTITUTION_HEADS in the shell hook",
    ).not.toBeNull();
    const shellHeads = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect(shellHeads.length).toBeGreaterThan(0);
    expect([...shellHeads].sort()).toEqual(
      [...SUBSTITUTION_PREFILTER_HEADS].sort(),
    );
  });

  // The phrase pre-filter is the SAME "fix one, fix both" tax as the atomizer
  // regexes below: it exists because `npm` is too common a head to list in the
  // set above, so `npm run test:file` is claimed as a phrase on both paths.
  // Widen it on one hook only and the router shape pays the round-trip there and
  // silently skips it on the other — invisible without this assertion.
  it("the substitution PHRASE pre-filter matches the shell hook byte-for-byte", () => {
    expect(SUBSTITUTION_PHRASE_RE.source).toBe(
      pyRaw("_SUBSTITUTION_PHRASE_RE"),
    );
  });

  /**
   * The `tools:invoke` remedy is the third thing genuinely duplicated across
   * the two hooks (EI-18810711449496523), and it carries the same drift tax as
   * the pre-filter above: it cannot be imported into a Python heredoc, so the
   * wording exists twice. Drift here is quieter than a pattern drift — both
   * paths still fire, one just keeps handing agents the dead end the fix
   * removed — which is precisely why it needs the mechanical assertion rather
   * than the comment that currently says "mirrors the shell hook".
   */
  it("the tools:invoke fallback hint matches the shell hook byte-for-byte", () => {
    const m = /_INVOKE_HINT = \(([\s\S]*?)\n\)/.exec(shellHook);
    expect(m, "could not find _INVOKE_HINT in the shell hook").not.toBeNull();
    // Join the implicitly-concatenated Python string literals the same way the
    // interpreter does. Asserted non-empty first: a regex that matched but
    // captured nothing would make this guard vacuously green.
    const shellHint = [...m![1].matchAll(/'([^']*)'/g)]
      .map((x) => x[1])
      .join("");
    expect(shellHint.length).toBeGreaterThan(0);
    expect(shellHint).toBe(TOOLS_INVOKE_FALLBACK_HINT);
  });

  it("the three atomizer regexes match the shell hook byte-for-byte", () => {
    expect(SUBST_SPLIT_RE.source).toBe(pyRaw("_SUBST_SPLIT_RE"));
    expect(SUBST_RUNNER_RE.source).toBe(pyRaw("_SUBST_RUNNER_RE"));
    expect(SUBST_ENV_RE.source).toBe(pyRaw("_SUBST_ENV_RE"));
  });

  it("the resource pre-filter matches the shell hook (modulo the capturing-group dialect)", () => {
    const m = /re\.search\(r'(systemctl\|[^']*)', command\)/.exec(shellHook);
    expect(
      m,
      "could not find the resource pre-filter regex in the shell hook",
    ).not.toBeNull();
    // The only permitted difference: the shell hook writes a capturing
    // `(dev|build)` where the TS uses a non-capturing `(?:dev|build)`. Neither
    // hook reads the group, so it is dialect, not behaviour.
    expect(RESOURCE_PREFILTER_RE.source).toBe(
      m![1].replace("(dev|build)", "(?:dev|build)"),
    );
  });
});

describe('resourcePrefilterHit', () => {
  it.each([
    ['systemctl', 'systemctl --user restart papercup-staging-api.service'],
    ['overmind', 'overmind restart web'],
    ['psql', 'psql -d papercusp -c "SELECT 1"'],
    ['astro', 'astro build'],
    ['the desktop sidecar build', 'npm run build-desktop-sidecar'],
    ['release-local', 'papercusp-desktop/bin/release-local.sh'],
    ['npm run dev', 'npm run dev'],
    ['npm run build', 'npm run build'],
  ])('claims %s', (_label, command) => {
    expect(resourcePrefilterHit(command)).toBe(true);
  });

  it.each([
    ['a plain listing', 'ls -la'],
    ['an unrelated npm script', 'npm run lint'],
    ['a test run', 'npm run test:file -- a.test.ts'],
  ])('does NOT claim %s', (_label, command) => {
    expect(resourcePrefilterHit(command)).toBe(false);
  });
});

describe('substitution message formatting', () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    atom: 'cat notes.txt',
    toolName: 'capability:read',
    advisoryText: 'capability:read returns the file with no shell round-trip.',
    tier: 'advise',
    ...over,
  });

  it('renders one block per match, atom + arrow + tool, advisory on its own line', () => {
    const out = formatSubstitutionLines([sub()]);
    expect(out).toContain('`cat notes.txt` → capability:read');
    expect(out).toContain('capability:read returns the file with no shell round-trip.');
  });

  it('omits the advisory line when the row carries no text', () => {
    expect(formatSubstitutionLines([sub({ advisoryText: '' })])).toBe(
      '  • `cat notes.txt` → capability:read',
    );
  });

  it('falls back to ? for a row missing its tool name (never renders undefined)', () => {
    const out = formatSubstitutionLines([sub({ toolName: undefined })]);
    expect(out).toContain('→ ?');
    expect(out).not.toContain('undefined');
  });

  it('truncates a pathological atom so a refusal stays readable', () => {
    const out = formatSubstitutionLines([sub({ atom: `cat ${'x'.repeat(500)}` })]);
    expect(out.split('\n')[0].length).toBeLessThan(200);
  });

  it('renders every match, not just the first', () => {
    const out = formatSubstitutionLines([
      sub(),
      sub({ atom: 'psql -c "SELECT 1"', toolName: 'dev:pg_query' }),
    ]);
    expect(out).toContain('capability:read');
    expect(out).toContain('dev:pg_query');
  });

  it('the deny reason names the gate, the tool, and how to proceed', () => {
    const out = substitutionDenyReason([sub({ tier: 'deny' })]);
    expect(out).toContain('substitution-gate');
    expect(out).toContain('capability:read');
    expect(out).toContain('Re-run using the tool above');
  });

  it('the advisory says the command PROCEEDED — past tense, because on this path it already has', () => {
    // Not a cosmetic divergence from the shell hook's "is proceeding": there the
    // advisory rides out on the allow, BEFORE the command runs; here it is
    // delivered on the next tool_result, AFTER it ran. Same fact, correct tense.
    const out = substitutionAdvisoryText([sub()]);
    expect(out).toContain('bash→tool advisory');
    expect(out).toContain('Advisory only');
    expect(out).toContain('proceeded as issued');
  });

  /**
   * EI-18810711449496523 — see the cc gate's mirror of this guard for the
   * measurement. Short version: the advised tool is usually NOT in the
   * caller's loaded tool surface (8 of the 10 named tools missed on a live
   * trimmed session), and neither hook can know that at decision time. Both
   * messages therefore have to name `tools:invoke`, which reaches any catalog
   * tool server-side, or the advice dead-ends and trains agents to read these
   * rows as noise.
   */
  it('both messages name the tools:invoke fallback for a tool the caller cannot load', () => {
    expect(substitutionAdvisoryText([sub()])).toContain('tools:invoke');
    expect(substitutionDenyReason([sub({ tier: 'deny' })])).toContain('tools:invoke');
  });

  /**
   * P-009 — the executable advisory. `invokeLine` is rendered SERVER-SIDE (see
   * bash-substitution/invoke-envelope.ts); this hook's whole job is to place it,
   * so these pin placement and the suppression rule, not the formatting.
   */
  describe('executable envelope (invokeLine)', () => {
    const withInvoke = (over: Record<string, unknown> = {}) =>
      sub({
        atom: 'tail -n 25 /tmp/x.log',
        invokeLine:
          'tools:invoke { name: "capability:read", args: {"file_path":"/tmp/x.log","tail":25} }',
        ...over,
      });

    it('renders the call under the advisory, labelled as something to run', () => {
      const lines = formatSubstitutionLines([withInvoke()]).split('\n');
      expect(lines[0]).toContain('`tail -n 25 /tmp/x.log` → capability:read');
      // LAST, after the prose: the advisory explains why, the envelope is what
      // to type — and the thing to type should be the last thing read.
      expect(lines[lines.length - 1].trim()).toBe(
        'run: tools:invoke { name: "capability:read", args: {"file_path":"/tmp/x.log","tail":25} }',
      );
    });

    it('omits the run: line entirely when the server derived no envelope', () => {
      expect(formatSubstitutionLines([sub()])).not.toContain('run:');
    });

    it('SUPPRESSES the generic tools:invoke hint once a concrete call is present', () => {
      // The generic hint teaches the convention. A rendered envelope IS a
      // tools:invoke call, so repeating the generic form under it explains the
      // mechanism the agent is already looking at and pushes the one executable
      // line further from the eye. P-009 only pays while that line is the
      // shortest path in the message.
      const advisory = substitutionAdvisoryText([withInvoke()]);
      expect(advisory).toContain('run: tools:invoke');
      expect(advisory).not.toContain('Not in your loaded tool set?');

      const deny = substitutionDenyReason([withInvoke({ tier: 'deny' })]);
      expect(deny).toContain('run: tools:invoke');
      expect(deny).not.toContain('Not in your loaded tool set?');
    });

    it('keeps the generic hint when NO match carried a call (mixed batch)', () => {
      // One row with an envelope is enough to suppress; none must not.
      expect(substitutionAdvisoryText([sub(), sub()])).toContain('Not in your loaded tool set?');
      expect(substitutionAdvisoryText([sub(), withInvoke()])).not.toContain(
        'Not in your loaded tool set?',
      );
    });

    it('hasInvokeEnvelope ignores blank and missing lines', () => {
      expect(hasInvokeEnvelope([sub()])).toBe(false);
      expect(hasInvokeEnvelope([sub({ invokeLine: '   ' })])).toBe(false);
      expect(hasInvokeEnvelope([withInvoke()])).toBe(true);
    });

    it('leaves the pre-P-009 messages byte-identical when no envelope is present', () => {
      // The suppression refactor rebuilt these strings. A drift here would
      // change what every non-envelope advisory on the box says, which is still
      // the majority of them.
      expect(substitutionAdvisoryText([sub()])).toBe(
        'bash→tool advisory: a tool already answers this question directly.\n\n' +
          formatSubstitutionLines([sub()]) +
          '\n\nThe tool call is cheaper (no shell round-trip, structured result) and is ' +
          'what the routing table points at. Advisory only; this command proceeded as issued.\n' +
          TOOLS_INVOKE_FALLBACK_HINT,
      );
    });
  });

  it('the resource refusal names the held resources', () => {
    expect(
      resourceBlockReason([{ resource: 'db:migrate' }, { resource: 'dev:restart' }]),
    ).toContain('db:migrate, dev:restart');
  });

  it('the resource refusal degrades to a generic name when the payload is empty', () => {
    expect(resourceBlockReason(undefined)).toContain('a registered resource');
    expect(resourceBlockReason([])).toContain('a registered resource');
    expect(resourceBlockReason([{}])).toContain('?');
  });
});

describe('stageSubstitutionAdvisory / drainSubstitutionAdvisory (the soft channel)', () => {
  beforeEach(() => {
    drainSubstitutionAdvisory();
  });

  it('drains empty when nothing is staged', () => {
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('is one-shot — a staged advisory is delivered exactly once', () => {
    stageSubstitutionAdvisory('advisory text');
    expect(drainSubstitutionAdvisory()).toBe('advisory text');
    expect(drainSubstitutionAdvisory()).toBe('');
  });
});

describe('checkCommandVerdict (fail-open transport)', () => {
  const originalFetch = global.fetch;
  const prevOperatorUrl = process.env.PAPERCUSP_OPERATOR_URL;
  const prevBundleUrl = process.env.PAPERCUSP_BUNDLE_URL;
  beforeEach(() => {
    delete process.env.PAPERCUSP_BUNDLE_URL;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:59999/';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevOperatorUrl === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperatorUrl;
    if (prevBundleUrl === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundleUrl;
  });

  it('returns the parsed verdict on a well-formed MCP envelope', async () => {
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              { type: 'text', text: JSON.stringify({ decision: 'allow', substitutionTier: 'advise' }) },
            ],
          },
        }),
    })) as unknown as typeof fetch;
    await expect(checkCommandVerdict('cat notes.txt')).resolves.toMatchObject({
      decision: 'allow',
      substitutionTier: 'advise',
    });
  });

  it('forwards the shell cwd to locks:check_command', async () => {
    let requestBody = '';
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      requestBody = init?.body ?? '';
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: JSON.stringify({ decision: 'allow' }) }] },
          }),
      };
    }) as unknown as typeof fetch;

    await expect(checkCommandVerdict('npm install', '/tmp/ei-204040-scratch')).resolves.toMatchObject({
      decision: 'allow',
    });

    const request = JSON.parse(requestBody) as {
      params?: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
    };
    expect(request.params?.arguments).toEqual({ command: 'npm install', cwd: '/tmp/ei-204040-scratch' });
    expect(request.params?._meta).toMatchObject({ format: 'json' });
  });

  it('returns null when the operator is unreachable (never throws into the hook)', async () => {
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(checkCommandVerdict('cat notes.txt')).resolves.toBeNull();
  });

  it('returns null on a non-200', async () => {
    global.fetch = (async () => ({ ok: false, text: async () => 'nope' })) as unknown as typeof fetch;
    await expect(checkCommandVerdict('cat notes.txt')).resolves.toBeNull();
  });

  it('returns null on a malformed body rather than propagating a parse error', async () => {
    global.fetch = (async () => ({ ok: true, text: async () => 'not json' })) as unknown as typeof fetch;
    await expect(checkCommandVerdict('cat notes.txt')).resolves.toBeNull();
  });
});

describe('onToolCall registry verdict — resource holds + substitutions (P-017)', () => {
  const originalFetch = global.fetch;
  const prevOperatorUrl = process.env.PAPERCUSP_OPERATOR_URL;
  const prevBundleUrl = process.env.PAPERCUSP_BUNDLE_URL;
  let bodies: string[] = [];
  let reply: Record<string, unknown> = {};
  let seq = 0;

  /** How many times the hook actually asked the operator. */
  const checkCalls = () => bodies.filter((b) => b.includes('locks:check_command')).length;
  /** A fresh toolCallId per call so the identical-call loop-breaker never fires. */
  const call = (command: string) =>
    onToolCall({
      type: 'tool_call',
      toolName: 'bash',
      toolCallId: `subst-${++seq}`,
      input: { command },
    });

  beforeEach(() => {
    bodies = [];
    reply = { decision: 'allow', matched: [] };
    // A concrete operator URL so a round-trip is POSSIBLE — otherwise
    // callMcpTool short-circuits to null and every "paid no round-trip"
    // assertion below would pass for the wrong reason.
    delete process.env.PAPERCUSP_BUNDLE_URL;
    process.env.PAPERCUSP_OPERATOR_URL = 'http://127.0.0.1:59999/';
    global.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(String(init?.body ?? ''));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { content: [{ type: 'text', text: JSON.stringify(reply) }] },
          }),
      };
    }) as unknown as typeof fetch;
    _resetToolCallCacheForTests();
    resetToolCallLoopState();
    drainSubstitutionAdvisory();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (prevOperatorUrl === undefined) delete process.env.PAPERCUSP_OPERATOR_URL;
    else process.env.PAPERCUSP_OPERATOR_URL = prevOperatorUrl;
    if (prevBundleUrl === undefined) delete process.env.PAPERCUSP_BUNDLE_URL;
    else process.env.PAPERCUSP_BUNDLE_URL = prevBundleUrl;
  });

  const denySub = [
    {
      atom: 'cat notes.txt',
      toolName: 'capability:read',
      advisoryText: 'Use capability:read.',
      tier: 'deny',
    },
  ];

  it('pays NO round-trip for a command neither registry can claim', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    const r = await call('ls -la');
    expect(r.block).toBeUndefined();
    expect(checkCalls()).toBe(0);
  });

  it('asks the operator once for a command a substitution rule could claim', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    await call('cat notes.txt');
    expect(checkCalls()).toBe(1);
  });

  it('DENIES on tier=deny, naming the tool to use instead', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'allow', substitutions: denySub, substitutionTier: 'deny' };
    const r = await call('cat notes.txt');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('substitution-gate');
    expect(r.reason).toContain('capability:read');
  });

  it('tier=advise does NOT block and stages the lesson for the next tool_result', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = {
      decision: 'allow',
      substitutions: [{ ...denySub[0], tier: 'advise' }],
      substitutionTier: 'advise',
    };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    const advisory = drainSubstitutionAdvisory();
    expect(advisory).toContain('bash→tool advisory');
    expect(advisory).toContain('capability:read');
  });

  it('tier=observe neither blocks nor says anything (the default tier is silent)', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = {
      decision: 'allow',
      substitutions: [{ ...denySub[0], tier: 'observe' }],
      substitutionTier: 'observe',
    };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('a resource hold OUTRANKS a substitution deny — the emergency is not buried by the lesson', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = {
      decision: 'block',
      matched: [{ resource: 'db:migrate' }],
      substitutions: denySub,
      substitutionTier: 'deny',
    };
    const r = await call('psql -d papercusp -c "SELECT 1"');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('resource-gate');
    expect(r.reason).toContain('db:migrate');
    expect(r.reason).not.toContain('substitution-gate');
  });

  it('the resource half is UNCONDITIONAL — it fires with no agent marker set', async () => {
    delete process.env.PAPERCUSP_AGENT;
    delete process.env.PAPERCUSP_AGENT_SESSION;
    reply = { decision: 'block', matched: [{ resource: 'dev:restart' }] };
    const r = await call('overmind restart web');
    expect(r.block).toBe(true);
    expect(r.reason).toContain('resource-gate');
  });

  it("the substitution half is agent-gated — an owner's session pays no round-trip and is never denied", async () => {
    delete process.env.PAPERCUSP_AGENT;
    delete process.env.PAPERCUSP_AGENT_SESSION;
    reply = { decision: 'allow', substitutions: denySub, substitutionTier: 'deny' };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    expect(checkCalls()).toBe(0);
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('an owner session that DOES reach the operator still gets no substitution verdict', async () => {
    // psql trips BOTH pre-filters, so the round-trip happens for the RESOURCE
    // question even in an owner session — the substitution answer must still be
    // ignored, or the agent-gate would leak in through the resource path.
    delete process.env.PAPERCUSP_AGENT;
    delete process.env.PAPERCUSP_AGENT_SESSION;
    reply = { decision: 'allow', substitutions: denySub, substitutionTier: 'deny' };
    const r = await call('psql -d papercusp -c "SELECT 1"');
    expect(checkCalls()).toBe(1);
    expect(r.block).toBeUndefined();
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('FAILS OPEN when the operator is unreachable — a wedged operator never wedges a command', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    global.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('FAILS OPEN on a malformed substitutions payload (a string where an array belongs)', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'allow', substitutions: 'not-an-array', substitutionTier: 'deny' };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
  });

  it('does not act on a tier with no matches behind it', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'allow', substitutions: [], substitutionTier: 'deny' };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('does not act on matches with no tier (an unset tier is not a deny)', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'allow', substitutions: denySub, substitutionTier: null };
    const r = await call('cat notes.txt');
    expect(r.block).toBeUndefined();
    expect(drainSubstitutionAdvisory()).toBe('');
  });

  it('covers the `shell` tool-name spelling too, not just `bash`', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'allow', substitutions: denySub, substitutionTier: 'deny' };
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'shell',
      toolCallId: 'subst-shell',
      input: { command: 'cat notes.txt' },
    });
    expect(r.block).toBe(true);
    expect(r.reason).toContain('substitution-gate');
  });

  it('ignores a non-shell tool entirely', async () => {
    process.env.PAPERCUSP_AGENT = 'omp';
    reply = { decision: 'block', matched: [{ resource: 'db:migrate' }] };
    const r = await onToolCall({
      type: 'tool_call',
      toolName: 'read',
      toolCallId: 'subst-read',
      input: { command: 'psql -c "SELECT 1"' },
    });
    expect(r.block).toBeUndefined();
    expect(checkCalls()).toBe(0);
  });
});

// WI-6554700010010472 (owner #1798): OMP's native bash goes through the same RTK rewriter
// as Claude's Bash, Codex's direct shell calls and capability:bash.
describe('RTK output compression for OMP native bash', () => {
  const rtkFake = (): { rewrite: RtkRewriteSync; calls: Array<{ command: string; cwd?: string }> } => {
    const calls: Array<{ command: string; cwd?: string }> = [];
    const rewrite: RtkRewriteSync = (command, opts) => {
      calls.push({ command, cwd: opts?.cwd });
      return `rtk ${command}`;
    };
    return { rewrite, calls };
  };

  it('replaces only the command of a bash call and keeps every other parameter', () => {
    const { rewrite, calls } = rtkFake();
    const input = { command: 'git status', env: { FOO: '1' }, timeout: 30, cwd: '/w', async: true };
    const out = ompBashRtkResult({ toolName: OMP_BASH_TOOL, input }, {}, rewrite);
    expect(out).toEqual({ input: { command: 'rtk git status', env: { FOO: '1' }, timeout: 30, cwd: '/w', async: true } });
    expect(calls).toEqual([{ command: 'git status', cwd: '/w' }]);
    // The event's own input is not mutated: activity reports and gates saw the original.
    expect(input.command).toBe('git status');
  });

  it('keeps fields of a non-blocking gate result alongside the rewrite', () => {
    const { rewrite } = rtkFake();
    const gate: { block?: boolean; reason?: string } = { reason: 'advisory' };
    const out = ompBashRtkResult({ toolName: 'bash', input: { command: 'ls' } }, gate, rewrite);
    expect(out).toEqual({ reason: 'advisory', input: { command: 'rtk ls' } });
  });

  it('never rewrites a blocked call, and never asks RTK about one', () => {
    const { rewrite, calls } = rtkFake();
    const blocked = { block: true, reason: 'held by a peer' };
    expect(ompBashRtkResult({ toolName: 'bash', input: { command: 'git status' } }, blocked, rewrite)).toBe(blocked);
    expect(calls).toEqual([]);
  });

  it.each([
    ['python', { command: 'git status' }],
    ['read', { path: 'x' }],
    ['Bash', { command: 'git status' }],
  ])('leaves a %s call untouched', (toolName, input) => {
    const { rewrite, calls } = rtkFake();
    const result = {};
    expect(ompBashRtkResult({ toolName, input }, result, rewrite)).toBe(result);
    expect(calls).toEqual([]);
  });

  it.each([
    ['no input', undefined],
    ['a missing command', { cwd: '/w' }],
    ['a blank command', { command: '   ' }],
    ['a non-string command', { command: ['git', 'status'] }],
    ['a PTY (interactive) run', { command: 'git status', pty: true }],
    ['RTK_DISABLED=1 in the call env', { command: 'git status', env: { RTK_DISABLED: '1' } }],
  ])('leaves a bash call with %s untouched', (_label, input) => {
    const { rewrite, calls } = rtkFake();
    const result = {};
    expect(ompBashRtkResult({ toolName: 'bash', input }, result, rewrite)).toBe(result);
    expect(calls).toEqual([]);
  });

  it('fails open: no rewriter, a null or identical rewrite, or a throwing rewriter', () => {
    const result = {};
    const event = { toolName: 'bash', input: { command: 'git status' } };
    expect(ompBashRtkResult(event, result, null)).toBe(result);
    expect(ompBashRtkResult(event, result, () => null)).toBe(result);
    expect(ompBashRtkResult(event, result, (c) => c)).toBe(result);
    expect(
      ompBashRtkResult(event, result, () => {
        throw new Error('rtk crashed');
      }),
    ).toBe(result);
  });

  it('looks for the rewriter where both installers put hooks/cc', () => {
    expect(rtkGuardModuleCandidates('/h')).toEqual([`/h/.papercusp/hooks/cc/${RTK_GUARD_MODULE}`]);
  });

  it('imports rtkRewriteSync from the first loadable candidate, skipping missing and broken ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-rtk-'));
    try {
      const broken = join(dir, 'broken.mjs');
      const wrongShape = join(dir, 'wrong-shape.mjs');
      const good = join(dir, 'good.mjs');
      writeFileSync(broken, 'throw new Error("load failure");\n');
      writeFileSync(wrongShape, 'export const rtkRewriteSync = "not a function";\n');
      writeFileSync(good, 'export function rtkRewriteSync(c) { return "rtk " + c; }\n');
      const rewrite = await importRtkRewriter([join(dir, 'missing.mjs'), broken, wrongShape, good]);
      expect(rewrite?.('git status')).toBe('rtk git status');
      expect(await importRtkRewriter([join(dir, 'missing.mjs'), broken, wrongShape])).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the real shared rewriter from the hooks/cc module the installers copy', async () => {
    const guard = resolve(dirname(fileURLToPath(import.meta.url)), '../../cc', RTK_GUARD_MODULE);
    const rewrite = await importRtkRewriter([guard]);
    expect(typeof rewrite).toBe('function');
    // The shared policy applies: an explicit opt-out is never rewritten.
    expect(rewrite?.('RTK_DISABLED=1 git status')).toBeNull();
  });

  it('wires the rewrite into the registered tool_call handler, after the block check', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../coord-hook.ts'), 'utf8');
    const start = source.indexOf("pi.on('tool_call'");
    const end = source.indexOf("pi.on('tool_result'", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    const blockCheck = handler.indexOf('if (result.block) return result;');
    const rewrite = handler.indexOf('return ompBashRtkResult(event, result, await safe(() => loadRtkRewriter(), null));');
    expect(blockCheck).toBeGreaterThan(-1);
    expect(rewrite).toBeGreaterThan(blockCheck);
  });
});
