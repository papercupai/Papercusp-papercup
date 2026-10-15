---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25319012248841467-08ddc471bd777529f2ab19cfa57005f2-reconcile.json"
updated_at: 1791670620217
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25319012248841467:08ddc471bd777529f2ab19cfa57005f2",
  "inputSha256": "08ddc471bd777529f2ab19cfa57005f2db97f5288f282bf6d2301cdb7be87c1e",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:17:00.217Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25319012248841467",
      "outcome": "cleared",
      "expectedParkFingerprint": "857896914ac511e8b3c815fb15c1c1bc6212d24ed75b6c057162eee03fe91e1b",
      "observedParkFingerprint": "857896914ac511e8b3c815fb15c1c1bc6212d24ed75b6c057162eee03fe91e1b",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25405474372596998 (condition: 'The live result-door spill-fallback work item EI-25405474372596998 reaches done so this sessions:read failure can be re-evaluated against its verified recovery path.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25405474372596998 status=done, taken_by none; EI-25319012248841467 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25319012248841467-08ddc471bd777529f2ab19cfa57005f2-reconcile.json"
}
