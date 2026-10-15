---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire51-two-candidate-cutoff-control-limits-20261015-424d5.json"
updated_at: 1792022685415
_body: "content"
---

{
  "schemaVersion": "parked-fire51-two-candidate-cutoff-control-limits-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "observedAt": "2026-10-15T00:04:45.393Z",
  "finalCutoff": "2026-10-10T16:00:36.515Z",
  "priorEvidence": "audits/parked-agent-resumption-2026-10-09/fire50-original-two-claim-fire-custody-20261014-424d5.json",
  "lifecycleRead": {
    "results": [
      {
        "id": "EI-25286112504411834",
        "workItem": {
          "assignee": null,
          "takenAt": null,
          "updatedAt": "2026-10-10T16:26:50.191Z"
        },
        "lifecycle": {
          "events": [
            {
              "at": "2026-10-10T16:26:52.199Z",
              "atMs": 1791649612199,
              "kind": "force-released",
              "by": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
              "source": "audit_log",
              "action": "work_items:release:force",
              "detail": {
                "basis": "holder-warm-idle",
                "holder": "su-298f8b56-c687-404f-99e1-d1c1e53baf0c",
                "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
                "harness": "papercusp"
              }
            }
          ],
          "flags": {
            "needsHuman": false,
            "claimHold": false,
            "heldOpenBy": null,
            "heldOpenReason": null
          },
          "coverage": {
            "auditRows": 1,
            "reopenEntries": 0,
            "notRecorded": [
              "non-terminal transitions (→ wip, → open) are not recorded in any store — an empty timeline never means 'this item never moved'",
              "→ needs-human sets payload.needsHuman but records no dated transition — see flags.needsHuman for the current value, which carries no timestamp"
            ],
            "degraded": false
          }
        }
      },
      {
        "id": "EI-24785728669502309",
        "workItem": {
          "assignee": null,
          "takenAt": null,
          "updatedAt": "2026-10-10T16:26:23.485Z"
        },
        "lifecycle": {
          "events": [
            {
              "at": "2026-10-10T16:26:25.308Z",
              "atMs": 1791649585308,
              "kind": "force-released",
              "by": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
              "source": "audit_log",
              "action": "work_items:release:force",
              "detail": {
                "basis": "holder-warm-idle",
                "holder": "su-fc5749a7-6632-4f73-9c99-8b475641e7e2",
                "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
                "harness": "papercusp"
              }
            }
          ],
          "flags": {
            "needsHuman": false,
            "claimHold": false,
            "heldOpenBy": null,
            "heldOpenReason": null
          },
          "coverage": {
            "auditRows": 1,
            "reopenEntries": 0,
            "notRecorded": [
              "non-terminal transitions (→ wip, → open) are not recorded in any store — an empty timeline never means 'this item never moved'",
              "→ needs-human sets payload.needsHuman but records no dated transition — see flags.needsHuman for the current value, which carries no timestamp"
            ],
            "degraded": false
          }
        }
      }
    ]
  },
  "sourceRead": {
    "0": {
      "revision": "2bd468861e",
      "path": "packages/operator-core/lib/work-item-lifecycle-history.ts",
      "blobSha256": "881a0722232438fdcf5b88a83b9c2cd7589a9df34998c6fb22cd0b929d9ed8b2",
      "regions": [
        {
          "startLine": 100,
          "endLine": 122,
          "text": "  ];\n  if (family === 'issue') {\n    caveats.push(\n      '→ needs-human sets payload.needsHuman but records no dated transition — see flags.needsHuman for the current value, which carries no timestamp',\n    );\n  } else {\n    caveats.push(\n      'this item is feature-family: → needs-human is not flagged or dated, and → blocked was not recorded at all before EI-19397599078921465 — entries here begin at that fix',\n    );\n  }\n  return caveats;\n}\n\n/** Map an audit action onto a timeline `kind`, preserving the raw action either way. */\nfunction classify(action: string, details: Record<string, unknown> | null): WorkItemLifecycleEvent['kind'] {\n  if (action === 'work_items:state:blocked') return 'blocked';\n  if (action === 'work_items:release:force' || action === 'work_items:claim:force_claim_hold') {\n    return 'force-released';\n  }\n  if (action === 'work_items:claim_hold:set') {\n    // An issue-family `→ blocked` reaches audit_log ONLY as a claim-hold side effect,\n    // tagged reason='blocked' by the auto-park. Surfacing it as `held` would hide the\n    // very transition this module was built to answer — it is a block, recorded obliquely."
        },
        {
          "startLine": 153,
          "endLine": 185,
          "text": "\n  // ---- source 1: audit_log -------------------------------------------------\n  try {\n    const { sql } = getOrgPg();\n    const rows = (await sql.unsafe(\n      `SELECT ts, actor, action, details\n         FROM harness_shared.audit_log\n        WHERE workspace_id = $1 AND subject = $2 AND action LIKE 'work_items:%'\n        ORDER BY ts DESC\n        LIMIT $3`,\n      [params.workspaceId, params.id, limit],\n    )) as Array<{ ts: number | string; actor: string | null; action: string; details: unknown }>;\n    auditRows = rows.length;\n    for (const row of rows) {\n      const atMs = Number(row.ts);\n      if (!Number.isFinite(atMs)) continue;\n      const details = asRecord(row.details);\n      // `actor` is NOT NULL in schema with a 'user' default, and the claim-hold writer\n      // substitutes the literal 'system' when it has no actor. Neither is a real identity,\n      // so both normalize to null — reporting \"system blocked this\" would be a fabricated\n      // attribution, and a wrong name is worse than an admitted absence.\n      const rawActor = typeof row.actor === 'string' ? row.actor : null;\n      const by = rawActor && rawActor !== 'system' && rawActor !== 'user' ? rawActor : null;\n      events.push({\n        at: new Date(atMs).toISOString(),\n        atMs,\n        kind: classify(row.action, details),\n        by,\n        source: 'audit_log',\n        action: row.action,\n        ...(details ? { detail: details } : {}),\n      });\n    }"
        }
      ]
    },
    "1": {
      "revision": "2bd468861e",
      "path": "packages/operator-core/lib/issues-engineer.ts",
      "blobSha256": "41f207ed6cf3cad72f2ae84d68ba6d7d8bc1f543f63f69d94beaf19fd1577397",
      "regions": [
        {
          "startLine": 1056,
          "endLine": 1080,
          "text": "  signalOrigin?: SignalOrigin;\n  /**\n   * Explicit id — used by the unified work_items:create path to mint a\n   * kind-independent WI-NNN id (D-008). Omit for the legacy issues:create path,\n   * which allocates the next EI-<n>.\n   */\n  id?: string;\n  /**\n   * Initial state (observation-lane-scorecard-classification-2026-08-16 D-002/D-005).\n   * Default 'open'. 'done' files the row ALREADY-TERMINAL — for records that are\n   * completed at creation by construction (a rubric scorecard emitted through\n   * scorecards:emit is a finished verdict, not pending work). Note migration 698's\n   * insert rule: a row arriving terminal carries an honest NULL closed_ts (its\n   * created_at ≈ close time); only an UPDATE crossing the terminal boundary stamps one.\n   */\n  state?: 'open' | 'done';\n  /**\n   * Admission-gate state to be born with (plan work-queue-admission-and-bulk-dedup-2026-08-24,\n   * P-002). 'pending' = born-pending, invisible to claim/place until the promoter judges\n   * it; 'auto' = a filing-time bypass. Omit/null ⇒ the column stays NULL, which\n   * {@link isAdmitted} reads as admitted (pre-gate back-compat).\n   *\n   * MUST ride in THIS INSERT, never a post-create UPDATE: an item that lands admitted\n   * and is demoted a moment later is claimable in the gap, which is the entire failure\n   * born-pending exists to prevent."
        }
      ]
    }
  },
  "assessment": [
    {
      "id": "EI-25286112504411834",
      "cutoffHeldMembership": "review-open",
      "continuousCustody": "unverified",
      "eligibilityAccepted": false,
      "outcomeJoined": false,
      "reason": "Later force-release names the expected holder after the cutoff; the lifecycle reader does not expose a complete claim-transition history. Aggregate claim/release latches do not establish continuous custody."
    },
    {
      "id": "EI-24785728669502309",
      "cutoffHeldMembership": "review-open",
      "continuousCustody": "unverified",
      "eligibilityAccepted": false,
      "outcomeJoined": false,
      "reason": "Later force-release names the expected holder after the cutoff; the lifecycle reader does not expose a complete claim-transition history. Aggregate claim/release latches do not establish continuous custody."
    }
  ],
  "limits": [
    "Current mutable flags and null assignee do not describe historical cutoff state.",
    "Reader coverage.degraded=false means its defined stores were read, not that all claim transitions were recorded.",
    "The pinned source is a source-semantics check, not proof of the original serving runtime.",
    "No missing-source or missing-pickup claim follows from absence in these stores."
  ],
  "next": "Retain these two cutoff controls as review-open and continue remaining retained seven-case/five-wait predicates before the full original116 eligibility freeze; do not repeat these source reads without movement."
}
