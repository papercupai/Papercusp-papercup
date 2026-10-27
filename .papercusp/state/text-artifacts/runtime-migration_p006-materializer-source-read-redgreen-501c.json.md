---
rel_path: "runtime-migration/p006-materializer-source-read-redgreen-501c.json"
updated_at: 1792808366734
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-26824212147685395",
  "parent": "WI-6554700010022072",
  "plane": "local-maintained-source-regression",
  "summary": "Guard the complete Bash materializer body against same-inode script rewrites during allocation/dependency waits.",
  "rootCause": "Bash lazily parses sequential top-level commands. A sourced helper's compound guard does not protect its caller; after an allocation wait the caller can resume at an obsolete byte offset in replacement source.",
  "fix": "Existing setup-release-checkout.sh now wraps its executable body in one compound command, parsed before the first wait, preserving BASH_SOURCE resource roots.",
  "recurrenceGuard": "apps/operator/lib/release/setup-release-checkout-help.test.ts: actual script clones a real pinned fixture repository, waits at injected allocation handshake, is overwritten on the same inode, then must finish with original pinned contents and HEAD.",
  "red": {
    "log": "/tmp/bun-p006-source-read-red-501c.log",
    "sha256": "32c56598c0c1aa2cb5ae54cd6b99979d11c208ab43108bbb976a1dab170c8342",
    "nativeExit": 1,
    "subprocessExit": 127,
    "passed": 4,
    "failed": 1,
    "childSubstituted": 0
  },
  "green": {
    "log": "/tmp/bun-p006-source-read-green-501c.log",
    "sha256": "1f4a6604253fc8debb874bbee024332cd1214229490af4749a122b1d3a4c55af",
    "nativeExit": 0,
    "suites": 7,
    "passed": 171,
    "failed": 0,
    "skipped": 0,
    "childSubstituted": 0
  },
  "sourceMap": {
    "path": "/tmp/bun-p006-source-read-green-sources-501c.json",
    "sha256": "b1478140f5b6f86415e998b1b70748566698be85111b83368f6502322be8eb2b"
  },
  "sourceHashes": {
    "apps/operator/bin/release/setup-release-checkout.sh": "ccf40562959df6b9fb28bc3443bd3dd49b943aea9cc71640c381d8131ef1b279",
    "apps/operator/lib/release/setup-release-checkout-help.test.ts": "0793b047b61c87a7d1e98ae848b039eb5b1722ba3cb8e58b87504cc96e443eb4"
  },
  "verification": "Native terminal exits recorded in owned checkpoint; saved log counts read back and named source/test hashes reconfirmed against HEAD in successor. Prior bash -n and git diff --check passed. Unchanged suites were not rerun.",
  "limitations": [
    "Root cause directly proven for controlled rewrite; original production-launched script bytes unavailable.",
    "HEAD moved during green; complete imported/configuration provenance remains unknown.",
    "Prior partial P006 clone remains unaccepted; installed ten-cell matrix and shipment acceptance remain open; Node remains active."
  ]
}
