import type { UnifiedToolContext, ToolResult } from '@papercusp/tooldef';
import type { OrchestrationSourceArgs } from '../orchestration/public-contract';

interface DurableCodeArgs {
  script?: string;
  title?: string;
  description?: string;
  inputs?: Record<string, unknown>;
  work_item_id?: string;
  execution?: { lifecycle: 'background'; durability: 'durable'; timeoutSec?: number };
  kernel?: unknown;
  timeoutSec?: number;
  dryRun?: boolean;
}

interface DurableCodeDeps {
  inspect: typeof import('../orchestration/inspect').inspectOrchestration;
  run: typeof import('../orchestration/run').runOrchestration;
}

const reply = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/**
 * code:run only ADMITS a durable run. Reading and cancelling it belong to the orchestration
 * doors that already own those selectors — code:run no longer duplicates them (they cost
 * ~600 B of every seeded catalog, WI-6554700010029562). Admission replies carry this pointer
 * because a compact-tier schema strips property prose, so the reply is where agents learn it.
 */
export const DURABLE_RUN_FOLLOW_UP =
  'Read status/output with orchestrate:inspect { durableRun:{workflowId} }; cancel with ' +
  'orchestrate:run { durableControl:{workflowId,action:"cancel"} } (via tools:invoke if not loaded).';

function withFollowUp(result: ToolResult): ToolResult {
  const index = result.content.findIndex(item => item.type === 'text');
  const item = result.content[index];
  if (!item || item.type !== 'text' || !('text' in item)) return result;
  let parsed: unknown;
  try { parsed = JSON.parse(item.text); } catch { return result; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      (parsed as { state?: unknown }).state !== 'complete') return result;
  const content = [...result.content];
  content[index] = { ...item, text: JSON.stringify({ ...parsed, next: DURABLE_RUN_FOLLOW_UP }) };
  return { ...result, content };
}

/** A convenience door over the existing pinned DBOS workflow, never another executor/store. */
export async function runDurableCode(
  args: DurableCodeArgs,
  ctx: UnifiedToolContext,
  injected?: DurableCodeDeps,
): Promise<ToolResult> {
  if (!args.script || !args.execution || args.kernel || args.timeoutSec !== undefined || args.dryRun) {
    return reply({ ok: false, executed: false, error: 'durable_execution_args_invalid',
      message: 'Pass script with execution. Omit kernel, dryRun and foreground timeoutSec; set execution.timeoutSec for the durable deadline. ' +
        DURABLE_RUN_FOLLOW_UP });
  }
  // Lazy imports avoid the foreground adapter's code:run dependency cycle.
  const deps = injected ?? {
    inspect: (await import('../orchestration/inspect')).inspectOrchestration,
    run: (await import('../orchestration/run')).runOrchestration,
  };

  const request: OrchestrationSourceArgs = {
    script: { source: args.script!, title: args.title, description: args.description,
      ...(args.inputs && Object.keys(args.inputs).length ? { bindingSchema: {
        version: 1,
        properties: Object.fromEntries(Object.keys(args.inputs).map(key => [key,
          { type: 'json', required: true, lifetime: { kind: 'stable' } } ])),
        additionalProperties: false,
      } } : {}),
    },
    execution: { lifecycle: 'background', durability: 'durable' },
    timeoutSec: args.execution!.timeoutSec,
    ...(args.inputs ? { bindings: { values: args.inputs } } : {}),
    ...(args.work_item_id ? { workItemId: args.work_item_id } : {}),
  };
  const inspected = await deps.inspect(request, ctx);
  const data = (inspected as ToolResult & { data?: {
    ok?: boolean;
    normalized?: { durability?: { pin?: OrchestrationSourceArgs['inspectionPin'] } };
  } }).data;
  if (!data?.ok || !data.normalized?.durability?.pin) {
    return reply(data ?? { ok: false, executed: false, error: 'durable_inspection_failed' });
  }
  // The exact immutable source/bindings inspected above are admitted under the same caller.
  // The existing adapter rechecks the pin and replay hazards before enqueuing one workflow.
  return withFollowUp(await deps.run({ ...request, inspectionPin: data.normalized.durability.pin }, ctx));
}
