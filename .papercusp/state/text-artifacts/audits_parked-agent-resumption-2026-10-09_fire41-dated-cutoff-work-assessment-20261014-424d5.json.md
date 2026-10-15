---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire41-dated-cutoff-work-assessment-20261014-424d5.json"
updated_at: 1792010272202
_body: "content"
---

{
  "schemaVersion": "parked-r13-fire41-dated-cutoff-work-assessment-v1",
  "observedAt": "2026-10-14T20:37:52.189Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/fire41-two-dated-cutoff-release-rawrefs-20261014-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/fire41-loop-end-work-release-rawrefs-20261014-424d5.json"
  ],
  "records": [
    {
      "workItemId": "EI-25574253034038454",
      "rawRef": "EI-25574253034038454#lifecycle:audit_log:1791649718564:force-released",
      "at": "2026-10-10T16:28:38.564Z",
      "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
      "holder": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "relativeToCutoff": "after-cutoff",
      "text": "force-released (work_items:release:force): {\"basis\":\"holder-warm-idle\",\"holder\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"reason\":\"[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.\",\"harness\":\"papercusp\"}",
      "assessment": "Post-cutoff release names the cohort holder; it does not establish uninterrupted earlier hold, complete cutoff applicability, guaranteed wake or pickup."
    },
    {
      "workItemId": "EI-25405882696245541",
      "rawRef": "EI-25405882696245541#lifecycle:audit_log:1791649666499:force-released",
      "at": "2026-10-10T16:27:46.499Z",
      "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
      "holder": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "relativeToCutoff": "after-cutoff",
      "text": "force-released (work_items:release:force): {\"basis\":\"holder-warm-idle\",\"holder\":\"su-8d2cb6cc-8f27-4a25-8541-b00927471b94\",\"reason\":\"[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.\",\"harness\":\"papercusp\"}",
      "assessment": "Post-cutoff release names the cohort holder; it does not establish uninterrupted earlier hold, complete cutoff applicability, guaranteed wake or pickup."
    },
    {
      "workItemId": "WI-10008104",
      "rawRef": "WI-10008104#release:2026-10-10T13:13:29.278Z",
      "at": "2026-10-10T13:13:29.278Z",
      "actor": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "holder": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "relativeToCutoff": "before-cutoff",
      "text": "claim released by su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44 at 2026-10-10T13:13:29.278Z",
      "assessment": "Dated self-release before cutoff is established; an uninterrupted hold through cutoff cannot be inferred from the intent. Later reacquisition or the complete held set is not established."
    },
    {
      "workItemId": "WI-10006552",
      "rawRef": "WI-10006552#lifecycle:audit_log:1791649735741:force-released",
      "at": "2026-10-10T16:28:55.741Z",
      "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
      "holder": "su-f6e9cbee-faee-465e-9281-2743f85a91ab",
      "relativeToCutoff": "after-cutoff",
      "text": "force-released (work_items:release:force): {\"basis\":\"holder-warm-idle\",\"holder\":\"su-f6e9cbee-faee-465e-9281-2743f85a91ab\",\"reason\":\"[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.\",\"harness\":\"papercusp\"}",
      "assessment": "Post-cutoff release names the cohort holder; it does not establish uninterrupted earlier hold, complete cutoff applicability, guaranteed wake or pickup."
    }
  ],
  "allRowsReviewOpen": true,
  "whole116EligibilityAccepted": 0,
  "cutoffContinuityAccepted": 0,
  "outcomesJoined": 0,
  "next": "Follow retained dated pre-cutoff source refs for final-held applicability and control continuity; retain review-open until exact predicates are established. Do not reconstruct missing historical routine output or join outcomes."
}
