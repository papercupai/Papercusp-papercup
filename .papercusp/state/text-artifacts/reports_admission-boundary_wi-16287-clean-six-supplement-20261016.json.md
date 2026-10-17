---
rel_path: "reports/admission-boundary/wi-16287-clean-six-supplement-20261016.json"
updated_at: 1792188198377
_body: "content"
---

{
  "schemaVersion": 1,
  "workItemId": "WI-6554700010016287",
  "planSlug": "work-queue-exclusion-alarm-duplicates-2026-10-16",
  "commitSha": "28f698820ec65c9ef301d257a34f7974a797f1eb",
  "scope": "papercusp-workspace/papercusp",
  "sourceVerification": "All four committed blobs equal the original test-time captures; rechecked in this continuation.",
  "files": [
    {
      "path": "packages/operator-core/lib/coord/actionable-conditions.ts",
      "sha256": "71a39d7df3feb445ddf3ef3fa3b917aa1ecd182611eee8327f3c35dd45661aaf"
    },
    {
      "path": "packages/operator-core/lib/coord/condition-bridge.test.ts",
      "sha256": "42411bfa1aae4aec3cc11a92f54b61b1cd7a24acc2be719a9e114c2a5fdc0944"
    },
    {
      "path": "packages/operator-core/lib/work-items-admission-promoter.ts",
      "sha256": "b5193078f4ff6b9a20257a9c8c73f03572e302f9b5990fbf0eba6cc5c968c20a"
    },
    {
      "path": "packages/operator-core/lib/work-items-admission-promoter.integration.test.ts",
      "sha256": "05bdc94bbdd496c0b4a07007811c23b4e6d409961ef11d63640bc82cb03529f8"
    }
  ],
  "testRuns": [
    {
      "id": 21294405,
      "passed": 13
    },
    {
      "id": 21294406,
      "passed": 10
    },
    {
      "id": 21294407,
      "passed": 5
    },
    {
      "id": 21294408,
      "passed": 23
    },
    {
      "id": 21294415,
      "passed": 103
    },
    {
      "id": 21294416,
      "passed": 18
    }
  ],
  "result": {
    "passed": 172,
    "failed": 0,
    "skipped": 0,
    "requestedFiles": 6,
    "executedFiles": 6,
    "matchedFiles": 6,
    "childSubstituted": 0,
    "worktreeDirty": false
  },
  "log": {
    "path": "/tmp/wi16287-as-committed-six-2136.log",
    "sha256": "f257bbda4642d63d5f3787680fe2786359f75c0ad62e60de022f4606270b646b",
    "bytes": 912085
  },
  "limits": [
    "Named source/test footprints only; full transitive graph is not fingerprinted.",
    "This is committed source proof, not evidence of deployment.",
    "Separate focused calibration/mutation records are additional proof; they do not replace the original 172-case corpus."
  ]
}
