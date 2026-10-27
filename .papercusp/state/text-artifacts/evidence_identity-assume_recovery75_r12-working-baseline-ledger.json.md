---
rel_path: "evidence/identity-assume/recovery75/r12-working-baseline-ledger.json"
updated_at: 1792983580949
_body: "content"
---

{
  "count": 1,
  "total": 1,
  "truncatedByLimit": false,
  "latestPerFile": false,
  "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
  "omittedBySourceFilter": 0,
  "runs": [
    {
      "id": 22101046,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/home/marsh-office/papercupai-workspace/papercusp",
      "executionDetails": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "commitSha": "3bea28d963eba2beb7654cc90911dafe6fc2cff4",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:56:54.204Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": "R-12 preview preserves caller and target runtime and durable snapshots",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots"
        ],
        "worktreeDirtyReason": "11 porcelain line(s) before the run: M apps/slack-asana-bug-drill |  M packages/operator-core/lib/agent-tools/activity/activity.integration.test.ts |  M packages/operator-core/lib/agent-tools/session/assume.integration.test.ts |  M packages/operator-core/lib/console-launcher.ts |  M packages/operator-core/lib/su-session-codex-adapter.integration.test.ts",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:57:38.199Z",
      "finishedAt": "2026-10-26T02:57:44.535Z",
      "durationMs": 6336,
      "commitSha": "3bea28d963eba2beb7654cc90911dafe6fc2cff4",
      "runGroupId": null,
      "source": "local",
      "branch": "staging",
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 735.7,
      "saturationSuspect": null,
      "worktreeDirty": true,
      "isScratchConfig": false,
      "cases": [
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retains durable startup provenance when verification advances the receipt",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-1 same managed attachment replaces caller execution",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-1 reject unrelated-window and env-only fake takeover",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-2 target inbox and task routing spans before during and after cutover",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-2 preserve target fleet subscriptions and historical authorship",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-5 caller return reference resumes exactly once and rejects stale replay",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed source-process",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed return-pin",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed finalize-binding",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed registration",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed new-loop",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps caller fenced when exact return has a changed process-start",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retains strict original-process rollback equality when a returning registration is live",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > fences only the caller generation, preserves sibling controls and rejects conflicting or stale unpause",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-5 caller wakes quiesce while target wakes remain live",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retains the fence after failed host acknowledgement or changed recovery custody",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > refuses rollback over a newer loop configuration",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retries exact loop restoration after a refused host thaw acknowledgement",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retries exact loop restoration after a lost host thaw acknowledgement",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > refuses a retry if an already restored loop changed before the thaw acknowledgement",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > restores nonempty caller work without cancelling its bound awaits or moving work to the target",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > keeps recovery paused instead of taking a peer plan claim",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > writes an immutable caller-only recovery snapshot and exact return reference",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > refuses changed caller custody before creating its recovery snapshot and rejects later tampering",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-5 nonempty caller work and return reference survive handoff failure",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-6 accepted requires later process and routed probe verification",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-6 timeout and host death remain recoverable indeterminate: timeout",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-6 timeout and host death remain recoverable indeterminate: host death",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-8 fault injection at every transition boundary preserves custody and recovery: caller-checkpointed",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-8 fault injection at every transition boundary preserves custody and recovery: caller-quiesced",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-8 fault injection at every transition boundary preserves custody and recovery: target-custody-acquired",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-8 fault injection at every transition boundary preserves custody and recovery: handoff-requested",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-8 crash after target custody before exec or verification converges on retry",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-9 unauthorized takeover refuses without disclosure or mutation",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-9 exact caller target incarnation context and expiry bind admission",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-9 commit rechecks administrative authority and reviewer restrictions",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 972,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-3 native resume preserves exact conversation and backend",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-3 unavailable corrupt stale and incompatible context refuses without fallback",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-4 stale target incarnation and writer generation refuses unchanged",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-4 same textual target in foreign workspace refuses",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-3 checkpoint selection pins revision hash and fresh context",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-10 tampered mismatched or non-target checkpoint refuses before custody",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-10 caller history credentials and unapproved environment do not cross context boundary",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-11 refused verified and rolled-back outcomes remain append-only: refused",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-11 refused verified and rolled-back outcomes remain append-only: target-verified",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > R-11 refused verified and rolled-back outcomes remain append-only: rolled-back",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > rolls back the mutable receipt when its append-only audit cannot commit",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume production receipt adapter (real PG) > retains an uncertain execution fence beyond ordinary launch cleanup and refuses corrupt stored receipts",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > R-8 preserves original native history across an authorized startup append and retains lease fences",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > rechecks the exact live reservation and native context before allowing handoff",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > refuses changed context and an expired or replaced reservation",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > does not renew custody or release another incarnation after target binding changes",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > checks lease ownership again when a slow native probe outlives its reservation",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > R-4 two callers race one target with one unchanged loser",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > refuses stale incarnation and foreign workspace without writing a lease",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseKey": "session:assume existing resume reservation (real PG) > refuses ended-to-live changes despite a stale or replayed claim",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        }
      ]
    }
  ],
  "_meta": {
    "explicitFullRequest": true,
    "format": "json",
    "_seeAlso": [
      {
        "tool": "testing:flakiness (is this red a known flake — cross-run flip rate)"
      },
      {
        "tool": "testing:run (actually run test files)"
      },
      {
        "tool": "dev:pipeline_position (is my change live / what is blocking it)"
      }
    ]
  }
}
