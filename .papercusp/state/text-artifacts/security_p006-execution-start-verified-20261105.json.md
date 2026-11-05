---
rel_path: "security/p006-execution-start-verified-20261105.json"
updated_at: 1793901670662
_body: "content"
---

{
  "schema": "p006-execution-start-verified-v1",
  "owner": "su-9aa0bac1-57ab-408e-a009-fd2b58012aa0",
  "workItems": [
    "WI-6554700010044291",
    "WI-6554700010045189"
  ],
  "startRequest": {
    "key": "p006-start-after-audit11-20261105-v1",
    "route": "http://127.0.0.1:3170",
    "outcome": "SUCCESS; admission ready; no new rows promoted; strict canonical writer proof independently read"
  },
  "canonicalExecutionStart": {
    "status": "ready",
    "version": "38",
    "content_hash": "8ad52fe3c10ca55ecca0e9b5d79f2e075832d5b521d0bd4d995f1b399351cc40",
    "execution_start_revision_seq": 42,
    "seq": 42,
    "start_content_hash": "8ad52fe3c10ca55ecca0e9b5d79f2e075832d5b521d0bd4d995f1b399351cc40",
    "schema": "plan-execution-start-v1",
    "scope": {
      "planSlug": "app-security-runtime-boundaries-and-defense-in-depth-2026-10-31",
      "harnessSlug": "papercusp",
      "workspaceId": "papercusp-workspace"
    }
  },
  "previousKeys": "75725313-1d13-4b40-964e-a60a6e71933d and p006-start-parent-repair-20261105-v1 are settled refusals; never replay. Successful new key is settled too; do not restart/re-audit unchanged plan.",
  "activationAudit": "audit11 PASS exact revision41/id84496; full source conversation reread retained in parent checkpoint",
  "specQuality": "PASS EI-27968098572197261; independent audit EI-27968810892464452 passed; do not repeat unchanged",
  "scope": "No code edits, locks, tests rerun or extra implementation agents this continuation; no LIVE_GATE_OPS. Manual lock mode remains.",
  "implementationNext": "Implement Mac privileged installer seam reusing native update_authorization.rs verifier and managed-policy directory activation lock. Fixed product destinations, immutable owned artifact bytes, root re-verification CURRENT trust and durable floors, ready acknowledgement BEFORE sidecar teardown, macOS10.15 support. Existing main.rs download_verify_then_install still invokes update.install in GUI closure; it cannot write root policy as a normal user. No existing Mac elevated update helper found in first-pass source search. Do not treat osascript arbitrary current executable path as a trusted root helper.",
  "proofPreserved": {
    "archive": "security/p006-checkpoint-WI4291-fd5d0291617f-20261105T1706Z.md@papercusp",
    "archiveChars": 31999,
    "checkRows": 5,
    "latestLocal": "security/p006-mac-policy-local-20261105T1642Z.json@papercusp",
    "replayTests": false
  },
  "holds": "All16 requirements/BAR/SEC/review/authenticated all-author provenance/installation/exact signed installed-artifact acceptance remain OPEN. Empty production authors refuse. No completed/shipped claim.",
  "sourceRead": "Canonical staging tree confirmed. Read update_authorization.rs1..370 and610..750; main.rs8910..9035,10435..10480,11940..11985; native suite fixture610+. Current native functional route desktop-native requires matching OS/native prerequisites; :3070 never needed for intermediate verification.",
  "localReceipts": [
    "/tmp/p006-start-after-audit11-20261105.json",
    "/tmp/p006-start-after-audit11-unwrapped-20261105.json",
    "/tmp/p006-execution-authority-readback-20261105.json",
    "/tmp/p006-start-receipt-friction-20261105.json"
  ]
}
