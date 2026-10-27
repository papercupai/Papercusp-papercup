---
rel_path: "verification/EI-26759612479891450/2026-10-23-runner-generation-lifetime-current-source-v2.json"
updated_at: 1792747910620
_body: "content"
---

{
  "schemaVersion": 2,
  "workItem": "EI-26759612479891450",
  "parent": "EI-26742095048555144",
  "program": "WI-6554700010016092",
  "scope": "Committed subject bytes and actual native systemd scope verified. Shared-tree test ledger rows remain worktreeDirty=true; no whole-tree clean claim, deployed bg-host adoption or global storage-resolution claim.",
  "priorArtifact": "verification/EI-26759612479891450/2026-10-23-runner-generation-lifetime-local-v1.json",
  "sourceCommit": "6bffe39570ed67111efcd2689c991791b3bb28b2",
  "files": [
    {
      "path": "packages/operator-core/lib/systemd-scope-env-runner.mjs",
      "sha256": "ff1bcc1eba7c15b1d8494f36abd833511d3d3e88cd32cc64d0bb346efad25f99"
    },
    {
      "path": "packages/operator-core/lib/systemd-scope-env-runner.signal-grace.test.ts",
      "sha256": "e6932d1c402464419a8925f1576f32e7db6228d61e123489e36c9818504c805d"
    }
  ],
  "tests": {
    "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/systemd-scope-env-runner.signal-grace.test.ts packages/operator-core/lib/task-manager/managed-spawn-payload-env.test.ts",
    "testRunIds": [
      21811781,
      21811780
    ],
    "passed": 26,
    "failed": 0,
    "skipped": 0,
    "stamp": "TEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=6bffe39570 uncommittedPaths=0/2 provenance=stamped startedAt=2026-10-23T09:24:26.624Z childSubstituted=15 skippedTests=0",
    "logPath": "/tmp/4acaa-runner-committed.log",
    "logSha256": "b62735cc1257529908e5680078d2f8386150fba426bcbb90a296237f9df8c519",
    "worktreeDirty": true,
    "dirtyReason": "Shared-tree reporter observed unrelated porcelain entries. Both changed subject files matched committed bytes; do not bind as a whole-tree clean run.",
    "subjectMjsSubstitutions": 0
  },
  "nativeScope": {
    "kind": "native-systemd-scope-runner",
    "runner": "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/systemd-scope-env-runner.mjs",
    "runnerSha256": "ff1bcc1eba7c15b1d8494f36abd833511d3d3e88cd32cc64d0bb346efad25f99",
    "unit": "pc-dream-runner-4acaa-2085967.scope",
    "result": {
      "code": 23,
      "signal": null
    },
    "rows": [
      {
        "stage": "runner",
        "pid": 2086113,
        "root": "/tmp/dream-4acaa-spawning-generation-marker",
        "cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pc-dream-runner-4acaa-2085967.scope"
      },
      {
        "stage": "payload",
        "pid": 2086113,
        "root": "/tmp/dream-4acaa-payload-generation-marker",
        "keys": [
          "PAPERCUSP_INTEGRATION_ROOT"
        ],
        "cgroup": "0::/user.slice/user-1000.slice/user@1000.service/app.slice/pc-dream-runner-4acaa-2085967.scope"
      }
    ],
    "checks": {
      "exit23": true,
      "runnerRootA": true,
      "payloadRootB": true,
      "samePid": true,
      "sameCgroup": true,
      "ownedScope": true,
      "exactEnv": true
    },
    "stderr": "",
    "unparsed": null
  },
  "rootCause": {
    "hypothesis": "Resident inherited-output environment runner preserves the spawning integration-root reference independently of the correctly scoped audit payload.",
    "alternativeHypothesis": "The audit payload environment itself incorrectly names the spawning root.",
    "distinguishingTest": "Actual-process regression launches with spawning root A and exact payload env B; report payload PID/root and compare to launcher PID.",
    "predictedObservations": {
      "hypothesis": "Before repair payload root B is correct but PID differs; replacing runner preserves PID and root B.",
      "alternativeHypothesis": "Payload root would be A, regardless of runner lifetime."
    },
    "actualObservation": "Initial guard failed only PID equality while root B was correct. Exact repaired runner suite passed, including direct PID identity and SIGTERM cleanup."
  },
  "limitations": [
    "Existing long-lived audit processes and their pins remain untouched.",
    "Parent EI-26742095048555144 still owns aggregate generation retention/cleanup throughput and storage headroom.",
    "Native probe runs canonical source in an owned short-lived scope; it does not prove resident bg-host or green main deployment.",
    "Original Dream c6/SAME, human/science/native and final shipment gates remain open."
  ]
}
