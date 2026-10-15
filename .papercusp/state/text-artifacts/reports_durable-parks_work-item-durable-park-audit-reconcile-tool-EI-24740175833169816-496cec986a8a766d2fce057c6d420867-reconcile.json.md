---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24740175833169816-496cec986a8a766d2fce057c6d420867-reconcile.json"
updated_at: 1791670541358
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24740175833169816:496cec986a8a766d2fce057c6d420867",
  "inputSha256": "496cec986a8a766d2fce057c6d420867b5468fa34b33e0515b8b51a372f12a99",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:41.358Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24740175833169816",
      "outcome": "cleared",
      "expectedParkFingerprint": "2c545495a4ad588e95abbecef26688e3058d7f9de6cd844249a439ac2fd4d220",
      "observedParkFingerprint": "2c545495a4ad588e95abbecef26688e3058d7f9de6cd844249a439ac2fd4d220",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24732297217951452 (condition: 'The active same-root-cause investigation on EI-24732297217951452 reaches a terminal finding, allowing this aggregate report to be checked for distinct residue.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24732297217951452 status=done, taken_by none; EI-24740175833169816 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24740175833169816-496cec986a8a766d2fce057c6d420867-reconcile.json"
}
