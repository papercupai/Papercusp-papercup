---
rel_path: "evidence/idop-shell-quote-splice-guard-commit-containment-20261029-fire46.json"
updated_at: 1793242621924
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "shell-guard-commit-containment",
  "workItem": "EI-27266551901301989",
  "observedAt": "2026-10-29T02:56:23.965239+00:00",
  "head": "5489b3040ec18bb9b1c93b63c6f8dae12492c8f1",
  "canonicalRoot": "/home/marsh-office/papercupai-workspace/papercusp",
  "branch": "staging",
  "originalProof": {
    "path": "evidence/idop-shell-quote-splice-guard-repair-20261029-fire45.json",
    "sha256": "7bbd6319671dd89bba98992214dd7be02de4a449484812bacbfb3828f3571c8a",
    "bytes": 605105,
    "pins": [
      {
        "sha256": "80f73448b60e753ca68e6fb6c725c1fbfa3d1c523f9337ab4012d929263bf025",
        "bytes": 379629,
        "verified": true
      },
      {
        "sha256": "6bfd9c126b9d78fe47baaf0af8759b5e3b531fe3977aa6f1e72abe0fcc01530f",
        "bytes": 380397,
        "verified": true
      },
      {
        "sha256": "ed376ff441587c5b16b90ced0515947eb75105774d0ba3c03d8323509016cd86",
        "bytes": 374431,
        "verified": true
      },
      {
        "label": "baseline",
        "sha256": "cbd1e8800941de2c0715b6c692828f42a1edef02514295bba408edcbfbb49c18",
        "bytes": 507034,
        "verified": true
      },
      {
        "label": "focusedFixed",
        "sha256": "3669de7fae93e5f088d2a3b65b94df7afdddf0bbd66fcb55215a5d7bc9314bc5",
        "bytes": 394825,
        "verified": true
      },
      {
        "label": "fullFixed",
        "sha256": "d85f42fe60675e84e2d5e78d6365463038fc80bd98eaa97d868dfd47375c0d73",
        "bytes": 46675,
        "verified": true
      }
    ]
  },
  "sources": [
    {
      "path": "apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh",
      "sha256": "6bfd9c126b9d78fe47baaf0af8759b5e3b531fe3977aa6f1e72abe0fcc01530f",
      "headContainsExactBytes": true,
      "status": "",
      "bytes": 380397
    },
    {
      "path": "apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts",
      "sha256": "ed376ff441587c5b16b90ced0515947eb75105774d0ba3c03d8323509016cd86",
      "headContainsExactBytes": true,
      "status": "",
      "bytes": 374431
    }
  ],
  "retainedTestResult": {
    "baselineNewCases": {
      "failed": 4,
      "passed": 2,
      "filteredOut": 1062
    },
    "focusedFixed": {
      "passed": 6,
      "failed": 0,
      "filteredOut": 1062
    },
    "fullFixed": {
      "passed": 1068,
      "failed": 0,
      "skipped": 0,
      "childSubstituted": 0
    }
  },
  "limits": [
    "Saved runs were local dirty-tree runs; this read proves exact repaired source/test content is now committed, not a new as-committed run.",
    "No deployment, original P001 acceptance, complete import closure or git-sync general root-cause claim."
  ],
  "commands": [
    "git rev-parse HEAD",
    "git branch --show-current",
    "git show <head>:<each named path>",
    "git status --porcelain -- <each named path>"
  ]
}

