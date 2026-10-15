---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire48-report-publication-readback-20261014-424d5.json"
updated_at: 1792019177794
_body: "content"
---

{
  "schemaVersion": "fire48-report-publication-readback-v1",
  "source": "audits/parked-agent-resumption-2026-10-09/fire48-owner-report-20261014-424d5.md",
  "request_key": "parked-fire48-custody-20261014-424d5-v1",
  "publish": {
    "ok": true,
    "report_id": "rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
    "request_key": "parked-fire48-custody-20261014-424d5-v1",
    "workspace_id": "papercusp-workspace",
    "title": "Fire48: original wake records and unresolved final claim custody",
    "summary": "Two dated revision candidates recovered; final cutoff membership and whole-plan acceptance remain open.",
    "kind": "status-digest",
    "subject": {
      "kind": "work_item",
      "ref": "WI-6554700010008887",
      "label": null
    },
    "origin": {
      "harness_slug": "papercusp",
      "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "author_session_ref": "685eab91-ff89-4d95-97f4-a0970ab61029"
    },
    "visibility": "owner",
    "supersedes_report_id": null,
    "lineage_id": "rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
    "source": "agent",
    "tags": [],
    "published_at": "2026-10-14T23:05:48.603Z",
    "updated_at": "2026-10-14T23:05:48.603Z",
    "retired_at": null,
    "path": "/reports?sel=rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
    "body_bytes": 1426,
    "body_sha256": "6fa0650c175acb66180fe322e10e954e864a8fe6d3e5089accaa8c66f6160dbc",
    "goal_owner_report": null,
    "event_emitted": true
  },
  "readback": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "id": "rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
        "report": {
          "report_id": "rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
          "workspace_id": "papercusp-workspace",
          "title": "Fire48: original wake records and unresolved final claim custody",
          "summary": "Two dated revision candidates recovered; final cutoff membership and whole-plan acceptance remain open.",
          "kind": "status-digest",
          "subject": {
            "kind": "work_item",
            "ref": "WI-6554700010008887",
            "label": null
          },
          "origin": {
            "harness_slug": "papercusp",
            "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
            "author_session_ref": "685eab91-ff89-4d95-97f4-a0970ab61029"
          },
          "visibility": "owner",
          "supersedes_report_id": null,
          "lineage_id": "rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
          "source": "agent",
          "tags": [],
          "published_at": "2026-10-14T23:05:48.603Z",
          "updated_at": "2026-10-14T23:05:48.603Z",
          "retired_at": null,
          "path": "/reports/rpt_aae0c0f6-9959-47fc-9850-baa336d106b6",
          "body_bytes": 1426,
          "body_md": "# Fire48: dated native wake and revision custody\n\nThe original native intervals for su-298f8b56 and su-fc5749a7 contain machine-injected wake messages. They do not establish an assistant response, claim mutation, or completed remediation.\n\nThe messages identify two additional claim candidates: EI-25286112504411834 and EI-24785728669502309. Original revision notices are dated 2026-10-10T04:20:51.051Z and 08:48:29.046Z. Later release records attribute them to the corresponding sessions. Final membership at the 16:00:36.515Z cutoff remains unverified: the revision writer can transfer a claim to its submitter or leave it unassigned, so a notice alone cannot distinguish those outcomes.\n\nSaved sources were independently read back in full:\n\n- `audits/parked-agent-resumption-2026-10-09/fire48-two-native-and-candidate-custody-20261014-424d5.json`\n- `audits/parked-agent-resumption-2026-10-09/fire48-original-candidate-event-and-audit-v2-20261014-424d5.json`\n- `audits/parked-agent-resumption-2026-10-09/fire48-two-native-cutoff-assessment-20261014-424d5.json`\n\nNext: read the original grading receipts and exact final held-state custody. Whole-cohort eligibility, continuity and outcomes remain open, as do the final fix runtime anchor and the census after an actual 24 hours. The existing transport incident remains unresolved; another connection reset is recorded on EI-25988128742965194. No final acceptance is claimed.\n"
        }
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "verification": {
    "exactFullBody": true,
    "visibility": "owner",
    "path": "/reports/rpt_aae0c0f6-9959-47fc-9850-baa336d106b6"
  }
}
