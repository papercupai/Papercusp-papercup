---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold43-immutable-dependency-mutation-custody-424d5.json"
updated_at: 1791953896006
_body: "content"
---

{
  "schemaVersion": "r13-cold43-immutable-dependency-mutation-custody-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "route": "Same approved SELF/AUTO/P-013/account/cold",
  "subject": "su-ec24b79e-fb5f-4056-847e-c1bd3edfec3a",
  "reviewAt": "2026-10-10T01:09:46.552Z",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold39-dependency-scope-and-expanded-controls-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold40-original-disk-pipeline-source-custody-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold42-original-routine-output-retention-custody-v2-424d5.json"
  ],
  "immutableSource": {
    "observedAt": "2026-10-14T04:57:18.341738+00:00",
    "commit": "cf57965610278cd8d8183d6a4b12160d127da3c3",
    "path": "packages/operator-core/lib/dbos/work-item-deps-store.ts",
    "blob": "5bec54fb42a5bdfafe06a6383dd0d674de1ae46b",
    "sha256": "6fd7345d02d0fb4d642f1fbbcf2a222fa1cbeb94d5d20be74b0791c0761b255f",
    "bytes": 61477,
    "regions": [
      {
        "firstLine": 532,
        "lastLine": 577,
        "text": "async function applyStoredEdgeDiff(\n  tx: Sql,\n  workspaceId: string,\n  before: readonly StoredDependencyEdge[],\n  after: readonly StoredDependencyEdge[],\n): Promise<{ inserted: number; removed: number }> {\n  const beforeByKey = new Map(before.map((edge) => [storedEdgeKey(edge), edge]));\n  const afterByKey = new Map(after.map((edge) => [storedEdgeKey(edge), edge]));\n  const removed = [...beforeByKey.entries()].filter(([key]) => !afterByKey.has(key)).map(([, edge]) => edge);\n  const inserted = [...afterByKey.entries()].filter(([key]) => !beforeByKey.has(key)).map(([, edge]) => edge);\n  const updated = [...afterByKey.entries()]\n    .filter(([key, edge]) => beforeByKey.has(key) && beforeByKey.get(key)!.satisfaction !== edge.satisfaction)\n    .map(([, edge]) => edge);\n\n  let removedCount = 0;\n  for (const edge of removed) {\n    const rows = await tx<Array<{ id: string | number }>>`\n      DELETE FROM harness_shared.work_item_deps\n       WHERE workspace_id = ${workspaceId} AND dep_type = 'blocks'\n         AND blocked_kind = ${edge.blocked.kind} AND blocked_ref = ${edge.blocked.ref}\n         AND blocker_kind = ${edge.blocker.kind} AND blocker_ref = ${edge.blocker.ref}\n      RETURNING id`;\n    removedCount += rows.length;\n  }\n  let insertedCount = 0;\n  for (const edge of inserted) {\n    const rows = await tx<Array<{ id: string | number }>>`\n      INSERT INTO harness_shared.work_item_deps\n        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, created_by, satisfaction)\n      VALUES\n        (${workspaceId}, ${edge.blocked.kind}, ${edge.blocked.ref},\n         ${edge.blocker.kind}, ${edge.blocker.ref}, 'blocks', ${edge.createdBy}, ${edge.satisfaction})\n      ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)\n      DO NOTHING\n      RETURNING id`;\n    insertedCount += rows.length;\n  }\n  for (const edge of updated) {\n    await tx`\n      UPDATE harness_shared.work_item_deps\n         SET satisfaction = ${edge.satisfaction}\n       WHERE workspace_id = ${workspaceId} AND dep_type = 'blocks'\n         AND blocked_kind = ${edge.blocked.kind} AND blocked_ref = ${edge.blocked.ref}\n         AND blocker_kind = ${edge.blocker.kind} AND blocker_ref = ${edge.blocker.ref}`;\n  }\n  return { inserted: insertedCount, removed: removedCount };"
      },
      {
        "firstLine": 581,
        "lastLine": 650,
        "text": " * Canonical dependency mutation boundary (dependency-graph-admission P-005).\n *\n * The complete read → candidate → analyse → write sequence runs in one\n * SERIALIZABLE transaction. Validation is delta-based: existing invalid data may\n * be repaired or left unchanged, while a mutation that introduces a new SCC,\n * endpoint defect, or stranded nonterminal node is rejected before any write.\n */\nexport async function mutateWorkItemDependencies(\n  input: WorkItemDependencyBatchInput,\n  opts: { sql?: Sql; retry?: SerializableRetryOptions } = {},\n): Promise<WorkItemDependencyBatchResult> {\n  const startedAt = performance.now();\n  const sql = opts.sql ?? (getOrgPg().sql as Sql);\n  return withWorkItemDependencyAdmissionTransaction(\n    sql,\n    async (tx) => {\n      const itemWorkspaceId = input.itemWorkspaceId ?? input.workspaceId;\n      await lockDependencyMutationEndpoints(tx, itemWorkspaceId, input.mutations);\n      const current = await loadStoredDependencyEdges(tx, input.workspaceId);\n      const candidate = applyDependencyMutations(current, input.mutations);\n      const { nodes, lifecycleRows, outOfScopeIdentityKeys } = await loadDependencyNodes(tx, itemWorkspaceId, [\n        ...current,\n        ...candidate,\n      ]);\n      const before = analyseStoredEdges(nodes, current);\n      const after = analyseStoredEdges(nodes, candidate);\n      const findings = newlyRejectedFindings(before, after, current, candidate, outOfScopeIdentityKeys);\n      const lifecycleConflicts = newlyActiveDependantConflicts(current, candidate, lifecycleRows);\n      if (lifecycleConflicts.length > 0) {\n        findings.push({\n          policy: getDependencyPolicy('active-dependant-unreconciled')!,\n          cycles: [],\n          endpointDefects: [],\n          stranded: [],\n          lifecycleConflicts,\n        });\n      }\n      if (findings.length > 0) {\n        throw new WorkItemDependencyAdmissionError(findings, before, after, {\n          ...dependencyGraphPerformanceTelemetry({\n            operation: 'mutation',\n            durationMs: performance.now() - startedAt,\n            nodes: after.verdicts.length,\n            edges: candidate.length,\n          }),\n          event: 'dependency-mutation-rejected',\n          policyCodes: findings.map((finding) => finding.policy.code),\n        });\n      }\n      const diff = await applyStoredEdgeDiff(tx, input.workspaceId, current, candidate);\n      return {\n        ...diff,\n        before,\n        after,\n        telemetry: {\n          ...dependencyGraphPerformanceTelemetry({\n            operation: 'mutation',\n            durationMs: performance.now() - startedAt,\n            nodes: after.verdicts.length,\n            edges: candidate.length,\n          }),\n          event: 'dependency-mutation-committed',\n          policyCodes: [],\n          ...diff,\n        },\n      };\n    },\n    opts.retry,\n  );\n}"
      },
      {
        "firstLine": 851,
        "lastLine": 899,
        "text": "  }\n\n  await opts.beforeWrite?.();\n\n  const receipts: WorkItemDependencyRefRewriteReceipt[] = [];\n  for (const dependency of rows) {\n    const blockedRef = rewriteByRef.get(dependency.blocked_ref) ?? dependency.blocked_ref;\n    const blockerRef = rewriteByRef.get(dependency.blocker_ref) ?? dependency.blocker_ref;\n    const before = repointDependencyReceipt(dependency);\n    if (dependency.blocked_kind === dependency.blocker_kind && blockedRef === blockerRef) {\n      await tx`DELETE FROM harness_shared.work_item_deps WHERE id = ${dependency.id}`;\n      receipts.push({ before, after: null, targetPrior: null, disposition: 'removed-self-edge' });\n      continue;\n    }\n    const [targetPrior] = await tx<RepointDependencyRow[]>`\n      SELECT id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by\n        FROM harness_shared.work_item_deps\n       WHERE workspace_id = ${input.workspaceId}\n         AND blocked_kind = ${dependency.blocked_kind}\n         AND blocked_ref = ${blockedRef}\n         AND blocker_kind = ${dependency.blocker_kind}\n         AND blocker_ref = ${blockerRef}\n         AND dep_type = ${dependency.dep_type}\n         AND id <> ${dependency.id}\n       LIMIT 1`;\n    const [after] = await tx<RepointDependencyRow[]>`\n      INSERT INTO harness_shared.work_item_deps\n        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by)\n      VALUES (${input.workspaceId}, ${dependency.blocked_kind}, ${blockedRef},\n              ${dependency.blocker_kind}, ${blockerRef}, ${dependency.dep_type},\n              ${dependency.satisfaction === 'success' ? 'success' : 'settled'}, ${dependency.created_by})\n      ON CONFLICT (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)\n      DO UPDATE SET satisfaction = CASE\n        WHEN harness_shared.work_item_deps.satisfaction = 'success' OR EXCLUDED.satisfaction = 'success'\n          THEN 'success'\n        ELSE 'settled'\n      END\n      RETURNING id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type, satisfaction, created_by`;\n    if (!after) throw new Error(`dependency repoint failed for ${String(dependency.id)}`);\n    await tx`DELETE FROM harness_shared.work_item_deps WHERE id = ${dependency.id}`;\n    receipts.push({\n      before,\n      after: repointDependencyReceipt(after),\n      targetPrior: targetPrior ? repointDependencyReceipt(targetPrior) : null,\n      disposition: targetPrior ? 'merged-with-existing-edge' : 'repointed-edge',\n    });\n  }\n  return receipts;\n}"
      }
    ]
  },
  "assessment": {
    "sourceContents": "Verified immutable commit/blob source, not historical loaded-runtime continuity.",
    "historicalBuildScope": "Cold40 early serving invocations pin cf57965610 on 2026-10-09. They do not pin the 2026-10-10 review-to-cutoff runtime.",
    "dependencyRows": "applyStoredEdgeDiff deletes stored edges and inserts/updates replacements. The repoint implementation also deletes original IDs, returning before/after receipts. Current surviving edges alone cannot establish cutoff absence.",
    "telemetry": "mutateWorkItemDependencies returns telemetry event dependency-mutation-committed in its transaction result. The inspected boundary does not itself persist that returned telemetry into an append-only event history. Caller persistence remains unverified; no global absence inferred.",
    "wholeWork": "Original checkpoint still names disk reserve/git-sync and pending staging acceptance. No independent reachable-step exhaustion or interval dependency/control continuity established.",
    "eligibility": "Review remains open. Frozen whole116 continuity/eligibility has not been accepted; no outcome joins."
  },
  "next": [
    "Follow exact mutateWorkItemDependencies callers at immutable build and identify any dated durable mutation-history writer.",
    "Use dated actual loaded-build/control custody for review-to-cutoff, not early-build contents alone.",
    "Consider other unresolved whole116 sources independently; do not repeat completed36 acquisitions, three missing-path reads, or prior assessments."
  ],
  "preserved": {
    "originalCohort": 116,
    "acceptedReceipts": 113,
    "unresolvedReceipts": 24,
    "cutoffContinuityAccepted": 0,
    "eligibilityFrozen": 0,
    "outcomesJoined": 0
  },
  "frictions": [
    {
      "type": "caller-inspector",
      "ref": "EI-25929243910984843",
      "detail": "JSON parsing failed after overlarge capability:bash output was clipped at15000; corrected by bounding source output. No product write."
    },
    {
      "type": "transport",
      "ref": "EI-24802357246708467",
      "detail": "Readonly code:run inspector HTTP502 trace ee131d92-77df-40f5-8883-4d289b81ad1b outcome_unknown. Captured/coalesced; no product mutation requested."
    },
    {
      "type": "transport",
      "ref": "EI-25929464144366395",
      "detail": "Initial canonical artifact save returned HTTP502/outcome_unknown. Exact key was independently read on authenticated staging3170 and found false before this save; no blind retry."
    }
  ],
  "limits": [
    "No original-output absence inferred from Cold42 missing retained files.",
    "No current-gate operations, source edits, product tests, acquisitions, terminal receipt replays, account changes, restores, or executor-route changes."
  ]
}
