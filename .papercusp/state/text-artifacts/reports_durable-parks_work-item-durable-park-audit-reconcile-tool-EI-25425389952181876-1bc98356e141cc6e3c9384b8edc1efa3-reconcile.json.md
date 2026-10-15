---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25425389952181876-1bc98356e141cc6e3c9384b8edc1efa3-reconcile.json"
updated_at: 1791672935159
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25425389952181876:1bc98356e141cc6e3c9384b8edc1efa3",
  "inputSha256": "1bc98356e141cc6e3c9384b8edc1efa334d3d57efc679dfa8157fe0688a81364",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:55:35.158Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25425389952181876",
      "outcome": "cleared",
      "expectedParkFingerprint": "723d73ca09ca3d9203936036b003a30a014a0d810929f3ae713477985760ac09",
      "observedParkFingerprint": "723d73ca09ca3d9203936036b003a30a014a0d810929f3ae713477985760ac09",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25403881334911643 (condition: 'Revisit this linked reproduction when EI-25403881334911643 reaches done; close it as duplicate if the root cause is shared, or assign it if a separate defect remains.'). Re-read 2026-10-10T22:55Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25403881334911643 status=dropped, taken_by none; EI-25425389952181876 status=open, taken_by null. Condition clause beyond the trigger, verified: the condition says 'when EI-25403881334911643 reaches done'. EI-25403881334911643 is status=dropped since 2026-10-09T23:14:53Z, and work-item:done:EI-25403881334911643 fired once at 2026-10-09T23:14:56Z with payload state 'dropped', which is the exact trigger this park declared. The revisit is due; whether this is a duplicate (shared root cause) or a separate defect to assign is decided by the next claimant, as the condition states. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25425389952181876-1bc98356e141cc6e3c9384b8edc1efa3-reconcile.json"
}
