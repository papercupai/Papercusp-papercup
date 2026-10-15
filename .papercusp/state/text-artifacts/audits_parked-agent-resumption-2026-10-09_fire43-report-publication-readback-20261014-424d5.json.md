---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire43-report-publication-readback-20261014-424d5.json"
updated_at: 1792013167565
_body: "content"
---

{
  "report_id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
  "path": "/reports?sel=rpt_495fb331-58a2-4853-b179-5f74f16239de",
  "source": "audits/parked-agent-resumption-2026-10-09/fire43-owner-report-20261014-424d5.md",
  "request_key": "parked-fire43-owner-report-20261014-424d5-v1",
  "bodyChars": 1770,
  "completeMarkdownEquality": true,
  "visibilityVerified": "owner",
  "published": {
    "ok": true,
    "report_id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
    "request_key": "parked-fire43-owner-report-20261014-424d5-v1",
    "workspace_id": "papercusp-workspace",
    "title": "Parked-agent audit: pre-cutoff journal evidence and remaining limits",
    "summary": "Two retained journals recovered; final-cutoff continuity and acceptance remain open.",
    "kind": "analysis",
    "subject": {
      "kind": "work_item",
      "ref": "WI-6554700010008887",
      "label": null
    },
    "origin": {
      "harness_slug": "papercusp",
      "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "author_session_ref": "8a3f8fc7-c56a-48d6-b549-25d4ebf39a2c"
    },
    "visibility": "owner",
    "supersedes_report_id": null,
    "lineage_id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
    "source": "agent",
    "tags": [
      "parked-agent",
      "r13",
      "historical-evidence"
    ],
    "published_at": "2026-10-14T21:26:07.387Z",
    "updated_at": "2026-10-14T21:26:07.387Z",
    "retired_at": null,
    "path": "/reports?sel=rpt_495fb331-58a2-4853-b179-5f74f16239de",
    "body_bytes": 1770,
    "body_sha256": "36bba22a468ffb2d650740b632c5a4d25a77053c4f35f1d223b68cbc10b0ac8c",
    "goal_owner_report": null,
    "event_emitted": true,
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "reports:list (browse the library)"
        },
        {
          "tool": "reports:get (read one back, with its lineage)"
        },
        {
          "tool": "reports:retire (soft-retire one you authored)"
        }
      ]
    }
  },
  "read": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
        "report": {
          "report_id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
          "request_key": "parked-fire43-owner-report-20261014-424d5-v1",
          "workspace_id": "papercusp-workspace",
          "title": "Parked-agent audit: pre-cutoff journal evidence and remaining limits",
          "summary": "Two retained journals recovered; final-cutoff continuity and acceptance remain open.",
          "kind": "analysis",
          "subject": {
            "kind": "work_item",
            "ref": "WI-6554700010008887",
            "label": null
          },
          "origin": {
            "harness_slug": "papercusp",
            "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
            "author_session_ref": "8a3f8fc7-c56a-48d6-b549-25d4ebf39a2c"
          },
          "visibility": "owner",
          "supersedes_report_id": null,
          "lineage_id": "rpt_495fb331-58a2-4853-b179-5f74f16239de",
          "source": "agent",
          "tags": [
            "parked-agent",
            "r13",
            "historical-evidence"
          ],
          "published_at": "2026-10-14T21:26:07.387Z",
          "updated_at": "2026-10-14T21:26:07.387Z",
          "retired_at": null,
          "path": "/reports?sel=rpt_495fb331-58a2-4853-b179-5f74f16239de",
          "body_bytes": 1770,
          "body_sha256": "36bba22a468ffb2d650740b632c5a4d25a77053c4f35f1d223b68cbc10b0ac8c",
          "goal_owner_report": null,
          "body_md": "Avi, final acceptance remains open. This continuation preserved dated work-history evidence without joining recovery outcomes.\n\nThe retained seven-item source artifact contains 17 distinct dated rawRef records selected before the 2026-10-10T16:00:36.515Z cutoff. The selection is a locator set, not a complete history or complete held-set assertion. Its 27,200-character artifact was saved and read back exactly.\n\nTwo requested superseded journal records were resolved and preserved in a 55,428-character source-response artifact. EI-25395605811228800 at 11:05:30.410Z retains an earlier route-capacity narrative and S38 unrun status. EI-25248675192543911 at 11:05:32.155Z retains a Fire32 loop-status narrative and pending leader disposition. Each returned journal text is 600 characters. Exact recovery of those retained records does not establish the original complete checkpoint, final-cutoff applicability, continuous custody, or guaranteed wake pickup.\n\nThe separate 3,745-character assessment was also read back exactly. Whole-cohort eligibility and continuity remain unfrozen, and recovery outcomes remain unjoined. The actual final-fix runtime anchor and subsequent 24-hour R14 measurement remain open.\n\nA read-only code:run call returned HTTP 502/read ECONNRESET (trace 26bbd9b4-0b3e-4a4a-b4b3-0cc178848e26). The failure coalesced onto EI-24802357246708467. Remaining reads used the maintained current-build ptool CLI. Successful fallback does not resolve the transport defect.\n\nSource artifacts are in audits/parked-agent-resumption-2026-10-09/ under artifact slug papercusp: fire43-pre-cutoff-work-record-candidates-20261014-424d5.json; fire43-two-pre-cutoff-journal-rawrefs-20261014-424d5.json; fire43-two-pre-cutoff-journal-assessment-20261014-424d5.json.\n"
        }
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "reports:list (browse)"
        },
        {
          "tool": "reports:search (full text)"
        },
        {
          "tool": "reports:publish (supersede one)"
        }
      ]
    }
  }
}
