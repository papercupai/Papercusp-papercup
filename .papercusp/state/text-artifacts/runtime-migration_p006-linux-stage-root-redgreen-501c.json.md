---
rel_path: "runtime-migration/p006-linux-stage-root-redgreen-501c.json"
updated_at: 1792823763269
_body: "content"
---

{
  "schemaVersion": 1,
  "item": "EI-26841012722271235",
  "plan": "node-to-bun-staged-migration-2026-10-22",
  "lane": "P-006",
  "scope": "Linux artifact producer source fix; candidate/install/signature/default/rollback/shipment acceptance remains open.",
  "rootCause": "Fresh Linux producer invokes tooling scripts outside selected frozen product root without binding their source/output roots. Inherited stale source overrides and stage-env tooling defaults select wrong inputs or destination.",
  "reuse": "Existing PAPERCUSP_STAGE_SOURCE_ROOT, PAPERCUSP_STAGE_SOURCE_SIDECAR and PAPERCUSP_DESKTOP_TARGET_ROOT seams.",
  "files": [
    {
      "path": "papercusp-desktop/bin/build-linux-local.sh",
      "sha256": "392a8a5ba20fa57b26512b58dee4bf03d3d883d033cf9c356c52edfcab49d1ac"
    },
    {
      "path": "papercusp-desktop/bin/stage-env-sidecars.sh",
      "sha256": "5a125cb0f0b6b07a82cc2cce3619142fd09254a46951b716caa72d7d891fd1db"
    },
    {
      "path": "papercusp-desktop/test/build-linux-distribution-profile.test.js",
      "sha256": "ac5623e915cec5e9a3a47a481387496fbc8df2660d8d3fc35db7a9dda81d2c01"
    }
  ],
  "regression": {
    "procedure": "Maintained fresh-branch fixture selects same and distinct tooling/product roots, seeds stale inherited source overrides, invokes real env-sidecar staging and asserts selected source/destination and preservation of tooling sidecar.",
    "red": {
      "task": "0mvm0qhbc1axd6oeepo",
      "log": ".papercusp/scratch/bash-b1a5a8ae-468.log",
      "sha256": "f432971ff42e3b771daf0ca1fc27dc8cedbd13114ab8ad0ada4324284376f92e",
      "nativeExit": 1,
      "tests": 1,
      "passed": 0,
      "failed": 1,
      "actual": "source=/stale/source; sidecar=/stale/sidecar"
    },
    "green": {
      "task": "0mvm0r53oithx011tqx",
      "log": ".papercusp/scratch/bash-0b195d69-734.log",
      "sha256": "699b2b248e232b54788d6e3b243550802e116bf0254dc521b81f61594685cd73",
      "nativeExit": 0,
      "tests": 13,
      "passed": 13,
      "failed": 0,
      "skipped": 0
    },
    "recheck": "2026-10-24 successor read complete native terminal markers and compared all named source/test hashes; unchanged proof was not rerun."
  },
  "existingGui": {
    "task": "0mvlz5oaq1wmllu61bu",
    "usesPreFixCaller": true,
    "frozenCandidateEvidenceAccepted": false,
    "terminal": "pending at 06:33Z"
  },
  "limitations": [
    "Source-level regression proof only.",
    "Existing GUI source archive is excluded from frozen-candidate proof.",
    "No live runtime/default or data store changes."
  ]
}
