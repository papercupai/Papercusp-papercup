---
rel_path: "evidence/native-observer-20261023/attachments-12e9c9723675-bootstrap-probe-origin.json"
updated_at: 1792747579675
_body: "content"
---

{
  "schemaVersion": 1,
  "taskId": "0mvkqy3zruug732w3mq",
  "verdict": "16passed/1failed across2completefiles,0skips/0childsubstitution; LSPresourcecase failed on unowned bootstrap scope",
  "captures": [
    {
      "path": ".papercusp/scratch/native-plan/fair-2026-10-21/worker-full7-attachments-12e9c9723675-20261023.json",
      "sha256": "3f2deedf129902e87ff0c8c4c927cc32c2f598381cab03520f9da0bfd5696d17",
      "recordedSha": "12e9c9723675b7bcd76181c5ba7986a642c948c7",
      "worktreeDirty": false,
      "completionCheckpoint": {
        "schemaVersion": 1,
        "qualificationAttemptId": null,
        "runGroupId": null,
        "runContext": "clean-local",
        "runnerIdentity": "proof-v3 v25.9.0 linux x64",
        "state": "terminal",
        "noPersist": false
      },
      "sourceEvidenceStatus": "stable",
      "sourceReasons": [],
      "namedSources": [
        {
          "path": "packages/operator-core/lib/code-intelligence/fair-process-observer.test.ts",
          "sha256": "d83db4093c33abf7b90399dd5ced75eee169d848976281fd91ec0d335cd6fb45",
          "basis": "vite-pre-transform",
          "currentSha256": "d83db4093c33abf7b90399dd5ced75eee169d848976281fd91ec0d335cd6fb45"
        },
        {
          "path": "packages/operator-core/lib/code-intelligence/fair-process-observer.ts",
          "sha256": "83963bec7e10704820e706e161c895623d7cc42174689d439306aaf3366bc69a",
          "basis": "vite-pre-transform",
          "currentSha256": "83963bec7e10704820e706e161c895623d7cc42174689d439306aaf3366bc69a"
        }
      ],
      "nativeRun": {
        "reason": "passed",
        "unhandledErrorCount": 0,
        "modulePopulationMatched": true,
        "files": [
          {
            "testFile": "packages/operator-core/lib/code-intelligence/fair-process-observer.test.ts",
            "execution": {
              "passed": 10,
              "failed": 0,
              "skipped": 0,
              "collectionFailed": false,
              "passedCaseTitles": [
                "fair process lifetime witness > retains ordered PID, start identity and command custody after a migrated probe exits",
                "fair process lifetime witness > decodes the kernel attachment map without losing exited identities or nanosecond precision",
                "fair process lifetime witness > preserves fleeting forks, ignores thread births, and keeps a distinct launch root and migrated LSP scope",
                "fair process lifetime witness > refuses event/map faults, concurrent snapshots, missing roots and reset counters",
                "fair process lifetime witness > does not accept a missing/reused payload or a foreign target scope",
                "fair process lifetime witness > refuses malformed or duplicate membership instead of certifying an empty population",
                "separately managed process scope costs > includes observed nested projects but refuses foreign roots, escaping links and missing task lineage",
                "separately managed process scope costs > includes migrated LSP task memory while leaving thread counters out of process counts",
                "separately managed process scope costs > does not count a nested scope twice",
                "separately managed process scope costs > preserves missing/retired server costs and foreign or unsafe paths as unknown"
              ]
            }
          }
        ]
      }
    },
    {
      "path": ".papercusp/scratch/native-plan/fair-2026-10-21/worker-full7-attachments-12e9c9723675-20261023.1.json",
      "sha256": "ea767e66f6098dbdbc3805148fdc168417d50b72c219c46949dfec7a80aee83b",
      "recordedSha": "12e9c9723675b7bcd76181c5ba7986a642c948c7",
      "worktreeDirty": false,
      "completionCheckpoint": {
        "schemaVersion": 1,
        "qualificationAttemptId": null,
        "runGroupId": null,
        "runContext": "clean-local",
        "runnerIdentity": "proof-v3 v25.9.0 linux x64",
        "state": "terminal",
        "noPersist": false
      },
      "sourceEvidenceStatus": "stable",
      "sourceReasons": [],
      "namedSources": [
        {
          "path": "packages/operator-core/lib/code-intelligence/fair-comparison.integration.test.ts",
          "sha256": "20b99d51a4dcf4920a2b9c902574aa1f638bc367e1a61524e958c143be67f64c",
          "basis": "vite-pre-transform",
          "currentSha256": "20b99d51a4dcf4920a2b9c902574aa1f638bc367e1a61524e958c143be67f64c"
        },
        {
          "path": "packages/operator-core/lib/code-intelligence/fair-process-observer.ts",
          "sha256": "83963bec7e10704820e706e161c895623d7cc42174689d439306aaf3366bc69a",
          "basis": "vite-pre-transform",
          "currentSha256": "83963bec7e10704820e706e161c895623d7cc42174689d439306aaf3366bc69a"
        },
        {
          "path": "packages/operator-core/lib/systemd-scope.ts",
          "sha256": "c4214de57bbee85feb6e1d8b0bef18f785ec641b74d14fbd2faa53d5e89f9acf",
          "basis": "vite-pre-transform",
          "currentSha256": "c4214de57bbee85feb6e1d8b0bef18f785ec641b74d14fbd2faa53d5e89f9acf"
        }
      ],
      "nativeRun": {
        "reason": "failed",
        "unhandledErrorCount": 0,
        "modulePopulationMatched": true,
        "files": [
          {
            "testFile": "packages/operator-core/lib/code-intelligence/fair-comparison.integration.test.ts",
            "execution": {
              "passed": 6,
              "failed": 1,
              "skipped": 0,
              "collectionFailed": false,
              "failedCaseTitles": [
                "native protocol real confined worker lifecycle > includes the real language-server managed scopes in the worker lifetime and resource witness"
              ],
              "passedCaseTitles": [
                "native frozen comparison through the compiler pipeline > observes configuration changes that alter module resolution on the same native dispatcher",
                "native frozen comparison through the compiler pipeline > uses the registered dispatch gates before native graph execution",
                "native frozen comparison through the compiler pipeline > reconstructs the saved multilingual edition and refuses a changed measurement protocol before work",
                "native frozen comparison through the compiler pipeline > executes the frozen positive and absence controls and reconstructs their scores",
                "native protocol real confined worker lifecycle > counts fleeting forks and final thread-group exits through the prelaunch kernel observer, or reports unavailable",
                "native protocol real confined worker lifecycle > loads the saved edition, measures its real task scope and drains it before deleting its private files"
              ]
            }
          }
        ]
      }
    }
  ],
  "log": {
    "path": ".papercusp/scratch/bash-e43e3b1e-b50.log",
    "sha256": "6c8b54dafc158dc9ddba2c8a6a5627f74aa226fd5a345fb23b212a9a13d6a91a",
    "terminalLines": [
      "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=failed head=12e9c97236 uncommittedPaths=0/2 provenance=stamped startedAt=2026-10-23T09:09:30.452Z childSubstituted=0 skippedTests=0",
      "FULL_WORKER_INTEGRATION_EXIT=1 SIGNAL=null",
      "PRIVATE_PG_STOPPED {\"dataDir\":\"/tmp/pcv/papercusp-native-pg-Zwm1zc\",\"dataDirAbsent\":true}",
      "[capability:bash] JOB END: status=failed exit=1 at 2026-10-23T09:16:09.017Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output."
    ]
  },
  "ready": {
    "identity": {
      "taskId": "0mvkr64881ar9i7d1ms",
      "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope",
      "treeRoot": "/home/marsh-office/.papercusp/bench/fair-comparison-2026-10/repetitions/lsp-query-0-t5tKy0/tree",
      "home": "/home/marsh-office/.papercusp/bench/fair-comparison-2026-10/repetitions/lsp-query-0-t5tKy0/home",
      "sourceCommit": "90e6465ad21b79142bac4853bb1c9c958f868f41",
      "runtimeVersion": "typescript-language-server (vendored) / typescript 6.0.3"
    },
    "sample": {
      "sampledAt": "2026-10-23T09:15:11.618Z",
      "memoryCurrentBytes": 9408303104,
      "memoryPeakBytes": 9642573824,
      "memoryPeakBasis": "sum-of-scope-peaks-upper-bound",
      "scopeCosts": [
        {
          "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope",
          "taskId": "0mvkr64881ar9i7d1ms",
          "memoryBytes": 568340480,
          "peakMemoryBytes": 642527232,
          "cpuUsec": 13895367,
          "pidsCurrent": 21,
          "pidsEventsMax": 0
        },
        {
          "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-0mvkr6inmw8z0ao1cgw.scope",
          "taskId": "0mvkr6inmw8z0ao1cgw",
          "memoryBytes": 8839962624,
          "peakMemoryBytes": 9000046592,
          "cpuUsec": 116697523,
          "pidsCurrent": 40,
          "pidsEventsMax": 0
        }
      ],
      "peakChildProcesses": 6,
      "processObservation": {
        "witness": {
          "schemaVersion": 1,
          "scope": "launch-root-process-descendants",
          "clockTicksPerSecond": 100,
          "observerUid": 1000,
          "counters": {
            "writers": 0,
            "version": 164,
            "errors": 0,
            "root_pid": 1092965,
            "root_start": "1535799575600658",
            "peak": 6,
            "births": 30,
            "exits": 25,
            "threads": 63,
            "migrations": 2,
            "current": 5
          },
          "members": [
            {
              "pid": 1104699,
              "startNs": "1535812538169365"
            },
            {
              "pid": 1092965,
              "startNs": "1535799575600658"
            },
            {
              "pid": 1105995,
              "startNs": "1535813889934761"
            },
            {
              "pid": 1106517,
              "startNs": "1535814806170828"
            },
            {
              "pid": 1105505,
              "startNs": "1535813492310973"
            },
            {
              "pid": 1106190,
              "startNs": "1535814342783080"
            }
          ],
          "cgroupPaths": [
            "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u5737627.scope",
            "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-0mvkr6inmw8z0ao1cgw.scope",
            "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope"
          ],
          "scopeAttachments": [
            {
              "index": 0,
              "pid": 1092965,
              "startNs": "1535799575600658",
              "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope",
              "commandAtAttach": "systemd-run"
            },
            {
              "index": 1,
              "pid": 1105281,
              "startNs": "1535813294925695",
              "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u5737627.scope",
              "commandAtAttach": "systemd-run"
            },
            {
              "index": 2,
              "pid": 1105505,
              "startNs": "1535813492310973",
              "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-sidecar.slice/pc-0mvkr6inmw8z0ao1cgw.scope",
              "commandAtAttach": "systemd-run"
            }
          ]
        },
        "unknown": [],
        "overhead": {
          "taskId": "0mvkr648916e9ex35u5",
          "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr648916e9ex35u5.scope",
          "memoryBytes": 102420480,
          "peakMemoryBytes": 251150336,
          "cpuUsec": 4216135,
          "pidsCurrent": 10,
          "pidsEventsMax": 0
        }
      },
      "processCensus": {
        "taskId": "0mvkr64881ar9i7d1ms",
        "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope",
        "rootPid": 1092965,
        "processes": [
          {
            "pid": 1092965,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153579957",
            "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope"
          },
          {
            "pid": 1104699,
            "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153581253",
            "cgroupPath": "/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-test.slice/papercusp-test-run.slice/pc-0mvkr64881ar9i7d1ms.scope"
          }
        ],
        "childProcesses": 1,
        "unknown": []
      },
      "observedChildProcessesMax": 1,
      "indexFiles": [],
      "unknown": [
        "process-observer-unowned-cost-scope",
        "native-tool-seam-and-configuration-invalidation-not-verified"
      ]
    }
  },
  "bootstrapProbeCorrelation": {
    "scope": "/user.slice/user-1000.slice/user@1000.service/app.slice/run-u5737627.scope",
    "pid": 1105281,
    "sourcePath": "packages/operator-core/lib/systemd-scope.ts",
    "sourceSha256AtTestedCommit": "c4214de57bbee85feb6e1d8b0bef18f785ec641b74d14fbd2faa53d5e89f9acf",
    "spawnPath": ".papercusp/scratch/native-plan/fair-2026-10-21/worker-full7-attachments-12e9c9723675-20261023.1.json.native-processes/055950169176282145d6a12278851071c6934df7eb1692e3c5dc7aa92f7ae3c2.json",
    "spawn": {
      "event": "child-spawn",
      "pid": 1092965,
      "childPid": 1105281,
      "childIdentity": "a22a8bd7-d568-4192-9923-1a966a300216",
      "atMs": 1792746839820,
      "command": "systemd-run",
      "argv": [
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--property=CollectMode=inactive-or-failed",
        "--property=RuntimeMaxSec=5",
        "--property=TimeoutStopSec=1",
        "--",
        "/usr/bin/true"
      ]
    },
    "closePath": ".papercusp/scratch/native-plan/fair-2026-10-21/worker-full7-attachments-12e9c9723675-20261023.1.json.native-processes/75ebfcfde7e6d429d5f690909d9dc0f81f67ef316aaa27dd3d48b7233c998f82.json",
    "close": {
      "event": "child-close",
      "pid": 1092965,
      "childPid": 1105281,
      "childIdentity": "a22a8bd7-d568-4192-9923-1a966a300216",
      "atMs": 1792746839870,
      "code": 0,
      "signal": null
    },
    "conclusion": "Kernel scope attachment PID matches the worker recorded child-spawn and child-close. Its exact argv is the maintained probeTransientScopeSupport harmless scope probe. That probe moved an observed descendant into an unregistered auto-collected scope; sampling rightly leaves those scope costs unknown."
  },
  "remainingUnknowns": [
    "bootstrap probe memory/CPU accounting or removal of unnecessary probe at origin",
    "native tool and configuration qualification",
    "full frozen143case verdict",
    "opaque native child/socket/config source closure"
  ]
}
