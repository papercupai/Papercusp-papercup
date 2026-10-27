---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-b/manifest.json"
updated_at: 1792923733543
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "actual-search-adapter-discovery-capture",
  "planSlug": "shared-search-restart-papercusp-2026-10-22",
  "workItemId": "WI-6554700010022135",
  "captureId": "p001-docs-final-input-20261025-b",
  "frozenAt": "2026-10-25T10:22:13.330Z",
  "ownerId": "su-45e55f4b-3b99-466a-85fb-973108f644c9",
  "route": {
    "tool": "docs:search",
    "url": "http://127.0.0.1:3170",
    "runtime": "staging-operator",
    "preflightBuild": "1777870c66",
    "client": "installed ptool explicit --url, unmodified request JSON via stdin"
  },
  "population": {
    "attemptIds": [
      "docs-title-02",
      "docs-identifier-02"
    ],
    "adapter": "docs:search",
    "product": "papercusp",
    "condition": "unknown",
    "purpose": "retain exact real-adapter final inputs; discovery only",
    "uniqueKnownItemOpportunities": 1
  },
  "queries": [
    {
      "id": "docs-title-02",
      "args": {
        "query": "Grading retrieval and final-context quality",
        "harness": "engineering",
        "limit": 2,
        "semantic": true
      }
    },
    {
      "id": "docs-identifier-02",
      "args": {
        "query": "labelled-relevance-benchmarking",
        "harness": "engineering",
        "limit": 2,
        "semantic": true
      }
    }
  ],
  "independentKnownItem": {
    "slug": "agent-insights/labelled-relevance-benchmarking",
    "sourcePath": "apps/operator-docs/src/content/docs/agent-insights/labelled-relevance-benchmarking.mdx",
    "sourceSha256": "59d93c8abc7e20b4952681c733e4debcddb0bac4b237e5d05dfbd0e85c9daaff",
    "completeRelevantSet": false
  },
  "sourcePins": {
    "adapter": "59dec7d3473e16a710b45566ccab63ff5caa538a755eaf3229fa5f089aa906e1",
    "rankingDefaults": "9ffe909f9d4eefc769dec626e4697036b88172ee8ac1937c6c122becc53a39da"
  },
  "unknowns": [
    "corpus snapshot identity",
    "effective model/runtime read closure",
    "cold/warm condition",
    "qualified prior judge pilot and labels",
    "metered retrieval cost",
    "prospective per-cell numeric acceptance budgets and adequate sample"
  ],
  "exclusions": "none; both attempts and any refused/error/degraded/unknown result retained",
  "paidJudgeCalls": 0,
  "qualityVerdict": "unknown",
  "baselineAccepted": false,
  "planAcceptance": false,
  "shipment": "unverified",
  "supersedesTransportOnly": "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-a/manifest.json",
  "priorCapture": {
    "attemptId": "docs-title-01",
    "receipt": "evidence/shared-search-restart-papercusp-2026-10-22/docs-final-input-20261025-a/docs-title-01.json",
    "outcome": "refused-before-execution",
    "remainingAttempt": "docs-identifier-01 not dispatched; retained as unexecuted"
  }
}
