---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire41-two-dated-cutoff-release-rawrefs-20261014-424d5.json"
updated_at: 1792010172102
_body: "content"
---

{
  "schemaVersion": "parked-r13-fire41-two-dated-release-rawrefs-v1",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "cutoff": "2026-10-10T16:00:36.515Z",
  "requestedRefs": [
    "EI-25574253034038454#lifecycle:audit_log:1791649718564:force-released",
    "EI-25405882696245541#lifecycle:audit_log:1791649666499:force-released"
  ],
  "sourceRead": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "id": "EI-25574253034038454",
        "availability": "available",
        "workItem": {
          "id": "EI-25574253034038454",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "dev:pipeline_position tool-call failure (direct-wrapper-dropped-testClass)",
          "summary": "Suspected tool-call failure reported through the canonical improvements:capture toolFailure shorthand.\n\nTool: dev:pipeline_position\nError code: direct-wrapper-dropped-testClass\nStatus: success-with-incomplete-route\nMessage: Passed testClass:'operator-api' through the direct wrapper, but the returned input contained only path and sha and no currentBuildTestRoute. The live tools:find schema declares testClass; the wrapper call did not preserve it, so I must use tools:invoke for this argument. I will not re-read gate state from pipeline_position while another session owns the red gate.\nDirect evidence kind: server-contract-mismatch\nDirect evidence expected: dev:pipeline_position receives testClass:'operator-api' and returns currentBuildTestRoute.\nDirect evidence actual: Response input contains path and sha only; currentBuildTestRoute is absent.",
          "state": "done",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": null,
          "createdBy": "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078",
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "su",
              "severity": "major",
              "created_by": "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078",
              "found_during": "pre-release evidence route selection for EI-25516864794830903",
              "signal_origin": "organic"
            },
            "reporter": {
              "at": "2026-10-10T06:51:41.689Z",
              "id": "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078",
              "kind": "agent",
              "basis": "agent-session"
            },
            "filedByRole": "su",
            "repeatCount": 1,
            "watchdogKey": "tool-failure-signature:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:field-unknown",
            "_assumptions": {
              "declared": "none",
              "resolvedAt": "2026-10-11T16:14:37.242Z"
            },
            "dedupCoverage": {
              "lexical": "unavailable",
              "degraded": true,
              "semantic": "ok"
            },
            "ideaLifecycle": {
              "state": "triaged",
              "ideaType": "code-bug",
              "triagedAt": "2026-10-10T22:42:59.525Z",
              "triageReason": "code-bug, policy tier=auto (no protected path/keyword → AUTO-eligible (still gated by blueprint + tests + release-manager)) — auto-implement lane (D-003: one verdict chain)",
              "stateUpdatedAt": "2026-10-10T22:42:59.525Z",
              "triageDecision": "place"
            },
            "reportContext": {
              "app": "papercusp",
              "screen": null,
              "refused": [],
              "truncated": [],
              "appVersion": "0.0.0+e6e50c21f6",
              "capturedAt": "2026-10-10T06:51:41.689Z",
              "logExcerpt": null,
              "screenshot": null,
              "autoCaptured": [
                "app",
                "appVersion",
                "recentErrors"
              ],
              "recentErrors": [
                {
                  "at": "2026-10-10T06:51:41.689Z",
                  "source": "dev:pipeline_position",
                  "message": "dev:pipeline_position direct-wrapper-dropped-testClass: Passed testClass:'operator-api' through the direct wrapper, but the returned input contained only path and sha and no currentBuildTestRoute. The live tools:find schema declares testClass; the wrapper call did not preserve it, so I must use tools:invoke for this argument. I will not re-read gate state from pipeline_position while another session owns the red gate."
                }
              ],
              "schemaVersion": 1
            },
            "reporterKinds": [
              "agent"
            ],
            "admissionReview": {
              "alert": {
                "key": "work-item-admission-review-debt",
                "state": "cleared",
                "reason": "review moot: item already terminal",
                "emittedAt": "2026-10-11T12:15:03.456-04:00"
              },
              "state": "terminal",
              "enteredAt": "2026-10-10T04:15:12.034-04:00",
              "mootReason": "item was already done when its fail-open duplication review came due; a terminal item is never claimed again, so the review cannot change anything",
              "retryOwner": "system:work-item-admission-promoter",
              "reviewedAt": "2026-10-11T12:15:03.456-04:00",
              "reviewedBy": "system:work-item-admission-fail-open",
              "terminalAt": "2026-10-11T12:15:03.456-04:00",
              "lastRetryAt": "2026-10-11T03:38:35.672-04:00",
              "reviewDueAt": "2026-10-10T05:15:12.034-04:00",
              "retryAttempts": 1,
              "terminalOutcome": "review-moot"
            },
            "candidateExpiry": {
              "at": "2026-10-10T07:33:53.746Z",
              "owner": "system:stranded-tool-failure-sweep",
              "reason": "tool-unchanged-since-report",
              "outcome": "kept",
              "checkedBuild": "8520735b8d"
            },
            "dedupCandidates": [
              {
                "id": "EI-24794112773122126",
                "method": "semantic-soft",
                "similarity": 0.9
              },
              {
                "id": "EI-24360721150869286",
                "method": "semantic-hard",
                "similarity": 0.86
              },
              {
                "id": "EI-24774889084012248",
                "method": "lexical",
                "similarity": 0.6
              }
            ],
            "admissionFailOpen": {
              "at": "2026-10-10T04:15:12.034-04:00",
              "actor": "system:work-item-admission-fail-open",
              "runId": "sched-.routinesTick-2026-10-10T08:15:00.000Z-41",
              "scope": "workspace",
              "reason": "pending-age-exceeded-two-promoter-ticks"
            },
            "admissionIdentity": {
              "titleKey": "title:call dev direct dropped failure pipeline position testclass tool wrapper",
              "signalKey": "repeated-tool-error:dev:pipeline_position:structural:passed-testclass-operator-api-through-the",
              "schemaVersion": "admission-identity-v1"
            },
            "freshnessEnvelope": {
              "observedAt": "2026-10-10T06:51:47.924Z",
              "linkedFixRefs": [],
              "reporterSession": "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078",
              "observedSourceSha": "e6e50c21f6",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "e6e50c21f6",
              "deployBuildIdentity": "e6e50c21f6@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": "2026-10-10T06:51:47.924Z"
            },
            "_completionEvidence": {
              "summary": "Fixed route loss in oversized dev:pipeline_position results by preserving currentBuildTestRoute in the pipeline-specific result-door paths and extending the regression to compare that path with the generic control. Linked open-report disposition remains owned by the fleet leader through WI-6554700010008601.",
              "coverage": {
                "checked": [
                  "Saved matched operator-api call input and bounded response",
                  "Current pipeline handler route generation and result-door preserve path",
                  "Focused result-door regression and generic control"
                ],
                "residue": [
                  "WI-6554700010008601"
                ],
                "notChecked": [
                  "Live/current-build dev:pipeline_position invocation",
                  "Disposition of linked open reports"
                ],
                "population": [
                  "Saved matched operator-api call input and bounded response",
                  "Current pipeline handler route generation and result-door preserve path",
                  "Focused result-door regression and generic control",
                  "Live/current-build dev:pipeline_position invocation",
                  "Disposition of linked open reports"
                ],
                "notApplicable": []
              },
              "testsRun": "npm run test:file -- packages/operator-core/lib/result-door.test.ts — recorded 2026-10-11 15:54Z at source SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true",
              "treeStamp": {
                "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "contentIdentity": [
                  {
                    "path": "packages/operator-core/lib/result-door.ts",
                    "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                    "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
                  },
                  {
                    "path": "packages/operator-core/lib/result-door.test.ts",
                    "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                    "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
                  }
                ]
              },
              "testResult": "PASS: result-door.test.ts 123/123. The overflow fixture keeps currentBuildTestRoute on the pipeline-specific path; the generic control drops it.",
              "verifiedHow": "Read the saved matched call call_b394004c2d4046bcba3e259cd2f71a37, which supplied testClass=operator-api and returned a size-truncated result without currentBuildTestRoute. Read the current handler and result-door preserve paths, then checked the regression fixture and recorded focused run. The item checkpoint fingerprint was current and the final item read showed it still open and assigned to this session.",
              "filesChanged": [
                "packages/operator-core/lib/result-door.ts",
                "packages/operator-core/lib/result-door.test.ts"
              ],
              "settlementManifest": {
                "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
                "version": 1,
                "generation": 1,
                "evidenceHash": "65d1066e96a096b7c31e4b4e1a57e5e6f7b9c9e81a47ee938620ff8a877ef6f0",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "contentIdentity": [
                  {
                    "path": "packages/operator-core/lib/result-door.test.ts",
                    "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                    "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
                  },
                  {
                    "path": "packages/operator-core/lib/result-door.ts",
                    "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                    "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
                  }
                ],
                "normalizedPaths": [
                  "packages/operator-core/lib/result-door.test.ts",
                  "packages/operator-core/lib/result-door.ts"
                ]
              },
              "rootCauseVerification": {
                "hypothesis": "The generic result-door projection omitted currentBuildTestRoute from PIPELINE_POSITION_PRESERVE_PATHS, so size bounding dropped the route from an oversized dev:pipeline_position response.",
                "testResult": "The saved call included testClass=operator-api and its output was projection-truncated without currentBuildTestRoute. The handler computes the route. The focused fixture passed with the route preserved on the pipeline path and omitted by the generic control.",
                "evidenceRefs": [
                  "call_b394004c2d4046bcba3e259cd2f71a37 (EI-25574253034038454 source-call check)",
                  "packages/operator-core/lib/agent-tools/dev/pipeline_position.ts:872-879",
                  "packages/operator-core/lib/result-door.ts:868-870,3125",
                  "packages/operator-core/lib/result-door.test.ts:1265-1333",
                  "result-door.test.ts recorded run: 123/123 at SHA 4f991247708f12d9edc56af763f1f8fd94219773"
                ],
                "testProcedure": "Inspect saved call call_b394004c2d4046bcba3e259cd2f71a37; read pipeline_position.ts route generation and result-door.ts preserve paths; run the recorded result-door.test.ts regression with currentBuildTestRoute appended after the compact fields; compare pipeline-specific and generic outputs.",
                "contractVersion": 2,
                "actualObservation": "The saved call supplied testClass=operator-api and showed a truncated response missing currentBuildTestRoute. Current handler source generates the route; the regression passed 123/123, preserving it through the pipeline path while the generic control omitted it.",
                "distinguishingTest": "Compare the saved matched call and current handler source, then exercise the same oversized fixture through the pipeline-specific preserve path and the generic result-door control.",
                "alternativeHypothesis": "The direct wrapper dropped testClass before the handler, so currentBuildTestRoute was never computed and the result door had no route field to preserve.",
                "predictedObservations": {
                  "hypothesis": "The saved call is size-truncated; the route is generated before bounding; the pipeline-specific preserve path retains the late route while the same generic control drops it.",
                  "alternativeHypothesis": "The selector is absent before handler execution, no route is generated, and the preserve-path change cannot make a route appear in the oversized result."
                }
              },
              "checkpointChecksCarried": [
                {
                  "claim": "The late currentBuildTestRoute regression passes and executes result-door.ts.",
                  "recheck": "Only if either result-door file changes or EI-25574253034038454 reopens.",
                  "verified": "2026-10-11 15:54Z: result-door.test.ts passed 123/123; executed-source capture at SHA 4f991247708f12d9edc56af763f1f8fd94219773 included result-door.ts and result-door.test.ts; worktreeDirty=true. @2026-10-11T16:02:25.631Z"
                },
                {
                  "claim": "The saved matched operator-api pipeline call was bounded by the generic result door and omitted currentBuildTestRoute.",
                  "recheck": "Re-read the saved call record and current result-door preserve paths; do not make a live dev:pipeline_position or gate read.",
                  "verified": "Parsed call_b394004c2d4046bcba3e259cd2f71a37 from the saved Codex log. Input supplied testClass=operator-api. Output had _projection.truncated=t…[truncated]and no currentBuildTestRoute. Current handler attaches routeHint; current PIPELINE_POSITION_PRESERVE_PATHS omitted the route. @2026-10-11T15:40Z"
                },
                {
                  "claim": "Source includes currentBuildTestRoute through the handler and both bounded shapers; the generic pipeline result-door preserve list omits it. This is a source-level lead, not a proven runtime cause.",
                  "recheck": "Re-read pipeline_position.ts compact shapers and result-door.ts PIPELINE_POSITION_PRESERVE_PATHS; confirm with a permitted matched output before claiming root cause.",
                  "verified": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts (handler, compactPipelineResult, minimalPipelineResult, handler test) and packages/operator-core/lib/result-door.ts (PIPELINE_POSITION_PRESERVE_PATHS/projectBoundedPayload call). No live pipeline call or test was run. @2026-10-11T15:11:05.050Z"
                },
                {
                  "claim": "Two related reports are open/unassigned; the third is resolved with a retraction. Their disposition has an active fleet-leader item.",
                  "recheck": "Re-read linked statuses/comments and WI-6554700010008601 if any report changes before its disposition completes.",
                  "verified": "get @16:08Z: EI-24774889084012248 open/unassigned (retracted 2026-10-01); EI-25688976195321944 open/unassigned; EI-25665326493623170 resolved (retracted 2026-10-11); WI-6554700010008601 open assigned su-055e916b-4218-4d93-9e0d-4a2c57fe9026. @2026-10-11T16:12:21.154Z"
                },
                {
                  "claim": "EI-25574253034038454 now has relates edges to EI-24774889084012248, EI-25688976195321944, and EI-25665326493623170.",
                  "recheck": "work_items:links {id:'EI-25574253034038454',direction:'out'}",
                  "verified": "work_items:link returned ok for all three relates edges. @2026-10-11T14:53Z"
                },
                {
                  "claim": "Current source accepts testClass, attaches currentBuildTestRoute, and preserves extras through both bounded pipeline shapers; tools:invoke returns the dispatched result.",
                  "recheck": "Re-read pipeline_position.ts and tools/invoke.ts at current HEAD; this does not verify the deployed runtime.",
                  "observed": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts and packages/operator-core/lib/agent-tools/tools/invoke.ts; no tests or live pipeline call run. @2026-10-11T14:57:37.381Z"
                },
                {
                  "claim": "The captured direct-wrapper call supplied testClass='operator-api'; the returned payload omitted currentBuildTestRoute and had no pipeline-specific projection object.",
                  "recheck": "Read session 01a12482-6bcc-7492-860d-2da4335147a0 call_id call_b394004c2d4046bcba3e259cd2f71a37 in its Codex JSONL under /home/marsh-office/.papercusp/su-codex-homes/session-39417/sessions/2026/10/10/.",
                  "verified": "Parsed the exact call input and correlated output; response application keys include input, targetSha, positions, assessments, gate and serving, but neither currentBuildTestRoute nor pipeline-specific projection. @2026-10-11T14:40:16.535Z"
                },
                {
                  "claim": "The source at the reported deployed SHA accepts testClass and computes currentBuildTestRoute in the handler.",
                  "recheck": "git show d740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/agent-tools/dev/pipeline_position.ts",
                  "verified": "The schema has optional testClass; handler calls currentBuildTestRoute(args.testClass) and includes routeHint in each return branch. @2026-10-11T14:40:16.535Z"
                }
              ],
              "checkpointProseSnapshot": "## Did\n[turn:self]\nCurrent local result-door.ts contains currentBuildTestRoute in PIPELINE_POSITION_PRESERVE_PATHS. The overflow fixture places the route after compact fields, matching handler-extra order.\n[turn:self]\nFocused result-door.test.ts run passed 123/123. Captured source map: recorded SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true; executed modules include result-door.ts and result-door.test.ts.\n[turn:self]\nFleet leader received the quarantine evidence. WI-6554700010008601 is open and assigned to the leader for disposition of the two linked route-omission reports.\n\n## Left\nEI-25574253034038454 remains open pending its completion record with rootCauseVerification. EI-25526144897971741 remains open/assigned. The inbox await remains active. Latest git-sync read shows result-door.test.ts quarantined through peer-held code/run.ts; the active local-sync fire was progressing and safe_to_restart=false. The loop checkpoint narrative saved, but its new check rows were refused to avoid evicting carried rows.\n\n## Key insight\nThe first test failure came from an invalid falsifiability fixture: the route appeared before padding and the generic projector retained it. With the route in the late handler-extra position, the generic control drops it and the pipeline-specific preserve policy keeps it.\n\n## Next action\nTerminal completion of EI-25574253034038454 is the next action, using the saved call, current source, captured local test result, and rootCauseVerification. The scheduler item remains held; another pull is eligible only after a claim slot frees or fresh invocation evidence arrives."
            },
            "toolFailureProbation": {
              "class": "structural",
              "state": "promoted",
              "report": {
                "status": "success-with-incomplete-route",
                "message": "Passed testClass:'operator-api' through the direct wrapper, but the returned input contained only path and sha and no currentBuildTestRoute. The live tools:find schema declares testClass; the wrapper call did not preserve it, so I must use tools:invoke for this argument. I will not re-read gate state from pipeline_position while another session owns the red gate.",
                "toolName": "dev:pipeline_position",
                "errorCode": "direct-wrapper-dropped-testClass",
                "directEvidence": {
                  "kind": "server-contract-mismatch",
                  "actual": "Response input contains path and sha only; currentBuildTestRoute is absent.",
                  "expected": "dev:pipeline_position receives testClass:'operator-api' and returns currentBuildTestRoute."
                }
              },
              "classKey": "repeated-tool-error-class:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:schema-unknown~field-unknown:runtime-unknown",
              "reporters": [
                "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078"
              ],
              "lastSeenAt": "2026-10-10T06:51:41.689Z",
              "firstSeenAt": "2026-10-10T06:51:41.689Z",
              "watchdogKey": "tool-failure-signature:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:field-unknown",
              "intendedKind": "bug",
              "signatureKey": "tool-failure-signature:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:field-unknown",
              "directEvidence": true,
              "deployedRevision": "runtime-unknown",
              "messageFingerprint": "passed-testclass-operator-api-through-the",
              "contractFingerprint": "schema-unknown~field-unknown",
              "correlationFingerprint": "dev:pipeline_position|direct-wrapper-dropped-testclass|schema-unknown|field-unknown|runtime-unknown|passed-testclass-operator-api-through-the"
            },
            "toolFailureSignature": {
              "classes": {
                "repeated-tool-error-class:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:schema-unknown~field-unknown:runtime-unknown": {
                  "count": 1,
                  "reporters": [
                    "su-c4dc38e8-5f3c-48fc-a4ad-3efd0ad46078"
                  ],
                  "lastSeenAt": "2026-10-10T06:51:41.689Z",
                  "firstSeenAt": "2026-10-10T06:51:41.689Z",
                  "deployedRevision": "runtime-unknown",
                  "contractFingerprint": "schema-unknown~field-unknown"
                }
              },
              "signatureKey": "tool-failure-signature:dev:pipeline_position:structural:direct-wrapper-dropped-testclass:field-unknown"
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-10-10T06:51:47.924Z",
              "schemaVersion": "implementation-readiness-v1"
            },
            "deploymentStalenessScreen": {
              "at": "2026-10-10T22:42:59.525Z",
              "state": "current",
              "divert": false,
              "relPath": "packages/operator-core/lib/agent-tools/dev/pipeline_position.ts",
              "treeRef": "staging",
              "screened": true,
              "toolName": "dev:pipeline_position",
              "deployedSha": "cbeffe4f01"
            }
          },
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": {
            "summary": "Fixed route loss in oversized dev:pipeline_position results by preserving currentBuildTestRoute in the pipeline-specific result-door paths and extending the regression to compare that path with the generic control. Linked open-report disposition remains owned by the fleet leader through WI-6554700010008601.",
            "coverage": {
              "checked": [
                "Saved matched operator-api call input and bounded response",
                "Current pipeline handler route generation and result-door preserve path",
                "Focused result-door regression and generic control"
              ],
              "residue": [
                "WI-6554700010008601"
              ],
              "notChecked": [
                "Live/current-build dev:pipeline_position invocation",
                "Disposition of linked open reports"
              ],
              "population": [
                "Saved matched operator-api call input and bounded response",
                "Current pipeline handler route generation and result-door preserve path",
                "Focused result-door regression and generic control",
                "Live/current-build dev:pipeline_position invocation",
                "Disposition of linked open reports"
              ],
              "notApplicable": []
            },
            "testsRun": "npm run test:file -- packages/operator-core/lib/result-door.test.ts — recorded 2026-10-11 15:54Z at source SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true",
            "treeStamp": {
              "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/result-door.ts",
                  "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                  "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
                },
                {
                  "path": "packages/operator-core/lib/result-door.test.ts",
                  "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                  "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
                }
              ]
            },
            "testResult": "PASS: result-door.test.ts 123/123. The overflow fixture keeps currentBuildTestRoute on the pipeline-specific path; the generic control drops it.",
            "verifiedHow": "Read the saved matched call call_b394004c2d4046bcba3e259cd2f71a37, which supplied testClass=operator-api and returned a size-truncated result without currentBuildTestRoute. Read the current handler and result-door preserve paths, then checked the regression fixture and recorded focused run. The item checkpoint fingerprint was current and the final item read showed it still open and assigned to this session.",
            "filesChanged": [
              "packages/operator-core/lib/result-door.ts",
              "packages/operator-core/lib/result-door.test.ts"
            ],
            "settlementManifest": {
              "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
              "version": 1,
              "generation": 1,
              "evidenceHash": "65d1066e96a096b7c31e4b4e1a57e5e6f7b9c9e81a47ee938620ff8a877ef6f0",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "packages/operator-core/lib/result-door.test.ts",
                  "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                  "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
                },
                {
                  "path": "packages/operator-core/lib/result-door.ts",
                  "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                  "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
                }
              ],
              "normalizedPaths": [
                "packages/operator-core/lib/result-door.test.ts",
                "packages/operator-core/lib/result-door.ts"
              ]
            },
            "rootCauseVerification": {
              "hypothesis": "The generic result-door projection omitted currentBuildTestRoute from PIPELINE_POSITION_PRESERVE_PATHS, so size bounding dropped the route from an oversized dev:pipeline_position response.",
              "testResult": "The saved call included testClass=operator-api and its output was projection-truncated without currentBuildTestRoute. The handler computes the route. The focused fixture passed with the route preserved on the pipeline path and omitted by the generic control.",
              "evidenceRefs": [
                "call_b394004c2d4046bcba3e259cd2f71a37 (EI-25574253034038454 source-call check)",
                "packages/operator-core/lib/agent-tools/dev/pipeline_position.ts:872-879",
                "packages/operator-core/lib/result-door.ts:868-870,3125",
                "packages/operator-core/lib/result-door.test.ts:1265-1333",
                "result-door.test.ts recorded run: 123/123 at SHA 4f991247708f12d9edc56af763f1f8fd94219773"
              ],
              "testProcedure": "Inspect saved call call_b394004c2d4046bcba3e259cd2f71a37; read pipeline_position.ts route generation and result-door.ts preserve paths; run the recorded result-door.test.ts regression with currentBuildTestRoute appended after the compact fields; compare pipeline-specific and generic outputs.",
              "contractVersion": 2,
              "actualObservation": "The saved call supplied testClass=operator-api and showed a truncated response missing currentBuildTestRoute. Current handler source generates the route; the regression passed 123/123, preserving it through the pipeline path while the generic control omitted it.",
              "distinguishingTest": "Compare the saved matched call and current handler source, then exercise the same oversized fixture through the pipeline-specific preserve path and the generic result-door control.",
              "alternativeHypothesis": "The direct wrapper dropped testClass before the handler, so currentBuildTestRoute was never computed and the result door had no route field to preserve.",
              "predictedObservations": {
                "hypothesis": "The saved call is size-truncated; the route is generated before bounding; the pipeline-specific preserve path retains the late route while the same generic control drops it.",
                "alternativeHypothesis": "The selector is absent before handler execution, no route is generated, and the preserve-path change cannot make a route appear in the oversized result."
              }
            },
            "checkpointChecksCarried": [
              {
                "claim": "The late currentBuildTestRoute regression passes and executes result-door.ts.",
                "recheck": "Only if either result-door file changes or EI-25574253034038454 reopens.",
                "verified": "2026-10-11 15:54Z: result-door.test.ts passed 123/123; executed-source capture at SHA 4f991247708f12d9edc56af763f1f8fd94219773 included result-door.ts and result-door.test.ts; worktreeDirty=true. @2026-10-11T16:02:25.631Z"
              },
              {
                "claim": "The saved matched operator-api pipeline call was bounded by the generic result door and omitted currentBuildTestRoute.",
                "recheck": "Re-read the saved call record and current result-door preserve paths; do not make a live dev:pipeline_position or gate read.",
                "verified": "Parsed call_b394004c2d4046bcba3e259cd2f71a37 from the saved Codex log. Input supplied testClass=operator-api. Output had _projection.truncated=t…[truncated]and no currentBuildTestRoute. Current handler attaches routeHint; current PIPELINE_POSITION_PRESERVE_PATHS omitted the route. @2026-10-11T15:40Z"
              },
              {
                "claim": "Source includes currentBuildTestRoute through the handler and both bounded shapers; the generic pipeline result-door preserve list omits it. This is a source-level lead, not a proven runtime cause.",
                "recheck": "Re-read pipeline_position.ts compact shapers and result-door.ts PIPELINE_POSITION_PRESERVE_PATHS; confirm with a permitted matched output before claiming root cause.",
                "verified": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts (handler, compactPipelineResult, minimalPipelineResult, handler test) and packages/operator-core/lib/result-door.ts (PIPELINE_POSITION_PRESERVE_PATHS/projectBoundedPayload call). No live pipeline call or test was run. @2026-10-11T15:11:05.050Z"
              },
              {
                "claim": "Two related reports are open/unassigned; the third is resolved with a retraction. Their disposition has an active fleet-leader item.",
                "recheck": "Re-read linked statuses/comments and WI-6554700010008601 if any report changes before its disposition completes.",
                "verified": "get @16:08Z: EI-24774889084012248 open/unassigned (retracted 2026-10-01); EI-25688976195321944 open/unassigned; EI-25665326493623170 resolved (retracted 2026-10-11); WI-6554700010008601 open assigned su-055e916b-4218-4d93-9e0d-4a2c57fe9026. @2026-10-11T16:12:21.154Z"
              },
              {
                "claim": "EI-25574253034038454 now has relates edges to EI-24774889084012248, EI-25688976195321944, and EI-25665326493623170.",
                "recheck": "work_items:links {id:'EI-25574253034038454',direction:'out'}",
                "verified": "work_items:link returned ok for all three relates edges. @2026-10-11T14:53Z"
              },
              {
                "claim": "Current source accepts testClass, attaches currentBuildTestRoute, and preserves extras through both bounded pipeline shapers; tools:invoke returns the dispatched result.",
                "recheck": "Re-read pipeline_position.ts and tools/invoke.ts at current HEAD; this does not verify the deployed runtime.",
                "observed": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts and packages/operator-core/lib/agent-tools/tools/invoke.ts; no tests or live pipeline call run. @2026-10-11T14:57:37.381Z"
              },
              {
                "claim": "The captured direct-wrapper call supplied testClass='operator-api'; the returned payload omitted currentBuildTestRoute and had no pipeline-specific projection object.",
                "recheck": "Read session 01a12482-6bcc-7492-860d-2da4335147a0 call_id call_b394004c2d4046bcba3e259cd2f71a37 in its Codex JSONL under /home/marsh-office/.papercusp/su-codex-homes/session-39417/sessions/2026/10/10/.",
                "verified": "Parsed the exact call input and correlated output; response application keys include input, targetSha, positions, assessments, gate and serving, but neither currentBuildTestRoute nor pipeline-specific projection. @2026-10-11T14:40:16.535Z"
              },
              {
                "claim": "The source at the reported deployed SHA accepts testClass and computes currentBuildTestRoute in the handler.",
                "recheck": "git show d740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/agent-tools/dev/pipeline_position.ts",
                "verified": "The schema has optional testClass; handler calls currentBuildTestRoute(args.testClass) and includes routeHint in each return branch. @2026-10-11T14:40:16.535Z"
              }
            ],
            "checkpointProseSnapshot": "## Did\n[turn:self]\nCurrent local result-door.ts contains currentBuildTestRoute in PIPELINE_POSITION_PRESERVE_PATHS. The overflow fixture places the route after compact fields, matching handler-extra order.\n[turn:self]\nFocused result-door.test.ts run passed 123/123. Captured source map: recorded SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true; executed modules include result-door.ts and result-door.test.ts.\n[turn:self]\nFleet leader received the quarantine evidence. WI-6554700010008601 is open and assigned to the leader for disposition of the two linked route-omission reports.\n\n## Left\nEI-25574253034038454 remains open pending its completion record with rootCauseVerification. EI-25526144897971741 remains open/assigned. The inbox await remains active. Latest git-sync read shows result-door.test.ts quarantined through peer-held code/run.ts; the active local-sync fire was progressing and safe_to_restart=false. The loop checkpoint narrative saved, but its new check rows were refused to avoid evicting carried rows.\n\n## Key insight\nThe first test failure came from an invalid falsifiability fixture: the route appeared before padding and the generic projector retained it. With the route in the late handler-extra position, the generic control drops it and the pipeline-specific preserve policy keeps it.\n\n## Next action\nTerminal completion of EI-25574253034038454 is the next action, using the saved call, current source, captured local test result, and rootCauseVerification. The scheduler item remains held; another pull is eligible only after a claim slot frees or fresh invocation evidence arrives."
          },
          "completionAuthority": "committed",
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-10T06:51:47.924Z",
          "updatedAt": "2026-10-13T14:39:26.287Z",
          "closedAt": "2026-10-11T16:14:37.250Z"
        },
        "checkpoint": null,
        "checkpointChecks": {
          "count": 0,
          "cap": 12,
          "remaining": 12
        },
        "checkpointBody": {
          "chars": 0,
          "cap": 32000,
          "remaining": 32000
        },
        "checkpointAgeMs": null,
        "checkpointUpdatedAtMs": null,
        "checkpointContentHash": null,
        "checkpointSubjectFingerprint": {
          "status": "mismatch",
          "current": {
            "version": 1,
            "sha256": "ec3d2fa31a08d25650ca9513f396e6ecfb691bd8b5a6b41c9982dc315c27890f"
          },
          "stored": {
            "version": 1,
            "sha256": "4f59d68e3fc57977e388593efb1a0ee128c57efd7351228dc510adf6b180a1da"
          }
        },
        "completion": {
          "summary": "Fixed route loss in oversized dev:pipeline_position results by preserving currentBuildTestRoute in the pipeline-specific result-door paths and extending the regression to compare that path with the generic control. Linked open-report disposition remains owned by the fleet leader through WI-6554700010008601.",
          "coverage": {
            "checked": [
              "Saved matched operator-api call input and bounded response",
              "Current pipeline handler route generation and result-door preserve path",
              "Focused result-door regression and generic control"
            ],
            "residue": [
              "WI-6554700010008601"
            ],
            "notChecked": [
              "Live/current-build dev:pipeline_position invocation",
              "Disposition of linked open reports"
            ],
            "population": [
              "Saved matched operator-api call input and bounded response",
              "Current pipeline handler route generation and result-door preserve path",
              "Focused result-door regression and generic control",
              "Live/current-build dev:pipeline_position invocation",
              "Disposition of linked open reports"
            ],
            "notApplicable": []
          },
          "testsRun": "npm run test:file -- packages/operator-core/lib/result-door.test.ts — recorded 2026-10-11 15:54Z at source SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true",
          "treeStamp": {
            "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "contentIdentity": [
              {
                "path": "packages/operator-core/lib/result-door.ts",
                "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
              },
              {
                "path": "packages/operator-core/lib/result-door.test.ts",
                "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
              }
            ]
          },
          "testResult": "PASS: result-door.test.ts 123/123. The overflow fixture keeps currentBuildTestRoute on the pipeline-specific path; the generic control drops it.",
          "verifiedHow": "Read the saved matched call call_b394004c2d4046bcba3e259cd2f71a37, which supplied testClass=operator-api and returned a size-truncated result without currentBuildTestRoute. Read the current handler and result-door preserve paths, then checked the regression fixture and recorded focused run. The item checkpoint fingerprint was current and the final item read showed it still open and assigned to this session.",
          "filesChanged": [
            "packages/operator-core/lib/result-door.ts",
            "packages/operator-core/lib/result-door.test.ts"
          ],
          "settlementManifest": {
            "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
            "version": 1,
            "generation": 1,
            "evidenceHash": "65d1066e96a096b7c31e4b4e1a57e5e6f7b9c9e81a47ee938620ff8a877ef6f0",
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "contentIdentity": [
              {
                "path": "packages/operator-core/lib/result-door.test.ts",
                "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
              },
              {
                "path": "packages/operator-core/lib/result-door.ts",
                "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
              }
            ],
            "normalizedPaths": [
              "packages/operator-core/lib/result-door.test.ts",
              "packages/operator-core/lib/result-door.ts"
            ]
          },
          "rootCauseVerification": {
            "hypothesis": "The generic result-door projection omitted currentBuildTestRoute from PIPELINE_POSITION_PRESERVE_PATHS, so size bounding dropped the route from an oversized dev:pipeline_position response.",
            "testResult": "The saved call included testClass=operator-api and its output was projection-truncated without currentBuildTestRoute. The handler computes the route. The focused fixture passed with the route preserved on the pipeline path and omitted by the generic control.",
            "evidenceRefs": [
              "call_b394004c2d4046bcba3e259cd2f71a37 (EI-25574253034038454 source-call check)",
              "packages/operator-core/lib/agent-tools/dev/pipeline_position.ts:872-879",
              "packages/operator-core/lib/result-door.ts:868-870,3125",
              "packages/operator-core/lib/result-door.test.ts:1265-1333",
              "result-door.test.ts recorded run: 123/123 at SHA 4f991247708f12d9edc56af763f1f8fd94219773"
            ],
            "testProcedure": "Inspect saved call call_b394004c2d4046bcba3e259cd2f71a37; read pipeline_position.ts route generation and result-door.ts preserve paths; run the recorded result-door.test.ts regression with currentBuildTestRoute appended after the compact fields; compare pipeline-specific and generic outputs.",
            "contractVersion": 2,
            "actualObservation": "The saved call supplied testClass=operator-api and showed a truncated response missing currentBuildTestRoute. Current handler source generates the route; the regression passed 123/123, preserving it through the pipeline path while the generic control omitted it.",
            "distinguishingTest": "Compare the saved matched call and current handler source, then exercise the same oversized fixture through the pipeline-specific preserve path and the generic result-door control.",
            "alternativeHypothesis": "The direct wrapper dropped testClass before the handler, so currentBuildTestRoute was never computed and the result door had no route field to preserve.",
            "predictedObservations": {
              "hypothesis": "The saved call is size-truncated; the route is generated before bounding; the pipeline-specific preserve path retains the late route while the same generic control drops it.",
              "alternativeHypothesis": "The selector is absent before handler execution, no route is generated, and the preserve-path change cannot make a route appear in the oversized result."
            }
          },
          "checkpointChecksCarried": [
            {
              "claim": "The late currentBuildTestRoute regression passes and executes result-door.ts.",
              "recheck": "Only if either result-door file changes or EI-25574253034038454 reopens.",
              "verified": "2026-10-11 15:54Z: result-door.test.ts passed 123/123; executed-source capture at SHA 4f991247708f12d9edc56af763f1f8fd94219773 included result-door.ts and result-door.test.ts; worktreeDirty=true. @2026-10-11T16:02:25.631Z"
            },
            {
              "claim": "The saved matched operator-api pipeline call was bounded by the generic result door and omitted currentBuildTestRoute.",
              "recheck": "Re-read the saved call record and current result-door preserve paths; do not make a live dev:pipeline_position or gate read.",
              "verified": "Parsed call_b394004c2d4046bcba3e259cd2f71a37 from the saved Codex log. Input supplied testClass=operator-api. Output had _projection.truncated=t…[truncated]and no currentBuildTestRoute. Current handler attaches routeHint; current PIPELINE_POSITION_PRESERVE_PATHS omitted the route. @2026-10-11T15:40Z"
            },
            {
              "claim": "Source includes currentBuildTestRoute through the handler and both bounded shapers; the generic pipeline result-door preserve list omits it. This is a source-level lead, not a proven runtime cause.",
              "recheck": "Re-read pipeline_position.ts compact shapers and result-door.ts PIPELINE_POSITION_PRESERVE_PATHS; confirm with a permitted matched output before claiming root cause.",
              "verified": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts (handler, compactPipelineResult, minimalPipelineResult, handler test) and packages/operator-core/lib/result-door.ts (PIPELINE_POSITION_PRESERVE_PATHS/projectBoundedPayload call). No live pipeline call or test was run. @2026-10-11T15:11:05.050Z"
            },
            {
              "claim": "Two related reports are open/unassigned; the third is resolved with a retraction. Their disposition has an active fleet-leader item.",
              "recheck": "Re-read linked statuses/comments and WI-6554700010008601 if any report changes before its disposition completes.",
              "verified": "get @16:08Z: EI-24774889084012248 open/unassigned (retracted 2026-10-01); EI-25688976195321944 open/unassigned; EI-25665326493623170 resolved (retracted 2026-10-11); WI-6554700010008601 open assigned su-055e916b-4218-4d93-9e0d-4a2c57fe9026. @2026-10-11T16:12:21.154Z"
            },
            {
              "claim": "EI-25574253034038454 now has relates edges to EI-24774889084012248, EI-25688976195321944, and EI-25665326493623170.",
              "recheck": "work_items:links {id:'EI-25574253034038454',direction:'out'}",
              "verified": "work_items:link returned ok for all three relates edges. @2026-10-11T14:53Z"
            },
            {
              "claim": "Current source accepts testClass, attaches currentBuildTestRoute, and preserves extras through both bounded pipeline shapers; tools:invoke returns the dispatched result.",
              "recheck": "Re-read pipeline_position.ts and tools/invoke.ts at current HEAD; this does not verify the deployed runtime.",
              "observed": "Read packages/operator-core/lib/agent-tools/dev/pipeline_position.ts and packages/operator-core/lib/agent-tools/tools/invoke.ts; no tests or live pipeline call run. @2026-10-11T14:57:37.381Z"
            },
            {
              "claim": "The captured direct-wrapper call supplied testClass='operator-api'; the returned payload omitted currentBuildTestRoute and had no pipeline-specific projection object.",
              "recheck": "Read session 01a12482-6bcc-7492-860d-2da4335147a0 call_id call_b394004c2d4046bcba3e259cd2f71a37 in its Codex JSONL under /home/marsh-office/.papercusp/su-codex-homes/session-39417/sessions/2026/10/10/.",
              "verified": "Parsed the exact call input and correlated output; response application keys include input, targetSha, positions, assessments, gate and serving, but neither currentBuildTestRoute nor pipeline-specific projection. @2026-10-11T14:40:16.535Z"
            },
            {
              "claim": "The source at the reported deployed SHA accepts testClass and computes currentBuildTestRoute in the handler.",
              "recheck": "git show d740fc3802877d1c8c3b1068768681ee32ef0025:packages/operator-core/lib/agent-tools/dev/pipeline_position.ts",
              "verified": "The schema has optional testClass; handler calls currentBuildTestRoute(args.testClass) and includes routeHint in each return branch. @2026-10-11T14:40:16.535Z"
            }
          ],
          "checkpointProseSnapshot": "## Did\n[turn:self]\nCurrent local result-door.ts contains currentBuildTestRoute in PIPELINE_POSITION_PRESERVE_PATHS. The overflow fixture places the route after compact fields, matching handler-extra order.\n[turn:self]\nFocused result-door.test.ts run passed 123/123. Captured source map: recorded SHA 4f991247708f12d9edc56af763f1f8fd94219773; worktreeDirty=true; executed modules include result-door.ts and result-door.test.ts.\n[turn:self]\nFleet leader received the quarantine evidence. WI-6554700010008601 is open and assigned to the leader for disposition of the two linked route-omission reports.\n\n## Left\nEI-25574253034038454 remains open pending its completion record with rootCauseVerification. EI-25526144897971741 remains open/assigned. The inbox await remains active. Latest git-sync read shows result-door.test.ts quarantined through peer-held code/run.ts; the active local-sync fire was progressing and safe_to_restart=false. The loop checkpoint narrative saved, but its new check rows were refused to avoid evicting carried rows.\n\n## Key insight\nThe first test failure came from an invalid falsifiability fixture: the route appeared before padding and the generic projector retained it. With the route in the late handler-extra position, the generic control drops it and the pipeline-specific preserve policy keeps it.\n\n## Next action\nTerminal completion of EI-25574253034038454 is the next action, using the saved call, current source, captured local test result, and rootCauseVerification. The scheduler item remains held; another pull is eligible only after a claim slot frees or fresh invocation evidence arrives."
        },
        "hasCompletionEvidence": true,
        "completionFreshness": {
          "verdict": "stale",
          "storedTreeStamp": {
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "headSha": "c9a2ecca438781185a40b89374cc93dae30e4516",
            "contentIdentity": [
              {
                "path": "packages/operator-core/lib/result-door.ts",
                "workingTreeBlobSha": "09552a3c963be08bd83a694b01db350acabd166f",
                "headBlobSha": "09552a3c963be08bd83a694b01db350acabd166f"
              },
              {
                "path": "packages/operator-core/lib/result-door.test.ts",
                "workingTreeBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164",
                "headBlobSha": "a2040d906b4cbb8464ac54efe0a46ef32dbcb164"
              }
            ]
          },
          "currentTreeStamp": {
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "headSha": "6505fa29ac33fd803058a7aa5e8370bb6876e13c",
            "contentIdentity": [
              {
                "path": "packages/operator-core/lib/result-door.ts",
                "workingTreeBlobSha": "fd58e23cfd9305cea09d7102af1f4fdde9356936",
                "headBlobSha": "fd58e23cfd9305cea09d7102af1f4fdde9356936"
              },
              {
                "path": "packages/operator-core/lib/result-door.test.ts",
                "workingTreeBlobSha": "660a2c71ce3a61c677a62e7a4f9bd91359e3d166",
                "headBlobSha": "660a2c71ce3a61c677a62e7a4f9bd91359e3d166"
              }
            ]
          },
          "reason": "Committed content for packages/operator-core/lib/result-door.ts changed between verification HEAD c9a2ecca438781185a40b89374cc93dae30e4516 and current HEAD 6505fa29ac33fd803058a7aa5e8370bb6876e13c; re-verify before treating the terminal result as current."
        },
        "deploymentPosition": {
          "paths": [],
          "unknownPaths": [
            "packages/operator-core/lib/result-door.ts",
            "packages/operator-core/lib/result-door.test.ts"
          ],
          "totalPaths": 2,
          "truncated": false,
          "unknownReason": "timeout"
        },
        "priorAttemptRefResolution": {
          "schemaVersion": "prior-attempt-refs-v1",
          "records": [
            {
              "scope": "self",
              "authority": "lifecycle",
              "rawRef": "EI-25574253034038454#lifecycle:audit_log:1791649718564:force-released",
              "workItemId": "EI-25574253034038454",
              "planItemId": null,
              "at": "2026-10-10T16:28:38.564Z",
              "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
              "text": "force-released (work_items:release:force): {\"basis\":\"holder-warm-idle\",\"holder\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"reason\":\"[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.\",\"harness\":\"papercusp\"}",
              "depth": 0,
              "detail": {
                "source": "audit_log",
                "basis": "holder-warm-idle",
                "holder": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
                "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
                "harness": "papercusp"
              },
              "id": "d87054c202a19f83406f",
              "approach": null,
              "outcome": null,
              "rootCauses": [],
              "falsePremises": [],
              "touchedFiles": [],
              "tests": [],
              "residue": []
            }
          ],
          "unresolved": [
            "EI-25405882696245541#lifecycle:audit_log:1791649666499:force-released"
          ],
          "fingerprint": "b6e4c4eff801903b93dcc5862e4edff289a3b854cbfa18fd3fc3cd8b8ae555d1"
        }
      },
      {
        "ok": true,
        "id": "EI-25405882696245541",
        "availability": "available",
        "workItem": {
          "id": "EI-25405882696245541",
          "kind": "bug",
          "family": "issue",
          "harness": "papercusp",
          "title": "tool-weight global compact floor headroom overrun",
          "summary": "Focused Reports delivery correction measures reports:publish1284chars (1500budget/1600hardcap; deferred non-floor). tool-weight CLI exits1 because compact floor delivery100559B exceeds100000B by559B, which is outside this Reports source correction. Explicit duplicate-only search returned possibleDuplicates:[]. Writer: scripts/tool-weight.ts delegates measureDeliverySummary('claude') and runToolWeightCli. Independent GATE_SYSTEM_DEV follow-up only; LIVE_GATE_OPS stand-down retained; cause not yet established.",
          "state": "done",
          "assignee": null,
          "takenAt": null,
          "lastProgressAt": null,
          "assignedBy": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
          "createdBy": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
          "severity": "major",
          "goalId": null,
          "tags": null,
          "sourcePlanSlug": null,
          "sourcePlanItemIds": null,
          "redundancy": null,
          "expectedCostCents": null,
          "parent": null,
          "payload": {
            "_ei": {
              "scope": "harness:papercusp",
              "source": "su",
              "severity": "major",
              "created_by": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
              "assigned_by": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
              "found_during": "WI-10007261",
              "signal_origin": "organic"
            },
            "filedByRole": "su",
            "_assumptions": {
              "declared": "none",
              "resolvedAt": "2026-10-11T04:52:55.392Z"
            },
            "dedupCoverage": {
              "lexical": "ok",
              "degraded": false,
              "semantic": "ok"
            },
            "ideaLifecycle": {
              "state": "open",
              "stateUpdatedAt": "2026-10-08T10:15:37.807Z"
            },
            "admissionIdentity": {
              "titleKey": "title:compact floor global headroom overrun tool weight",
              "schemaVersion": "admission-identity-v1"
            },
            "freshnessEnvelope": {
              "observedAt": "2026-10-08T10:15:37.808Z",
              "linkedFixRefs": [],
              "reporterSession": "su-4375e570-0ffb-4d0f-8652-9d23635c5fe9",
              "observedSourceSha": "d740fc3802",
              "toolSchemaVersion": null,
              "observedRuntimeSha": "d740fc3802",
              "deployBuildIdentity": "d740fc3802@0.0.0",
              "reporterRuntimeVersion": "0.0.0",
              "lastSuccessfulReproductionAt": null
            },
            "_completionEvidence": {
              "summary": "Reduced the compact-summary lead cap from 50 to 40 while preserving the independent 70-character safety-rail minimum. The 960-tool generated delivery artifact now measures 99,932 B with zero overrun.",
              "coverage": {
                "checked": [
                  "partial-guidance summary lead and mandatory-rail unit behavior",
                  "generated tool-delivery artifact for the 960-tool snapshot"
                ],
                "residue": [],
                "notChecked": [],
                "population": [
                  "partial-guidance summary lead and mandatory-rail unit behavior",
                  "generated tool-delivery artifact for the 960-tool snapshot"
                ],
                "notApplicable": []
              },
              "testsRun": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; npm run gen:tool-delivery:check",
              "treeStamp": {
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "contentIdentity": [
                  {
                    "path": "libs/generic/tooldef/src/partial-guidance.ts",
                    "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                    "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                    "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                    "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
                  },
                  {
                    "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                    "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                    "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                    "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                    "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
                  },
                  {
                    "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                    "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                    "headBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4",
                    "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                    "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                  }
                ]
              },
              "testResult": "Passed: partial-guidance.test.ts 21/21; GEN_TOOL_DELIVERY_CHECK ok for the 960-tool artifact at 99,932 B / zero overrun.",
              "verifiedHow": "Read the scoped source/test change in the generic/tooldef submodule, inspected the generated artifact diff, reran the focused test, and ran the generator consistency check. The test runner reports local submodule HEAD 9e74a4166c differs from superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245, so the passing test describes local staging state rather than the pinned candidate.",
              "filesChanged": [
                "libs/generic/tooldef/src/partial-guidance.ts",
                "libs/generic/tooldef/src/partial-guidance.test.ts",
                "apps/operator/scripts/tool-delivery.generated.mjs"
              ],
              "historyAttestation": {
                "version": 2,
                "checkouts": [
                  {
                    "paths": [
                      {
                        "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                        "proof": "exact-path-blob-history",
                        "fromHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                        "toCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                        "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                      }
                    ],
                    "closeHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                    "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                    "emittedCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
                  }
                ],
                "generation": 1,
                "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5"
              },
              "settlementManifest": {
                "headSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                "version": 1,
                "generation": 1,
                "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5",
                "residualPaths": [],
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "contentIdentity": [
                  {
                    "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                    "headBlobSha": "4e0a09d79631b7f48fd407e4804467bbb9828c35",
                    "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                  },
                  {
                    "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                    "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                    "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
                  },
                  {
                    "path": "libs/generic/tooldef/src/partial-guidance.ts",
                    "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                    "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
                  }
                ],
                "normalizedPaths": [
                  "apps/operator/scripts/tool-delivery.generated.mjs",
                  "libs/generic/tooldef/src/partial-guidance.test.ts",
                  "libs/generic/tooldef/src/partial-guidance.ts"
                ]
              },
              "rootCauseVerification": {
                "hypothesis": "The 50-character summary lead cap added enough selection prose across compact tools to push the measured 960-tool delivery above its 100,000-byte budget. The origin is lead sizing in partial-guidance; the independent safety-rail minimum remains 70 characters.",
                "testResult": "At lead cap 50 the CLI and generator matched at 100,278 B. The same-snapshot sweep at 40 measured 99,932 B with 66 compact tools and zero overrun; the 70-character rail minimum remained intact. The focused unit test passed 21/21 and the generated-artifact check passed.",
                "evidenceRefs": [
                  "EI-25405882696245541#checkpoint",
                  "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts (21/21; local submodule HEAD 9e74a4166c; superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245)",
                  "npm run gen:tool-delivery:check (GEN_TOOL_DELIVERY_CHECK ok)"
                ],
                "testProcedure": "Use scripts/tool-weight.ts and measureDeliverySummary('claude') for the baseline; run the built-in lead-cap sweep at 40; run PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; then run npm run gen:tool-delivery:check.",
                "contractVersion": 2,
                "actualObservation": "The saved checkpoint records matching CLI and generator baseline measurements of 100,278 B on catalog 960. Its cap sweep records 99,932 B at 40, 66 compact tools, zero overrun, and an unchanged 70-character rail floor. This turn reproduced the 21/21 focused-test pass and generator-check pass. The test runner stamped the local submodule HEAD and reported that the superproject still points at the prior gitlink.",
                "distinguishingTest": "Hold the 960-tool catalog and 70-character rail cap constant, compare CLI and generator measurements at lead cap 50, then sweep the lead cap to 40 and compare bytes, compact-tool count, and rail retention.",
                "alternativeHypothesis": "The apparent overrun came only from CLI and generator measuring different catalog snapshots, so reducing the lead cap would not fix the same-snapshot delivery.",
                "predictedObservations": {
                  "hypothesis": "Both baseline measurement paths report 100,278 B on catalog 960 at cap 50; cap 40 lowers that fixed-snapshot result to 99,932 B while keeping the rail minimum at 70.",
                  "alternativeHypothesis": "The baseline paths disagree because their catalog snapshots differ, or cap 40 leaves the same-snapshot measurement over budget without a consistent size reduction."
                }
              },
              "checkpointProseSnapshot": "## Did\nCurrent same-snapshot measurements from tool-weight and gen:tool-delivery both report 100278 B / 278 B over on catalog=960. The built-in cap sweep measured lead cap 40 at 99932 B (68 B headroom, 66 compact tools); safety rails retain their independent 70-character minimum. Changed SUMMARY_LEAD_MAX_CHARS 50→40 and regenerated apps/operator/scripts/tool-delivery.generated.mjs for all kinds: 99932 B, overrun 0. npm run gen:tool-delivery:check passed. The focused psu-launcher BUDGET assertions passed (2 tests). partial-guidance.test.ts initially found its hard-coded default-cap expectation at 50; updated it to 40 under lock, rerun pending. All locks released.\n\n## Left\nRerun PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; inspect final diff for only the intended cap, expectation, and generated artifact; then complete EI-25405882696245541 with nested rootCauseVerification. The historical 100559 B CLI value was inherited from prior work and was not reproduced: same-snapshot CLI/report both read 100278 B, so its exact historical cause remains unestablished. EI-25188923369514003 remains held and conditional on a dated event-time runtime record.\n\n## Key insight\nsummaryGuidanceDescription keeps the lead at the configured cap but rails at Math.max(cap, 70); lowering the default lead cap shortens selection prose while preserving hard-rail length. Existing psu-launcher budget assertion is the aggregate recurrence guard, and the generator check verifies artifact/source parity.\n\n## Next action\nRerun the compact-summary test, inspect the three-file diff, then close EI-25405882696245541 with evidence. Only after the close, pull the next admitted item via scheduler:get_next; the 2/2 claim cap blocked the prior pull."
            },
            "claim_history_post_id": 9001788375295,
            "implementationReadiness": {
              "reason": "existing-immediate-capture-policy",
              "source": "capture-policy",
              "status": "ready",
              "updatedAt": "2026-10-08T10:15:37.808Z",
              "schemaVersion": "implementation-readiness-v1"
            }
          },
          "rank": null,
          "rankWriter": null,
          "rankUpdatedAt": null,
          "priority": null,
          "terminalOwner": "su-5a5372ca-c10c-49bd-99b0-84f2502f080d",
          "terminalCompletionRef": null,
          "terminalCompletionEvidence": {
            "summary": "Reduced the compact-summary lead cap from 50 to 40 while preserving the independent 70-character safety-rail minimum. The 960-tool generated delivery artifact now measures 99,932 B with zero overrun.",
            "coverage": {
              "checked": [
                "partial-guidance summary lead and mandatory-rail unit behavior",
                "generated tool-delivery artifact for the 960-tool snapshot"
              ],
              "residue": [],
              "notChecked": [],
              "population": [
                "partial-guidance summary lead and mandatory-rail unit behavior",
                "generated tool-delivery artifact for the 960-tool snapshot"
              ],
              "notApplicable": []
            },
            "testsRun": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; npm run gen:tool-delivery:check",
            "treeStamp": {
              "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "libs/generic/tooldef/src/partial-guidance.ts",
                  "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                  "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                  "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                  "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
                },
                {
                  "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                  "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                  "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                  "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                  "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
                },
                {
                  "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                  "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                  "headBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4",
                  "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                  "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                }
              ]
            },
            "testResult": "Passed: partial-guidance.test.ts 21/21; GEN_TOOL_DELIVERY_CHECK ok for the 960-tool artifact at 99,932 B / zero overrun.",
            "verifiedHow": "Read the scoped source/test change in the generic/tooldef submodule, inspected the generated artifact diff, reran the focused test, and ran the generator consistency check. The test runner reports local submodule HEAD 9e74a4166c differs from superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245, so the passing test describes local staging state rather than the pinned candidate.",
            "filesChanged": [
              "libs/generic/tooldef/src/partial-guidance.ts",
              "libs/generic/tooldef/src/partial-guidance.test.ts",
              "apps/operator/scripts/tool-delivery.generated.mjs"
            ],
            "historyAttestation": {
              "version": 2,
              "checkouts": [
                {
                  "paths": [
                    {
                      "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                      "proof": "exact-path-blob-history",
                      "fromHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                      "toCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                      "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                    }
                  ],
                  "closeHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                  "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                  "emittedCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
                }
              ],
              "generation": 1,
              "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5"
            },
            "settlementManifest": {
              "headSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
              "version": 1,
              "generation": 1,
              "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5",
              "residualPaths": [],
              "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
              "contentIdentity": [
                {
                  "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                  "headBlobSha": "4e0a09d79631b7f48fd407e4804467bbb9828c35",
                  "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                },
                {
                  "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                  "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                  "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
                },
                {
                  "path": "libs/generic/tooldef/src/partial-guidance.ts",
                  "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                  "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
                }
              ],
              "normalizedPaths": [
                "apps/operator/scripts/tool-delivery.generated.mjs",
                "libs/generic/tooldef/src/partial-guidance.test.ts",
                "libs/generic/tooldef/src/partial-guidance.ts"
              ]
            },
            "rootCauseVerification": {
              "hypothesis": "The 50-character summary lead cap added enough selection prose across compact tools to push the measured 960-tool delivery above its 100,000-byte budget. The origin is lead sizing in partial-guidance; the independent safety-rail minimum remains 70 characters.",
              "testResult": "At lead cap 50 the CLI and generator matched at 100,278 B. The same-snapshot sweep at 40 measured 99,932 B with 66 compact tools and zero overrun; the 70-character rail minimum remained intact. The focused unit test passed 21/21 and the generated-artifact check passed.",
              "evidenceRefs": [
                "EI-25405882696245541#checkpoint",
                "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts (21/21; local submodule HEAD 9e74a4166c; superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245)",
                "npm run gen:tool-delivery:check (GEN_TOOL_DELIVERY_CHECK ok)"
              ],
              "testProcedure": "Use scripts/tool-weight.ts and measureDeliverySummary('claude') for the baseline; run the built-in lead-cap sweep at 40; run PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; then run npm run gen:tool-delivery:check.",
              "contractVersion": 2,
              "actualObservation": "The saved checkpoint records matching CLI and generator baseline measurements of 100,278 B on catalog 960. Its cap sweep records 99,932 B at 40, 66 compact tools, zero overrun, and an unchanged 70-character rail floor. This turn reproduced the 21/21 focused-test pass and generator-check pass. The test runner stamped the local submodule HEAD and reported that the superproject still points at the prior gitlink.",
              "distinguishingTest": "Hold the 960-tool catalog and 70-character rail cap constant, compare CLI and generator measurements at lead cap 50, then sweep the lead cap to 40 and compare bytes, compact-tool count, and rail retention.",
              "alternativeHypothesis": "The apparent overrun came only from CLI and generator measuring different catalog snapshots, so reducing the lead cap would not fix the same-snapshot delivery.",
              "predictedObservations": {
                "hypothesis": "Both baseline measurement paths report 100,278 B on catalog 960 at cap 50; cap 40 lowers that fixed-snapshot result to 99,932 B while keeping the rail minimum at 70.",
                "alternativeHypothesis": "The baseline paths disagree because their catalog snapshots differ, or cap 40 leaves the same-snapshot measurement over budget without a consistent size reduction."
              }
            },
            "checkpointProseSnapshot": "## Did\nCurrent same-snapshot measurements from tool-weight and gen:tool-delivery both report 100278 B / 278 B over on catalog=960. The built-in cap sweep measured lead cap 40 at 99932 B (68 B headroom, 66 compact tools); safety rails retain their independent 70-character minimum. Changed SUMMARY_LEAD_MAX_CHARS 50→40 and regenerated apps/operator/scripts/tool-delivery.generated.mjs for all kinds: 99932 B, overrun 0. npm run gen:tool-delivery:check passed. The focused psu-launcher BUDGET assertions passed (2 tests). partial-guidance.test.ts initially found its hard-coded default-cap expectation at 50; updated it to 40 under lock, rerun pending. All locks released.\n\n## Left\nRerun PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; inspect final diff for only the intended cap, expectation, and generated artifact; then complete EI-25405882696245541 with nested rootCauseVerification. The historical 100559 B CLI value was inherited from prior work and was not reproduced: same-snapshot CLI/report both read 100278 B, so its exact historical cause remains unestablished. EI-25188923369514003 remains held and conditional on a dated event-time runtime record.\n\n## Key insight\nsummaryGuidanceDescription keeps the lead at the configured cap but rails at Math.max(cap, 70); lowering the default lead cap shortens selection prose while preserving hard-rail length. Existing psu-launcher budget assertion is the aggregate recurrence guard, and the generator check verifies artifact/source parity.\n\n## Next action\nRerun the compact-summary test, inspect the three-file diff, then close EI-25405882696245541 with evidence. Only after the close, pull the next admitted item via scheduler:get_next; the 2/2 claim cap blocked the prior pull."
          },
          "completionAuthority": "committed",
          "origin": "local",
          "auditVerdict": null,
          "verifiedAuthorGithubUserId": null,
          "createdAt": "2026-10-08T10:15:37.808Z",
          "updatedAt": "2026-10-11T04:57:14.231Z",
          "closedAt": "2026-10-11T04:52:55.433Z"
        },
        "checkpoint": null,
        "checkpointChecks": {
          "count": 0,
          "cap": 12,
          "remaining": 12
        },
        "checkpointBody": {
          "chars": 0,
          "cap": 32000,
          "remaining": 32000
        },
        "checkpointAgeMs": null,
        "checkpointUpdatedAtMs": null,
        "checkpointContentHash": null,
        "checkpointSubjectFingerprint": {
          "status": "mismatch",
          "current": {
            "version": 1,
            "sha256": "34fd85df941ff7241a544e392268b102cdf5462446bd52dbbd985242fc26b473"
          },
          "stored": {
            "version": 1,
            "sha256": "ddaf5ead2b3b7a8bcd3cfe98a1ebbe2f8732a7ef65ba2ffc3c9d9a4a835ebba8"
          }
        },
        "completion": {
          "summary": "Reduced the compact-summary lead cap from 50 to 40 while preserving the independent 70-character safety-rail minimum. The 960-tool generated delivery artifact now measures 99,932 B with zero overrun.",
          "coverage": {
            "checked": [
              "partial-guidance summary lead and mandatory-rail unit behavior",
              "generated tool-delivery artifact for the 960-tool snapshot"
            ],
            "residue": [],
            "notChecked": [],
            "population": [
              "partial-guidance summary lead and mandatory-rail unit behavior",
              "generated tool-delivery artifact for the 960-tool snapshot"
            ],
            "notApplicable": []
          },
          "testsRun": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; npm run gen:tool-delivery:check",
          "treeStamp": {
            "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "contentIdentity": [
              {
                "path": "libs/generic/tooldef/src/partial-guidance.ts",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
              },
              {
                "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
              },
              {
                "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                "headBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
              }
            ]
          },
          "testResult": "Passed: partial-guidance.test.ts 21/21; GEN_TOOL_DELIVERY_CHECK ok for the 960-tool artifact at 99,932 B / zero overrun.",
          "verifiedHow": "Read the scoped source/test change in the generic/tooldef submodule, inspected the generated artifact diff, reran the focused test, and ran the generator consistency check. The test runner reports local submodule HEAD 9e74a4166c differs from superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245, so the passing test describes local staging state rather than the pinned candidate.",
          "filesChanged": [
            "libs/generic/tooldef/src/partial-guidance.ts",
            "libs/generic/tooldef/src/partial-guidance.test.ts",
            "apps/operator/scripts/tool-delivery.generated.mjs"
          ],
          "historyAttestation": {
            "version": 2,
            "checkouts": [
              {
                "paths": [
                  {
                    "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                    "proof": "exact-path-blob-history",
                    "fromHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                    "toCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
                    "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
                  }
                ],
                "closeHeadSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "emittedCommitSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
              }
            ],
            "generation": 1,
            "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5"
          },
          "settlementManifest": {
            "headSha": "15ad6a1da90811a1c9cd1a5a084d1c7c08108725",
            "version": 1,
            "generation": 1,
            "evidenceHash": "da8fcefdcddc737c7cc8bea3ece409a94f3ac9713af118a0b9169e5128a5eae5",
            "residualPaths": [],
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "contentIdentity": [
              {
                "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                "headBlobSha": "4e0a09d79631b7f48fd407e4804467bbb9828c35",
                "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4"
              },
              {
                "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
              },
              {
                "path": "libs/generic/tooldef/src/partial-guidance.ts",
                "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
              }
            ],
            "normalizedPaths": [
              "apps/operator/scripts/tool-delivery.generated.mjs",
              "libs/generic/tooldef/src/partial-guidance.test.ts",
              "libs/generic/tooldef/src/partial-guidance.ts"
            ]
          },
          "rootCauseVerification": {
            "hypothesis": "The 50-character summary lead cap added enough selection prose across compact tools to push the measured 960-tool delivery above its 100,000-byte budget. The origin is lead sizing in partial-guidance; the independent safety-rail minimum remains 70 characters.",
            "testResult": "At lead cap 50 the CLI and generator matched at 100,278 B. The same-snapshot sweep at 40 measured 99,932 B with 66 compact tools and zero overrun; the 70-character rail minimum remained intact. The focused unit test passed 21/21 and the generated-artifact check passed.",
            "evidenceRefs": [
              "EI-25405882696245541#checkpoint",
              "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts (21/21; local submodule HEAD 9e74a4166c; superproject pin 4144310a3d0fa8395c8e5bd3ee8356e78e010245)",
              "npm run gen:tool-delivery:check (GEN_TOOL_DELIVERY_CHECK ok)"
            ],
            "testProcedure": "Use scripts/tool-weight.ts and measureDeliverySummary('claude') for the baseline; run the built-in lead-cap sweep at 40; run PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; then run npm run gen:tool-delivery:check.",
            "contractVersion": 2,
            "actualObservation": "The saved checkpoint records matching CLI and generator baseline measurements of 100,278 B on catalog 960. Its cap sweep records 99,932 B at 40, 66 compact tools, zero overrun, and an unchanged 70-character rail floor. This turn reproduced the 21/21 focused-test pass and generator-check pass. The test runner stamped the local submodule HEAD and reported that the superproject still points at the prior gitlink.",
            "distinguishingTest": "Hold the 960-tool catalog and 70-character rail cap constant, compare CLI and generator measurements at lead cap 50, then sweep the lead cap to 40 and compare bytes, compact-tool count, and rail retention.",
            "alternativeHypothesis": "The apparent overrun came only from CLI and generator measuring different catalog snapshots, so reducing the lead cap would not fix the same-snapshot delivery.",
            "predictedObservations": {
              "hypothesis": "Both baseline measurement paths report 100,278 B on catalog 960 at cap 50; cap 40 lowers that fixed-snapshot result to 99,932 B while keeping the rail minimum at 70.",
              "alternativeHypothesis": "The baseline paths disagree because their catalog snapshots differ, or cap 40 leaves the same-snapshot measurement over budget without a consistent size reduction."
            }
          },
          "checkpointProseSnapshot": "## Did\nCurrent same-snapshot measurements from tool-weight and gen:tool-delivery both report 100278 B / 278 B over on catalog=960. The built-in cap sweep measured lead cap 40 at 99932 B (68 B headroom, 66 compact tools); safety rails retain their independent 70-character minimum. Changed SUMMARY_LEAD_MAX_CHARS 50→40 and regenerated apps/operator/scripts/tool-delivery.generated.mjs for all kinds: 99932 B, overrun 0. npm run gen:tool-delivery:check passed. The focused psu-launcher BUDGET assertions passed (2 tests). partial-guidance.test.ts initially found its hard-coded default-cap expectation at 50; updated it to 40 under lock, rerun pending. All locks released.\n\n## Left\nRerun PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- libs/generic/tooldef/src/partial-guidance.test.ts; inspect final diff for only the intended cap, expectation, and generated artifact; then complete EI-25405882696245541 with nested rootCauseVerification. The historical 100559 B CLI value was inherited from prior work and was not reproduced: same-snapshot CLI/report both read 100278 B, so its exact historical cause remains unestablished. EI-25188923369514003 remains held and conditional on a dated event-time runtime record.\n\n## Key insight\nsummaryGuidanceDescription keeps the lead at the configured cap but rails at Math.max(cap, 70); lowering the default lead cap shortens selection prose while preserving hard-rail length. Existing psu-launcher budget assertion is the aggregate recurrence guard, and the generator check verifies artifact/source parity.\n\n## Next action\nRerun the compact-summary test, inspect the three-file diff, then close EI-25405882696245541 with evidence. Only after the close, pull the next admitted item via scheduler:get_next; the 2/2 claim cap blocked the prior pull."
        },
        "hasCompletionEvidence": true,
        "completionFreshness": {
          "verdict": "stale",
          "storedTreeStamp": {
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e",
            "contentIdentity": [
              {
                "path": "libs/generic/tooldef/src/partial-guidance.ts",
                "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
              },
              {
                "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
              },
              {
                "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                "workingTreeBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4",
                "headBlobSha": "47e80fe814dfdb2a78ea68a7ae93b7a70ce6a1f4",
                "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
                "headSha": "e4891d0d5f7016b7a3d08ca79d742c590a65748e"
              }
            ]
          },
          "currentTreeStamp": {
            "repositoryRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "headSha": "6505fa29ac33fd803058a7aa5e8370bb6876e13c",
            "contentIdentity": [
              {
                "path": "libs/generic/tooldef/src/partial-guidance.ts",
                "workingTreeBlobSha": "1c711489bda912937185b4427bdb615be0675d9a",
                "headBlobSha": "1c711489bda912937185b4427bdb615be0675d9a"
              },
              {
                "path": "libs/generic/tooldef/src/partial-guidance.test.ts",
                "workingTreeBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4",
                "headBlobSha": "1669a38a152d0fc864d14b10f4b42c2c900a45f4"
              },
              {
                "path": "apps/operator/scripts/tool-delivery.generated.mjs",
                "workingTreeBlobSha": "25b7960cffac51f456b020e5c730a93ccad670da",
                "headBlobSha": "25b7960cffac51f456b020e5c730a93ccad670da"
              }
            ]
          },
          "reason": "Committed content for apps/operator/scripts/tool-delivery.generated.mjs changed between verification HEAD e4891d0d5f7016b7a3d08ca79d742c590a65748e and current HEAD 6505fa29ac33fd803058a7aa5e8370bb6876e13c; re-verify before treating the terminal result as current."
        },
        "deploymentPosition": {
          "paths": [],
          "unknownPaths": [
            "libs/generic/tooldef/src/partial-guidance.ts",
            "libs/generic/tooldef/src/partial-guidance.test.ts",
            "apps/operator/scripts/tool-delivery.generated.mjs"
          ],
          "totalPaths": 3,
          "truncated": false,
          "unknownReason": "timeout"
        },
        "priorAttemptRefResolution": {
          "schemaVersion": "prior-attempt-refs-v1",
          "records": [
            {
              "scope": "self",
              "authority": "lifecycle",
              "rawRef": "EI-25405882696245541#lifecycle:audit_log:1791649666499:force-released",
              "workItemId": "EI-25405882696245541",
              "planItemId": null,
              "at": "2026-10-10T16:27:46.499Z",
              "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
              "text": "force-released (work_items:release:force): {\"basis\":\"holder-warm-idle\",\"holder\":\"su-8d2cb6cc-8f27-4a25-8541-b00927471b94\",\"reason\":\"[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.\",\"harness\":\"papercusp\"}",
              "depth": 0,
              "detail": {
                "source": "audit_log",
                "basis": "holder-warm-idle",
                "holder": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
                "reason": "[owner:Avi 2026-10-10 #1594] plan bug-queue-legitimacy P-008: holder inactive >2h with no item progress >2h; stale reservation released so the drain fleet can claim it. Holder may re-claim if still working.",
                "harness": "papercusp"
              },
              "id": "d2f6507c6980258d8927",
              "approach": null,
              "outcome": null,
              "rootCauses": [],
              "falsePremises": [],
              "touchedFiles": [],
              "tests": [],
              "residue": []
            }
          ],
          "unresolved": [
            "EI-25574253034038454#lifecycle:audit_log:1791649718564:force-released"
          ],
          "fingerprint": "28c8718150bb2d987bb80b6c9bc70db27eac9bb34a1b33942e13261f76b5c5d7"
        }
      }
    ],
    "counts": {
      "ok": 2,
      "failed": 0
    },
    "read": {
      "schemaVersion": "work-items-get-read-v1",
      "mode": "complete",
      "requested": 2,
      "available": 2,
      "absent": 0,
      "unavailable": 0,
      "budgetMs": 30000,
      "elapsedMs": 10021,
      "baseReadMaxMs": 3,
      "enrichmentMaxMs": 10018,
      "outerStageAttribution": "tool_invocations.duration_ms minus elapsedMs is combined dispatch/projection/serialization time"
    }
  }
}
