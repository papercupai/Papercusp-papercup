---
rel_path: "runtime-migration/p004-evaluator-archive-custody-repair-0dcd3-20261102.json"
updated_at: 1793601271745
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "EI-27654977482800018",
  "parentWorkItem": "WI-6554700010022070",
  "rootCause": "Direct wx publication of shared content-addressed evaluator files exposes partial bytes to concurrent EEXIST readers and retains partial final files after interrupted writes. Both interleavings reproduced deterministically in maintained tests.",
  "fix": "Completed temporary write outside trusted inventory, no-replace hardlink publication, staging cleanup; existing symlink/regular-file/digest validation unchanged. Reuses native tracer pattern.",
  "source": {
    "libs/test-config/src/executed-inputs-capture.ts": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5",
    "libs/test-config/src/executed-inputs-capture.test.ts": "49596fc16b919ef86582b74ce34f48cfe9291658da4fb2eeb339c98ccf55bc76"
  },
  "logs": [
    {
      "path": "/tmp/ei276549-red-local-0dcd3-20261102.log",
      "sha256": "ddc475fd545ab35cbff2531d29db649d48039951fb8bc79b65932672ed61a943",
      "observations": [
        "      Tests  2 failed | 12 skipped (14)",
        "TEST_FILE_NATIVE_CUSTODY status=complete directory=\"/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-7glSuo\" manifest={\"ref\":\"b0f07ba028287b321f14bc6ab6100414f1e1b1ed16145fe848998ae60be611d7.native-proof.json\",\"sha256\":\"b0f07ba028287b321f14bc6ab6100414f1e1b1ed16145fe848998ae60be611d7\",\"byteLength\":765546}",
        "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=3a29b7d8b4 uncommittedPaths=1/1 provenance=unknown startedAt=2026-11-02T06:24:33.978Z childSubstituted=0 skippedTests=12"
      ]
    },
    {
      "path": "/tmp/ei276549-green-0dcd3-20261102.log",
      "sha256": "d155aa7bcf110fa347a85d1b815e698672fce8e12e1dec68b44856d26b3f123e",
      "observations": [
        "      Tests  15 passed | 1 skipped (16)",
        "TEST_FILE_NATIVE_CUSTODY status=complete directory=\"/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-LyMeyP\" manifest={\"ref\":\"e7bbcafc5775d4356a01d66f6cd7278afdeda79b1781cb5feb89271be913bd45.native-proof.json\",\"sha256\":\"e7bbcafc5775d4356a01d66f6cd7278afdeda79b1781cb5feb89271be913bd45\",\"byteLength\":908334}",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=cdecd89728 uncommittedPaths=1/2 provenance=stamped startedAt=2026-11-02T06:26:31.915Z childSubstituted=0 skippedTests=1"
      ]
    },
    {
      "path": "/tmp/ei276549-types-fixed-0dcd3-20261102.log",
      "sha256": "2014f5921e79eb82584c8cc27126adef1cd112a68e07cc69b1e719f4dc786041",
      "observations": []
    },
    {
      "path": "/tmp/p004-offline-custody-fixed-0dcd3-20261102.log",
      "sha256": "8121c107077df334256fe5d62b9775bc62062bf70de66016e84d2a23969e987b",
      "observations": [
        "      Tests  15 passed | 32 skipped (47)",
        "TEST_FILE_NATIVE_CUSTODY status=complete directory=\"/home/marsh-office/.papercusp/test-artifacts/testing-run/native-router-IDgXcB\" manifest={\"ref\":\"c400a75c0ca3ed777bee7ce4b39691b29fd0d24b0e147771de0f26d980dee260.native-proof.json\",\"sha256\":\"c400a75c0ca3ed777bee7ce4b39691b29fd0d24b0e147771de0f26d980dee260\",\"byteLength\":1023069}",
        "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=b7d6a118c7 uncommittedPaths=0/2 provenance=stamped startedAt=2026-11-02T06:30:55.353Z childSubstituted=0 skippedTests=32"
      ]
    }
  ],
  "maps": [
    {
      "path": "/tmp/ei276549-green-source-0dcd3-20261102.json",
      "sha256": "dfbdde66d63d1595d77d0e90b29c1d454d7bf55b1d45e358f760ef3c067e7a8f",
      "recordedSha": "cdecd897280bbf720e56caa57b99e73f1fee6ddb",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "rows": [
        {
          "file": "libs/test-config/src/executed-inputs-capture.test.ts",
          "pinsVerified": 24,
          "invalidPins": [],
          "reasons": [
            "pre-setup-evaluations-unobserved",
            "runtime-inputs-outside-evaluator",
            "external-loader-bytes-unobserved"
          ],
          "sourceStatus": "stable",
          "captureProducer": [
            {
              "path": "libs/test-config/src/executed-inputs-capture.ts",
              "sha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5",
              "basis": "vite-pre-transform",
              "currentSha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5"
            }
          ],
          "opaque": [
            "worker-runtime-unavailable"
          ]
        },
        {
          "file": "libs/test-config/src/executed-inputs-capture-armed-run.test.ts",
          "pinsVerified": 24,
          "invalidPins": [],
          "reasons": [
            "pre-setup-evaluations-unobserved",
            "runtime-inputs-outside-evaluator",
            "external-loader-bytes-unobserved"
          ],
          "sourceStatus": "stable",
          "captureProducer": [
            {
              "path": "libs/test-config/src/executed-inputs-capture.ts",
              "sha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5",
              "basis": "vite-pre-transform",
              "currentSha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5"
            }
          ],
          "opaque": [
            "child-process",
            "worker-runtime-unavailable"
          ]
        }
      ]
    },
    {
      "path": "/tmp/p004-offline-custody-fixed-source-0dcd3-20261102.json",
      "sha256": "c34903cda7a3993275ef1a9b637613af4eb703976370bef941bd69058b0d3248",
      "recordedSha": "b7d6a118c7750f28ef8ce83b6932a38e348e64c6",
      "worktreeDirty": true,
      "nativeReason": "passed",
      "rows": [
        {
          "file": "packages/operator-core/lib/application-runtime-acceptance-offline.test.ts",
          "pinsVerified": 34,
          "invalidPins": [],
          "reasons": [
            "pre-setup-evaluations-unobserved",
            "runtime-inputs-outside-evaluator",
            "external-loader-bytes-unobserved"
          ],
          "sourceStatus": "stable",
          "captureProducer": [
            {
              "path": "libs/test-config/src/executed-inputs-capture.ts",
              "sha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5",
              "basis": "vite-pre-transform",
              "currentSha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5"
            }
          ],
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        },
        {
          "file": "packages/operator-core/lib/vm-release-runtime-policy.test.ts",
          "pinsVerified": 48,
          "invalidPins": [],
          "reasons": [
            "pre-setup-evaluations-unobserved",
            "runtime-inputs-outside-evaluator",
            "external-loader-bytes-unobserved"
          ],
          "sourceStatus": "stable",
          "captureProducer": [
            {
              "path": "libs/test-config/src/executed-inputs-capture.ts",
              "sha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5",
              "basis": "vite-pre-transform",
              "currentSha256": "5b01c473367dbdd79d13ca9d020559fe602b9442dc64fd62d35b43530f0f05d5"
            }
          ],
          "opaque": [
            "child-process",
            "worker-thread",
            "worker-runtime-unavailable"
          ]
        }
      ]
    }
  ],
  "limits": [
    "Local source proof only; Node active, final signed candidate/platform BAR acceptance/shipment unproven.",
    "Capture15PASS1existingmode-skip; P00415PASS32deliberatelyunselected are separate populations.",
    "Full capture preceded a numeric-file-descriptor type narrowing in regression only; final full test-config typecheck exit0.",
    "Maps retain dirty worktree/runtime/external/child opacity. Original failed custody proof remains separate. No source hash claimed as complete retrospective closure."
  ]
}
