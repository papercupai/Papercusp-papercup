/**
 * Always-worn kernel safety rails (identity-system-everything-migration-2026-10-18
 * P-004, R-11; plan Decision D-001).
 *
 * A safety rail is EXPRESSED in the identity system's own rule language (a sync
 * pre-tool guard: a `DataCondition` deny evaluated by `evaluateDataCondition`)
 * but it is enforced by HOST code, never worn. It is not an identity layer, so
 * it occupies no stack slot and falls under no contribution or restriction rule,
 * and it is not read from any artifact, so it applies when the session wears no
 * identity package, when the package is broken, and when the worn-rules read
 * fails. It is never charged to a sink budget, and a call whose input is over
 * the guard input bound is refused rather than passed unread, so no budget can
 * drop it.
 *
 * The pre-tool guard port (`evaluateToolGuard` in sync-hook-rules.ts) checks
 * these rails BEFORE it reads anything worn.
 *
 * Each rail mirrors a deny the client shell gate already makes
 * (apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh, the
 * destructive-git block: one segment of the command, split on `;&|` and newlines,
 * after the same wrapper words), so a rail adds no deny the gate does not
 * already make for an agent session. The gate stays the primary enforcer: it
 * strips quoted and heredoc text before matching, which a regex over the raw
 * command cannot do. A heredoc line that starts with one of these commands is
 * therefore refused here even though the gate would let it through.
 *
 * Pure. No I/O.
 */
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';

/** The identity id every kernel refusal names. */
export const KERNEL_IDENTITY_ID = 'kernel';

/** The rule id of a refusal for a call whose input is over the guard input bound. */
export const KERNEL_INPUT_BOUND_RULE_ID = 'kernel:guard-input-bound';

export interface KernelSafetyRail {
  /** Stable rule id, named in the refusal. */
  readonly id: string;
  /** What a violating call would do, for the refusal text. */
  readonly reason: string;
  /** The deny condition over `{ tool, input, client }`. */
  readonly deny: DataCondition;
  /**
   * The tools whose input this rail reads, over `{ tool, client }`. A call to
   * one of them whose input the adapter cut at the guard input bound is
   * refused, because the rail cannot see the part it would match. Absent
   * means every tool.
   */
  readonly appliesTo?: DataCondition;
}

/** The shell tools whose command a rail reads: Claude, Codex and the Papercusp MCP tool. */
const SHELL_TOOL = '^(?:Bash|exec_command|shell_command|shell|(?:mcp__.+__)?capability[_:]bash)$';

/** Start of one command segment, then the gate's wrapper words. */
const SEGMENT =
  '(?:^|[;&|\\n(])\\s*' +
  '(?:(?:sudo(?:\\s+(?:-[ugpUrCht]\\s+\\S+|-[A-Za-z]+|--[\\w-]+(?:=\\S*)?))*' +
  '|env(?:\\s+[A-Za-z_]\\w*=\\S*)*' +
  '|nice(?:\\s+-n\\s*-?\\d+)?' +
  '|ionice(?:\\s+-\\w+(?:\\s+\\d+)?)*' +
  '|xargs(?:\\s+-\\w+)*' +
  '|timeout\\s+\\S+' +
  '|rtk|time|command|nohup|exec|setsid|nocorrect|stdbuf|doas|nocache)\\s+)*';

/** The gate's `_GIT`: `git` plus its repository-selecting options. */
const GIT = 'git\\b(?:\\s+-C\\s+\\S+|\\s+-c\\s+\\S+|\\s+--git-dir\\S*|\\s+--work-tree\\S*)*\\s+';

/** Rest of the same segment. */
const SAME_SEGMENT = '[^;&|\\n]*';

function shellRail(id: string, reason: string, subcommand: string): KernelSafetyRail {
  const pattern = SEGMENT + GIT + subcommand;
  return {
    id,
    reason,
    appliesTo: { tool: { matches: SHELL_TOOL } },
    deny: {
      all: [
        { tool: { matches: SHELL_TOOL } },
        { any: [{ 'input.command': { matches: pattern } }, { 'input.cmd': { matches: pattern } }] },
      ],
    },
  };
}

const SHARED_TREE =
  "it would discard other agents' uncommitted work in the shared checkout. Discard only your own file, by hand";

/**
 * The listed safety rails. R-11's test replays a violating call against every
 * entry; a new rail joins that test by being added here.
 */
export const KERNEL_SAFETY_RAILS: readonly KernelSafetyRail[] = [
  shellRail('kernel:git-reset-hard', `git reset --hard is refused: ${SHARED_TREE}`,
    `reset\\b${SAME_SEGMENT}--hard\\b`),
  shellRail('kernel:git-clean-force', `git clean -f is refused: ${SHARED_TREE}`,
    `clean\\b${SAME_SEGMENT}-\\w*f`),
  shellRail('kernel:git-checkout-all', `git checkout/restore of the whole tree is refused: ${SHARED_TREE}`,
    `(?:checkout|restore)\\b${SAME_SEGMENT}\\s(?:\\.|:/)(?=\\s|$|[;&|\\n)])`),
  shellRail('kernel:git-stash', `git stash is refused: the stash is one stack shared by every agent in the checkout, so ${SHARED_TREE}`,
    // Only list/show are read-only. drop/clear delete entries on the shared
    // stack and branch switches the shared tree's branch (WI-6554700010017558).
    'stash\\b(?!\\s+(?:list|show)\\b)'),
];

export type KernelVerdict =
  | { readonly decision: 'deny'; readonly identityId: string; readonly ruleId: string; readonly reason: string }
  | { readonly decision: 'none' };

/**
 * PURE, fail-closed: the first kernel rail a pending call violates. A rail
 * whose condition throws refuses too, because a rail that cannot evaluate
 * cannot prove the call is safe.
 *
 * A call whose input the adapter cut at the guard input bound
 * (`inputTruncated`) is refused by the first rail that applies to its tool:
 * the bound is a budget, and a rail must never be dropped by a budget. This is
 * the adapter's own contract (hooks/inject/core.mjs `guardCall`: over the bound
 * the server refuses the call for any guard that matches the tool).
 */
export function evaluateKernelSafetyRails(
  call: { readonly tool: string; readonly input: unknown; readonly client: string; readonly inputTruncated?: boolean },
  rails: readonly KernelSafetyRail[] = KERNEL_SAFETY_RAILS,
): KernelVerdict {
  const event = { tool: call.tool, input: call.input, client: call.client };
  if (call.inputTruncated === true) {
    // A rail whose tool condition throws counts as applying (fail closed).
    const blind = rails.filter((rail) => {
      try {
        return rail.appliesTo === undefined || evaluateDataCondition(rail.appliesTo, event);
      } catch {
        return true;
      }
    });
    if (blind.length === 0) return { decision: 'none' };
    return {
      decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId: KERNEL_INPUT_BOUND_RULE_ID,
      reason: `tool input exceeds the guard input bound, so kernel rail(s) ${blind.map((rail) => rail.id).join(', ')} `
        + 'cannot see all of it. Write long content to a file with the Write tool, or split the command',
    };
  }
  for (const rail of rails) {
    try {
      if (evaluateDataCondition(rail.deny, event)) {
        return { decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId: rail.id, reason: rail.reason };
      }
    } catch (error) {
      return {
        decision: 'deny', identityId: KERNEL_IDENTITY_ID, ruleId: rail.id,
        reason: `kernel rail ${rail.id} failed to evaluate: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      };
    }
  }
  return { decision: 'none' };
}
