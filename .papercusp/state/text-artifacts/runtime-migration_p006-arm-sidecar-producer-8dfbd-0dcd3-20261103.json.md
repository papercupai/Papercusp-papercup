---
rel_path: "runtime-migration/p006-arm-sidecar-producer-8dfbd-0dcd3-20261103.json"
updated_at: 1793683276486
_body: "content"
---

{
  "schemaVersion": 1,
  "at": "2026-11-03T05:21:00Z",
  "scope": "Native linux-arm64 sidecar producer; installed and final signed-package acceptance not asserted",
  "source": {
    "sha": "8dfbd7a3b58ee30c9e1e164f10b6a6a91da550cf",
    "cleanAtProducerStart": true,
    "cleanAtReadback": true,
    "root": "/home/marsh-office/bun-p006-8dfbd-0dcd3/source",
    "nativeHost": "compute.7267754029919619670"
  },
  "producer": {
    "taskId": "0mw083nir1g5bjqb1mf",
    "log": ".papercusp/scratch/bash-3d4ab75c-4b8.log",
    "status": "completed",
    "exitCode": 0,
    "endedAt": "2026-11-03T05:15:04.209Z",
    "containerRemoved": true,
    "imageId": "sha256:2c664b733f72f6668b88ffe8790911714e35bd0479a77d1d0378a34d0394c3c7",
    "mode": "Existing standalone producer PAPERCUSP_SKIP_DEP_GENERATION=1; no checkpoint-safe generation asserted"
  },
  "bundle": {
    "path": "/home/marsh-office/bun-p006-8dfbd-0dcd3/source/papercusp-desktop/src-tauri/sidecar",
    "serveSha256": "3dc9a05701aa08d25464c0f88b3f6523965b2bac561bf298df359fe487a3b0d1",
    "bun": {
      "version": "1.4.4",
      "sha256": "354c2b049c716aca07b2e5cddb887928ac58950675d1258bb6312083917793b6"
    },
    "retainedNode": {
      "version": "24.18.1",
      "sha256": "e98373424346e5dc6191351cdd147155e3e13667fbafc284d1df58299527f0ec"
    },
    "provenance": {
      "file": "build-provenance.json",
      "bytes": 1493,
      "sha256": "4e9303834ccd9c0a4add9e619d6e8ceeb77ddffe7b236214963139ceca2c0f5d",
      "version": "0.0.32",
      "gitDirty": false
    },
    "stamp": {
      "file": ".sidecar-build-stamp",
      "bytes": 471,
      "sha256": "3f14a8d9db464961ee4396357aff9bb0806ca170c64d7f8b22c3ec97984971b6"
    }
  },
  "verification": {
    "beforeAtomicPublish": "pass",
    "afterAtomicPublish": "pass",
    "bundledElfClosure": 274,
    "nativeModulesLoad": 11,
    "packagedBootImportClosure": "pass",
    "remoteInitializerProtocolCycle": "pass",
    "releaseIdentityAudit": "pass",
    "readbackLog": ".papercusp/scratch/bash-3443aba1-d01.log",
    "candidateAccepted": false
  },
  "remaining": [
    "Native final package production/signatures",
    "Installed full target matrix",
    "Bun default eligibility and single ownership",
    "Canary/soak/rollback/BAR",
    "7-day retained Node window",
    "Final shipped status"
  ]
}

