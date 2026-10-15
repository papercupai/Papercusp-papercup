---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-native-retry-cleanup-fire25-424d5.json"
updated_at: 1791834045667
_body: "content"
---

{
  "schemaVersion": "native-retry-lock-cleanup-fire25-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "stopReason": "SYSTEM-WIDE PAUSE received from coordination handle 70c55; no task work after receipt.",
  "source": {
    "path": "apps/operator/scripts/hooks/cc/posttooluse-locks-release.sh",
    "sha256": "3c4192ffaa392bff066093d81fb2a0618d15741bc42a40bf452255198b8192ac"
  },
  "test": {
    "path": "apps/operator/scripts/hooks/cc/__tests__/pretooluse-locks-decision.test.ts",
    "sha256": "9c75cec8333f3ee3d03eaece90a78847e4d433138b17480911fd198e07789234"
  },
  "runs": [
    {
      "id": 21155821,
      "log": "/tmp/parked-fire25-retry-full-424d5.log",
      "exit": 0,
      "passed": 54,
      "failed": 0,
      "skipped": 0,
      "scope": "maintained complete hook file; local DIRTY at 39bba16fa3; harnessSlug NULL in original ledger"
    },
    {
      "id": 21155843,
      "log": "/tmp/parked-fire25-retry-copy-current-424d5.log",
      "exit": 0,
      "passed": 2,
      "failed": 0,
      "skipped": 52,
      "scope": "whole-directory materialized CURRENT hook, exact regression plus normal physical-domain release control"
    },
    {
      "id": 21155862,
      "log": "/tmp/parked-fire25-retry-copy-historical-424d5.log",
      "exit": 1,
      "passed": 1,
      "failed": 1,
      "skipped": 52,
      "scope": "whole-directory materialized historical c41fff15b12352e87a92c233f24762195c708dd3; normal release control passes; native retry expected one old-token release but observed zero"
    }
  ],
  "probeHelper": "apps/operator/scripts/hooks/cc/__tests__/hook-probe.ts materializeHookDir",
  "probeDirs": "/tmp/parked-fire25-hook-probe-dirs-424d5.json",
  "rootCauseScope": "Successful same-session native retry attests retained edit but pre-fix PostToolUse cannot consume old automatic release token. Comparison establishes this mechanism for the reproduced sequence; original failed-parent PostToolUse omission remains unverified.",
  "publication": {
    "head": "39bba16fa3a1aa32a82924e31734f7e68e4756e5",
    "sourceAndTestCommitted": false,
    "installedSha256": "d74aa0d7376f34ff4825db98668203c042fd2f984adb7fcc0841e52a261bd9b5",
    "installedContainsFix": false,
    "preview": "/tmp/parked-fire25-sync-preview-424d5.json",
    "run": "/tmp/parked-fire25-sync-run-424d5.json",
    "outcome": "skipped held_exclusive; system git-sync acquired19:35:37.124Z; no duplicate fire",
    "ownActiveLocks": []
  },
  "pending": [
    "Verify committed source/test and installed hook after pause is lifted; do not convert DIRTY proof into clean proof.",
    "Root933 private no-host behavior remains pending; do not repeat90 for recall or change peer route.",
    "Frozen116 cutoff eligibility precedes18+7 outcome joins; unaccepted.",
    "R14 ALL final-fix containing-runtime anchor absent; no24h due time."
  ],
  "processes": "All newly started exec handles12549/16545/5868 completed and drained; inherited handles were not polled.",
  "taskEditsThisContinuation": []
}
