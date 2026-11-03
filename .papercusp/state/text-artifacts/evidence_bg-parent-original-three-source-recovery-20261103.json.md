---
rel_path: "evidence/bg-parent-original-three-source-recovery-20261103.json"
updated_at: 1793669159208
_body: "content"
---

{
  "schemaVersion": "bg-parent-source-authority-recovery-v1",
  "status": "recovered-source-evidence-only-not-accepted-runtime-manifest",
  "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
  "workItemId": "WI-6554700010028547",
  "parentWorkItemId": "WI-6554700010025840",
  "parentPlanSlug": "loop-rebase-critical-sweep-floor-2026-10-24",
  "sourceCommit": "72959875a3b38694f1f7ebaf78eb7b0782d954ab",
  "originalRefs": [
    "thread-post:1204094 line165",
    "session_turn:codex:01a16f55-1fed-7240-9697-c3b949dc3150:6",
    "session_turn_parts:default/codex/01a16f55-1fed-7240-9697-c3b949dc3150/70",
    "session_turn_parts:default/codex/01a16f55-1fed-7240-9697-c3b949dc3150/104",
    "loop-rebase-critical-sweep-floor-2026-10-24 evidence68404",
    "loop-rebase-critical-sweep-floor-2026-10-24 evidence68921"
  ],
  "originalSourceDigests": {
    "packages/operator-core/lib/dbos/routines-workflow.ts": "2959316721171c028fef5d8ca83201f849c6f583c3a079178de51ddf843b9348",
    "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts": "2c1a0a3fe64d0f03832c88f18cfd0ee0207c3032539982016211c895690b033b",
    "packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts": "4e8edba73d6e6b3ee9e1ec6f5fcd02ee6a39c7258bf161728b92769c9ce2f98e"
  },
  "originalGitBlobs": {
    "packages/operator-core/lib/dbos/routines-workflow.ts": "85c7396e72e5f8cddd5ddbba3b3a6a8d7119e31d",
    "packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-su.ts": "35ccbdd2ea73e7e3f376fcb37a762c6079b47e95",
    "packages/operator-core/lib/harness/routines/loop-turn-start-stamp.ts": "aad6f1c7029ff189ccdbe0ed6676b808e0aab54c"
  },
  "verification": "Read Git objects at the original historical commit; recompute SHA-256; all three exactly match retained accepted source digests. No candidate created, no test rerun, no source edit, no new runtime.",
  "limitations": [
    "Original matching boot artifact manifest remained absent/UNKNOWN.",
    "Parent integration evidence68921 source population has nine members and does not itself include scheduler/bootstrap; it must not be substituted as the three-input manifest.",
    "Evidence provenance records reviewed author source-cohort qualification; does not establish full parent operational acceptance.",
    "R1 inherited immutable parent manifest authority remains UNKNOWN until reviewed disposition of this recovered original source packet.",
    "D002 old artifact stays UNKNOWN; D016 P002 guarded restart/rollback and P003 verification preserved; self/cap2/no implementation workers/no LIVE_GATE_OPS."
  ]
}
