---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire95-exact-failed-audit-and-own-delivery-424d5.json"
updated_at: 1792136012439
_body: "content"
---

{
  "kind": "fire95-exact-audit-and-own-delivery-reconciliation",
  "sourceArtifacts": [
    "audits/parked-agent-resumption-2026-10-09/fire94-activation5-and-overlay-aware-attestation-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/fire94-primary-before-condensation-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/fire83-seven-full-checkpoints-before-condensation-424d5.json"
  ],
  "boundary": {
    "audit": "FAILED; do not reemit until whole-plan evidence repaired",
    "r14": "no finalALLfix anchor, actual>=24h unstarted",
    "checks": "preserve12loop/6primary/2parent",
    "await": "already_done; no audit wait registered",
    "loopRepair": "unverified; same-loop retry only after terminal delivery, never a duplicate loop"
  },
  "receipts": [
    {
      "source": "/tmp/parked-fire95-audit-result.json",
      "sha256": "e96d49c327953b878d5a5db3abe01381ae055e1721126a52df81e94096732e9c",
      "body": {
        "scorecard": {
          "issueId": "EI-26119245090910872",
          "gradingAudit": {
            "state": "failed",
            "metaRubricRef": "grading-integrity",
            "stampedAt": "2026-10-16T07:14:12.923Z",
            "rubricRevision": 14,
            "criteriaHash": "795ad5a5aa77061bf0aeb54bd7c412307036cf576777ac42932b8afa8d6b4da9",
            "lastDispatchReservation": {
              "key": "grading-audit:EI-26119245090910872",
              "reservedAt": "2026-10-16T07:14:15.985Z"
            },
            "auditIssueId": "EI-26119973969501787",
            "auditor": "su-980e4bbc-98e9-4d0d-8b4e-0aa3b8c10cb1",
            "auditedAt": "2026-10-16T07:25:48.384Z"
          },
          "auditTarget": {
            "current": true,
            "superseded": false,
            "supersededBy": null,
            "retracted": false,
            "subjectRubricCurrentness": {
              "state": "current",
              "reason": "current",
              "recordedRevision": 7,
              "currentRevision": 7,
              "recordedCriteriaHash": "e562e568654b9c508282c21077859528809152bb87f05faca1fad6a5f5d70407",
              "currentCriteriaHash": "e562e568654b9c508282c21077859528809152bb87f05faca1fad6a5f5d70407"
            }
          }
        },
        "diagnostics": {
          "schemaVersion": "scorecards-get-diagnostics-v1",
          "correlationId": "96bce122-fa8c-4786-80f0-3ddec87cfe57",
          "handlerState": "completed",
          "handlerElapsedMs": 30,
          "omittedStages": 0,
          "stages": [
            {
              "stage": "scorecards-get-evidence-read",
              "elapsedMs": 25,
              "outcome": "fulfilled"
            },
            {
              "stage": "scorecards-get-rubric-read",
              "elapsedMs": 4,
              "outcome": "fulfilled"
            }
          ]
        },
        "evidenceRead": {
          "complete": false,
          "reason": "card-exceeds-inline-budget",
          "instruction": "Evidence has NOT been read. For a criterion-index page, follow evidenceRead.next until the full index is assembled; then read every indexed criterion and concatenate its pages before grading.",
          "criteria": [
            {
              "key": "outcomes-not-diff-restatements",
              "rating": "pass",
              "evidenceChars": 1186,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "outcomes-not-diff-restatements",
                  "evidenceOffset": 0
                }
              }
            },
            {
              "key": "traces-to-goal-or-decision",
              "rating": "pass",
              "evidenceChars": 1295,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "traces-to-goal-or-decision",
                  "evidenceOffset": 0
                }
              }
            },
            {
              "key": "falsifiable-with-evidence",
              "rating": "pass",
              "evidenceChars": 1653,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "falsifiable-with-evidence",
                  "evidenceOffset": 0
                }
              }
            },
            {
              "key": "failure-mode-coverage",
              "rating": "pass",
              "evidenceChars": 1300,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "failure-mode-coverage",
                  "evidenceOffset": 0
                }
              }
            },
            {
              "key": "non-overlapping",
              "rating": "pass",
              "evidenceChars": 1253,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "non-overlapping",
                  "evidenceOffset": 0
                }
              }
            },
            {
              "key": "prefer-structured-check",
              "rating": "pass",
              "evidenceChars": 1640,
              "read": {
                "tool": "scorecards:get",
                "args": {
                  "issueId": "EI-26119245090910872",
                  "criterionKey": "prefer-structured-check",
                  "evidenceOffset": 0
                }
              }
            }
          ],
          "scope": "criterion-index",
          "offset": 0,
          "totalCriteria": 6
        }
      }
    },
    {
      "source": "/tmp/parked-fire95-independent-audit-index.json",
      "sha256": "4285024c5afef8137312f8687fa21fb2415876eb98daf42f75b181f7a4b3a172",
      "body": {
        "scorecard": {
          "issueId": "EI-26119973969501787",
          "criteria": [
            {
              "key": "base-rate-check",
              "rating": "pass",
              "evidence": "Target EI-26119245090910872 has six applicable pass ratings and no fail/severe downgrade set. Re-ran every pass under the all-pass override. None is justified by a zero-act/no-trigger census: positive artifacts include rubrics:get on current and pinned revision 7 (14 criteria, hash e562e568654b9c508282c21077859528809152bb87f05faca1fad6a5f5d70407, deep-equal, plan version 65), plans:get D-018/D-020, conversations:get thread-post:1175843 and 1175766, capability:git-evidence at dd936d3a5a7824032f74e6fad1c59edf72e965ca, testing:runs 21144529/21144542, and work_items:get EI-25762038484804784. The symmetric absence-only rule is not triggered."
            },
            {
              "key": "instrument-split",
              "rating": "pass",
              "evidence": "Each stated measurement uses the appropriate store: rubric shape/currentness via rubrics:get; construction authority via plans:get decisions; independent critique/approval via conversations:get; committed source via capability:git-evidence; saved execution outcomes via testing:runs; repair lifecycle/completion via work_items:get; provisional-card history via scorecards:list. No MCP/native-activity or spend claim is inferred from the wrong ledger."
            },
            {
              "key": "terminal-re-rate",
              "rating": "pass",
              "evidence": "scorecards:list {rubricRef:'meta-acceptance-rubric',subjectRef:'acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09',provisional:true} returned count 0 and scorecards:[]. Therefore no provisional rating was frozen into the terminal card. The target's currentness probe also re-read current and immutable rubric revision 7 and found all 14 criteria deep-equal at plan version 65."
            },
            {
              "key": "platform-telemetry-excluded",
              "rating": "pass",
              "evidence": "None of the six target ratings measures agent efficiency or activity mix. Their complete evidence strings use rubric, plan, conversation, historical git blob, test-run, work-item, and scorecard-history reads; no raw tool_invocations count, dispatch-wrapper count, hook/wake/watchdog traffic, or agent_modes row is used as behavior evidence."
            },
            {
              "key": "re-runnable-evidence",
              "rating": "fail",
              "evidence": "All six complete criterion evidence strings were read and their stated probes were attempted. The exact current/pinned rubric, D-018/D-020, review posts, historical blob dd936d3a5a7824032f74e6fad1c59edf72e965ca, runs 21144529/21144542, and EI-25762038484804784 are resolvable. But several pass explanations do not supply probes sufficient to reproduce the criterion they rate: traces-to-goal-or-decision verifies 14 nonempty sourceRefs and only D-018/D-020, while plans:get reports 23 decisions and the meta-rubric requires the inverse gradeable-Decision coverage check; failure-mode-coverage cites only the R-3 file/runs/item and does not enumerate the subject plan's decision/risk failure surfaces; prefer-structured-check proves the repaired R-3 detector but asserts the other 13 bindings 'remain as independently reviewed' without exact selectors or per-binding detector-adequacy probes. rubrics:get proves binding existence, not that every bound detector can fail for its drift marker. scorecards:get with rerunRecipeOffset:0 returned rerun_recipe_not_found, so no complete stored recipe repairs these omitted checks. The all-pass card is therefore not independently re-runnable in full."
            },
            {
              "key": "degenerate-distribution",
              "rating": "fail",
              "evidence": "Persisted applicable histogram is {pass:6}; there are no waived/not-applicable ratings. Because this is uniform across six criteria, the rubric required re-running every applicable rating. That complete pass exposed the unreproducible inverse-decision, whole-plan failure-surface, and all-binding detector-adequacy gaps recorded under re-runnable-evidence. The uniform all-pass distribution therefore does not survive the mandated complete checks."
            }
          ],
          "nKeys": 6
        },
        "evidenceRead": {
          "complete": true
        }
      }
    },
    {
      "source": "/tmp/parked-fire95-exact-delivery.json",
      "sha256": "ee3e9f519c7dd49ba14c74280494b2a3e6520bae97de08c7af07282f227e947d",
      "body": {
        "mode": "query",
        "rowCount": 1,
        "truncated": false,
        "fields": [
          "id",
          "workspace_id",
          "status",
          "channel",
          "attempts",
          "last_error",
          "next_attempt_at",
          "created_at",
          "delivered_at",
          "turn_proof",
          "turn_started_at"
        ],
        "elapsedMs": 27,
        "rows": [
          {
            "id": "843866",
            "workspace_id": "default",
            "status": "parked",
            "channel": null,
            "attempts": 4,
            "last_error": "no recorded pid but presence is fresh — parking to avoid a concurrent resume of a live session",
            "next_attempt_at": "2026-10-16 07:27:45.728563+00",
            "created_at": "2026-10-16 07:24:04.679321+00",
            "delivered_at": null,
            "turn_proof": null,
            "turn_started_at": null
          }
        ]
      }
    },
    {
      "source": "/tmp/parked-fire95-owned-delivery-continuation.json",
      "sha256": "90fd0c9c5caf433d85660503254b7ceb1838b5485d6f89a5ce84bff43a7f9270",
      "body": {
        "ok": true,
        "summary": {
          "capture": {
            "ok": true,
            "_meta": {
              "explicitFullRequest": true,
              "format": "json",
              "_seeAlso": [
                {
                  "tool": "possibleDuplicates may be null when both lexical and semantic search were unavailable; that is no verdict, not a clean search. Read dedupCoverage before interpreting empty or missing matches."
                },
                {
                  "tool": "SYMPTOM-FIRST — improvements:capture { title, checkDuplicatesOnly:true } BEFORE you diagnose: \"has anyone already hit this?\" costs one call and a title, and creates nothing. Treat its title-only match list as incomplete; rerun with the final body before relying on it."
                },
                {
                  "tool": "improvements:digest (triage the backlog this lands in — but NEVER shows lane:\"observation\" rows; see below)"
                },
                {
                  "tool": "CLAIM + ATTRIBUTE: assign_to:\"self\" atomically claims non-observation filings. lane:\"observation\" records are non-claimable sensor readings and ignore assign_to; use a bug/change filing when you need to claim implementation work. observation.refs carries evidence attribution. Never pass createdBy / source / sourceRole / filedByRole — the server derives filer identity and role, and the strict schema rejects them."
                },
                {
                  "tool": "work_items:create (a problem in a MANAGED harness, not papercusp itself)"
                },
                {
                  "tool": "plans:new (something needing real design — capture kind=feature linking it)"
                },
                {
                  "tool": "VERIFY A CAPTURE LANDED (no separate improvements:list — reuse the existing readers): kind:bug/change/feature → the CREATE response already returned `issue.id`; re-check it with work_items:get { id }. lane:\"observation\" → these are EXCLUDED from improvements:digest and the default work_items:list by design (D-005), so use work_items:list { includeObservations:true, q:\"<title fragment>\" } instead."
                }
              ]
            }
          },
          "awaitReceipt": {
            "ok": true,
            "already_done": true,
            "event": "work-item:done:EI-26119245090910872",
            "item_state": "done",
            "advice": "EI-26119245090910872 is ALREADY settled (done) — \"work-item:done:EI-26119245090910872\" fired when it settled and will not fire again. Do not wait; proceed with the work this settle unblocks now.",
            "_meta": {
              "explicitFullRequest": true,
              "_seeAlso": [
                {
                  "tool": "events:catalog (what CAN I wait on? — the awaitable-key registry; check before polling)"
                },
                {
                  "tool": "deploy:await / work-item:await / … (named sugar for the common waits — build the key for you)"
                },
                {
                  "tool": "events:emit (the counterpart — fire the event a peer awaits)"
                },
                {
                  "tool": "events:cancel (retract a pending await)"
                },
                {
                  "tool": "watch:create (a standing watch instead of a one-shot await)"
                },
                {
                  "tool": "EI-14225/EI-14793: re-awaiting the SAME exact key — or re-registering the SAME composed `spec` — auto-retires your own prior pending registration on it (see `superseded` in the response), so a repeated idle-park loop never has to call events:cancel first."
                }
              ]
            }
          }
        },
        "logs": [],
        "dryRun": false,
        "dispatchCount": 2,
        "dispatchTimings": {
          "calls": [
            {
              "ordinal": 0,
              "tool": "improvements:capture",
              "effect": "write",
              "elapsedMs": 769,
              "disposition": "settled",
              "callId": "f4jinm-2t3"
            },
            {
              "ordinal": 1,
              "tool": "events:await",
              "effect": "write",
              "elapsedMs": 72,
              "disposition": "settled",
              "callId": "f4jinm-2t4"
            }
          ],
          "totalCount": 2,
          "omittedCount": 0,
          "maxCalls": 24
        },
        "intermediateBytes": 2748,
        "runtimeObservations": {
          "authorizationObservationCount": 2,
          "authorityWideningDetected": false,
          "midTurnPromptInjectionObservability": "not-observable"
        },
        "childFailures": [],
        "partial": false,
        "mutations": {
          "count": 2,
          "byTool": {
            "improvements:capture": 1,
            "events:await": 1
          },
          "attemptedCount": 2,
          "settledPrefixCount": 2,
          "dispositions": {
            "settled": [
              0,
              1
            ]
          },
          "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
        }
      }
    },
    {
      "source": "/tmp/parked-fire95-reconcile-checkpoints.json",
      "sha256": "50de4dc94122a48597ba47b6c52219682b8195734381c67dc1ac47a826ea60b0",
      "body": {
        "ok": true,
        "summary": {
          "ok": true,
          "results": [
            {
              "ok": true,
              "id": "WI-6554700010008887",
              "harness": "papercusp",
              "cleared": false,
              "length": 8445,
              "contentHash": "b0b8b24ce3a1",
              "captureAdvisory": "this note yields residue, touchedFiles to a future claim-time brief; rootCauses — name it with \"root cause:\" or \"originates at\" so a later claimant inherits the WHY, not just the what; falsePremises — mark a corrected belief with \"false premise\", \"was wrong\" or \"retracted\" so it cannot be re-derived",
              "verified": true,
              "storedHead": "## Did\nFire94 re-read complete substantive source conversations (codex01a12344 t",
              "checks": 6,
              "by": "su-424d5476-0b13-401a-a926-0aaa9f212391",
              "rowsMode": "merge"
            },
            {
              "ok": true,
              "id": "WI-10008164",
              "harness": "papercusp",
              "cleared": false,
              "length": 8172,
              "contentHash": "e89310f7d4a2",
              "captureAdvisory": "this note yields residue to a future claim-time brief; rootCauses — name it with \"root cause:\" or \"originates at\" so a later claimant inherits the WHY, not just the what; falsePremises — mark a corrected belief with \"false premise\", \"was wrong\" or \"retracted\" so it cannot be re-derived",
              "verified": true,
              "storedHead": "## Did\n[turn:01a1430f@2026-10-16T04:54:47.029Z] Fire83 kept R14 open. BEFORE con",
              "checks": 0,
              "by": "su-424d5476-0b13-401a-a926-0aaa9f212391",
              "rowsMode": "merge"
            }
          ],
          "counts": {
            "ok": 2,
            "failed": 0
          },
          "_meta": {
            "explicitFullRequest": true,
            "format": "json"
          }
        },
        "logs": [],
        "dryRun": false,
        "dispatchCount": 1,
        "dispatchTimings": {
          "calls": [
            {
              "ordinal": 0,
              "tool": "work_items:checkpoint",
              "effect": "write",
              "elapsedMs": 384,
              "disposition": "settled",
              "callId": "f4jinm-2n6"
            }
          ],
          "totalCount": 1,
          "omittedCount": 0,
          "maxCalls": 24
        },
        "intermediateBytes": 1373,
        "runtimeObservations": {
          "authorizationObservationCount": 1,
          "authorityWideningDetected": false,
          "midTurnPromptInjectionObservability": "not-observable"
        },
        "childFailures": [],
        "partial": false,
        "mutations": {
          "count": 1,
          "byTool": {
            "work_items:checkpoint": 1
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
      }
    },
    {
      "source": "/tmp/parked-fire95-failed-audit-check.json",
      "sha256": "d1e6efdda6016cf8b301c5a9a57ca93c65698b8a5553ce1b4038068ca639d017",
      "body": {
        "ok": true,
        "summary": {
          "ok": true,
          "results": [
            {
              "ok": true,
              "id": "WI-6554700010008887",
              "harness": "papercusp",
              "cleared": false,
              "length": 10546,
              "contentHash": "cca57eef8d7d",
              "captureAdvisory": "this note yields falsePremises, residue, touchedFiles to a future claim-time brief; rootCauses — name it with \"root cause:\" or \"originates at\" so a later claimant inherits the WHY, not just the what",
              "verified": true,
              "storedHead": "## Did\nFire94 re-read complete substantive source conversations (codex01a12344 t",
              "checks": 6,
              "by": "su-424d5476-0b13-401a-a926-0aaa9f212391",
              "provenanceLint": {
                "flagged": true,
                "note": "provenance_lint: this carry-surface write contains an owner-attributed directive and/or a claimed COMPLETED action (e.g. \"posted evidence to WI-####\", \"messaged the fleet leader su-…\") with no verifiable turn ref. Anchor each to the turn where it ACTUALLY happened with [turn:<session>@<iso-ts>] (the system verifies it against your own transcript and stamps owner-vs-agent origin — P-014). For the turn you are writing FROM, write the sentinel [turn:self] and the platform expands it to the real ref at write time… [truncated 505 chars] …ARRATES an action (\"I did X\") is only valid AFTER X's tool call returned ok in the SAME turn — a specific artifact id (post/msg/WI ref) is NOT proof it happened (they can be fabricated, EI-18226077402946717), so a downstream reader must independently verify it, never trust it as evidence-of-action. Non-owner sources still tag [self-imposed] · [peer:<sid>] · [inferred]. Verify a remembered directive or action via sessions:search { session:'self', mode:'verbatim' }. See WI-3532 / EI-9091 / EI-18226077402946717.",
                "matches": [
                  {
                    "line": "Full exact independent audit EI-26119973969501787 read: six criteria total; rerunnable-evidence and degenerate-distribution FAIL. The current/pinned14criteria, two decisions, reviews, R3 blob/runs/ite",
                    "kind": "bare-gate-imperative"
                  }
                ]
              },
              "retainedProvenance": {
                "flagged": true,
                "note": "provenance_lint: this carry-surface write contains an owner-attributed directive and/or a claimed COMPLETED action (e.g. \"posted evidence to WI-####\", \"messaged the fleet leader su-…\") with no verifiable turn ref. Anchor each to the turn where it ACTUALLY happened with [turn:<session>@<iso-ts>] (the system verifies it against your own transcript and stamps owner-vs-agent origin — P-014). For the turn you are writing FROM, write the sentinel [turn:self] and the platform expands it to the real ref at write time… [truncated 505 chars] …ARRATES an action (\"I did X\") is only valid AFTER X's tool call returned ok in the SAME turn — a specific artifact id (post/msg/WI ref) is NOT proof it happened (they can be fabricated, EI-18226077402946717), so a downstream reader must independently verify it, never trust it as evidence-of-action. Non-owner sources still tag [self-imposed] · [peer:<sid>] · [inferred]. Verify a remembered directive or action via sessions:search { session:'self', mode:'verbatim' }. See WI-3532 / EI-9091 / EI-18226077402946717.",
                "matches": [
                  {
                    "line": "- ? [#fire89-vetting-audit-dispatched] Corrected overlay-aware card EI-26119245090910872 FAILED independent audit EI-26119973969501787; omitted whole-plan inverse/failure-surface/all-binding probes pr",
                    "kind": "unverified-action-claim"
                  }
                ]
              },
              "turnProvenance": {
                "writtenDuring": {
                  "ref": "[turn:01a14395@2026-10-16T07:20:55.909Z]",
                  "verdict": "agent-injected",
                  "origin": "self-compaction"
                }
              },
              "rowsMode": "merge"
            }
          ],
          "counts": {
            "ok": 1,
            "failed": 0
          },
          "_meta": {
            "explicitFullRequest": true,
            "format": "json"
          }
        },
        "logs": [],
        "dryRun": false,
        "dispatchCount": 1,
        "dispatchTimings": {
          "calls": [
            {
              "ordinal": 0,
              "tool": "work_items:checkpoint",
              "effect": "write",
              "elapsedMs": 5277,
              "disposition": "settled",
              "callId": "10xeea-3g"
            }
          ],
          "totalCount": 1,
          "omittedCount": 0,
          "maxCalls": 24
        },
        "intermediateBytes": 4486,
        "runtimeObservations": {
          "authorizationObservationCount": 1,
          "authorityWideningDetected": false,
          "midTurnPromptInjectionObservability": "not-observable"
        },
        "childFailures": [],
        "partial": false,
        "mutations": {
          "count": 1,
          "byTool": {
            "work_items:checkpoint": 1
          },
          "attemptedCount": 1,
          "settledPrefixCount": 1,
          "dispositions": {
            "settled": [
              0
            ]
          },
          "note": "count includes only write calls that settled successfully before code:run returned; disposition indexes are zero-based dispatch order and in_flight calls require verification before retry"
        },
        "summaryNotice": {
          "truncated": true,
          "originalChars": 4460,
          "returnedChars": 3500,
          "arraysTruncated": 0,
          "arrayOriginalLengths": {},
          "stringsTruncated": 2,
          "valuesTruncated": 2,
          "omittedItems": 960,
          "paths": [
            "summary.results[0].provenanceLint.note",
            "summary.results[0].provenanceLint.matches[0]",
            "summary.results[0].retainedProvenance.note",
            "summary.results[0].retainedProvenance.matches[0]"
          ],
          "note": "code:run summary was bounded before transport; scalar marker fields are preserved where possible and nested arrays/strings are explicitly truncated",
          "rawSummaryCursor": {
            "status": "volatile-fallback",
            "tool": "capability:read",
            "args": {
              "uri": "papercusp://scratch-memory/74a02682-63ef-48e4-94b5-a168da8725df",
              "byte_offset": 0,
              "byte_limit": 3072
            },
            "bodyOffsetInPayload": 0,
            "byteCount": 4486,
            "sha256": "bb06ec78ed6435fb6f6db3d6c22079f436bf1ca5d54870c88bc48c0e360a3e2a",
            "expiresAt": "2026-10-16T07:37:38.096Z",
            "note": "The exact bytes are in a short-lived in-memory fallback; read them with capability:read before expiresAt and follow next_cursor."
          }
        }
      }
    }
  ]
}
