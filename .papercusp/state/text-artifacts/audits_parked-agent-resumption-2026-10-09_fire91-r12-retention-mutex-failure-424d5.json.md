---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire91-r12-retention-mutex-failure-424d5.json"
updated_at: 1792131716471
_body: "content"
---

{
  "schemaVersion": "parked-fire91-r12-retention-failure-v1",
  "at": "2026-10-16T06:21:53.127Z",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "main": "WI-6554700010008887",
  "incident": {
    "ok": true,
    "created": true,
    "kind": "bug",
    "improvementKind": "bug",
    "issue": {
      "id": "EI-26115908945347053",
      "kind": "bug",
      "harness": null,
      "state": "open",
      "title": "Private R12 e2e proof timed out acquiring shared disk-retention mutex",
      "assignee": "su-424d5476-0b13-401a-a926-0aaa9f212391"
    },
    "topics": [
      "papercusp-improvement"
    ],
    "possibleDuplicates": [],
    "dedupCoverage": {
      "lexical": "ok",
      "semantic": "ok",
      "degraded": false
    },
    "admissionIdentity": {
      "schemaVersion": "admission-identity-v1",
      "titleKey": "title:acquiring disk e2e mutex out private proof r12 retention shared timed"
    }
  },
  "task": {
    "ok": true,
    "bash_id": "427fcae7-02d",
    "task_id": "0mvak8jvkhzw9ap1u4g",
    "status": "running",
    "exit_code": null,
    "running": true,
    "total_bytes": 828604,
    "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-427fcae7-02d.log",
    "cpu_cores": 1.29,
    "cpu_basis": "cores burned by this job's OWN cgroup over the 702s since your last bash_output read (1.0 = one core saturated). CPU use is NOT payload progress: wrapper/queue work can burn multiple cores before the payload starts, so neither a nonzero value nor growing wrapper output distinguishes working from pc-heavy:waiting-for-slot. ~0 while status=running also does NOT mean finished. Confirm progress from a payload-emitted phase/test marker, not this number.",
    "output": "    \u001b[90m845|\u001b[39m             `Timed out after ${timeoutMs}ms waiting for fs-mutex \"${na…\n    \u001b[90m846|\u001b[39m           )\u001b[33m;\u001b[39m\n\u001b[90m \u001b[2m❯\u001b[22m runHarness ../../libs/generic/verification-harness/src/runner.ts:\u001b[2m1124:27\u001b[22m\u001b[39m\n\u001b[90m \u001b[2m❯\u001b[22m recordIsolatedIntegrationProof test/isolated-integration-proof.ts:\u001b[2m472:18\u001b[22m\u001b[39m\n\u001b[90m \u001b[2m❯\u001b[22m verifyAlarm lib/system-health/liveness-alarm-current-build.e2e.test.ts:\u001b[2m17:17\u001b[22m\u001b[39m\n\n\u001b[31m\u001b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\u001b[22m\u001b[39m\n\nTEST_FILE_STARTUP_TRACE {\"pid\":3240516,\"event\":\"worker-disconnect\",\"childPid\":3241796,\"elapsedMs\":185061}\nTEST_FILE_STARTUP_TRACE {\"pid\":3240516,\"event\":\"worker-exit\",\"childPid\":3241796,\"elapsedMs\":185062,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":3240516,\"event\":\"worker-close\",\"childPid\":3241796,\"elapsedMs\":185062,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\" name=\"keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery\" message=\"Error: Timed out after 180000ms waiting for fs-mutex \\\"papercusp-disk-retention\\\" (/home/marsh-office/.papercusp/fs-mutex-locks/papercusp-disk-retention.lock); holder: {\\n  \\\"pid\\\": 365316,\\n  \\\"tgid\\\": 365316,\\n  \\\"startTicks\\\": \\\"91673048\\\",\\n  \\\"bootId\\\": \\\"b8c61f1d-f67c-43a8-ac9d-2286713e224f\\\",\\n  \\\"host\\\": \\\"main-server-Precision-7865-Tower\\\",\\n  \\\"startedAt\\\": \\\"2026-10-16T06:12:56.753Z\\\",\\n  \\\"name\\\": \\\"papercusp-disk-retention\\\",\\n  \\\"acquiredAt\\\": \\\"2026-10-16T06:12:56.795Z\\\",\\n  \\\"phase\\\": \\\"running\\\",\\n  \\\"runningAt\\\": \\\"2026-10-16T06:12:56.839Z\\\"\\n}\\n\\n    at withFsMutex (/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/scripts/lib/fs-mutex.mjs:844:17)\\n    at runHarness (/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/libs/generic/verification-harness/src/runner.ts:1124:27)\\n    at recordIsolatedIntegrationProof (/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/packages/operator-core/test/isolated-integration-proof.ts:472:18)\\n    at verifyAlarm (/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts:17:17)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20\"\n"
  },
  "originalReporter": {
    "path": "/tmp/parked-fire88-r12-current-reporter-424d5.jsonl",
    "sha256": "4dfa98f429122866c9be055ae61c133f87e0f0d9f903ae2ced52da0397764047",
    "exactBytes": "{\"receiptId\":\"3e9b32bc-078d-43ea-8c5a-49696cb4757b\",\"attempt\":0,\"filePath\":\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\",\"status\":\"fail\",\"row\":{\"filePath\":\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\",\"status\":\"fail\",\"durationMs\":180243,\"startedAt\":\"2026-10-16T06:14:58.812Z\",\"finishedAt\":\"2026-10-16T06:17:59.055Z\",\"outputTail\":\"keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery: Timed out after 180000ms waiting for fs-mutex \\\"papercusp-disk-retention\\\" (/home/marsh-office/.papercusp/fs-mutex-locks/papercusp-disk-retention.lock); holder: {\\n  \\\"pid\\\": 365316,\\n  \\\"tgid\\\": 365316,\\n  \\\"startTicks\\\": \\\"91673048\\\",\\n  \\\"bootId\\\": \\\"b8c61f1d-f67c-43a8-ac9d-2286713e224f\\\",\\n  \\\"host\\\": \\\"main-server-Precision-7865-Tower\\\",\\n  \\\"startedAt\\\": \\\"2026-10-16T06:12:56.753Z\\\",\\n  \\\"name\\\": \\\"papercusp-disk-retention\\\",\\n  \\\"acquiredAt\\\": \\\"2026-10-16T06:12:56.795Z\\\",\\n  \\\"phase\\\": \\\"running\\\",\\n  \\\"runningAt\\\": \\\"2026-10-16T06:12:56.839Z\\\"\\n}\\n\",\"isScratchConfig\":false,\"executionDetails\":{\"schemaVersion\":1,\"runStartedAt\":\"2026-10-16T06:14:53.942Z\",\"root\":\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source\",\"runGroupId\":null,\"workspaceId\":\"papercusp-workspace\",\"harnessSlug\":\"papercusp\",\"testNamePattern\":\"keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery\",\"testLayer\":\"e2e\",\"mutationPhase\":null,\"runtimeEnvironmentBeforeCaptureStatus\":\"not-configured\",\"filePath\":\"packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts\",\"passed\":0,\"failed\":1,\"skipped\":3,\"collectionFailed\":false,\"failedCaseTitles\":[\"keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery\"],\"worktreeDirty\":false,\"commitSha\":\"a48bba03ecda239044c6b0cbced8371fe2319415\",\"runtimeEnvironmentAfterCaptureStatus\":\"not-configured\"},\"verifierSourceReason\":null,\"cases\":[{\"caseIndex\":0,\"caseKey\":\"keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery\",\"occurrence\":1,\"status\":\"fail\",\"durationMs\":180238,\"errorTail\":\"Timed out after 180000ms waiting for fs-mutex \\\"papercusp-disk-retention\\\" (/home/marsh-office/.papercusp/fs-mutex-locks/papercusp-disk-retention.lock); holder: {\\n  \\\"pid\\\": 365316,\\n  \\\"tgid\\\": 365316,\\n  \\\"startTicks\\\": \\\"91673048\\\",\\n  \\\"bootId\\\": \\\"b8c61f1d-f67c-43a8-ac9d-2286713e224f\\\",\\n  \\\"host\\\": \\\"main-server-Precision-7865-Tower\\\",\\n  \\\"startedAt\\\": \\\"2026-10-16T06:12:56.753Z\\\",\\n  \\\"name\\\": \\\"papercusp-disk-retention\\\",\\n  \\\"acquiredAt\\\": \\\"2026-10-16T06:12:56.795Z\\\",\\n  \\\"phase\\\": \\\"running\\\",\\n  \\\"runningAt\\\": \\\"2026-10-16T06:12:56.839Z\\\"\\n}\\n\"},{\"caseIndex\":1,\"caseKey\":\"keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery\",\"occurrence\":1,\"status\":\"skip\",\"durationMs\":null,\"errorTail\":null},{\"caseIndex\":2,\"caseKey\":\"delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence\",\"occurrence\":1,\"status\":\"skip\",\"durationMs\":null,\"errorTail\":null},{\"caseIndex\":3,\"caseKey\":\"delivers one Papercusp-owned spend alarm and resolves a measured budget recovery\",\"occurrence\":1,\"status\":\"skip\",\"durationMs\":null,\"errorTail\":null}],\"worktreeDirty\":false,\"commitSha\":\"a48bba03ecda239044c6b0cbced8371fe2319415\",\"receiptId\":\"3e9b32bc-078d-43ea-8c5a-49696cb4757b\",\"receiptAttempt\":0},\"outcome\":\"inserted\",\"id\":\"21272651\"}\n"
  },
  "newAwait": {
    "ok": true,
    "await_id": 312088,
    "event": "task:terminal:0mvak8jvkhzw9ap1u4g",
    "expires_ts": "2026-10-16T06:31:51.678Z",
    "on_timeout": "wake",
    "wake_handle": "session #40770 (codex) — injectable/resumable",
    "operational_brief": {
      "schemaVersion": "operational-brief-v1",
      "surface": "await-wait",
      "subject": "task:terminal:0mvak8jvkhzw9ap1u4g",
      "state": {
        "status": "known",
        "value": "waiting",
        "source": "event_awaits"
      },
      "owner": {
        "status": "known",
        "value": "task-manager terminal bridge (packages/operator-core/lib/task-manager/task-terminal-events.ts)",
        "source": "events:catalog emitter"
      },
      "nextAction": {
        "status": "known",
        "value": "END YOUR TURN. You are re-invoked when task:terminal:0mvak8jvkhzw9ap1u4g fires, or with a timeout wake by 2026-10-16T06:31:51.678Z. On a timeout wake, check that task-manager terminal bridge (packages/operator-core/lib/task-manager/task-terminal-events.ts) is progressing before re-arming; a stalled emitter is your blocker to diagnose.",
        "source": "event_awaits"
      },
      "blockers": {
        "status": "known",
        "value": [
          "waiting for task:terminal:0mvak8jvkhzw9ap1u4g to fire"
        ],
        "source": "event_awaits"
      },
      "lastVerified": {
        "status": "known",
        "value": {
          "ref": "event_awaits#312088",
          "at": "2026-10-16T06:21:51.678Z",
          "summary": "one-shot wake await registered and pending"
        },
        "source": "event_awaits"
      },
      "deadline": {
        "status": "known",
        "value": "2026-10-16T06:31:51.678Z",
        "source": "event_awaits.expires_ts"
      },
      "facts": {
        "awaitId": 312088,
        "eventKey": "task:terminal:0mvak8jvkhzw9ap1u4g",
        "onTimeout": "wake",
        "wakeHandle": {
          "status": "known",
          "value": "adv-session",
          "source": "event_awaits"
        },
        "payloadFiltered": false,
        "announced": false,
        "retract": "events:cancel { await_id: 312088 }"
      },
      "unknowns": []
    },
    "advice": "Registered. End your turn now — you will be re-invoked when the event fires (or at the deadline). Do not poll."
  },
  "boundary": "Actual child failure at fs-mutex acquisition; upstream cause UNKNOWN. Wrapperterminal/retained3hashes/cleanup/current17hashes notyetverified. No expensive rerun, sourceedit, completedRuntime fabrication, binding or acceptance. Independent attestationaudit remains separate."
}
