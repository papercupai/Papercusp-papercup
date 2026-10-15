---
rel_path: "reports/plan-audits/7d5f7539-bff1-4bfc-8406-4f6afc8416a9/audit.json"
updated_at: 1791341469685
_body: "content"
---

{
  "schemaVersion": "unshipped-plans-audit-manifest-v2",
  "generatedAt": "2026-10-07T02:51:09.681Z",
  "workspace": "papercusp-workspace",
  "scope": {
    "snapshotStartedAt": "2026-10-07T02:51:06.875Z",
    "snapshotFinishedAt": "2026-10-07T02:51:09.681Z",
    "liveOwnershipMeasuredAt": "2026-10-07T02:51:06.944Z",
    "nonterminalListedAtSnapshot": 1,
    "materialized": 1,
    "catalogFailures": 0,
    "classifiedRows": 1,
    "rule": "Point-in-time, read-only audit. Ongoing plans are protected; no lifecycle, item, blocker, claim, assignment, or ownership state is changed.",
    "classifierRevision": 3,
    "classifierCorrection": "Plan-level supersession requires an explicit plan-subject assertion in the Now state; prose-only blockers require blocker-shaped Now syntax, so incidental slug/title/history vocabulary is never lifecycle authority."
  },
  "summaryByCategory": {
    "ongoing-protected": {
      "count": 1,
      "byStatus": {
        "draft": 1
      }
    }
  },
  "bands": {
    "protected": 1,
    "closeoutOrReconcile": 0,
    "supersedeOrRetire": 0,
    "blockerClaims": 0,
    "unblockedPartial": 0,
    "catalogResidue": 0
  },
  "closeoutEvidence": {
    "staleAuditAndRubric": 0,
    "missingAuditOrAcceptance": 0
  },
  "blockerEvidence": {
    "typedCurrent": 0,
    "typedWithStaleHint": 0,
    "textOnly": 0
  },
  "currentRegistryAtPublish": {
    "total": 1,
    "draft": 1
  },
  "provenance": {
    "blender": 0,
    "outsideBlender": 1
  },
  "rows": [
    {
      "slug": "plan-audit-report-workspace-and-sidebar-2026-10-06",
      "title": "Navigable audit reports and generic Plans-sidebar audit generation",
      "harness": "papercusp",
      "status": "draft",
      "provenance": "outside-blender",
      "category": "ongoing-protected",
      "reason": "A live agent currently declares, claims, or holds nonterminal work linked to this plan.",
      "recommendation": "No cleanup action: preserve the lane and re-audit after its live owner finishes.",
      "created": "2026-10-07",
      "updated": "2026-10-06 22:25:56.502592-04",
      "itemTotal": 5,
      "terminalPlanItems": 0,
      "openPlanItems": 5,
      "workItemTotal": 5,
      "openWorkItems": 5,
      "workItemStates": {
        "open": 5
      },
      "itemCounts": {
        "todo": 2,
        "blocked": 3
      },
      "audit": {
        "auditSeq": 2,
        "createdAt": "2026-10-06 22:27:52.132235-04",
        "auditedSha": null,
        "auditedItems": 0
      },
      "acceptanceRubric": {
        "rubricId": "acceptance-plan-audit-report-workspace-and-sidebar-2026-10-06",
        "status": "active"
      },
      "gateVerdict": null,
      "owners": [
        {
          "ownerId": "su-a9dad156-41b6-41a9-b2e5-91ced5d4b6a4",
          "ownerLabel": "su · su-a9dad",
          "fleet": null,
          "intent": "Self implementation: shared audit report renderer and scoped engine, durable runs and sidebar journey, verified shipment.",
          "source": "declared-plan"
        },
        {
          "ownerId": "su-a9dad156-41b6-41a9-b2e5-91ced5d4b6a4",
          "ownerLabel": "su · su-a9dad",
          "fleet": null,
          "intent": "Self implementation: shared audit report renderer and scoped engine, durable runs and sidebar journey, verified shipment.",
          "source": "work-item-hold"
        },
        {
          "ownerId": "su-a9dad156-41b6-41a9-b2e5-91ced5d4b6a4",
          "ownerLabel": "su · su-a9dad",
          "fleet": null,
          "intent": "Self implementation: shared audit report renderer and scoped engine, durable runs and sidebar journey, verified shipment.",
          "source": "plan-item-claim"
        }
      ],
      "blocker": {
        "typedBlocked": true,
        "typedHuman": false,
        "refs": [
          "P-001",
          "P-002",
          "P-003",
          "P-004"
        ],
        "staleHints": []
      },
      "nowState": "",
      "nowNext": ""
    }
  ]
}

