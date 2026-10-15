---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24526883774548932-b1cdd1cf6195a022207e65166ac5871b-reconcile.json"
updated_at: 1791670534537
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24526883774548932:b1cdd1cf6195a022207e65166ac5871b",
  "inputSha256": "b1cdd1cf6195a022207e65166ac5871b1f935366a38886d0f02672d688daf9ca",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:34.537Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24526883774548932",
      "outcome": "cleared",
      "expectedParkFingerprint": "6c9ab4adc200da5e92e321514b5a9e2b40278bc3716d7e5ac0f8225f3cd45cb0",
      "observedParkFingerprint": "6c9ab4adc200da5e92e321514b5a9e2b40278bc3716d7e5ac0f8225f3cd45cb0",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:WI-10004525 (condition: 'Re-evaluate this Sep 28 incident after WI-10004525 records measured native Codex MCP endpoint and refusal-reconnect findings sufficient to compare its historical client path.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): WI-10004525 status=done, taken_by none; EI-24526883774548932 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24526883774548932-b1cdd1cf6195a022207e65166ac5871b-reconcile.json"
}
