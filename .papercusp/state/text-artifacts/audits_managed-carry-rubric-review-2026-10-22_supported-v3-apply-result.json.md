---
rel_path: "audits/managed-carry-rubric-review-2026-10-22/supported-v3-apply-result.json"
updated_at: 1792708731060
_body: "content"
---

{
  "requestKey": "managed-carry-r2-r5-r6-detectors-20261022-v3",
  "previewArtifact": "audits/managed-carry-rubric-review-2026-10-22/supported-v3-preview-d32eae0110.json",
  "result": {
    "ok": true,
    "pending": true,
    "idempotencyKey": "managed-carry-r2-r5-r6-detectors-20261022-v3",
    "receipt": {
      "idempotencyKey": "managed-carry-r2-r5-r6-detectors-20261022-v3",
      "rubricRef": "acceptance-managed-carry-lifecycle-enforcement-2026-09-13",
      "registered": true,
      "poll": {
        "tool": "rubrics:amend-status",
        "args": {
          "rubricRef": "acceptance-managed-carry-lifecycle-enforcement-2026-09-13",
          "idempotencyKey": "managed-carry-r2-r5-r6-detectors-20261022-v3"
        }
      }
    },
    "note": "The amendment reached its foreground response deadline and continues server-side. Poll rubrics:amend-status with this receipt; do not re-issue the amend while it reads running.",
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "rubrics:propose (whole-document revision)"
        },
        {
          "tool": "rubrics:get (read before amending)"
        },
        {
          "tool": "work_items:comment (post the exact approval JSON as a Threadable body)"
        },
        {
          "tool": "conversations:get (find the routed reviewer answer post id)"
        }
      ]
    }
  }
}
