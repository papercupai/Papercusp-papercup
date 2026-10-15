---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-WI-10001907-cefca07613e25b7b142ff8f16244d1f0-reconcile.json"
updated_at: 1791672933744
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:WI-10001907:cefca07613e25b7b142ff8f16244d1f0",
  "inputSha256": "cefca07613e25b7b142ff8f16244d1f07ece1ff671d99942cd1bed121461ff5f",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:55:33.743Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "WI-10001907",
      "outcome": "cleared",
      "expectedParkFingerprint": "08796c146ab44a25eaeb523e1c713ea81ba15bfaac76589cbd1769ef67d947aa",
      "observedParkFingerprint": "08796c146ab44a25eaeb523e1c713ea81ba15bfaac76589cbd1769ef67d947aa",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:WI-10001906 (condition: 'Canonical singleton gate item WI-10001906 reaches a terminal state; then retry closing WI-10001907 as its duplicate without claiming any live-gate responsibility.'). Re-read 2026-10-10T22:55Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): WI-10001906 status=dropped, taken_by none; WI-10001907 status=open, taken_by null. Condition clause beyond the trigger, verified: the condition requires only that WI-10001906 reach a TERMINAL state. WI-10001906 is status=dropped since 2026-09-26T17:44:18Z, and harness_shared.event_key_fires records work-item:done:WI-10001906 fired once at 2026-09-26T17:44:19Z with payload state 'dropped'. The duplicate-closing step the condition names is the next claimant's work. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-WI-10001907-cefca07613e25b7b142ff8f16244d1f0-reconcile.json"
}
