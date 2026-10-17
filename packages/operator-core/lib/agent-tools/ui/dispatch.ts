/**
 * ui:dispatch — fire an intent at a browser tab and wait for the
 * result.
 *
 * Flow:
 *   1. INSERT into ui_intents with status='pending'.
 *   2. Long-poll for the row to leave 'pending' (set by the
 *      browser-side dispatcher's POST /api/ui/intents/:id/result).
 *   3. Return result/error to the agent.
 *
 * If the tab doesn't pick up the intent within `timeout_ms` we mark
 * it status='timeout' and return that to the agent. The browser tab
 * will skip stale timeouts because its UPDATE clause requires
 * status='pending'.
 *
 * Built-in intents (always available): set_url, snapshot,
 * read_visible_text, focus, scroll_into_view, click.
 *
 * NOTE: was briefly auto-migrated to drizzle by a phase-3 batch and
 * the generated values-builder broke jsonb encoding for the `args`
 * column. Raw sql shape is correct.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { uiCrossWorkspaceBlock } from './_workspace-guard';
import { hardText, LIMITS } from '../limits';
import { dispatchUiIntent } from '../../ui/dispatch-intent';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 60_000;

export default defineTool({
  name: 'ui:dispatch',
  description:
    'Dispatch a UI intent to a browser tab and wait for the result. Defaults client_id to ctx.uiClientId (the tab that spawned the agent). Built-in intents: set_url ({path?:"/route", params:{...}} — path switches the route, params merge into the query string), snapshot ({selector?,mode?}), read_visible_text, focus, scroll_into_view, click. Pages can register additional intents via useUiIntent(name, handler).',
  capability: 'ui:dispatch',
  guidance: {
    when: 'You need to make something happen in the user\'s browser tab — open the panel, navigate, focus a card, etc. Side-effect tool: writes a ui_intents row the tab consumes via SSE.',
    notWhen: 'For showing a question + choices in the chat, use `chat:ask_choice` (renders inline buttons). For asking the operator brain to delegate work, use `<spawn>` — `ui:dispatch` is for UI side effects, not work delegation.',
    seeAlso: [
      'ui:get_state (read current UI state before acting)',
      'ui:list_clients (choose which tab to target)',
      'chat:ask_choice (inline question + choices instead of a UI side effect)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    /** Target tab. Defaults to ctx.uiClientId. */
    client_id: z.string().optional(),
    /** Intent name, e.g. "set_url" or a feature-registered name. */
    intent: hardText(LIMITS.SHORT_TITLE),
    /** Args object passed to the intent handler. */
    args: z.record(z.string(), z.unknown()).optional(),
    /** Long-poll budget; default 5000ms, max 60000ms. */
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).optional(),
  }),
  async handler(args, ctx) {
    const clientId = args.client_id ?? ctx.uiClientId ?? null;
    if (!clientId) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: 'client_id_required: pass client_id or invoke from a tab-spawned context (ctx.uiClientId).',
        }],
      };
    }
    // F-M7: refuse to dispatch into a UI client owned by another workspace (flag-gated).
    const block = await uiCrossWorkspaceBlock(clientId);
    if (block) {
      return { isError: true, content: [{ type: 'text', text: block }] };
    }
    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const principalSlug = ctx.principal?.slug ?? (ctx.isSuperuser ? 'system:operator' : `agent:${ctx.role ?? 'unknown'}`);
    const result = await dispatchUiIntent({ clientId, intent: args.intent, args: args.args ?? {}, requestedBy: principalSlug, timeoutMs });
    return {
      isError: result.status === 'error' || result.status === 'timeout',
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
