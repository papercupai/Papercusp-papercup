---
rel_path: "verification/EI-26773717003971934/2026-10-23-native-commit-containment.json"
updated_at: 1792766200046
_body: "content"
---

{
  "workItem": "EI-26773717003971934",
  "containingCommit": "181ee2c9bc809168a0b18bcde4d21f0cd534a732",
  "files": [
    {
      "path": "apps/operator/scripts/psu-pty-host.mjs",
      "sha256": "7e4686fc70c53ff5e6bc16f3b0ee031ea60d2cf4473de47f74340e9db0c103fc",
      "matchesCommit": true
    },
    {
      "path": "apps/operator/scripts/psu-pty-host.d.mts",
      "sha256": "63a6a3dab73ce1010a4d27b36e10426fb18f95f81c90a02a836c2d047172f45b",
      "matchesCommit": true
    },
    {
      "path": "apps/operator/lib/psu-pty-host-execution-recovery.integration.test.ts",
      "sha256": "692390fa1f2d8686910bb206bac82fd0d5c221f481f1909ee1db2cbc245734f5",
      "matchesCommit": true
    },
    {
      "path": "apps/operator/lib/psu-pty-host-kickoff-activity.test.ts",
      "sha256": "d7b50ea73ac74d734c8c99cfb55bf44db5d17a109ca55ed50311d1bac5883fe7",
      "matchesCommit": true
    }
  ],
  "priorLocalProof": "verification/EI-26773717003971934/2026-10-23-native-abort-proof.json",
  "verificationScope": "Exact working bytes match each file at the named immutable local commit. This adds commit containment only; prior tests remain local-dirty receipts and no deployed-host or independent acceptance claim is made.",
  "declarationScope": "Current declaration SHA is now pinned for future qualification; it was not pinned in the historical 13:04 type receipt.",
  "publicationScope": "Local commit containment verified. Remote egress and runtime adoption are not inferred."
}
