---
rel_path: "evidence/identity-assume/recovery75/pg-original-catch-and-survivor-ledger.json"
updated_at: 1792983154097
_body: "content"
---

{
  "count": 6,
  "total": 6,
  "truncatedByLimit": false,
  "latestPerFile": false,
  "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
  "omittedBySourceFilter": 0,
  "runs": [
    {
      "id": 22100191,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -155,7 +155,7 @@\n     version: 1, requestId: request.requestId, authorizationRef,\n     preparedAt: now, expiresAt: now + ASSUME_TOKEN_TTL_MS, caller: caller.data, target: target.data,\n   });\n-  return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n+  await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n }\n \n /** Re-resolve all pins and administrative authority before any caller mutation.\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-12 preview preserves caller and target runtime and durable snapshots'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s|return \\{ ok: true, state: 'prepared', token: seal\\(preparation, deps\\.secret\\), preparation \\};|await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };|",
          "probeInvocationId": "8fc7fff0-6e0b-4cdf-9e45-9f9844349187",
          "testCommandSha256": "6628e8146be7fddb0be4e070d00db37bec830e95e6e0f2fa94898f981313fc8e",
          "subjectAfterSha256": "38bffd3540170ebc7a7b419a555bc1908eff6417b00c7f8983c798542c37c89c",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:46:04.662Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-12 preview preserves caller and target runtime and durable snapshots",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:46:51.886Z",
      "finishedAt": "2026-10-26T02:46:56.528Z",
      "durationMs": 4642,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 618.1,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "durationMs": 850,
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
    },
    {
      "id": 22099685,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "copy-baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -155,7 +155,7 @@\n     version: 1, requestId: request.requestId, authorizationRef,\n     preparedAt: now, expiresAt: now + ASSUME_TOKEN_TTL_MS, caller: caller.data, target: target.data,\n   });\n-  return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n+  await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n }\n \n /** Re-resolve all pins and administrative authority before any caller mutation.\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-12 preview preserves caller and target runtime and durable snapshots'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s|return \\{ ok: true, state: 'prepared', token: seal\\(preparation, deps\\.secret\\), preparation \\};|await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };|",
          "probeInvocationId": "8fc7fff0-6e0b-4cdf-9e45-9f9844349187",
          "testCommandSha256": "6628e8146be7fddb0be4e070d00db37bec830e95e6e0f2fa94898f981313fc8e",
          "subjectAfterSha256": "38bffd3540170ebc7a7b419a555bc1908eff6417b00c7f8983c798542c37c89c",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:44:55.448Z",
        "mutationPhase": "copy-baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-12 preview preserves caller and target runtime and durable snapshots",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:45:35.481Z",
      "finishedAt": "2026-10-26T02:45:39.104Z",
      "durationMs": 3623,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 628.7,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "durationMs": 1086,
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
    },
    {
      "id": 22099178,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -155,7 +155,7 @@\n     version: 1, requestId: request.requestId, authorizationRef,\n     preparedAt: now, expiresAt: now + ASSUME_TOKEN_TTL_MS, caller: caller.data, target: target.data,\n   });\n-  return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n+  await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };\n }\n \n /** Re-resolve all pins and administrative authority before any caller mutation.\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-12 preview preserves caller and target runtime and durable snapshots'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s|return \\{ ok: true, state: 'prepared', token: seal\\(preparation, deps\\.secret\\), preparation \\};|await (await import('./session-assume-store')).createAssumeReceiptStore(preparation).claim({ transitionKey: assumeTransitionKey(preparation), preparationFingerprint: assumePreparationFingerprint(preparation), preparation, state: 'prepared', updatedAt: now, durable: true }); return { ok: true, state: 'prepared', token: seal(preparation, deps.secret), preparation };|",
          "probeInvocationId": "8fc7fff0-6e0b-4cdf-9e45-9f9844349187",
          "testCommandSha256": "6628e8146be7fddb0be4e070d00db37bec830e95e6e0f2fa94898f981313fc8e",
          "subjectAfterSha256": "38bffd3540170ebc7a7b419a555bc1908eff6417b00c7f8983c798542c37c89c",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:43:56.466Z",
        "mutationPhase": "baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-12 preview preserves caller and target runtime and durable snapshots",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-12 preview preserves caller and target runtime and durable snapshots"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:44:31.638Z",
      "finishedAt": "2026-10-26T02:44:35.557Z",
      "durationMs": 3919,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 388.3,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "durationMs": 881,
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
    },
    {
      "id": 22099171,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 1,
        "passed": 0,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume-store.ts\n+++ b/packages/operator-core/lib/session-assume-store.ts\n@@ -104,7 +104,7 @@\n         harness_slug: plan.target.harnessSlug, summary: `session:assume ${receipt.state}`,\n         // Identity, admission and context pins only. Checkpoint contents and\n         // credentials are deliberately absent from this append-only record.\n-        sessionAssume: next.sessionAssume,\n+        sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },\n       };\n       const { sql } = getOrgPg();\n       const log = new PgCoordLog({ getSql: () => sql, workspaceId, ensureSchema: async () => {} });\n",
          "subjectPath": "packages/operator-core/lib/session-assume-store.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-11 takeover audit retains caller target authorization and terminal provenance'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s/sessionAssume: next\\.sessionAssume,/sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },/",
          "probeInvocationId": "8a0cc428-3155-4745-8858-9825dd2f2b04",
          "testCommandSha256": "08b1e4149812569163b5878e660ef1bc0173bcad57a301ce5b1c42911ee3205d",
          "subjectAfterSha256": "4bdad5f093fdc08b25bf05ec37c74f9c1c238fc19cf7eb29f08d08d7299bd192",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "4372c7390c6ebc0b42d81277c8ae5194d98e453f0d784deac200b71b038e0627"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:42:50.779Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-11 takeover audit retains caller target authorization and terminal provenance",
        "collectionFailed": false,
        "failedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "fail",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:43:28.338Z",
      "finishedAt": "2026-10-26T02:43:31.179Z",
      "durationMs": 2841,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance: expected 'mutant-authority-lost' to be 'fixture:admin-envelope' // Object.is equality\nactual: mutant-authority-lost\nexpected: fixture:admin-envelope",
      "loopLagP95Ms": null,
      "rssMb": 607.3,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "status": "skip",
          "durationMs": null,
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
          "status": "fail",
          "durationMs": 201,
          "errorTail": "expected 'mutant-authority-lost' to be 'fixture:admin-envelope' // Object.is equality\nactual: mutant-authority-lost\nexpected: fixture:admin-envelope"
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
    },
    {
      "id": 22099167,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "copy-baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume-store.ts\n+++ b/packages/operator-core/lib/session-assume-store.ts\n@@ -104,7 +104,7 @@\n         harness_slug: plan.target.harnessSlug, summary: `session:assume ${receipt.state}`,\n         // Identity, admission and context pins only. Checkpoint contents and\n         // credentials are deliberately absent from this append-only record.\n-        sessionAssume: next.sessionAssume,\n+        sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },\n       };\n       const { sql } = getOrgPg();\n       const log = new PgCoordLog({ getSql: () => sql, workspaceId, ensureSchema: async () => {} });\n",
          "subjectPath": "packages/operator-core/lib/session-assume-store.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-11 takeover audit retains caller target authorization and terminal provenance'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s/sessionAssume: next\\.sessionAssume,/sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },/",
          "probeInvocationId": "8a0cc428-3155-4745-8858-9825dd2f2b04",
          "testCommandSha256": "08b1e4149812569163b5878e660ef1bc0173bcad57a301ce5b1c42911ee3205d",
          "subjectAfterSha256": "4bdad5f093fdc08b25bf05ec37c74f9c1c238fc19cf7eb29f08d08d7299bd192",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "4372c7390c6ebc0b42d81277c8ae5194d98e453f0d784deac200b71b038e0627"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:41:47.374Z",
        "mutationPhase": "copy-baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-11 takeover audit retains caller target authorization and terminal provenance",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:42:25.230Z",
      "finishedAt": "2026-10-26T02:42:27.336Z",
      "durationMs": 2106,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 398.8,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "status": "skip",
          "durationMs": null,
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
          "status": "pass",
          "durationMs": 203,
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
    },
    {
      "id": 22099134,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
        "failed": 0,
        "passed": 1,
        "skipped": 57,
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
        "mutation": {
          "leg": "baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume-store.ts\n+++ b/packages/operator-core/lib/session-assume-store.ts\n@@ -104,7 +104,7 @@\n         harness_slug: plan.target.harnessSlug, summary: `session:assume ${receipt.state}`,\n         // Identity, admission and context pins only. Checkpoint contents and\n         // credentials are deliberately absent from this append-only record.\n-        sessionAssume: next.sessionAssume,\n+        sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },\n       };\n       const { sql } = getOrgPg();\n       const log = new PgCoordLog({ getSql: () => sql, workspaceId, ensureSchema: async () => {} });\n",
          "subjectPath": "packages/operator-core/lib/session-assume-store.ts",
          "testCommand": "PROBE_SUBJECT={} node scripts/with-test-pg.mjs -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.integration.test.ts --testNamePattern 'R-11 takeover audit retains caller target authorization and terminal provenance'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "2fc5fa05ecfb0700a4039ec20ae4d8365e393e79cb97e387e2a3938dc278f299",
          "mutateExpression": "s/sessionAssume: next\\.sessionAssume,/sessionAssume: { ...(next.sessionAssume as AssumeTransitionReceipt), preparation: { ...plan, authorizationRef: 'mutant-authority-lost' } },/",
          "probeInvocationId": "8a0cc428-3155-4745-8858-9825dd2f2b04",
          "testCommandSha256": "08b1e4149812569163b5878e660ef1bc0173bcad57a301ce5b1c42911ee3205d",
          "subjectAfterSha256": "4bdad5f093fdc08b25bf05ec37c74f9c1c238fc19cf7eb29f08d08d7299bd192",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "4372c7390c6ebc0b42d81277c8ae5194d98e453f0d784deac200b71b038e0627"
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-26T02:40:37.878Z",
        "mutationPhase": "baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "R-11 takeover audit retains caller target authorization and terminal provenance",
        "collectionFailed": false,
        "passedCaseTitles": [
          "session:assume production receipt adapter (real PG) > R-11 takeover audit retains caller target authorization and terminal provenance"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "packages/operator-core/lib/agent-tools/session/assume.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-26T02:41:18.282Z",
      "finishedAt": "2026-10-26T02:41:23.318Z",
      "durationMs": 5036,
      "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
      "runGroupId": null,
      "source": "mutation-probe",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 654.4,
      "saturationSuspect": null,
      "worktreeDirty": false,
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
          "status": "skip",
          "durationMs": null,
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
          "status": "pass",
          "durationMs": 215,
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
