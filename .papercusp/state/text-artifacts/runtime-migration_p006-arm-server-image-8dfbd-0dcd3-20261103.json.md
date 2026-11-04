---
rel_path: "runtime-migration/p006-arm-server-image-8dfbd-0dcd3-20261103.json"
updated_at: 1793684621917
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Native ARM local server image qualification under retained Node; Bun/default/installed matrix/shipment not accepted",
  "taskId": "0mw08xkh81cbpigt17d",
  "log": ".papercusp/scratch/bash-dcc32816-798.log",
  "exitCode": 0,
  "nativeReceiptPath": "/home/marsh-office/bun-p006-8dfbd-0dcd3/server-image/papercusp-server-arm64-0e8f1d84942f/build.json",
  "localReceiptPath": "/mnt/data/tmp/bun-p006-arm-server-image-8dfbd-0dcd3-20261103/native-build.json",
  "nativeReceiptSha256": "f55abda826bd69edf5e2bcb35d3d49b86ad30d6a4772d7e7a3d3b2bcac6473b3",
  "native": {
    "schemaVersion": 1,
    "kind": "papercusp-server-local-image",
    "platform": "linux/arm64",
    "tag": "papercusp-bun-p006:8dfbd-arm64",
    "imageId": "sha256:0e8f1d84942f64a323af87378639278520f9da1e12abc9a6a9d42424e465d887",
    "sourceCommit": "8dfbd7a3b58ee30c9e1e164f10b6a6a91da550cf",
    "labels": {
      "org.opencontainers.image.revision": "8dfbd7a3b58ee30c9e1e164f10b6a6a91da550cf",
      "com.papercusp.rootfs.sha256": "ff424db984b09bac202b4d44b12b7b03f184987599ea0c374404032bc48b1781",
      "com.papercusp.sidecar.sha256": "a5a05676562256be4ac1aeb285552dd8423c15991cca064a0300aa5ea52d4915",
      "com.papercusp.serve.sha256": "3dc9a05701aa08d25464c0f88b3f6523965b2bac561bf298df359fe487a3b0d1",
      "com.papercusp.native.release-audit": "passed",
      "com.papercusp.native.source-verified": "true"
    },
    "engine": "docker",
    "rootfsBaseImage": "ubuntu:24.04",
    "payloadVerification": {
      "serveSha256": "3dc9a05701aa08d25464c0f88b3f6523965b2bac561bf298df359fe487a3b0d1",
      "mcpProxySha256": "f730c5aee493a0bc8465f051c07c35a17ac1b88f9f590810ab143e5e1b47b108",
      "nodeArch": "arm64",
      "nodeVersion": "v24.18.1"
    },
    "bootVerification": {
      "schemaVersion": 1,
      "imageId": "sha256:0e8f1d84942f64a323af87378639278520f9da1e12abc9a6a9d42424e465d887",
      "platform": "linux/arm64",
      "sourceCommit": "8dfbd7a3b58ee30c9e1e164f10b6a6a91da550cf",
      "verifiedAtUtc": "2026-11-03T05:35:06.836Z",
      "homeVerification": {
        "uid": 1001,
        "gid": 1001,
        "homeUid": 1001,
        "homeGid": 1001,
        "mode": 448,
        "empty": true,
        "writable": true
      },
      "arch": "arm64",
      "node": "v24.18.1",
      "ready": {
        "status": 200,
        "body": {
          "ok": true,
          "ready": true,
          "dbos": true,
          "dbosEnabled": true,
          "ts": "2026-11-03T05:35:06.662Z"
        }
      },
      "health": {
        "status": 200,
        "body": {
          "ok": true,
          "service": "papercusp-operator",
          "sha": "8dfbd7a3b58ee30c9e1e164f10b6a6a91da550cf",
          "version": "0.0.32",
          "claimSpec": {
            "specVersion": "1.0",
            "revisionAdoption": [
              "first"
            ]
          },
          "ts": "2026-11-03T05:35:06.677Z"
        }
      },
      "database": {
        "vectorReady": true,
        "schemaReady": true,
        "serverVersion": "18.4"
      }
    },
    "rootfsRecipeSha256": "a54f2506f1e440b514666accca0c67cc2a1b8caa7f344c709972cae7ac0d94a9",
    "containerfileSha256": "6ac58e752f19a16acc486b45be662298db85c5da2876af194fc6905f81093e6a",
    "buildMode": "build",
    "sbomSha256": "ecf4eda3b0691d7325bcd98db4cc549db334fa9f62e8fe42fe044f3dc2bb1805",
    "sbomPackages": 12975,
    "sbomPath": "/home/marsh-office/bun-p006-8dfbd-0dcd3/server-image/papercusp-server-arm64-0e8f1d84942f/sbom.cdx.json",
    "signed": false,
    "published": false
  }
}

