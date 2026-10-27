---
rel_path: "evidence/bg-host-p001-metadata-custody-20261026-01a17677.json"
updated_at: 1792993861401
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "item": "P-001",
  "nativeSession": "01a17677-9d82-7571-9034-9bfb21c36009",
  "date": "2026-10-26",
  "scope": "Detached local source verification only; P001, runtime qualification and Luna shipment remain open.",
  "rootCause": "Compiler custody authenticated onLoad buffers and endpoint census hashes, but resolver package metadata could change and be restored during resolution. Esbuild selected a different original-censused JavaScript file while both endpoint checks agreed.",
  "distinguishingTest": {
    "before": 22120852,
    "observation": "Esbuild produced dep=99 after package main selected alternate.js; original package.json bytes were restored, endpoint source/dependency checks agreed, and publication incorrectly accepted the build.",
    "alternative": "An onLoad buffer substitution would fail its digest; both index.js and alternate.js were in the original census and unmodified."
  },
  "fix": "Retain original source/dependency physical path, device, inode, mode, link count, size, mtimeNs and ctimeNs before compilation; refuse publication after any identity change, including restored content.",
  "files": [
    {
      "path": "scripts/source-preview.mjs",
      "sha256": "919dfc1e385bc9637c49768a826e4fc2b27aa0393a4527b4c1de6a3bd9fc1b9f"
    },
    {
      "path": "scripts/source-preview.d.mts",
      "sha256": "dde355bb5ff4e4110c4ee0205cd09997636c9d4c1391236267bedf20dd459d63"
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "sha256": "566c80ff92ca8fc1d614bdbe1c5f5a4d2c7c63cbf3bd8699a0f0f8451ef3b48d"
    }
  ],
  "verification": [
    {
      "testRunId": 22120892,
      "result": "PASS6;0fail;386filtered;childSubstituted0",
      "runGroup": "98277d83-a9c7-4728-a0be-5bb3f3326eaf",
      "cases": "real changed/restored package resolution; identical-byte rewrites of original source/dependency metadata; unchanged real compilation; original source/dependency transient-byte guards"
    },
    {
      "testRunId": 22121590,
      "result": "PASS3;0fail;389filtered;childSubstituted0",
      "cases": "private pinned real esbuild; original main/worker output-only recipe publication; original ancillary source copy publication"
    },
    {
      "command": "npm run lint:tsc -- --files=scripts/source-preview.d.mts,packages/operator-core/lib/source-preview-export.test.ts",
      "result": "scripts and operator-core scopes clean, exit0",
      "log": "/tmp/bg-host-p001-metadata-typed-final-20261026.log"
    },
    {
      "command": "node --check scripts/source-preview.mjs; git diff --check (three changed files)",
      "result": "exit0"
    }
  ],
  "limits": [
    "Dirty worktree/local evidence; committed source containment unverified.",
    "General/script typecheck with .mjs named returns partial: actual scripts TS program excludes .mjs. Generated declaration and test types passed separately.",
    "Absent resolver inputs, full production recipe/population, directory asset expansion, compiler self-consumption/runtime closure and R4 remain incomplete.",
    "REAL parent manifest UNKNOWN bars actual source preparation and activation.",
    "No runtime cohort, restart, deploy, LIVE_GATE_OPS, or Luna shipment verified."
  ],
  "continuation": "Do not rerun these nine cases or prior unchanged Fire75 matrices solely to reconstruct proof. Next inspect maintained bundle-host/common recipe population capture and close independent P001 source obligations. Preserve D014 and main-greening D017 ownership."
}
