---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-22556667837611970-461daa9ce1f28ce86335e077ee578818-reconcile.json"
updated_at: 1791689501635
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-22556667837611970:461daa9ce1f28ce86335e077ee578818",
  "inputSha256": "461daa9ce1f28ce86335e077ee57881829f0389d8785b6d57586a61817845487",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-11T03:31:41.634Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-22556667837611970",
      "outcome": "cleared",
      "expectedParkFingerprint": "d3951e6e1e62b54287d38e689fbd33dbf33eaaee7cf103e3f346ed3b0e1641e2",
      "observedParkFingerprint": "d3951e6e1e62b54287d38e689fbd33dbf33eaaee7cf103e3f346ed3b0e1641e2",
      "reasonCode": "condition-satisfied",
      "evidence": "Condition met: a fresh grading-integrity auditor launch with account:auto started and completed. adv_sessions id=40119 (coord_owner su-93993ed3-3d01-4d06-a181-6b1a8ed86145, role judge) launch_argv contains --account=auto and --launched-by=system:grading-audit-dispatch; started_at 2026-10-11T02:23:18Z; it settled the audit for scorecard EI-25647879846595062 (payload.observation.gradingAudit.state='passed', auditor su-93993ed3, auditedAt 2026-10-11T02:31:19Z). Six sibling P-004 cards (EI-25647865468494679, EI-25647868024226749, EI-25647870195273979, EI-25647872877500342, EI-25647875345634607, EI-25647878016349140) were audited 'passed' by 02:38Z the same way. Re-check: dev:pg_query adv_sessions WHERE coord_owner_id='su-93993ed3-3d01-4d06-a181-6b1a8ed86145' and the card's gradingAudit stamp. The park's trigger (its own done key) was self-referential and could never fire on its own.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-22556667837611970-461daa9ce1f28ce86335e077ee578818-reconcile.json"
}
