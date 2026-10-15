---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold44-dependency-callers-and-change-bus-custody-424d5.json"
updated_at: 1791954912625
_body: "content"
---

{
  "schemaVersion": "r13-cold44-dependency-callers-change-bus-custody-v1",
  "capturedAt": "2026-10-14T05:15:05.574Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "reviewAt": "2026-10-10T01:09:46.552Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold43-immutable-dependency-mutation-custody-424d5.json"
  ],
  "callers": {
    "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
    "path": "packages/operator-core/lib/dbos/work-item-deps-store.ts",
    "blob": "5bec54fb42a5bdfafe06a6383dd0d674de1ae46b",
    "sha256": "6fd7345d02d0fb4d642f1fbbcf2a222fa1cbeb94d5d20be74b0791c0761b255f",
    "bytes": 61477,
    "regions": [
      {
        "startLine": 1156,
        "endLine": 1189,
        "text": "export async function mirrorWorkItemBlockingEdge(\n  blocker: WorkItemDepEndpoint,\n  blocked: WorkItemDepEndpoint,\n  opts: WorkItemDependencyWriterOptions = {},\n): Promise<void> {\n  // EI-19387076313999646: resolve BOTH endpoints against their actual target row's family\n  // before writing — closes the link-seam half of D-017 (see resolveActualDepEndpoint above).\n  const sql = opts.sql ?? (getOrgPg().sql as Sql);\n  const [blockerResolution, blockedResolution] = await Promise.all([\n    resolveActualDepEndpoint(sql, blocker),\n    resolveActualDepEndpoint(sql, blocked),\n  ]);\n  const resolvedBlocker = blockerResolution.endpoint;\n  const resolvedBlocked = blockedResolution.endpoint;\n  const edge = workItemBlockingEdge(resolvedBlocker, resolvedBlocked);\n  if (!edge) return;\n  await mutateWorkItemDependencies(\n    {\n      workspaceId: DEFAULT_COORD_WORKSPACE,\n      itemWorkspaceId: mutationItemWorkspaceId([blockedResolution, blockerResolution], opts.itemWorkspaceId),\n      mutations: [\n        {\n          op: 'add',\n          blocked: resolvedBlocked,\n          blocker: resolvedBlocker,\n          createdBy: opts.createdBy,\n          satisfaction: opts.satisfaction,\n        },\n      ],\n    },\n    { sql, retry: opts.retry },\n  );\n}\n\n"
      },
      {
        "startLine": 1191,
        "endLine": 1218,
        "text": "export async function removeMirroredWorkItemBlockingEdge(\n  blocker: WorkItemDepEndpoint,\n  blocked: WorkItemDepEndpoint,\n  opts: WorkItemDependencyWriterOptions = {},\n): Promise<void> {\n  // Same resolution as the write path (EI-19387076313999646): an unlink call passing the\n  // ORIGINAL (possibly mis-declared) kind+ref must still find the CORRECTED row that was\n  // actually inserted, or the edge becomes un-removable through this door.\n  const sql = opts.sql ?? (getOrgPg().sql as Sql);\n  const [blockerResolution, blockedResolution] = await Promise.all([\n    resolveActualDepEndpoint(sql, blocker),\n    resolveActualDepEndpoint(sql, blocked),\n  ]);\n  const resolvedBlocker = blockerResolution.endpoint;\n  const resolvedBlocked = blockedResolution.endpoint;\n  if (!workItemBlockingEdge(resolvedBlocker, resolvedBlocked)) return;\n  await mutateWorkItemDependencies(\n    {\n      workspaceId: DEFAULT_COORD_WORKSPACE,\n      itemWorkspaceId: mutationItemWorkspaceId([blockedResolution, blockerResolution], opts.itemWorkspaceId),\n      mutations: [{ op: 'remove', blocked: resolvedBlocked, blocker: resolvedBlocker }],\n    },\n    { sql, retry: opts.retry },\n  );\n}\n\n/** blocked feature_id → blocker feature_ids (within `harnessSlug`, prefix-stripped). Pure read. */\nexport async function getWorkItemDepBlockers(harnessSlug: string): Promise<Map<string, WorkItemBlockerRequirement[]>> {\n"
      },
      {
        "startLine": 1389,
        "endLine": 1415,
        "text": "  } else {\n    const desiredKeys = new Set(blockers.map(dependencyIdentityKey));\n    for (const { endpoint: blocker } of priorResolutions) {\n      if (!desiredKeys.has(dependencyIdentityKey(blocker))) {\n        mutations.push({ op: 'remove', blocked: blockedResolution.endpoint, blocker });\n      }\n    }\n    for (const blocker of blockers) {\n      mutations.push({\n        op: 'add', blocked: blockedResolution.endpoint, blocker,\n        createdBy: opts.createdBy, satisfaction: opts.satisfaction,\n      });\n    }\n  }\n  if (mutations.length === 0) return;\n  await mutateWorkItemDependencies(\n    {\n      workspaceId: DEFAULT_COORD_WORKSPACE,\n      itemWorkspaceId: mutationItemWorkspaceId(\n        [blockedResolution, ...blockerResolutions, ...priorResolutions], opts.itemWorkspaceId,\n      ),\n      mutations,\n    },\n    { sql, retry: opts.retry },\n  );\n}\n"
      }
    ]
  },
  "adjacent": [
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/issues-engineer.ts",
      "blob": "f2fa2f96340697b1474b6f83538ff2277a1e9581",
      "sha256": "6fce05df2ae03bab27ffcbf5a561885c1a8bed4983fa1a6eb185302bcc1792ad",
      "bytes": 250448,
      "regions": [
        {
          "startLine": 4304,
          "endLine": 4333,
          "text": "  await subs.unsubscribe(subscriberId, 'object', `${ISSUE_KIND}:${id}`);\n}\n\n/** Linkable.link — an issue→target edge (rel 'blocks' | 'relates' | 'duplicates' | …). Phase 2. */\nexport async function linkIssue(\n  id: string,\n  dst: ObjectRef,\n  rel: string,\n  by?: string,\n  satisfaction?: 'settled' | 'success',\n): Promise<void> {\n  const src = issueRef(id);\n  if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {\n    await mirrorWorkItemBlockingEdge(src, dst, { createdBy: by, satisfaction });\n  } else {\n    // Non-work blocks (plan items/events) and every other relation remain on the\n    // polymorphic coord_links substrate.\n    await linkIssueRelationBounded(src, dst, rel, by);\n  }\n}\nexport async function unlinkIssue(id: string, dst: ObjectRef, rel: string): Promise<void> {\n  const src = issueRef(id);\n  if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {\n    await removeMirroredWorkItemBlockingEdge(src, dst);\n  } else {\n    await unlinkIssueRelationBounded(src, dst, rel);\n  }\n}\n\n/** One outbound edge from an issue, as {@link issuesOutLinksMany} returns it. */\n"
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/work-items.ts",
      "blob": "4c77ff596624734f6e6728305b7eb44077858af4",
      "sha256": "449b2a83d02eb1b6f374f2ef20e8335ef0d2fdcd053f3275380b3fba8893569e",
      "bytes": 579866,
      "regions": [
        {
          "startLine": 9946,
          "endLine": 9960,
          "text": "    return { error: `feature target ref must be '<harness>#<id>' (got '${dst.ref}')` };\n  }\n  if (wi.family === 'issue') {\n    await linkIssue(id, dst, rel, opts.by, opts.satisfaction);\n  } else {\n    const src = workItemObjectRef(wi);\n    if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {\n      await mirrorWorkItemBlockingEdge(src, dst, { createdBy: opts.by, satisfaction: opts.satisfaction });\n    } else {\n      await linkFeatureRelationBounded(src, dst, rel, opts.by);\n    }\n  }\n  if (rel === 'blocks') await syncDerivedBlockerSubscriptions(dst);\n  if (rel === 'blocks') {\n    const dependentRef = await import('./work-items-events').then((m) => m.workItemIdFromRef(dst));\n"
        },
        {
          "startLine": 9977,
          "endLine": 9986,
          "text": "  if (!wi) return { error: `work_item '${id}' not found` };\n  if (wi.family === 'issue') await unlinkIssue(id, dst, rel);\n  else {\n    const src = workItemObjectRef(wi);\n    if (rel === 'blocks' && (dst.kind === 'issue' || dst.kind === 'feature')) {\n      await removeMirroredWorkItemBlockingEdge(src, dst);\n    } else {\n      await unlinkFeatureRelationBounded(src, dst, rel);\n    }\n  }\n"
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/dbos/feature-blockers-edges.ts",
      "blob": "c0013cc871ac264073699b2ba3f2d68abf3bfb99",
      "sha256": "b169a9404383199d2c396dff3414bfbd4c6d0f476fd2cb0393c1a5f72ad3c6b0",
      "bytes": 7989,
      "regions": [
        {
          "startLine": 56,
          "endLine": 65,
          "text": " * either admitted by the same policy or is an explicitly capability-confined SQL migration.\n */\nexport async function syncFeatureBlockEdges(\n  harnessSlug: string,\n  featureId: string,\n  blockedBy: readonly string[],\n  opts: WorkItemDependencyWriterOptions = {},\n): Promise<void> {\n  await syncWorkItemDepEdges(harnessSlug, featureId, blockedBy, opts);\n}\n"
        }
      ]
    },
    {
      "commit": "4a430f1e4f53f397d2687b92f3df34065aad9f7c",
      "path": "libs/db/sql/1365-unify-work-item-dep-change-notify.sql",
      "blob": "06a2ea0005c5fb2b383bb6babaf54adb83319af3",
      "sha256": "dd4ab2c8a8864ee300a4049e675586c192c57b3b44066938c27be8fab00422fd",
      "bytes": 1399,
      "regions": [
        {
          "startLine": 1,
          "endLine": 34,
          "text": "-- WI-10006171: 1109 added a generic notifier beside 367's semantic producer.\n-- Keep one notification with both dependency refs and generic row-routing fields.\n-- Reuse the existing producer and trigger; no table or data shape changes.\nCREATE OR REPLACE FUNCTION harness_shared.emit_work_item_dep_change_notify()\nRETURNS trigger LANGUAGE plpgsql AS $$\nDECLARE\n  row_jsonb jsonb := to_jsonb(COALESCE(NEW, OLD));\nBEGIN\n  PERFORM pg_notify('sync_invalidate', jsonb_build_object(\n    'name', 'harness_shared.work_item_deps.changed',\n    'args', jsonb_build_object(\n      'workspace_id', current_setting('app.workspace_id', true),\n      'op', TG_OP,\n      'id', row_jsonb -> 'id',\n      'plan_slug', row_jsonb -> 'plan_slug',\n      'harness_slug', row_jsonb -> 'harness_slug',\n      'dep_type', row_jsonb -> 'dep_type',\n      'blocked_kind', row_jsonb -> 'blocked_kind',\n      'blocked_ref', row_jsonb -> 'blocked_ref',\n      'blocker_kind', row_jsonb -> 'blocker_kind',\n      'blocker_ref', row_jsonb -> 'blocker_ref'\n    )\n  )::text);\n  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n  RETURN NEW;\nEND;\n$$;\n\nCREATE OR REPLACE TRIGGER emit_work_item_dep_change_notify_trg\n  AFTER INSERT OR UPDATE OR DELETE ON harness_shared.work_item_deps\n  FOR EACH ROW EXECUTE FUNCTION harness_shared.emit_work_item_dep_change_notify();\n\nDROP TRIGGER IF EXISTS emit_change_notify_trg ON harness_shared.work_item_deps;\n"
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/sync-sse.ts",
      "blob": "563b05028fa22b98ceab197997756625033785ea",
      "sha256": "b8f39460359ad834b9d08bafd3ad85f7fc6d61ae66e715e461ce2935b75f3429",
      "bytes": 16239,
      "regions": [
        {
          "startLine": 139,
          "endLine": 150,
          "text": "    emitSystemEvent({ tool: name, args: args ?? {}, ...(ws ? { workspaceId: ws } : {}) });\n  }\n  return queryNamesForTriggerEvent(name, args);\n}\n\n// These query names are low-volume control-plane projections of an agent's\n// posture. Their `agent_modes.changed` trigger is meaningful and should reach\n// an open popup promptly, but the same targets are also bridged from hot\n// sources such as coord_presence. Keep the override keyed by SOURCE + TARGET:\n// lowering a target-wide window would re-arm the heartbeat invalidate storm\n// that the bus's 90s default is designed to contain (WI-840/WI-37446).\nconst LOW_VOLUME_AGENT_MODE_QUERY_NAMES = new Set([\n"
        }
      ]
    },
    {
      "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
      "path": "packages/operator-core/lib/events/engine.ts",
      "blob": "744cf7dd67ab8c5b80da75bde9e582d621a2cbb1",
      "sha256": "0f386fa21c551a8519d0d9d170fc53a16074e4ecb1239bfc11e9e394120234a2",
      "bytes": 12570,
      "regions": [
        {
          "startLine": 113,
          "endLine": 132,
          "text": "      emit: () => {},\n      signal: new AbortController().signal,\n    } as unknown as UnifiedToolContext;\n    event = {\n      tool: opts.tool,\n      args: opts.args ?? {},\n      result: { ok: true, data: opts.args ?? {} },\n      ctx,\n      ...(opts.cause ? { cause: opts.cause } : {}),\n    };\n  } catch (err) {\n     \n    console.warn(`[events] system-event build failed for ${opts.tool}: ${err instanceof Error ? err.message : String(err)}`);\n    return;\n  }\n  matchAndRun(event);\n}\n\n/**\n * D-007 (bulk-endpoint-standardization-2026-06-21) — fan a bulk-envelope event\n"
        },
        {
          "startLine": 238,
          "endLine": 259,
          "text": "\n  let actions: Array<MatchedAction<ToolInvocationEvent, string>>;\n  try {\n    actions = matchReactions(event);\n  } catch (err) {\n    // Matching must never break the trigger. (Pure code; defensive.)\n     \n    console.warn(`[events] match failed for ${event.tool}: ${err instanceof Error ? err.message : String(err)}`);\n    return;\n  }\n  if (actions.length === 0) return;\n\n  // Hand off to the generic engine. It owns success-gate + loop-guard + the\n  // durable-vs-in-process scheduling (with in-process fallback); we inject the\n  // Papercusp dispatcher + durable seam and map our event fields onto its ports.\n  runReactions<ToolInvocationEvent, string>({\n    actions,\n    event,\n    succeeded: event.result.ok,\n    cause: event.cause,\n    rootRunId: event.ctx.runId ?? null,\n    fireInProcess: ({ fire, args, event: ev, cause, capability }) =>\n"
        }
      ]
    }
  ],
  "datedLoggedLinkRead": {
    "arguments": {
      "sql": "SELECT id,invoked_at,tool_name,status,args_json,serving_build_sha FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND invoked_at BETWEEN '2026-10-09T00:00:00Z' AND '2026-10-10T16:00:36.515Z' AND tool_name IN ('work_items:link','issues:link') AND (args_json->>'id'='EI-25477838487191856' OR args_json->>'source_id'='EI-25477838487191856' OR args_json->>'target_id'='EI-25477838487191856' OR args_json->>'target_ref'='EI-25477838487191856' OR args_json @> '{\"items\":[{\"id\":\"EI-25477838487191856\"}]}'::jsonb OR args_json @> '{\"items\":[{\"target_id\":\"EI-25477838487191856\"}]}'::jsonb OR args_json @> '{\"items\":[{\"target_ref\":\"EI-25477838487191856\"}]}'::jsonb) ORDER BY invoked_at,id",
      "positiveControlSql": "SELECT id,invoked_at,tool_name,status FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND invoked_at BETWEEN '2026-10-09T00:00:00Z' AND '2026-10-10T16:00:36.515Z' AND tool_name IN ('work_items:link','issues:link') ORDER BY invoked_at LIMIT 1",
      "allowUnscoped": false,
      "maxRows": 40,
      "timeoutMs": 15000
    },
    "result": {
      "error": "canceling statement due to statement timeout",
      "code": "57014",
      "advisory": "ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
      "_meta": {
        "explicitFullRequest": true
      },
      "ok": false
    }
  },
  "currentLiveFunctions": {
    "mode": "query",
    "rowCount": 2,
    "truncated": false,
    "fields": [
      "schema",
      "name",
      "definition"
    ],
    "elapsedMs": 238,
    "rows": [
      {
        "schema": "harness_shared",
        "name": "emit_work_item_dep_change_notify",
        "definition": "CREATE OR REPLACE FUNCTION harness_shared.emit_work_item_dep_change_notify()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n  row_jsonb jsonb := to_jsonb(COALESCE(NEW, OLD));\nBEGIN\n  PERFORM pg_notify('sync_invalidate', jsonb_build_object(\n    'name', 'harness_shared.work_item_deps.changed',\n    'args', jsonb_build_object(\n      'workspace_id', current_setting('app.workspace_id', true),\n      'op', TG_OP,\n      'id', row_jsonb -> 'id',\n      'plan_slug', row_jsonb -> 'plan_slug',\n      'harness_slug', row_jsonb -> 'harness_slug',\n      'dep_type', row_jsonb -> 'dep_type',\n      'blocked_kind', row_jsonb -> 'blocked_kind',\n      'blocked_ref', row_jsonb -> 'blocked_ref',\n      'blocker_kind', row_jsonb -> 'blocker_kind',\n      'blocker_ref', row_jsonb -> 'blocker_ref'\n    )\n  )::text);\n  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;\n  RETURN NEW;\nEND;\n$function$\n"
      },
      {
        "schema": "harness_shared",
        "name": "wir_deps_sync",
        "definition": "CREATE OR REPLACE FUNCTION harness_shared.wir_deps_sync()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nDECLARE\n    v_ref text := COALESCE(NEW.blocked_ref, OLD.blocked_ref);\n    r     record;\nBEGIN\n    IF COALESCE(NEW.dep_type, OLD.dep_type) <> 'blocks' THEN\n        RETURN COALESCE(NEW, OLD);\n    END IF;\n    FOR r IN\n        SELECT f.workspace_id, f.harness_slug, f.feature_id\n          FROM harness_shared.work_items f\n         WHERE f.item_kind <> ALL (ARRAY['bug','change','task'])\n           AND (f.harness_slug || '#' || f.feature_id) = v_ref\n    LOOP\n        PERFORM harness_shared.sync_work_item_blocked(r.workspace_id, r.harness_slug, r.feature_id);\n    END LOOP;\n    RETURN COALESCE(NEW, OLD);\n-- Best-effort: a readiness-sync error must NEVER wedge the underlying edge write. Drift is caught\n-- by the inline-predicate oracle + the reconciliation sweep; the claim falls back to the inline\n-- predicate while the flag is off.\nEXCEPTION WHEN OTHERS THEN\n    RAISE WARNING 'wir_deps_sync: readiness sync failed (non-fatal): %', SQLERRM;\n    RETURN COALESCE(NEW, OLD);\nEND;\n$function$\n"
      }
    ],
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "work_items:claimable"
        },
        {
          "tool": "plans:list"
        },
        {
          "tool": "db:migrations"
        },
        {
          "tool": "testing:runs"
        },
        {
          "tool": "issues:list / work_items:get"
        },
        {
          "tool": "dev:pg_active_queries"
        },
        {
          "tool": "dev:pg_table_sizes"
        },
        {
          "tool": "dev:pg_health"
        }
      ]
    }
  },
  "preserved": {
    "originalCohort": 116,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "cutoffContinuityAccepted": 0,
    "eligibilityFrozen": 0,
    "outcomesJoined": 0
  },
  "assessment": {
    "facades": "The three direct production callers at cf57965610 await and discard mutateWorkItemDependencies return values. The inspected link/sync wrappers return void or ok; no returned telemetry persistence exists in these inspected functions.",
    "changeBus": "Immutable submodule 4a430f1e migration1365 emits sync_invalidate notifications containing operation and dependency refs. Immutable sync-sse bridge calls emitSystemEvent, whose engine matches and schedules reactions; no general append-only event history write is shown in these inspected functions. Matched downstream rules, other writers and historical loaded runtime are outside this bounded proof.",
    "datedCalls": "No retained matching work_items:link or issues:link call for the exact subject from Oct9 start to frozen cutoff; positive control34289423 passed. The result excludes only matching retained calls covered by the query, not direct SQL, migrations, other verbs, deleted/missing logs or unrecognized envelopes.",
    "eligibility": "Current surviving edges and these scoped logged calls cannot establish historical whole-work dependency absence. ec24 remains review-open; no eligibility or outcome join accepted."
  },
  "next": [
    "Prioritize the independent other110 whole-cohort eligibility cases from Cold33 and Cold32v2, without waiting for ec24.",
    "Keep ec24 unresolved unless genuinely new dated loaded-runtime/control/dependency evidence appears; do not repeat this source trace or already unavailable spill reads.",
    "Freeze whole116 eligibility with explicit custody limits before recovery outcome joins."
  ],
  "limits": [
    "No source edits, product tests, native receipt acquisition or replay, restore, account change, executor change or LIVE_GATE_OPS.",
    "Archived source is content custody at an early build; it does not prove it was loaded throughout Oct10 review-to-cutoff."
  ]
}
