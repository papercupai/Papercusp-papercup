---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-presnapshot-row-candidates-fire14-424d5.json"
updated_at: 1791809545407
_body: "content"
---

{
  "schemaVersion": "parked-presnapshot-retained-launch-profiles-v1",
  "workItem": "WI-6554700010008887",
  "scope": "Current retained rows whose started_at and launched_at precede the frozen candidate census and whose recorded end is later/absent; candidates for historical profile custody, not original profiles certified solely from timestamps. launch_argv can be replaced by initial adoption/finalized resume. No defaults filled.",
  "sql": "WITH a AS MATERIALIZED (SELECT content::jsonb c FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path='audits/parked-agent-resumption-2026-10-09/r13-original116-candidates-fire14-424d5.json'), cohort AS MATERIALIZED (SELECT x->>'ownerId' owner_id FROM a CROSS JOIN LATERAL jsonb_array_elements(c->'rows') x) SELECT s.id,s.coord_owner_id,s.first_seen_at,s.started_at,s.launched_at,s.ended_at,s.display,s.launch_argv FROM cohort JOIN harness_shared.adv_sessions s ON s.coord_owner_id=cohort.owner_id WHERE s.workspace_id='papercusp-workspace' AND s.started_at<'2026-10-10T16:00:36.515Z' AND s.launched_at<'2026-10-10T16:00:36.515Z' AND (s.ended_at IS NULL OR s.ended_at>'2026-10-10T16:00:36.515Z') ORDER BY s.coord_owner_id,s.first_seen_at",
  "rows": [],
  "status": "instrument-not-certified-for-absence",
  "caveat": "Zero matching rows is a constrained-query result, not absence of original profiles. launched_at is a transition field and this filter lacks a same-query positive control; retain pre-snapshot row185/102-owner aggregate separately as investigation candidates, never route custody."
}
