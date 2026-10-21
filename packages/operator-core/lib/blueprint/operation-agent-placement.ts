/**
 * Automatic applied-worker placement for accepted AGENT operations
 * (WI-10006859; plan app-agent-tasks-durable-execution-2026-10-06 D-017).
 *
 * An accepted blueprint operation whose `execution.kind` is `'agent'` can be
 * claimed only by its applied worker: a role session launched as
 * `psu --role <execution.role> --feature <target item> --harness <operation
 * harness>`, which bootstrap-role binds through
 * resolveAcceptedOperationWorkerBinding. That binding stays the sole trust
 * path; this module only starts the session that asks for it.
 *
 * Shape (mirrors the program scan in coord-program-workflow.ts):
 *  1. retire receipts that can never be placed again (not an agent operation,
 *     target terminal or missing, attempts exhausted);
 *  2. claim up to `limit` placeable receipts with ONE conditional
 *     UPDATE ... RETURNING under a transaction advisory lock, so two hosts
 *     running the routines tick cannot place the same receipt twice;
 *  3. launch one headless worker per claimed receipt.
 *
 * The claim is written before the launch, so a crash between the two costs a
 * retry window, never a duplicate worker. A receipt is re-placed only after
 * `retryAfterSec` AND only when its previous worker is no longer live, and at
 * most `maxAttempts` times in total.
 */
import type { Sql } from 'postgres';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import type { AcceptedOperationWorkerBinding } from './operation-worker-binding';

export const AGENT_PLACEMENT_LOCK_KEY = 'blueprint-agent-operation-placement';

export interface AgentPlacementOptions {
  /** Most receipts claimed per pass. */
  limit?: number;
  /** Most live placed workers per workspace, counting ones still booting. */
  perWorkspaceLive?: number;
  /** Seconds before a receipt whose worker is gone may be placed again. */
  retryAfterSec?: number;
  /** Total launch attempts per receipt before placement gives up. */
  maxAttempts?: number;
}

export const AGENT_PLACEMENT_DEFAULTS: Required<AgentPlacementOptions> = {
  limit: 4,
  perWorkspaceLive: 4,
  retryAfterSec: 600,
  maxAttempts: 3,
};

export interface AgentOperationPlacement {
  receiptId: number;
  workspaceId: string;
  /** The operation's harness: the `--harness` the worker binds against. */
  harnessSlug: string;
  operationId: string;
  specificationRevision: string;
  workItemId: string;
  role: string;
  /** Pre-pinned coord owner id for the worker this attempt launches. */
  ownerId: string;
  /** 1-based attempt number this claim consumed. */
  attempt: number;
  /** Model authority from the same immutable operation snapshot, never caller launch args. */
  modelPolicy?: AcceptedOperationWorkerBinding['modelPolicy'];
}

function resolveOptions(opts: AgentPlacementOptions): Required<AgentPlacementOptions> {
  const o = { ...AGENT_PLACEMENT_DEFAULTS, ...opts };
  for (const [key, value, max] of [
    ['limit', o.limit, 100],
    ['perWorkspaceLive', o.perWorkspaceLive, 100],
    ['retryAfterSec', o.retryAfterSec, 86_400],
    ['maxAttempts', o.maxAttempts, 100],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > max) {
      throw new Error(`agent placement ${key} must be an integer 1..${max}`);
    }
  }
  return o;
}

/** Retire unplaceable receipts, then claim the placeable ones. */
export async function claimAgentOperationPlacements(
  sql: Sql,
  opts: AgentPlacementOptions = {},
): Promise<AgentOperationPlacement[]> {
  const o = resolveOptions(opts);
  const terminal = ANY_FAMILY_TERMINAL_STATES as string[];
  const rows = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${AGENT_PLACEMENT_LOCK_KEY}))`;

    await tx`
      UPDATE harness_shared.blueprint_operation_invocations i
         SET agent_placement_retired_at = now()
       WHERE i.target_kind = 'work-item'
         AND i.agent_placement_retired_at IS NULL
         AND (
           -- Not an agent operation in its pinned specification, or one with no
           -- pinned worker identity: bootstrap-role refuses to bind such a
           -- worker ('has no pinned worker identity'), so a launch only fails.
           NOT EXISTS (
             SELECT 1 FROM harness_shared.blueprint_specifications s
              CROSS JOIN LATERAL jsonb_array_elements(s.artifact->'configuration'->'operations') op
              WHERE s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
                AND s.specification_revision = i.specification_revision
                AND op->>'id' = i.operation_id
                AND op->'execution'->>'kind' = 'agent'
                AND jsonb_typeof(op->'policy'->'identity') = 'object')
           -- Target item terminal, gone, or its operation cancelled (cancellation
           -- is recorded as payload.blueprintCancellation; the item can stay open).
           OR NOT EXISTS (
             SELECT 1 FROM harness_shared.work_items wi
              WHERE wi.workspace_id = i.workspace_id
                AND wi.harness_slug IN (COALESCE(i.target_harness_slug, i.harness_slug),
                                        'harness:' || i.harness_slug)
                AND wi.feature_id = i.target_ref
                AND wi.status <> ALL(${terminal}::text[])
                AND COALESCE(wi.payload->'blueprintCancellation', 'null'::jsonb)
                    IN ('null'::jsonb, 'false'::jsonb))
           -- Attempts exhausted, and the last worker has had its window and is gone.
           OR (i.agent_launch_attempts >= ${o.maxAttempts}
               AND i.agent_last_launch_at <= now() - make_interval(secs => ${o.retryAfterSec})
               AND NOT EXISTS (
                 SELECT 1 FROM harness_shared.adv_sessions s
                  WHERE s.workspace_id = i.workspace_id
                    AND s.coord_owner_id = i.agent_launch_owner_id
                    AND s.ended_at IS NULL AND s.ended_by IS NULL))
         )
    `;

    return tx<Array<{
      receipt_id: string; workspace_id: string; harness_slug: string; operation_id: string;
      specification_revision: string; work_item_id: string; role: string;
      owner_id: string; attempt: number;
      model_policy: AcceptedOperationWorkerBinding['modelPolicy'] | null;
    }>>`
      WITH live AS (
        SELECT i.workspace_id, count(*)::int AS n
          FROM harness_shared.blueprint_operation_invocations i
         WHERE i.target_kind = 'work-item'
           AND i.agent_placement_retired_at IS NULL
           AND i.agent_launch_owner_id IS NOT NULL
           AND (i.agent_last_launch_at > now() - make_interval(secs => ${o.retryAfterSec})
                OR EXISTS (
                  SELECT 1 FROM harness_shared.adv_sessions s
                   WHERE s.workspace_id = i.workspace_id
                     AND s.coord_owner_id = i.agent_launch_owner_id
                     AND s.ended_at IS NULL AND s.ended_by IS NULL))
         GROUP BY i.workspace_id
      ), eligible AS (
        SELECT i.id, wi.feature_id AS work_item_id, op->'execution'->>'role' AS role,
               op->'policy'->'model' AS model_policy,
               row_number() OVER (PARTITION BY i.workspace_id ORDER BY i.id) AS rank,
               i.workspace_id
          FROM harness_shared.blueprint_operation_invocations i
          JOIN harness_shared.work_items wi
            ON wi.workspace_id = i.workspace_id
           AND wi.harness_slug IN (COALESCE(i.target_harness_slug, i.harness_slug),
                                   'harness:' || i.harness_slug)
           AND wi.feature_id = i.target_ref
          JOIN harness_shared.blueprint_specifications s
            ON s.workspace_id = i.workspace_id AND s.harness_slug = i.harness_slug
           AND s.specification_revision = i.specification_revision
          CROSS JOIN LATERAL jsonb_array_elements(s.artifact->'configuration'->'operations') op
         WHERE i.target_kind = 'work-item'
           AND i.agent_placement_retired_at IS NULL
           AND i.agent_launch_attempts < ${o.maxAttempts}
           AND (i.agent_last_launch_at IS NULL
                OR i.agent_last_launch_at <= now() - make_interval(secs => ${o.retryAfterSec}))
           AND NOT EXISTS (
             SELECT 1 FROM harness_shared.adv_sessions ls
              WHERE ls.workspace_id = i.workspace_id
                AND ls.coord_owner_id = i.agent_launch_owner_id
                AND ls.ended_at IS NULL AND ls.ended_by IS NULL)
           AND wi.status <> ALL(${terminal}::text[])
           AND wi.taken_by IS NULL
           -- A human-audience item can never be claimed by an agent worker; it
           -- stays unretired so a later reclassification makes it placeable.
           AND wi.audience IS DISTINCT FROM 'human'
           -- Same reading as operation-service: a null/false mark is not a cancellation.
           AND COALESCE(wi.payload->'blueprintCancellation', 'null'::jsonb) IN ('null'::jsonb, 'false'::jsonb)
           AND jsonb_typeof(op->'policy'->'identity') = 'object'
           AND wi.payload->'blueprintOperation'->>'operationId' = i.operation_id
           AND wi.payload->'blueprintOperation'->>'specificationRevision' = i.specification_revision
           AND op->>'id' = i.operation_id
           AND op->'execution'->>'kind' = 'agent'
           AND op->'target'->>'kind' = 'work-item'
           AND jsonb_typeof(op->'execution'->'role') = 'string'
      ), picked AS (
        SELECT e.id, e.work_item_id, e.role, e.model_policy
          FROM eligible e
          LEFT JOIN live l ON l.workspace_id = e.workspace_id
         WHERE e.rank + COALESCE(l.n, 0) <= ${o.perWorkspaceLive}
         ORDER BY e.id
         LIMIT ${o.limit}
      )
      UPDATE harness_shared.blueprint_operation_invocations i
         SET agent_launch_attempts = i.agent_launch_attempts + 1,
             agent_last_launch_at = now(),
             agent_launch_owner_id = 'su-' || gen_random_uuid()::text
        FROM picked p
       WHERE i.id = p.id
      RETURNING i.id::text AS receipt_id, i.workspace_id, i.harness_slug, i.operation_id,
                i.specification_revision, p.work_item_id, p.role, p.model_policy,
                i.agent_launch_owner_id AS owner_id, i.agent_launch_attempts AS attempt
    `;
  });

  return rows.map((row) => {
    const receiptId = Number(row.receipt_id);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0 || !row.role?.trim() ||
        !row.work_item_id || !row.owner_id) {
      throw new Error('accepted agent operation placement candidate is malformed');
    }
    return {
      receiptId,
      workspaceId: row.workspace_id,
      harnessSlug: row.harness_slug,
      operationId: row.operation_id,
      specificationRevision: row.specification_revision,
      workItemId: row.work_item_id,
      role: row.role.trim(),
      ownerId: row.owner_id,
      attempt: Number(row.attempt),
      ...(row.model_policy ? {
        modelPolicy: row.model_policy as AcceptedOperationWorkerBinding['modelPolicy'],
      } : {}),
    };
  }).sort((a, b) => a.receiptId - b.receiptId);
}

/** The first turn a placed worker receives. Its role persona and the bound
 * operation carry the substance; this only points it at its one item. */
export function buildAgentPlacementKickoff(p: AgentOperationPlacement): string {
  return [
    `You were launched automatically as the applied worker for accepted blueprint operation ` +
      `"${p.operationId}" (receipt ${p.receiptId}, harness ${p.harnessSlug}).`,
    `Your one work item is ${p.workItemId}. Claim it with work_items:claim, read its ` +
      `blueprintOperation input with work_items:get, do the operation as your role defines it, ` +
      `and close it with work_items:complete including evidence.`,
    `Do not take any other work. If you cannot complete it, record the blocker on ${p.workItemId} ` +
      `and release it, so the next placement attempt starts from your notes.`,
  ].join('\n\n');
}

export interface AgentPlacementLaunchResult {
  ok: boolean;
  detail?: string;
}

export type AgentPlacementLauncher = (p: AgentOperationPlacement) => Promise<AgentPlacementLaunchResult>;

export interface AgentPlacementPassResult {
  claimed: number;
  launched: number;
  failed: Array<{ receiptId: number; workItemId: string; detail: string }>;
}

/** One placement pass: claim, then launch each claimed receipt. A launch
 * failure keeps its consumed attempt, so a broken receipt stops after
 * `maxAttempts` instead of relaunching forever. */
export async function placeAcceptedAgentOperations(
  sql: Sql,
  deps: { launch: AgentPlacementLauncher; options?: AgentPlacementOptions },
): Promise<AgentPlacementPassResult> {
  const claimed = await claimAgentOperationPlacements(sql, deps.options);
  const result: AgentPlacementPassResult = { claimed: claimed.length, launched: 0, failed: [] };
  for (const placement of claimed) {
    let outcome: AgentPlacementLaunchResult;
    try {
      outcome = await deps.launch(placement);
    } catch (error) {
      outcome = { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.ok) result.launched += 1;
    else {
      result.failed.push({
        receiptId: placement.receiptId,
        workItemId: placement.workItemId,
        detail: outcome.detail ?? 'the launcher reported no detail',
      });
    }
  }
  return result;
}

/** Production launcher: the same fresh headless door goal-auto-start and
 * consult-dispatch use (buildConsoleEnvelope -> buildAgentLaunchCommand ->
 * spawnHeadless), with the operation's role and target item as the
 * `--role/--feature` pair bootstrap-role binds. */
export const launchAgentOperationWorker: AgentPlacementLauncher = async (p) => {
  let agent: 'claude' | 'codex' = 'claude';
  let model: string | undefined;
  if (p.modelPolicy) {
    const { selectAcceptedOperationWorkerModel } = await import('./operation-worker-binding');
    const errors: string[] = [];
    // Validate the SAME first pinned model on its native backend. This never
    // substitutes another model, including under an allowed/preferred policy,
    // and does not turn an unavailable-account policy into implicit failover.
    for (const backend of ['codex', 'claude'] as const) {
      try {
        const selected = selectAcceptedOperationWorkerModel({ modelPolicy: p.modelPolicy }, null, backend);
        if (selected) {
          agent = backend;
          model = selected.model;
          break;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!model) throw new Error(`accepted operation model has no supported native backend: ${errors.join('; ')}`);
  }
  const [{ buildConsoleEnvelope }, { spawnHeadless }, { resolveSpawnHostOperatorBaseUrl },
    { buildAgentLaunchCommand, injectLaunchedByArg }, { papercuspPathForWorkspace }, { join }] =
    await Promise.all([
      import('../console-launcher'),
      import('../console-spawn'),
      import('../mcp-base-url'),
      import('../agent-launch-core'),
      import('../papercusp-root'),
      import('node:path'),
    ]);
  const operatorBaseUrl = resolveSpawnHostOperatorBaseUrl();
  const base = await buildConsoleEnvelope({
    workspaceId: p.workspaceId,
    slug: p.harnessSlug,
    operatorBaseUrl,
    // The accepted snapshot must be replayed by the admitting runtime. The
    // background host's ordinary long-lived agent endpoint can serve an older
    // schema that cannot replay that snapshot.
    agentMcpBaseUrl: operatorBaseUrl,
    skipMcpJson: false,
  });
  let command = buildAgentLaunchCommand({
    mode: 'fresh',
    agent,
    ...(model ? { model } : {}),
    account: 'auto',
    harness: p.harnessSlug,
    workspace: p.workspaceId,
    ownerId: p.ownerId,
    role: p.role,
    feature: p.workItemId,
    headless: true,
  });
  command = injectLaunchedByArg(command, `system:${AGENT_PLACEMENT_LOCK_KEY}`).command;
  const spawned = await spawnHeadless({
    envelope: {
      ...base,
      env: {
        ...base.env,
        PAPERCUSP_ACCOUNT_ROUTING_MODE: 'auto',
        PAPERCUSP_KICKOFF_PROMPT: buildAgentPlacementKickoff(p),
      },
      greetingCmd: command,
      cwd: base.cwd,
    },
    label: `${p.role} · ${p.workItemId} (placed)`,
    logDir: join(papercuspPathForWorkspace(p.workspaceId), 'fleet-logs'),
    coordOwnerId: p.ownerId,
    launchedBy: `system:${AGENT_PLACEMENT_LOCK_KEY}`,
  });
  if (spawned.status !== 'ok') {
    return { ok: false, detail: 'error' in spawned && spawned.error ? String(spawned.error) : 'spawn failed' };
  }
  return { ok: true };
};
