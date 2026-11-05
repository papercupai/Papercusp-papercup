/** Registered condition view; shared readers remain usable without tool registration. */
import { z } from "zod";
import { defineTool } from "@papercusp/agent-mcp";
import { COORD_ROLES } from "../roles";
import { coordHasPgFastPath } from "../log";
import {
  CONDITIONS_FAST_PATH_ROW_CAP,
  computeConditionStates,
  readConditionEnvelopes,
  readConditionEnvelopesForKey,
} from "../condition-state";

// Preserve every existing consumer of the original tool-module exports.
export * from "../condition-state";

export default defineTool({
  name: "coord:conditions",
  description:
    'The live "what is wrong RIGHT NOW" view: folds condition-keyed severe-event broadcasts (git-sync stalls, green-gate freezes, …) into per-condition STATE instead of message history. Returns open conditions first (latest alarm newer than any resolution) with first_seen/last_seen/alarm_count/latest_summary, then recently-resolved ones (resolved_at + resolved_summary). Pass condition_key for one exact-key lookup without scanning the aggregate window. An OPEN condition is claimable work; a resolved one needs no action.',
  guidance: {
    when:
      'Orienting on current system health — "is anything wrong right now?" — before claiming a stall/red-gate broadcast, or when an old severe-event alarm in your inbox needs a live open/resolved verdict.',
    notWhen:
      "For your addressed mail use coord:inbox (stale alarms there already carry resolved:true). For human-facing escalations use coord:escalations. For agent liveness use coord:presence.",
  },
  capability: "coord:read",
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    include_resolved: z
      .boolean()
      .optional()
      .describe(
        "Also return resolved conditions (default true, capped by resolved_limit). Pass false for open-only.",
      ),
    resolved_limit: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe("Max resolved conditions returned (most recent kept). Default 10."),
    condition_key: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe(
        "Exact condition key to read. Uses the keyed lifecycle lookup and returns only that condition; " +
          "an unmatched key is reported with condition_found:false.",
      ),
  }),
  async handler(args) {
    const conditionKey = args.condition_key?.trim();
    const envelopes = conditionKey
      ? await readConditionEnvelopesForKey(conditionKey)
      : await readConditionEnvelopes();
    const states = computeConditionStates(envelopes);
    // The aggregate fold's bounded window is not a complete condition census.
    const windowSaturated =
      coordHasPgFastPath() && envelopes.length >= CONDITIONS_FAST_PATH_ROW_CAP;
    const selected = conditionKey
      ? states.filter((s) => s.condition_key === conditionKey)
      : states;
    const open = selected.filter((s) => s.open);
    const resolvedLimit = args.resolved_limit ?? 10;
    const resolved =
      args.include_resolved === false
        ? []
        : selected.filter((s) => !s.open).slice(0, resolvedLimit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            open_count: open.length,
            open,
            resolved_count: selected.length - open.length,
            ...(conditionKey
              ? {
                  condition_key: conditionKey,
                  condition_found: selected.length > 0,
                }
              : {}),
            resolved,
            ...(windowSaturated
              ? {
                  window_saturated: {
                    rows: envelopes.length,
                    cap: CONDITIONS_FAST_PATH_ROW_CAP,
                    note:
                      "The fold read only the newest condition rows; conditions whose last alarm or " +
                      "resolution is older than that window are missing from open and resolved.",
                  },
                }
              : {}),
          }),
        },
      ],
    };
  },
});
