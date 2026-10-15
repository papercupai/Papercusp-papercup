---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-two-implicit-rearm-original-parts-fire31-424d5.json"
updated_at: 1791853896372
_body: "content"
---

{"schemaVersion":"r13-two-implicit-rearm-original-parts-v1","observedAt":"2026-10-13T01:11:36.366Z","targets":["su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5","su-82c46308-5eb9-4237-9d2d-950d322576c4"],"requestLedgerRefs":["34836154","34896168"],"query":"SELECT source_kind,session_id,part_idx,ts,owner,speaker,part_kind,tool_name,text FROM harness_shared.session_turn_parts WHERE workspace_id='papercusp-workspace' AND ((owner='su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5' AND ts >= '2026-10-09T18:43:00Z' AND ts <= '2026-10-09T18:47:00Z') OR (owner='su-82c46308-5eb9-4237-9d2d-950d322576c4' AND ts >= '2026-10-09T20:31:00Z' AND ts <= '2026-10-09T20:36:00Z')) ORDER BY owner,ts,part_idx LIMIT 200","rows":[],"limits":["Retained original parts, not current owner/session mutable state. Home paths were absent; these indexed owner/time records remain the source.","Parsed observations may be partial tool envelopes; no configuration effect or cutoff continuity is inferred merely from keyword presence or outer request status.","No recovery outcomes joined; all source times precede frozen cutoff."]}
