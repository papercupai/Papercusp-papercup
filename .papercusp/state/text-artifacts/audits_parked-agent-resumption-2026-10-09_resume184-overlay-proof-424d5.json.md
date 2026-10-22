---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume184-overlay-proof-424d5.json"
updated_at: 1792675884483
_body: "content"
---

{
  "schemaVersion": "parked-resume184-overlay-proof-v1",
  "parent": "WI-6554700010008887",
  "bug": "EI-26686070814371483",
  "scope": "Approved SELF/AUTO whole-plan continuation; only R15/R16 verification selectors and shared terminal-period comparison fixed. Overall task remains open.",
  "references": [
    "audits/parked-agent-resumption-2026-10-09/resume183-clean-mutation-qualification-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/resume184-case-mapping-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/resume184-mapped-adequacy-424d5.json"
  ],
  "local": {
    "routePreflight": {
      "ok": true,
      "summary": {
        "planHash": "40df4c9cc0ab55e3095e47eb3ed1191d9acb694295709134d71661ad9a2e0d24",
        "version": 74,
        "run": [
          {
            "id": 21746326,
            "status": "pass",
            "cases": [
              {
                "caseKey": "activates agents-stranded at the configured threshold independently of wedged",
                "occurrence": 1,
                "status": "pass",
                "durationMs": 270818,
                "errorTail": null
              },
              {
                "caseKey": "preserves the active agents-stranded alarm when its census leg is unobservable",
                "occurrence": 1,
                "status": "pass",
                "durationMs": 0,
                "errorTail": null
              },
              {
                "caseKey": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
                "occurrence": 1,
                "status": "skip",
                "durationMs": null,
                "errorTail": null
              },
              {
                "caseKey": "keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery",
                "occurrence": 1,
                "status": "skip",
                "durationMs": null,
                "errorTail": null
              },
              {
                "caseKey": "delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence",
                "occurrence": 1,
                "status": "skip",
                "durationMs": null,
                "errorTail": null
              },
              {
                "caseKey": "delivers one Papercusp-owned spend alarm and resolves a measured budget recovery",
                "occurrence": 1,
                "status": "skip",
                "durationMs": null,
                "errorTail": null
              }
            ]
          }
        ],
        "testKeys": [
          "id",
          "workspaceId",
          "harnessSlug",
          "root",
          "executionDetails",
          "filePath",
          "status",
          "framework",
          "startedAt",
          "finishedAt",
          "durationMs",
          "commitSha",
          "runGroupId",
          "source",
          "branch",
          "outputTail",
          "loopLagP95Ms",
          "rssMb",
          "saturationSuspect",
          "worktreeDirty",
          "isScratchConfig",
          "cases"
        ]
      },
      "logs": [],
      "dryRun": false,
      "dispatchCount": 2,
      "dispatchTimings": {
        "calls": [
          {
            "ordinal": 0,
            "tool": "plans:get",
            "effect": "read",
            "elapsedMs": 385,
            "disposition": "settled",
            "callId": "q5twp9-io"
          },
          {
            "ordinal": 1,
            "tool": "testing:runs",
            "effect": "read",
            "elapsedMs": 21,
            "disposition": "settled",
            "callId": "q5twp9-ip"
          }
        ],
        "totalCount": 2,
        "omittedCount": 0,
        "maxCalls": 24
      },
      "intermediateBytes": 349114,
      "runtimeObservations": {
        "authorizationObservationCount": 2,
        "authorityWideningDetected": false,
        "midTurnPromptInjectionObservability": "not-observable"
      },
      "plannedMutations": [],
      "okFalseMutations": [],
      "childFailures": [],
      "partial": false
    },
    "mappingReceipt": {
      "schemaVersion": "papercusp.output-envelope/v1",
      "summary": "",
      "summaryProvenance": "authored",
      "content": [
        {
          "kind": "reference",
          "uri": "papercusp://scratch/papercusp-workspace/code:run/02640dd2-ef53-4767-b924-575dc43b4911/result-door-1792675026236-58ed46e6.spill",
          "preview": "{\"ok\":true,\"summary\":{\"receipt\":{\"ok\":true,\"slug\":\"parked-agent-census-resumption-and-root-cause-2026-10-09\",\"contentHash\":\"4e0b575f47882d9c97e375125dd77fc270c153b95a3e0af3b4cf409b75d5b571\",\"version\":75,\"filePath\":\"plan://papercusp/parked-a",
          "byteCount": 6285,
          "sha256": "f67f2d2205f41564d3d84805ce4de0891dc54d7d702398a0482feec5a5613034",
          "expiresAt": "2026-10-23T13:17:06.236Z",
          "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
          "audience": "owner"
        }
      ],
      "state": "incomplete",
      "incomplete": {
        "reason": "under-budget-partial-result",
        "spilledItems": 2,
        "recoverable": false,
        "note": "The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. The `uri` in `content` is a framed scratch-reference container, not a raw JSON file. Read it with `capability:read` byte pages (`byte_offset` + `byte_limit`, without `raw`) and follow `next_cursor` to validate and unwrap its manifest before parsing the payload; the default numbered line view can truncate a long single-line payload. However, the emitted result already carries upstream partial marker(s) (summaryNotice.truncated); paging this reference cannot recover the omitted fields, rows, or text. Read the original unshaped return through `summaryNotice.rawSummaryCursor` with `capability:read`, following `next_cursor`; the ordinary result-door spill contains only the emitted bounded summary. If `rawSummaryCursor.status` is `unavailable`, re-run code:run with a smaller return split into bounded slices."
      },
      "metrics": {},
      "accounting": {
        "summaryChars": 0,
        "summaryBytes": 0,
        "contentBytes": 632,
        "totalBytes": 632,
        "summaryBudgetChars": 0
      }
    },
    "evaluationReceipt": {
      "ok": true,
      "summary": {
        "mapping": {
          "ok": true,
          "version": 75,
          "activationAudit": {
            "status": "preserved",
            "auditSeq": 6,
            "auditedPlanRevision": {
              "id": 79041,
              "seq": 68,
              "contentHash": "357edc88b704e84f53fccd7c127b41529cac310f41c6cb0c4e8eda05ccb19580"
            },
            "currentPlanRevision": {
              "id": 80630,
              "seq": 75,
              "contentHash": "4e0b575f47882d9c97e375125dd77fc270c153b95a3e0af3b4cf409b75d5b571",
              "planVersion": 75,
              "recorded": true
            },
            "changedSinceAudit": true,
            "revisionGap": 7,
            "reAudit": {
              "decision": "editing_agent",
              "requiredWhen": [
                "requirements",
                "scope",
                "constraints",
                "decisions",
                "dependencies",
                "sequencing",
                "acceptance criteria",
                "open questions",
                "promised follow-ups"
              ],
              "notRequiredWhen": [
                "spelling",
                "formatting",
                "cosmetic-only wording"
              ],
              "instruction": "Activation audit #6 covered revision 68; the plan is now revision 75. The audit remains recorded. Re-run plans:audit { phase:'activation' } if this edit materially changes requirements, scope, constraints, decisions, dependencies, sequencing, acceptance criteria, open questions, promised follow-ups. spelling, formatting, cosmetic-only wording do not require another audit."
            }
          },
          "receiptKeys": [
            "ok",
            "slug",
            "contentHash",
            "version",
            "filePath",
            "revision",
            "activationAudit",
            "itemsParsed",
            "items",
            "_meta"
          ],
          "proofChars": 711591
        },
        "evaluation": {
          "ok": true,
          "build": {
            "sha": "6430ced5a6",
            "version": "0.0.0"
          },
          "verdicts": {
            "pass": 0,
            "fail": 0,
            "unknown": 2
          },
          "rows": [
            {
              "specId": "AUTO-BAR-R-15-P-011",
              "specRevision": 2,
              "verdict": "unknown",
              "ratings": {
                "traceability": "pass",
                "fixture-calibration": "pass",
                "falsifiability": "pass",
                "correct-layer": "unknown",
                "oracle-independence": "pass",
                "execution-integrity": "pass",
                "freshness": "pass",
                "plan-class-risk-floor": "pass",
                "disclosed-gap": "not-applicable"
              }
            },
            {
              "specId": "AUTO-BAR-R-16-P-011",
              "specRevision": 2,
              "verdict": "unknown",
              "ratings": {
                "traceability": "pass",
                "fixture-calibration": "pass",
                "falsifiability": "pass",
                "correct-layer": "unknown",
                "oracle-independence": "pass",
                "execution-integrity": "pass",
                "freshness": "pass",
                "plan-class-risk-floor": "pass",
                "disclosed-gap": "not-applicable"
              }
            }
          ],
          "wouldBlock": [
            {
              "specId": "AUTO-BAR-R-15-P-011",
              "revision": 2,
              "criteria": [
                "correct-layer"
              ]
            },
            {
              "specId": "AUTO-BAR-R-16-P-011",
              "revision": 2,
              "criteria": [
                "correct-layer"
              ]
            }
          ]
        },
        "proof": {
          "path": "audits/parked-agent-resumption-2026-10-09/resume184-mapped-adequacy-424d5.json",
          "chars": 244328,
          "saveOk": true,
          "exactReadback": true
        }
      },
      "logs": [],
      "dryRun": false,
      "dispatchCount": 4,
      "dispatchTimings": {
        "calls": [
          {
            "ordinal": 0,
            "tool": "artifacts:load",
            "effect": "read",
            "elapsedMs": 156,
            "disposition": "settled",
            "callId": "q5twp9-r1"
          },
          {
            "ordinal": 1,
            "tool": "plans:evaluate-spec-test-adequacy",
            "effect": "read",
            "elapsedMs": 6673,
            "disposition": "settled",
            "callId": "q5twp9-r2"
          },
          {
            "ordinal": 2,
            "tool": "artifacts:save",
            "effect": "write",
            "elapsedMs": 260,
            "disposition": "settled",
            "callId": "q5twp9-rb"
          },
          {
            "ordinal": 3,
            "tool": "artifacts:load",
            "effect": "read",
            "elapsedMs": 90,
            "disposition": "settled",
            "callId": "q5twp9-rd"
          }
        ],
        "totalCount": 4,
        "omittedCount": 0,
        "maxCalls": 24
      },
      "intermediateBytes": 1246560,
      "runtimeObservations": {
        "authorizationObservationCount": 4,
        "authorityWideningDetected": false,
        "midTurnPromptInjectionObservability": "not-observable"
      },
      "childFailures": [],
      "partial": false,
      "mutations": {
        "count": 1,
        "byTool": {
          "artifacts:save": 1
        },
        "attemptedCount": 1,
        "settledPrefixCount": 1,
        "dispositions": {
          "settled": [
            0
          ]
        },
        "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
      }
    },
    "diagnostic": {
      "ok": true,
      "summary": {
        "ok": true,
        "bash_id": "87a64710-8e3",
        "task_id": "0mvjkly1f9u48ma17hz",
        "status": "completed",
        "running": false,
        "yielded": false,
        "exit_code": 0,
        "duration_ms": 40515,
        "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
        "output": "[db] target source=operator-env-file endpoint=localhost:5432\n{\"bar\":\"R-15\",\"differences\":[{\"field\":\"title\",\"stored\":\"The agents-stranded standing alarm is active at its configured threshold (AGENT_STRANDED_ALARM_THRESHOLD, currently 5).\",\"parsed\":\"The agents-stranded standing alarm is active at its configured threshold (AGENT_STRANDED_ALARM_THRESHOLD, currently 5)\"}]}\n{\"bar\":\"R-16\",\"differences\":[{\"field\":\"title\",\"stored\":\"An unobserved census leg preserves its existing population alarm.\",\"parsed\":\"An unobserved census leg preserves its existing population alarm\"}]}\n",
        "truncated": false,
        "total_bytes": 573,
        "log_path": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-87a64710-8e3.log",
        "response_window_ms": 45000,
        "timeout_ms": 120000,
        "deadline": "2026-10-22T13:24:16.160Z",
        "_meta": {
          "explicitFullRequest": true,
          "_seeAlso": [
            {
              "tool": "capability:bash_output (read a backgrounded run)"
            },
            {
              "tool": "capability:git (git actions, gated as git)"
            },
            {
              "tool": "logs:read { unit, since, grep, limit } (service logs; filters inside journalctl)"
            }
          ]
        }
      },
      "logs": [],
      "dryRun": false,
      "dispatchCount": 3,
      "dispatchTimings": {
        "calls": [
          {
            "ordinal": 0,
            "tool": "plans:get",
            "effect": "read",
            "elapsedMs": 315,
            "disposition": "settled",
            "callId": "q5twp9-1cj"
          },
          {
            "ordinal": 1,
            "tool": "rubrics:get",
            "effect": "read",
            "elapsedMs": 761,
            "disposition": "settled",
            "callId": "q5twp9-1ck"
          },
          {
            "ordinal": 2,
            "tool": "capability:bash",
            "effect": "write",
            "elapsedMs": 40650,
            "disposition": "settled",
            "callId": "q5twp9-1cm"
          }
        ],
        "totalCount": 3,
        "omittedCount": 0,
        "maxCalls": 24
      },
      "intermediateBytes": 429958,
      "runtimeObservations": {
        "authorizationObservationCount": 3,
        "authorityWideningDetected": false,
        "midTurnPromptInjectionObservability": "not-observable"
      },
      "childFailures": [],
      "partial": false,
      "mutations": {
        "count": 1,
        "byTool": {
          "capability:bash": 1
        },
        "attemptedCount": 1,
        "settledPrefixCount": 1,
        "dispositions": {
          "settled": [
            0
          ]
        },
        "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
      }
    },
    "causalRedLog": "\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts -t stored title retains the heading terminal period\n\n[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).\n[pc-heavy] slot acquired — starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=6 admittedCgroupMiB=9368 admissionId=pc-heavy-1721469-1792675514156328401 retryHandle=psi-recovery:pc-heavy-1721469-1792675514156328401 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts -t stored title retains the heading terminal period (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)\nFocused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=21 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=8594 capturedBytes=773 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={\"channel\":\"stdout\",\"text\":\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"}\nPC_HEAVY_PREEMPT_READY pid=1725780\n[db] target source=operator-env-file endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=12 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10012 capturedBytes=712 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1753781,\\\"event\\\":\\\"node-loaded\\\",\\\"nodeOptions\\\":{\\\"sha256\\\":\\\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\\\",\\\"bytes\\\":243,\\\"switches\\\":[\\\"--import\\\"]},\\\"execArgv\\\":{\\\"sha256\\\":\\\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\\\",\\\"bytes\\\":0,\\\"switches\\\":[]}}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20013 capturedBytes=1440 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1753781,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":1758924,\\\"elapsedMs\\\":635,\\\"startupMs\\\":633,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=30014 capturedBytes=1440 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1753781,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":1758924,\\\"elapsedMs\\\":635,\\\"startupMs\\\":633,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=40015 capturedBytes=1440 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1753781,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":1758924,\\\"elapsedMs\\\":635,\\\"startupMs\\\":633,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=50016 capturedBytes=1492 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"[db] target source=fallback endpoint=localhost:5432\"}\nPC_HEAVY_PSI_FINALIZATION pid=1725780\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=50540 capturedBytes=1635 completedFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stdout\",\"text\":\"❯ lib/agent-tools/rubrics/acceptance-live-requirements.test.ts (19 tests | 1 failed | 18 skipped) 44ms\"}\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=56440 capturedBytes=5357 completedFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=1 signal=none lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1753781,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":1758924,\\\"elapsedMs\\\":37300,\\\"code\\\":null,\\\"signal\\\":\\\"SIGTERM\\\"}\"}\nRunning as unit: papercusp-test-1725780-mvjkqe6x-4.scope; invocation ID: 58e9d0aaade44e0cb0c02e5a82c93a76\nTEST_FILE_STARTUP_TRACE {\"pid\":1745644,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-forked\",\"childPid\":1758924}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"start-sent\",\"childPid\":1758924,\"elapsedMs\":2}\nTEST_FILE_STARTUP_TRACE {\"pid\":1758924,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"started-received\",\"childPid\":1758924,\"elapsedMs\":635,\"startupMs\":633,\"error\":false}\n[db] target source=fallback endpoint=localhost:5432\nTEST_FILE_HEARTBEAT completedCases=1\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"stop-sent\",\"childPid\":1758924,\"elapsedMs\":35866}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"stopped-received\",\"childPid\":1758924,\"elapsedMs\":35867,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-signal\",\"childPid\":1758924,\"elapsedMs\":35867,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-signal\",\"childPid\":1758924,\"elapsedMs\":36368,\"signal\":\"SIGKILL\",\"sent\":true}\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  lib/agent-tools/rubrics/acceptance-live-requirements.test.ts > readLiveAcceptanceCriteria (the acceptance read) > overlays named cases when a stored title retains the heading terminal period\nAssertionError: expected { kind: 'tests', …(1) } to deeply equal { kind: 'tests', …(2) }\n\n- Expected\n+ Received\n\n  {\n-   \"cases\": [\n-     {\n-       \"file\": \"packages/operator-core/lib/new-path.test.ts\",\n-       \"testName\": \"the required named case\",\n-     },\n-   ],\n    \"files\": [\n-     \"packages/operator-core/lib/new-path.test.ts\",\n+     \"packages/operator-core/lib/old-path.test.ts\",\n    ],\n    \"kind\": \"tests\",\n  }\n\n ❯ lib/agent-tools/rubrics/acceptance-live-requirements.test.ts:259:37\n    257|       { readSubjectPlanContent: async () => ({ content: edited }), par…\n    258|     );\n    259|     expect(read.criteria[0]!.check).toEqual(check);\n       |                                     ^\n    260|     expect(read.criteria[0]!.title).toBe('Live view.');\n    261|     expect(read.status).toMatchObject({ live: ['R-1'], changed: ['R-1'…\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯\n\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-disconnect\",\"childPid\":1758924,\"elapsedMs\":37299}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-exit\",\"childPid\":1758924,\"elapsedMs\":37300,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1753781,\"event\":\"worker-close\",\"childPid\":1758924,\"elapsedMs\":37300,\"code\":null,\"signal\":\"SIGTERM\"}\nTEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed\nTEST_FILE_ASSERTION_FAILURE file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" name=\"readLiveAcceptanceCriteria (the acceptance read) overlays named cases when a stored title retains the heading terminal period\" message=\"AssertionError: expected { kind: 'tests', …(1) } to deeply equal { kind: 'tests', …(2) }\\n    at /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts:259:37\\n    at processTicksAndRejections (node:internal/process/task_queues:104:5)\\n    at file:///home/marsh-office/papercupai-workspace/papercusp/node_modules/vitest/node_modules/@vitest/runner/dist/chunk-artifact.js:1903:20\"\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1721469-1792675514156328401 retryHandle=psi-recovery:pc-heavy-1721469-1792675514156328401 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=16b035a000 testedPaths=1 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-22T13:25:21.036Z\n  HEAD         : 16b035a000\n  tested files : packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts  [DIRTY +36/-0]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\n  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.\n  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.\n     Falsify against the judged candidate BEFORE recording any of them as stale:\n       git show <candidate>:packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n  matched lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n\n RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core\n\n ❯ lib/agent-tools/rubrics/acceptance-live-requirements.test.ts (19 tests | 1 failed | 18 skipped) 44ms\n     ↓ is unchanged for an identical criterion\n     ↓ treats a tests-check file move as verification-only\n     ↓ keeps explicit file/case selectors in verification and overlays them without changing meaning\n     ↓ treats a method rewrite as verification-only\n     ↓ treats a condition change as meaning\n     ↓ treats a check-kind change as meaning\n     ↓ treats an added or removed requirement as meaning\n     ↓ keeps a non-tests check whole in the meaning projection\n     ↓ is unchanged by a test-path-only or method-only requirement edit\n     ↓ still changes for a meaning edit, so an amendment stays required\n     ↓ takes method and check from the live explicit block, and reports what changed\n     ↓ keeps a stored field the live block omits instead of blanking it\n     ↓ keeps stored verification when a same-key live block changes BAR meaning before amendment\n     ↓ overlays a same-kind instrument rebind when the promise is unchanged (WI-6554700010018740)\n     ↓ shows the new test path after a test-path-only edit, with no amendment\n     ↓ does not pair a changed BAR meaning with the pre-amendment live method/check\n     × overlays named cases when a stored title retains the heading terminal period 38ms\n     ↓ falls back to the stored criteria, naming why, when the subject plan cannot be read\n     ↓ does not overlay a non-acceptance rubric\n\n Test Files  1 failed (1)\n      Tests  1 failed | 18 skipped (19)\n   Start at  09:25:58\n   Duration  36.87s (transform 26.13s, setup 429ms, import 34.73s, tests 44ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=16b035a000 testedPaths=1 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-22T13:26:40.521Z\n  HEAD         : 16b035a000\n  tested files : packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts  [DIRTY +36/-0]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\n  ⚠ 1 of 1 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.\n  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.\n     Falsify against the judged candidate BEFORE recording any of them as stale:\n       git show <candidate>:packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit is unchanged for an identical criterion\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit treats a tests-check file move as verification-only\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit keeps explicit file/case selectors in verification and overlays them without changing meaning\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit treats a method rewrite as verification-only\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit treats a condition change as meaning\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit treats a check-kind change as meaning\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit treats an added or removed requirement as meaning\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"classifyRequirementBarEdit keeps a non-tests check whole in the meaning projection\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"acceptanceBarSourceFingerprint (BAR-neutrality of plan edits) is unchanged by a test-path-only or method-only requirement edit\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"acceptanceBarSourceFingerprint (BAR-neutrality of plan edits) still changes for a meaning edit, so an amendment stays required\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"overlayLiveRequirementVerification takes method and check from the live explicit block, and reports what changed\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"overlayLiveRequirementVerification keeps a stored field the live block omits instead of blanking it\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"overlayLiveRequirementVerification keeps stored verification when a same-key live block changes BAR meaning before amendment\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"overlayLiveRequirementVerification overlays a same-kind instrument rebind when the promise is unchanged (WI-6554700010018740)\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"readLiveAcceptanceCriteria (the acceptance read) shows the new test path after a test-path-only edit, with no amendment\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"readLiveAcceptanceCriteria (the acceptance read) does not pair a changed BAR meaning with the pre-amendment live method/check\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"readLiveAcceptanceCriteria (the acceptance read) falls back to the stored criteria, naming why, when the subject plan cannot be read\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_SKIPPED name=\"readLiveAcceptanceCriteria (the acceptance read) does not overlay a non-acceptance rubric\" file=\"/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\" — COLLECTED, NOT RUN: this assertion produced no evidence in this run\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=16b035a000 uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-22T13:25:21.036Z childSubstituted=0 skippedTests=18\n",
    "greenLog": "\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts packages/operator-core/lib/agent-tools/plans/source-bar-test-requirements.test.ts\n\n[pc-heavy] release gate is JUDGING (phase=suite) — heavy slots clamped to 2 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY — you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).\n[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) — pid 1860236, waiting up to 30s\n[pc-heavy] still queued (15s elapsed, pid 1860236, slots=1)\n[pc-heavy] slot acquired — starting real work\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts packages/operator-core/lib/agent-tools/plans/source-bar-test-requirements.test.ts (root=/home/marsh-office/papercupai-workspace/papercusp, lock=npm-install-79e418157b6a)\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=13 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=4262 capturedBytes=832 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={\"channel\":\"stdout\",\"text\":\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"}\nPC_HEAVY_PREEMPT_READY pid=1885625\n[db] target source=operator-env-file endpoint=localhost:5432\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=7 admittedCgroupMiB=2303 admissionId=pc-heavy-1860236-1792675681691451829 retryHandle=psi-recovery:pc-heavy-1860236-1792675681691451829 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=25 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\",\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=6868 capturedBytes=2198 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stdout\",\"text\":\"✓ lib/agent-tools/plans/source-bar-test-requirements.test.ts (19 tests) 41ms\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10026 capturedBytes=2931 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1906367,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":1909220,\\\"elapsedMs\\\":2323,\\\"code\\\":null,\\\"signal\\\":\\\"SIGTERM\\\"}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20027 capturedBytes=2931 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1906367,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":1909220,\\\"elapsedMs\\\":2323,\\\"code\\\":null,\\\"signal\\\":\\\"SIGTERM\\\"}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=30028 capturedBytes=2931 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1906367,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":1909220,\\\"elapsedMs\\\":2323,\\\"code\\\":null,\\\"signal\\\":\\\"SIGTERM\\\"}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=40029 capturedBytes=2983 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\"] pendingFiles=[\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"[db] target source=fallback endpoint=localhost:5432\"}\nPC_HEAVY_PSI_FINALIZATION pid=1885625\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=40545 capturedBytes=3103 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\",\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stdout\",\"text\":\"✓ lib/agent-tools/rubrics/acceptance-live-requirements.test.ts (19 tests) 98ms\"}\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=43794 capturedBytes=4229 completedFiles=[\"lib/agent-tools/plans/source-bar-test-requirements.test.ts\",\"lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":1906367,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":1909209,\\\"elapsedMs\\\":37066,\\\"code\\\":null,\\\"signal\\\":\\\"SIGKILL\\\"}\"}\nRunning as unit: papercusp-test-1885625-mvjktsa8-4.scope; invocation ID: 930439bee6604b01925cdf02eaad6a61\nTEST_FILE_STARTUP_TRACE {\"pid\":1904535,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-forked\",\"childPid\":1909209}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-forked\",\"childPid\":1909220}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"start-sent\",\"childPid\":1909209,\"elapsedMs\":12}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"start-sent\",\"childPid\":1909220,\"elapsedMs\":3}\nTEST_FILE_STARTUP_TRACE {\"pid\":1909209,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1909220,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"8e1f91d2fab3573c5d4fc01af74ff478f73b49fb45c09f6bdd8a3fd3f9ac74c5\",\"bytes\":243,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"started-received\",\"childPid\":1909209,\"elapsedMs\":606,\"startupMs\":594,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"started-received\",\"childPid\":1909220,\"elapsedMs\":648,\"startupMs\":645,\"error\":false}\nTEST_FILE_HEARTBEAT completedCases=1\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"stop-sent\",\"childPid\":1909220,\"elapsedMs\":2183}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"stopped-received\",\"childPid\":1909220,\"elapsedMs\":2184,\"stopMs\":1,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-signal\",\"childPid\":1909220,\"elapsedMs\":2184,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-disconnect\",\"childPid\":1909220,\"elapsedMs\":2314}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-exit\",\"childPid\":1909220,\"elapsedMs\":2323,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-close\",\"childPid\":1909220,\"elapsedMs\":2323,\"code\":null,\"signal\":\"SIGTERM\"}\n[db] target source=fallback endpoint=localhost:5432\nTEST_FILE_HEARTBEAT completedCases=20\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"stop-sent\",\"childPid\":1909209,\"elapsedMs\":35871}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"stopped-received\",\"childPid\":1909209,\"elapsedMs\":35874,\"stopMs\":3,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-signal\",\"childPid\":1909209,\"elapsedMs\":35874,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-disconnect\",\"childPid\":1909209,\"elapsedMs\":35904}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-signal\",\"childPid\":1909209,\"elapsedMs\":36377,\"signal\":\"SIGKILL\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-exit\",\"childPid\":1909209,\"elapsedMs\":37065,\"code\":null,\"signal\":\"SIGKILL\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":1906367,\"event\":\"worker-close\",\"childPid\":1909209,\"elapsedMs\":37066,\"code\":null,\"signal\":\"SIGKILL\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-1860236-1792675681691451829 retryHandle=psi-recovery:pc-heavy-1860236-1792675681691451829 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=2 groups=1\nTEST_FILE_PROVENANCE head=16b035a000 testedPaths=2 uncommitted=1 unknown=0 phase=pre-run startedAt=2026-10-22T13:28:09.064Z\n  HEAD         : 16b035a000\n  tested files : packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts  [DIRTY +36/-0]\n                 packages/operator-core/lib/agent-tools/plans/source-bar-test-requirements.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\n  ⚠ 1 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.\n  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.\n     Falsify against the judged candidate BEFORE recording any of them as stale:\n       git show <candidate>:packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\nROUTE cwd=packages/operator-core config=vitest.config.ts\n  requested lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n  requested lib/agent-tools/plans/source-bar-test-requirements.test.ts\n  matched lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n  matched lib/agent-tools/plans/source-bar-test-requirements.test.ts\n\n RUN  v4.1.8 /home/marsh-office/papercupai-workspace/papercusp/packages/operator-core\n\n ✓ lib/agent-tools/plans/source-bar-test-requirements.test.ts (19 tests) 41ms\n ✓ lib/agent-tools/rubrics/acceptance-live-requirements.test.ts (19 tests) 98ms\n\n Test Files  2 passed (2)\n      Tests  38 passed (38)\n   Start at  09:28:26\n   Duration  35.96s (transform 27.43s, setup 1.21s, import 35.40s, tests 139ms, environment 0ms)\n\nTEST_FILE_PROVENANCE head=16b035a000 testedPaths=2 uncommitted=1 unknown=0 phase=post-run startedAt=2026-10-22T13:29:06.085Z\n  HEAD         : 16b035a000\n  tested files : packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts  [DIRTY +36/-0]\n                 packages/operator-core/lib/agent-tools/plans/source-bar-test-requirements.test.ts  [clean]\n  scope        : the NAMED paths above only — an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\n  ⚠ 1 of 2 tested path(s) carry uncommitted changes — this result describes LOCAL state and is not reproducible by anyone else. Cite it with this stamp or not at all.\n  ⛔ STALE-VERDICT TRAP: a PASS here does NOT make a gate verdict naming these path(s) stale — the pass can be riding on uncommitted work while the COMMITTED blob the gate judged still fails.\n     Falsify against the judged candidate BEFORE recording any of them as stale:\n       git show <candidate>:packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\nTEST_FILE_RESULT requested=2 executed=2 matched=2 status=passed head=16b035a000 uncommittedPaths=1/2 provenance=stamped startedAt=2026-10-22T13:28:09.064Z childSubstituted=0 skippedTests=0\n"
  },
  "files": [
    {
      "path": "packages/operator-core/lib/acceptance-live-requirements.ts",
      "sha256": "2d6f81f209fa5c08db378c27b7fc0262ec3c3e96a5ad9be6e163ae9e329d1606",
      "committedSha256": "a1b2ec16bd74bfa73cdfccda73c792b83264098471a2db94f8b411d3ebdf1aa4",
      "matchesHead": false,
      "content": "/**\n * Acceptance criteria as a LIVE view of the subject plan's requirement blocks\n * (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001 / R-1).\n *\n * WHY. A seeded acceptance rubric holds a copy of every plan `R-N` requirement block. Before\n * this module, ANY edit to a block — including only moving its named test file — changed\n * `acceptanceBarSourceFingerprint`, so the subject's BAR pin stayed stale until an agent ran\n * `rubrics:amend`, which in turn re-vetted and re-graded the rubric. Measured on\n * slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08: 4 amendments, each resetting vetting and\n * grading, most of them path or method corrections.\n *\n * WHAT. Split a requirement into its MEANING (intent, condition, falsifier, scope, plane, layers,\n * check kind) and its VERIFICATION HOW (`method`, `replication`, and the file/test-name fields of\n * a `tests` check). A verification-only edit is BAR-neutral: the pin advances on the ordinary\n * neutral path and nothing is re-vetted or re-graded. Acceptance reads then take the verification\n * fields from the live plan block instead of the stored copy. A meaning edit is unchanged\n * behaviour: it still needs an amendment.\n *\n * The live block is canonical for verification fields because `rubrics:amend` re-renders the\n * plan's requirement blocks (`rerenderAmendedRequirementBlocks`), so after any amendment the block\n * and the rubric agree, and every later edit to the block is the newest truth.\n *\n * The stored rubric (and its barHash / criteriaHash) is deliberately NOT rewritten: those hashes\n * are the identity vetting, grading and proof were recorded against. This is a read overlay.\n */\n\n/** A structured criterion check, as persisted on a rubric criterion. */\nexport interface LiveRequirementCheck {\n  kind: string;\n  [field: string]: unknown;\n}\n\n/** The verification-HOW fields of a criterion. */\nexport interface LiveVerificationFields {\n  method?: string;\n  check?: LiveRequirementCheck;\n  replication?: unknown;\n}\n\n/** Per check kind, the fields that only say WHERE/HOW the proof runs, not WHAT it proves. */\nexport const VERIFICATION_ONLY_CHECK_FIELDS: Readonly<Record<string, readonly string[]>> = {\n  tests: ['files', 'testName', 'cases'],\n};\n\nfunction neutralCheck(check: LiveRequirementCheck): LiveRequirementCheck {\n  const pathFields = VERIFICATION_ONLY_CHECK_FIELDS[check.kind];\n  if (!pathFields) return check;\n  return Object.fromEntries(\n    Object.entries(check).filter(([field]) => !pathFields.includes(field)),\n  ) as LiveRequirementCheck;\n}\n\n/**\n * The criterion with its verification HOW removed — what the requirement MEANS.\n *\n * `barHash` is dropped too: the normalizer derives it from the criterion INCLUDING `check`, so\n * keeping it would smuggle the test file list back into the meaning. Every field it summarises\n * that carries meaning is still compared directly.\n */\nexport function verificationNeutralCriterion<\n  T extends LiveVerificationFields & { bar?: unknown; barHash?: unknown; barProvenance?: unknown },\n>(\n  criterion: T,\n): Omit<T, 'method' | 'replication' | 'bar' | 'barHash' | 'barProvenance'> {\n  // `bar` is the read-only acceptance projection alias of `model`, while\n  // `barHash` and `barProvenance` are server-owned identity/lifecycle fields.\n  // None belongs in the meaning comparison used by the live plan overlay.\n  const {\n    method: _method,\n    replication: _replication,\n    bar: _alias,\n    barHash: _derived,\n    barProvenance: _provenance,\n    check,\n    ...meaning\n  } = criterion;\n  return check === undefined\n    ? (meaning as Omit<T, 'method' | 'replication' | 'bar' | 'barHash' | 'barProvenance'>)\n    : ({ ...meaning, check: neutralCheck(check) } as Omit<T, 'method' | 'replication' | 'bar' | 'barHash' | 'barProvenance'>);\n}\n\nfunction stableJson(value: unknown): string {\n  const canonical = (input: unknown): unknown => {\n    if (Array.isArray(input)) return input.map(canonical);\n    if (input && typeof input === 'object') {\n      return Object.fromEntries(\n        Object.entries(input as Record<string, unknown>)\n          .filter(([, nested]) => nested !== undefined)\n          .sort(([a], [b]) => a.localeCompare(b))\n          .map(([key, nested]) => [key, canonical(nested)]),\n      );\n    }\n    return input;\n  };\n  return JSON.stringify(canonical(value));\n}\n\nexport type RequirementBarEdit = 'unchanged' | 'verification-only' | 'meaning';\n\n/**\n * Classify one requirement's edit. An added or removed requirement is a meaning change; an\n * edit confined to `method`, `replication` or a `tests` check's files/test name is\n * verification-only; anything else is a meaning change.\n */\nexport function classifyRequirementBarEdit<B extends LiveVerificationFields, A extends LiveVerificationFields>(\n  before: B | null | undefined,\n  after: A | null | undefined,\n): RequirementBarEdit {\n  if (!before || !after) return !before && !after ? 'unchanged' : 'meaning';\n  if (stableJson(before) === stableJson(after)) return 'unchanged';\n  return stableJson(verificationNeutralCriterion(before)) === stableJson(verificationNeutralCriterion(after))\n    ? 'verification-only'\n    : 'meaning';\n}\n\nexport type LiveRequirementCriterion = LiveVerificationFields & Record<string, unknown>;\n\nexport interface LiveRequirementBar {\n  barKey: string;\n  /** Present only for an explicit ```requirement block; legacy prose has no verification of its own. */\n  criterion?: LiveRequirementCriterion;\n}\n\nexport type LiveRequirementKeptReason = 'no-explicit-block' | 'check-kind-changed' | 'meaning-changed';\n\nexport interface LiveRequirementOverlay<C> {\n  criteria: C[];\n  /** BARs whose verification fields are read from the live plan block. */\n  live: string[];\n  /** Subset of `live` whose verification differs from the stored copy. */\n  changed: string[];\n  /** BARs that keep the stored verification, and why. */\n  kept: Array<{ barKey: string; reason: LiveRequirementKeptReason }>;\n}\n\nconst VERIFICATION_FIELDS = ['method', 'check', 'replication'] as const;\n\n/** A criterion's promise: its meaning projection with the whole check removed. */\nfunction promiseProjection(criterion: LiveVerificationFields): Record<string, unknown> {\n  const { check: _check, ...promise }: Record<string, unknown> = verificationNeutralCriterion(criterion);\n  // Requirement headings consume their final period as Markdown syntax, while\n  // stored rubric titles can retain it. Compare the same label in both forms\n  // without changing the persisted title or accepting a different promise.\n  if (typeof promise.title === 'string') promise.title = promise.title.trim().replace(/\\.$/, '');\n  return promise;\n}\n\n/**\n * Overlay each stored acceptance criterion's verification fields with the live plan block's.\n *\n * A BAR keeps its stored verification when the plan has no explicit block for it (legacy prose)\n * or when the block's check KIND differs — a kind change alters what the proof measures, so it is\n * a meaning change that still needs an amendment. It also keeps it when the live block's PROMISE\n * (every meaning field except the check) differs from the stored one: the same R-N key then names\n * a new promise that only an amendment may adopt. A same-kind check rebind under an unchanged\n * promise (for example `instrument:none` → a registered instrument) is overlaid. A live field the\n * block omits keeps its stored value rather than being blanked.\n */\nexport function overlayLiveRequirementVerification<C extends LiveVerificationFields & { barKey?: string | null }>(\n  stored: readonly C[],\n  liveBars: readonly LiveRequirementBar[],\n): LiveRequirementOverlay<C> {\n  const byKey = new Map(liveBars.map((bar) => [bar.barKey, bar] as const));\n  const live: string[] = [];\n  const changed: string[] = [];\n  const kept: LiveRequirementOverlay<C>['kept'] = [];\n  const criteria = stored.map((criterion) => {\n    const barKey = criterion.barKey?.trim();\n    if (!barKey) return criterion;\n    const block = byKey.get(barKey)?.criterion;\n    if (!block) {\n      kept.push({ barKey, reason: 'no-explicit-block' });\n      return criterion;\n    }\n    if ((criterion.check?.kind ?? null) !== (block.check?.kind ?? criterion.check?.kind ?? null)) {\n      kept.push({ barKey, reason: 'check-kind-changed' });\n      return criterion;\n    }\n    // A plan can be rewritten before its acceptance rubric amendment lands. In\n    // that window the same R-N key may carry a new promise, while the stored\n    // rubric still carries the old promise. Overlaying the new verification\n    // fields onto the old criterion makes methods/checks appear one BAR away\n    // from their model and falsifier. Only a meaning-preserving edit may supply\n    // live verification fields; the canonical amendment remains responsible for\n    // adopting a changed BAR.\n    // The parser normally returns a complete criterion, but callers can provide a\n    // verification-only projection (for example, a test path/method patch). Merge\n    // the live block over the stored criterion before comparing meaning so omitted\n    // meaning fields remain inherited instead of looking like a BAR rewrite.\n    // The comparison is over the PROMISE only (the meaning projection without\n    // `check`): the check KIND is guarded just above, and the check's own details\n    // are exactly what this overlay exists to carry. Binding a stored\n    // `instrument:none` seed to the plan's registered instrument under an\n    // unchanged promise is therefore overlaid, which the scheduled rescore depends\n    // on (EI-26127406089578547, WI-6554700010018740).\n    if (stableJson(promiseProjection(criterion)) !== stableJson(promiseProjection({ ...criterion, ...block }))) {\n      kept.push({ barKey, reason: 'meaning-changed' });\n      return criterion;\n    }\n    const next: C = { ...criterion };\n    for (const field of VERIFICATION_FIELDS) {\n      if (block[field] !== undefined) (next as LiveVerificationFields)[field] = block[field] as never;\n    }\n    live.push(barKey);\n    if (classifyRequirementBarEdit(criterion, next) !== 'unchanged') changed.push(barKey);\n    return next;\n  });\n  return { criteria, live, changed, kept };\n}\n\nexport interface LiveAcceptanceViewDeps {\n  readSubjectPlanContent: (args: {\n    planSlug: string;\n    harnessSlug?: string;\n  }) => Promise<{ content: string; version?: number | null } | null>;\n  parseRequirementBars: (content: string) =>\n    | { ok: true; bars: LiveRequirementBar[] }\n    | { ok: false; problems: Array<{ detail: string }> };\n}\n\nexport type LiveAcceptanceViewStatus =\n  | { source: 'live-plan'; subjectPlan: string; subjectPlanVersion: number | null; live: string[]; changed: string[]; kept: LiveRequirementOverlay<unknown>['kept'] }\n  | { source: 'stored-rubric'; reason: 'not-a-plan-acceptance-rubric' | 'subject-plan-unreadable' | 'requirements-unparseable'; detail?: string };\n\n/**\n * The acceptance READ: stored criteria with verification fields from the subject plan's live\n * requirement blocks. Fail-soft — any read or parse failure returns the stored criteria with a\n * `stored-rubric` status naming why, never a guessed overlay.\n */\nexport async function readLiveAcceptanceCriteria<C extends LiveVerificationFields & { barKey?: string | null }>(\n  rubric: { kind?: string | null; subjectPlan?: string | null; subjectHarnessSlug?: string | null; criteria: readonly C[] },\n  deps: LiveAcceptanceViewDeps,\n): Promise<{ criteria: C[]; status: LiveAcceptanceViewStatus }> {\n  if (rubric.kind !== 'acceptance' || !rubric.subjectPlan) {\n    return { criteria: [...rubric.criteria], status: { source: 'stored-rubric', reason: 'not-a-plan-acceptance-rubric' } };\n  }\n  let plan: { content: string; version?: number | null } | null;\n  try {\n    plan = await deps.readSubjectPlanContent({\n      planSlug: rubric.subjectPlan,\n      ...(rubric.subjectHarnessSlug ? { harnessSlug: rubric.subjectHarnessSlug } : {}),\n    });\n  } catch (error) {\n    return {\n      criteria: [...rubric.criteria],\n      status: { source: 'stored-rubric', reason: 'subject-plan-unreadable', detail: error instanceof Error ? error.message : String(error) },\n    };\n  }\n  if (!plan) {\n    return { criteria: [...rubric.criteria], status: { source: 'stored-rubric', reason: 'subject-plan-unreadable' } };\n  }\n  const parsed = deps.parseRequirementBars(plan.content);\n  if (!parsed.ok) {\n    return {\n      criteria: [...rubric.criteria],\n      status: { source: 'stored-rubric', reason: 'requirements-unparseable', detail: parsed.problems.map((p) => p.detail).join('; ') },\n    };\n  }\n  const overlay = overlayLiveRequirementVerification(rubric.criteria, parsed.bars);\n  return {\n    criteria: overlay.criteria,\n    status: {\n      source: 'live-plan',\n      subjectPlan: rubric.subjectPlan,\n      subjectPlanVersion: plan.version ?? null,\n      live: overlay.live,\n      changed: overlay.changed,\n      kept: overlay.kept,\n    },\n  };\n}\n"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts",
      "sha256": "1cc513590ef27d7ffd5d5548bd4d3a849f0c63c7aa8841cc565090af2fa949b3",
      "committedSha256": "8f7877ae0dbfeee1a385adb661cde4d5ce1fe3a84003038733aa1ff9f4050333",
      "matchesHead": false,
      "content": "/**\n * R-1 (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001): acceptance criteria are a\n * live view of the plan's requirement blocks. A test-path-only edit to a requirement must be\n * BAR-neutral (no amendment, so nothing re-vets or re-grades) and the next acceptance read must\n * show the new test path. A meaning edit must still require an amendment.\n */\nimport { describe, expect, it } from 'vitest';\nimport { acceptanceBarSourceFingerprint } from '../../acceptance-bar-amendment';\nimport { parseRequirementBars } from '../../acceptance-bar-seed';\nimport {\n  classifyRequirementBarEdit,\n  overlayLiveRequirementVerification,\n  readLiveAcceptanceCriteria,\n  verificationNeutralCriterion,\n  type LiveAcceptanceViewDeps,\n} from '../../acceptance-live-requirements';\n\nconst OLD_TEST = 'packages/operator-core/lib/old-path.test.ts';\nconst NEW_TEST = 'packages/operator-core/lib/new-path.test.ts';\n\nfunction requirementBlock(opts: { file?: string; condition?: string; method?: string; checkKind?: 'tests' | 'instrument' } = {}): string {\n  const check = (opts.checkKind ?? 'tests') === 'tests'\n    ? { kind: 'tests', files: [opts.file ?? OLD_TEST] }\n    : { kind: 'instrument', instrumentKey: 'none' };\n  return JSON.stringify({\n    intent: { request: 'Read acceptance criteria from the live plan.', sourceRefs: ['owner-directive:1909'] },\n    acceptance: {\n      condition: opts.condition ?? 'A path-only edit shows the new path on the next read.',\n      falsifier: 'A path-only edit leaves a stale criterion.',\n      evidencePlane: 'tree',\n      requiredScope: ['P-001'],\n      requiredTestLayers: ['unit'],\n    },\n    verification: { method: opts.method ?? 'Run the live-view tests.', check },\n  });\n}\n\nfunction fixturePlan(block: string): string {\n  return [\n    '---', 'title: Live view fixture', 'slug: live-view-fixture', 'status: active', '---', '',\n    '## Requirements', '',\n    '**R-1 — Live view.**', '',\n    '```requirement', block, '```', '',\n    '## Design', '',\n    '### Bar-to-work map for this plan', '',\n    '| bar | implementing plan items | evidence plane |',\n    '|---|---|---|',\n    '| R-1 | P-001 | tree |', '',\n    '## Phase 1', '',\n    '- **P-001** `todo` Build the live view (R-1).', '',\n  ].join('\\n');\n}\n\ndescribe('classifyRequirementBarEdit', () => {\n  const base = { model: 'm', driftMarkers: 'f', method: 'run it', check: { kind: 'tests', files: [OLD_TEST] } };\n\n  it('is unchanged for an identical criterion', () => {\n    expect(classifyRequirementBarEdit(base, { ...base })).toBe('unchanged');\n  });\n  it('treats a tests-check file move as verification-only', () => {\n    expect(classifyRequirementBarEdit(base, { ...base, check: { kind: 'tests', files: [NEW_TEST] } })).toBe('verification-only');\n  });\n  it('keeps explicit file/case selectors in verification and overlays them without changing meaning', () => {\n    const check = { kind: 'tests', files: [NEW_TEST], cases: [{ file: NEW_TEST, testName: 'specific new case' }] };\n    expect(classifyRequirementBarEdit(base, { ...base, check })).toBe('verification-only');\n    const overlay = overlayLiveRequirementVerification([{ ...base, barKey: 'R-1' }], [{ barKey: 'R-1', criterion: { check } }]);\n    expect(overlay.criteria[0]?.check).toEqual(check);\n  });\n  it('treats a method rewrite as verification-only', () => {\n    expect(classifyRequirementBarEdit(base, { ...base, method: 'run it differently' })).toBe('verification-only');\n  });\n  it('treats a condition change as meaning', () => {\n    expect(classifyRequirementBarEdit(base, { ...base, model: 'a different promise' })).toBe('meaning');\n  });\n  it('treats a check-kind change as meaning', () => {\n    expect(classifyRequirementBarEdit(base, { ...base, check: { kind: 'instrument', instrumentKey: 'none' } })).toBe('meaning');\n  });\n  it('treats an added or removed requirement as meaning', () => {\n    expect(classifyRequirementBarEdit(undefined, base)).toBe('meaning');\n    expect(classifyRequirementBarEdit(base, null)).toBe('meaning');\n  });\n  it('keeps a non-tests check whole in the meaning projection', () => {\n    const neutral = verificationNeutralCriterion({ check: { kind: 'probe', all: ['a'] }, method: 'x' });\n    expect(neutral).toEqual({ check: { kind: 'probe', all: ['a'] } });\n  });\n});\n\ndescribe('acceptanceBarSourceFingerprint (BAR-neutrality of plan edits)', () => {\n  it('is unchanged by a test-path-only or method-only requirement edit', async () => {\n    const before = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock()));\n    // Positive control: the fixture parses, so equality below is not two nulls.\n    expect(before).toMatch(/^[a-f0-9]{64}$/);\n    expect(await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ file: NEW_TEST })))).toBe(before);\n    expect(await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ method: 'Run the renamed tests.' })))).toBe(before);\n  });\n\n  it('still changes for a meaning edit, so an amendment stays required', async () => {\n    const before = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock()));\n    const condition = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ condition: 'A different promise holds.' })));\n    const kind = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ checkKind: 'instrument' })));\n    expect(condition).toMatch(/^[a-f0-9]{64}$/);\n    expect(condition).not.toBe(before);\n    expect(kind).not.toBe(before);\n  });\n});\n\ndescribe('overlayLiveRequirementVerification', () => {\n  const stored = [\n    { key: 'r-1', barKey: 'R-1', method: 'old', check: { kind: 'tests', files: [OLD_TEST] } },\n    { key: 'r-2', barKey: 'R-2', method: 'legacy', check: { kind: 'tests', files: [OLD_TEST] } },\n    { key: 'r-3', barKey: 'R-3', method: 'kind', check: { kind: 'tests', files: [OLD_TEST] } },\n  ];\n\n  it('takes method and check from the live explicit block, and reports what changed', () => {\n    const overlay = overlayLiveRequirementVerification(stored, [\n      { barKey: 'R-1', criterion: { method: 'new', check: { kind: 'tests', files: [NEW_TEST] } } },\n      { barKey: 'R-2' },\n      { barKey: 'R-3', criterion: { check: { kind: 'instrument', instrumentKey: 'none' } } },\n    ]);\n    expect(overlay.criteria[0]).toMatchObject({ method: 'new', check: { kind: 'tests', files: [NEW_TEST] } });\n    expect(overlay.live).toEqual(['R-1']);\n    expect(overlay.changed).toEqual(['R-1']);\n    expect(overlay.criteria[1]).toBe(stored[1]);\n    expect(overlay.criteria[2]).toBe(stored[2]);\n    expect(overlay.kept).toEqual([\n      { barKey: 'R-2', reason: 'no-explicit-block' },\n      { barKey: 'R-3', reason: 'check-kind-changed' },\n    ]);\n  });\n\n  it('keeps a stored field the live block omits instead of blanking it', () => {\n    const overlay = overlayLiveRequirementVerification([stored[0]!], [{ barKey: 'R-1', criterion: { check: { kind: 'tests', files: [NEW_TEST] } } }]);\n    expect(overlay.criteria[0]!.method).toBe('old');\n  });\n\n  it('keeps stored verification when a same-key live block changes BAR meaning before amendment', () => {\n    const storedCriterion = {\n      key: 'r-2',\n      barKey: 'R-2',\n      model: 'The settlement lookup uses the index.',\n      driftMarkers: 'The lookup scans the table.',\n      method: 'Run the settlement integration suite.',\n      check: { kind: 'tests', files: [OLD_TEST] },\n    };\n    const overlay = overlayLiveRequirementVerification([storedCriterion], [{\n      barKey: 'R-2',\n      criterion: {\n        key: 'r-2',\n        barKey: 'R-2',\n        model: 'Every event family has a proof classification.',\n        driftMarkers: 'An unclassified family leaves the catalogue test green.',\n        method: 'Run the catalogue classification suite.',\n        check: { kind: 'tests', files: [NEW_TEST] },\n      },\n    }]);\n    expect(overlay.criteria[0]).toBe(storedCriterion);\n    expect(overlay.live).toEqual([]);\n    expect(overlay.changed).toEqual([]);\n    expect(overlay.kept).toEqual([{ barKey: 'R-2', reason: 'meaning-changed' }]);\n  });\n\n  it('overlays a same-kind instrument rebind when the promise is unchanged (WI-6554700010018740)', () => {\n    const promise = {\n      key: 'r-15',\n      barKey: 'R-15',\n      title: 'Outcome',\n      model: 'The outcome meets its bar.',\n      driftMarkers: 'The outcome misses its bar.',\n      evidencePlane: 'live',\n      method: 'Run the registered measurement.',\n    };\n    const storedCriterion = { ...promise, check: { kind: 'instrument', instrumentKey: 'none' } };\n    const live = { ...promise, check: { kind: 'instrument', instrumentKey: 'agents:native-session-minutes' } };\n    const overlay = overlayLiveRequirementVerification([storedCriterion], [{ barKey: 'R-15', criterion: live }]);\n    expect(overlay.criteria[0]!.check).toEqual({ kind: 'instrument', instrumentKey: 'agents:native-session-minutes' });\n    expect(overlay.live).toEqual(['R-15']);\n    expect(overlay.changed).toEqual(['R-15']);\n    expect(overlay.kept).toEqual([]);\n    // The same rebind paired with a rewritten promise is still kept for the amendment.\n    const rewritten = overlayLiveRequirementVerification([storedCriterion], [{\n      barKey: 'R-15', criterion: { ...live, model: 'A different promise.' },\n    }]);\n    expect(rewritten.criteria[0]).toBe(storedCriterion);\n    expect(rewritten.kept).toEqual([{ barKey: 'R-15', reason: 'meaning-changed' }]);\n  });\n});\n\ndescribe('readLiveAcceptanceCriteria (the acceptance read)', () => {\n  const realParser: LiveAcceptanceViewDeps['parseRequirementBars'] = (content) => {\n    const parsed = parseRequirementBars(content);\n    return parsed.ok\n      ? { ok: true, bars: parsed.bars.map((bar) => ({ barKey: bar.barKey, ...(bar.criterion ? { criterion: bar.criterion } : {}) })) }\n      : { ok: false, problems: parsed.problems };\n  };\n\n  it('shows the new test path after a test-path-only edit, with no amendment', async () => {\n    const original = fixturePlan(requirementBlock());\n    const edited = fixturePlan(requirementBlock({ file: NEW_TEST }));\n    const seeded = parseRequirementBars(original);\n    if (!seeded.ok) throw new Error('fixture must parse');\n    const storedCriteria = seeded.bars.map((bar) => ({ ...bar.criterion!, barKey: bar.barKey }));\n    expect(storedCriteria[0]!.check).toMatchObject({ kind: 'tests', files: [OLD_TEST] });\n\n    // No amendment: the edit is BAR-neutral, so the pin advances on the neutral path.\n    expect(await acceptanceBarSourceFingerprint(edited)).toBe(await acceptanceBarSourceFingerprint(original));\n\n    const read = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'live-view-fixture', subjectHarnessSlug: 'papercusp', criteria: storedCriteria },\n      { readSubjectPlanContent: async () => ({ content: edited, version: 7 }), parseRequirementBars: realParser },\n    );\n    expect(read.criteria[0]!.check).toMatchObject({ kind: 'tests', files: [NEW_TEST] });\n    expect(read.status).toMatchObject({ source: 'live-plan', subjectPlanVersion: 7, live: ['R-1'], changed: ['R-1'] });\n  });\n\n  it('does not pair a changed BAR meaning with the pre-amendment live method/check', async () => {\n    const original = fixturePlan(requirementBlock());\n    const edited = fixturePlan(requirementBlock({\n      condition: 'A different promise now holds.',\n      method: 'Run the replacement proof.',\n      file: NEW_TEST,\n    }));\n    const seeded = parseRequirementBars(original);\n    if (!seeded.ok) throw new Error('fixture must parse');\n    const storedCriteria = seeded.bars.map((bar) => ({ ...bar.criterion!, barKey: bar.barKey }));\n\n    const read = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'live-view-fixture', subjectHarnessSlug: 'papercusp', criteria: storedCriteria },\n      { readSubjectPlanContent: async () => ({ content: edited, version: 8 }), parseRequirementBars: realParser },\n    );\n    expect(read.criteria[0]!.model).toBe(storedCriteria[0]!.model);\n    expect(read.criteria[0]!.method).toBe(storedCriteria[0]!.method);\n    expect(read.criteria[0]!.check).toEqual(storedCriteria[0]!.check);\n    expect(read.status).toMatchObject({\n      source: 'live-plan',\n      subjectPlanVersion: 8,\n      live: [],\n      changed: [],\n      kept: [{ barKey: 'R-1', reason: 'meaning-changed' }],\n    });\n  });\n\n  it('overlays named cases when a stored title retains the heading terminal period', async () => {\n    const seeded = parseRequirementBars(fixturePlan(requirementBlock()));\n    if (!seeded.ok) throw new Error('fixture must parse');\n    const storedCriteria = seeded.bars.map((bar) => ({\n      ...bar.criterion!, barKey: bar.barKey, title: `${bar.title}.`,\n    }));\n    const block = JSON.parse(requirementBlock({ file: NEW_TEST }));\n    const check = {\n      kind: 'tests', files: [NEW_TEST],\n      cases: [{ file: NEW_TEST, testName: 'the required named case' }],\n    };\n    block.verification.check = check;\n    const edited = fixturePlan(JSON.stringify(block));\n    const read = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'live-view-fixture', criteria: storedCriteria },\n      { readSubjectPlanContent: async () => ({ content: edited }), parseRequirementBars: realParser },\n    );\n    expect(read.criteria[0]!.check).toEqual(check);\n    expect(read.criteria[0]!.title).toBe('Live view.');\n    expect(read.status).toMatchObject({ live: ['R-1'], changed: ['R-1'], kept: [] });\n\n    const renamed = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'live-view-fixture', criteria: storedCriteria },\n      {\n        readSubjectPlanContent: async () => ({\n          content: edited.replace('**R-1 — Live view.**', '**R-1 — Changed view.**'),\n        }),\n        parseRequirementBars: realParser,\n      },\n    );\n    expect(renamed.criteria[0]!.check).toEqual(storedCriteria[0]!.check);\n    expect(renamed.status).toMatchObject({\n      live: [], kept: [{ barKey: 'R-1', reason: 'meaning-changed' }],\n    });\n  });\n\n  it('falls back to the stored criteria, naming why, when the subject plan cannot be read', async () => {\n    const criteria = [{ barKey: 'R-1', check: { kind: 'tests', files: [OLD_TEST] } }];\n    const unreadable = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'gone', criteria },\n      { readSubjectPlanContent: async () => { throw new Error('pg down'); }, parseRequirementBars: realParser },\n    );\n    expect(unreadable.criteria).toEqual(criteria);\n    expect(unreadable.status).toMatchObject({ source: 'stored-rubric', reason: 'subject-plan-unreadable', detail: 'pg down' });\n\n    const missing = await readLiveAcceptanceCriteria(\n      { kind: 'acceptance', subjectPlan: 'gone', criteria },\n      { readSubjectPlanContent: async () => null, parseRequirementBars: realParser },\n    );\n    expect(missing.status).toMatchObject({ source: 'stored-rubric', reason: 'subject-plan-unreadable' });\n  });\n\n  it('does not overlay a non-acceptance rubric', async () => {\n    let reads = 0;\n    const read = await readLiveAcceptanceCriteria(\n      { kind: 'standard', subjectPlan: null, criteria: [{ barKey: 'R-1' }] },\n      { readSubjectPlanContent: async () => { reads += 1; return null; }, parseRequirementBars: realParser },\n    );\n    expect(reads).toBe(0);\n    expect(read.status).toMatchObject({ source: 'stored-rubric', reason: 'not-a-plan-acceptance-rubric' });\n  });\n});\n"
    }
  ],
  "boundary": "Original live21746326, original345, clean six mutation legs and terminalP011 were not rerun. 38-test local suite passed with functional fix; the explicit Record annotation was added after that run started and changes TypeScript typing only. No final immutable source or loaded-runtime acceptance claimed. Parent 10 checks remain untouched. No active commands or locks.",
  "head": "16b035a0006673bbd46f2c0d0c46f6454cc0035b",
  "diff": "diff --git a/packages/operator-core/lib/acceptance-live-requirements.ts b/packages/operator-core/lib/acceptance-live-requirements.ts\nindex c76f9ec094..b614f1e55a 100644\n--- a/packages/operator-core/lib/acceptance-live-requirements.ts\n+++ b/packages/operator-core/lib/acceptance-live-requirements.ts\n@@ -137,7 +137,11 @@ const VERIFICATION_FIELDS = ['method', 'check', 'replication'] as const;\n \n /** A criterion's promise: its meaning projection with the whole check removed. */\n function promiseProjection(criterion: LiveVerificationFields): Record<string, unknown> {\n-  const { check: _check, ...promise } = verificationNeutralCriterion(criterion);\n+  const { check: _check, ...promise }: Record<string, unknown> = verificationNeutralCriterion(criterion);\n+  // Requirement headings consume their final period as Markdown syntax, while\n+  // stored rubric titles can retain it. Compare the same label in both forms\n+  // without changing the persisted title or accepting a different promise.\n+  if (typeof promise.title === 'string') promise.title = promise.title.trim().replace(/\\.$/, '');\n   return promise;\n }\n \ndiff --git a/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts b/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\nindex 31139982a0..97d83931f9 100644\n--- a/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n+++ b/packages/operator-core/lib/agent-tools/rubrics/acceptance-live-requirements.test.ts\n@@ -239,6 +239,42 @@ describe('readLiveAcceptanceCriteria (the acceptance read)', () => {\n     });\n   });\n \n+  it('overlays named cases when a stored title retains the heading terminal period', async () => {\n+    const seeded = parseRequirementBars(fixturePlan(requirementBlock()));\n+    if (!seeded.ok) throw new Error('fixture must parse');\n+    const storedCriteria = seeded.bars.map((bar) => ({\n+      ...bar.criterion!, barKey: bar.barKey, title: `${bar.title}.`,\n+    }));\n+    const block = JSON.parse(requirementBlock({ file: NEW_TEST }));\n+    const check = {\n+      kind: 'tests', files: [NEW_TEST],\n+      cases: [{ file: NEW_TEST, testName: 'the required named case' }],\n+    };\n+    block.verification.check = check;\n+    const edited = fixturePlan(JSON.stringify(block));\n+    const read = await readLiveAcceptanceCriteria(\n+      { kind: 'acceptance', subjectPlan: 'live-view-fixture', criteria: storedCriteria },\n+      { readSubjectPlanContent: async () => ({ content: edited }), parseRequirementBars: realParser },\n+    );\n+    expect(read.criteria[0]!.check).toEqual(check);\n+    expect(read.criteria[0]!.title).toBe('Live view.');\n+    expect(read.status).toMatchObject({ live: ['R-1'], changed: ['R-1'], kept: [] });\n+\n+    const renamed = await readLiveAcceptanceCriteria(\n+      { kind: 'acceptance', subjectPlan: 'live-view-fixture', criteria: storedCriteria },\n+      {\n+        readSubjectPlanContent: async () => ({\n+          content: edited.replace('**R-1 — Live view.**', '**R-1 — Changed view.**'),\n+        }),\n+        parseRequirementBars: realParser,\n+      },\n+    );\n+    expect(renamed.criteria[0]!.check).toEqual(storedCriteria[0]!.check);\n+    expect(renamed.status).toMatchObject({\n+      live: [], kept: [{ barKey: 'R-1', reason: 'meaning-changed' }],\n+    });\n+  });\n+\n   it('falls back to the stored criteria, naming why, when the subject plan cannot be read', async () => {\n     const criteria = [{ barKey: 'R-1', check: { kind: 'tests', files: [OLD_TEST] } }];\n     const unreadable = await readLiveAcceptanceCriteria(\n"
}
