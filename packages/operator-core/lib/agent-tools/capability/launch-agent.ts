/**
 * capability:launch-agent — THE agent-launch primitive: start agents ad-hoc (on a
 * free-form brief), RESUME a dead one mid-thread, or FORK a live one — into visible
 * desktop windows or headless, in a fleet or not, one or many.
 * (agent-launch-resume-primitives-2026-07-12, D-001/D-002/D-003.)
 *
 * It is the flexible superset of `fleet:launch-on-plan`: that tool stays as the
 * ergonomic "spin up N members on a plan" door, but a launch no longer REQUIRES a
 * plan, a fleet, or a leader. Both doors sit on one shared core
 * (`agent-launch-core.ts`) — the psu-command injectors, the resume/fork resolver,
 * and the launch idempotency guard — so there is no forked spawn path.
 *
 * The modes compose: (ad-hoc | resumed | forked | successor) × (fleet | no-fleet) ×
 * (visible | headless) × 1..N.
 *
 * Two mechanisms are worth knowing, because they are what make a launched agent
 * actually WORK rather than sit at an idle prompt:
 *
 *  1. THE FIRST TURN. `brief` rides the spawn-safe `PAPERCUSP_KICKOFF_PROMPT` env
 *     (never a `--kickoff=` value — a free-form text inside a console greeting
 *     one-liner gets double-quoted and breaks the shell). A FRESH launch seeds it as
 *     the CLI's positional prompt; a RESUME/FORK has no such seam, so psu's
 *     managed-pty host injects it as a turn once the child settles at its prompt
 *     (D-008 — a resumed session's presence rows were reaped when it died, so
 *     roster-gated coord:wake/coord:send answer `unknown_recipient`: the pty is the
 *     ONLY way in).
 *
 *  2. RESUME vs FORK. An in-place resume re-attaches the ORIGINAL coord identity;
 *     resuming a session whose CLI is still running would open a second CLI against
 *     one transcript (WI-3882), so a LIVE source is auto-forked instead (D-007) —
 *     a fork mints a fresh identity and leaves the original untouched. Explicit
 *     `fork:false` instead requires an in-place resume and refuses a live source.
 */
import { randomUUID } from 'node:crypto';
import { SCOPED_INFERENCE_GATEWAY_ENV, snapshotScopedInferenceGateway, type ScopedInferenceGateway } from '@papercusp/orchestrator/codex-gateway-config';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { join } from 'node:path';
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import type { AbortCompletionReceipt, ToolResult } from '@papercusp/tooldef';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { parseBindingRef } from '@papercusp/orchestrator/blueprint';
import { buildConsoleEnvelope } from '../../console-launcher';
import { spawnConsole, spawnHeadless, type SpawnChildExit } from '../../console-spawn';
import { AGENT_LAUNCH_HANDLER_TIMEOUT_SEC, RESUME_VERIFY_TIMEOUT_MS } from '../../agent-kickoff/launch-budgets.mjs';
import { activeWorkspaceId } from '../../workspace-registry';
import { papercuspPathForWorkspace } from '../../papercusp-root';
import {
  createFleetIfAbsent,
  fleetSlugFromName,
  getFleetHeadcountTarget,
  getFleetScheme,
} from '../../agent-fleets-store';
import { latestFleetMembership } from '../../fleet-membership-store';
import { fetchPresenceFleet } from '../coordination/presence-fleet';
import { fetchContextPressure } from '../coordination/context-pressure';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolveGoalLaunch } from '../../goal-launch-settings';
import { resolveSpawnHostOperatorBaseUrl } from '../../mcp-base-url';
import { capPreservingOperative } from '../../operative-clause';
import { listFacts } from '../../agent-facts/store';
import { getModes } from '../../modes/store';
import { modeInstructionsFactKey } from '../mode/set';
import { getLoopStatus } from '../../harness/routines/loop';
import {
  buildAgentLaunchCommand,
  claimAgentLaunch,
  composeModelSpec,
  deriveFreshLaunchEvidenceSummary,
  foldMemberSpec,
  formatFreshLaunchEvidenceSummary,
  injectFleetArg,
  injectLaunchedByArg,
  INTERNAL_EXPECTED_SUCCESSOR_BINDING,
  type InternalExpectedSuccessorBinding,
  renderGoalFleetAllocation,
  isStaleHeadlessAgentHost,
  memberSpecSchema,
  recordAgentLaunchResult,
  releaseAgentLaunchClaim,
  resolveResumeTarget,
  restoreVisibleMayShutdown,
  verifyFreshLaunchStarted,
  verifyResumeStarted,
  type CodexModelSource,
  waitForPtyHostGone,
  type FleetMemberDefaults,
  type FreshLaunchVerdict,
  type FreshLaunchSessionProbe,
  type LaunchMode,
  type MemberSpec,
  normalizeLaunchMode,
  resolveLaunchMode,
} from '../../agent-launch-core';
import { declareCoupling } from '../../coord/couplings';
import { nativeSessionHandleForAdvSession, type NativeSessionHandle } from '../../native-session-handles';
// WI-37920 / P-002: check the backend in the env the WINDOW gets, not ours.
import { BACKEND_AGENTS, backendBinOverrideEnvKey, preflightBackendLaunch } from '../../backend-bin-resolve.mjs';
import { NATIVE_CONTAINER_EXEC_ENV, type NativeContainerExecBinding } from '@papercusp/orchestrator/fleet-srt-spawn';
import { describeSessionEndTime, hasAdvSessionTerminalEvidence, markAdvSessionEnded } from '../../adv-sessions';
import { resolveSessionStates } from '../coordination/liveness-oracle';
import type { ColorScheme } from '../../console-color-schemes';
import { findLiveHostAsync, shutdownViaPty } from '../../events/await/psu-pty-discovery';
import { armInboxWake } from '../../events/await/inbox-wake-arm';
import { classifyResumeTurnExit } from '../../events/await/resume-turn-outcome';
import { nodeCgroupFs } from '../../task-manager/cgroup-read';
import { isPidInLiveWindowScope } from '../../task-manager/terminal-residue-census';
import {
  HEADLESS_LAUNCH_LOG_SCAN_BYTES,
  PSU_LAUNCH_LOG_TAIL_CHARS,
  readPsuLaunchLogTail,
} from '../../psu-launch-log.mjs';
import { assertOriginalCodexRouting, codexThreadWriterHolder, ORIGINAL_CODEX_ROUTING_ENV, supportsTrackedFork } from '../../../../../apps/operator/scripts/psu-launcher.mjs';
import { LaunchModelAliasError, resolveCodexModelSelection, resolveLaunchModelAlias } from '../../model-context-budget.mjs';
import { isSuTierRole } from '../../su-role-addendum';
import { spawnGovernedAgentProcess } from '../../resource-governor/spawn-execution';
import {
  resolveSavedFleetLaunchSpec,
  type SavedFleetLaunchConfig,
  type SavedFleetLaunchSpecProvenance,
} from '../fleet_registry/saved-launch-spec';

/** Internal direct-handler context marker used only to preserve a cold loop
 * successor's already-enrolled first-turn provenance. It is not part of the
 * public launch-agent schema or ordinary caller arguments. */
export const INTERNAL_LOOP_FIRE_ORIGIN: unique symbol = Symbol('internal-loop-fire-origin');

/** Exact scorecard binding stored on a fresh headless grading-auditor task row. */
export interface GradingAuditTaskDetail {
  issueId: string;
  evidenceFingerprint: string;
  reservation: { key: string; reservedAt: string };
}

/** Server-only direct-handler seam; it is intentionally absent from the MCP schema. */
export const INTERNAL_GRADING_AUDIT_TASK_DETAIL: unique symbol = Symbol('internal-grading-audit-task-detail');

/** Private controller seam, absent from the public tool schema. */
export const INTERNAL_SCOPED_INFERENCE_GATEWAY: unique symbol = Symbol('internal-scoped-inference-gateway');
export const INTERNAL_SCOPED_SESSION_CONFINEMENT: unique symbol = Symbol('internal-scoped-session-confinement');
/**
 * Internal context key (benchmark-coverage-frontierswe-v2-2026-10-10 D-026): pin a fresh
 * headless launch's backend CLI to an exact executable, e.g. `{ codex: <container-exec
 * wrapper> }`. Delivered to psu as backendBinOverrideEnvKey(agent), which
 * resolveBackendLaunch honours without falling back. A context symbol, not an argument,
 * so no MCP caller can set it; only the server-side bench runner does.
 */
export const INTERNAL_BACKEND_BIN_OVERRIDE: unique symbol = Symbol('internal-backend-bin-override');
export type InternalBackendBinOverride = Readonly<Record<string, string | NativeContainerExecBinding>>;

/** How long to wait for a resumed session's live psu-pty host to appear before
 *  returning an honest UNCONFIRMED verdict. Most healthy resumes register within
 *  a few seconds, but EI-21476169071856015 measured a healthy exact Codex resume
 *  landing more than seven minutes later, so expiry is never itself a failure. */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isGradingAuditTaskDetail(value: unknown): value is GradingAuditTaskDetail {
  const detail = asRecord(value);
  const reservation = asRecord(detail?.reservation);
  if (!detail || !reservation) return false;
  const issueId = typeof detail.issueId === 'string' ? detail.issueId.trim() : '';
  const evidenceFingerprint = typeof detail.evidenceFingerprint === 'string' ? detail.evidenceFingerprint.trim() : '';
  const key = typeof reservation.key === 'string' ? reservation.key.trim() : '';
  const reservedAt = typeof reservation.reservedAt === 'string' ? reservation.reservedAt.trim() : '';
  return Boolean(
    issueId && evidenceFingerprint && key === `grading-audit:${issueId}` &&
    reservedAt && Number.isFinite(Date.parse(reservedAt)),
  );
}

function agentLaunchCompletionReceipt(
  idempotencyKey: string | null | undefined,
  summaryRecorded: boolean,
): AbortCompletionReceipt | null {
  const key = idempotencyKey?.trim();
  if (!key || !summaryRecorded) return null;
  return { status: 'recorded', effectRef: `agent-launch:${key}` };
}

/**
 * A launch can open processes before its 90-second dispatch deadline. Surface a
 * late success only when this exact call returned a durable idempotency receipt;
 * opening a process alone is not enough to make retrying or reporting safe.
 */
function agentLaunchAbortCompletionReceipt(
  args: unknown,
  result: ToolResult,
): AbortCompletionReceipt {
  const key = asRecord(args)?.idempotencyKey;
  const normalizedKey = typeof key === 'string' ? key.trim() : '';
  const resultData = asRecord(result.structuredContent);
  const receipt = asRecord(resultData?.completionReceipt);
  const expectedEffectRef = normalizedKey ? `agent-launch:${normalizedKey}` : null;
  if (
    expectedEffectRef &&
    receipt?.status === 'recorded' &&
    receipt.effectRef === expectedEffectRef
  ) {
    return { status: 'recorded', effectRef: expectedEffectRef };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'launch-agent did not return a matching durable idempotency receipt',
    failures: [normalizedKey ? 'missing-completion-receipt' : 'missing-idempotency-key'],
  };
}

/**
 * Read the bounded, per-owner psu boot log without allowing this diagnostic
 * side-channel to change the resume verdict. The launcher writes this file
 * before it can register a live host, so it is the only evidence available for
 * an archived/no-op resume that leaves no psu-pty host behind.
 */
function readResumeBootLogTail(ownerId: string): string | null {
  try {
    return readPsuLaunchLogTail(ownerId, { chars: PSU_LAUNCH_LOG_TAIL_CHARS });
  } catch {
    return null;
  }
}

/** Read only the bounded tail of the per-launch headless log. The owner-keyed
 * psu boot log is not the same artifact as spawnHeadless's fleet log: the
 * former may stop before the resumed CLI starts, while the latter contains the
 * eventual provider error that childExit observed. */
function readHeadlessResumeLogTail(logPath: string | null | undefined): string | null {
  if (!logPath) return null;
  let fd: number | null = null;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, HEADLESS_LAUNCH_LOG_SCAN_BYTES);
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.subarray(0, read).toString('utf8').slice(-PSU_LAUNCH_LOG_TAIL_CHARS);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort diagnostic; a missing tail must not change the exit verdict.
      }
    }
  }
}

/** Classify a persistent headless child exit with the shared resume taxonomy. */
function classifyHeadlessResumeExit(
  exit: SpawnChildExit,
  logPath: string | null | undefined,
  agent: string | null,
): { logTail: string | null; outcome: ReturnType<typeof classifyResumeTurnExit> } {
  const logTail = readHeadlessResumeLogTail(logPath);
  const outcome = classifyResumeTurnExit({
    // A spawn-level error has no meaningful exit code; force the failed-exit
    // branch so its message is classified instead of being mistaken for a
    // clean null/null exit.
    exitCode: exit.error ? 1 : exit.code,
    signal: exit.signal,
    stdoutTail: logTail ?? '',
    stderrTail: exit.error?.message ?? '',
    ...(agent === 'codex' ? { outputProtocol: 'codex-jsonl' as const } : {}),
  });
  return { logTail, outcome };
}

function resumeBootLogNote(tail: string | null): string {
  if (tail == null) return ' No per-owner psu boot log was available.';
  if (tail.length === 0) return ' The per-owner psu boot log was present but empty.';
  return ` Per-owner psu boot log tail (bounded to ${PSU_LAUNCH_LOG_TAIL_CHARS} chars):\n${tail}`;
}

function headlessResumeLogNote(tail: string | null): string {
  if (tail == null) return ' No headless resume log was available.';
  if (tail.length === 0) return ' The headless resume log was present but empty.';
  return ` Headless resume log tail (bounded to ${PSU_LAUNCH_LOG_TAIL_CHARS} chars):\n${tail}`;
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/**
 * Preserve the verifier's durable transcript identity on the public launch
 * task. `ownerId` is only the coordination identity; it is not a resumable
 * transcript target once a role session has ended.
 *
 * The fresh-launch probe exposes Claude and Codex native ids directly. OMP
 * thread metadata stays unresolved when absent. The
 * structural `nativeSession` seam also lets a richer verifier result pass its
 * canonical handle through unchanged.
 */
function nativeSessionHandleFromFreshProbe(
  session: FreshLaunchSessionProbe,
  agent: string | null | undefined,
): NativeSessionHandle | null {
  const projected = (session as FreshLaunchSessionProbe & {
    nativeSession?: NativeSessionHandle | null;
  }).nativeSession;
  if (projected !== undefined) return projected;
  if ((agent !== 'claude' && agent !== 'codex') || !session.ownerId || !session.sessionId) return null;

  // Reuse the canonical adv_sessions resolver so the public shape remains the
  // same backend-neutral NativeSessionHandle used by roster/session consumers.
  // The launch verifier does not carry config-dir evidence, so make that
  // uncertainty explicit rather than probing or guessing a transcript path.
  return nativeSessionHandleForAdvSession(
    {
      id: session.advSessionId,
      agent,
      coordOwnerId: session.ownerId,
      sessionId: session.sessionId,
    } as Parameters<typeof nativeSessionHandleForAdvSession>[0],
    {
      findCodexRolloutId: () => session.sessionId,
      resolveConfigDir: () => ({
        dir: null,
        source: null,
        tried: ['fresh-launch-verifier'],
        unresolvedReason: 'config directory was not included in fresh-launch verification',
      }),
    },
  );
}

/**
 * Validate the FINAL folded psu persona before any launch is claimed or spawned.
 * `role` is a prompt/persona selector, never a convenient lane label. Deferring
 * this check to bootstrap-role opens a real terminal first, so an invalid batch
 * leaves one failed window per member instead of one actionable tool refusal.
 */
function unresolvedAgentRole(opts: {
  harness: string | null;
  projectDir: string;
  configs: readonly FleetMemberDefaults[];
}): string | null {
  const requested = Array.from(
    new Map(
      opts.configs.flatMap((config, index) => {
        const role = config.role?.trim();
        return role ? [[role, { role, source: `agent ${index + 1}` }] as const] : [];
      }),
    ).values(),
  );

  for (const entry of requested) {
    if (entry.role === 'su' || isSuTierRole(entry.role)) continue;
    if (!opts.harness) {
      return (
        `Cannot validate persona role \`${entry.role}\` for ${entry.source}: no harness resolved. ` +
        'Pass `harness`, or omit `role` for the standard su collaborator. Put lane/job names in `brief` or `label`. ' +
        'NO agents were spawned and NO terminals were opened.'
      );
    }
    try {
      assembleRolePrompt({
        slug: opts.harness,
        projectDir: opts.projectDir,
        role: entry.role,
        mode: 'chat',
      });
    } catch (e) {
      return (
        `Invalid persona role \`${entry.role}\` for ${entry.source}: ${(e as Error)?.message ?? e}. ` +
        'Omit `role` for the standard su collaborator, pass `role:"su"`, or choose a registered persona. ' +
        'Put lane/job names in `brief` or `label`. NO agents were spawned and NO terminals were opened.'
      );
    }
  }
  return null;
}

// WI-6154: this-host identity (PAPERCUSP_HONO_PORT) must win over an inherited
// PAPERCUSP_OPERATOR_URL — see resolveSpawnHostOperatorBaseUrl's doc for why.
const resolveOperatorBaseUrl = resolveSpawnHostOperatorBaseUrl;

/** Read the launching session's durable DRAIN overlay once per call. A mode or
 * fact read outage must not strand an otherwise valid ad-hoc launch. */
async function readCallerLaunchMode(workspaceId: string, ownerId: string | null): Promise<LaunchMode | null> {
  if (!ownerId) return null;
  try {
    const modeRows = await getModes(workspaceId, ownerId);
    if (!modeRows.some((row) => row.mode === 'drain')) return null;
    const facts = await listFacts({ scope: 'owner', scopeRef: ownerId }, { workspaceId, limit: 50 });
    const instructions = facts.find((fact) => fact.key === modeInstructionsFactKey('drain'));
    return resolveLaunchMode({ modeRows, instructionsFact: instructions?.body });
  } catch {
    return null;
  }
}

/**
 * capability:launch-agent is intentionally broad, but a fresh plan+fleet launch
 * duplicates fleet:launch-on-plan's authoritative placement mutation. An
 * active GOAL steward must use that canonical door so spawned leadership,
 * eligibility, claim-spec admission, canary proof, and the shared obligation
 * provider are all evaluated together.
 *
 * Resume/fork/successor recovery has no plan argument by contract and remains
 * available. A fresh plan-bound independent grader with no fleet also remains
 * available: it is verification/remediation, not fleet placement.
 */
export function goalHolderPlanFleetBypass(opts: {
  sourceAction: boolean;
  plan?: string | null;
  fleet?: string | null;
  modeRows: ReadonlyArray<{ mode?: unknown; subject?: unknown }>;
}): { goalId: string } | null {
  if (opts.sourceAction || !opts.plan?.trim() || !opts.fleet?.trim()) return null;
  const goal = opts.modeRows.find(
    (row) => row.mode === 'goal' && typeof row.subject === 'string' && row.subject.trim(),
  );
  return goal ? { goalId: String(goal.subject).trim() } : null;
}

/**
 * `extraArgs` is also the capability's escape hatch for psu's durable launch
 * posture flags. Those flags are not part of a fleet's boot-baked profile:
 * comparing them against the saved profile turns a redundant `--auto` on
 * resume into a false saved_launch_spec_conflict. Keep the mode flags in the
 * eventual command, but compare only profile-bearing args and preserve the
 * canonical profile when the caller supplied mode flags alone.
 */
function splitSavedProfileExtraArgs(extraArgs: readonly string[] | undefined): {
  profileArgs: string[];
  modeArgs: string[];
} {
  const profileArgs: string[] = [];
  const modeArgs: string[] = [];
  let pendingModeValue = false;

  for (const arg of extraArgs ?? []) {
    if (pendingModeValue) {
      modeArgs.push(arg);
      pendingModeValue = false;
      continue;
    }
    if (
      arg === '--auto' ||
      arg === '--no-auto' ||
      arg === '--mode=drain' ||
      arg === '--mode-owner-directed' ||
      arg.startsWith('--mode-subject=') ||
      arg.startsWith('--mode-instructions=')
    ) {
      modeArgs.push(arg);
      continue;
    }
    if (arg === '--mode-subject' || arg === '--mode-instructions') {
      modeArgs.push(arg);
      pendingModeValue = true;
      continue;
    }
    profileArgs.push(arg);
  }

  return { profileArgs, modeArgs };
}

const RESUME_FORK_BRIEF_CALL_CONSTRAINT = 'resume or fork => non-empty top-level brief required';

export default defineTool({
  name: 'capability:launch-agent',
  description:
    "Launch an ad-hoc agent, resume, or fork. `resume`/`fork` require a non-empty top-level `brief`; fresh plan-bound or successor launches may omit it. A spawn is not proof of registration, a first turn, or a work claim—read launch verification.",
  guidance: {
    when: 'AD-HOC/RECOVERY AGENT-LAUNCH DOOR: fixed brief, resume, or fork; visible or headless, fleet or unfleeted. Existing-plan N-member work uses fleet:launch-on-plan. Duplicate screening never delays process launch; it governs work-item claims.',
    notWhen:
      'To run a COMMAND (dev server, build, REPL): capability:terminal / capability:bash. Doors: /internal/docs/agent-insights/launching-agents-which-tool-for-which-door.',
    chaining:
      "A fresh/fork/headless launch returns once spawned; a visible in-place resume uses a three-state verifier: matching host = verified, observed UUID mismatch = isError, deadline with no host = RESUME UNCONFIRMED (not an invented failure). `resume: { agentId }` resolves that agent's latest session; a LIVE source is auto-FORKED (two CLIs on one transcript collide), minting a NEW identity — find it in coord:presence. Pass `idempotencyKey` if a retry might re-fire the call (a replay reports deduped:true instead of opening a second set of windows). EI-9748: a `:3170` restart reaps HEADLESS children.",
    seeAlso: [
      'fleet:launch-on-plan (N members on a plan, with seats + capacity advice)',
      'capability:terminal (run a COMMAND in a visible terminal, not an agent)',
      "coord:presence (a launched/forked agent's identity + liveness)",
      'processes:list / processes:kill (returned tasks[].taskId handles; not tasks:get)',
      'roles:list (discover the target harness persona ids before setting role)',
      'roles:known (static built-in role universe)',
    ],
    // EI-22084251948568820 cluster (+ EI-22078751749824171, EI-21575773427457407,
    // EI-21723773357897744): four independent reports of a top-level `carry` being
    // rejected with an opaque "full anyOf schema, no field pointer" error. Carry is
    // a valid flat setting for a FRESH launch; source launches preserve the target
    // loop/profile carry, while `members[i].carry` overrides the fresh flat value.
    //
    // ⛔ There is deliberately NO `argRedirects.carry` here, and re-adding one would
    // not help. `invalidInputCorrections` runs ONLY over UNRECOGNIZED KEYS, and
    // `carry` IS a declared key on BOTH branches of the union below — so the
    // rejection those four filings hit is a BRANCH/VALUE failure, never an unknown
    // key, and a redirect authored here could never fire. (This is the same shape
    // facts:list documents for its `scope` enum.) One was authored anyway and sat
    // dead until the class-wide reachability guard found it:
    // tool-arg-redirect-contract.ts, P-004 of
    // tool-contract-class-sizing-and-non-vacuous-guard-2026-09-05.
    //
    // Those filings are ALREADY FIXED, and not by this redirect: EI-22084251948568820
    // (closed 2026-09-02) added `unknownArgHint` support for union-rooted schemas in
    // libs/generic/tooldef/src/define-tool.ts, so the rejection now names the
    // offending field instead of dumping the whole anyOf. The redirect was a
    // supplementary guidance touch landed alongside that real repair; removing it
    // takes away nothing a caller was receiving. The remaining teaching lives on the
    // two `carry` field descriptions below, which is the surface a caller sees.
  },
  capability: 'capability:terminal',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  // The kickoff-proof window is longer than the old 90s parent declaration.
  // Derive the parent from the actual sequential proof windows so a slow
  // launch returns its structured receipt before the transport abandons it.
  timeoutSec: AGENT_LAUNCH_HANDLER_TIMEOUT_SEC,
  // Launches are deliberately non-idempotent. A completed handler can still prove
  // that this attempt's launch summary is durably queryable by its idempotency key.
  abortCompletionReceipt: agentLaunchAbortCompletionReceipt,
  args: (() => {
    const base = z.object({
      brief: z
        .string()
        .min(1)
        .max(8000)
        .optional()
        .describe(
          'First-turn request; REQUIRED for resume/fork. Optional for fresh plan-bound or per-member briefs, or a successor with seeded carry. Delivery does not prove a turn started or claimed work; read launch verification.',
        ),
      plan: z
        .string()
        .max(120)
        .optional()
        .describe(
          'Plan slug to bind the agent to — it launches on the plan and auto-kicks-off against it (the fleet:launch-on-plan behavior, without needing a fleet).',
        ),
      harness: z
        .string()
        .max(120)
        .optional()
        .describe(
          'Harness slug to bootstrap for an operator-scope launch. Required when the caller context is wildcard/unset; otherwise the caller harness is used.',
        ),
      mcpTarget: z
        .enum(['stable', 'spawn-host'])
        .optional()
        .describe(
          "'spawn-host' binds bootstrap and MCP to this operator for a bounded current-build check; default 'stable' uses the proxy.",
        ),
      workItem: z
        .string()
        .max(200)
        .optional()
        .describe(
          'Exact work-item id that authorizes this launch under a work-scope exception (for example, the scorecard being independently audited).',
        ),
      feature: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Work-item/feature id passed as psu --feature on a fresh launch. For an accepted-operation worker, it must equal workItem; resume and fork retain their source binding.',
        ),
      resume: z
        .object({
          agentId: z
            .string()
            .max(120)
            .optional()
            .describe(
              "The agent's coord id (e.g. 'su-a1a71' — a prefix is fine). Resolves its MOST-RECENT session automatically.",
            ),
          sessionId: z
            .string()
            .max(200)
            .optional()
            .describe(
              "An exact native CLI session uuid, when you want to pin one specific session rather than the agent's latest.",
            ),
        })
        .optional()
        .describe(
          'Resume full context with a required non-empty brief. For ordinary in-place continuation, send `{ resume, brief }`. Add `fork:false` for strict in-place recovery that refuses a live source instead of auto-forking. Choose agentId (latest) OR sessionId (exact). Omitted settings use the target/saved fleet profile. Leave `carry` out because it is rejected for resume/fork. Normally omit `account` and `model` too; overrides may conflict with the saved fleet profile. Use successor for fresh context with retained identity and explicit runtime/carry.',
        ),
      successor: z
        .object({
          agentId: z
            .string()
            .max(120)
            .optional()
            .describe("The ended predecessor's coord id (e.g. 'su-a1a71' — a prefix is fine)."),
          sessionId: z.string().max(200).optional().describe("The ended predecessor's exact native CLI session uuid."),
        })
        .optional()
        .describe(
          'Fresh context for an ENDED predecessor, preserving owner identity, claims and seeded recovery brief. Allows explicit fresh-context `account`, `model`, or `carry` settings. Visible by default when `headless` is omitted or `false`; headless:true hides the window. Cannot combine with restoreVisible. Live sources are refused; resume auto-forks them for a parallel branch.',
        ),
      originalRouting: z.object({
        ownerId: z.string().min(1).max(120),
        advSessionId: z.number().int().positive(),
        sessionId: z.string().uuid(),
        codexHome: z.string().min(1).max(500),
        profileFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      }).strict().optional().describe(
        'Repair the provider route of an exact quiescent Codex thread using its saved gateway account. Pin its original owner, adv row, UUID, isolated home and codexOriginalRoutingFingerprint. Requires an existing healthy profile/transcript; live or changed custody refuses, without fork, successor, shutdown or profile repair. Omit all runtime/settings overrides.',
      ),
      fork: z
        .boolean()
        .optional()
        .describe(
          'Resume routing: omit this for the normal protective behavior (a LIVE source is automatically forked); `true` always branches to a FRESH identity; explicit `false` requires an in-place resume and fails closed if the source is LIVE, rather than silently changing to a fork.',
        ),
      restoreVisible: z
        .boolean()
        .optional()
        .describe(
          'Recover an exact resume.sessionId after its desktop window disappeared. No surviving host: ordinary exact resume. A surviving host is shut down gracefully ONLY with kernel cgroup proof its window is dead; alive/unknown/non-window hosts are refused. For stale headless hosts omit this flag and use ordinary exact resume. Verify the restored visible terminal.',
        ),
      agent: z
        .enum(['claude', 'codex', 'omp'])
        .optional()
        .describe(
          'Which agent CLI backs a FRESH launch (default: the psu default). For resume, an explicit different backend requests a session port that retains the source identity; supply a compatible model. Live-source resumes automatically fork, so they cannot cross backends. A fork keeps the recorded backend. An identity-preserving successor may explicitly override the predecessor backend.',
        ),
      role: z
        .string()
        .max(120)
        .optional()
        .describe(
          'psu --role: a registered persona id resolved against the target harness (the valid ids are harness-specific). Discover exact ids first with roles:list { harnessSlug: "<target>" } and read roles[].id; roles:known lists built-in ids. This is not a lane/job label; put lane direction in the brief or label.',
        ),
      stack: z
        .array(z.string().min(1))
        .max(40)
        .optional()
        .describe('Repeatable psu --stack `<slot>:<id>` bindings (e.g. `domain:papercusp-engineer`) for every fresh launch; bare ids are invalid. members[i].stack overrides this list.'),
      fleet: z
        .string()
        .max(120)
        .optional()
        .describe(
          "Fleet name or slug to JOIN (membership + the fleet's bound window colour). Optional: omit it and a FRESH launch falls back to YOUR OWN presence-fleet (WI-4234); a RESUME/FORK preserves the target session's latest durable fleet membership instead of inheriting the caller's fleet.",
        ),
      independent: z
        .boolean()
        .optional()
        .describe(
          "Keep a FRESH launch out of the caller's presence fleet; an explicit `fleet` still wins (RESUME/FORK membership: see `fleet`).",
        ),
      goalVerifier: z
        .enum(['grade', 'test'])
        .optional()
        .describe('GOAL holder only: launch one independent GRADE or TEST session, bind its matching goal launch profile and mode before turn one, and couple the holder to the verifier.'),
      headless: z
        .boolean()
        .optional()
        .describe(
          'Launch with no window (logs to a file under the workspace fleet-logs dir) instead of a visible desktop terminal. Default false = visible. Headless sessions stay injectable (managed pty).',
        ),
      count: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          'How many agents to launch with this brief/plan (default 1 — or the length of `members` when that is given). Every actual start is independently admitted by the durable resource governor. Not allowed with an in-place resume — one session cannot be resumed N times (fork it instead).',
        ),
      members: z
        .array(memberSpecSchema)
        .optional()
        .describe(
          'Index-aligned FRESH multi-launch config (entry 0 = agent 1). Set fields override top-level args, then system defaults. Registered roles only; invalid personas fail atomically before launch. Missing entries use flat args; omitted count uses members.length. Not for resume/fork. claimKinds requires a self-pulling fleet via fleet:launch-on-plan.',
        ),
      cwd: z
        .string()
        .max(500)
        .optional()
        .describe(
          "Working dir for a FRESH launch (absolute, or relative to the harness project dir). A resume always lands in the session's own recorded cwd.",
        ),
      label: z.string().max(120).optional().describe('Display label (shown in /adv/sessions + the window title).'),
      display: z
        .string()
        .max(40)
        .optional()
        .describe(
          "WI-4272 (demo/recording): open the window(s) on this X display (e.g. ':110') instead of the owner's desktop seat. Linux + visible only.",
        ),
      account: z
        .string()
        .max(120)
        .optional()
        .describe(
          "Account routing for a fresh launch or successor: 'default' (the system login), 'auto' (gateway-routed), or a pool account id. Defaults to 'default' on every platform; the gateway is never selected implicitly. For ordinary in-place resume, omit it to use the target's recorded or saved-fleet account. An explicit resume override is intentional and may be refused if it conflicts with the saved fleet profile. Always resolved — a scripted launch must never block on the interactive account picker.",
        ),
      model: z
        .string()
        .max(80)
        .optional()
        .describe('Model override for a fresh launch or successor (e.g. an opus/sonnet spec). For ordinary in-place resume, omit it to use the target session model; an explicit resume override is intentional and may be refused if it conflicts with the saved fleet profile.'),
      effort: z.string().min(1).max(40).optional()
        .describe('Reasoning effort for every member (low|medium|high|xhigh|max); members[].effort overrides it. Human model aliases resolve through config:tiers-get launchAliases.'),
      extraArgs: z
        .array(z.string().max(200))
        .max(20)
        .optional()
        .describe(
          "Extra psu flags passed through as individually shell-quoted argv values (e.g. ['--brain', '--context-size=trimmed']) — the capability:terminal pass-through model, so a NEW psu flag or structured JSON value needs no tool change.",
        ),
      idempotencyKey: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe(
          'Dedupe key for retries: pass the SAME key when re-firing a call that may have already landed — a replay reports deduped:true (with what the original launched) instead of opening a SECOND set of agent windows.',
        ),
    });
    // Keep the fresh/source distinction in the published schema, but validate it
    // with field-specific issues instead of a union of `z.never()` branches. The
    // union used to report `successor` as the offending field whenever a valid
    // successor carried a source-only override such as `carry`, because the
    // fresh branch rejected successor before the source branch rejected carry.
    // Successors are fresh processes, so they may override backend, account,
    // model, placement, and carry while retaining the predecessor identity.
    return base
      .extend({
        carry: z
          .enum(['warm', 'cold'])
          .optional()
          .describe(
            "Warm/cold auto-mode carry for a FRESH launch or identity-preserving successor. `members[i].carry` overrides this flat value. Do not set it with in-place `resume`/`fork`: the schema rejects it and the target session's loop/profile carry is retained.",
          ),
      })
      .superRefine((value, refinement) => {
        const hasResume = Boolean(value.resume?.agentId || value.resume?.sessionId);
        const hasSuccessor = Boolean(value.successor?.agentId || value.successor?.sessionId);
        if (hasResume && hasSuccessor) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['successor'],
            message: '`resume` and `successor` are mutually exclusive; choose the source recovery mode you want.',
          });
        }
        if (hasSuccessor && value.restoreVisible !== undefined) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['restoreVisible'],
            message: '`successor` and `restoreVisible` are mutually exclusive; use `restoreVisible` only with an exact session resume.',
          });
        }
        if (value.plan && (hasResume || hasSuccessor)) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['plan'],
            message: '`plan` is for a FRESH launch; resumed and successor sessions keep their own context.',
          });
        }
        if (hasResume && value.carry) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['carry'],
            message: '`carry` is not valid for an in-place resume/fork; the target session preserves its loop/profile carry. Use `successor` to start a fresh identity-preserving context with an explicit carry.',
          });
        }
        if (hasResume && !value.brief?.trim()) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['brief'],
            message: '`brief` is required with `resume`/`fork` because it is the resumed session\'s actionable next turn',
          });
        }
      })
      // Keep the root Zod object (launch-agent consumers inspect args.shape),
      // while publishing the same cross-field rule to MCP/compact-schema clients.
      // A root oneOf would be erased by flattenForOpenAi; dependentSchemas is
      // preserved as an object-rooted JSON Schema constraint.
      // This validator-owned call annotation preserves the separate
      // resume/fork brief requirement in tools:find, whose structural
      // projection correctly keeps `brief` optional for fresh launches.
      .meta({
        dependentSchemas: {
          successor: { not: { required: ['restoreVisible'] } },
          restoreVisible: { not: { required: ['successor'] } },
        },
        'x-papercusp-call-constraint': RESUME_FORK_BRIEF_CALL_CONSTRAINT,
      });
  })(),
  async handler(args, ctx) {
    let modelResolution: ReturnType<typeof resolveLaunchModelAlias> | null = null;
    const memberAliasResolutions: Array<ReturnType<typeof resolveLaunchModelAlias> | undefined> = [];
    const requestedDefaultEffort = args.effort;
    // Internal recovery callers set this only when the durable leader identity
    // must resume from its own launch record. It is intentionally outside the
    // public schema so ordinary resumes continue using the fleet recipe.
    const leaderRecoveryOwnerId = (args as typeof args & { __leaderRecoveryOwnerId?: string })
      .__leaderRecoveryOwnerId?.trim() || null;
    try {
      if (args.model) {
        modelResolution = resolveLaunchModelAlias(args.model, { effort: args.effort, agent: args.agent });
        args = { ...args, model: modelResolution.model, effort: modelResolution.effort ?? undefined, agent: args.agent ?? modelResolution.agent ?? undefined };
      }
      if (args.members) {
        args = { ...args, members: args.members.map((member, i) => {
          if (!member.model) return member;
          const resolved = resolveLaunchModelAlias(member.model, { effort: member.effort ?? requestedDefaultEffort, agent: member.agent });
          memberAliasResolutions[i] = resolved;
          return { ...member, model: resolved.model, effort: resolved.effort ?? undefined, agent: member.agent ?? resolved.agent ?? undefined };
        }) };
      }
    } catch (error) {
      if (error instanceof LaunchModelAliasError) {
        return { data: { ok: false, error: error.code, message: error.message, candidates: error.candidates }, isError: true };
      }
      throw error;
    }
    const privateRoute = (ctx as typeof ctx & {
      [INTERNAL_SCOPED_INFERENCE_GATEWAY]?: ScopedInferenceGateway;
    })[INTERNAL_SCOPED_INFERENCE_GATEWAY];
    const scopedGateway = privateRoute === undefined ? null : snapshotScopedInferenceGateway(privateRoute);
    const privateConfinement = (ctx as typeof ctx & {
      [INTERNAL_SCOPED_SESSION_CONFINEMENT]?: import('../../capability-envelope/session-confinement').SessionToolConfinement;
    })[INTERNAL_SCOPED_SESSION_CONFINEMENT];
    if (scopedGateway && (!privateConfinement || !Array.isArray(privateConfinement.denyOutside)))
      return err('Scoped native inference requires an exact server-side session tool ceiling before launch.');
    if (scopedGateway && (args.resume || args.successor || args.fork || (args.count ?? args.members?.length ?? 1) !== 1)) {
      return err('Scoped inference gateway requires a fresh single native launch.');
    }
    const backendBinOverride = (ctx as typeof ctx & {
      [INTERNAL_BACKEND_BIN_OVERRIDE]?: InternalBackendBinOverride;
    })[INTERNAL_BACKEND_BIN_OVERRIDE];
    const backendBinOverrideEnv: Record<string, string> = {};
    if (backendBinOverride !== undefined) {
      if (args.resume || args.successor || args.fork || args.headless !== true) {
        return err('A backend binary override requires a fresh headless launch.');
      }
      for (const [agentName, override] of Object.entries(backendBinOverride)) {
        if (!(BACKEND_AGENTS as readonly string[]).includes(agentName)) {
          return err(`A backend binary override names an unknown agent: ${agentName}.`);
        }
        const binPath = typeof override === 'string' ? override : override?.command;
        if (typeof binPath !== 'string' || !isAbsolute(binPath)) {
          return err(`A backend binary override for ${agentName} must be an absolute path.`);
        }
        if (typeof override !== 'string') {
          if (!scopedGateway || !privateConfinement || agentName !== 'codex' || override.kind !== 'docker-exec' ||
              !/^[a-f0-9]{64}$/.test(override.sha256) || Object.keys(override).sort().join(',') !== 'command,kind,sha256')
            return err('A native container binding requires the private metered Codex launch and an exact wrapper digest.');
          backendBinOverrideEnv[NATIVE_CONTAINER_EXEC_ENV] = JSON.stringify(override);
        }
        backendBinOverrideEnv[backendBinOverrideEnvKey(agentName)] = binPath;
      }
    }
    // A launch-declared confinement binds a NEW identity before its process opens. A
    // resumed, successor or forked identity already ran turns unconfined, so it is refused
    // rather than confined after the fact (WI-6554700010008492).
    if (privateConfinement && (args.resume || args.successor || args.fork)) {
      return err('A launch-declared session tool confinement requires a fresh launch.');
    }
    // Internal direct-handler seam used only by fleet:respawn-member after the
    // canonical saved profile has been resolved. It is deliberately absent
    // from the public zod schema, so ordinary fresh-launch behavior does not
    // change and callers cannot smuggle an unaudited recovery carry.
    let savedLaunchCarry = (args as typeof args & { __savedLaunchCarry?: 'warm' | 'cold' }).__savedLaunchCarry;
    const internalKickoffOrigin =
      (ctx as typeof ctx & { [INTERNAL_LOOP_FIRE_ORIGIN]?: 'loop-fire' })[INTERNAL_LOOP_FIRE_ORIGIN] === 'loop-fire'
        ? 'loop-fire'
        : null;
    const gradingAuditTaskDetail = (ctx as typeof ctx & {
      [INTERNAL_GRADING_AUDIT_TASK_DETAIL]?: GradingAuditTaskDetail;
    })[INTERNAL_GRADING_AUDIT_TASK_DETAIL];
    // Internal seam used by fleet:respawn-member: a replacement must be
    // identity-correlated before it is spawned, because concurrent respawns
    // cannot safely identify one another by roster ordering after launch.
    const respawnOwnerId = (args as typeof args & { __respawnOwnerId?: string }).__respawnOwnerId?.trim() || null;
    // Internal seam, same trust boundary as __respawnOwnerId: the member this launch REPLACES.
    // A respawn is net-zero on headcount, so the goal ceiling check must not charge the
    // replaced member's seat (EI-24909345582884838) — otherwise a fleet AT maxPerFleet refuses
    // its own replacement after fleet:respawn-member has already drained the old member.
    const respawnReplacesOwnerId =
      (args as typeof args & { __respawnReplacesOwnerId?: string }).__respawnReplacesOwnerId?.trim() || null;
    let isResume = !!(args.resume?.agentId || args.resume?.sessionId);
    let isSuccessor = !!(args.successor?.agentId || args.successor?.sessionId);
    const expectedSuccessorBinding = (ctx as typeof ctx & {
      [INTERNAL_EXPECTED_SUCCESSOR_BINDING]?: InternalExpectedSuccessorBinding;
    })[INTERNAL_EXPECTED_SUCCESSOR_BINDING];
    if (expectedSuccessorBinding && !isSuccessor) {
      return err('An internal expected source binding requires an identity-preserving successor.');
    }
    const sourceAction = isResume || isSuccessor;
    if (args.originalRouting && (!isResume || !args.resume?.sessionId || args.resume.agentId ||
        args.resume.sessionId !== args.originalRouting.sessionId ||
        ['successor', 'fork', 'restoreVisible', 'agent', 'account', 'model', 'carry', 'fleet', 'extraArgs',
          'members', 'plan', 'cwd', 'role', 'headless', 'independent', 'goalVerifier', 'feature']
          .some((key) => (args as Record<string, unknown>)[key] !== undefined))) {
      return err('originalRouting requires an exact resume with no fork, successor or settings overrides.');
    }
    if (sourceAction && !isSuccessor && args.feature?.trim()) {
      return err('feature cannot override a resumed or forked session binding; omit it to keep the source session binding.');
    }
    if (args.successor && !isSuccessor) {
      return err('`successor` needs `agentId` or `sessionId` — pass the ended predecessor reference to recover.');
    }
    if (isSuccessor && (isResume || args.fork || args.restoreVisible)) {
      return err(
        '`successor` is an explicit fresh recovery mode and cannot be combined with `resume`, `fork`, or `restoreVisible`.',
      );
    }
    if (!sourceAction && args.fork) {
      return err('`fork: true` needs a source session — pass `resume: { agentId }` (or `sessionId`) to fork from.');
    }
    if (args.restoreVisible && !isResume) {
      return err('`restoreVisible:true` requires `resume: { sessionId }` — it restores one exact existing transcript.');
    }
    if (args.restoreVisible && !args.resume?.sessionId) {
      return err(
        '`restoreVisible:true` requires an exact `resume.sessionId`; an agentId/latest lookup is not a safe destructive target.',
      );
    }
    if (args.restoreVisible && args.fork) {
      return err(
        '`restoreVisible:true` and `fork:true` conflict: restoration continues the exact transcript in place; fork leaves the source untouched.',
      );
    }
    if (sourceAction && args.plan) {
      return err(
        '`plan` is for a FRESH launch. A resumed session keeps its own context — put any new direction in `brief`, which becomes its next turn.',
      );
    }
    // P-002: `members` is a FRESH per-member spec array — one session can't be
    // resumed N different ways, so it never rides a resume/fork.
    if (sourceAction && args.members?.length) {
      return err(
        '`members` configures a FRESH per-member multi-launch; a resume/fork is a single session — put any new direction in `brief`.',
      );
    }
    // `count` defaults to the number of member specs when omitted, so `members: [a,b,c]`
    // opens 3 without a redundant `count: 3`.
    const count = args.count ?? (args.members?.length || 1);
    if (args.members && args.members.length > count) {
      return err(
        `You passed ${args.members.length} member specs but count is ${count}. Raise count (or omit it — it defaults to the number of member specs) so every spec maps to an agent, or trim members.`,
      );
    }
    if (isSuccessor && count > 1) {
      return err(
        'A fresh successor is one identity-preserving session. Use a separate fresh brief for parallel work; do not launch N successors onto one predecessor owner.',
      );
    }
    if (isResume && count > 1 && !args.fork) {
      return err(
        'A session cannot be resumed more than once (a second CLI on one transcript collides). Use `fork: true` with `count` to branch N agents off it, or launch fresh agents with a `brief`.',
      );
    }
    if (isResume && !args.brief?.trim()) {
      return err(
        '`resume`/`fork` requires a non-empty `brief` — it is the resumed session\'s actionable next turn. A no-brief resume would open an idle CLI and report an ambiguous launch; use a fresh `plan` launch if no next-turn direction is available.',
      );
    }
    const anyMemberBrief = (args.members ?? []).some((m) => m?.brief?.trim());
    if (!sourceAction && !args.brief && !args.plan && !anyMemberBrief) {
      return err(
        'Give the agent something to do: a `brief` (free-form first turn), a per-member `members[i].brief`, or a `plan` slug — otherwise it launches and sits idle.',
      );
    }

    const workspaceId = ctx.workspaceId && ctx.workspaceId !== '*' ? ctx.workspaceId : activeWorkspaceId();
    // Operator/HTTP bridge calls can arrive with a wildcard or unset harness context. An explicit
    // harness keeps those launches on the su bootstrap path; without it, buildAgentLaunchCommand
    // omits --harness and a fresh psu falls into plain-CLI onboarding before it can receive its brief.
    const slug = args.harness?.trim() || (ctx.harnessSlug && ctx.harnessSlug !== '*' ? ctx.harnessSlug : null);
    // workspace-work-scope-policy-2026-09-04 P-005: no agent is launched into a harness
    // the workspace work-scope policy excludes.
    {
      const { gateWorkScope } = await import('../../work-scope-policy');
      const scope = await gateWorkScope('capability:launch-agent', {
        harness: slug,
        plan: (args as { plan?: string }).plan ?? null,
        workItem: (args as { workItem?: string }).workItem ?? null,
      });
      if (!scope.allowed) return err(scope.message);
    }

    let callerOwnerId: string | null = null;
    try {
      callerOwnerId = resolveAgentIdentity(ctx).ownerId;
    } catch {
      callerOwnerId = null;
    }
    if (args.goalVerifier) {
      if (sourceAction || count !== 1 || args.fleet?.trim() || args.plan?.trim() ||
          args.members?.length || args.extraArgs?.length || !callerOwnerId) {
        return err('goalVerifier requires one fresh, attributable, fleetless brief with no plan, member overrides or raw psu flags. No agent was spawned.');
      }
      let callerModes: Awaited<ReturnType<typeof getModes>>;
      try {
        callerModes = await getModes(workspaceId, callerOwnerId);
      } catch (error) {
        return err(`goal_verifier_authority_unreadable: ${error instanceof Error ? error.message : String(error)}. No agent was spawned.`);
      }
      if (!callerModes.some((row) => row.mode === 'goal' && row.subject)) {
        return err('goalVerifier requires an active, attributed GOAL holder. No agent was spawned.');
      }
    }
    // P-006 / A-04 alternate-entry guard. Pay the fresh authority read ONLY for
    // the ambiguous shape that can bypass canonical plan-fleet placement; all
    // diagnostic/ad-hoc and source-recovery launches retain their existing
    // availability. Unreadable authority fails closed for this one mutation —
    // otherwise a mode-store outage would itself become the bypass.
    if (!sourceAction && args.plan?.trim() && args.fleet?.trim() && callerOwnerId) {
      let modeRows: Awaited<ReturnType<typeof getModes>>;
      try {
        modeRows = await getModes(workspaceId, callerOwnerId);
      } catch (error) {
        return err(
          `goal_plan_placement_authority_unreadable: could not determine whether ${callerOwnerId} is the active ` +
            `GOAL holder before a fresh plan+fleet launch (${error instanceof Error ? error.message : String(error)}). ` +
            'No fleet was created and no agent was spawned. Retry when mode state is readable, or use an ordinary ' +
            'resume/fork/remediation launch that does not create a plan fleet.',
        );
      }
      const bypass = goalHolderPlanFleetBypass({
        sourceAction,
        plan: args.plan,
        fleet: args.fleet,
        modeRows,
      });
      if (bypass) {
        return err(
          `goal_plan_placement_bypass_refused: active GOAL holder for '${bypass.goalId}' cannot create a fresh ` +
            `plan+fleet placement through capability:launch-agent. No fleet was created and no agent was spawned. ` +
            `Use fleet:launch-on-plan { name:${JSON.stringify(args.fleet.trim())}, plan:${JSON.stringify(args.plan.trim())}, ` +
            `harness:${JSON.stringify(slug)}, leader:'spawn', headless:true, ...resourceChoices } so the live shared ` +
            'placement provider, eligibility/admission, canary, and independent-leadership policy run at one boundary. ' +
            'For independent grading/remediation, omit fleet and pass independent:true; resume/fork paths remain available.',
        );
      }
    }
    // DRAIN is a durable caller overlay. Resolve it before composing either a
    // fresh command or a resume/fork command so every capability launch path
    // carries the same mode into bootstrap-su.
    const launchMode = args.goalVerifier
      ? normalizeLaunchMode({ mode: args.goalVerifier })
      : await readCallerLaunchMode(workspaceId, callerOwnerId);

    // Resolve the resume/fork/successor target: an agent id (usual) or an exact
    // session uuid. D-007 keeps ordinary resume/fork behavior unchanged; the
    // explicit successor path is the one exception that intentionally starts a
    // FRESH process while retaining the ended owner's coord identity.
    let resumeSessionId: string | null = null;
    let resumeId: string | null = null;
    let resumeOwnerId: string | null = null;
    let resumeAgent: string | null = null;
    let resumeRole: string | null = null;
    let resumeFeature: string | null = null;
    let resumeSourceAdvSessionId: number | null = null;
    let resumeModel: string | null = null;
    let resumeModelSource: CodexModelSource | null = null;
    let resumeAccount: string | null = null;
    let successorBrief: string | null = null;
    const successorPreparation: { reconcile?: () => Promise<string | null> } = {};
    let reconcileOriginalRouting: (() => Promise<void>) | null = null;
    let recheckInPlaceResume: (() => Promise<void>) | null = null;
    let fork = !!args.fork;
    let sourceStillLive = false;
    const notes: string[] = [];
    if (sourceAction) {
      const source = isSuccessor ? args.successor : args.resume;
      const target = await resolveResumeTarget({
        agentId: source?.agentId ?? null,
        sessionId: source?.sessionId ?? null,
      });
      if (!target.ok) return err(`Cannot ${isSuccessor ? 'start successor' : 'resume'}: ${target.detail}`);
      if (expectedSuccessorBinding) {
        const expected = expectedSuccessorBinding;
        if (!expected.ownerId || !expected.workspaceId || !expected.harnessSlug || !expected.binding?.startedAt ||
            workspaceId !== expected.workspaceId || slug !== expected.harnessSlug ||
            target.ownerId !== expected.ownerId || target.advSessionId !== expected.advSessionId ||
            target.workspaceId !== expected.workspaceId || target.harnessSlug !== expected.harnessSlug ||
            target.binding?.coordOwnerId !== expected.binding.coordOwnerId ||
            target.binding?.sessionId !== expected.binding.sessionId ||
            target.binding?.startedAt !== expected.binding.startedAt) {
          return err('Cannot start successor: the resolved source no longer matches the expected workspace, harness, and incarnation binding. No process was opened.');
        }
      }
      resumeSessionId = target.sessionId;
      // Native UUID verification remains nullable for tracked Codex rows that
      // resume by their adv_sessions row id through psu's isolated CODEX_HOME.
      resumeId = target.resumeId ?? target.sessionId;
      resumeOwnerId = target.ownerId;
      resumeAgent = target.agent;
      resumeRole = target.role;
      resumeFeature = target.feature;
      resumeSourceAdvSessionId = target.advSessionId;
      resumeModel = target.model;
      resumeAccount = target.account;
      if (args.originalRouting) {
        const pin = args.originalRouting;
        if (typeof target.headless !== 'boolean') return err('originalRouting refused: recorded placement is unavailable.');
        // The request forbids placement overrides. Carry the recorded value
        // into the existing command/member configuration after that check.
        args = { ...args, headless: target.headless };
        if (target.agent !== 'codex' || target.advSessionId !== pin.advSessionId ||
            target.ownerId !== pin.ownerId || target.sessionId !== pin.sessionId || target.live ||
            target.binding?.coordOwnerId !== pin.ownerId || target.binding?.sessionId !== pin.sessionId ||
            !target.binding?.startedAt) {
          return err('originalRouting refused: original binding is live or changed.');
        }
        const snapshotTarget = target;
        let snapshot = JSON.stringify(target);
        let terminalEvidenceEstablished = target.endedAt != null;
        const sameExceptTerminal = (current: typeof target) => {
          const omitTerminalFields = (key: string, value: unknown) =>
            key === 'endedAt' || key === 'endedBy' ? undefined : value;
          return JSON.stringify(current, omitTerminalFields) === JSON.stringify(snapshotTarget, omitTerminalFields);
        };
        const validate = (current: typeof target) => {
          if (current.live || current.binding?.sessionId !== pin.sessionId ||
              current.binding?.coordOwnerId !== pin.ownerId)
            throw new Error('originalRouting refused: original binding is live or changed.');
          const native = nativeSessionHandleForAdvSession({
            id: current.advSessionId, agent: current.agent, coordOwnerId: current.ownerId,
            sessionId: current.sessionId,
          } as Parameters<typeof nativeSessionHandleForAdvSession>[0], { findCodexRolloutId: () => null });
          assertOriginalCodexRouting({ id: current.advSessionId, agent: current.agent,
            coordOwnerId: current.ownerId, sessionId: current.sessionId, endedAt: current.endedAt,
            role: current.role,
            account: current.account, codexHome: native?.backend === 'codex' ? native.codexHome : null,
          }, pin);
        };
        // An existing end marker remains a prerequisite for every other
        // original-routing check. A missing marker is handled at the spawn
        // boundary below, where the same terminal-oracle/host/writer/CAS guard
        // used by successors can safely reconcile an exact dead binding.
        if (terminalEvidenceEstablished) {
          try { validate(target); } catch (error) { return err((error as Error).message); }
        }
        reconcileOriginalRouting = async () => {
          let current = await resolveResumeTarget({ sessionId: pin.sessionId });
          if (!current.ok)
            throw new Error('originalRouting refused: original custody or saved settings changed before spawn.');
          if (JSON.stringify(current) !== snapshot) {
            if (!terminalEvidenceEstablished && current.endedAt != null && sameExceptTerminal(current)) {
              // The normal lifecycle writer or reaper may publish its marker
              // after the initial read. Accept only that monotonic transition
              // for this same binding/settings snapshot.
              snapshot = JSON.stringify(current);
              terminalEvidenceEstablished = true;
            } else {
              throw new Error('originalRouting refused: original custody or saved settings changed before spawn.');
            }
          }
          if (!terminalEvidenceEstablished) {
            const binding = snapshotTarget.binding;
            if (!binding || binding.coordOwnerId !== pin.ownerId || binding.sessionId !== pin.sessionId) {
              throw new Error('originalRouting refused: exact predecessor binding is unavailable.');
            }
            if (current.live || await findLiveHostAsync(pin.ownerId)) {
              throw new Error('originalRouting refused: original host is live.');
            }
            const writer = readSourceCodexWriter();
            if (!writer || writer.held || !['free', 'no-lock-file'].includes(writer.reason)) {
              throw new Error('originalRouting refused: original writer is live or unknown.');
            }
            if (!hasAdvSessionTerminalEvidence(current)) {
              const verdicts = await resolveSessionStates([{ ownerId: pin.ownerId }], { hydratePerId: true });
              const state = verdicts.get(pin.ownerId)?.sessionState;
              if (state !== 'ended' && state !== 'suspect') {
                throw new Error(
                  `originalRouting refused: predecessor liveness is ${state ?? 'unknown'}; positive terminal evidence is required.`,
                );
              }
            }
            if (await findLiveHostAsync(pin.ownerId)) {
              throw new Error('originalRouting refused: a live host appeared during terminal reconciliation.');
            }
            const writerAfterOracle = readSourceCodexWriter();
            if (!writerAfterOracle || writerAfterOracle.held ||
                !['free', 'no-lock-file'].includes(writerAfterOracle.reason)) {
              throw new Error('originalRouting refused: a live or unknown writer appeared during terminal reconciliation.');
            }
            const ended = await markAdvSessionEnded(pin.advSessionId, null, 'reconciler', {
              expectedBinding: binding,
              throwOnError: true,
            });
            if (!ended) {
              throw new Error('originalRouting refused: predecessor binding reconciliation lost its compare-and-swap.');
            }
            const reconciled = await resolveResumeTarget({ sessionId: pin.sessionId });
            if (!reconciled.ok || reconciled.endedAt == null || !sameExceptTerminal(reconciled)) {
              throw new Error('originalRouting refused: terminal reconciliation changed or lost the original binding.');
            }
            current = reconciled;
            snapshot = JSON.stringify(current);
            terminalEvidenceEstablished = true;
            notes.push(
              `✓ Reconciled terminal original binding #${pin.advSessionId} before exact routing recovery; actual exit time remains unknown.`,
            );
          }
          validate(current);
        };
      }
      // A legacy Codex launch may have recorded a model without the newer
      // provenance flag, or no model at all. Preserve the recorded model as an
      // inherited choice; when it is absent, make the configured-default
      // authority explicit so psu never falls through to its native default.
      if (target.agent === 'codex') {
        resumeModelSource = target.modelSource ?? (target.model ? 'inherited' : 'configured-default');
      }
      // EI-21725123573114023: an IN-PLACE resume whose resolved target carries no
      // coord owner id is structurally unverifiable, and BOTH safety rails below
      // are keyed on that id — so they disengage silently rather than failing:
      //   1. the three-state resume verifier is gated on `resumeOwnerId`, so it is
      //      skipped outright and `resumeVerified` stays undefined; the tool then
      //      reports a plain "Launched" that attests nothing.
      //   2. `resolveResumeTarget` can only call findLiveHost() with an owner id,
      //      so `live` is ALWAYS false here — a still-live source is never
      //      auto-forked and two CLIs collide on one transcript (WI-3882).
      // Reporting success we cannot falsify is the exact failure this tool already
      // refuses everywhere else, so fail closed before anything spawns — the same
      // stance the successor path below takes on the same missing id. An EXPLICIT
      // fork is unaffected: it mints a fresh identity and its own transcript, and
      // is documented as unverifiable-by-design.
      if (!isSuccessor && !fork && !target.ownerId) {
        return err(
          `Cannot resume ${target.sessionId}: adv session #${target.advSessionId} records no coord owner id, so the ` +
            'resume cannot be verified and a still-LIVE source cannot be detected and auto-forked. No process was ' +
            'opened. Pass `fork: true` to branch onto a fresh identity, or launch a fresh agent instead.',
        );
      }
      sourceStillLive = target.live;
      let codexWriterHeld = false;
      // A wake-pump can reactivate a Codex session without a managed pty-host
      // row being visible to resolveResumeTarget yet. Codex's per-thread flock
      // is the same single-writer authority checked by psu immediately before
      // resume, so consult it for every retained-owner source launch, including
      // a fresh successor. Ordinary resume forks a live source; a successor
      // must refuse because it would retain that writer's active owner identity.
      const codexNativeHandle = !fork && target.agent === 'codex'
        ? nativeSessionHandleForAdvSession(
          {
            id: target.advSessionId,
            agent: 'codex',
            coordOwnerId: target.ownerId,
            sessionId: target.sessionId,
          } as Parameters<typeof nativeSessionHandleForAdvSession>[0],
          { findCodexRolloutId: () => null },
        )
        : null;
      const readSourceCodexWriter = () => codexNativeHandle?.backend === 'codex'
        ? codexThreadWriterHolder(codexNativeHandle.codexHome, target.sessionId)
        : null;
      {
        const writer = readSourceCodexWriter();
        if (args.originalRouting && (!writer || writer.held || !['free', 'no-lock-file'].includes(writer.reason))) {
          return err('originalRouting refused: original writer is live or unknown; no fork was created.');
        }
        if (writer) {
          codexWriterHeld = writer.held;
          if (writer.held) {
            sourceStillLive = true;
            notes.push(
              `⚠ Codex reports an active writer for ${target.sessionId ?? 'the latest thread'}; ` +
                'the source is treated as live and will be forked to avoid a second writer.',
            );
          }
        }
      }
      const prepareSuccessor = async (sourceKind: 'ended' | 'critical-dormant'): Promise<string | null> => {
        if (!target.ownerId) {
          return (
            `Cannot start successor for ${target.sessionId}: the ended source has no coord owner id to pre-pin. ` +
            'Use a fresh context-seeded launch instead; no process was opened.'
          );
        }
        if (sourceStillLive) {
          return (
            `Cannot start successor for ${target.ownerId}: the source session is still LIVE. ` +
            'A fresh process cannot safely retain an active owner identity; use ordinary resume, which forks live sources.'
          );
        }
        // A successor is a fresh context, so an explicit backend override is
        // supported. This is the recovery escape hatch when the predecessor's
        // provider/runtime or account is the reason it died. Without an explicit
        // override, preserve the recorded backend when it is supported.
        const sourceAgent =
          target.agent === 'claude' || target.agent === 'codex' || target.agent === 'omp' ? target.agent : null;
        if (target.agent && !sourceAgent && !args.agent) {
          return (
            `Cannot start successor for ${target.ownerId}: the ended source recorded unsupported agent ${target.agent}. ` +
            'Pass an explicit supported `agent` override, or launch a fresh agent.'
          );
        }
        if (args.agent && sourceAgent && args.agent !== sourceAgent) {
          notes.push(
            `✓ Successor backend override: requested ${args.agent} instead of the ended source backend ${sourceAgent}; the fresh context retains predecessor identity ${target.ownerId}.`,
          );
        }
        resumeAgent = args.agent ?? sourceAgent;
        args.agent ??= sourceAgent ?? undefined;
        args.cwd ??= target.cwd ?? undefined;
        notes.push(
          `✓ Fresh successor for ${sourceKind === 'critical-dormant' ? 'critical dormant source' : 'ended session'} ${target.sessionId} (${target.agent ?? 'agent'}) is pre-pinned to the original coord identity ${target.ownerId}; ` +
            'its durable carry/claims are reused.',
        );
        try {
          const { buildCarryBrief, renderCarryBriefText } = await import('../../carry-brief');
          const carry = await buildCarryBrief(target.ownerId, { workspaceId });
          const renderedCarry = renderCarryBriefText(carry);
          const rawBrief = [
            `Fresh successor recovery for ${sourceKind === 'critical-dormant' ? 'critical dormant source' : 'ended session'} ${target.sessionId}.`,
            `This is a NEW context retaining predecessor identity ${target.ownerId}; re-orient and verify live state before acting.`,
            args.brief?.trim() ? `Current recovery direction:\n${args.brief.trim()}` : null,
            renderedCarry
              ? `Predecessor carry/recovery brief:\n${renderedCarry}`
              : 'No carry brief was available; recover durable state with coord:orient { afterCompaction: true } and work_items:get before editing.',
          ]
            .filter((part): part is string => Boolean(part))
            .join('\n\n');
          successorBrief = capPreservingOperative(rawBrief, 8000, {
            more: 'coord:orient { afterCompaction: true }',
            inlineNotice: true,
          });
        } catch (e) {
          return (
            `Cannot start successor for ${target.ownerId}: failed to assemble its durable carry/recovery brief ` +
            `(${(e as Error)?.message ?? e}). No process was opened.`
          );
        }
        // EI-22446987530949437: do this only AFTER preflight and the launch
        // claim, immediately before spawn. A new launcher can refresh presence
        // and turn a dead predecessor into `recorded`, defeating bootstrap's
        // otherwise-correct fail-closed conflict guard. Reconcile the original
        // binding first, never an arbitrary row currently attached to the owner.
        successorPreparation.reconcile = async () => {
          const binding = target.binding;
          if (!binding || binding.coordOwnerId !== target.ownerId) {
            return 'Cannot start successor: the exact predecessor binding is unavailable. No process was opened.';
          }
          const current = await resolveResumeTarget({ agentId: binding.coordOwnerId });
          if (!current.ok || current.advSessionId !== target.advSessionId ||
              current.binding?.coordOwnerId !== binding.coordOwnerId ||
              current.binding?.sessionId !== binding.sessionId ||
              current.binding?.startedAt !== binding.startedAt ||
              current.workspaceId !== target.workspaceId ||
              current.harnessSlug !== target.harnessSlug ||
              (expectedSuccessorBinding && (
                current.ownerId !== expectedSuccessorBinding.ownerId ||
                current.advSessionId !== expectedSuccessorBinding.advSessionId ||
                current.workspaceId !== expectedSuccessorBinding.workspaceId ||
                current.harnessSlug !== expectedSuccessorBinding.harnessSlug
              ))) {
            return 'Cannot start successor: the predecessor binding changed during preparation. Re-resolve the source; no process was opened.';
          }
          if (current.live || (await findLiveHostAsync(binding.coordOwnerId))) {
            return 'Cannot start successor: a LIVE source host appeared during preparation. No process was opened.';
          }
          if (readSourceCodexWriter()?.held) {
            return 'Cannot start successor: an active native Codex writer appeared during preparation. No process was opened.';
          }
          if (current.endedAt != null) return null;
          if (!hasAdvSessionTerminalEvidence(current)) {
            const verdicts = await resolveSessionStates(
              [{ ownerId: binding.coordOwnerId }],
              { hydratePerId: true },
            );
            const state = verdicts.get(binding.coordOwnerId)?.sessionState;
            if (state !== 'ended' && !(state === 'suspect' && !expectedSuccessorBinding?.requirePositiveTerminalEvidence)) {
              return `Cannot start successor: predecessor liveness is ${state ?? 'unknown'}; positive terminal evidence is required. No process was opened.`;
            }
          }
          if (await findLiveHostAsync(binding.coordOwnerId)) {
            return 'Cannot start successor: a LIVE source host appeared during reconciliation. No process was opened.';
          }
          if (readSourceCodexWriter()?.held) {
            return 'Cannot start successor: an active native Codex writer appeared during reconciliation. No process was opened.';
          }
          const ended = await markAdvSessionEnded(target.advSessionId, null, 'reconciler', {
            expectedBinding: binding,
            throwOnError: true,
          });
          if (!ended) {
            return 'Cannot start successor: predecessor binding reconciliation lost its compare-and-swap. Re-resolve the source; no process was opened.';
          }
          notes.push(`✓ Reconciled terminal predecessor binding #${target.advSessionId} before successor launch; actual exit time remains unknown.`);
          return null;
        };
        return null;
      };
      if (isSuccessor) {
        const successorFailure = await prepareSuccessor('ended');
        if (successorFailure) return err(successorFailure);
      } else if (args.restoreVisible) {
        if (codexWriterHeld && !target.live) {
          return err(
            `Cannot restore ${target.sessionId}: Codex reports an active writer but no managed host is registered. ` +
              'Pass `fork: true` to branch safely, or retry after the writer exits; no process was opened.',
          );
        }
        if (!target.live || !target.ownerId) {
          sourceStillLive = false;
          notes.push(
            `ⓘ Visible restore requested for ${target.sessionId}, but no live managed host remains; ` +
              'continuing with an ordinary exact resume (nothing to terminate).',
          );
        } else {
          const host = await findLiveHostAsync(target.ownerId);
          if (!host) {
            // The host can disappear between resolveResumeTarget and this check.
            // That race is safe: there is no remaining CLI to collide with, so
            // continue as the ordinary exact resume instead of forcing a retry.
            sourceStillLive = false;
            notes.push(
              `ⓘ Visible restore requested for ${target.sessionId}, but its managed host disappeared during ` +
                'verification; continuing with an ordinary exact resume (nothing to terminate).',
            );
          } else {
            const windowVerdict = isPidInLiveWindowScope(host.pid, nodeCgroupFs);
            if (!restoreVisibleMayShutdown(windowVerdict)) {
              const recoveryHint =
                windowVerdict === 'not-a-window'
                  ? ' This host has no live desktop window; omit `restoreVisible` and retry an ordinary exact resume. That path reclaims only an explicitly agent-launched headless host with measured pty activity idle for at least 30 minutes; otherwise a still-live source is forked to avoid opening a second CLI on one transcript.'
                  : '';
              return err(
                `Cannot restore ${target.sessionId}: desktop-window verdict for ${target.ownerId} is ${windowVerdict}. ` +
                  'Only a positive dead-window witness permits shutdown; alive, unknown, and not-a-window all refuse. Nothing was terminated.' +
                  recoveryHint,
              );
            }
            const shutdown = await shutdownViaPty(target.ownerId, {
              force: true,
              reason: `guarded visible restore of exact native session ${target.sessionId}`,
            });
            if (shutdown !== 'sent') {
              return err(
                `Cannot restore ${target.sessionId}: the proven-windowless host refused or missed graceful shutdown (${shutdown}). ` +
                  'Nothing was killed and no replacement was launched.',
              );
            }
            if (!(await waitForPtyHostGone(target.ownerId))) {
              return err(
                `Cannot restore ${target.sessionId}: graceful shutdown was accepted but the old host did not disappear within 10s. ` +
                  'No replacement was launched, preventing two CLIs on one transcript.',
              );
            }
            sourceStillLive = false;
            notes.push(
              `✓ Guarded restore: kernel cgroup evidence proved ${target.ownerId}'s desktop window dead; ` +
                `its unattended agent-launched host shut down gracefully before exact UUID ${target.sessionId} was relaunched.`,
            );
          }
        }
      }
      if (!isSuccessor) {
        // Omission permits the normal protective auto-fork. Explicit false
        // requires the original identity/transcript, so reject a live source
        // before changing routes or reclaiming a stale headless host.
        if (args.fork === false) {
          const refusal = `Cannot resume ${target.resumeId ?? target.sessionId} in place: `;
          if (sourceStillLive) {
            return err(refusal + 'the source session is still LIVE. Explicit `fork:false` is fail-closed; omit `fork` to allow the normal protective auto-fork, or retry after the source ends.');
          }
          const custody = (current: typeof target) => JSON.stringify([
            current.ownerId, current.advSessionId, current.sessionId, current.resumeId, current.binding,
          ]);
          const sourceCustody = custody(target);
          recheckInPlaceResume = async () => {
            const current = await resolveResumeTarget({
              agentId: target.sessionId ? null : target.ownerId,
              sessionId: target.sessionId,
            });
            if (!current.ok || custody(current) !== sourceCustody) {
              throw new Error(refusal + 'source custody changed during preparation; no replacement was launched.');
            }
            if (current.live || await findLiveHostAsync(target.ownerId!)) {
              throw new Error(refusal + 'the source session became LIVE during preparation; no replacement was launched.');
            }
            const writer = readSourceCodexWriter();
            if (target.agent === 'codex' && (!writer || writer.held || !['free', 'no-lock-file'].includes(writer.reason))) {
              throw new Error(refusal + 'the Codex writer is live or unknown; no replacement was launched.');
            }
          };
          try { await recheckInPlaceResume(); } catch (error) {
            return err(error instanceof Error ? error.message : String(error));
          }
        }
        let staleHeadlessRecovery = false;
        if (sourceStillLive && !codexWriterHeld && !fork && !args.restoreVisible && target.ownerId) {
          const host = await findLiveHostAsync(target.ownerId);
          if (!host) {
            // The host can disappear between resolveResumeTarget and this check.
            // There is then no remaining CLI to collide with, so exact-resume.
            sourceStillLive = false;
          } else if (isStaleHeadlessAgentHost(host)) {
            // Keep the normal live-source fork until context pressure has passed;
            // only then take the narrow, guarded recovery action below.
            staleHeadlessRecovery = true;
          }
        }
        if (sourceStillLive && !fork && !staleHeadlessRecovery) {
          fork = true;
          notes.push(
            `⚠ ${target.ownerId ?? 'that session'} is still LIVE — resuming it in place would open a second CLI against one transcript (WI-3882), so it was FORKED instead. The fork has a FRESH identity; the original keeps running untouched.`,
          );
        }
        // P-015: `endedAt` is an END TIME only when the session reported its own exit.
        // Otherwise a sweeper stamped it on noticing the process was already gone, so
        // stating it as "ended <ts>" asserts something we do not know (WI-7126).
        const endedPhrase = describeSessionEndTime(target);
        const sourceActionNote = fork
          ? `Forking session ${target.sessionId} (${target.agent ?? 'agent'}, ${sourceStillLive ? 'live' : endedPhrase}) — the fork mints a NEW coord id; find it in coord:presence.`
          : `Resuming session ${target.sessionId} (${target.agent ?? 'agent'}, ${endedPhrase}) — it re-attaches its ORIGINAL identity ${target.ownerId ?? '(unknown)'}.`;
        let promotedToSuccessor = false;

        // EI-21007744826020808: a live source at the context cliff can technically
        // fork/resume, accept the kickoff injection, and then die before it can take
        // the turn. Kickoff delivery is transport evidence, not usable-context
        // evidence. Reuse the same fresh/staleness-aware pressure oracle the fleet
        // roster uses; a stale/unknown reading fails open, while a current CRITICAL
        // reading fails closed before we open a doomed process.
        // An exact native-session pin is a request to keep that transcript.
        // Pressure may require the CLI to compact, but it is not permission
        // to replace the conversation with a fresh successor (WI-10001085).
        if (target.ownerId && !((args.resume?.sessionId || args.fork === false) && !fork && !target.live)) {
          try {
            const pressure = (await fetchContextPressure([target.ownerId])).get(target.ownerId);
            if (pressure === 'critical') {
              // A dormant critical source cannot reliably take another turn, but
              // it is also safe to replace: no live CLI is attached to its
              // transcript. Promote this narrow case to the explicit fresh
              // successor path so the singleton coord identity and durable claim
              // survive without opening a duplicate live process. A resolved
              // LIVE source remains refused, even if its host disappears during
              // this call, because that liveness race is not proof of dormancy.
              if (!target.live) {
                const successorFailure = await prepareSuccessor('critical-dormant');
                if (successorFailure) return err(successorFailure);
                isResume = false;
                isSuccessor = true;
                fork = false;
                promotedToSuccessor = true;
                notes.push(
                  `⚠ ${target.ownerId} is DORMANT at CRITICAL context pressure; ordinary ${args.fork ? 'fork' : 'resume'} was promoted to a fresh identity-preserving successor so the original coord identity and durable claim are retained.`,
                );
              } else {
                return err(
                  `Cannot ${fork ? 'fork' : 'resume'} ${target.ownerId}: its current context is CRITICAL ` +
                    '(at or above 90% of its compaction limit). The resumed transcript may boot but cannot ' +
                    'reliably take another turn. Compact/recover that source first, or launch a FRESH agent ' +
                    'with a context-seeded brief.',
                );
              }
            } else if (pressure === 'high') {
              notes.push(
                `⚠ ${target.ownerId} is already at HIGH context pressure (≥80%); the ${fork ? 'fork' : 'resume'} may need to compact before doing useful work.`,
              );
            }
          } catch (e) {
            notes.push(
              `resume-context preflight unavailable (${(e as Error)?.message ?? e}) — proceeding without a context verdict`,
            );
          }
        }
        if (!promotedToSuccessor) notes.push(sourceActionNote);
        if (staleHeadlessRecovery) {
          const shutdown = await shutdownViaPty(target.ownerId!, {
            force: true,
            reason: `guarded stale-headless recovery of exact native session ${target.sessionId}`,
          });
          if (shutdown !== 'sent') {
            return err(
              `Cannot recover ${target.sessionId}: the stale headless host refused or missed guarded shutdown (${shutdown}). ` +
                'Nothing was killed and no replacement was launched.',
            );
          }
          if (!(await waitForPtyHostGone(target.ownerId!))) {
            return err(
              `Cannot recover ${target.sessionId}: guarded shutdown was accepted but the stale headless host did not disappear within 10s. ` +
                'No replacement was launched, preventing two CLIs on one transcript.',
            );
          }
          sourceStillLive = false;
          notes.push(
            `✓ Guarded stale-headless recovery: ${target.ownerId} had explicit agent provenance and no measured pty activity for at least 30 minutes; ` +
              `its host shut down before exact UUID ${target.sessionId} was relaunched in place.`,
          );
        }
      }
    }

    // Every capability fork pre-pins a managed identity. Check the launcher's
    // actual tracked-fork capability before reservation or terminal allocation,
    // rather than opening a child that must refuse before registering.
    if (isResume && fork && !supportsTrackedFork({
      agent: resumeAgent,
      sessionId: resumeSessionId,
      coordOwnerId: resumeOwnerId,
      id: resumeSourceAdvSessionId,
    })) {
      return err(
        `Cannot launch a managed fork of ${resumeId ?? 'that session'}: tracked fork is unavailable for this ` +
          `${resumeAgent ?? 'unknown'} source. It currently requires a Claude source with a native session id, ` +
          'coord owner and tracked session row. No process was admitted or opened. ' +
          'Resume in place with `fork:false` only after the source and its writer have ended, ' +
          'or launch a fresh agent with a context-seeded brief.',
      );
    }

    // A same-owner resume must preserve the target session's loop lifecycle. The
    // fleet profile is the right source for a fresh replacement, but it can be
    // stale for an in-place resume when the target loop was retuned independently
    // (for example, a cold loop in a fleet whose saved launch profile is warm).
    // Forks mint a new identity and successors/respawns are fresh processes, so
    // they intentionally keep the fleet/profile carry resolved below.
    if (isResume && !fork && resumeOwnerId) {
      try {
        const targetLoop = await getLoopStatus(resumeOwnerId);
        if (targetLoop) {
          savedLaunchCarry = targetLoop.carry;
          notes.push(
            `✓ Applied target loop carry '${targetLoop.carry}' to the same-owner resume; it overrides the saved fleet launch carry.`,
          );
        }
      } catch (e) {
        notes.push(
          `⚠ Could not read the resumed target's loop carry (${(e as Error)?.message ?? e}); preserving the saved fleet launch carry.`,
        );
      }
    }

    // Fleet: explicit name wins. For a resume/fork with no explicit fleet, preserve
    // the target's durable membership from fleet_membership_events: its presence row
    // may already have been reaped, and the caller's fleet is unrelated. Only a FRESH
    // launch inherits the caller's presence fleet (WI-4234). Colour + membership come
    // from the SAME slug, so they can never diverge.
    let fleetSlug: string | null = args.fleet ? fleetSlugFromName(args.fleet) : null;
    let scheme: ColorScheme | null = null;
    if (fleetSlug) {
      // An explicit fleet is also a supported way to create a fresh fleet. Ensure
      // its durable registry row exists before any scheme/profile read: those
      // readers intentionally return null for an unknown slug, which previously
      // let this launch proceed with a fleet argument that had never been
      // registered. createFleetIfAbsent is idempotent, so existing fleets keep
      // their authoritative owner/leader and only a first insert uses the caller
      // as the fleet owner and initial leader.
      try {
        await createFleetIfAbsent({
          workspaceId,
          fleetSlug,
          title: args.fleet?.trim() || fleetSlug,
          owner: callerOwnerId,
          leaderOwnerId: callerOwnerId,
        });
      } catch (e) {
        return err(
          `Could not ensure fleet \`${fleetSlug}\` exists: ${(e as Error)?.message ?? e}. ` +
            'No agent was spawned.',
        );
      }
      try {
        scheme = await getFleetScheme(workspaceId, fleetSlug);
      } catch {
        scheme = null;
      }
    } else if (sourceAction) {
      if (resumeOwnerId) {
        try {
          const membership = await latestFleetMembership(workspaceId, resumeOwnerId);
          if (membership?.fleetSlug) {
            fleetSlug = membership.fleetSlug;
            scheme = await getFleetScheme(workspaceId, membership.fleetSlug);
          }
        } catch (e) {
          // Do not fall back to the caller's fleet on a resume: that would attach
          // the target to an unrelated claim spec. Launch unfleeted and make the
          // degraded membership lookup visible in the result instead.
          notes.push(
            `⚠ Could not resolve the resumed target's durable fleet membership (${(e as Error)?.message ?? e}); launching unfleeted rather than inheriting the caller's fleet.`,
          );
        }
      }
    } else if (!args.independent && !args.goalVerifier && callerOwnerId) {
      try {
        const membership = (await fetchPresenceFleet([callerOwnerId])).get(callerOwnerId);
        if (membership?.fleetSlug) {
          fleetSlug = membership.fleetSlug;
          scheme = await getFleetScheme(workspaceId, membership.fleetSlug);
        }
      } catch {
        scheme = null;
      }
    }

    // D-008 (WI-40321): a fleet respawn must consume the same durable launch
    // profile as fleet:launch-on-plan and the headcount governor. Resume keeps
    // its transcript/backend identity, but omitted placement/routing flags still
    // come from the fleet profile so a dead visible member returns headlessly
    // when that is the fleet's recorded shape.
    type AppliedHeadcountProfile = Omit<NonNullable<Awaited<ReturnType<typeof getFleetHeadcountTarget>>>, 'config'> & {
      config: SavedFleetLaunchConfig;
    };
    let persistedHeadcountProfile: AppliedHeadcountProfile | null = null;
    let savedLaunchSpecMeta: {
      provenance: SavedFleetLaunchSpecProvenance;
      reusePath: string;
    } | null = null;
    if (fleetSlug) {
      if (sourceAction) {
        const requestedExtraArgs = args.extraArgs;
        const { profileArgs, modeArgs } = splitSavedProfileExtraArgs(requestedExtraArgs);
        // A mode-only array is an explicit launch-posture request, not an
        // explicit replacement for the fleet's saved profile. An empty array
        // remains a real profile override and therefore still fails closed
        // against a non-empty canonical profile.
        const requestedProfileExtraArgs =
          requestedExtraArgs !== undefined && (requestedExtraArgs.length === 0 || profileArgs.length > 0)
            ? profileArgs
            : undefined;
        const savedLaunchSpec = await resolveSavedFleetLaunchSpec({
          workspaceId,
          fleetSlug,
          // A guarded desktop restoration may explicitly restore the original
          // session's placement/model after the fleet defaults have changed.
          // This is a per-launch delta; the fleet profile remains canonical.
          allowDeltas: args.restoreVisible ? ['headless', 'model'] : undefined,
          requested: {
            account: args.account,
            model: args.model,
            headless: args.headless,
            extraArgs: requestedProfileExtraArgs,
          },
          ...(leaderRecoveryOwnerId ? {
            memberOwnerId: leaderRecoveryOwnerId,
            preferMemberRecord: true,
          } : {}),
          reusePath: leaderRecoveryOwnerId
            ? 'fleet leader recovery -> capability:launch-agent resume -> agent-launch-core.buildAgentLaunchCommand'
            : 'capability:launch-agent resume/successor -> agent-launch-core.buildAgentLaunchCommand',
        });
        if (!savedLaunchSpec.ok) return err(savedLaunchSpec.message);
        if (savedLaunchSpec.found) {
          persistedHeadcountProfile = {
            workspaceId,
            fleetSlug,
            target: savedLaunchSpec.target,
            enabled: true,
            config: savedLaunchSpec.config,
            nextAttemptAt: null,
            backoffMs: 0,
            lastError: null,
          };
          args.headless ??= savedLaunchSpec.effective.member.headless;
          args.account ??= savedLaunchSpec.effective.member.account;
          args.model ??= composeModelSpec(
            savedLaunchSpec.effective.member.model,
            savedLaunchSpec.effective.member.effort,
          );
          if (requestedExtraArgs === undefined) {
            args.extraArgs ??= savedLaunchSpec.effective.member.extraArgs;
          } else if (requestedExtraArgs.length > 0 && profileArgs.length === 0) {
            // Mode-only requests inherit the canonical profile while retaining
            // the explicit posture flags in the actual resume/fork command.
            args.extraArgs = [...(savedLaunchSpec.effective.member.extraArgs ?? []), ...modeArgs];
          }
          savedLaunchCarry ??= savedLaunchSpec.effective.member.carry;
          savedLaunchSpecMeta = {
            provenance: savedLaunchSpec.provenance,
            reusePath: savedLaunchSpec.reusePath,
          };
          notes.push(
            `✓ Applied canonical saved fleet launch spec from ${savedLaunchSpec.provenance.source} ` +
              `(target ${savedLaunchSpec.target}, ${args.headless ? 'headless' : 'visible'}, ` +
              `reuse ${savedLaunchSpec.reusePath}).`,
          );
        }
      } else {
        // P-044 is deliberately resume-only here: a FRESH launch retains its
        // existing behavior while the fleet-specific top-up door owns strict
        // conflict policy. The shared resolver does not change fresh launches.
        try {
          persistedHeadcountProfile = await getFleetHeadcountTarget(workspaceId, fleetSlug);
        } catch (e) {
          return err(
            `Could not read the persisted launch profile for fleet \`${fleetSlug}\`: ${(e as Error)?.message ?? e}. ` +
              'Refusing to reconstruct member settings ad hoc.',
          );
        }
        if (persistedHeadcountProfile) {
          const profile = persistedHeadcountProfile.config;
          args.agent ??= profile.agent;
          args.headless ??= profile.headless ?? true;
          args.account ??= profile.account;
          args.model ??= composeModelSpec(profile.model, profile.effort);
          args.carry ??= profile.carry;
          args.extraArgs ??= profile.extraArgs;
          notes.push(
            `✓ Applied persisted fleet launch profile from fleet:headcount-target ` +
              `(target ${persistedHeadcountProfile.target}, ${args.headless ? 'headless' : 'visible'}).`,
          );
        }
      }
    }

    let base;
    try {
      const spawnHostOperatorBaseUrl = resolveOperatorBaseUrl();
      base = await buildConsoleEnvelope({
        workspaceId,
        slug,
        operatorBaseUrl: spawnHostOperatorBaseUrl,
        ...(args.mcpTarget === 'spawn-host' ? { agentMcpBaseUrl: spawnHostOperatorBaseUrl } : {}),
        // A launched AGENT is an MCP-connected console (unlike capability:terminal,
        // which just runs a command) — it needs the superuser .mcp.json.
        skipMcpJson: false,
      });
    } catch (e) {
      return err(`Failed to prepare the launch: ${(e as Error)?.message ?? e}`);
    }

    const cwd = args.cwd ? (isAbsolute(args.cwd) ? args.cwd : resolvePath(base.cwd, args.cwd)) : base.cwd;
    if (args.originalRouting) {
      if (args.account && args.account !== resumeAccount)
        return err('originalRouting refused: saved fleet account differs from original account.');
      if (args.model && args.model !== resumeModel)
        return err('originalRouting refused: saved fleet model differs from original model.');
      // Codex reads the original transcript model/effort, not an explicit saved-fleet override.
      args.model = undefined;
    }

    // ── Per-member launch composition (P-002) ──────────────────────────────────
    // A FRESH multi-launch folds `members[i]` over the flat top-level args, so agent i
    // can differ in model/effort/account/limit/role/context/brief/…; a shorter (or
    // absent) `members` falls each remaining agent back to the flat args — the common
    // case is one identical command for all `count`. A resume/fork is a single session,
    // so `members` never applies (rejected above): every clone shares one command.
    // ── Per-goal launch settings + ceilings (P-004/D-009) ─────────────────────
    // Resolved from the CALLER, not from an argument: if this agent is working
    // under a goal (running it, or having inherited it — D-008), its spawns
    // belong to that goal and are bound by the goal's ceilings. `count` is passed
    // whole so an over-large batch is refused once here rather than part-way
    // through, leaving half a fleet running against a breached ceiling.
    const retainedOwnerId = isSuccessor || (isResume && !fork) ? resumeOwnerId : null;
    // Forks also carry the reviewer's transcript and get the caller's launch edge.
    // Screen the source identity for both retaining and forked recovery, before
    // writing an edge that would put the reviewer under its plan's implementer.
    const reviewerSourceOwnerId = isSuccessor || isResume ? resumeOwnerId : null;
    if (reviewerSourceOwnerId && callerOwnerId) {
      const guard = await import('../../acceptance-reviewer-relaunch-guard');
      let conflict: Awaited<ReturnType<typeof guard.findReviewerRelaunchConflict>>;
      try {
        conflict = await guard.findReviewerRelaunchConflict({
          workspaceId,
          launcherOwnerId: callerOwnerId,
          retainedOwnerId: reviewerSourceOwnerId,
        });
      } catch (e) {
        return err(
          `reviewer_relaunch_independence_unreadable: could not verify that relaunching ${reviewerSourceOwnerId} keeps ` +
            `acceptance review independent of ${callerOwnerId} (${e instanceof Error ? e.message : String(e)}). ` +
            'Retry once the database is readable (EI-25876555362728602).',
        );
      }
      if (conflict) return err(guard.renderReviewerRelaunchRefusal(conflict));
    }
    const goalExcludedOwnerIds = [...new Set([
      ...(respawnReplacesOwnerId ? [respawnReplacesOwnerId] : []),
      ...(retainedOwnerId ? [retainedOwnerId] : []),
    ])];
    const goalLaunch = await resolveGoalLaunch({
      workspaceId,
      launcherOwnerId: callerOwnerId ?? '',
      // No slot at the BATCH level — this tool has no top-level launch slot, and
      // the ceilings do not depend on one (D-016).
      goalRole: args.goalVerifier === 'grade' ? 'grading' : args.goalVerifier === 'test' ? 'test' : null,
      fleetSlug,
      count,
      ...(goalExcludedOwnerIds.length ? { excludeOwnerIds: goalExcludedOwnerIds } : {}),
      requested: {
        ...(args.agent ? { agent: args.agent as 'claude' | 'codex' | 'omp' } : {}),
        ...(args.account ? { account: args.account } : {}),
        ...(args.model ? { model: args.model } : {}),
      },
    });
    if (goalLaunch.refusal) {
      // P-005 / R-5: a refused goal launch must not strand the goal-created work it
      // was for. Stamp every open, unassigned item of this goal the launch named so
      // the holder's stranded-goal-work agenda shows it at once. Best-effort: the
      // refusal is returned either way.
      let strandNote = '';
      if (goalLaunch.goalId) {
        const stranded = await import('../../goal-stranded-work');
        const record = await stranded
          .recordGoalPlacementRefusal({
            workspaceId,
            goalId: goalLaunch.goalId,
            launcherOwnerId: callerOwnerId ?? '',
            reason: goalLaunch.refusal.reason,
            message: goalLaunch.refusal.message,
            source: 'capability:launch-agent',
            named: stranded.launchNamedWorkItemIds({ feature: args.feature, workItem: args.workItem, brief: args.brief }),
          })
          .catch((e: unknown) => ({ named: [] as string[], marked: [] as string[], error: e instanceof Error ? e.message : String(e) }));
        strandNote = stranded.goalPlacementRefusalNote(record);
      }
      return err(goalLaunch.refusal.message + strandNote);
    }

    const memberSpecs: (MemberSpec | undefined)[] = args.members ?? [];
    const flatBase: FleetMemberDefaults = {
      // The goal's effective profile is the BASE; an explicit per-member spec
      // still wins via foldMemberSpec below, which is the intended order —
      // settings are the goal's standing policy, not an override of a choice the
      // caller just made for one member.
      agent: isSuccessor && resumeAgent ? resumeAgent : (goalLaunch.effective.agent ?? args.agent ?? 'claude'),
      account: goalLaunch.effective.account ?? args.account ?? undefined,
      model: goalLaunch.effective.model ?? args.model ?? (isSuccessor && resumeAgent === 'codex' ? resumeModel ?? undefined : undefined),
      modelSource: isSuccessor && resumeAgent === 'codex'
        ? (goalLaunch.effective.model || args.model ? 'explicit' : resumeModelSource ?? undefined)
        : undefined,
      effort: goalLaunch.effective.effort ?? args.effort ?? undefined,
      contextSize: goalLaunch.effective.contextSize ?? persistedHeadcountProfile?.config.contextSize ?? undefined,
      compactionLimit: persistedHeadcountProfile?.config.compactionLimit,
      // P-003: `headless` was the ONE knob in this block that ignored the goal
      // while every sibling above inherited it, so a goal pinning a headed
      // launch was silently overridden back to headless here.
      //
      // The args leg keeps its `|| undefined` rather than becoming `??`: an
      // explicit `args.headless === false` has always collapsed to `undefined`,
      // and both spell "visible", so preserving it keeps this change purely
      // additive on a launch path the whole fleet shares. A goal that pins
      // `false` DOES pass `false` through — that is the new capability.
      headless: goalLaunch.effective.headless ?? (args.headless || undefined),
      // An explicit flat role is the caller's persona choice and must win over
      // any persisted fleet profile. This mirrors member > fleet precedence:
      // a saved role is only a fallback when the caller omitted the field.
      // A fresh successor retains the predecessor's persona by default. The
      // caller's explicit role still wins; a null source role stays generic SU
      // instead of inheriting an unrelated saved headcount profile.
      role: isSuccessor
        ? (args.role ?? resumeRole ?? undefined)
        : (args.role ?? persistedHeadcountProfile?.config.role),
      feature: isSuccessor
        ? (args.feature ?? resumeFeature ?? undefined)
        : (sourceAction ? undefined : args.feature ?? undefined),
      stack: args.stack ?? undefined,
      // A flat carry setting applies to every fresh member unless that member
      // supplies its own override in `members[i].carry`.
      carry: goalLaunch.effective.carry ?? args.carry ?? undefined,
      launchContext: persistedHeadcountProfile?.config.launchContext,
      extraArgs: args.extraArgs ?? undefined,
    };
    const foldedConfigs: FleetMemberDefaults[] = Array.from({ length: count }, (_v, i) => {
      // A successor is a fresh process even though it has a source identity.
      // Apply the same Codex model policy as an ordinary fresh launch; otherwise
      // a model-less predecessor reaches the command builder and cannot wake.
      if (sourceAction && !isSuccessor) return flatBase;
      // D-016 (WI-38048): this used to fold `settings.roles[memberSpecs[i].role]`
      // — i.e. it looked the goal's launch profiles up by psu `--role`. That is
      // the defect, not a feature that was lost here: a launch SLOT is a function
      // (plan-fleet-member, grading, …) while `--role` is a persona, and persona
      // is `su` for ~all sessions, so the lookup matched nothing while making the
      // panel read as configured. This generic door is handed psu roles and no
      // slot, so it folds NO role layer — absent beats wrong.
      //
      // Slot binding is not lost, it moved to the door that KNOWS its slot:
      // fleet_registry/launch-on-plan resolves with `goalRole:'plan-fleet-member'`
      // and passes the folded profile down as fleetDefaults, and goals/start
      // resolves with `goalRole:'goal'`. If a caller ever needs per-member slot
      // pinning here, add an explicit `goalRole` to MemberSpec — do NOT reinstate
      // the `--role` lookup.
      const folded = foldMemberSpec(flatBase, memberSpecs[i]);
      if (folded.agent !== 'codex') return folded;
      // One policy owns both the omitted-model default and the Spark deny. Do
      // this before any terminal/PTY is opened so a bad member cannot partially
      // launch a batch and leave an untracked process behind.
      const selection = resolveCodexModelSelection(folded.model, {
        source: folded.modelSource ?? (folded.model ? 'explicit' : 'configured-default'),
      });
      return { ...folded, model: selection.model, modelSource: selection.source };
    });
    if (gradingAuditTaskDetail !== undefined) {
      if (!isGradingAuditTaskDetail(gradingAuditTaskDetail)) {
        return err('Internal grading-audit task metadata is malformed; no process was spawned.');
      }
      if (sourceAction || count !== 1 || foldedConfigs[0]?.headless !== true) {
        return err('Grading-audit task metadata requires one fresh headless launch; no process was spawned.');
      }
    }
    if (scopedGateway && (foldedConfigs.length !== 1 || foldedConfigs.some(config => config.agent !== 'codex'))) {
      return err('Scoped inference gateway requires the supported Codex transport.');
    }
    // A workItem grants launch scope but does not bind a worker identity. When
    // the requested role is the accepted operation's worker role, require the
    // same target as --feature before any terminal is opened. Generic audit
    // launches against ordinary work items, and accepted items for other roles,
    // continue through the generic launch path.
    if ((!isResume || isSuccessor) && args.workItem?.trim() && slug) {
      const roles = [...new Set(
        foldedConfigs.map((config) => config.role?.trim()).filter((role): role is string => !!role),
      )];
      if (roles.length) {
        try {
          const { resolveAcceptedOperationWorkerBinding } =
            await import('../../blueprint/operation-worker-binding');
          for (const role of roles) {
            const binding = await resolveAcceptedOperationWorkerBinding({
              workspaceId,
              harnessSlug: slug,
              workItemId: args.workItem.trim(),
              role,
              roleMismatch: 'ignore',
              repoDir: args.cwd?.trim() || papercuspPathForWorkspace(workspaceId),
            });
            if (!binding) continue;
            const unboundConfig = foldedConfigs.find((config) =>
              config.role?.trim() === role && config.feature?.trim() !== binding.workItemId);
            if (unboundConfig) {
              return err(
                'Accepted blueprint operation worker role "' + role + '" for ' + binding.workItemId +
                  ' requires feature to exactly match workItem. Pass feature: "' +
                  binding.workItemId + '". No process was spawned.',
              );
            }
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return err(
            'Could not verify accepted operation worker binding before launch: ' +
              detail + '. No process was spawned.',
          );
        }
      }
    }
    // The psu bootstrap rejects malformed stack refs, but that is too late:
    // admission and a child process have already been consumed by then. Check
    // every effective member (including overrides) before claiming the launch.
    if (!sourceAction || isSuccessor) {
      for (const [i, config] of foldedConfigs.entries()) {
        for (const ref of config.stack ?? []) {
          if (!parseBindingRef(ref)) {
            return err(
              `Invalid stack binding for member ${i + 1}: ${JSON.stringify(ref)} ` +
                '(expected "<slot>:<id>", e.g. "domain:papercusp-engineer").',
            );
          }
        }
      }
    }
    // Pre-pin every ordinary fresh member before opening its process. The
    // bootstrap can then register the session under the same owner that the
    // launcher, admission metadata, and launch verifier already know. A
    // respawn supplies its durable replacement identity; successors and
    // in-place resumes retain the source identity; each fork gets a fresh pin
    // through the shared command builder so its reservation and bootstrap agree.
    const memberOwnerIds: Array<string | null> = Array.from({ length: count }, (_v, i) => {
      if (isSuccessor || (isResume && !fork)) return resumeOwnerId;
      if (i === 0 && respawnOwnerId) return respawnOwnerId;
      return `su-${randomUUID()}`;
    });
    // Installed whenever the host declared one, not only beside a scoped gateway. Until
    // WI-6554700010008492 a confinement passed without a gateway was silently dropped.
    if (privateConfinement) {
      try {
        const { declareSessionConfinement } = await import('../../capability-envelope/session-confinement-store');
        for (const ownerId of memberOwnerIds) {
          if (!ownerId) return err('Scoped native launch has no pinned confinement identity.');
          const receipt = await declareSessionConfinement({ ownerId, workspaceId,
            confinement: privateConfinement! });
          if (!receipt.ok) return err(`Scoped native tool confinement refused: ${receipt.reason}`);
        }
      } catch {
        return err('Scoped native tool confinement could not be durably installed; no process started.');
      }
    }
    if (!isResume) {
      const roleFailure = unresolvedAgentRole({
        harness: slug,
        projectDir: base.cwd,
        configs: foldedConfigs,
      });
      if (roleFailure) return err(roleFailure);
    }
    // ── P-002: preflight the backend in the env the WINDOW will receive ───────
    //
    // Not the operator's env — that is the whole trap. A probe run from here
    // (process.env.PATH, a `which`, a capability:bash call) inherits the
    // OPERATOR's environment, which is precisely the environment that does NOT
    // have the defect; it reports green while the window dies. preflightBackendLaunch
    // searches ONLY the dirs we inject, so a pass means the window works no matter
    // what PATH it inherits, and a fail aborts HERE with a diagnosis instead of
    // opening a doomed terminal that reports "Launched".
    //
    // Fresh launches only: a resume/fork runs under the CLI its session was
    // recorded on, which this call does not choose.
    // WI-6554700010011633: the session's own model and provider are chosen HERE, after alias
    // resolution and saved-profile inheritance — not at a tool dispatch the kernel seat sees.
    // Judge every launch (fresh, successor, resume) against the workspace's inherited policy
    // before any terminal opens; a resume onto a now-forbidden model is refused too.
    {
      const { judgeLaunchGovernance } = await import('../../governance-policy/session-governance');
      const refusal = await judgeLaunchGovernance(
        workspaceId,
        foldedConfigs.map((folded) => ({ agent: folded.agent ?? 'claude', model: folded.model })),
      );
      if (refusal) return err(refusal);
    }

    if (!isResume) {
      const preflighted = new Set<string>();
      for (const folded of foldedConfigs) {
        const agentName = folded.agent ?? 'claude';
        if (preflighted.has(agentName)) continue;
        preflighted.add(agentName);
        const pre = preflightBackendLaunch(agentName, base.env);
        if (!pre.ok) return err(pre.diagnosis);
      }
    }

    // EI-20362893066852316: capability:launch-agent is the flexible sibling of
    // fleet:launch-on-plan, so it must protect ad-hoc Codex launches with the
    // same model preflight. Run it before constructing/spawning any terminal;
    // only a definitive backend model refusal blocks, while auth, capacity,
    // transport, and unknown responses remain fail-open diagnostics.
    if (!isResume && foldedConfigs.some((folded) => folded.agent === 'codex' && folded.model?.trim())) {
      try {
        const [{ parseBridgeModel }, { preflightCodexModel, resolveCodexPreflightHome }] = await Promise.all([
          import('../../inference-gateway/codex-cli-bridge'),
          import('../../inference-gateway/codex-oauth-proxy'),
        ]);
        const preflighted = new Set<string>();
        for (const folded of foldedConfigs) {
          if (folded.agent !== 'codex' || !folded.model?.trim()) continue;
          const account = folded.account?.trim() || undefined;
          const key = `${account ?? 'default'}\u0000${folded.model.trim()}`;
          if (preflighted.has(key)) continue;
          preflighted.add(key);
          const home = await resolveCodexPreflightHome(account, workspaceId);
          if (!home) continue;
          const bareModel = parseBridgeModel(folded.model).id;
          const pf = await preflightCodexModel(home, bareModel);
          if (pf.verdict === 'refused') {
            return err(
              `Codex model preflight REFUSED '${bareModel}' on account '${account ?? 'default'}' — the ChatGPT backend answered: ${pf.detail} ` +
                `NO terminals were opened (a launch on this model would fail every turn). Working ids on this subscription are family-suffixed ` +
                `(e.g. gpt-5.6-sol, gpt-5.6-terra); verify one with a 1-turn probe: codex exec -m <id> 'Reply OK'.`,
            );
          }
          if (pf.verdict === 'unknown') {
            notes.push(`codex model preflight inconclusive (${pf.detail}) — proceeding fail-open`);
          }
        }
      } catch (e) {
        notes.push(`codex model preflight errored (${(e as Error).message}) — proceeding fail-open`);
      }
    }

    const memberCommands: string[] = [];
    for (let i = 0; i < count; i++) {
      const folded = foldedConfigs[i];
      let cmd: string;
      try {
        cmd = isResume
          ? buildAgentLaunchCommand({
              mode: fork ? 'fork' : 'resume',
              ...(fork ? { ownerId: memberOwnerIds[i] } : {}),
              sessionId: resumeSessionId,
              resumeId,
              // A same-session resume/fork keeps the source's account route
              // unless the caller deliberately requests another one. Without
              // this, `--account=auto` sessions silently restart on `default`.
              account: args.account ?? resumeAccount,
              fleetRole: leaderRecoveryOwnerId ? 'leader' : undefined,
              // Resume/fork does not pass --agent, but the command builder
              // still needs the recorded backend to apply Codex's model
              // policy. A Codex source may have changed model OR reasoning
              // effort inside its live TUI after launch. Do not pass the stale
              // launch argv back as an explicit --model: psu's native resume
              // reader selects the latest turn_context model:effort, falling
              // back to recorded launch metadata only if no transcript exists.
              agent: resumeAgent,
              targetAgent: args.agent ?? null,
              model: args.model ?? (resumeAgent === 'codex' ? null : resumeModel),
              modelSource: args.model ? 'explicit' : (resumeAgent === 'codex' ? null : resumeModelSource),
              headless: !!args.headless,
              carry: savedLaunchCarry ?? null,
              launchMode: args.originalRouting ? null : launchMode,
              extraArgs: args.extraArgs ?? null,
            })
          : buildAgentLaunchCommand({
              mode: 'fresh',
              agent: (isSuccessor ? resumeAgent : folded.agent) ?? null,
              ownerId: memberOwnerIds[i],
              plan: args.plan ?? null,
              // ALWAYS harness-scope a fresh launch, plan or not (caught by the P-016
              // live-verify): `--harness` is what makes psu bootstrap a papercusp-su
              // collaborator. Without it psu boots a PLAIN claude, skips the su bootstrap,
              // runs its first-run onboarding, never reaches a prompt, and the brief can
              // never be delivered — the agent is dead on arrival.
              harness: slug,
              account: folded.account ?? null,
              model: folded.model ?? null,
              modelSource: folded.modelSource ?? null,
              effort: folded.effort ?? null,
              headless: !!folded.headless,
              carry: folded.carry ?? null,
              contextSize: folded.contextSize ?? null,
              compactionLimit: folded.compactionLimit ?? null,
              role: folded.role ?? null,
              stack: folded.stack ?? null,
              feature: folded.feature ?? null,
              profile: folded.profile ?? null,
              brain: folded.brain,
              allowSubagents: folded.allowSubagents,
              addDir: folded.addDir ?? null,
              launchContext: folded.launchContext ?? null,
              // Fresh fleet members receive mode participation, not the launching
              // leader's personal mission or sticky owner-directed authority.
              launchMode: fleetSlug && !isSuccessor
                ? normalizeLaunchMode(launchMode, { fleetRole: leaderRecoveryOwnerId ? 'leader' : 'member' })
                : launchMode,
              extraArgs: folded.extraArgs ?? null,
            });
      } catch (e) {
        return err(
          count > 1
            ? `Cannot build agent ${i + 1}'s launch command: ${(e as Error)?.message ?? e}`
            : `Cannot build the launch command: ${(e as Error)?.message ?? e}`,
        );
      }
      // The same injectors capability:terminal uses — fleet membership + who launched me.
      cmd = injectFleetArg(cmd, fleetSlug).command;
      cmd = injectLaunchedByArg(cmd, callerOwnerId).command;
      memberCommands.push(cmd);
    }
    // Back-compat: `command` (singular) is the representative reported/recorded command
    // — identical across members in the common no-`members` case.
    const command = memberCommands[0] ?? '';
    // Use the same final model/effort pair that composed each command. A flat
    // preflight resolution can differ after member or goal settings are folded.
    const memberModelResolutions = isResume ? [] : foldedConfigs.map((config, i) => {
      const model = composeModelSpec(config.model, config.effort);
      if (!model) return null;
      const requested = memberAliasResolutions[i] ?? modelResolution;
      return {
        requested: requested?.requested ?? model,
        agent: config.agent ?? null,
        model,
        effort: (model.match(/:(low|medium|high|xhigh|max)$/i)?.[1] ?? null) as ReturnType<typeof resolveLaunchModelAlias>['effort'],
        alias: requested?.alias ?? null,
      };
    });
    const firstModelResolution = memberModelResolutions[0] ?? null;
    const effectiveModelResolution = isResume ? modelResolution : memberModelResolutions.every(resolved =>
      resolved?.model === firstModelResolution?.model && resolved?.agent === firstModelResolution?.agent &&
      resolved?.effort === firstModelResolution?.effort) ? firstModelResolution : null;

    // P-014: claim the launch only after all validation, target/profile resolution,
    // backend/model preflight, and command composition have succeeded. A refused
    // preflight must leave the key reusable so a corrected retry can launch; the
    // claim still lands immediately before the first spawn, preventing duplicate
    // windows for re-fired calls. (No key ⇒ unguarded, exactly like cup:spawn.)
    const claim = await claimAgentLaunch({
      workspaceId,
      idempotencyKey: args.idempotencyKey,
      launchedBy: callerOwnerId,
    });
    if (!claim.won) {
      const prior = claim.priorSummary && Object.keys(claim.priorSummary).length ? claim.priorSummary : null;
      const priorLaunch =
        prior && typeof prior.launch === 'object' && prior.launch !== null
          ? (prior.launch as Record<string, unknown>)
          : prior;
      const when = claim.priorLaunchedAt ? new Date(claim.priorLaunchedAt).toISOString() : 'earlier';
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Already launched (deduped) — idempotencyKey ${JSON.stringify(args.idempotencyKey)} was claimed at ${when}` +
              `${claim.priorLaunchedBy ? ` by ${claim.priorLaunchedBy}` : ''}. Nothing new was spawned.\n` +
              (prior
                ? `That call reported: ${JSON.stringify(prior)}`
                : 'No summary was recorded for that call — check /adv/sessions for what it opened.'),
          },
        ],
        data: {
          deduped: true,
          launch: priorLaunch
            ? { ...priorLaunch, deduped: true }
            : { deduped: true, opened: 0, failed: 0, mode: 'deduped', fleet: null, tasks: [] },
          ...(agentLaunchCompletionReceipt(args.idempotencyKey, prior !== null)
            ? { completionReceipt: agentLaunchCompletionReceipt(args.idempotencyKey, prior !== null) }
            : {}),
        },
      };
    }

    if (successorPreparation.reconcile) {
      let failure: string | null;
      try {
        failure = await successorPreparation.reconcile();
      } catch (e) {
        failure = `Cannot start successor: predecessor reconciliation failed (${(e as Error)?.message ?? e}). No process was opened.`;
      }
      if (failure) {
        await releaseAgentLaunchClaim({ workspaceId, idempotencyKey: args.idempotencyKey });
        return err(failure);
      }
    }

    if (isSuccessor && resumeOwnerId) {
      // A fresh successor keeps the coord owner but replaces its native context.
      // Clear the predecessor's scheduler reading before opening the child: its
      // first turn can pull work before this launch call returns. The ordinary
      // session-respawned report does this for carry-respawns, but capability
      // successors do not pass through that report.
      try {
        const { clearContextEstimate } = await import('../coordination/presence');
        await clearContextEstimate(resumeOwnerId);
      } catch (error) {
        await releaseAgentLaunchClaim({ workspaceId, idempotencyKey: args.idempotencyKey });
        return err(`Cannot start successor: failed to invalidate predecessor context pressure (${String(error)}). No process was opened.`);
      }
      try {
        const { clearContextUsage } = await import('../../system-health/context-usage-cache');
        clearContextUsage(resumeOwnerId);
      } catch {
        /* the persisted scheduler reading above is authoritative */
      }
      try {
        const { clearContextAnchor } = await import('../../compaction-usage');
        clearContextAnchor(resumeOwnerId);
      } catch {
        /* the successor's native transcript will reseed the render cache */
      }
    }

    // Public member claimKinds still needs fleet:launch-on-plan's claim-spec
    // machinery. Carry is now a normal fresh command setting and is folded above.
    if ((args.members ?? []).some((m) => m?.claimKinds?.length) && !savedLaunchCarry) {
      notes.push(
        '⚠ `claimKinds` on a member is only honored by fleet:launch-on-plan (it seeds the member claim spec); this general launch door opens raw agents, so that field was IGNORED. Use fleet:launch-on-plan for a self-pulling fleet.',
      );
    }

    const label =
      args.label ??
      (isSuccessor
        ? `successor · ${args.successor?.agentId ?? resumeSessionId ?? 'agent'}`
        : isResume
          ? `${fork ? 'fork' : 'resume'} · ${args.resume?.agentId ?? resumeId ?? resumeSessionId ?? 'agent'}`
          : `agent · ${args.plan ?? (args.brief ?? '').slice(0, 40)}`);
    const anyHeadless = foldedConfigs.some((f) => !!f.headless);
    const headlessLogDir = anyHeadless ? join(papercuspPathForWorkspace(workspaceId), 'fleet-logs') : null;

    // The brief rides the ENV, never a --kickoff= value: free-form text inside the
    // console greeting one-liner gets double-single-quoted and breaks the shell (the
    // gnome-terminal exit-2 the docs-agent hit). psu reads it for BOTH paths — the fresh
    // CLI positional prompt, and the pty-injected first turn of a resume/fork. A member's
    // own `brief` overrides the shared one for that agent's first turn.
    // P-003: the correlation floor for verifyFreshLaunchStarted — only sessions
    // that registered AFTER this instant can belong to this call.
    const spawnStartedAt = Date.now();
    // Date.now() is only a correlation timestamp, not an invocation identity:
    // concurrent launch-agent calls can reach this point in the same millisecond
    // and otherwise reuse the governor's admission idempotency key. Keep the
    // timestamp for diagnostics, but add one nonce per launch invocation; the
    // member index still distinguishes processes within a single batch.
    const spawnAdmissionNonce = randomUUID();
    const memberLabels = memberCommands.map((_, i) => (count > 1 ? `${label} (${i + 1}/${count})` : label));
    // A headless process can be alive and have a durable task/log identity even
    // when the bounded native-transcript kickoff receipt times out. Keep that
    // evidence separate from the SpawnConsoleResult status: turning an `ok`
    // result into `{ status: 'error' }` loses the identity, makes `opened` lie,
    // and releases the idempotency claim so a caller retry can duplicate it.
    const goalAllocationBrief = goalLaunch.goalId && !sourceAction
      ? renderGoalFleetAllocation({
          goalId: goalLaunch.goalId,
          intendedParallelPlanFleets: goalLaunch.settings?.intendedParallelPlanFleets ?? null,
        })
      : null;
    const memberBriefs = memberCommands.map((_, i) => {
      const custom = isSuccessor
        ? successorBrief
        : (memberSpecs[i]?.brief?.trim() || args.brief);
      return [custom, goalAllocationBrief].filter(Boolean).join('\n\n') || undefined;
    });
    const kickoffProofRequired = memberBriefs.map((brief) => Boolean(brief || args.plan));
    const results = await Promise.all(
      memberCommands.map(async (cmd, i) => {
        const memberBrief = memberBriefs[i];
        const env = {
          ...base.env,
          // Only explicit exact resume authorizes retirement clearing.
          ...(!fork && isResume ? { PSU_ALLOW_RETIRED_RESUME: '1' } : {}),
          ...(scopedGateway ? { [SCOPED_INFERENCE_GATEWAY_ENV]: JSON.stringify(scopedGateway) } : {}),
          ...(memberBrief ? { PAPERCUSP_KICKOFF_PROMPT: memberBrief } : {}),
          ...(internalKickoffOrigin
            ? { PAPERCUSP_INTERNAL_KICKOFF_ORIGIN: internalKickoffOrigin }
            : {}),
          ...(args.originalRouting ? { [ORIGINAL_CODEX_ROUTING_ENV]: JSON.stringify(args.originalRouting) } : {}),
          ...backendBinOverrideEnv,
        };
        // Never inherit a prior assignment's host-boundary authority.
        if (backendBinOverrideEnv[NATIVE_CONTAINER_EXEC_ENV] === undefined)
          delete (env as Record<string, string | undefined>)[NATIVE_CONTAINER_EXEC_ENV];
        const memberLabel = memberLabels[i];
        const targetOwnerId = memberOwnerIds[i];
        // Any scripted brief is a real first-turn obligation. Ask the headless
        // spawner for its native-transcript receipt so a stale wrapper that
        // ignores the option (missing receipt) and a host that reports negative
        // proof are surfaced in the recoverable partial result below rather
        // than being mistaken for a clean launch.
        const requireKickoffProof = kickoffProofRequired[i];
        try {
          if (recheckInPlaceResume) await recheckInPlaceResume();
          if (reconcileOriginalRouting) await reconcileOriginalRouting();
          return await spawnGovernedAgentProcess(
          {
            workspaceId,
            idempotencyKey: `agent-spawn:${callerOwnerId ?? 'operator'}:${spawnStartedAt}:${spawnAdmissionNonce}:${i}`,
            owner: targetOwnerId ?? `launcher:${callerOwnerId ?? 'operator'}`,
            payloadRef: `capability:launch-agent:${fleetSlug ?? args.plan ?? 'ad-hoc'}:${i}`,
            metadata: {
              launchedBy: callerOwnerId ?? 'operator',
              targetOwnerId,
              fleetSlug,
              headless: !!foldedConfigs[i].headless,
              ...(respawnReplacesOwnerId ? { replacesOwnerId: respawnReplacesOwnerId } : {}),
            },
          },
          async (admissionContext) => {
            if (recheckInPlaceResume) await recheckInPlaceResume();
            if (reconcileOriginalRouting) await reconcileOriginalRouting();
            const governedEnv = {
              ...env,
              PAPERCUSP_ADMISSION_CONTEXT: JSON.stringify(admissionContext),
            };
            if (foldedConfigs[i].headless) {
              const result = await spawnHeadless({
                envelope: { ...base, env: governedEnv, greetingCmd: cmd, cwd },
                writeMcpJson: true,
                label: memberLabel,
                logDir: headlessLogDir,
                launchedBy: callerOwnerId ?? undefined,
                fleetSlug,
                ...(gradingAuditTaskDetail
                  ? { ledgerDetail: { gradingAudit: gradingAuditTaskDetail } }
                  : {}),
                kickoffProof: requireKickoffProof,
                // Fresh members and successors are explicitly pre-pinned. An
                // in-place resume re-attaches its source owner. Each fork's
                // distinct identity is pinned in both argv and this receipt.
                coordOwnerId: targetOwnerId,
              });
              // A one-turn headless agent may finish at its CLI prompt without
              // calling coord:orient or activity:report. Arm its standing wake
              // watcher here so follow-up work can still reach the live session.
              if (result.status === 'ok' && targetOwnerId) {
                try {
                  await armInboxWake({
                    ownerId: targetOwnerId,
                    note: 'headless launch-agent inbox-wake',
                  });
                } catch (error) {
                  notes.push(
                    '⚠ HEADLESS INBOX-WAKE NOT ARMED — ' +
                      targetOwnerId +
                      ' launched but follow-up wake registration failed: ' +
                      ((error as Error)?.message ?? String(error)) +
                      '.',
                  );
                }
              }
              // Preserve the successful spawn result. The process/task/log
              // identity is recoverable evidence even though the first-turn
              // receipt is not; the summary below reports this as a partial
              // launch and keeps the caller's idempotency claim.
              return result;
            }
            return spawnConsole({
              envelope: { ...base, env: governedEnv, greetingCmd: cmd, cwd },
              label: memberLabel,
              writeMcpJson: true,
              scheme,
              allowDesktopBridge: true,
              // capability:launch-agent consumes this return value as proof
              // that a member exists, so it must pay the visible spawner's
              // bounded greeting-command receipt instead of treating a
              // surviving terminal emulator as an agent.
              verifyBootReceipt: true,
              // `pid` is the terminal emulator (or its launcher), not the
              // interactive shell that owns the tab. Capture the shell's
              // authenticated PID so respawn cleanup can pass it to
                  // fleet:kill's terminal_pids path.
              captureTerminalPid: true,
              displayOverride: memberSpecs[i]?.display ?? args.display,
              // Keep process-per-window as the safe auto-detection fallback,
              // but honor an explicit workspace/host TERMINAL choice. The boot
              // receipt above makes a terminal that drops `-- CMD` fail visibly
              // instead of claiming a successful launch.
              preferProcessPerWindow: !process.env.TERMINAL?.trim(),
            });
          },
          );
        } catch (error) {
          // Admission can reject before the console spawner runs (for example when
          // its durable receipt cannot be persisted). Keep the attempt in its member
          // slot so a partial batch still reports the right member labels, while
          // making the rejection eligible for the zero-open rollback below.
          return {
            status: 'error' as const,
            code: 500,
            error: `governed spawn failed: ${(error as Error)?.message ?? error}`,
          };
        }
      }),
    );

    const opened = results.filter((r) => r.status === 'ok');
    const failed = results.filter((r) => r.status !== 'ok');
    const failures = results.flatMap((result, memberIndex) =>
      result.status === 'error'
        ? [
            {
              memberIndex,
              label: memberLabels[memberIndex],
              code: result.code,
              reason: result.error,
            },
          ]
        : [],
    );
    const openedOwnerIds = results.flatMap((result, i) =>
      result.status === 'ok' && memberOwnerIds[i] ? [memberOwnerIds[i]] : [],
    );
    for (const result of results) {
      notes.push(...(result.goalAdmissionDegraded ?? []).map((reason) => `⚠ ${reason}`));
    }
    let verifierCoupling: { status: 'coupled' | 'failed' | 'not-opened'; holderId: string; verifierId: string | null; error?: string } | null = null;
    if (args.goalVerifier && callerOwnerId) {
      const verifierId = openedOwnerIds[0] ?? null;
      if (!verifierId) {
        verifierCoupling = { status: 'not-opened', holderId: callerOwnerId, verifierId };
      } else {
        try {
          const edge = await declareCoupling({
            agentA: callerOwnerId,
            agentB: verifierId,
            declaredBy: callerOwnerId,
            reason: `GOAL ${args.goalVerifier.toUpperCase()} verification`,
            ttlSec: 2 * 24 * 3600,
            workspaceId,
          });
          verifierCoupling = edge
            ? { status: 'coupled', holderId: callerOwnerId, verifierId }
            : { status: 'failed', holderId: callerOwnerId, verifierId, error: 'coupling store returned no edge' };
        } catch (error) {
          verifierCoupling = { status: 'failed', holderId: callerOwnerId, verifierId, error: error instanceof Error ? error.message : String(error) };
        }
        if (verifierCoupling.status === 'failed') {
          notes.push(`⚠ GOAL verifier ${verifierId} opened but coupling failed (${verifierCoupling.error}); couple the holder and verifier before treating this routing as complete.`);
        }
      }
    }
    const kickoffProofFailures = results.flatMap((result, i) => {
      if (
        result.status !== 'ok' ||
        !foldedConfigs[i].headless ||
        !kickoffProofRequired[i] ||
        result.kickoffProof?.persisted === true
      ) return [];
      return [
        {
          memberIndex: i,
          reason: result.kickoffProof?.reason ?? 'kickoff-proof-missing',
          nativeRef: result.kickoffProof?.nativeRef ?? null,
          taskId: result.taskId ?? null,
          logPath: result.logPath ?? null,
        },
      ];
    });
    const partialLaunch = kickoffProofFailures.length > 0 || (opened.length > 0 && failed.length > 0) || verifierCoupling?.status === 'failed';
    for (const failure of kickoffProofFailures) {
      const keyNote = args.idempotencyKey?.trim()
        ? ` idempotencyKey ${JSON.stringify(args.idempotencyKey)} remains claimed; do not retry it without first inspecting the opened identity.`
        : '';
      notes.push(
        `⚠ RECOVERABLE PARTIAL LAUNCH — ${memberLabels[failure.memberIndex]} opened a process (task ${failure.taskId ?? 'unavailable'}), but its native ` +
          `kickoff proof was not persisted (${failure.reason}). The task/log identity is retained for recovery; ` +
          `see ${failure.logPath ?? 'the headless launch log'}.${keyNote}`,
      );
    }
    let launchClaimReleased = false;
    if (opened.length === 0 && args.idempotencyKey?.trim()) {
      launchClaimReleased = await releaseAgentLaunchClaim({
        workspaceId,
        idempotencyKey: args.idempotencyKey,
      });
      notes.push(
        launchClaimReleased
          ? `↩ No agent process opened; released idempotencyKey ${JSON.stringify(args.idempotencyKey)} so the failed launch can be retried.`
          : `⚠ No agent process opened, but the idempotencyKey ${JSON.stringify(args.idempotencyKey)} could not be released; retry with a fresh key after checking the launch ledger.`,
      );
    }

    // EI-11524: a clean terminal spawn is NOT proof the agent is running. An
    // in-place `psu --resume` whose transcript was archived off-disk (or whose
    // launcher searched the wrong projects dir) finds nothing, starts no process,
    // and the window closes seconds later — yet we previously reported SUCCESS.
    // Verify a live psu-pty host actually appears for the resumed identity (which
    // re-attaches its ORIGINAL ownerId) before calling the resume good. If none
    // appears inside the bounded window, report UNCONFIRMED without converting
    // absence into failure (EI-21476169071856015). A fork mints a new identity we
    // can't poll here. Headless in-place resumes have no visible window, so they
    // race the persistent child-exit observer against this verifier instead.
    let resumeVerifyFailed = false;
    let resumeVerified: boolean | null | undefined;
    let resumeVerification: {
      expectedSessionId: string | null;
      actualSessionId: string | null;
      mismatch: boolean;
      rollback: string | null;
      bootLogTail?: string | null;
    } | null = null;
    if (isResume && !fork && resumeOwnerId && opened.length > 0) {
      const headlessResult = args.headless
        ? opened.find((result) => result.status === 'ok' && result.childExit)
        : undefined;
      const childExit = headlessResult?.status === 'ok' ? headlessResult.childExit : undefined;
      const verifyPromise = verifyResumeStarted(resumeOwnerId, {
        expectedSessionId: resumeSessionId,
        ...(args.agent && args.agent !== resumeAgent && resumeSourceAdvSessionId != null ? {
          expectedPort: { sourceAdvSessionId: resumeSourceAdvSessionId, targetBackend: args.agent },
        } : {}),
        timeoutMs: RESUME_VERIFY_TIMEOUT_MS,
      });
      const observation = childExit
        ? await Promise.race([
            childExit.then((exit) => ({ kind: 'exit' as const, exit })),
            verifyPromise.then((verify) => ({ kind: 'verify' as const, verify })),
          ])
        : { kind: 'verify' as const, verify: await verifyPromise };

      if (observation.kind === 'exit') {
        const classified = classifyHeadlessResumeExit(
          observation.exit,
          headlessResult?.status === 'ok' ? headlessResult.logPath : null,
          resumeAgent,
        );
        const exitDescription = observation.exit.error
          ? `spawn error: ${observation.exit.error.message}`
          : observation.exit.signal
            ? `signal ${observation.exit.signal}`
            : `exit ${observation.exit.code ?? 0}`;
        const bootLogTail = classified.logTail;
        resumeVerification = {
          expectedSessionId: resumeSessionId,
          actualSessionId: null,
          mismatch: false,
          rollback: null,
          bootLogTail,
        };
        if (classified.outcome.ok) {
          // A clean headless child exit is compatible with a completed one-turn
          // resume, but it does not attest that the matching managed host became
          // live. Preserve the verifier's honest three-state contract.
          resumeVerified = null;
          notes.push(
            `⏳ HEADLESS RESUME UNCONFIRMED — the resumed process ${exitDescription} before a matching managed ` +
              `host was observed. A clean exit is not proof of a live resumed turn; re-check coord:presence.` +
              headlessResumeLogNote(bootLogTail),
          );
        } else {
          resumeVerifyFailed = true;
          resumeVerified = false;
          notes.push(
            `✗ HEADLESS RESUME TURN FAILED — the resumed process ${exitDescription}; ` +
              `${classified.outcome.error.class}: ${classified.outcome.error.message}. ` +
              `The persistent child-exit evidence is authoritative for this observed failure.` +
              headlessResumeLogNote(bootLogTail),
          );
        }
      } else {
        const verify = observation.verify;
        if (verify.started === false) {
          resumeVerifyFailed = true;
          resumeVerified = false;
          if (verify.mismatch) {
            const rollback = await shutdownViaPty(resumeOwnerId, {
              force: true,
              reason: `resume UUID mismatch: requested ${verify.expectedSessionId ?? 'unknown'}, actual ${verify.actualSessionId ?? 'unknown'}`,
            });
            resumeVerification = {
              expectedSessionId: verify.expectedSessionId,
              actualSessionId: verify.actualSessionId,
              mismatch: true,
              rollback,
            };
            notes.push(
              `✗ RESUME UUID MISMATCH — requested ${verify.expectedSessionId ?? '(unknown)'} but the live backend ` +
                `actually resumed ${verify.actualSessionId ?? '(no attested UUID)'}. Success was REFUSED. ` +
                `Rollback result for the newly launched wrong session: ${rollback}.`,
            );
          } else {
            const bootLogTail = readResumeBootLogTail(resumeOwnerId);
            resumeVerification = {
              expectedSessionId: verify.expectedSessionId,
              actualSessionId: verify.actualSessionId,
              mismatch: false,
              rollback: null,
              bootLogTail,
            };
            notes.push(
              `✗ RESUME DID NOT START — an observed failure prevented ${resumeOwnerId} from registering a matching live agent. ` +
                `Check the terminal window and bounded boot log before retrying.` +
                resumeBootLogNote(bootLogTail),
            );
          }
        } else if (verify.started === null) {
          resumeVerified = null;
          const bootLogTail = readResumeBootLogTail(resumeOwnerId);
          resumeVerification = {
            expectedSessionId: verify.expectedSessionId,
            actualSessionId: verify.actualSessionId,
            mismatch: false,
            rollback: null,
            bootLogTail,
          };
          notes.push(
            `⏳ RESUME UNCONFIRMED — no matching managed-pty host was observed for ${resumeOwnerId} within ` +
              `${Math.round(RESUME_VERIFY_TIMEOUT_MS / 1000)}s. The bounded verification window expired; ` +
              `that is absence of evidence, not an observed no-op. A healthy exact Codex resume has registered ` +
              `more than seven minutes later (EI-21476169071856015). Do NOT launch a fallback on this note alone: ` +
              `re-check coord:presence / work_items:observe in a few minutes.` +
              resumeBootLogNote(bootLogTail),
          );
        } else {
          resumeVerified = true;
          resumeVerification = {
            expectedSessionId: verify.expectedSessionId,
            actualSessionId: verify.actualSessionId,
            mismatch: false,
            rollback: null,
          };
        }
      }
    }

    // ── P-003: kill the false "Launched" for a FRESH/FORK launch ─────────────
    //
    // A clean spawn is not proof an agent is running — the 4th recurrence of this
    // class (EI-11543, WI-4752, EI-18696184925888288, and the measured acceptance
    // case adv_session 14842, which registered a row, fired its two launch
    // statusline calls, and then did nothing for the hour until the reaper closed
    // it, while the tool had already reported success).
    //
    // The verdict is THREE-state (D-004) and that is load-bearing: first real turn
    // is p50 ~31s, so a boolean at this timeout would report most HEALTHY launches
    // as failures. `null` says "still booting" honestly; only observed SILENCE is
    // reported as a failure, and only that sets isError.
    let freshVerdict: FreshLaunchVerdict | null = null;
    // A fork mints a fresh identity, so the same launched-by + spawn-time
    // correlation used for a fresh agent is authoritative for it too. An
    // in-place resume keeps its known owner id and uses verifyResumeStarted above.
    if ((!isResume || fork) && callerOwnerId && opened.length > 0) {
      // EI-20823593041668393: a slow headless first turn can stop making MCP
      // statusline calls while its CLI is plainly alive and rendering into the
      // durable log. Snapshot here, then let the verifier compare at the end of
      // its window before it turns ledger silence into a death verdict.
      const headlessLogSizes = new Map(
        opened.flatMap((result) => {
          if (result.status !== 'ok' || !result.logPath) return [];
          try {
            return [[result.logPath, statSync(result.logPath).size] as const];
          } catch {
            return [];
          }
        }),
      );
      try {
        freshVerdict = await verifyFreshLaunchStarted(
          {
            workspaceId,
            launcherOwnerId: callerOwnerId,
            since: spawnStartedAt,
            expected: opened.length,
            ...(openedOwnerIds.length === opened.length ? { expectedOwnerIds: openedOwnerIds } : {}),
          },
          {
            probeProcessEvidence: () =>
              opened.flatMap((result) => {
                if (result.status !== 'ok' || result.pid == null || !result.logPath) return [];
                let pidAlive = false;
                let logGrowing = false;
                try {
                  process.kill(result.pid, 0);
                  pidAlive = true;
                } catch {
                  pidAlive = false;
                }
                try {
                  logGrowing = statSync(result.logPath).size > (headlessLogSizes.get(result.logPath) ?? 0);
                } catch {
                  logGrowing = false;
                }
                return [{ pidAlive, logGrowing }];
              }),
          },
        );
        notes.push(freshVerdict.note);
      } catch (e) {
        // The instrument broke. Say THAT — never let a probe fault masquerade as
        // a launch failure (or, worse, as success).
        notes.push(
          `⏳ launch verification could not run (${(e as Error)?.message ?? e}) — the agents may be ` +
            `fine; this says nothing either way. Confirm with coord:presence.`,
        );
      }
    } else if ((!isResume || fork) && opened.length > 0 && !callerOwnerId) {
      // EI-21725123573114023: the verifier above is gated on the CALLER's owner id
      // (its correlation key), so an unattributed caller silently skipped it and
      // fell through to a bare "Launched N agents" — success asserted with nothing
      // observed. That is the same masquerade the catch branch above refuses to
      // allow for a broken probe; absence of the instrument deserves the same
      // honesty as a fault in it.
      notes.push(
        '⏳ launch verification DID NOT RUN — this call has no caller owner id to correlate new sessions ' +
          'against, so nothing here attests that an agent actually started. The spawn succeeded; that is all ' +
          'this result claims. Confirm with coord:presence before treating the brief as delivered.',
      );
    }

    const launchEvidence = deriveFreshLaunchEvidenceSummary({
      opened: opened.length,
      firstTurn: freshVerdict?.agentStarted ?? null,
      workerAttestations: freshVerdict?.sessions.map((session) => session.workerAttestation) ?? null,
    });

    const lines: string[] = [];
    if (opened.length) {
      const allHeadless = foldedConfigs.every((f) => !!f.headless);
      const how = allHeadless ? 'headless' : anyHeadless ? 'mixed (visible + headless)' : 'visible';
      const fleetNote = fleetSlug ? ` in fleet ${fleetSlug}${scheme ? ` (${scheme.name})` : ''}` : ' (no fleet)';
      lines.push(`Launched ${opened.length} ${how} agent${opened.length > 1 ? 's' : ''}${fleetNote}:`);
      // Per-member disclosure (P-002): when `members` made the composed commands differ,
      // show each one so the caller sees exactly what each agent got; otherwise the single
      // shared command.
      const distinctCommands = [...new Set(memberCommands)];
      if (distinctCommands.length <= 1) {
        lines.push(`  ${command}`);
      } else {
        lines.push('  per-member commands:');
        memberCommands.forEach((c, i) => lines.push(`    ${i + 1}. ${c}`));
      }
      for (const o of opened) {
        if (o.status !== 'ok') continue;
        const terminalPid = o.terminalPid == null ? 'unavailable' : String(o.terminalPid);
        lines.push(
          `  • ${o.terminal} (launcher pid ${o.pid ?? '?'}; terminal pid ${terminalPid}) in ${cwd}` +
            `${o.display ? ` [DISPLAY=${o.display}]` : ''}` +
            `${o.normalizedLogPath ? `; grep-safe log: ${o.normalizedLogPath}` : ''}`,
        );
      }
      const hasLaunchBrief = memberBriefs.some(Boolean);
      const hasLaunchPlan = Boolean(!isSuccessor && !isResume && args.plan);
      if (hasLaunchBrief) {
        lines.push(
          isResume
            ? "  ↪ the brief is QUEUED as the resumed session's next turn (psu's managed pty injects it once the agent reaches its prompt). Delivery alone is not proof the turn began; read the verification verdict below."
            : "  ↪ the brief was supplied as the agent's first turn prompt. Process open does not prove that turn began; read the launch evidence below before treating the agent as working.",
        );
      } else if (hasLaunchPlan) {
        lines.push(
          `  ↪ bound to plan ${JSON.stringify(args.plan)} — the agent pulls its own work; no brief needed.`,
        );
      } else {
        lines.push('  ⚠ no `brief` — the agent opens IDLE. It will not do anything until someone gives it a turn.');
      }
      lines.push(`  ↳ ${formatFreshLaunchEvidenceSummary(launchEvidence)}`);
      if (anyHeadless) {
        lines.push(
          `  ⓘ headless logs: ${headlessLogDir}. EI-9748: a \`:3170\` restart reaps headless children — prefer a visible launch for long-lived work on the dev box.`,
        );
      }
    }
    for (const n of notes) lines.push(n);
    // `failed` is already narrowed to the error arm by the filter's inferred
    // type predicate (TS 5.5+), so no re-guard — one would be dead code (TS2367).
    for (const f of failed) {
      lines.push(`✗ launch failed (${f.code}): ${f.error}`);
    }

    // The verifier is the authoritative source for a freshly registered native
    // transcript. Keep its handle adjacent to the task/log receipt so a caller
    // can follow up after the role session ends without addressing the mortal
    // coord owner id. A verifier failure leaves this field absent; a successful
    // verifier with no resolvable native handle keeps it explicitly null.
    const nativeSessionByOwner = freshVerdict
      ? new Map(
          freshVerdict.sessions.flatMap((session) => {
            if (!session.ownerId) return [];
            const memberIndex = memberOwnerIds.indexOf(session.ownerId);
            const backend = isResume
              ? resumeAgent
              : foldedConfigs[memberIndex >= 0 ? memberIndex : 0]?.agent;
            return [[session.ownerId, nativeSessionHandleFromFreshProbe(session, backend)] as const];
          }),
        )
      : null;

    const launchSummary = {
      deduped: false,
      // Preserve the resolver's pre-spawn count. A later read could include this
      // launch or an existing actor whose goal attribution/freshness changed.
      goalAdmission: goalLaunch.goalId ? {
        stage: 'batch-preflight',
        goalId: goalLaunch.goalId,
        fleet: fleetSlug,
        requested: count,
        ceilings: goalLaunch.ceilings,
        headcount: goalLaunch.headcountMeasurement ? goalLaunch.headcount : null,
        measurement: goalLaunch.headcountMeasurement ?? null,
        capacityStatus: goalLaunch.degradedReasons.some((reason) => reason.startsWith('ceiling not enforced'))
          ? 'unenforced' : goalLaunch.headcountMeasurement ? 'enforced' : 'not-checked',
        degraded: goalLaunch.degraded,
        degradedReasons: goalLaunch.degradedReasons,
      } : null,
      // Preserve each final decision separately from the earlier batch check.
      // A throwing spawn can leave a durable receipt but no returned context;
      // null is unknown here, never proof of a zero or unenforced population.
      finalGoalAdmissions: results.map((result, memberIndex) => ({
        memberIndex, ownerId: memberOwnerIds[memberIndex] ?? null,
        receiptId: result.admissionContext?.receiptId ?? null,
        admission: result.goalAdmission ?? null,
        outcome: result.status === 'ok' ? 'opened' : 'failed',
      })),
      opened: opened.length,
      failed: failed.length,
      failures,
      partial: partialLaunch,
      command,
      fleet: fleetSlug,
      independent: args.independent === true,
      goalVerifier: args.goalVerifier ?? null,
      verifierCoupling,
      headcountProfile: persistedHeadcountProfile
        ? {
            applied: true,
            target: persistedHeadcountProfile.target,
            config: persistedHeadcountProfile.config,
            ...(savedLaunchSpecMeta ?? {}),
          }
        : null,
      mode: isSuccessor ? 'successor' : isResume ? (fork ? 'fork' : 'resume') : 'fresh',
      resumedOwnerId: resumeOwnerId,
      ownerIds: memberOwnerIds,
      launchEvidence,
      ...(kickoffProofFailures.length > 0
        ? {
            kickoffProof: {
              required: true,
              persisted: false,
              failures: kickoffProofFailures.map((failure) => ({
                memberIndex: failure.memberIndex,
                label: memberLabels[failure.memberIndex],
                reason: failure.reason,
                nativeRef: failure.nativeRef,
                taskId: failure.taskId,
                logPath: failure.logPath,
              })),
            },
          }
        : {}),
      tasks: results.flatMap((result, i) =>
        result.status === 'ok'
          ? [
              {
                taskId: result.taskId ?? null,
                logPath: result.logPath ?? null,
                normalizedLogPath: result.normalizedLogPath ?? null,
                pid: result.pid,
                terminalPid: result.terminalPid ?? null,
                label: memberLabels[i],
                ownerId: memberOwnerIds[i],
                headless: !!foldedConfigs[i].headless,
                kickoffProof: result.kickoffProof ?? null,
                ...(freshVerdict
                  ? { nativeSession: nativeSessionByOwner?.get(memberOwnerIds[i] ?? '') ?? null }
                  : {}),
              },
            ]
          : [],
      ),
      ...(resumeVerified !== undefined ? { resumeVerified } : {}),
      ...(resumeVerification ? { resumeVerification } : {}),
      ...(freshVerdict
        ? {
            agentStarted: freshVerdict.agentStarted,
            freshVerdict: {
              agentStarted: freshVerdict.agentStarted,
              sessions: freshVerdict.sessions.map((session) => ({
                ownerId: session.ownerId,
                sessionId: session.sessionId,
              })),
            },
          }
        : {}),
    };

    let launchSummaryRecorded = false;
    if (!launchClaimReleased) {
      launchSummaryRecorded = await recordAgentLaunchResult({
        workspaceId,
        idempotencyKey: args.idempotencyKey,
        summary: launchSummary,
      });
    }
    const completionReceipt = agentLaunchCompletionReceipt(args.idempotencyKey, launchSummaryRecorded);

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      data: {
        deduped: false,
        modelResolution: effectiveModelResolution,
        memberModelResolutions,
        launch: launchSummary,
        ...(completionReceipt ? { completionReceipt } : {}),
      },
      // Only an OBSERVED failure is an error. `agentStarted === null` and
      // `resumeVerified === null` (unconfirmed — still booting) must NOT set
      // isError: healthy launches can land there inside this bounded window, and
      // flagging them would make the tool cry wolf on its own success path.
      ...(opened.length === 0 || resumeVerifyFailed || freshVerdict?.agentStarted === false
        ? { isError: true as const }
        : {}),
    };
  },
});
