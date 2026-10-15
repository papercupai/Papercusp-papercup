---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold22-committed-custody-424d5.json"
updated_at: 1791889353854
_body: "content"
---

{
  "schemaVersion": "cold22-committed-custody-v1",
  "commit": {
    "head": "e8e83b6c00341b8f45ff841c3225e21f7dca620a",
    "files": [
      {
        "path": "packages/operator-core/lib/session-archive-hook.ts",
        "workingSha256": "34caf85bcd78a89eb1747fb016645d1739713762c5c180494028c33d114a2967",
        "committedSha256": "34caf85bcd78a89eb1747fb016645d1739713762c5c180494028c33d114a2967"
      },
      {
        "path": "packages/operator-core/lib/session-archive-hook.test.ts",
        "workingSha256": "2e48fb18251617283576b2aef499aadf62ab75ec192592787e039ee37e37d194",
        "committedSha256": "2e48fb18251617283576b2aef499aadf62ab75ec192592787e039ee37e37d194"
      },
      {
        "path": "packages/operator-core/lib/session-archive-reconciler.test.ts",
        "workingSha256": "6dc7b5e1c607c6d049afcc9fe5d5a45f447273caf107e5b2698fddbf0bd1c1c9",
        "committedSha256": "6dc7b5e1c607c6d049afcc9fe5d5a45f447273caf107e5b2698fddbf0bd1c1c9"
      }
    ]
  },
  "ledger": [
    {
      "id": "21196084",
      "file_path": "packages/operator-core/lib/session-archive-reconciler.test.ts",
      "status": "pass",
      "commit_sha": "1d5e73b2025883f57c9a122fe8e2932c334f66a8",
      "passed": "16",
      "failed": "0",
      "skipped": "0",
      "worktree_dirty": true
    },
    {
      "id": "21196085",
      "file_path": "packages/operator-core/lib/session-archive-hook.test.ts",
      "status": "pass",
      "commit_sha": "1d5e73b2025883f57c9a122fe8e2932c334f66a8",
      "passed": "43",
      "failed": "0",
      "skipped": "0",
      "worktree_dirty": true
    }
  ],
  "proof": "audits/parked-agent-resumption-2026-10-09/r13-cold22-legacy-ingest-custody-proof-424d5.json",
  "scope": "Original execution was LOCAL/DIRTY,59 PASS0FAIL0SKIP. Exact tested source/test hashes now equal committed e8e83b6c; no clean rerun or runtime install claimed."
}
