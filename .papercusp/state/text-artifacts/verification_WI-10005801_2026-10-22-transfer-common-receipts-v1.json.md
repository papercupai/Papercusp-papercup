---
rel_path: "verification/WI-10005801/2026-10-22-transfer-common-receipts-v1.json"
updated_at: 1792691586790
_body: "content"
---

{
  "schemaVersion": "dream-outcome-evidence-v1",
  "workItem": "WI-10005801",
  "capturedAt": "2026-10-22T17:53:05.745Z",
  "purpose": "New transfer common-receipt acceptance/adoption evidence, separate from historical producer census",
  "query": {
    "sql": "SELECT coalesce(t.learning_lifecycle->>'stage','no-common-receipt') AS receipt_stage, t.learning_lifecycle->'contract'->'decision'->>'verdict' AS contract_verdict, t.learning_lifecycle->>'promotionAllowed' AS promotion_allowed, t.tier, t.status, count(*) AS lesson_rows, sum(CASE WHEN t.memory_id IS NOT NULL OR t.pack_candidate_id IS NOT NULL THEN 1 ELSE 0 END) AS linked_rows, sum((SELECT count(*) FROM jsonb_array_elements(coalesce(t.learning_lifecycle->'decisions','[]'::jsonb)) d WHERE d->'contract'->'decision'->>'verdict' = 'accepted')) AS accepted_historical_decisions FROM harness_shared.transfer_lessons t WHERE t.workspace_id = 'papercusp-workspace' GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4,5",
    "allowUnscoped": false,
    "maxRows": 100,
    "timeoutMs": 10000,
    "positiveControlSql": "SELECT id::text, tier, status FROM harness_shared.transfer_lessons WHERE workspace_id = 'papercusp-workspace' ORDER BY id LIMIT 1",
    "payloadTier": "full"
  },
  "result": {
    "mode": "query",
    "rowCount": 6,
    "truncated": false,
    "fields": [
      "receipt_stage",
      "contract_verdict",
      "promotion_allowed",
      "tier",
      "status",
      "lesson_rows",
      "linked_rows",
      "accepted_historical_decisions"
    ],
    "elapsedMs": 283,
    "rows": [
      {
        "receipt_stage": "activation",
        "contract_verdict": null,
        "promotion_allowed": "false",
        "tier": "probationary",
        "status": "candidate",
        "lesson_rows": "10",
        "linked_rows": "10",
        "accepted_historical_decisions": "0"
      },
      {
        "receipt_stage": "activation",
        "contract_verdict": null,
        "promotion_allowed": "false",
        "tier": "probationary",
        "status": "error",
        "lesson_rows": "6",
        "linked_rows": "6",
        "accepted_historical_decisions": "0"
      },
      {
        "receipt_stage": "decision",
        "contract_verdict": null,
        "promotion_allowed": "false",
        "tier": "probationary",
        "status": "candidate",
        "lesson_rows": "19",
        "linked_rows": "0",
        "accepted_historical_decisions": "0"
      },
      {
        "receipt_stage": "decision",
        "contract_verdict": null,
        "promotion_allowed": "false",
        "tier": "probationary",
        "status": "error",
        "lesson_rows": "4",
        "linked_rows": "0",
        "accepted_historical_decisions": "0"
      },
      {
        "receipt_stage": "no-common-receipt",
        "contract_verdict": null,
        "promotion_allowed": null,
        "tier": "probationary",
        "status": "candidate",
        "lesson_rows": "24",
        "linked_rows": "24",
        "accepted_historical_decisions": "0"
      },
      {
        "receipt_stage": "observation",
        "contract_verdict": null,
        "promotion_allowed": "false",
        "tier": "probationary",
        "status": "candidate",
        "lesson_rows": "1",
        "linked_rows": "1",
        "accepted_historical_decisions": "0"
      }
    ],
    "positiveControl": {
      "rows": [
        {
          "id": "01dd23e9-6c90-4555-af91-8568af3dbe37",
          "tier": "probationary",
          "status": "candidate"
        }
      ],
      "rowCount": 1,
      "truncated": false,
      "fields": [
        "id",
        "tier",
        "status"
      ],
      "status": "passed"
    }
  },
  "sourceHash": {
    "head": "060876c3b008b6305d2122026b89fa4e5ee1e532",
    "paths": [
      {
        "path": "packages/operator-core/lib/transfer/store.ts",
        "sha256": "7e65ca8269110d375a8de68ae48ea1f2edf6d23e87259a6f64d761fe81a14dd1",
        "matchesHead": true
      },
      {
        "path": "packages/operator-core/lib/transfer/tick.ts",
        "sha256": "1c18695c004a0190de9c024c780a2195bc79832ebe8bdf9091e365dcab6dbcc4",
        "matchesHead": true
      },
      {
        "path": "packages/operator-core/lib/experiment/producer-lifecycle-store.ts",
        "sha256": "0ef80af0c08870aa70f98e36775be7f15a4364828ae56b482fe6d94d162532ff",
        "matchesHead": true
      },
      {
        "path": "packages/operator-core/lib/experiment/lifecycle-adapter.ts",
        "sha256": "1be2f37b52488ec540161aec7b0fe3281ad260c817e14323954e7b7122f83e32",
        "matchesHead": true
      }
    ]
  },
  "interpretation": [
    "Transfer lifecycle activation is selected when memory_id or pack_candidate_id is present; decision is also projected for probationary native tier with verdict inconclusive.",
    "tick.ts admits probationary lessons to memory before evaluation under existing D-006. A link does not prove successful replay, retention or causal benefit.",
    "promotionContract validates accepted common decision, artifact and execution pins, complete replay cells and settled reservation before validated tier.",
    "This query includes accepted historical decision arrays because latest contract:null alone would not establish historical absence.",
    "All returned rows are probationary; populated latest receipts have contract verdict null and promotionAllowed false; accepted decision-array entries are zero in each exhaustive returned group."
  ],
  "limits": [
    "Stored receipt/source-row inspection only; readProducerObservations sourceHash currentness was not revalidated.",
    "Current code hashes match local HEAD; exact serving/background source uptake was not verified.",
    "Memory and knowledge-pack links were not followed to establish runtime retrieval/exposure or post-adoption benefit.",
    "No paid run, replay, learning/control, source-plan or audited-subject mutation performed."
  ]
}
