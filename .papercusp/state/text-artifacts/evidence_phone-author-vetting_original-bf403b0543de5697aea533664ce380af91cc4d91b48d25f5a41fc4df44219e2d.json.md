---
rel_path: "evidence/phone-author-vetting/original-bf403b0543de5697aea533664ce380af91cc4d91b48d25f5a41fc4df44219e2d.json"
updated_at: 1790924242322
_body: "content"
---

{
  "schemaVersion": "phone-author-vetting-evidence/v1",
  "status": "preserved-scope; author regrade incomplete",
  "capturedAt": "2026-10-02T05:54:00Z",
  "workItem": "WI-10004893",
  "originalAuthorCard": "EI-24824140551577989",
  "failedIndependentAudit": {
    "issueId": "EI-24839276600757131",
    "createdAt": "2026-10-02T04:09:40.131Z",
    "createdBy": "system:judge/su-d35cc159-4598-4ebf-baa5-5ed166d2ea45",
    "rubricRef": "grading-integrity",
    "rubricRevision": 10,
    "criteriaHash": "ebcc5c8c7861dd56211f08abcbbe9a30ea6db2272d6f2e816f507c1434a7d7a1",
    "evidenceFingerprint": "b836e8e1b186436678119c80a2b443e313d4b3e0fe619e1809e15681dc824a22",
    "sourceHive": "papercusp",
    "subject": {
      "ref": "EI-24824140551577989",
      "kind": "scorecard"
    },
    "criteria": [
      {
        "key": "base-rate-check",
        "rating": "fail",
        "evidence": "The graded card has one downgrade, prefer-structured-check=weak. Its evidence names a forward remediation ('repair as-built bindings and finish targeted detectors') but gives no stored-scope probe showing those bindings/detectors were achievable in the graded run, no exact P002/P003 file paths, and no satisfiability/base-rate result. Several passes also rest on absence claims without covering compliance artifacts: outcomes says 'None is discharged by a diff alone' and falsifiable says 'no missing ... gaps', while citing selected R2/R39/R84/R86 examples rather than a complete criterion census over the preserved revision."
      },
      {
        "key": "instrument-split",
        "rating": "fail",
        "evidence": "The claims are primarily proved from consult thread posts rather than the authoritative stores they measure. outcomes, falsifiable, failure-mode-coverage, and non-overlapping cite thread-post:1153815/1153837/1153920 instead of a reproducible rubrics:get read of the exact subject revision; traces cites one plan decision while asserting complete canonical sourceRefs/mappings; prefer-structured-check cites thread-post:1154455 while making file/assertion and binding claims. Re-running scorecards:get confirms these are the persisted evidence strings, so the source mismatch is in the terminal card itself."
      },
      {
        "key": "terminal-re-rate",
        "rating": "pass",
        "evidence": "scorecards:list for rubricRef meta-acceptance-rubric, sourceHive papercusp, and subjectRef acceptance-phone-public-telephone-service-2026-10-01 returned exactly one card, EI-24824140551577989. There is no preceding interim scorecard whose violatable ratings could have been copied forward; this card is terminal."
      },
      {
        "key": "platform-telemetry-excluded",
        "rating": "pass",
        "evidence": "All six graded criteria concern acceptance-rubric content, plan decisions, consult review, or test bindings. None cites tool_invocations, native-tool activity, spend, efficiency, activity mix, hooks, wake pumps, watchdog probes, or dispatch-wrapper counts, so platform-emitted telemetry is not used in any verdict."
      },
      {
        "key": "re-runnable-evidence",
        "rating": "fail",
        "evidence": "D-004 rerun set: downgrade prefer-structured-check plus sampled non-downgrades traces-to-goal-or-decision and non-overlapping. prefer-structured-check names portal/tests/four-surface.e2e.test.tsx but no source SHA/snapshot, line/assertion, command, or exact preserved-scope retrieval; its evidenceRef is only thread-post:1154455. traces names a session turn, D003-D008, and 'Current snapshot complete:true/problems:[]' but supplies no tool call/args or exact subject-revision mapping output. non-overlapping gives four illustrative pairs and thread-post:1153920 but no exact rubric retrieval or exhaustive pairwise probe. A non-author cannot execute any of these probes verbatim against evidence fingerprint 22eaefc4a2a8c50a64dcbb85341d3cd401f5c3af9e22ae7994199c8e98e5c6fd without guessing or substituting the newer tree."
      },
      {
        "key": "degenerate-distribution",
        "rating": "unknown",
        "evidence": "Persisted applicable histogram is pass=5, weak=1, so five criteria share one rating and the rubric requires corroborating spot re-runs. The mandated rerun set was prefer-structured-check, traces-to-goal-or-decision, and non-overlapping. Those probes are not independently executable from the evidence strings, as detailed under re-runnable-evidence; therefore the near-uniform five-pass cluster cannot be corroborated or contradicted from the preserved evidence scope. It is not honest to call the distribution non-degenerate merely because one weak rating breaks full uniformity."
      }
    ],
    "nKeys": 6,
    "missingKeys": [],
    "extraKeys": [],
    "rubricResolved": true,
    "synthesized": false,
    "auditTarget": {
      "current": true,
      "superseded": false,
      "supersededBy": null,
      "retracted": false,
      "subjectRubricCurrentness": null
    }
  },
  "canonicalReads": {
    "subject": {
      "tool": "rubrics:get",
      "args": {
        "rubricRef": "acceptance-phone-public-telephone-service-2026-10-01",
        "revision": 4,
        "detail": "full",
        "payloadTier": "full"
      }
    },
    "method": {
      "tool": "rubrics:get",
      "args": {
        "rubricRef": "meta-acceptance-rubric",
        "revision": 5,
        "detail": "full",
        "payloadTier": "full"
      },
      "criteriaHash": "215de0837eaed307004dd8a9dfcf2cff9caaa47b9ee19e3f11bb2c5390a19614"
    },
    "decisions": {
      "tool": "plans:get",
      "args": {
        "slug": "phone-public-telephone-service-2026-10-01",
        "harness": "papercusp",
        "heading": "Decisions",
        "mode": "full",
        "includeEnrichments": false,
        "includeHistory": false
      },
      "version": 21,
      "contentHash": "7477ae57f696280234517dcd89c67560da76066e6a33f822e68ae8a1c4156b37"
    }
  },
  "subjectRubric": {
    "rubricId": "acceptance-phone-public-telephone-service-2026-10-01",
    "revision": 4,
    "workspaceId": "papercusp-workspace",
    "kind": "acceptance",
    "subjectPlan": "phone-public-telephone-service-2026-10-01",
    "subjectHarnessSlug": "papercusp",
    "classRef": "plan-class-feature-ship",
    "barSetHash": "8c6902b0dec73a51021126e86e2f73c848c9d350b36471e0c192b9909e1c1ef1",
    "barContract": {
      "schemaVersion": 1,
      "adoptionEpoch": 1,
      "cohort": "post-epoch",
      "subjectPlanRevision": 20,
      "seededAt": "2026-10-01T19:28:40.699Z",
      "seededBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9",
      "meaningRevision": 2
    },
    "characteristic": "plan-acceptance",
    "title": "Acceptance BAR — Phone public telephone service — real numbers, calling and verified public readiness",
    "description": "Predeclared acceptance BARs for phone-public-telephone-service-2026-10-01.",
    "criteria": [
      {
        "key": "r-1",
        "title": "Public service contract and launch decisions",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "The approved release contract identifies launch countries, customers, supported incoming/outgoing call journeys, emergency obligations, paid-service budget and source/deployment ownership before paid provisioning or public exposure.",
        "bar": "The approved release contract identifies launch countries, customers, supported incoming/outgoing call journeys, emergency obligations, paid-service budget and source/deployment ownership before paid provisioning or public exposure.",
        "barKey": "R-1",
        "barHash": "ada11b45bd7aae02cd3c355a7d62aeb4ac932620cb69cb378aafd2756bea9761",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Review the retained owner decisions, provider capabilities and dated source/runtime inventory; compare each promised user journey with its implementation and evidence route.",
        "driftMarkers": "A required choice is silently assumed, the old browser-only shipment is treated as PSTN proof, or service is represented as primary-phone replacement without an approved emergency/compliance route.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-2",
        "title": "Secure reachable media — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A signed-in user at app.papercusp.com exchanges bidirectional audio with the self-hosted media plane from an external network, including a UDP-blocked network using TURN/TLS.",
        "bar": "A signed-in user at app.papercusp.com exchanges bidirectional audio with the self-hosted media plane from an external network, including a UDP-blocked network using TURN/TLS.",
        "barKey": "R-2",
        "barHash": "ef6efaf040acb773dbee28f842f1b6cfb9d5f67e16677f1efd3adaa71a7d2080",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run authenticated remote-browser real-microphone calls on home broadband and cellular, then with UDP blocked; retain ICE-selected transport, WSS origin, peer audio receipt and lifecycle evidence.",
        "driftMarkers": "One-way/no audio, an insecure or loopback browser endpoint, failed certificate renewal, or dependence on LAN/hairpin connectivity.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-3",
        "title": "Numbers and carrier routing — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A provisioning operation through the approved carrier account creates a durable number record for the authorized tenant.",
        "bar": "A provisioning operation through the approved carrier account creates a durable number record for the authorized tenant.",
        "barKey": "R-3",
        "barHash": "455fe46ae5e11ac4d1b5ad990a804416e78d2ee7bda3a17ea2c4d5af40162c1c",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-4",
        "title": "Incoming telephone calls — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An ordinary-phone incoming call reaches the assistant selected by the tenant policy.",
        "bar": "An ordinary-phone incoming call reaches the assistant selected by the tenant policy.",
        "barKey": "R-4",
        "barHash": "8868ae52bf73d3568ee59f2500912d42d2dab8a25f6c868d19fcd65bd5417ee6",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-5",
        "title": "Outgoing telephone calls — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An authorized outbound request dials its supported E.164 destination using the correct verified caller ID.",
        "bar": "An authorized outbound request dials its supported E.164 destination using the correct verified caller ID.",
        "barKey": "R-5",
        "barHash": "2a4edbf04847e98f4e514873c061a044bdc8e5c8d52580bfc487ebdd713afed1",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-6",
        "title": "Tenant and caller authority — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone number record is scoped to its authorized tenant.",
        "bar": "A Phone number record is scoped to its authorized tenant.",
        "barKey": "R-6",
        "barHash": "6d0ab5eb492d3bb6e36d54a6d0439902dc238e864a9ae5f2c76c5cde64574a8b",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-7",
        "title": "Voicemail, privacy and consent — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A persisted voicemail or transcript remains complete after service restart.",
        "bar": "A persisted voicemail or transcript remains complete after service restart.",
        "barKey": "R-7",
        "barHash": "a40d95d71b55edd5387e8bf8efff05ef268f22f96fdf9c08cfad9fd0a19f7143",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-8",
        "title": "Reliable assistant conversation — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A real PSTN conversation provides intelligible two-way audio.",
        "bar": "A real PSTN conversation provides intelligible two-way audio.",
        "barKey": "R-8",
        "barHash": "378cae19db14a93e157a96bd2458e51d2d93f01918643ab84fd3dba8437a54b4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
        "driftMarkers": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-9",
        "title": "Usage controls and economics — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound call requires an active tenant entitlement before dialing.",
        "bar": "An outbound call requires an active tenant entitlement before dialing.",
        "barKey": "R-9",
        "barHash": "41543b641736c08e39061343427367eac5a3c8aa4659208f9e3604b62caa86f4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-10",
        "title": "Operational readiness — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "The pinned deployment satisfies the approved capacity objective.",
        "bar": "The pinned deployment satisfies the approved capacity objective.",
        "barKey": "R-10",
        "barHash": "d6cba31911327448da2d12244c1fc7bd6bed590f7cbcac3d835ff60cff7003f7",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-11",
        "title": "Verified public release — outcome 1",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An independent acceptance review passes each mandatory requirement.",
        "bar": "An independent acceptance review passes each mandatory requirement.",
        "barKey": "R-11",
        "barHash": "bdbcd714005052c788de571a41d25735dbfd69f60a6d4e6868e671ebcfb7b43f",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-12",
        "title": "Automated regression protection across the calling contract — outcome 1",
        "intent": {
          "request": "Ship the approved public telephone service with real project-suite regression protection as well as actual public-phone/provider evidence.",
          "rationale": "Separate the original automated unit/integration/e2e promise from manual external-provider/live-phone verification; neither obligation substitutes for the other.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5",
            "session_turn:codex:01a0f7b1-b53e-71f2-b1d3-01818dcd94c3:11"
          ]
        },
        "model": "Each new or changed call, media, number, authorization, privacy, usage or recovery behavior implementing the mandatory Phone outcomes has registered unit, integration and e2e tests covering persistence, replay, restart and cross-tenant adversarial cases.",
        "bar": "Each new or changed call, media, number, authorization, privacy, usage or recovery behavior implementing the mandatory Phone outcomes has registered unit, integration and e2e tests covering persistence, replay, restart and cross-tenant adversarial cases.",
        "barKey": "R-12",
        "barHash": "93614a34990c3abdbb0114db1c8b27a70b332e73e1b4db47a9ccfac9019b3867",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "R-10",
          "R-11",
          "R-13",
          "R-14",
          "R-15",
          "R-16",
          "R-17",
          "R-18",
          "R-19",
          "R-2",
          "R-20",
          "R-21",
          "R-22",
          "R-23",
          "R-24",
          "R-25",
          "R-26",
          "R-27",
          "R-28",
          "R-29",
          "R-3",
          "R-30",
          "R-31",
          "R-32",
          "R-33",
          "R-34",
          "R-35",
          "R-36",
          "R-37",
          "R-38",
          "R-39",
          "R-4",
          "R-40",
          "R-41",
          "R-42",
          "R-43",
          "R-44",
          "R-45",
          "R-46",
          "R-47",
          "R-48",
          "R-49",
          "R-5",
          "R-50",
          "R-51",
          "R-52",
          "R-53",
          "R-54",
          "R-55",
          "R-56",
          "R-57",
          "R-58",
          "R-59",
          "R-6",
          "R-60",
          "R-61",
          "R-62",
          "R-63",
          "R-64",
          "R-65",
          "R-66",
          "R-67",
          "R-68",
          "R-69",
          "R-7",
          "R-70",
          "R-71",
          "R-72",
          "R-73",
          "R-75",
          "R-76",
          "R-77",
          "R-78",
          "R-79",
          "R-8",
          "R-80",
          "R-81",
          "R-82",
          "R-83",
          "R-84",
          "R-85",
          "R-86",
          "R-87",
          "R-9",
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "e2e",
          "integration",
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend the existing sidecar/data contract, worker integration and portal e2e suites to cover each new phone behavior; add conventional framework tests when the current suites do not fit, updating this check to those real paths before binding proof. Run the exact resulting suite and current-source evidence; enumerate coverage per behavior/R-N and retain failures/skips. Inspect test bodies to ensure the named unit/integration/e2e files actually prove the new behavior; old baseline tests alone do not pass this BAR.",
        "driftMarkers": "A changed required behavior has no recurrence test at its required depth, only typechecks or implementation-mirroring assertions are cited, a suite is red/skipped/unregistered, or mock/synthetic test evidence is used to claim real telephone/public-host readiness.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts",
            ".papercusp/apps/phone-app/worker/src/phone-voice-contract-adapter.integration.test.ts",
            ".papercusp/apps/portal/tests/four-surface.e2e.test.tsx"
          ]
        }
      },
      {
        "key": "r-13",
        "title": "Secure reachable media — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-2; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A public client receives only publicly reachable secure media endpoints.",
        "bar": "A public client receives only publicly reachable secure media endpoints.",
        "barKey": "R-13",
        "barHash": "5061cf05bb8410e557558c62b7b2ee9f6c2e393f2647c96b42c14577baca5b01",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run authenticated remote-browser real-microphone calls on home broadband and cellular, then with UDP blocked; retain ICE-selected transport, WSS origin, peer audio receipt and lifecycle evidence.",
        "driftMarkers": "One-way/no audio, an insecure or loopback browser endpoint, failed certificate renewal, or dependence on LAN/hairpin connectivity.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-14",
        "title": "Numbers and carrier routing — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A carrier binding operation assigns a number only to its authorized tenant.",
        "bar": "A carrier binding operation assigns a number only to its authorized tenant.",
        "barKey": "R-14",
        "barHash": "2e9ba12a9e6616cf71deff08acf76313d0c7c966f1609012d2a8efe22840e850",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-15",
        "title": "Numbers and carrier routing — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A suspended number rejects further call routing.",
        "bar": "A suspended number rejects further call routing.",
        "barKey": "R-15",
        "barHash": "c0844e5f95221674d520b167c95999bf80886008374b1fe12d02216832194c6b",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-16",
        "title": "Numbers and carrier routing — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A released number loses its prior tenant binding.",
        "bar": "A released number loses its prior tenant binding.",
        "barKey": "R-16",
        "barHash": "b3b3597fad0d4fcf3d331dbdd54c93701129001791ef51a0918c0d26e75f15ee",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-17",
        "title": "Numbers and carrier routing — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An inbound trunk routes according to the durable number record.",
        "bar": "An inbound trunk routes according to the durable number record.",
        "barKey": "R-17",
        "barHash": "83e026848f6f3efb3e92be6b2bf2641921cc032139d66b9d45365a513285d504",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-18",
        "title": "Numbers and carrier routing — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound trunk routes according to the durable number record.",
        "bar": "An outbound trunk routes according to the durable number record.",
        "barKey": "R-18",
        "barHash": "fbeee90dd67178b7dd046c23a278f9def58de1f6167dbd263c8eadbee5915146",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-19",
        "title": "Numbers and carrier routing — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A dispatch rule selects the assistant identified by the durable number record.",
        "bar": "A dispatch rule selects the assistant identified by the durable number record.",
        "barKey": "R-19",
        "barHash": "40a1826f0bc695321839513ce22e453974478ac00653506e36fde5dae67b11e4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-20",
        "title": "Numbers and carrier routing — outcome 8",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound caller ID matches the verified identity in the durable number record.",
        "bar": "An outbound caller ID matches the verified identity in the durable number record.",
        "barKey": "R-20",
        "barHash": "c4cdbc080e72f03e828c8725e256045a0cd0e3350014172656d55d1430564231",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-21",
        "title": "Numbers and carrier routing — outcome 9",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-3; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A portability operation follows the approved workflow recorded for the number.",
        "bar": "A portability operation follows the approved workflow recorded for the number.",
        "barKey": "R-21",
        "barHash": "cc46ec2a3f165a299818b9d64b0255c2db6a857337912437ef152a98f5a8e745",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-22",
        "title": "Incoming telephone calls — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An incoming call rings the owner when tenant policy requires it.",
        "bar": "An incoming call rings the owner when tenant policy requires it.",
        "barKey": "R-22",
        "barHash": "9a867b4cc0bcf0e1641c4280655959bfbeeca42bb1bd3594157acaaa41dcf0ea",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-23",
        "title": "Incoming telephone calls — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An incoming call follows the configured screening decision.",
        "bar": "An incoming call follows the configured screening decision.",
        "barKey": "R-23",
        "barHash": "d201b2b28690aa249d6cc68eafb371b08789b36e091eaf7bcb88f589c35737d0",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-24",
        "title": "Incoming telephone calls — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An authorized browser pickup connects the owner to the incoming telephone call.",
        "bar": "An authorized browser pickup connects the owner to the incoming telephone call.",
        "barKey": "R-24",
        "barHash": "3e632737a06e688d87ab02a4f0e6b66cebefb98f7597b51c571055ef54cde531",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-25",
        "title": "Incoming telephone calls — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An approved telephone handoff connects the incoming call to its configured destination.",
        "bar": "An approved telephone handoff connects the incoming call to its configured destination.",
        "barKey": "R-25",
        "barHash": "9b02e4897e8df01b099ec52b4cd21f8794dd00ed676ccdf4e480b95573777ae7",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-26",
        "title": "Incoming telephone calls — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A busy incoming call follows the configured busy handling policy.",
        "bar": "A busy incoming call follows the configured busy handling policy.",
        "barKey": "R-26",
        "barHash": "7c18eba968398625742ea54226fa8ee44719eae6f7c897c1e7bf280b84e58882",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-27",
        "title": "Incoming telephone calls — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An unanswered incoming call follows the configured no-answer handling policy.",
        "bar": "An unanswered incoming call follows the configured no-answer handling policy.",
        "barKey": "R-27",
        "barHash": "d9906898e39edf4836dd0986e73ff0df9bdb9d2f6338495b71289b144505d09c",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-28",
        "title": "Incoming telephone calls — outcome 8",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An incoming call routed to voicemail leaves a retrievable tenant-owned message.",
        "bar": "An incoming call routed to voicemail leaves a retrievable tenant-owned message.",
        "barKey": "R-28",
        "barHash": "89fee0eb1b54f72a7859eaa6c2012cf4ddfd973e9caca614fac60460d65dbf13",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-29",
        "title": "Incoming telephone calls — outcome 9",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-4; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A call-history entry records the observed incoming-call outcome.",
        "bar": "A call-history entry records the observed incoming-call outcome.",
        "barKey": "R-29",
        "barHash": "24ec17c93925b21375e80bf7e0cfaeb87411d27c9ecc0985e64ad8fed0e91004",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
        "driftMarkers": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-30",
        "title": "Outgoing telephone calls — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound ringing event produces the corresponding ringing state.",
        "bar": "An outbound ringing event produces the corresponding ringing state.",
        "barKey": "R-30",
        "barHash": "9d2134ac2be24a1b44be6b4c43556104286c2dfd8cbd16d68f8b73e17b71a4a1",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-31",
        "title": "Outgoing telephone calls — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound answer event produces the corresponding connected state.",
        "bar": "An outbound answer event produces the corresponding connected state.",
        "barKey": "R-31",
        "barHash": "f455c7a9550d0173f060317e0f3d56807ea0ca950290b667b4d49781a20c0532",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-32",
        "title": "Outgoing telephone calls — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound busy event produces the corresponding busy outcome.",
        "bar": "An outbound busy event produces the corresponding busy outcome.",
        "barKey": "R-32",
        "barHash": "046094289c5923f3be4a32d59bba13636cac1026ab54d9653533d35e3f8a0d28",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-33",
        "title": "Outgoing telephone calls — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound rejection event produces the corresponding rejected outcome.",
        "bar": "An outbound rejection event produces the corresponding rejected outcome.",
        "barKey": "R-33",
        "barHash": "09c775e5d10afe5e62d402ac206c55fdfd3e48f352dc6ff28884b216b4bc56b1",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-34",
        "title": "Outgoing telephone calls — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound no-answer event produces the corresponding no-answer outcome.",
        "bar": "An outbound no-answer event produces the corresponding no-answer outcome.",
        "barKey": "R-34",
        "barHash": "c01b73bcb26934de39249b326ad4ce1305695e18f13da649444a6ca8cc9bc1d2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-35",
        "title": "Outgoing telephone calls — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A DTMF input reaches the connected telephone peer.",
        "bar": "A DTMF input reaches the connected telephone peer.",
        "barKey": "R-35",
        "barHash": "9d5dd77e616a5ba2fd2d42e8db8bbf99c77badc787360be769e4700f22b050df",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-36",
        "title": "Outgoing telephone calls — outcome 8",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An approved outbound transfer connects the intended destination.",
        "bar": "An approved outbound transfer connects the intended destination.",
        "barKey": "R-36",
        "barHash": "5ead913b71729809245d5219cd555f43d5e8d237dcf44abd06fb251cff268f48",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-37",
        "title": "Outgoing telephone calls — outcome 9",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound cancellation terminates the dialing attempt.",
        "bar": "An outbound cancellation terminates the dialing attempt.",
        "barKey": "R-37",
        "barHash": "b3d62b677d33b2d8b393c32876302aaa6b81eaf16682a7b5e9e5ace03e1459a0",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-38",
        "title": "Outgoing telephone calls — outcome 10",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A permitted scheduled call begins only at its authorized scheduled time.",
        "bar": "A permitted scheduled call begins only at its authorized scheduled time.",
        "barKey": "R-38",
        "barHash": "05537bfae2db89e709c3c02051898ec0bc9e49b2e7ad73e1dc21442ad82232c5",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-39",
        "title": "Outgoing telephone calls — outcome 11",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A replayed outbound request does not create a duplicate dialing attempt.",
        "bar": "A replayed outbound request does not create a duplicate dialing attempt.",
        "barKey": "R-39",
        "barHash": "44bfe5fa41d390c10a26b5a8bc8cd80b0c7f695c7760a39d907c3f14c0aeca47",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-40",
        "title": "Outgoing telephone calls — outcome 12",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-5; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound call cannot incur spend outside its authorized budget.",
        "bar": "An outbound call cannot incur spend outside its authorized budget.",
        "barKey": "R-40",
        "barHash": "d4d9c9101b0fb943af9c397ccba3bacde0fc61aa5acc206297e605a3a5c2d026",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
        "driftMarkers": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-41",
        "title": "Tenant and caller authority — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-6; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Caller ID cannot confer owner authority or private agent-tool access.",
        "bar": "Caller ID cannot confer owner authority or private agent-tool access.",
        "barKey": "R-41",
        "barHash": "2ab686c46e0d409b90d54d534fedcea0a1aa349821fdb827f01da60e5f5096bf",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-42",
        "title": "Voicemail, privacy and consent — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A recording or transcription action requires the consent specified by the approved policy.",
        "bar": "A recording or transcription action requires the consent specified by the approved policy.",
        "barKey": "R-42",
        "barHash": "c1378f5787920b7475a7dfd09ff18fbd71699313aaab96a6bb939bc90eb7d6b2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-43",
        "title": "Voicemail, privacy and consent — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Stored call content expires according to the approved retention policy.",
        "bar": "Stored call content expires according to the approved retention policy.",
        "barKey": "R-43",
        "barHash": "d0fbf359a4366e6c7910fcd9c1bed295f546bc4ed4a2ef086ff6609ebb9d56a4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-44",
        "title": "Voicemail, privacy and consent — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An authorized export returns only the tenant's permitted call content.",
        "bar": "An authorized export returns only the tenant's permitted call content.",
        "barKey": "R-44",
        "barHash": "813803dcded8b50f1f8ca152828fe97374845fb372ac2cbdb90aac44e37b02dd",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-45",
        "title": "Voicemail, privacy and consent — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An authorized deletion removes the call content required by the approved deletion policy.",
        "bar": "An authorized deletion removes the call content required by the approved deletion policy.",
        "barKey": "R-45",
        "barHash": "6e78134bfe5e3a2054a2df8137e53254078423a381156229c16ac1b8ea23fbd3",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-46",
        "title": "Voicemail, privacy and consent — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A call-content notification follows the approved notification policy.",
        "bar": "A call-content notification follows the approved notification policy.",
        "barKey": "R-46",
        "barHash": "18e661028f7673f6d27be397188541f3cac39cf76fab5b5765651fb81afb169e",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-47",
        "title": "Voicemail, privacy and consent — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-7; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Consent-sensitive audio storage remains disabled until explicitly enabled.",
        "bar": "Consent-sensitive audio storage remains disabled until explicitly enabled.",
        "barKey": "R-47",
        "barHash": "484f7fd11ca46b2f641009c521e6ac1dd33801a73498406a35e95ed508c08e4e",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-48",
        "title": "Reliable assistant conversation — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-8; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A caller interruption follows the approved safe barge-in policy.",
        "bar": "A caller interruption follows the approved safe barge-in policy.",
        "barKey": "R-48",
        "barHash": "cbd2b9bd8c96193324372b0b9fe2707ba763c468829dfff52023712ed7ad6f2f",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
        "driftMarkers": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-49",
        "title": "Reliable assistant conversation — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-8; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A PSTN call retains its authenticated worker identity throughout the conversation.",
        "bar": "A PSTN call retains its authenticated worker identity throughout the conversation.",
        "barKey": "R-49",
        "barHash": "bf872fd840590b70cc5ec6e2b07d0bf9931ced997933e3e98f2581eef6308069",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
        "driftMarkers": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-50",
        "title": "Reliable assistant conversation — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-8; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Measured PSTN response latency satisfies the approved latency target.",
        "bar": "Measured PSTN response latency satisfies the approved latency target.",
        "barKey": "R-50",
        "barHash": "108ba7822dd4fe880af98b9fe59749cef834398f9ea88c2623f60329e40538be",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
        "driftMarkers": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-51",
        "title": "Reliable assistant conversation — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-8; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A provider failure, overload event or worker restart routes the call to an understandable fallback or voicemail.",
        "bar": "A provider failure, overload event or worker restart routes the call to an understandable fallback or voicemail.",
        "barKey": "R-51",
        "barHash": "418ee4b27e7856f5bf197dd4c53438fd5b5d2f2b4fe90415ea7027932cf3403e",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
        "driftMarkers": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-52",
        "title": "Usage controls and economics — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound call requires an allowed destination before dialing.",
        "bar": "An outbound call requires an allowed destination before dialing.",
        "barKey": "R-52",
        "barHash": "4e3b074a8abab9d82e6645670ad10db274e8f60053f74c5905e1db5cca017bb5",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-53",
        "title": "Usage controls and economics — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound call exceeding the approved rate limit is rejected before dialing.",
        "bar": "An outbound call exceeding the approved rate limit is rejected before dialing.",
        "barKey": "R-53",
        "barHash": "af24aa7a3d449525455fc7d9effe73bfa543b7406c1a04c548009dcba0c4edfc",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-54",
        "title": "Usage controls and economics — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An outbound call exceeding the approved concurrency limit is rejected before dialing.",
        "bar": "An outbound call exceeding the approved concurrency limit is rejected before dialing.",
        "barKey": "R-54",
        "barHash": "9f0a29a22e976b8cfd5bd4240aa729b5c07b839ba47784389193bcf88c812574",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-55",
        "title": "Usage controls and economics — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A call cannot continue beyond its approved duration limit.",
        "bar": "A call cannot continue beyond its approved duration limit.",
        "barKey": "R-55",
        "barHash": "7a56687c393438c9cc3b1ae139d8659903e4ec68cc40b59bc8d523e9e0c65b82",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-56",
        "title": "Usage controls and economics — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A call cannot incur charges beyond its tenant's hard spend cap.",
        "bar": "A call cannot incur charges beyond its tenant's hard spend cap.",
        "barKey": "R-56",
        "barHash": "ded1ee01ef6035823e66aeb3090c431cb040b0af89c9ebe10d87da1a4b136006",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-57",
        "title": "Usage controls and economics — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Each phone-minute, AI, media or number charge is attributable to its authorized tenant.",
        "bar": "Each phone-minute, AI, media or number charge is attributable to its authorized tenant.",
        "barKey": "R-57",
        "barHash": "c253d86b88b18d3e408140dcc284a0d03ebf33f5077defaab2cc8c46937c8dcb",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-58",
        "title": "Usage controls and economics — outcome 8",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "The retained usage ledger reconciles with the provider's charge records.",
        "bar": "The retained usage ledger reconciles with the provider's charge records.",
        "barKey": "R-58",
        "barHash": "c873f17774ffa6292af9795fbba5ead6ee59c80a69f0c8f06a6ea64fed9f318c",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-59",
        "title": "Usage controls and economics — outcome 9",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-9; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A replayed provider charge event cannot produce duplicate billing.",
        "bar": "A replayed provider charge event cannot produce duplicate billing.",
        "barKey": "R-59",
        "barHash": "005f61a885cfa735e598a3947623e4948fc9cb3ebcec42c46acb96ce6034a862",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
        "driftMarkers": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-60",
        "title": "Operational readiness — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A recovery drill meets the approved recovery objective.",
        "bar": "A recovery drill meets the approved recovery objective.",
        "barKey": "R-60",
        "barHash": "1d7b48b92441d0d777f99b7e4a6c2a2eebdff3fdf5ce421baad2969c2da11f41",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-61",
        "title": "Operational readiness — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A clean build reproduces the pinned release artifact.",
        "bar": "A clean build reproduces the pinned release artifact.",
        "barKey": "R-61",
        "barHash": "51a3b655845d2cc866989dc3170cfe4778f6d019c418abe2adfa07c4a422d335",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-62",
        "title": "Operational readiness — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Certificate renewal completes automatically before certificate expiry.",
        "bar": "Certificate renewal completes automatically before certificate expiry.",
        "barKey": "R-62",
        "barHash": "9f96286e05118f6ef9766f7f95ceeda10c551d39f544cadb3fd51048cf37f704",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-63",
        "title": "Operational readiness — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A backup restores the required service data in an isolated recovery drill.",
        "bar": "A backup restores the required service data in an isolated recovery drill.",
        "barKey": "R-63",
        "barHash": "2e18ce7d8be229edaff3f2944ddec469cdac2274bc0f868c3f650c3d5c16ac68",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-64",
        "title": "Operational readiness — outcome 6",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Secret rotation preserves the approved credential access boundary.",
        "bar": "Secret rotation preserves the approved credential access boundary.",
        "barKey": "R-64",
        "barHash": "936748dc5b1ebebeecc36afcdee178eb670974aab0a1b1178954197d82c63595",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-65",
        "title": "Operational readiness — outcome 7",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A health signal reflects the service's observed health state.",
        "bar": "A health signal reflects the service's observed health state.",
        "barKey": "R-65",
        "barHash": "7dccb13e4f966683de2149785096b0c71854aa2b641ac51abc3a512dca7781fb",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-66",
        "title": "Operational readiness — outcome 8",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A readiness signal reflects the service's observed ability to accept traffic.",
        "bar": "A readiness signal reflects the service's observed ability to accept traffic.",
        "barKey": "R-66",
        "barHash": "815aeaf010b62e2bc405857c4a810344dd83746b19e6568f4a14a8befbdf4dca",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-67",
        "title": "Operational readiness — outcome 9",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An injected service fault produces an actionable alert.",
        "bar": "An injected service fault produces an actionable alert.",
        "barKey": "R-67",
        "barHash": "ba186fbe2fabb389da8e44b7b5658348ac6fbbd558535d1c75c3a5981443d7bf",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-68",
        "title": "Operational readiness — outcome 10",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "An injected service failure reaches its configured bounded fallback outcome.",
        "bar": "An injected service failure reaches its configured bounded fallback outcome.",
        "barKey": "R-68",
        "barHash": "f15257d2496bd76e11b9721596ba35cf8ef377e7e274cea8264597ea42f0babf",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-69",
        "title": "Operational readiness — outcome 11",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-10; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A rollback drill restores the previous verified service artifact.",
        "bar": "A rollback drill restores the previous verified service artifact.",
        "barKey": "R-69",
        "barHash": "90849d624a5932c252beb8677683176013cfdac3920457796f57b16ee1b52b6b",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-70",
        "title": "Verified public release — outcome 2",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-11; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "The shipment record identifies the exact public app, sidecar, worker and media/SIP configuration.",
        "bar": "The shipment record identifies the exact public app, sidecar, worker and media/SIP configuration.",
        "barKey": "R-70",
        "barHash": "2097bd712ee7fbfdca36b098a473cad1a886f22e86e0800401e5f0754b3993f2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-71",
        "title": "Verified public release — outcome 3",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-11; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A real public-host PSTN smoke test passes on the exact shipment artifact.",
        "bar": "A real public-host PSTN smoke test passes on the exact shipment artifact.",
        "barKey": "R-71",
        "barHash": "7a32b9d522dc750adaeb965f9ff1d6548052af9ffd17794392a86c18fe918c70",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-72",
        "title": "Verified public release — outcome 4",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-11; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A bounded invited pilot meets its declared acceptance criteria.",
        "bar": "A bounded invited pilot meets its declared acceptance criteria.",
        "barKey": "R-72",
        "barHash": "1bb2cd638462af92fc7bd0c72442bc5743076d32ed93ceddd1f5a7975d5e3cdd",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-73",
        "title": "Verified public release — outcome 5",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Atomic refinement of R-11; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "General signup remains closed until the required invited pilot passes.",
        "bar": "General signup remains closed until the required invited pilot passes.",
        "barKey": "R-73",
        "barHash": "69187469d3e8911d35538951c8f12db5d7713b270266281ae1e25d92a66ceb51",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-74",
        "title": "Automated regression protection across the calling contract — outcome 2",
        "intent": {
          "request": "Ship the approved public telephone service with real project-suite regression protection as well as actual public-phone/provider evidence.",
          "rationale": "Separate the original automated unit/integration/e2e promise from manual external-provider/live-phone verification; neither obligation substitutes for the other. Atomic refinement of R-12; no new owner provenance is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5",
            "session_turn:codex:01a0f7b1-b53e-71f2-b1d3-01818dcd94c3:11"
          ]
        },
        "model": "The full required test suite passes on the current implementing source.",
        "bar": "The full required test suite passes on the current implementing source.",
        "barKey": "R-74",
        "barHash": "b0703a290015487407d6c850507c3ce619da32d18e6ffa87ae67609e416bdaae",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "R-10",
          "R-11",
          "R-13",
          "R-14",
          "R-15",
          "R-16",
          "R-17",
          "R-18",
          "R-19",
          "R-2",
          "R-20",
          "R-21",
          "R-22",
          "R-23",
          "R-24",
          "R-25",
          "R-26",
          "R-27",
          "R-28",
          "R-29",
          "R-3",
          "R-30",
          "R-31",
          "R-32",
          "R-33",
          "R-34",
          "R-35",
          "R-36",
          "R-37",
          "R-38",
          "R-39",
          "R-4",
          "R-40",
          "R-41",
          "R-42",
          "R-43",
          "R-44",
          "R-45",
          "R-46",
          "R-47",
          "R-48",
          "R-49",
          "R-5",
          "R-50",
          "R-51",
          "R-52",
          "R-53",
          "R-54",
          "R-55",
          "R-56",
          "R-57",
          "R-58",
          "R-59",
          "R-6",
          "R-60",
          "R-61",
          "R-62",
          "R-63",
          "R-64",
          "R-65",
          "R-66",
          "R-67",
          "R-68",
          "R-69",
          "R-7",
          "R-70",
          "R-71",
          "R-72",
          "R-73",
          "R-75",
          "R-76",
          "R-77",
          "R-78",
          "R-79",
          "R-8",
          "R-80",
          "R-81",
          "R-82",
          "R-83",
          "R-84",
          "R-85",
          "R-86",
          "R-87",
          "R-9",
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "e2e",
          "integration",
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend the existing sidecar/data contract, worker integration and portal e2e suites to cover each new phone behavior; add conventional framework tests when the current suites do not fit, updating this check to those real paths before binding proof. Run the exact resulting suite and current-source evidence; enumerate coverage per behavior/R-N and retain failures/skips. Inspect test bodies to ensure the named unit/integration/e2e files actually prove the new behavior; old baseline tests alone do not pass this BAR.",
        "driftMarkers": "A changed required behavior has no recurrence test at its required depth, only typechecks or implementation-mirroring assertions are cited, a suite is red/skipped/unregistered, or mock/synthetic test evidence is used to claim real telephone/public-host readiness.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts",
            ".papercusp/apps/phone-app/worker/src/phone-voice-contract-adapter.integration.test.ts",
            ".papercusp/apps/portal/tests/four-surface.e2e.test.tsx"
          ]
        }
      },
      {
        "key": "r-75",
        "title": "Tenant and caller authority — explicit atomic guarantee 75",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone call record is scoped to the tenant that owns the call.",
        "bar": "A Phone call record is scoped to the tenant that owns the call.",
        "barKey": "R-75",
        "barHash": "1555b5e53e6206567a41db2ff5881545dce1b7e41825d0a9783900e4ef02bf4c",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-76",
        "title": "Tenant and caller authority — explicit atomic guarantee 76",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone recording is scoped to the tenant that owns its call.",
        "bar": "A Phone recording is scoped to the tenant that owns its call.",
        "barKey": "R-76",
        "barHash": "2dfc340c2fc4533d7588dd8305e9a427cea9931c70147ac66d646f59c7708412",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-77",
        "title": "Tenant and caller authority — explicit atomic guarantee 77",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone transcript is scoped to the tenant that owns its call.",
        "bar": "A Phone transcript is scoped to the tenant that owns its call.",
        "barKey": "R-77",
        "barHash": "03b9fe6d9b1a9b32cf7b01417193a445e910e7fb093caac6e7cf198b40eee429",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-78",
        "title": "Tenant and caller authority — explicit atomic guarantee 78",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone provider callback is scoped to the tenant identified by its authenticated call binding.",
        "bar": "A Phone provider callback is scoped to the tenant identified by its authenticated call binding.",
        "barKey": "R-78",
        "barHash": "b6d6dc6a1d7e1593b9a27ae52a3a91c82bae364c1d8cbf4fcd16f53d52e3cd5b",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-79",
        "title": "Tenant and caller authority — explicit atomic guarantee 79",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone worker context is scoped to the tenant identified by its authenticated call binding.",
        "bar": "A Phone worker context is scoped to the tenant identified by its authenticated call binding.",
        "barKey": "R-79",
        "barHash": "000b6950ff8dd1401cdab39fb8e41613ebaeb9fe4f89726e8cbcc9853fd86ee4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-80",
        "title": "Tenant and caller authority — explicit atomic guarantee 80",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A Phone call grant is scoped to its authorized tenant.",
        "bar": "A Phone call grant is scoped to its authorized tenant.",
        "barKey": "R-80",
        "barHash": "bffa613bc0efa797005795572ff04144361fb11e1070152d59e34dbd96f0d025",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-81",
        "title": "Tenant and caller authority — explicit atomic guarantee 81",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Speech content cannot confer owner authority or private agent-tool access.",
        "bar": "Speech content cannot confer owner authority or private agent-tool access.",
        "barKey": "R-81",
        "barHash": "304e726882095f636060199df7d57bd5f9f48ab7a866df3f08ddb9f4b64f9724",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-82",
        "title": "Tenant and caller authority — explicit atomic guarantee 82",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A room label cannot confer owner authority or private agent-tool access.",
        "bar": "A room label cannot confer owner authority or private agent-tool access.",
        "barKey": "R-82",
        "barHash": "21b48bb9ae1875d7710e3a87572207312057ac2762b4f5449620979e25624bc5",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-83",
        "title": "Tenant and caller authority — explicit atomic guarantee 83",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A browser-supplied field cannot confer owner authority or private agent-tool access.",
        "bar": "A browser-supplied field cannot confer owner authority or private agent-tool access.",
        "barKey": "R-83",
        "barHash": "e7699163663a3c5faf35de9a2d36f083d9c910de7ac869d7613703f2fb470b13",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
        "driftMarkers": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-84",
        "title": "Voicemail, privacy and consent — explicit atomic guarantee 84",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A persisted voicemail or transcript remains tenant scoped after service restart.",
        "bar": "A persisted voicemail or transcript remains tenant scoped after service restart.",
        "barKey": "R-84",
        "barHash": "f1cc17cfe3bae2c1abee05674c9ad47d02694b7feb345e2581ad3b9c1d11899c",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "tree"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "unit"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
        "driftMarkers": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
        "check": {
          "kind": "tests",
          "files": [
            ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
            ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
          ]
        }
      },
      {
        "key": "r-85",
        "title": "Numbers and carrier routing — explicit atomic guarantee 85",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A carrier number lifecycle operation requires the approved carrier account.",
        "bar": "A carrier number lifecycle operation requires the approved carrier account.",
        "barKey": "R-85",
        "barHash": "8625b317c575e51fbbe585886607d928bd9b2fb415c11734f9d86c68f8e4e575",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
        "driftMarkers": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-86",
        "title": "Verified public release — explicit atomic guarantee 86",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "Real external phone/provider acceptance remains separately mandatory for each live Phone BAR.",
        "bar": "Real external phone/provider acceptance remains separately mandatory for each live Phone BAR.",
        "barKey": "R-86",
        "barHash": "e7a43dc6411d6f353c36d8250c6c25f631a1a73c89e2cdb4ea4535fda03fe5e3",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
        "driftMarkers": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      },
      {
        "key": "r-87",
        "title": "Operational readiness — explicit atomic guarantee 87",
        "intent": {
          "request": "Make the existing Phone app ready to be a finished public telephone service.",
          "rationale": "Derived implementation and acceptance detail for Avi's planning request; this block does not claim separate owner approval. Explicit restoration from independent review thread-post:1153815; no separate owner turn is claimed.",
          "sourceRefs": [
            "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
          ]
        },
        "model": "A secret rotation completes without interrupting ongoing service.",
        "bar": "A secret rotation completes without interrupting ongoing service.",
        "barKey": "R-87",
        "barHash": "cc60eb307e771922fecb13e2ba456fc24ea1ee3c2f50a8680b3372cd9e328cfa",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "live"
        ],
        "evidencePlane": "live",
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-01T15:09:29.696Z",
          "declaredBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9"
        },
        "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
        "driftMarkers": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "none"
        }
      }
    ],
    "ratingScale": [
      "healthy",
      "degraded",
      "broken",
      "unknown"
    ],
    "criteriaHash": "f208eb77d15410f7b9868dc34e877a308ab2ed381b8a3805266ab445861b67cc",
    "methodRef": null,
    "gradingAuthority": "independent",
    "status": "active",
    "createdBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9",
    "proposedBy": "su-e6db372d-b1df-498d-9873-2b2bee8968e9",
    "ratifiedBy": null,
    "createdAt": "2026-10-01",
    "updatedAt": "2026-10-02T00:27:36.095Z"
  },
  "metaCriteria": [
    {
      "key": "outcomes-not-diff-restatements",
      "title": "Criteria state OUTCOMES, not diff restatements",
      "model": "An acceptance criterion describes an observable OUTCOME the shipped work must produce (a behavior, a state, a guarantee) — a definition-of-done a non-implementer could verify without reading the diff. A criterion that restates what was edited (\"function X added\", \"file Y updated\") is satisfied by construction the moment the diff exists, so it gates nothing.",
      "method": "For each criterion ask: could this rating be produced by reading the DIFF alone, without running or observing the system? If yes, it is a diff restatement — rewrite it as the outcome the change exists to cause. rubrics:get the acceptance rubric and scan every criterion; one restatement is a finding, a majority is a fail.",
      "driftMarkers": "Criteria naming files/functions/commits instead of behavior; criteria trivially true once the code merges; a rubric whose criteria map 1:1 onto the change-list bullets.",
      "replication": "REPLICATION DRILL: draft two criteria for the same change — (a) \"plan-start-consult.ts now calls selectResponders\" (diff restatement), (b) \"plans:start on a below-floor plan surfaces a labeled best-available candidate instead of proceeding silently\" (outcome). Grading a rubric containing (a) must rate this criterion fail/weak and name (a); grading one containing only (b)-shaped criteria must pass. Control: if both fixtures rate the same, the grader is not applying the criterion.",
      "instrumentKey": "none"
    },
    {
      "key": "traces-to-goal-or-decision",
      "title": "Every criterion traces to the plan goal or a recorded Decision",
      "model": "Acceptance criteria derive authority from the subject plan's stated goal or its recorded Decisions (D-NNN). An untraceable criterion imports scope nobody agreed to; a ruled Decision with no covering criterion silently drops contract. The rubric must measure the plan's contract, not the author's taste.",
      "method": "plans:get the subject plan (goal + Decisions) and rubrics:get the acceptance rubric. For each criterion, name the goal clause or Decision id it enforces — no nameable source is a finding. Then invert: for each Decision with gradeable consequences (semantics, flags, guarantees), find its covering criterion — an uncovered one is a finding.",
      "driftMarkers": "Criteria citing nothing; a Decision with explicit ruled consequences absent from the rubric; a criterion contradicting a Decision.",
      "replication": "REPLICATION DRILL: fixture a subject plan with goal G and three Decisions; add the criterion \"code is well-commented\" (traces to neither) to an otherwise-traceable rubric. Grading must flag exactly that criterion as untraceable. Control: a criterion quoting a Decision's ruled semantics must not be flagged.",
      "instrumentKey": "none"
    },
    {
      "key": "falsifiable-with-evidence",
      "title": "Falsifiable — a concrete observation could fail each criterion",
      "model": "A criterion is only a gate if concrete evidence could rate it broken: a named probe, query, test, or observable behavior. \"Quality is high\" cannot fail; \"the below-floor branch records no_live_responder (probe: plans:start against an all-dead fixture)\" can. Unfalsifiable criteria decorate the rubric and inflate pass rates.",
      "method": "For each criterion ask: what SPECIFIC observation would force a fail rating? If none can be named, the criterion is decorative — a finding. Prefer criteria that name their probe inline; check graded evidence strings cite observations rather than restating the criterion.",
      "driftMarkers": "Adjective criteria (robust/clean/proper) with no probe; criteria that could never rate anything but pass; scorecard evidence that paraphrases the criterion instead of citing an observation.",
      "replication": "REPLICATION DRILL: fixture a rubric with (a) \"the feature is reliable\" (no probe) and (b) \"consult expiry advances the cascade within one sweep tick (probe: the expiry-core cascade test)\". Grading must fail (a) and pass (b); a grade passing both is a broken application of this criterion.",
      "instrumentKey": "none"
    },
    {
      "key": "failure-mode-coverage",
      "title": "Failure/regression modes covered, not just the happy path",
      "model": "A definition-of-done that only describes success verifies the demo, not the ship: regressions live in error paths, races, degraded instruments, and behavior REMOVED or changed. The subject plan's known failure surfaces — error branches, concurrency rulings, degrade paths named in its Decisions — must appear as criteria where gradeable.",
      "method": "List the subject plan's failure surfaces from its Decisions and risk notes (raced/CAS semantics, degrade verdicts, caps/floors/guards). Check each gradeable one is covered by some criterion. A rubric that is 100% happy-path is a finding on THIS criterion even when every individual criterion passes the others.",
      "driftMarkers": "No criterion touching an error/degraded/raced path; regression-prone semantics (caps, floors, guards) unrepresented; \"tests pass\" standing in as the only failure coverage.",
      "replication": "REPLICATION DRILL: fixture a plan whose Decision rules a CAS/raced-advance semantics, with an acceptance rubric of five well-formed happy-path criteria and none touching the raced path. Grading must rate this criterion fail/weak despite the criteria individually passing the other meta-criteria.",
      "instrumentKey": "none"
    },
    {
      "key": "non-overlapping",
      "title": "Criteria are non-overlapping — each grades a distinct outcome",
      "model": "Overlapping criteria double-count one outcome: agreement inflates, and one defect either fails several criteria at once or passes all because each grader assumed another criterion owned it. Each criterion owns a distinct outcome; jointly they partition the plan's contract.",
      "method": "Pairwise scan: for each pair of criteria, name an observation that would fail one but not the other. If none exists, the pair overlaps — merge them. Reused verbatim evidence across criteria on a graded scorecard is the post-hoc symptom.",
      "driftMarkers": "Two criteria that always co-rate; a criterion that is a strict special case of another; identical evidence strings across criteria.",
      "replication": "REPLICATION DRILL: fixture a rubric containing \"min/max selection works end-to-end\" and \"below-floor selection selects at least one candidate\" (a strict special case). Grading must flag the pair as overlapping and propose the merge.",
      "instrumentKey": "none"
    },
    {
      "key": "prefer-structured-check",
      "title": "Structured check preferred wherever the outcome is objectively checkable (D-006)",
      "model": "Per plan Decision D-006: a criterion whose outcome is objectively checkable should carry a structured check binding — kind:'tests' { files } (must-pass, actually RUN at grading time) or kind:'instrument' (instrumentKey) — rather than prose-only judgment. A binding makes the rating machine-contradictable: a 'healthy' rating a failing run contradicts is detectable. Fuzzy judgment criteria remain legitimate exactly where the outcome is not objectively checkable.",
      "method": "For each criterion ask: does a test file or instrument already exist (or did the subject plan ship one) that decides this outcome? If yes and the criterion is prose-only, the rubric under-binds — a finding naming the bindable file/instrument. For check-carrying criteria, verify the referenced paths still resolve against the live tree.\n\nDETECTION BINDING, not merely PATH BINDING: for every criterion carrying check:{kind:'tests'}, take its model and driftMarkers literally and name the specific assertion, fixture, mutation control, or exercised branch in a BOUND file that would fail if the named drift occurred. A path that resolves and a test that runs green are necessary but not sufficient; if none of the bound assertions can go red for the criterion's own falsifier, grade this meta-criterion weak/fail and call the acceptance criterion under-bound. Grepping bound files for identifiers named in model/driftMarkers is a cheap triage signal, never the verdict: a behavioral assertion can bind without naming the symbol, so read the test before ruling. For negative/removal criteria, require a positive control in the same bound check proving the subject module/mechanism still exists and the relevant surrounding behavior operates; otherwise a renamed, gutted, deleted, or entirely failed mechanism can make the negative assertion pass vacuously.",
      "driftMarkers": "A plan that shipped tests whose acceptance rubric binds none of them; check paths that no longer resolve; instrument-decidable outcomes graded by prose.\n\nBound paths resolve and all tests pass, but no named assertion/fixture/branch would fail for the criterion's own drift marker; every bound file has zero references to the named mechanism and no behavioral proxy exercises it; disabling or throwing the whole mechanism leaves the criterion green; a negative-only assertion also passes when its subject is renamed, gutted, or deleted; scorecard evidence cites only filenames/pass counts rather than the detector that makes the rating falsifiable.",
      "replication": "REPLICATION DRILL: fixture a plan that shipped foo.test.ts deciding criterion C's outcome, with C prose-only in the rubric. Grading must rate this criterion weak/fail and name foo.test.ts as the bindable check. Control: the same rubric with C carrying check:{kind:'tests',files:['foo.test.ts']} must pass.\n\nREPLICATION DRILL — DETECTOR ADEQUACY: fixture an acceptance criterion with drift marker 'MemorySwapMax=0 returns as the worker default' and check:{kind:'tests',files:['managed-spawn-payload-env.test.ts']}; make that file resolve and pass but contain no assertion or fixture exercising the swap default. Grading MUST rate prefer-structured-check weak/fail and name the missing detector even though the path is valid and green. Control: bind a test that constructs the worker default and asserts swap='allow'; grading MUST pass. VACUOUS-NEGATIVE CONTROL: fixture `expect(source).not.toMatch(/removedExport/)` alone, then delete/gut the source; it must NOT pass detector adequacy until the same check positively proves the module and a surviving behavior exist. If path resolution alone or the negative-only check earns pass, this meta-criterion is being applied incorrectly.",
      "instrumentKey": "none"
    }
  ],
  "planDecisions": "### D-001 — Draft authority and inherited foundations\n\nDate: 2026-10-01\nAgent-authored planning decision grounded in Avi's request session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5: author this public-telephony sequel as draft only, retain the shipped browser-alpha history, and extend the existing template-materialized Phone app. Preserve the prior owner-approved self-host choice in phone-app-2026-08-30#D-002. Avi subsequently enabled AUTO mode: route self was selected for planning without a route ask. The country, spending, carrier, service/emergency contract and public launch still require real decisions/inputs; the prose and proposed thresholds are not their approval.\nRelated: P-001\n\n### D-002 — Approval and acceptance dependency rationale\n\nDate: 2026-10-01\nAgent-authored topology rationale: P-001 is deliberately an independent initial human choice, not an acceptance step that needs implementation first. Foundational items depend on it because multi-tenant scope, market, source ownership and cost policy change their design; read-only preparation remains allowed. P-004 requires owner/provider inputs because it creates paid real-world number obligations. P-006 really depends on P-010/P-011 because recipient consent, authorized destinations and spend caps must precede live outbound dialing. P-014 is the independent pre-pilot acceptance gate and therefore follows P-013 evidence. P-013 intentionally aggregates the eight call/voice/data/policy/usage/operations lanes: those suites run incrementally within their items, and this item exercises the integrated cross-lane scenario matrix. The long critical path and zero executable frontier while the initial owner gate is open are intentional for this unapproved draft; do not weaken required gates to improve a width metric.\nRelated: P-001, P-003, P-004, P-006, P-010, P-011, P-013, P-014\n\n\n### D-003 — Owner go-ahead supersedes planning-only approval gates\n\nDate: 2026-10-01\n[owner:Avi session_turn:codex:01a0f7b1-b53e-71f2-b1d3-01818dcd94c3:11] Verbatim: \"okay put yourself on auto mode and carry this plan to shipped status\". AUTO was re-registered with the end-to-end scope; route self and the tracked continuation loop are selected. This is approval to implement and ship the plan, so the older draft-only boundary and routine execution/route re-confirmation are superseded. Use the disclosed proposed US/English AI-assisted-number target for implementation, with no unverified primary-phone/emergency claims. P-001 becomes an actionable source/input inventory; P-014 becomes an evidence-driven independent acceptance task under the existing shipment authority. P-004 remains a real account/payment/number input gate; hard spending ceilings and actual secure credential references were requested, and provider/legal/emergency facts must be verified before public/live calling. Reassign those missing launch facts to their actual gate items, instead of pretending the entire software foundation needs an unanswered permission. This changes authorization and sequencing, not any mandatory R-N outcome or acceptance target.\nRelated: P-001, P-004, P-010, P-011, P-014\n\n\n### D-004 — Source inventory is independent of released-code readiness\n\nDate: 2026-10-01\nDuring activation, the old staging-first guard read P-001's deployment-ownership inventory as a release-plane wait and refused P-003/P-010/P-012. WI-10004900 now contains the durable source correction and thirteen regression cases: metadata and independent media preparation are allowed, while real main/deployed-host/checkpoint/final prerequisites still refuse. Guard tests64/64 and audit-tool tests58/58 pass (ledger20403680,20403681). P-001 now says runtime owners and P-002 explicitly says media-plane preparation on current builds to make their independent source-work meaning unambiguous on the older serving runtime as well; no actual prerequisite or acceptance bar was removed. The current public tool runtime does not yet contain the corrected guard; keep the fix's code publication distinct from any gate/deploy claim.\nRelated: P-001, P-003, P-010, P-012\n\n\n### D-005 — Separate automated suite proof from real external-phone proof\n\nDate: 2026-10-01\nActivation validation exposed a draft representation error: an explicitly manual instrument:none check cannot simultaneously declare automated test layers; the data/API filenames are classified unit despite the data contract's Postgres arm. Keep manual real-phone/provider outcomes under their original mandatory live R-N conditions, and add mandatory R-12 for the original automated unit/integration/e2e requirement across every changed R-2 through R-11 behavior. R-6/R-7/R-9 keep their unit checks, with integration/e2e depth also required by R-12. Existing real integration and e2e paths seed the check; they must be extended and replaced with additional real framework paths when implementation requires it. This is a correction to proof representation, not permission to satisfy real telephony with mocks or to omit automated recurrence protection.\nRelated: P-013, P-014\n\n### D-006 — Acceptance BAR amendment\nDate: 2026-10-01\nAmendment-Id: amend-74e6da9f19ba1b1e54f3fd04\nRequest-Hash: f9cc8554164c42ec706e13fef6a345aa40c52c7131adcfa7fe2a06e6d7a56422\nActor: su-e6db372d-b1df-498d-9873-2b2bee8968e9\nReason: Restore every explicit guarantee named in independent objection thread-post:1153815 while making the original Phone promises atomic: enumerated tenant resources/inputs, tenant scope after restart, approved carrier authority, complete regression scope, mandatory real external provider evidence, uninterrupted rotation and bounded fallback; retain original source refs, methods, falsifiers, evidence planes, test depths and hard pilot/spend/legal gates.\nApproved-By: system:judge/su-a8f83a52-f41a-4149-ba97-5ab08394478d\nApproval-Ref: thread-post:1153920\nApproved-At: 2026-10-01T18:38:51.170Z\nRubric revision: 1 → 2\nSubject plan revision: 9 → 10\nChanged BARs: R-2, R-3, R-4, R-5, R-6, R-7, R-8, R-9, R-10, R-11, R-12, R-13, R-14, R-15, R-16, R-17, R-18, R-19, R-20, R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32, R-33, R-34, R-35, R-36, R-37, R-38, R-39, R-40, R-41, R-42, R-43, R-44, R-45, R-46, R-47, R-48, R-49, R-50, R-51, R-52, R-53, R-54, R-55, R-56, R-57, R-58, R-59, R-60, R-61, R-62, R-63, R-64, R-65, R-66, R-67, R-68, R-69, R-70, R-71, R-72, R-73, R-74, R-75, R-76, R-77, R-78, R-79, R-80, R-81, R-82, R-83, R-84, R-85, R-86, R-87\nPrior evidence, grades, vetting, author verdicts, and ship verdicts remain audit history and are revision-ineligible.\n\n### D-007 — P001 inventory uses non-automated evidence; public telephone requirements remain mandatory\nDate: 2026-10-01\nP-001 delivers a manually reviewed canonical component/source/runtime inventory, not a new software feature or executable component selector. Actual artifact docs/evidence/phone-public-p001-inventory-2026-10-01.json contains six source/runtime rows, observed local health and explicit public/PSTN unknowns; committed operational test ledger20430627 records the observations. Correct PHONE-P-001-OUTCOME to behaviorClass non-automated with no requiredTestLayers; keep its behavior, falsifier, acceptanceRef and mandatory canonical BAR links unchanged. Previous observability classification incorrectly demanded a software mutation and L3 coverage census for the document. This applies only to P001 inventory verification. R1 approved launch contract and all87 public/live/regression outcomes still require their actual proof through the other mapped implementation/acceptance items. Negative control checked an unknown component yields no row; all six source files resolve to canonical independent app or operator roots. Source refs: owner planningturn5 and shipmentturn11; this is an agent-derived classification correction, not a new owner directive.\nRelated: P-001\n\n### D-008 — R1 launch contract stays on launch lanes while P001 inventory unlocks software\nDate: 2026-10-01\nMeasured closure refusal on WI10004983: AUTO-BAR-R-1-P-001@2 still required the full approved geography/budget/emergency/service contract even after owner-approved D003 converted P001 to independent inventory and moved missing facts to P004/P010/P014. R1's discharge map now names P004/P010/P014; its mandatory condition, methods, falsifier, source provenance and evidence plane are unchanged. P001 keeps its independent non-automated inventory clause and committed operational proof20430627. Retire only the obsolete P001 projection after verifying the remaining R1 edges exist. This is a structural reconciliation to the owner-approved sequencing; no paid provisioning/public exposure is authorized without actual R1 facts. Source: owner shipmentturn11 and D003; exact former mapping and close refusal were read this turn.\nRelated: P-001, P-004, P-010, P-014\n\n### D-009 — Carrier live acceptance remains downstream of the P003 software foundation\nDate: 2026-10-02\nMeasured: plans:get plan revision17 shows P004 blocked-by P003 and P011 blocked-by P003. Its authoritative BAR snapshot maps live R3/R14..R21/R85 to P003 as mandatory clause obligations as well as P004/P010/P013/P015. P003's specified output is durable data/sidecar foundations and idempotency/order/restart tests before carrier integration. Requiring actual carrier provisioning/lifecycle proof to finish that foundation makes P004 depend on evidence only P004 can produce and strands otherwise independent software lanes. Following owner-approved D003 sequencing and the D008 inventory precedent, remove only P003 from those ten LIVE discharge mappings; retain the existing P004/P010/P013/P015 mappings, original conditions, methods, falsifiers, mandatory status, source provenance and live evidence planes. Verify all surviving edges before retiring obsolete P003 projections. Keep P003's independent primary software clause and its automated tenant/authority/regression clauses; this decision is not a software completion verdict. Public carrier requirements remain mandatory for full shipment, and carrier/account/spend/provider/legal facts are still pending. No paid provisioning or public exposure is authorized by this sequencing correction.\nRelated: P-003, P-004, P-008, P-009, P-010, P-011, P-013, P-015",
  "sourceScope": {
    "harness": "phone-app",
    "root": "~/.papercusp-workspaces/papercusp-workspace/.papercusp/apps/phone-app",
    "head": "a4dbca852e97611e04c3f25f371872cae8553de7",
    "dirty": true,
    "files": [
      {
        "path": "apps/sidecar/src/api.test.ts",
        "sha256": "a14ab2958c8b74c95c12b0e256642838f9c853e0b70e0ff10333cd7509032667",
        "content": "/**\n * The sidecar's HTTP contract.\n *\n * The thing most worth pinning here is not any single route but the SEPARATION\n * of the three audiences: an owner session, a guest's invite token, and the\n * worker's own secret are three different credentials, and none of them may be\n * usable in another's place. Those are the tests at the top of this file.\n */\nimport { beforeEach, describe, expect, it } from \"vitest\";\nimport type { RoomServiceClient } from \"livekit-server-sdk\";\nimport { createMemoryPhoneBackend, type PhoneBackend } from \"@phone/data\";\nimport { createPhoneApi } from \"./api\";\nimport { CallLedger } from \"./calls\";\nimport { ScreeningControls } from \"./screening\";\nimport { SchedulingService } from \"./scheduling\";\nimport type { PhoneSidecarConfig } from \"./config\";\nimport type { AgentChatTranscriptBridge } from \"./agent-chat-bridge\";\n\nconst WORKER_SECRET = \"worker-secret-value\";\nconst OWNER = \"owner-a\";\n\nconst config: PhoneSidecarConfig = {\n  livekitUrl: \"ws://127.0.0.1:7890\",\n  livekitPublicUrl: \"wss://voice.portal.test\",\n  livekitApiKey: \"devkey\",\n  livekitApiSecret: \"devsecret-devsecret-devsecret-devsecret\",\n  authSecret: \"\",\n  workerSecret: WORKER_SECRET,\n  operatorOrigin: \"http://127.0.0.1:3070\",\n  operatorHarness: \"portal\",\n  workspaceId: \"papercusp-workspace\",\n  localMode: true,\n  localOwnerId: OWNER,\n  databaseUrl: \"\",\n  useMemoryStore: true,\n};\n\n/** Records what the sidecar told the media plane, so the screening tests can\n *  assert on the DIRECTIVE rather than on a network call. */\nclass FakeRoomService {\n  liveRooms: string[] = [];\n  metadata = new Map<string, string>();\n  deleted: string[] = [];\n\n  async listRooms() {\n    return this.liveRooms.map((name) => ({ name }));\n  }\n  async deleteRoom(name: string) {\n    this.deleted.push(name);\n  }\n  async updateRoomMetadata(name: string, metadata: string) {\n    this.metadata.set(name, metadata);\n    return { name, metadata };\n  }\n}\n\ninterface Harness {\n  app: ReturnType<typeof createPhoneApi>;\n  backend: PhoneBackend;\n  ledger: CallLedger;\n  rooms: FakeRoomService;\n}\n\nasync function harness(overrides: Partial<{\n  workerSecret: string;\n  transcriptBridge: AgentChatTranscriptBridge;\n  resolveActiveOperatorConversation: () => Promise<string | null>;\n}> = {}): Promise<Harness> {\n  const backend = createMemoryPhoneBackend();\n  await backend.migrate();\n  const rooms = new FakeRoomService();\n  const ledger = new CallLedger(\n    config,\n    backend,\n    rooms as unknown as RoomServiceClient,\n    overrides.transcriptBridge ?? { append: async () => true },\n  );\n  const app = createPhoneApi({\n    ledger,\n    screening: new ScreeningControls(config, ledger),\n    scheduling: new SchedulingService(backend, ledger),\n    // localMode short-circuits to localOwnerId; the auth mechanism itself is\n    // auth.ts's own concern, not this file's.\n    authenticate: async () => ({ ownerId: OWNER }),\n    workerSecret: overrides.workerSecret ?? WORKER_SECRET,\n    resolveActiveOperatorConversation:\n      overrides.resolveActiveOperatorConversation\n      ?? (async () => \"operator-active\"),\n  });\n  return { app, backend, ledger, rooms };\n}\n\nconst json = async (response: Response) => response.json() as Promise<Record<string, unknown>>;\n\ndescribe(\"credential response privacy\", () => {\n  it.each([\n    [\"/api/call\", \"phone_call_unavailable\", 503],\n    [\"/api/calls/incoming\", \"phone_call_unavailable\", 503],\n    [\"/api/scheduled\", \"phone_schedule_failed\", 400],\n  ])(\"never echoes dependency credentials from %s\", async (path, error, status) => {\n    const h = await harness();\n    const sensitive = \"fixture-private-invite-and-bearer\";\n    h.ledger.createCall = async () => { throw new Error(sensitive); };\n    h.backend.storeFor = () => { throw new Error(sensitive); };\n    const response = await h.app.request(path, {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ guestName: \"Dana\", scheduledFor: new Date().toISOString() }),\n    });\n    expect(response.status).toBe(status);\n    expect(await json(response)).toEqual({ ok: false, error });\n  });\n\n  it(\"preserves the explicit invalid-time validation code\", async () => {\n    const h = await harness();\n    const response = await h.app.request(\"/api/scheduled\", {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ guestName: \"Dana\", scheduledFor: \"invalid-time\" }),\n    });\n    expect(response.status).toBe(400);\n    expect(await json(response)).toEqual({ ok: false, error: \"phone_schedule_invalid_time\" });\n  });\n\n  it.each([\n    [\"/api/invite/nonexistent\", \"GET\", 404],\n    [\"/api/invite/nonexistent/join\", \"POST\", 404],\n    [\"/api/scheduled\", \"GET\", 200],\n    [\"/api/call\", \"POST\", 200],\n    [\"/internal/calls/room/context\", \"GET\", 401],\n  ])(\"prevents storage and referrer disclosure for %s %s\", async (path, method, status) => {\n    const h = await harness();\n    const response = await h.app.request(path, { method });\n    expect(response.status).toBe(status);\n    expect(response.headers.get(\"cache-control\")).toBe(\"no-store\");\n    expect(response.headers.get(\"referrer-policy\")).toBe(\"no-referrer\");\n  });\n\n  it(\"protects real invite preview, JWT grants and error responses\", async () => {\n    const h = await harness();\n    const created = await json(await h.app.request(\"/api/scheduled\", {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ guestName: \"Dana\", scheduledFor: new Date().toISOString() }),\n    }));\n    const booking = created.scheduled as { id: string; inviteToken: string };\n    const preview = await h.app.request(`/api/invite/${booking.inviteToken}`);\n    const grant = await h.app.request(`/api/invite/${booking.inviteToken}/join`, { method: \"POST\" });\n    const grantBody = await json(grant);\n    expect(grantBody.token).toEqual(expect.any(String));\n    h.rooms.deleteRoom = async () => { throw new Error(\"media teardown failed\"); };\n    const failure = await h.app.request(`/api/scheduled/${booking.id}/cancel`, { method: \"POST\" });\n    expect(failure.status).toBe(500);\n    for (const response of [preview, grant, failure]) {\n      expect(response.headers.get(\"cache-control\")).toBe(\"no-store\");\n      expect(response.headers.get(\"referrer-policy\")).toBe(\"no-referrer\");\n    }\n    expect(await json(failure)).toEqual({ ok: false, error: \"phone_internal_error\" });\n  });\n});\n\ndescribe(\"durable carrier preparation\", () => {\n  it(\"resolves inbound authority from a stored number, keeps callers restricted, and reuses the room\", async () => {\n    const h = await harness();\n    await h.backend.storeFor(OWNER).upsertNumber({ id: \"n-a\", e164: \"+14155550101\", provider: \"carrier\",\n      providerAccountId: \"account-a\", trunkId: \"trunk-a\", assistantId: \"assistant-a\", status: \"active\" });\n    const input = { provider: \"carrier\", providerAccountId: \"account-a\", providerCallId: \"external-1\",\n      from: \"+14155550102\", to: \"+14155550101\" };\n    const first = await h.ledger.bindInboundCall(input);\n    expect(first?.created).toBe(true);\n    expect((await h.ledger.bindInboundCall(input))?.call.id).toBe(first?.call.id);\n    expect((await h.ledger.bindInboundCall(input))?.created).toBe(false);\n    await expect(h.ledger.bindInboundCall({ ...input, to: \"+14155550199\" })).rejects.toThrow(\"phone_inbound_binding_conflict\");\n    const response = await h.app.request(`/internal/calls/${first!.call.id}/context`, {\n      headers: { \"x-phone-worker-secret\": WORKER_SECRET },\n    });\n    expect(response.status).toBe(200);\n    expect((await json(response)).context).toMatchObject({ ownerId: OWNER, assistantId: \"assistant-a\",\n      parentOperatorConversationId: null, principal: { kind: \"caller\", authenticated: false } });\n    expect(await h.ledger.bindInboundCall({ ...input, providerCallId: \"unknown\", to: \"+14155550199\" })).toBeNull();\n    await h.backend.close();\n  });\n\n  it(\"prepares one outbound intent for retries and refuses another tenant's number\", async () => {\n    const h = await harness();\n    await h.backend.storeFor(OWNER).upsertNumber({ id: \"n-a\", e164: \"+14155550101\", provider: \"carrier\",\n      providerAccountId: \"account-a\", trunkId: \"trunk-a\", assistantId: \"assistant-a\", status: \"active\" });\n    const options = { numberId: \"n-a\", to: \"+14155550102\", requestId: \"retry-a\", parentOperatorConversationId: \"operator-active\" };\n    const first = await h.ledger.prepareOutboundCall(OWNER, options);\n    const second = await h.ledger.prepareOutboundCall(OWNER, options);\n    expect(first.created).toBe(true);\n    expect(second.created).toBe(false);\n    expect(second.call.id).toBe(first.call.id);\n    await expect(h.ledger.prepareOutboundCall(\"other-owner\", options)).rejects.toThrow(\"phone_number_not_authorized\");\n    await expect(h.ledger.prepareOutboundCall(OWNER, { ...options, to: \"+14155550103\" })).rejects.toThrow(\"phone_dial_request_conflict\");\n    await h.backend.close();\n  });\n});\n\ndescribe(\"audience separation\", () => {\n  let h: Harness;\n  beforeEach(async () => { h = await harness(); });\n\n  it(\"refuses the worker's ingest routes without the worker secret\", async () => {\n    const response = await h.app.request(\"/internal/calls/room-1/context\");\n    expect(response.status).toBe(401);\n    expect((await json(response)).error).toBe(\"phone_worker_unauthorized\");\n  });\n\n  it(\"refuses a WRONG worker secret\", async () => {\n    const response = await h.app.request(\"/internal/calls/room-1/context\", {\n      headers: { \"x-phone-worker-secret\": \"not-the-secret-value\" },\n    });\n    expect(response.status).toBe(401);\n  });\n\n  it(\"disables worker ingest entirely when no secret is configured\", async () => {\n    // Blank must CLOSE the routes, never leave an unauthenticated write path\n    // open — a transcript endpoint anyone can post to is worse than a worker\n    // that cannot report at all.\n    const open = await harness({ workerSecret: \"\" });\n    const response = await open.app.request(\"/internal/calls/room-1/context\", {\n      headers: { \"x-phone-worker-secret\": \"\" },\n    });\n    expect(response.status).toBe(503);\n    expect((await json(response)).error).toBe(\"phone_worker_ingest_disabled\");\n  });\n\n  it(\"serves health without any credential\", async () => {\n    expect((await h.app.request(\"/api/health\")).status).toBe(200);\n  });\n});\n\ndescribe(\"placing and recording a call\", () => {\n  let h: Harness;\n  beforeEach(async () => { h = await harness(); });\n\n  it(\"mints a grant and files the call as dialing\", async () => {\n    const body = await json(await h.app.request(\"/api/call\", { method: \"POST\" }));\n    expect(body.ok).toBe(true);\n    expect(typeof body.token).toBe(\"string\");\n    expect(body.url).toBe(\"wss://voice.portal.test\");\n\n    const calls = (await json(await h.app.request(\"/api/calls\"))).calls as { status: string }[];\n    expect(calls[0]?.status).toBe(\"dialing\");\n  });\n\n  it(\"keeps the Portal agent-chat binding distinct from the active Papercup parent\", async () => {\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-123\" }),\n    }));\n    const room = created.roomName as string;\n\n    const context = await json(await h.app.request(`/internal/calls/${room}/context`, {\n      headers: { \"x-phone-worker-secret\": WORKER_SECRET },\n    }));\n    expect(context.context).toMatchObject({\n      callId: room,\n      conversationId: \"chat-123\",\n      parentOperatorConversationId: \"operator-active\",\n    });\n    expect((context.context as { principal: unknown }).principal).toEqual({\n      kind: \"owner\",\n      subjectId: OWNER,\n      authenticated: true,\n      authoritySource: \"owner-session\",\n    });\n\n    const calls = (await json(await h.app.request(\"/api/calls\"))).calls as {\n      conversationId: string | null;\n      parentOperatorConversationId: string | null;\n    }[];\n    expect(calls[0]?.conversationId).toBe(\"chat-123\");\n    expect(calls[0]?.parentOperatorConversationId).toBe(\"operator-active\");\n  });\n\n  it(\"fails closed before minting a call when no active owner parent resolves\", async () => {\n    const unavailable = await harness({\n      resolveActiveOperatorConversation: async () => null,\n    });\n    const response = await unavailable.app.request(\"/api/call\", { method: \"POST\" });\n    expect(response.status).toBe(503);\n    expect((await json(response)).error)\n      .toBe(\"phone_operator_conversation_unavailable\");\n    expect((await unavailable.backend.storeFor(OWNER).listCalls()).length).toBe(0);\n  });\n\n  it(\"rejects a malformed conversation binding instead of minting a detached call\", async () => {\n    const response = await h.app.request(\"/api/call\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"   \" }),\n    });\n    expect(response.status).toBe(400);\n    expect((await json(response)).error).toBe(\"phone_conversation_id_invalid\");\n  });\n\n  it(\"marks an incoming unknown caller as screening, which is what arms the controls\", async () => {\n    const body = await json(await h.app.request(\"/api/calls/incoming\", {\n      method: \"POST\",\n      body: JSON.stringify({}),\n      headers: { \"content-type\": \"application/json\" },\n    }));\n    const room = body.roomName as string;\n\n    const context = await json(await h.app.request(`/internal/calls/${room}/context`, {\n      headers: { \"x-phone-worker-secret\": WORKER_SECRET },\n    }));\n    expect((context.context as { screening: boolean }).screening).toBe(true);\n    // Unknown is the SCREENING condition, so it must survive as null rather\n    // than being filled in with a placeholder.\n    expect((context.context as { callerLabel: string | null }).callerLabel).toBeNull();\n    expect((context.context as { parentOperatorConversationId: string | null })\n      .parentOperatorConversationId).toBeNull();\n    expect((context.context as { principal: unknown }).principal).toEqual({\n      kind: \"unknown\",\n      subjectId: null,\n      authenticated: false,\n      authoritySource: \"unknown\",\n    });\n  });\n\n  it(\"derives a known caller principal from the server call ledger, not the worker\", async () => {\n    const body = await json(await h.app.request(\"/api/calls/incoming\", {\n      method: \"POST\",\n      body: JSON.stringify({ callerLabel: \"Dana\" }),\n      headers: { \"content-type\": \"application/json\" },\n    }));\n    const room = body.roomName as string;\n    const context = await json(await h.app.request(`/internal/calls/${room}/context`, {\n      headers: { \"x-phone-worker-secret\": WORKER_SECRET },\n    }));\n    expect((context.context as { principal: unknown }).principal).toEqual({\n      kind: \"caller\",\n      subjectId: room,\n      authenticated: false,\n      authoritySource: \"call-ledger\",\n    });\n  });\n\n  it(\"stores a transcript posted by the worker and finds the call by it\", async () => {\n    const created = await json(await h.app.request(\"/api/call\", { method: \"POST\" }));\n    const room = created.roomName as string;\n\n    const posted = await h.app.request(`/internal/calls/${room}/transcript`, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({\n        segments: [\n          { seq: 0, speaker: \"caller\", text: \"I need to reschedule the delivery\" },\n          { seq: 1, speaker: \"assistant\", text: \"I can help with that\" },\n        ],\n      }),\n    });\n    expect(posted.status).toBe(200);\n\n    const hits = (await json(await h.app.request(\"/api/calls/search?q=reschedule\")))\n      .hits as { call: { id: string } }[];\n    expect(hits.map((hit) => hit.call.id)).toEqual([room]);\n  });\n\n  it(\"mirrors a bound call into the same agent-chat using server-held identity\", async () => {\n    const appended: unknown[] = [];\n    const h = await harness({ transcriptBridge: {\n      append: async (input) => { appended.push(input); return true; },\n    } });\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-123\" }),\n    }));\n    const room = created.roomName as string;\n    const posted = await h.app.request(`/internal/calls/${room}/transcript`, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({ segments: [{ seq: 0, speaker: \"caller\", text: \"spoken hello\" }] }),\n    });\n    expect(posted.status).toBe(200);\n    expect(appended).toEqual([expect.objectContaining({ conversationId: \"chat-123\", roomName: room })]);\n  });\n\n  it(\"returns a retryable failure when the shared chat append does not land\", async () => {\n    const h = await harness({ transcriptBridge: { append: async () => false } });\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-123\" }),\n    }));\n    const response = await h.app.request(`/internal/calls/${created.roomName}/transcript`, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({ segments: [{ seq: 0, speaker: \"caller\", text: \"retry me\" }] }),\n    });\n    expect(response.status).toBe(502);\n    expect((await json(response)).error).toBe(\"phone_agent_chat_bridge_failed\");\n  });\n\n  it(\"refuses to store an empty voicemail\", async () => {\n    // A caller who was sent to voicemail and said nothing left no message; an\n    // empty inbox item would claim otherwise.\n    const created = await json(await h.app.request(\"/api/call\", { method: \"POST\" }));\n    const room = created.roomName as string;\n    const response = await h.app.request(`/internal/calls/${room}/voicemail`, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({ transcript: \"   \" }),\n    });\n    expect(response.status).toBe(400);\n    expect((await json(await h.app.request(\"/api/voicemail\"))).voicemails).toEqual([]);\n  });\n});\n\ndescribe(\"screening controls (P-006)\", () => {\n  let h: Harness;\n  let room: string;\n  beforeEach(async () => {\n    h = await harness();\n    const created = await json(await h.app.request(\"/api/calls/incoming\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ callerLabel: \"Dana\" }),\n    }));\n    room = created.roomName as string;\n  });\n\n  it(\"publishes a decline directive the worker can read, and records the disposition\", async () => {\n    expect((await h.app.request(`/api/calls/${room}/decline`, { method: \"POST\" })).status).toBe(200);\n\n    const written = h.rooms.metadata.get(room);\n    expect(written).toBeTruthy();\n    expect(JSON.parse(written!).directive).toBe(\"decline\");\n\n    const calls = (await json(await h.app.request(\"/api/calls\"))).calls as { disposition: string }[];\n    expect(calls[0]?.disposition).toBe(\"declined\");\n  });\n\n  it(\"hands back an operator token on take-over\", async () => {\n    const body = await json(await h.app.request(`/api/calls/${room}/take-over`, { method: \"POST\" }));\n    expect(body.ok).toBe(true);\n    expect(body.roomName).toBe(room);\n    expect(String(body.identity)).toContain(\"operator\");\n    expect(JSON.parse(h.rooms.metadata.get(room)!).directive).toBe(\"take-over\");\n  });\n\n  it(\"does NOT tear the room down when sending to voicemail\", async () => {\n    // The caller is still on the line and about to speak the message; deleting\n    // the room here would drop them mid-sentence and store nothing.\n    await h.app.request(`/api/calls/${room}/voicemail`, { method: \"POST\" });\n    expect(h.rooms.deleted).toEqual([]);\n    expect(JSON.parse(h.rooms.metadata.get(room)!).directive).toBe(\"voicemail\");\n  });\n\n  it(\"publishes a bounded say directive for the bound Portal conversation\", async () => {\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-123\" }),\n    }));\n    // A screening write first proves say MERGES with room state rather than\n    // replacing the last-write-wins metadata envelope.\n    await h.app.request(`/api/calls/${created.roomName}/voicemail`, { method: \"POST\" });\n    const response = await h.app.request(\"/api/calls/say\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-123\", text: \"Short spoken reply.\" }),\n    });\n    expect(response.status).toBe(200);\n    const metadata = JSON.parse(h.rooms.metadata.get(created.roomName as string)!);\n    expect(metadata.directive).toBe(\"voicemail\");\n    expect(metadata.say).toEqual(expect.objectContaining({ text: \"Short spoken reply.\" }));\n    expect(typeof metadata.say.id).toBe(\"string\");\n    expect(typeof metadata.say.issuedAt).toBe(\"string\");\n  });\n\n  it(\"does not let say target an unbound or inactive conversation\", async () => {\n    const missing = await h.app.request(\"/api/calls/say\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"not-bound\", text: \"hello\" }),\n    });\n    expect(missing.status).toBe(404);\n\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\", body: JSON.stringify({ conversationId: \"chat-closed\" }),\n      headers: { \"content-type\": \"application/json\" },\n    }));\n    await h.app.request(`/api/calls/${created.roomName}/ended`, { method: \"POST\" });\n    const inactive = await h.app.request(\"/api/calls/say\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-closed\", text: \"hello\" }),\n    });\n    expect(inactive.status).toBe(404);\n  });\n\n  it(\"rejects an overlong spoken line before publishing metadata\", async () => {\n    const created = await json(await h.app.request(\"/api/call\", {\n      method: \"POST\", body: JSON.stringify({ conversationId: \"chat-long\" }),\n      headers: { \"content-type\": \"application/json\" },\n    }));\n    const response = await h.app.request(\"/api/calls/say\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ conversationId: \"chat-long\", text: \"x\".repeat(221) }),\n    });\n    expect(response.status).toBe(400);\n    expect(h.rooms.metadata.has(created.roomName as string)).toBe(false);\n  });\n\n  it(\"404s a control aimed at a call that does not exist\", async () => {\n    expect((await h.app.request(\"/api/calls/no-such-room/decline\", { method: \"POST\" })).status).toBe(404);\n  });\n});\n\ndescribe(\"scheduled calls (P-008)\", () => {\n  let h: Harness;\n  beforeEach(async () => { h = await harness(); });\n\n  const book = async (scheduledFor: string) =>\n    json(await h.app.request(\"/api/scheduled\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ title: \"Intro\", guestName: \"Dana\", scheduledFor, durationMin: 30 }),\n    }));\n\n  it(\"issues an unguessable invite token and lets a guest join in the window\", async () => {\n    const created = await book(new Date().toISOString());\n    const booking = created.scheduled as { inviteToken: string; roomName: string };\n    // 32 random bytes, base64url — not derived from the id, time or name.\n    expect(booking.inviteToken.length).toBeGreaterThanOrEqual(40);\n\n    const preview = await json(await h.app.request(`/api/invite/${booking.inviteToken}`));\n    expect((preview.booking as { guestName: string }).guestName).toBe(\"Dana\");\n\n    const joined = await json(await h.app.request(`/api/invite/${booking.inviteToken}/join`, { method: \"POST\" }));\n    expect(joined.ok).toBe(true);\n    expect(joined.roomName).toBe(booking.roomName);\n  });\n\n  it(\"files the guest's call against the OWNER, not the guest\", async () => {\n    const created = await book(new Date().toISOString());\n    const booking = created.scheduled as { inviteToken: string; roomName: string };\n    await h.app.request(`/api/invite/${booking.inviteToken}/join`, { method: \"POST\" });\n\n    // It is the owner's call log, transcript and agent; the guest is a\n    // participant, never a tenant.\n    expect(await h.backend.unscoped.ownerOfCall(booking.roomName)).toBe(OWNER);\n    const calls = (await json(await h.app.request(\"/api/calls\"))).calls as { roomName: string }[];\n    expect(calls.map((c) => c.roomName)).toContain(booking.roomName);\n    const context = await json(await h.app.request(\n      `/internal/calls/${booking.roomName}/context`,\n      { headers: { \"x-phone-worker-secret\": WORKER_SECRET } },\n    ));\n    expect((context.context as { principal: unknown }).principal).toEqual({\n      kind: \"guest\",\n      subjectId: booking.roomName,\n      authenticated: true,\n      authoritySource: \"invite\",\n    });\n    expect((context.context as { parentOperatorConversationId: string | null })\n      .parentOperatorConversationId).toBeNull();\n  });\n\n  it(\"refuses a join far outside the window, and says which side it missed\", async () => {\n    const tooEarly = await book(new Date(Date.now() + 6 * 60 * 60_000).toISOString());\n    const earlyToken = (tooEarly.scheduled as { inviteToken: string }).inviteToken;\n    const earlyResponse = await h.app.request(`/api/invite/${earlyToken}/join`, { method: \"POST\" });\n    expect(earlyResponse.status).toBe(409);\n    expect((await json(earlyResponse)).error).toBe(\"phone_invite_too_early\");\n\n    const tooLate = await book(new Date(Date.now() - 6 * 60 * 60_000).toISOString());\n    const lateToken = (tooLate.scheduled as { inviteToken: string }).inviteToken;\n    const lateResponse = await h.app.request(`/api/invite/${lateToken}/join`, { method: \"POST\" });\n    expect(lateResponse.status).toBe(409);\n    expect((await json(lateResponse)).error).toBe(\"phone_invite_expired\");\n  });\n\n  it(\"distinguishes a wrong link (404) from a right link at the wrong time (409)\", async () => {\n    // Only the second is worth waiting on, so a guest must be able to tell.\n    const response = await h.app.request(\"/api/invite/tok_nonexistent/join\", { method: \"POST\" });\n    expect(response.status).toBe(404);\n  });\n\n  it(\"refuses a cancelled booking\", async () => {\n    const created = await book(new Date().toISOString());\n    const booking = created.scheduled as { id: string; inviteToken: string };\n    await h.app.request(`/api/scheduled/${booking.id}/cancel`, { method: \"POST\" });\n\n    const response = await h.app.request(`/api/invite/${booking.inviteToken}/join`, { method: \"POST\" });\n    expect(response.status).toBe(409);\n    expect((await json(response)).error).toBe(\"phone_invite_cancelled\");\n  });\n\n  it(\"rejects a booking with no guest or no time\", async () => {\n    const noGuest = await h.app.request(\"/api/scheduled\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ scheduledFor: new Date().toISOString() }),\n    });\n    expect(noGuest.status).toBe(400);\n  });\n});\n\ndescribe(\"owner call export\", () => {\n  it(\"downloads one owned snapshot and hides another tenant's call\", async () => {\n    const h = await harness();\n    const created = await json(await h.app.request(\"/api/call\", { method: \"POST\" }));\n    const room = created.roomName as string;\n    await h.ledger.ingestTranscript(room, [{ seq: 0, speaker: \"caller\", text: \"Export message\",\n      at: \"2026-10-01T12:00:00.000Z\" }]);\n    await h.ledger.saveVoicemail(room, { transcript: \"Export message\", durationSec: 5 });\n    const stored = (await h.backend.storeFor(OWNER).getCall(room))!;\n    await h.backend.storeFor(OWNER).upsertCall({ ...stored, recordingUri: \"s3://private-fixture/message.ogg\" });\n    const response = await h.app.request(`/api/calls/${room}/export?ownerId=owner-b`);\n    expect(response.status).toBe(200);\n    expect(response.headers.get(\"cache-control\")).toBe(\"private, no-store\");\n    expect(response.headers.get(\"content-disposition\")).toContain(\"attachment;\");\n    const exported = await response.text();\n    expect(exported).toContain(\"Export message\");\n    expect(exported).not.toContain(\"private-fixture\");\n    expect(exported).not.toContain(\"operator-active\");\n    await h.backend.storeFor(\"owner-b\").upsertCall({ ...stored, id: \"foreign-export\", roomName: \"foreign-export\" });\n    const foreign = await h.app.request(\"/api/calls/foreign-export/export?ownerId=owner-b\");\n    expect(foreign.status).toBe(404);\n    expect(await foreign.json()).toEqual({ ok: false, error: \"phone_call_not_found\" });\n    await h.backend.close();\n  });\n});\n\ndescribe(\"owner content deletion\", () => {\n  it(\"deletes only the authenticated owner's local content and rejects worker replay\", async () => {\n    const h = await harness(), room = \"local-content-delete\";\n    const store = h.backend.storeFor(OWNER), call = { id: room, roomName: room, conversationId: null,\n      parentOperatorConversationId: null, direction: \"inbound\" as const, status: \"completed\" as const,\n      callerLabel: null, disposition: null, startedAt: \"2026-10-01T12:00:00.000Z\",\n      endedAt: \"2026-10-01T12:00:05.000Z\", durationSec: 5, summary: \"Private message\" };\n    await store.upsertCall(call);\n    await h.ledger.ingestTranscript(room, [{ seq: 0, speaker: \"caller\", text: \"Private message\", at: call.startedAt }]);\n    await h.ledger.saveVoicemail(room, { transcript: \"Private message\", durationSec: 5 });\n    await h.backend.storeFor(\"owner-b\").upsertCall({ ...call, id: \"foreign-delete\", roomName: \"foreign-delete\", status: \"completed\" });\n    expect((await h.app.request(\"/api/calls/foreign-delete/content?ownerId=owner-b\", { method: \"DELETE\" })).status).toBe(404);\n    const response = await h.app.request(`/api/calls/${room}/content?ownerId=owner-b`, { method: \"DELETE\" });\n    expect(response.status).toBe(200); expect(response.headers.get(\"cache-control\")).toBe(\"private, no-store\");\n    const result = await response.json(); expect(result).toMatchObject({ ok: true, scope: \"phone-store\", deletedAt: expect.any(String) });\n    expect(await (await h.app.request(`/api/calls/${room}/content`, { method: \"DELETE\" })).json()).toEqual(result);\n    for (const [kind, body] of [[\"transcript\", { segments: [{ seq: 0, speaker: \"caller\", text: \"replayed\" }] }],\n      [\"voicemail\", { transcript: \"replayed\" }], [\"summary\", { summary: \"replayed\" }]] as const) {\n      const replay = await h.app.request(`/internal/calls/${room}/${kind}`, { method: \"POST\",\n        headers: { \"x-phone-worker-secret\": WORKER_SECRET, \"content-type\": \"application/json\" }, body: JSON.stringify(body) });\n      expect(replay.status).toBe(410); expect(await replay.json()).toEqual({ ok: false, error: \"phone_content_deleted\" });\n    }\n    expect(await store.exportCallContent(room)).toMatchObject({ call: { summary: null }, segments: [], voicemail: null });\n    expect((await h.ledger.summary(OWNER)).unreadVoicemail).toBe(0);\n    await h.backend.close();\n  });\n\n  it(\"returns an explicit conflict for active, recorded or mirrored calls\", async () => {\n    const h = await harness(), created = await json(await h.app.request(\"/api/call\", { method: \"POST\" }));\n    const room = created.roomName as string, store = h.backend.storeFor(OWNER), call = (await store.getCall(room))!;\n    const remove = () => h.app.request(`/api/calls/${room}/content`, { method: \"DELETE\" });\n    expect(await (await remove()).json()).toEqual({ ok: false, error: \"phone_call_active\" });\n    await store.upsertCall({ ...call, status: \"completed\", recordingUri: \"s3://private-fixture/audio.ogg\" });\n    const media = await remove(); expect(media.status).toBe(409);\n    expect(await media.json()).toEqual({ ok: false, error: \"phone_recording_delete_required\" });\n    await store.upsertCall({ ...call, status: \"completed\", recordingUri: null });\n    const mirrored = await remove(); expect(mirrored.status).toBe(409);\n    expect(await mirrored.json()).toEqual({ ok: false, error: \"phone_mirrored_content_delete_required\" });\n    await h.backend.close();\n  });\n});\n\ndescribe(\"summary badge\", () => {\n  it(\"does not resurrect the unread badge when the worker replays a read voicemail\", async () => {\n    const h = await harness();\n    const created = await json(await h.app.request(\"/api/calls/incoming\", {\n      method: \"POST\", headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ callerLabel: \"Dana\" }),\n    }));\n    const room = created.roomName as string;\n    const receipt = () => h.app.request(`/internal/calls/${room}/voicemail`, {\n      method: \"POST\", headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({ transcript: \"please call me back\", durationSec: 12 }),\n    });\n    expect((await receipt()).status).toBe(200);\n    expect((await json(await h.app.request(\"/api/summary\"))).summary).toMatchObject({ unreadVoicemail: 1 });\n    expect(await json(await h.app.request(`/api/voicemail/${room}/read`, { method: \"POST\" })))\n      .toMatchObject({ ok: true, changed: true });\n    const first = (await json(await h.app.request(\"/api/voicemail\"))).voicemails;\n    expect((await receipt()).status).toBe(200);\n    expect((await json(await h.app.request(\"/api/summary\"))).summary).toMatchObject({ unreadVoicemail: 0 });\n    expect((await json(await h.app.request(\"/api/voicemail\"))).voicemails).toEqual(first);\n    expect(await json(await h.app.request(`/api/voicemail/${room}/read`, { method: \"POST\" })))\n      .toMatchObject({ ok: true, changed: false });\n  });\n\n  it(\"counts a screening call as active and reports unread voicemail\", async () => {\n    const h = await harness();\n    const created = await json(await h.app.request(\"/api/calls/incoming\", {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\" },\n      body: JSON.stringify({ callerLabel: \"Dana\" }),\n    }));\n    const room = created.roomName as string;\n    await h.app.request(`/internal/calls/${room}/voicemail`, {\n      method: \"POST\",\n      headers: { \"content-type\": \"application/json\", \"x-phone-worker-secret\": WORKER_SECRET },\n      body: JSON.stringify({ transcript: \"please call me back\" }),\n    });\n\n    const summary = (await json(await h.app.request(\"/api/summary\"))).summary as {\n      activeCalls: number; screeningCalls: number; unreadVoicemail: number;\n    };\n    expect(summary.screeningCalls).toBe(1);\n    expect(summary.activeCalls).toBe(1);\n    expect(summary.unreadVoicemail).toBe(1);\n  });\n});\n",
        "headBlob": "da9d3e426100f27343e71a233380ac866fd709ad",
        "headBlobDescribes": "historical HEAD version, NOT the captured working bytes; sha256 identifies captured content"
      },
      {
        "path": "packages/data/src/store-contract.test.ts",
        "sha256": "3a8c570e693e5f7cd7facf88f14cbe27be6fd8706a89867fae1c0c17777773a9",
        "content": "/**\n * ONE contract, run against BOTH backends.\n *\n * The memory backend exists so tests and local runs need no database — which\n * makes it exactly the thing that can drift from the SQL it stands in for. A\n * test that only ever runs in memory would keep passing while the real path\n * broke, so this file parameterises over both and asserts identical observable\n * behaviour.\n *\n * The Postgres arm runs when PHONE_TEST_DATABASE_URL is set and SKIPS\n * otherwise, loudly (the suite prints which arms ran). Skipping is a real\n * result here — a silent single-arm pass is the failure this design is\n * guarding against, so the arm names itself either way.\n */\nimport { afterAll, beforeEach, describe, expect, it } from \"vitest\";\nimport postgres from \"postgres\";\nimport { randomUUID } from \"node:crypto\";\nimport { createMemoryPhoneBackend } from \"./memory-store\";\nimport { createPostgresPhoneBackend } from \"./postgres-store\";\nimport type { OwnedPhoneNumber, PhoneBackend, ProviderCallEvent, StoredCall, TelephonyCall } from \"./types\";\n\nconst OWNER = \"owner-a\";\nconst OTHER = \"owner-b\";\n\nconst TEST_DB_URL = process.env.PHONE_TEST_DATABASE_URL?.trim() ?? \"\";\n\ninterface Arm {\n  name: string;\n  create(): Promise<PhoneBackend>;\n  reset(backend: PhoneBackend): Promise<void>;\n  teardown(backend: PhoneBackend): Promise<void>;\n  reopen?(backend: PhoneBackend): Promise<PhoneBackend>;\n}\n\nconst arms: Arm[] = [\n  {\n    name: \"memory\",\n    async create() {\n      const backend = createMemoryPhoneBackend();\n      await backend.migrate();\n      return backend;\n    },\n    async reset() { /* a fresh backend per test; nothing to clear */ },\n    async teardown(backend) { await backend.close(); },\n  },\n];\n\nif (TEST_DB_URL) {\n  const schemas = new WeakMap<PhoneBackend, string>();\n  function openSchema(schema: string): PhoneBackend {\n    const sql = postgres(TEST_DB_URL, { max: 4, idle_timeout: 5, connect_timeout: 15,\n      connection: { search_path: schema } });\n    const backend = createPostgresPhoneBackend(sql);\n    schemas.set(backend, schema);\n    return backend;\n  }\n  arms.push({\n    name: \"postgres\",\n    async create() {\n      // Every test owns a fresh schema. Never TRUNCATE shared Phone tables,\n      // even if a developer accidentally supplies a non-test database URL.\n      const schema = `phone_contract_${randomUUID().replaceAll(\"-\", \"\")}`;\n      const admin = postgres(TEST_DB_URL, { max: 1 });\n      try { await admin.unsafe(`CREATE SCHEMA \"${schema}\"`); }\n      finally { await admin.end(); }\n      const backend = openSchema(schema);\n      await backend.migrate();\n      return backend;\n    },\n    async reset() { /* create() isolates */ },\n    async reopen(backend) {\n      const schema = schemas.get(backend)!;\n      await backend.close();\n      const reopened = openSchema(schema);\n      await reopened.migrate();\n      return reopened;\n    },\n    async teardown(backend) {\n      const schema = schemas.get(backend)!;\n      await backend.close();\n      const admin = postgres(TEST_DB_URL, { max: 1 });\n      try { await admin.unsafe(`DROP SCHEMA \"${schema}\" CASCADE`); }\n      finally { await admin.end(); }\n    },\n  });\n}\n\nfunction call(overrides: Partial<StoredCall> & Pick<StoredCall, \"id\">): StoredCall {\n  return {\n    roomName: overrides.id,\n    conversationId: null,\n    parentOperatorConversationId: null,\n    direction: \"outbound\",\n    status: \"dialing\",\n    callerLabel: null,\n    disposition: null,\n    startedAt: new Date(\"2026-08-31T12:00:00.000Z\").toISOString(),\n    endedAt: null,\n    durationSec: null,\n    summary: null,\n    ...overrides,\n  };\n}\n\nfunction number(overrides: Partial<OwnedPhoneNumber> = {}): OwnedPhoneNumber {\n  return { id: \"number-a\", e164: \"+14155550101\", provider: \"carrier\", providerAccountId: \"account-a\",\n    trunkId: \"trunk-a\", assistantId: \"assistant-a\", status: \"active\", ...overrides };\n}\nfunction dial(overrides: Partial<TelephonyCall> = {}, id = \"dial-a\"): StoredCall & { telephony: TelephonyCall } {\n  return { ...call({ id }), telephony: {\n    numberId: \"number-a\", assistantId: \"assistant-a\", provider: \"carrier\", providerAccountId: \"account-a\", trunkId: \"trunk-a\",\n    providerCallId: null, dialRequestId: \"request-a\", from: \"+14155550101\", to: \"+14155550102\",\n    connectedAt: null, lastEventAt: null, ...overrides,\n  } };\n}\nfunction event(type: ProviderCallEvent[\"type\"], overrides: Partial<ProviderCallEvent> = {}): ProviderCallEvent {\n  return { eventId: `event-${type}`, callId: \"dial-a\", provider: \"carrier\", providerAccountId: \"account-a\",\n    providerCallId: \"provider-call-a\", type, occurredAt: \"2026-08-31T12:00:10.000Z\", ...overrides };\n}\n\ndescribe(`store contract [arms: ${arms.map((a) => a.name).join(\", \")}]`, () => {\n  it(\"runs the Postgres arm, or says why not\", () => {\n    // Deliberately an assertion-free announcement rather than a skip: a reader\n    // scanning output should be able to see which arms were actually exercised.\n    if (!TEST_DB_URL) {\n      console.warn(\"[store-contract] Postgres arm SKIPPED — PHONE_TEST_DATABASE_URL is not set\");\n    }\n    expect(arms.length).toBeGreaterThan(0);\n  });\n});\n\ndescribe.each(arms)(\"PhoneStore contract ($name)\", (arm) => {\n  let backend: PhoneBackend;\n\n  it(\"keeps unsubmitted intents enumerable after restart and excludes bound calls and other tenants\", async () => {\n    let store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    await store.createDialRequest(dial());\n    if (arm.reopen) backend = await arm.reopen(backend);\n    store = backend.storeFor(OWNER);\n    expect((await store.listPendingDialRequests()).map(c => c.telephony?.dialRequestId)).toEqual([\"request-a\"]);\n    expect(await backend.storeFor(OTHER).listPendingDialRequests()).toEqual([]);\n    await store.reconcileProviderEvent(event(\"ringing\"));\n    expect(await store.listPendingDialRequests()).toEqual([]);\n  });\n\n  it(\"admits withheld inbound caller ID without inventing an identity\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    const inbound = { ...dial(), direction: \"inbound\" as const, status: \"screening\" as const,\n      telephony: { ...dial().telephony, dialRequestId: null, providerCallId: \"withheld-a\",\n        from: null, to: \"+14155550101\" } };\n    const result = await store.bindInboundCall(inbound);\n    expect(result.call.telephony?.from).toBeNull();\n    expect(result.call.callerLabel).toBeNull();\n    await expect(store.createDialRequest(dial({ from: null }))).rejects.toThrow(\"phone_invalid_dial_request\");\n  });\n\n  it(\"converges to the same state for every callback arrival ordering\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    const sequences = [ [\"ringing\", \"answered\", \"ended\"], [\"ringing\", \"ended\", \"answered\"],\n      [\"answered\", \"ringing\", \"ended\"], [\"answered\", \"ended\", \"ringing\"],\n      [\"ended\", \"ringing\", \"answered\"], [\"ended\", \"answered\", \"ringing\"] ] as const;\n    for (const [index, sequence] of sequences.entries()) {\n      const id = `permutation-${index}`;\n      await store.createDialRequest(dial({ dialRequestId: id }, id));\n      for (const type of sequence) {\n        await store.reconcileProviderEvent(event(type, { callId: id, providerCallId: id, eventId: `${id}-${type}`,\n          occurredAt: `2026-08-31T12:00:${type === \"ringing\" ? \"05\" : type === \"answered\" ? \"10\" : \"30\"}.000Z` }));\n      }\n      expect(await store.getCall(id)).toMatchObject({ status: \"completed\", durationSec: 20,\n        telephony: { connectedAt: \"2026-08-31T12:00:10.000Z\", lastEventAt: \"2026-08-31T12:00:30.000Z\" } });\n    }\n  });\n\n  it(\"binds inbound room and assistant exactly once without admitting owner authority\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    const inbound = { ...dial(), direction: \"inbound\" as const, status: \"screening\" as const,\n      telephony: { ...dial().telephony, dialRequestId: null, providerCallId: \"inbound-a\",\n        from: \"+14155550102\", to: \"+14155550101\" } };\n    const attempts = await Promise.all([store.bindInboundCall(inbound), store.bindInboundCall({ ...inbound, id: \"retry-inbound\", roomName: \"retry-inbound\" })]);\n    expect(attempts.filter(r => r.created)).toHaveLength(1);\n    expect(attempts[0]?.call).toEqual(attempts[1]?.call);\n    const resolved = await backend.unscoped.findProviderCall(\"carrier\", \"account-a\", \"inbound-a\");\n    expect(resolved?.ownerId).toBe(OWNER);\n    expect(resolved?.call.telephony?.assistantId).toBe(\"assistant-a\");\n    expect(await backend.storeFor(OTHER).getCall(resolved!.call.id)).toBeNull();\n    await expect(store.bindInboundCall({ ...inbound, parentOperatorConversationId: \"forged-owner\" })).rejects.toThrow(\"phone_invalid_inbound_binding\");\n    await expect(store.bindInboundCall({ ...inbound, telephony: { ...inbound.telephony, from: \"+14155550199\" } })).rejects.toThrow(\"phone_inbound_binding_conflict\");\n    await store.upsertNumber(number({ status: \"suspended\" }));\n    expect((await store.bindInboundCall(inbound)).created).toBe(false);\n  });\n\n  it(\"routes only active durable numbers and preserves tenant/account boundaries\", async () => {\n    await backend.storeFor(OWNER).upsertNumber(number());\n    expect(await backend.storeFor(OTHER).getNumber(\"number-a\")).toBeNull();\n    expect(await backend.storeFor(OTHER).listNumbers()).toEqual([]);\n    expect(await backend.unscoped.resolveInboundNumber(\"carrier\", \"account-a\", \"+14155550101\"))\n      .toEqual({ ownerId: OWNER, number: number() });\n    expect(await backend.unscoped.resolveInboundNumber(\"carrier\", \"other-account\", \"+14155550101\")).toBeNull();\n    expect(await backend.unscoped.resolveInboundNumber(\"carrier\", \"account-a\", \"+14155550199\")).toBeNull();\n    for (const status of [\"pending\", \"suspended\", \"released\"] as const) {\n      await backend.storeFor(OWNER).upsertNumber(number({ status }));\n      expect(await backend.unscoped.resolveInboundNumber(\"carrier\", \"account-a\", \"+14155550101\")).toBeNull();\n    }\n    await expect(backend.storeFor(OTHER).upsertNumber(number())).rejects.toThrow();\n    await expect(backend.storeFor(OTHER).upsertNumber(number({ id: \"other-id\" }))).rejects.toThrow();\n  });\n\n  it(\"rejects malformed numbers and dialing from a foreign or inactive binding\", async () => {\n    await expect(backend.storeFor(OWNER).upsertNumber(number({ e164: \"4155550101\" }))).rejects.toThrow(\"phone_invalid_number\");\n    await backend.storeFor(OTHER).upsertNumber(number());\n    await expect(backend.storeFor(OWNER).createDialRequest(dial())).rejects.toThrow(\"phone_number_not_authorized\");\n    await expect(backend.storeFor(OTHER).createDialRequest(dial({ trunkId: \"forged-trunk\" }))).rejects.toThrow(\"phone_number_not_authorized\");\n    await backend.storeFor(OTHER).upsertNumber(number({ status: \"suspended\" }));\n    await expect(backend.storeFor(OTHER).createDialRequest(dial())).rejects.toThrow(\"phone_number_not_authorized\");\n    expect(await backend.storeFor(OWNER).listCalls()).toEqual([]);\n  });\n\n  it(\"creates one durable call under concurrent dial retries and rejects changed targets\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    const results = await Promise.all([store.createDialRequest(dial()), store.createDialRequest(dial({}, \"retry-room\"))]);\n    expect(results.filter(r => r.created)).toHaveLength(1);\n    expect(results[0]?.call.id).toBe(results[1]?.call.id);\n    expect(await store.listCalls()).toHaveLength(1);\n    await expect(store.createDialRequest(dial({ to: \"+14155550103\" }))).rejects.toThrow(\"phone_dial_request_conflict\");\n    await expect(store.createDialRequest(dial({ dialRequestId: \"different-request\" }))).rejects.toThrow(\"phone_dial_request_conflict\");\n  });\n\n  it(\"deduplicates concurrent callbacks and rejects mutated receipts or provider identity\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    await store.createDialRequest(dial());\n    const e = event(\"answered\");\n    const results = await Promise.all([store.reconcileProviderEvent(e), store.reconcileProviderEvent(e)]);\n    expect(results.filter(r => r?.applied)).toHaveLength(1);\n    expect((await store.getCall(\"dial-a\"))?.status).toBe(\"live\");\n    await expect(store.reconcileProviderEvent({ ...e, type: \"failed\" })).rejects.toThrow(\"phone_provider_event_conflict\");\n    await expect(store.reconcileProviderEvent(event(\"ended\", { providerAccountId: \"foreign-account\" }))).rejects.toThrow(\"phone_provider_binding_mismatch\");\n    await expect(store.reconcileProviderEvent(event(\"ended\", { providerCallId: \"foreign-call\" }))).rejects.toThrow(\"phone_provider_binding_mismatch\");\n    expect(await backend.storeFor(OTHER).reconcileProviderEvent(e)).toBeNull();\n  });\n\n  it(\"reconciles end-before-answer, preserves measured duration and ignores stale media snapshots\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    const original = dial();\n    await store.createDialRequest(original);\n    await store.reconcileProviderEvent(event(\"ended\", { occurredAt: \"2026-08-31T12:00:30.000Z\" }));\n    expect((await store.getCall(\"dial-a\"))?.durationSec).toBeNull();\n    await store.reconcileProviderEvent(event(\"answered\"));\n    await store.reconcileProviderEvent(event(\"ringing\", { occurredAt: \"2026-08-31T12:00:05.000Z\" }));\n    await store.upsertCall(original);\n    const stored = await store.getCall(\"dial-a\");\n    expect(stored?.status).toBe(\"completed\");\n    expect(stored?.durationSec).toBe(20);\n    expect(stored?.endedAt).toBe(\"2026-08-31T12:00:30.000Z\");\n    expect(stored?.telephony?.lastEventAt).toBe(\"2026-08-31T12:00:30.000Z\");\n    await store.upsertNumber(number({ status: \"suspended\" }));\n    const retry = await store.createDialRequest(dial({}, \"later-room\"));\n    expect(retry.created).toBe(false);\n    expect(retry.call).toEqual(stored);\n  });\n\n  it(\"makes equal-time terminal outcomes deterministic and never invents connected duration\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertNumber(number());\n    await store.createDialRequest(dial());\n    await store.reconcileProviderEvent(event(\"ended\"));\n    await store.reconcileProviderEvent(event(\"failed\"));\n    expect((await store.getCall(\"dial-a\"))?.status).toBe(\"failed\");\n    expect((await store.getCall(\"dial-a\"))?.durationSec).toBeNull();\n    await store.createDialRequest(dial({ dialRequestId: \"request-b\" }, \"dial-b\"));\n    await store.reconcileProviderEvent(event(\"failed\", { callId: \"dial-b\", eventId: \"b-failed\", providerCallId: \"provider-b\" }));\n    await store.reconcileProviderEvent(event(\"ended\", { callId: \"dial-b\", eventId: \"b-ended\", providerCallId: \"provider-b\" }));\n    expect((await store.getCall(\"dial-b\"))?.status).toBe(\"failed\");\n  });\n\n  it(\"rejects attaching one provider call to another tenant and rolls back the failed receipt\", async () => {\n    const store = backend.storeFor(OWNER);\n    const other = backend.storeFor(OTHER);\n    await store.upsertNumber(number());\n    await other.upsertNumber(number({ id: \"number-b\", e164: \"+14155550103\" }));\n    await store.createDialRequest(dial());\n    await other.createDialRequest(dial({ numberId: \"number-b\", from: \"+14155550103\" }, \"dial-b\"));\n    await store.reconcileProviderEvent(event(\"answered\"));\n    await expect(other.reconcileProviderEvent(event(\"answered\", { callId: \"dial-b\", eventId: \"other-event\" }))).rejects.toThrow();\n    expect((await other.getCall(\"dial-b\"))?.status).toBe(\"dialing\");\n    expect((await other.reconcileProviderEvent(event(\"answered\", { callId: \"dial-b\", eventId: \"other-event\", providerCallId: \"provider-b\" })))?.applied).toBe(true);\n  });\n\n  it(\"retains number/dial/provider receipt bindings on repeated migrations and database reopen\", async () => {\n    await backend.storeFor(OWNER).upsertNumber(number());\n    await backend.storeFor(OWNER).createDialRequest(dial());\n    await backend.storeFor(OWNER).reconcileProviderEvent(event(\"answered\"));\n    await backend.migrate();\n    if (arm.reopen) backend = await arm.reopen(backend);\n    expect((await backend.unscoped.resolveInboundNumber(\"carrier\", \"account-a\", \"+14155550101\"))?.ownerId).toBe(OWNER);\n    expect(await backend.storeFor(OTHER).getNumber(\"number-a\")).toBeNull();\n    const retry = await backend.storeFor(OWNER).createDialRequest(dial({}, \"new-room\"));\n    expect(retry.created).toBe(false);\n    expect(retry.call.telephony?.providerCallId).toBe(\"provider-call-a\");\n    expect((await backend.storeFor(OWNER).reconcileProviderEvent(event(\"answered\")))?.applied).toBe(false);\n  });\n\n  beforeEach(async () => {\n    backend = await arm.create();\n    await arm.reset(backend);\n  });\n\n  afterAll(async () => {\n    if (backend) await arm.teardown(backend);\n  });\n\n  it(\"keeps one owner's calls out of another's reads\", async () => {\n    await backend.storeFor(OWNER).upsertCall(call({ id: \"room-1\" }));\n    await backend.storeFor(OTHER).upsertCall(call({ id: \"room-2\" }));\n\n    expect((await backend.storeFor(OWNER).listCalls()).map((c) => c.id)).toEqual([\"room-1\"]);\n    expect(await backend.storeFor(OWNER).getCall(\"room-2\")).toBeNull();\n  });\n\n  it(\"does not move startedAt when a call is re-upserted\", async () => {\n    // A guest rejoining a booked room re-upserts the same call. A drifting\n    // start would silently restate when the call began.\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.upsertCall(call({ id: \"room-1\", startedAt: \"2027-01-01T00:00:00.000Z\", status: \"live\" }));\n\n    const stored = await store.getCall(\"room-1\");\n    expect(stored?.startedAt).toContain(\"2026-08-31\");\n    expect(stored?.status).toBe(\"live\");\n  });\n\n  it(\"preserves distinct agent-chat and Papercup parent links across status-only upserts\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({\n      id: \"room-bound\",\n      conversationId: \"chat-123\",\n      parentOperatorConversationId: \"operator-active\",\n    }));\n    await store.upsertCall(call({\n      id: \"room-bound\",\n      conversationId: null,\n      parentOperatorConversationId: null,\n      status: \"live\",\n    }));\n\n    expect(await store.getCall(\"room-bound\")).toMatchObject({\n      id: \"room-bound\",\n      conversationId: \"chat-123\",\n      parentOperatorConversationId: \"operator-active\",\n    });\n  });\n\n  it(\"returns every timestamp as ISO-8601 UTC, identically in both stores\", async () => {\n    // The divergence this pins is INVISIBLE to the type system: both stores\n    // return `string`, but `::text` on a timestamptz renders Postgres' own\n    // session-local format (\"2026-08-31 08:03:44-04\") while the memory store\n    // echoes the ISO string it was given. A consumer doing `new Date(value)`\n    // gets a lenient V8 parse that works here and yields NaN elsewhere, and a\n    // guest is then shown \"Invalid Date\" for a booking that is perfectly fine.\n    const ISO = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/;\n    const store = backend.storeFor(OWNER);\n\n    await store.upsertCall(call({ id: \"room-iso\", status: \"completed\", endedAt: \"2026-08-31T12:30:00.000Z\" }));\n    await store.appendTranscript([\n      { callId: \"room-iso\", seq: 0, speaker: \"caller\", text: \"hello\", at: \"2026-08-31T12:05:00.000Z\" },\n    ]);\n    await store.saveVoicemail({\n      callId: \"room-iso\",\n      transcript: \"left a message\",\n      durationSec: 12,\n      callerLabel: \"Ada\",\n      createdAt: \"2026-08-31T12:10:00.000Z\",\n      readAt: null,\n    });\n    await store.createScheduledCall({\n      id: \"sched-iso\",\n      title: \"Intro\",\n      guestName: \"Ada\",\n      guestEmail: null,\n      scheduledFor: \"2026-09-01T15:00:00.000Z\",\n      durationMin: 30,\n      roomName: \"phone-booked-sched-iso\",\n      inviteToken: \"tok-iso\",\n      status: \"scheduled\",\n      createdAt: \"2026-08-31T12:00:00.000Z\",\n      callId: null,\n    });\n\n    const stored = await store.getCall(\"room-iso\");\n    expect(stored?.startedAt).toMatch(ISO);\n    expect(stored?.endedAt).toMatch(ISO);\n    expect((await store.listTranscript(\"room-iso\"))[0]!.at).toMatch(ISO);\n\n    const voicemail = (await store.listVoicemails())[0]!;\n    expect(voicemail.createdAt).toMatch(ISO);\n    // A nullable timestamp must stay null, not become the string \"null\".\n    expect(voicemail.readAt).toBeNull();\n\n    const scheduled = (await store.listScheduledCalls())[0]!;\n    expect(scheduled.scheduledFor).toMatch(ISO);\n    expect(scheduled.createdAt).toMatch(ISO);\n    // The value must survive the round trip, not merely LOOK like ISO.\n    expect(scheduled.scheduledFor).toBe(\"2026-09-01T15:00:00.000Z\");\n\n    // The unscoped guest lookup is the one a visitor's invite page reads, so\n    // it gets the same assertion rather than inheriting it by assumption.\n    const byToken = await backend.unscoped.findScheduledByToken(\"tok-iso\");\n    expect(byToken?.scheduledFor).toBe(\"2026-09-01T15:00:00.000Z\");\n  });\n\n  it(\"never blanks a stored summary on a later status write\", async () => {\n    // The call-end leg and the liveness reconciler are different writers\n    // finishing in an order nothing guarantees.\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.upsertCall(call({ id: \"room-1\", summary: \"caller asked about billing\" }));\n    await store.upsertCall(call({ id: \"room-1\", status: \"completed\", summary: null }));\n\n    expect((await store.getCall(\"room-1\"))?.summary).toBe(\"caller asked about billing\");\n  });\n\n  it(\"replaces a re-sent transcript segment instead of duplicating it\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.appendTranscript([\n      { callId: \"room-1\", seq: 0, speaker: \"caller\", text: \"first\", at: new Date().toISOString() },\n    ]);\n    await store.appendTranscript([\n      { callId: \"room-1\", seq: 0, speaker: \"caller\", text: \"corrected\", at: new Date().toISOString() },\n      { callId: \"room-1\", seq: 1, speaker: \"assistant\", text: \"reply\", at: new Date().toISOString() },\n    ]);\n\n    const segments = await store.listTranscript(\"room-1\");\n    expect(segments.map((s) => s.text)).toEqual([\"corrected\", \"reply\"]);\n  });\n\n  it(\"orders transcript by seq, not by arrival\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.appendTranscript([\n      { callId: \"room-1\", seq: 2, speaker: \"caller\", text: \"third\", at: new Date().toISOString() },\n      { callId: \"room-1\", seq: 0, speaker: \"caller\", text: \"first\", at: new Date().toISOString() },\n      { callId: \"room-1\", seq: 1, speaker: \"assistant\", text: \"second\", at: new Date().toISOString() },\n    ]);\n    expect((await store.listTranscript(\"room-1\")).map((s) => s.text)).toEqual([\"first\", \"second\", \"third\"]);\n  });\n\n  it(\"finds a call by words spoken inside it\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\", callerLabel: \"Dana\" }));\n    await store.upsertCall(call({ id: \"room-2\", callerLabel: \"Sam\" }));\n    await store.appendTranscript([\n      { callId: \"room-1\", seq: 0, speaker: \"caller\", text: \"I wanted to ask about the invoice\", at: new Date().toISOString() },\n    ]);\n    await store.appendTranscript([\n      { callId: \"room-2\", seq: 0, speaker: \"caller\", text: \"just calling to say hello\", at: new Date().toISOString() },\n    ]);\n\n    const hits = await store.searchCalls(\"invoice\");\n    expect(hits.map((h) => h.call.id)).toEqual([\"room-1\"]);\n  });\n\n  it(\"treats an empty query as 'everything recent', not as 'nothing matched'\", async () => {\n    // A blank search box rendering an empty call log is the bug this pins.\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.upsertCall(call({ id: \"room-2\" }));\n    expect((await store.searchCalls(\"   \")).length).toBe(2);\n  });\n\n  it(\"does not leak another owner's call into a search\", async () => {\n    await backend.storeFor(OTHER).upsertCall(call({ id: \"room-9\", callerLabel: \"Dana\" }));\n    await backend.storeFor(OTHER).appendTranscript([\n      { callId: \"room-9\", seq: 0, speaker: \"caller\", text: \"invoice question\", at: new Date().toISOString() },\n    ]);\n    expect(await backend.storeFor(OWNER).searchCalls(\"invoice\")).toEqual([]);\n  });\n\n  it(\"preserves the first arrival and owner read state across voicemail replay and restart\", async () => {\n    let store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-replay\" }));\n    const message = { callId: \"room-replay\", transcript: \"please call back\", durationSec: 12,\n      callerLabel: \"Dana\", createdAt: \"2026-10-01T12:00:00.000Z\", readAt: null };\n    await store.saveVoicemail({ ...message });\n    expect(await store.markVoicemailRead(message.callId)).toBe(true);\n    const readAt = (await store.listVoicemails())[0]!.readAt;\n    if (arm.reopen) backend = await arm.reopen(backend);\n    store = backend.storeFor(OWNER);\n    await store.saveVoicemail({ ...message, transcript: \"please call back about billing\",\n      createdAt: \"2026-10-02T12:00:00.000Z\" });\n    expect(await store.listVoicemails()).toEqual([{ ...message,\n      transcript: \"please call back about billing\", readAt }]);\n    expect(await store.markVoicemailRead(message.callId)).toBe(false);\n    expect(await backend.storeFor(OTHER).listVoicemails()).toEqual([]);\n    expect(await backend.storeFor(OTHER).markVoicemailRead(message.callId)).toBe(false);\n  });\n\n  it(\"does not let voicemail input or read snapshots mutate stored read state\", async () => {\n    const store = backend.storeFor(OWNER);\n    const message = { callId: \"room-snapshot\", transcript: \"private message\", durationSec: 3,\n      callerLabel: \"Dana\", createdAt: \"2026-10-01T12:00:00.000Z\", readAt: null as string | null };\n    await store.saveVoicemail(message);\n    message.transcript = \"changed outside store\";\n    message.readAt = \"2026-10-02T12:00:00.000Z\";\n    expect((await store.listVoicemails())[0]).toMatchObject({ transcript: \"private message\", readAt: null });\n    const snapshot = (await store.listVoicemails())[0]!;\n    snapshot.transcript = \"changed snapshot\";\n    snapshot.readAt = \"2026-10-02T12:00:00.000Z\";\n    expect(await store.markVoicemailRead(message.callId)).toBe(true);\n    expect((await store.listVoicemails())[0]!.transcript).toBe(\"private message\");\n  });\n\n  it(\"marks a voicemail read exactly once\", async () => {\n    const store = backend.storeFor(OWNER);\n    await store.upsertCall(call({ id: \"room-1\" }));\n    await store.saveVoicemail({\n      callId: \"room-1\",\n      transcript: \"please call me back\",\n      durationSec: null,\n      callerLabel: \"Dana\",\n      createdAt: new Date().toISOString(),\n      readAt: null,\n    });\n\n    expect(await store.markVoicemailRead(\"room-1\")).toBe(true);\n    // Second click is a no-op, and says so — not an error, not a re-stamp.\n    expect(await store.markVoicemailRead(\"room-1\")).toBe(false);\n    expect((await store.listVoicemails())[0]?.readAt).toBeTruthy();\n  });\n\n  it(\"resolves a booking by its invite token across owners, and the owner with it\", async () => {\n    const scheduled = {\n      id: \"booking-1\",\n      title: \"Intro call\",\n      guestName: \"Dana\",\n      guestEmail: null,\n      scheduledFor: new Date(\"2026-09-01T15:00:00.000Z\").toISOString(),\n      durationMin: 30,\n      roomName: \"phone-booked-booking-1\",\n      inviteToken: \"tok_abc123\",\n      status: \"scheduled\" as const,\n      createdAt: new Date().toISOString(),\n      callId: null,\n    };\n    await backend.storeFor(OWNER).createScheduledCall(scheduled);\n\n    const found = await backend.unscoped.findScheduledByToken(\"tok_abc123\");\n    expect(found?.id).toBe(\"booking-1\");\n    expect(await backend.unscoped.ownerOfScheduled(\"booking-1\")).toBe(OWNER);\n    expect(await backend.unscoped.findScheduledByToken(\"tok_wrong\")).toBeNull();\n  });\n\n  it(\"resolves the owner of a room, which is the worker's only route to one\", async () => {\n    await backend.storeFor(OWNER).upsertCall(call({ id: \"room-1\" }));\n    expect(await backend.unscoped.ownerOfCall(\"room-1\")).toBe(OWNER);\n    expect(await backend.unscoped.ownerOfCall(\"room-nope\")).toBeNull();\n  });\n\n  it(\"records a join against the booking\", async () => {\n    await backend.storeFor(OWNER).createScheduledCall({\n      id: \"booking-1\",\n      title: \"Intro\",\n      guestName: \"Dana\",\n      guestEmail: null,\n      scheduledFor: new Date().toISOString(),\n      durationMin: 30,\n      roomName: \"phone-booked-booking-1\",\n      inviteToken: \"tok_join\",\n      status: \"scheduled\",\n      createdAt: new Date().toISOString(),\n      callId: null,\n    });\n    expect(await backend.unscoped.markJoined(\"booking-1\", \"phone-booked-booking-1\")).toBe(true);\n\n    const [stored] = await backend.storeFor(OWNER).listScheduledCalls();\n    expect(stored?.status).toBe(\"joined\");\n    expect(stored?.callId).toBe(\"phone-booked-booking-1\");\n  });\n});\n",
        "headBlob": "4982e3af261d584b36ca8c350225d26a8591322b",
        "headBlobDescribes": "historical HEAD version, NOT the captured working bytes; sha256 identifies captured content"
      },
      {
        "path": "apps/sidecar/src/voicemail-persistence.e2e.test.ts",
        "sha256": "ce49405a1d5832325ee3e4f3f363fc9f8cc47f969f5c5260f251b6cbf86f730f",
        "content": "import { afterAll, beforeAll, expect, it, vi } from \"vitest\";\nimport { spawn, type ChildProcess } from \"node:child_process\";\nimport { mkdtemp, readFile, rm } from \"node:fs/promises\";\nimport { tmpdir } from \"node:os\";\nimport { join } from \"node:path\";\nimport { fileURLToPath } from \"node:url\";\nimport postgres from \"postgres\";\nimport { SignJWT } from \"jose\";\nimport { createPostgresPhoneBackend, type CallSearchHit, type PhoneBackend,\n  type StoredCall, type TranscriptSegment, type Voicemail } from \"@phone/data\";\nimport type { CallContentExport } from \"@phone/data\";\nimport { startPhoneEmbeddedPostgres, type PhoneEmbeddedPostgres } from \"@phone/embedded-postgres-server\";\n\n// Real child sidecar + real disposable Postgres. Carrier state and message\n// text are fixtures; this test makes no public audio or PSTN claim.\nlet home: string, pg: PhoneEmbeddedPostgres, backend: PhoneBackend;\nlet child: ChildProcess | undefined, exited: Promise<void>;\nlet url: string;\nconst authSecret = \"p009-test-auth-secret-p009-test-auth-secret\";\nconst workerHeaders = { \"x-phone-worker-secret\": \"p009-test-worker-secret\", \"content-type\": \"application/json\" };\n\nasync function startSidecar() {\n  const discovery = join(home, \"sidecar.json\");\n  let output = \"\";\n  child = spawn(process.execPath, [\"--import\", import.meta.resolve(\"tsx\"),\n    fileURLToPath(new URL(\"./index.ts\", import.meta.url))], {\n    env: { ...process.env, PHONE_HOME: home, PHONE_DISCOVERY_FILE: discovery,\n      PHONE_HTTP_PORT: \"0\", PORT: \"0\", PHONE_DATABASE_URL: pg.url,\n      PHONE_USE_MEMORY_STORE: \"0\", PHONE_LOCAL_MODE: \"0\",\n      PHONE_LIVEKIT_URL: \"ws://127.0.0.1:1\", PHONE_LIVEKIT_PUBLIC_URL: \"wss://media.test\",\n      PHONE_LIVEKIT_API_KEY: \"fixture\", PHONE_LIVEKIT_API_SECRET: \"fixture-secret-fixture-secret-fixture-secret\",\n      PORTAL_PHONE_AUTH_SECRET: authSecret, PHONE_AUTH_SECRET: authSecret,\n      PHONE_WORKER_SECRET: workerHeaders[\"x-phone-worker-secret\"],\n      PHONE_OPERATOR_ORIGIN: \"http://127.0.0.1:1\", PAPERCUSP_WORKSPACE: \"test-workspace\" },\n    stdio: [\"ignore\", \"pipe\", \"pipe\"],\n  });\n  child.stdout?.on(\"data\", data => { output = (output + String(data)).slice(-4000); });\n  child.stderr?.on(\"data\", data => { output = (output + String(data)).slice(-4000); });\n  exited = new Promise<void>((resolve, reject) => {\n    child!.once(\"exit\", () => resolve());\n    child!.once(\"error\", reject);\n  });\n  await vi.waitFor(async () => {\n    if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`sidecar exited: ${output}`);\n    try {\n      url = (JSON.parse(await readFile(discovery, \"utf8\")) as { url: string }).url;\n      const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });\n      if (!health.ok) throw new Error(`health HTTP ${health.status}: ${await health.text()}`);\n      expect(await health.json()).toMatchObject({ ok: true, service: \"papercusp-phone\" });\n    } catch (error) { throw new Error(`sidecar not ready: ${String(error)}\\n${output}`); }\n  }, { timeout: 20_000, interval: 100 });\n}\n\nasync function stopSidecar(signal: NodeJS.Signals = \"SIGTERM\") {\n  if (!child) return;\n  child.kill(signal);\n  let timeout: ReturnType<typeof setTimeout>;\n  try {\n    await Promise.race([exited, new Promise<never>((_, reject) => {\n      timeout = setTimeout(() => { child!.kill(\"SIGKILL\"); reject(new Error(\"sidecar exit deadline\")); }, 5000);\n    })]);\n  } finally { clearTimeout(timeout!); child = undefined; }\n}\n\nasync function headers(owner: string) {\n  const token = await new SignJWT({}).setProtectedHeader({ alg: \"HS256\" })\n    .setSubject(owner).setAudience(\"papercusp-phone\").setIssuer(\"papercusp-portal\").setIssuedAt().setExpirationTime(\"60s\")\n    .sign(new TextEncoder().encode(authSecret));\n  return { authorization: `Bearer ${token}` };\n}\nasync function read(path: string, owner: string) {\n  const response = await fetch(`${url}${path}`, { headers: await headers(owner) });\n  expect(response.status).toBe(200);\n  return response.json() as Promise<{ voicemails: Voicemail[]; calls: StoredCall[];\n    segments: TranscriptSegment[]; hits: CallSearchHit[];\n    summary: { unreadVoicemail: number; activeCalls: number } }>;\n}\nasync function post(path: string, body: unknown) {\n  const response = await fetch(`${url}${path}`, { method: \"POST\", headers: workerHeaders, body: JSON.stringify(body) });\n  expect(response.status).toBe(200);\n  expect(await response.json()).toMatchObject({ ok: true });\n}\n\nbeforeAll(async () => {\n  home = await mkdtemp(join(tmpdir(), \"phone-p009-e2e-\"));\n  pg = await startPhoneEmbeddedPostgres({ home });\n  backend = createPostgresPhoneBackend(postgres(pg.url, { max: 2, onnotice() {} }));\n  await backend.migrate();\n  await backend.storeFor(\"tenant-a\").upsertCall({ id: \"message-a\", roomName: \"message-a\", conversationId: null,\n    parentOperatorConversationId: null, direction: \"inbound\", status: \"completed\", callerLabel: \"Dana\",\n    disposition: \"voicemail\", startedAt: \"2026-10-01T12:00:00.000Z\", endedAt: \"2026-10-01T12:00:12.000Z\",\n    durationSec: 12, summary: null, telephony: { numberId: \"n-a\", assistantId: \"assistant-a\",\n      provider: \"fixture\", providerAccountId: \"account-a\", trunkId: \"trunk-a\", providerCallId: \"fixture-a\",\n      dialRequestId: null, from: \"+14155550102\", to: \"+14155550101\", connectedAt: \"2026-10-01T12:00:00.000Z\",\n      lastEventAt: \"2026-10-01T12:00:12.000Z\" } });\n  await backend.close();\n  await startSidecar();\n}, 120_000);\n\nafterAll(async () => {\n  await stopSidecar();\n  if (backend) await backend.close();\n  if (pg) await pg.stop();\n  if (home) await rm(home, { recursive: true, force: true });\n}, 15_000);\n\nit(\"retains acknowledged voicemail, transcript, read state and tenant scope through sidecar crash and database restart\", async () => {\n  const voicemail = { ownerId: \"tenant-b\", transcript: \"Please call back about billing\", durationSec: 12 };\n  const transcript = { ownerId: \"tenant-b\", segments: [\n    { seq: 1, speaker: \"assistant\", text: \"I will pass it on\", at: \"2026-10-01T12:00:08.000Z\" },\n    { seq: 0, speaker: \"caller\", text: \"A billing question\", at: \"2026-10-01T12:00:04.000Z\" },\n  ] };\n  await post(\"/internal/calls/message-a/voicemail\", voicemail);\n  await post(\"/internal/calls/message-a/transcript\", transcript);\n  await post(\"/internal/calls/message-a/summary\", { summary: \"Caller left a billing message\" });\n  expect((await read(\"/api/summary\", \"tenant-a\")).summary).toMatchObject({ unreadVoicemail: 1, activeCalls: 0 });\n  const marked = await fetch(`${url}/api/voicemail/message-a/read`, { method: \"POST\", headers: await headers(\"tenant-a\") });\n  expect(await marked.json()).toMatchObject({ ok: true, changed: true });\n  const saved = (await read(\"/api/voicemail\", \"tenant-a\")).voicemails;\n  await stopSidecar(\"SIGKILL\");\n  await pg.stop();\n  pg = await startPhoneEmbeddedPostgres({ home });\n  await startSidecar();\n  expect((await read(\"/api/voicemail\", \"tenant-a\")).voicemails).toEqual(saved);\n  await post(\"/internal/calls/message-a/voicemail\", voicemail);\n  await post(\"/internal/calls/message-a/transcript\", transcript);\n  expect((await read(\"/api/voicemail\", \"tenant-a\")).voicemails).toEqual(saved);\n  expect((await read(\"/api/summary\", \"tenant-a\")).summary).toMatchObject({ unreadVoicemail: 0, activeCalls: 0 });\n  const segments = (await read(\"/api/calls/message-a/transcript\", \"tenant-a\")).segments;\n  expect(segments.map((segment: { text: string }) => segment.text)).toEqual([\"A billing question\", \"I will pass it on\"]);\n  expect((await read(\"/api/calls/search?q=billing\", \"tenant-a\")).hits).toHaveLength(1);\n  expect((await read(\"/api/calls\", \"tenant-a\")).calls).toMatchObject([{ status: \"completed\",\n    durationSec: 12, disposition: \"voicemail\", summary: \"Caller left a billing message\" }]);\n  for (const [path, key] of [[\"/api/voicemail\", \"voicemails\"], [\"/api/calls/message-a/transcript\", \"segments\"],\n    [\"/api/calls\", \"calls\"], [\"/api/calls/search?q=billing\", \"hits\"]] as const) {\n    expect((await read(path, \"tenant-b\"))[key]).toEqual([]);\n  }\n  expect((await fetch(`${url}/api/voicemail`)).status).toBe(401);\n  const deniedRead = await fetch(`${url}/api/voicemail/message-a/read`, { method: \"POST\", headers: await headers(\"tenant-b\") });\n  expect(await deniedRead.json()).toMatchObject({ ok: true, changed: false });\n}, 60_000);\n\nit(\"exports only authenticated tenant content after sidecar and database restart\", async () => {\n  backend = createPostgresPhoneBackend(postgres(pg.url, { max: 2, onnotice() {} }));\n  const call: StoredCall = { id: \"export-message\", roomName: \"export-message\", conversationId: null,\n    parentOperatorConversationId: \"private-parent\", direction: \"inbound\", status: \"completed\",\n    callerLabel: \"Dana\", disposition: \"voicemail\", startedAt: \"2026-10-01T12:00:00.000Z\",\n    endedAt: \"2026-10-01T12:00:12.000Z\", durationSec: 12, summary: \"Exportable message\",\n    recordingUri: \"s3://private-fixture/message.ogg\" };\n  await backend.storeFor(\"tenant-a\").upsertCall(call);\n  await backend.storeFor(\"tenant-a\").appendTranscript([\n    { callId: call.id, seq: 0, speaker: \"caller\", text: \"Exportable transcript\", at: call.startedAt },\n  ]);\n  await backend.storeFor(\"tenant-a\").saveVoicemail({ callId: call.id, transcript: \"Exportable voicemail\",\n    durationSec: 12, callerLabel: \"Dana\", createdAt: call.startedAt, readAt: null });\n  await backend.close();\n  const path = `/api/calls/${call.id}/export`;\n  const download = async () => {\n    const response = await fetch(`${url}${path}?ownerId=tenant-b`, { headers: await headers(\"tenant-a\") });\n    expect(response.status).toBe(200);\n    expect(response.headers.get(\"cache-control\")).toBe(\"private, no-store\");\n    return response.json() as Promise<{ content: CallContentExport }>;\n  };\n  const before = await download();\n  expect(before.content).toMatchObject({ call: { id: call.id, summary: \"Exportable message\" },\n    segments: [{ text: \"Exportable transcript\" }], voicemail: { transcript: \"Exportable voicemail\" } });\n  expect(JSON.stringify(before)).not.toContain(\"private-fixture\");\n  expect(JSON.stringify(before)).not.toContain(\"private-parent\");\n  await stopSidecar(\"SIGKILL\"); await pg.stop();\n  pg = await startPhoneEmbeddedPostgres({ home }); await startSidecar();\n  expect(await download()).toEqual(before);\n  expect((await fetch(`${url}${path}`, { headers: await headers(\"tenant-b\") })).status).toBe(404);\n  expect((await fetch(`${url}${path}`)).status).toBe(401);\n  expect((await fetch(`${url}${path}`, { headers: workerHeaders })).status).toBe(401);\n}, 60_000);\n\nit(\"keeps authenticated deletion effective through worker replay, sidecar crash and database restart\", async () => {\n  backend = createPostgresPhoneBackend(postgres(pg.url, { max: 2, onnotice() {} }));\n  const call: StoredCall = { id: \"delete-message\", roomName: \"delete-message\", conversationId: null,\n    parentOperatorConversationId: null, direction: \"inbound\", status: \"completed\", callerLabel: \"Privatecaller\",\n    disposition: \"voicemail\", startedAt: \"2026-10-01T12:00:00.000Z\", endedAt: \"2026-10-01T12:00:12.000Z\",\n    durationSec: 12, summary: \"privatedeletee2e\" };\n  await backend.storeFor(\"tenant-a\").upsertCall(call); await backend.close();\n  const transcript = { segments: [{ seq: 0, speaker: \"caller\", text: \"privatedeletee2e\" }] }, mail = { transcript: \"privatedeletee2e\" };\n  await post(`/internal/calls/${call.id}/transcript`, transcript);\n  await post(`/internal/calls/${call.id}/voicemail`, mail);\n  const path = `/api/calls/${call.id}/content`, remove = async (owner: string) =>\n    fetch(`${url}${path}?ownerId=tenant-b`, { method: \"DELETE\", headers: await headers(owner) });\n  expect((await remove(\"tenant-b\")).status).toBe(404);\n  expect((await fetch(`${url}${path}`, { method: \"DELETE\" })).status).toBe(401);\n  expect((await fetch(`${url}${path}`, { method: \"DELETE\", headers: workerHeaders })).status).toBe(401);\n  const response = await remove(\"tenant-a\"); expect(response.status).toBe(200);\n  const result = await response.json(); expect(result).toMatchObject({ ok: true, scope: \"phone-store\", deletedAt: expect.any(String) });\n  await stopSidecar(\"SIGKILL\"); await pg.stop();\n  pg = await startPhoneEmbeddedPostgres({ home }); await startSidecar();\n  expect(await (await remove(\"tenant-a\")).json()).toEqual(result);\n  for (const [kind, body] of [[\"transcript\", transcript], [\"voicemail\", mail], [\"summary\", { summary: \"privatedeletee2e\" }]] as const) {\n    const replay = await fetch(`${url}/internal/calls/${call.id}/${kind}`, { method: \"POST\", headers: workerHeaders, body: JSON.stringify(body) });\n    expect(replay.status).toBe(410); expect(await replay.json()).toEqual({ ok: false, error: \"phone_content_deleted\" });\n  }\n  const exported = await fetch(`${url}/api/calls/${call.id}/export`, { headers: await headers(\"tenant-a\") });\n  expect(await exported.json()).toMatchObject({ content: { call: { summary: null, callerLabel: null }, segments: [], voicemail: null } });\n  expect((await read(\"/api/calls/search?q=privatedeletee2e\", \"tenant-a\")).hits).toEqual([]);\n  expect((await read(\"/api/calls\", \"tenant-a\")).calls.find(c => c.id === call.id)).toMatchObject({ contentDeletedAt: expect.any(String) });\n}, 60_000);\n\nit(\"does not expose a failed transcript batch after sidecar crash and database restart, then accepts a replay\", async () => {\n  const callId = \"atomic-transcript\", original = {\n    seq: 0, speaker: \"caller\", text: \"originalatomicsearch\", at: \"2026-10-01T12:00:04.000Z\",\n  };\n  const batch = { segments: [{ ...original, text: \"replacementatomicsearch\" },\n    { ...original, seq: 1, text: \"newatomicsearch\" }] };\n  let sql = postgres(pg.url, { max: 2, onnotice() {} });\n  let control = createPostgresPhoneBackend(sql);\n  try {\n    await control.storeFor(\"tenant-a\").upsertCall({ id: callId, roomName: callId,\n      conversationId: null, parentOperatorConversationId: null, direction: \"inbound\",\n      status: \"completed\", callerLabel: null, disposition: null,\n      startedAt: \"2026-10-01T12:00:00.000Z\", endedAt: null, durationSec: null, summary: null });\n    await post(`/internal/calls/${callId}/transcript`, { segments: [original] });\n    await sql.unsafe(`CREATE FUNCTION phone_e2e_reject_projection() RETURNS trigger LANGUAGE plpgsql AS $$\n      BEGIN IF NEW.id = 'atomic-transcript' THEN RAISE EXCEPTION 'fixture_atomic_projection_failure'; END IF;\n      RETURN NEW; END $$`);\n    await sql.unsafe(\"CREATE TRIGGER phone_e2e_reject_projection BEFORE UPDATE OF transcript_text ON phone_calls FOR EACH ROW EXECUTE FUNCTION phone_e2e_reject_projection()\");\n    const response = await fetch(`${url}/internal/calls/${callId}/transcript`, {\n      method: \"POST\", headers: workerHeaders, body: JSON.stringify(batch),\n    });\n    expect(response.status).toBe(500);\n    expect((await read(`/api/calls/${callId}/transcript`, \"tenant-a\")).segments).toEqual([{ ...original, callId }]);\n    expect((await read(\"/api/calls/search?q=originalatomicsearch\", \"tenant-a\")).hits).toHaveLength(1);\n    expect((await read(\"/api/calls/search?q=newatomicsearch\", \"tenant-a\")).hits).toEqual([]);\n    await control.close();\n    await stopSidecar(\"SIGKILL\"); await pg.stop();\n    pg = await startPhoneEmbeddedPostgres({ home }); await startSidecar();\n    sql = postgres(pg.url, { max: 2, onnotice() {} }); control = createPostgresPhoneBackend(sql);\n    expect((await read(`/api/calls/${callId}/transcript`, \"tenant-a\")).segments).toEqual([{ ...original, callId }]);\n    expect((await read(\"/api/calls/search?q=newatomicsearch\", \"tenant-a\")).hits).toEqual([]);\n    await sql.unsafe(\"DROP TRIGGER phone_e2e_reject_projection ON phone_calls\");\n    await post(`/internal/calls/${callId}/transcript`, batch);\n    await Promise.all([post(`/internal/calls/${callId}/transcript`, batch), post(`/internal/calls/${callId}/transcript`, batch)]);\n    expect((await read(`/api/calls/${callId}/transcript`, \"tenant-a\")).segments).toEqual(batch.segments.map(s => ({ ...s, callId })));\n    expect((await read(\"/api/calls/search?q=newatomicsearch\", \"tenant-a\")).hits).toHaveLength(1);\n    expect((await read(\"/api/calls/search?q=originalatomicsearch\", \"tenant-a\")).hits).toEqual([]);\n    expect((await read(`/api/calls/${callId}/transcript`, \"tenant-b\")).segments).toEqual([]);\n    expect((await read(\"/api/calls/search?q=newatomicsearch\", \"tenant-b\")).hits).toEqual([]);\n  } finally {\n    await sql.unsafe(\"DROP TRIGGER IF EXISTS phone_e2e_reject_projection ON phone_calls\");\n    await sql.unsafe(\"DROP FUNCTION IF EXISTS phone_e2e_reject_projection()\");\n    await control.close();\n  }\n}, 60_000);\n",
        "headBlob": "64d6e209d85b6c5d49aa382e28ef7c977f46a733",
        "headBlobDescribes": "historical HEAD version, NOT the captured working bytes; sha256 identifies captured content"
      },
      {
        "path": "packages/data/src/call-deletion.integration.test.ts",
        "sha256": "a9605b24127f13bc663dfb9111a117a58aaa02610e5f4c57e7bdc2fe26f80fc1",
        "content": "import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from \"vitest\";\nimport { mkdtemp, rm } from \"node:fs/promises\";\nimport { randomUUID } from \"node:crypto\";\nimport { tmpdir } from \"node:os\";\nimport { join } from \"node:path\";\nimport postgres from \"postgres\";\nimport { startPhoneEmbeddedPostgres, type PhoneEmbeddedPostgres } from \"@phone/embedded-postgres-server\";\nimport { createMemoryPhoneBackend } from \"./memory-store\";\nimport { createPostgresPhoneBackend } from \"./postgres-store\";\nimport type { PhoneBackend, PhoneStore, StoredCall } from \"./types\";\n\nlet home: string, pg: PhoneEmbeddedPostgres;\nbeforeAll(async () => {\n  home = await mkdtemp(join(tmpdir(), \"phone-delete-data-\"));\n  pg = await startPhoneEmbeddedPostgres({ home });\n}, 120_000);\nafterAll(async () => {\n  if (pg) await pg.stop();\n  if (home) await rm(home, { recursive: true, force: true });\n}, 15_000);\nconst openPg = () => createPostgresPhoneBackend(postgres(pg.url, { max: 4, onnotice() {} }));\nconst segment = (call: StoredCall) => ({ callId: call.id, seq: 0, speaker: \"caller\" as const,\n  text: \"privatedeletionwords\", at: call.startedAt });\nconst voicemail = (call: StoredCall) => ({ callId: call.id, transcript: \"privatedeletionwords\",\n  durationSec: 12, callerLabel: \"Privatecaller\", createdAt: call.startedAt, readAt: null });\nasync function erased(store: PhoneStore, id: string) {\n  expect(await store.listTranscript(id)).toEqual([]);\n  expect((await store.listVoicemails()).filter(v => v.callId === id)).toEqual([]);\n  expect(await store.markVoicemailRead(id)).toBe(false);\n  expect((await store.searchCalls(\"privatedeletionwords\")).filter(hit => hit.call.id === id)).toEqual([]);\n  expect((await store.searchCalls(\"Privatecaller\")).filter(hit => hit.call.id === id)).toEqual([]);\n  expect(await store.exportCallContent(id)).toMatchObject({ call: { summary: null, callerLabel: null },\n    segments: [], voicemail: null });\n}\n\ndescribe.each([\"memory\", \"postgres\"] as const)(\"call deletion (%s)\", arm => {\n  let backend: PhoneBackend, owner: string, other: string, call: StoredCall;\n  beforeEach(async () => {\n    backend = arm === \"memory\" ? createMemoryPhoneBackend() : openPg();\n    await backend.migrate(); owner = randomUUID(); other = randomUUID();\n    call = { id: randomUUID(), roomName: randomUUID(), conversationId: null,\n      parentOperatorConversationId: null, direction: \"inbound\", status: \"completed\",\n      callerLabel: \"Privatecaller\", disposition: \"voicemail\", startedAt: \"2026-10-01T12:00:00.000Z\",\n      endedAt: \"2026-10-01T12:00:12.000Z\", durationSec: 12, summary: \"privatedeletionwords\" };\n    await backend.storeFor(owner).upsertCall(call);\n    await backend.storeFor(owner).appendTranscript([segment(call)]);\n    await backend.storeFor(owner).saveVoicemail(voicemail(call));\n  });\n  afterEach(async () => { await backend.close(); });\n\n  it(\"atomically erases message/search content and retains one idempotent replay tombstone\", async () => {\n    const store = backend.storeFor(owner);\n    const result = await store.deleteCallContent(call.id);\n    expect(result).toMatchObject({ status: \"deleted\", deletedAt: expect.any(String) });\n    expect(await store.deleteCallContent(call.id)).toEqual(result);\n    expect(await store.getCall(call.id)).toMatchObject({ status: \"completed\", durationSec: 12,\n      summary: null, callerLabel: null, contentDeletedAt: expect.any(String) });\n    await erased(store, call.id);\n    await expect(store.appendTranscript([segment(call)])).rejects.toThrow(\"phone_content_deleted\");\n    await expect(store.saveVoicemail(voicemail(call))).rejects.toThrow(\"phone_content_deleted\");\n    await expect(store.upsertCall({ ...call, status: \"live\", contentDeletedAt: null })).rejects.toThrow(\"phone_content_deleted\");\n    await erased(store, call.id);\n  });\n\n  it(\"does not distinguish foreign from missing and scopes every deletion when ids collide\", async () => {\n    const foreign = backend.storeFor(other);\n    expect(await foreign.deleteCallContent(call.id)).toEqual({ status: \"not-found\" });\n    await foreign.upsertCall(call); await foreign.appendTranscript([segment(call)]); await foreign.saveVoicemail(voicemail(call));\n    await backend.storeFor(owner).deleteCallContent(call.id);\n    expect(await foreign.exportCallContent(call.id)).toMatchObject({ call: { summary: \"privatedeletionwords\" },\n      segments: [{ text: \"privatedeletionwords\" }], voicemail: { transcript: \"privatedeletionwords\" } });\n    expect((await foreign.getCall(call.id))!.contentDeletedAt).toBeUndefined();\n  });\n\n  it(\"refuses active calls, private media and both mirrored conversation bindings without erasure\", async () => {\n    const store = backend.storeFor(owner);\n    const cases: [Partial<StoredCall>, string][] = [\n      [{ status: \"dialing\" }, \"phone_call_active\"], [{ status: \"screening\" }, \"phone_call_active\"],\n      [{ status: \"live\" }, \"phone_call_active\"],\n      [{ recordingUri: \"s3://private-fixture/recording.ogg\" }, \"phone_recording_delete_required\"],\n      [{ recordingUri: \"\" }, \"phone_recording_delete_required\"],\n      [{ conversationId: \"private-chat\" }, \"phone_mirrored_content_delete_required\"],\n      [{ parentOperatorConversationId: \"private-parent\" }, \"phone_mirrored_content_delete_required\"],\n    ];\n    for (const [patch, reason] of cases) {\n      await store.upsertCall({ ...call, recordingUri: null, ...patch });\n      const before = await store.exportCallContent(call.id);\n      expect(await store.deleteCallContent(call.id)).toEqual({ status: \"blocked\", reason });\n      expect(await store.exportCallContent(call.id)).toEqual(before);\n      expect((await store.getCall(call.id))!.contentDeletedAt).toBeUndefined();\n    }\n  });\n\n  it(\"validates a replay batch before writing any other call and ignores forged tombstones\", async () => {\n    const store = backend.storeFor(owner), second = { ...call, id: randomUUID(), roomName: randomUUID(),\n      contentDeletedAt: \"2026-01-01T00:00:00.000Z\" };\n    await store.upsertCall(second);\n    expect((await store.getCall(second.id))!.contentDeletedAt).toBeUndefined();\n    await store.deleteCallContent(call.id);\n    await expect(store.appendTranscript([segment(second), segment(call)])).rejects.toThrow(\"phone_content_deleted\");\n    expect(await store.listTranscript(second.id)).toEqual([]);\n    // Returned metadata must not be a handle that can clear the tombstone.\n    for (const row of await store.listCalls()) { row.contentDeletedAt = null; row.summary = \"tampered\"; }\n    for (const hit of await store.searchCalls(\"\")) { hit.call.contentDeletedAt = null; hit.call.summary = \"tampered\"; }\n    await expect(store.saveVoicemail(voicemail(call))).rejects.toThrow(\"phone_content_deleted\");\n    await erased(store, call.id);\n  });\n\n  it(\"serializes concurrent replay and deletion without resurrecting content\", async () => {\n    const store = backend.storeFor(owner);\n    const outcomes = await Promise.allSettled([store.appendTranscript([segment(call)]),\n      store.saveVoicemail(voicemail(call)), store.upsertCall(call), store.deleteCallContent(call.id)]);\n    expect(outcomes[3]).toMatchObject({ status: \"fulfilled\", value: { status: \"deleted\" } });\n    for (const outcome of outcomes.slice(0, 3)) {\n      if (outcome.status === \"rejected\") expect(outcome.reason.message).toBe(\"phone_content_deleted\");\n    }\n    await erased(store, call.id);\n  });\n\n  if (arm === \"postgres\") {\n    it(\"rolls back deletes if the tombstone/search update fails\", async () => {\n      const sql = postgres(pg.url, { max: 1, onnotice() {} }), store = backend.storeFor(owner);\n      const before = await store.exportCallContent(call.id);\n      await sql.unsafe(`CREATE OR REPLACE FUNCTION phone_test_reject_deletion() RETURNS trigger LANGUAGE plpgsql AS $$\n        BEGIN IF NEW.owner_id = '${owner}' THEN RAISE EXCEPTION 'fixture_deletion_failure'; END IF; RETURN NEW; END $$`);\n      await sql.unsafe(\"CREATE TRIGGER phone_test_reject_deletion BEFORE UPDATE OF content_deleted_at ON phone_calls FOR EACH ROW EXECUTE FUNCTION phone_test_reject_deletion()\");\n      try {\n        await expect(store.deleteCallContent(call.id)).rejects.toThrow(\"fixture_deletion_failure\");\n        expect(await store.exportCallContent(call.id)).toEqual(before);\n        expect(await store.searchCalls(\"privatedeletionwords\")).toHaveLength(1);\n        expect((await store.getCall(call.id))!.contentDeletedAt).toBeUndefined();\n      } finally {\n        await sql.unsafe(\"DROP TRIGGER phone_test_reject_deletion ON phone_calls\");\n        await sql.unsafe(\"DROP FUNCTION phone_test_reject_deletion()\"); await sql.end();\n      }\n      expect(await store.deleteCallContent(call.id)).toMatchObject({ status: \"deleted\" });\n      await erased(store, call.id);\n    });\n\n    it(\"keeps the tombstone and tenant scope after database process restart\", async () => {\n      const result = await backend.storeFor(owner).deleteCallContent(call.id);\n      await backend.close(); await pg.stop(); pg = await startPhoneEmbeddedPostgres({ home });\n      backend = openPg(); await backend.migrate();\n      expect(await backend.storeFor(owner).deleteCallContent(call.id)).toEqual(result);\n      expect(await backend.storeFor(other).deleteCallContent(call.id)).toEqual({ status: \"not-found\" });\n      await expect(backend.storeFor(owner).saveVoicemail(voicemail(call))).rejects.toThrow(\"phone_content_deleted\");\n      await erased(backend.storeFor(owner), call.id);\n    });\n  }\n});\n",
        "headBlob": null,
        "headBlobDescribes": "historical HEAD version, NOT the captured working bytes; sha256 identifies captured content"
      }
    ]
  },
  "actualRuns": {
    "affected": {
      "runId": "9f5eaae0-94bd-4dba-94c2-0903387abf54",
      "files": [
        {
          "path": "apps/sidecar/src/api.test.ts",
          "testRunId": 20483860,
          "passed": 44,
          "failed": 0,
          "skipped": 0
        },
        {
          "path": "apps/sidecar/src/voicemail-persistence.e2e.test.ts",
          "testRunId": 20483861,
          "passed": 4,
          "failed": 0,
          "skipped": 0
        },
        {
          "path": "packages/data/src/call-deletion.integration.test.ts",
          "testRunId": 20483862,
          "passed": 12,
          "failed": 0,
          "skipped": 0
        }
      ]
    },
    "recurring": {
      "command": "npm test",
      "exitCode": 0,
      "passedByStage": {
        "template": 15,
        "data": 68,
        "sidecar": 98,
        "workerSidecarClient": 21
      },
      "total": 202
    },
    "typecheck": {
      "commands": [
        "npx tsc --noEmit -p packages/data/tsconfig.json",
        "npx tsc --noEmit -p apps/sidecar/tsconfig.json"
      ],
      "exitCodes": [
        0,
        0
      ]
    }
  },
  "census": [
    {
      "key": "r-1",
      "barKey": "R-1",
      "model": "The approved release contract identifies launch countries, customers, supported incoming/outgoing call journeys, emergency obligations, paid-service budget and source/deployment ownership before paid provisioning or public exposure.",
      "method": "Review the retained owner decisions, provider capabilities and dated source/runtime inventory; compare each promised user journey with its implementation and evidence route.",
      "falsifier": "A required choice is silently assumed, the old browser-only shipment is treated as PSTN proof, or service is represented as primary-phone replacement without an approved emergency/compliance route.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-2",
      "barKey": "R-2",
      "model": "A signed-in user at app.papercusp.com exchanges bidirectional audio with the self-hosted media plane from an external network, including a UDP-blocked network using TURN/TLS.",
      "method": "Run authenticated remote-browser real-microphone calls on home broadband and cellular, then with UDP blocked; retain ICE-selected transport, WSS origin, peer audio receipt and lifecycle evidence.",
      "falsifier": "One-way/no audio, an insecure or loopback browser endpoint, failed certificate renewal, or dependence on LAN/hairpin connectivity.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-3",
      "barKey": "R-3",
      "model": "A provisioning operation through the approved carrier account creates a durable number record for the authorized tenant.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-4",
      "barKey": "R-4",
      "model": "An ordinary-phone incoming call reaches the assistant selected by the tenant policy.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-5",
      "barKey": "R-5",
      "model": "An authorized outbound request dials its supported E.164 destination using the correct verified caller ID.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-6",
      "barKey": "R-6",
      "model": "A Phone number record is scoped to its authorized tenant.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-7",
      "barKey": "R-7",
      "model": "A persisted voicemail or transcript remains complete after service restart.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-8",
      "barKey": "R-8",
      "model": "A real PSTN conversation provides intelligible two-way audio.",
      "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
      "falsifier": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-9",
      "barKey": "R-9",
      "model": "An outbound call requires an active tenant entitlement before dialing.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-10",
      "barKey": "R-10",
      "model": "The pinned deployment satisfies the approved capacity objective.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-11",
      "barKey": "R-11",
      "model": "An independent acceptance review passes each mandatory requirement.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-12",
      "barKey": "R-12",
      "model": "Each new or changed call, media, number, authorization, privacy, usage or recovery behavior implementing the mandatory Phone outcomes has registered unit, integration and e2e tests covering persistence, replay, restart and cross-tenant adversarial cases.",
      "method": "Extend the existing sidecar/data contract, worker integration and portal e2e suites to cover each new phone behavior; add conventional framework tests when the current suites do not fit, updating this check to those real paths before binding proof. Run the exact resulting suite and current-source evidence; enumerate coverage per behavior/R-N and retain failures/skips. Inspect test bodies to ensure the named unit/integration/e2e files actually prove the new behavior; old baseline tests alone do not pass this BAR.",
      "falsifier": "A changed required behavior has no recurrence test at its required depth, only typechecks or implementation-mirroring assertions are cited, a suite is red/skipped/unregistered, or mock/synthetic test evidence is used to claim real telephone/public-host readiness.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5",
        "session_turn:codex:01a0f7b1-b53e-71f2-b1d3-01818dcd94c3:11"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts",
          ".papercusp/apps/phone-app/worker/src/phone-voice-contract-adapter.integration.test.ts",
          ".papercusp/apps/portal/tests/four-surface.e2e.test.tsx"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-13",
      "barKey": "R-13",
      "model": "A public client receives only publicly reachable secure media endpoints.",
      "method": "Run authenticated remote-browser real-microphone calls on home broadband and cellular, then with UDP blocked; retain ICE-selected transport, WSS origin, peer audio receipt and lifecycle evidence.",
      "falsifier": "One-way/no audio, an insecure or loopback browser endpoint, failed certificate renewal, or dependence on LAN/hairpin connectivity.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-14",
      "barKey": "R-14",
      "model": "A carrier binding operation assigns a number only to its authorized tenant.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-15",
      "barKey": "R-15",
      "model": "A suspended number rejects further call routing.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-16",
      "barKey": "R-16",
      "model": "A released number loses its prior tenant binding.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-17",
      "barKey": "R-17",
      "model": "An inbound trunk routes according to the durable number record.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-18",
      "barKey": "R-18",
      "model": "An outbound trunk routes according to the durable number record.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-19",
      "barKey": "R-19",
      "model": "A dispatch rule selects the assistant identified by the durable number record.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-20",
      "barKey": "R-20",
      "model": "An outbound caller ID matches the verified identity in the durable number record.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-21",
      "barKey": "R-21",
      "model": "A portability operation follows the approved workflow recorded for the number.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-22",
      "barKey": "R-22",
      "model": "An incoming call rings the owner when tenant policy requires it.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-23",
      "barKey": "R-23",
      "model": "An incoming call follows the configured screening decision.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-24",
      "barKey": "R-24",
      "model": "An authorized browser pickup connects the owner to the incoming telephone call.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-25",
      "barKey": "R-25",
      "model": "An approved telephone handoff connects the incoming call to its configured destination.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-26",
      "barKey": "R-26",
      "model": "A busy incoming call follows the configured busy handling policy.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-27",
      "barKey": "R-27",
      "model": "An unanswered incoming call follows the configured no-answer handling policy.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-28",
      "barKey": "R-28",
      "model": "An incoming call routed to voicemail leaves a retrievable tenant-owned message.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-29",
      "barKey": "R-29",
      "model": "A call-history entry records the observed incoming-call outcome.",
      "method": "Call the approved service number from consenting test phones on two originating carrier networks; execute screening, takeover, forwarding, decline, voicemail, simultaneous calls and disconnect cases; reconcile SIP, room and ledger IDs.",
      "falsifier": "A real phone call never enters the call ledger, leaks across tenants, silently drops on handoff/failure, or gets a fabricated duration or successful status.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-30",
      "barKey": "R-30",
      "model": "An outbound ringing event produces the corresponding ringing state.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-31",
      "barKey": "R-31",
      "model": "An outbound answer event produces the corresponding connected state.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-32",
      "barKey": "R-32",
      "model": "An outbound busy event produces the corresponding busy outcome.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-33",
      "barKey": "R-33",
      "model": "An outbound rejection event produces the corresponding rejected outcome.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-34",
      "barKey": "R-34",
      "model": "An outbound no-answer event produces the corresponding no-answer outcome.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-35",
      "barKey": "R-35",
      "model": "A DTMF input reaches the connected telephone peer.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-36",
      "barKey": "R-36",
      "model": "An approved outbound transfer connects the intended destination.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-37",
      "barKey": "R-37",
      "model": "An outbound cancellation terminates the dialing attempt.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-38",
      "barKey": "R-38",
      "model": "A permitted scheduled call begins only at its authorized scheduled time.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-39",
      "barKey": "R-39",
      "model": "A replayed outbound request does not create a duplicate dialing attempt.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-40",
      "barKey": "R-40",
      "model": "An outbound call cannot incur spend outside its authorized budget.",
      "method": "Execute the outbound scenario matrix against consenting test phones and a test IVR; compare provider call records with the app ledger and approved spend envelope; include replayed intent, cancellation race and provider outage.",
      "falsifier": "A browser-only room is reported as a placed telephone call, an unauthorized/unsupported destination is dialed, the assistant places a call without applicable recipient consent, or retry/cancel/restart creates a duplicate call.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-41",
      "barKey": "R-41",
      "model": "Caller ID cannot confer owner authority or private agent-tool access.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-42",
      "barKey": "R-42",
      "model": "A recording or transcription action requires the consent specified by the approved policy.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-43",
      "barKey": "R-43",
      "model": "Stored call content expires according to the approved retention policy.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-44",
      "barKey": "R-44",
      "model": "An authorized export returns only the tenant's permitted call content.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-45",
      "barKey": "R-45",
      "model": "An authorized deletion removes the call content required by the approved deletion policy.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-46",
      "barKey": "R-46",
      "model": "A call-content notification follows the approved notification policy.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-47",
      "barKey": "R-47",
      "model": "Consent-sensitive audio storage remains disabled until explicitly enabled.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-48",
      "barKey": "R-48",
      "model": "A caller interruption follows the approved safe barge-in policy.",
      "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
      "falsifier": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-49",
      "barKey": "R-49",
      "model": "A PSTN call retains its authenticated worker identity throughout the conversation.",
      "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
      "falsifier": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-50",
      "barKey": "R-50",
      "model": "Measured PSTN response latency satisfies the approved latency target.",
      "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
      "falsifier": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-51",
      "barKey": "R-51",
      "model": "A provider failure, overload event or worker restart routes the call to an understandable fallback or voicemail.",
      "method": "Measure answer latency and end-of-speech-to-first-audio on PSTN calls; inject STT/LLM/TTS and worker failures on an isolated current build; use existing voice-contract tests and metrics rather than a parallel voice engine.",
      "falsifier": "The agent repeatedly talks over the caller, never responds, loses identity/context, grants caller privilege, or declares success using browser synthetic latency while the PSTN leg was not measured.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-52",
      "barKey": "R-52",
      "model": "An outbound call requires an allowed destination before dialing.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-53",
      "barKey": "R-53",
      "model": "An outbound call exceeding the approved rate limit is rejected before dialing.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-54",
      "barKey": "R-54",
      "model": "An outbound call exceeding the approved concurrency limit is rejected before dialing.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-55",
      "barKey": "R-55",
      "model": "A call cannot continue beyond its approved duration limit.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-56",
      "barKey": "R-56",
      "model": "A call cannot incur charges beyond its tenant's hard spend cap.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-57",
      "barKey": "R-57",
      "model": "Each phone-minute, AI, media or number charge is attributable to its authorized tenant.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-58",
      "barKey": "R-58",
      "model": "The retained usage ledger reconciles with the provider's charge records.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-59",
      "barKey": "R-59",
      "model": "A replayed provider charge event cannot produce duplicate billing.",
      "method": "Extend existing sidecar/data and platform entitlement tests; inject quota and tariff changes, duplicate provider records, concurrent cap races and suspension; compare retained carrier and AI usage for the controlled pilot.",
      "falsifier": "Unauthenticated/over-budget dialing succeeds, an upgrade bypasses limits, a provider retry charges twice, or the approved pilot cannot fit its spending envelope.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-60",
      "barKey": "R-60",
      "model": "A recovery drill meets the approved recovery objective.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-61",
      "barKey": "R-61",
      "model": "A clean build reproduces the pinned release artifact.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-62",
      "barKey": "R-62",
      "model": "Certificate renewal completes automatically before certificate expiry.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-63",
      "barKey": "R-63",
      "model": "A backup restores the required service data in an isolated recovery drill.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-64",
      "barKey": "R-64",
      "model": "Secret rotation preserves the approved credential access boundary.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-65",
      "barKey": "R-65",
      "model": "A health signal reflects the service's observed health state.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-66",
      "barKey": "R-66",
      "model": "A readiness signal reflects the service's observed ability to accept traffic.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-67",
      "barKey": "R-67",
      "model": "An injected service fault produces an actionable alert.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-68",
      "barKey": "R-68",
      "model": "An injected service failure reaches its configured bounded fallback outcome.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-69",
      "barKey": "R-69",
      "model": "A rollback drill restores the previous verified service artifact.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-70",
      "barKey": "R-70",
      "model": "The shipment record identifies the exact public app, sidecar, worker and media/SIP configuration.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-71",
      "barKey": "R-71",
      "model": "A real public-host PSTN smoke test passes on the exact shipment artifact.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-72",
      "barKey": "R-72",
      "model": "A bounded invited pilot meets its declared acceptance criteria.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-73",
      "barKey": "R-73",
      "model": "General signup remains closed until the required invited pilot passes.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-74",
      "barKey": "R-74",
      "model": "The full required test suite passes on the current implementing source.",
      "method": "Extend the existing sidecar/data contract, worker integration and portal e2e suites to cover each new phone behavior; add conventional framework tests when the current suites do not fit, updating this check to those real paths before binding proof. Run the exact resulting suite and current-source evidence; enumerate coverage per behavior/R-N and retain failures/skips. Inspect test bodies to ensure the named unit/integration/e2e files actually prove the new behavior; old baseline tests alone do not pass this BAR.",
      "falsifier": "A changed required behavior has no recurrence test at its required depth, only typechecks or implementation-mirroring assertions are cited, a suite is red/skipped/unregistered, or mock/synthetic test evidence is used to claim real telephone/public-host readiness.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5",
        "session_turn:codex:01a0f7b1-b53e-71f2-b1d3-01818dcd94c3:11"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts",
          ".papercusp/apps/phone-app/worker/src/phone-voice-contract-adapter.integration.test.ts",
          ".papercusp/apps/portal/tests/four-surface.e2e.test.tsx"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-75",
      "barKey": "R-75",
      "model": "A Phone call record is scoped to the tenant that owns the call.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-76",
      "barKey": "R-76",
      "model": "A Phone recording is scoped to the tenant that owns its call.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-77",
      "barKey": "R-77",
      "model": "A Phone transcript is scoped to the tenant that owns its call.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-78",
      "barKey": "R-78",
      "model": "A Phone provider callback is scoped to the tenant identified by its authenticated call binding.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-79",
      "barKey": "R-79",
      "model": "A Phone worker context is scoped to the tenant identified by its authenticated call binding.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-80",
      "barKey": "R-80",
      "model": "A Phone call grant is scoped to its authorized tenant.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-81",
      "barKey": "R-81",
      "model": "Speech content cannot confer owner authority or private agent-tool access.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-82",
      "barKey": "R-82",
      "model": "A room label cannot confer owner authority or private agent-tool access.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-83",
      "barKey": "R-83",
      "model": "A browser-supplied field cannot confer owner authority or private agent-tool access.",
      "method": "Extend and run the existing sidecar API and data contract suites with cross-tenant numbers/rooms, forged/replayed callback bodies, caller prompt injection, guest revocation and provider-origin validation; confirm server-resolved identity end to end.",
      "falsifier": "Any adversarial tenant/caller fixture reads another tenant's data, spoofs owner authority, bypasses a destination/cost policy, or starts an unowned SIP call worker with privileged tools.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-84",
      "barKey": "R-84",
      "model": "A persisted voicemail or transcript remains tenant scoped after service restart.",
      "method": "Extend data/sidecar contract tests for interrupted writes, replayed events, retention expiry, scoped export and deletion; inspect storage/logs for sensitive data and retain jurisdiction-specific policy review before live recording.",
      "falsifier": "A call is recorded outside its consent policy, transcripts/voicemails vanish after restart, deletion leaves retrievable retained media, or an external recipient sees private content.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "tests",
        "files": [
          ".papercusp/apps/phone-app/apps/sidecar/src/api.test.ts",
          ".papercusp/apps/phone-app/packages/data/src/store-contract.test.ts"
        ]
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-85",
      "barKey": "R-85",
      "model": "A carrier number lifecycle operation requires the approved carrier account.",
      "method": "Exercise provisioning/reconciliation failures in the real suite, then verify approved numbers and routing with the carrier; exercise porting with a provider-supported test or retained owner/provider evidence rather than porting an owner's primary number.",
      "falsifier": "A number routes to the wrong tenant, caller ID is unverified, a provider event creates a second number/charge, or cancellation/porting loses number ownership.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-86",
      "barKey": "R-86",
      "model": "Real external phone/provider acceptance remains separately mandatory for each live Phone BAR.",
      "method": "Run the scoped suite and authenticated public-phone journey; independently grade the retained evidence, compare shipped fingerprints, test rollback, then audit the seven-day consenting pilot and unresolved residue before open rollout.",
      "falsifier": "The plan is marked shipped from typechecks, local health, synthetic-only media, a stale release artifact, a different tenant or an unresolved mandatory launch/legal/cost gate.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    },
    {
      "key": "r-87",
      "barKey": "R-87",
      "model": "A secret rotation completes without interrupting ongoing service.",
      "method": "Run bounded load and a 24-hour soak on an isolated candidate runtime, restore a backup, rotate credentials, simulate dependency outages and exercise rollback/failover; retain exact artifact and call-loss evidence.",
      "falsifier": "A clean deploy cannot reproduce the service, a media/worker failure stays silent, numbers/call history cannot be restored, or recovery/rollback violates the approved service objectives.",
      "sourceRefs": [
        "session_turn:codex:01a0f780-14e0-7ba1-9e8d-fda266059afc:5"
      ],
      "check": {
        "kind": "instrument",
        "instrumentKey": "none"
      },
      "semanticReview": "not yet exhaustively recorded; structural presence alone is not a pass"
    }
  ],
  "nextRequired": [
    "Read retained WI-10004893 third-party critique and the failed audit; no unchanged 87-criterion consult.",
    "Execute and preserve exact downgrade and selected non-downgrade probes from the captured scope; provide complete criterion census and explicit coverage limits.",
    "For traces, map each criterion to a goal/Decision and invert every gradeable Decision consequence; Decisions alone do not prove complete BAR mapping.",
    "For non-overlap, record meaningful pairwise separation or downgrade for unverified pairs; lexical inequality does not prove semantic independence.",
    "For structured checks, name exact assertions/fixtures/branches and positive controls; passing paths/counts alone are inadequate.",
    "Supersede original author card with corrected evidence and request independent grading-integrity audit; do not hand-stamp, use pending-only repair, or claim vetting satisfied until audited pass."
  ],
  "limitations": [
    "No public PSTN/audio/media/recording/deletion-policy fulfillment claim.",
    "Captured source is a dirty working snapshot; the stored contents and sha256, not HEAD blobs, identify it.",
    "No repaired scorecard has been emitted from this artifact yet.",
    "The initial unexplained e2e restart failure remains self-owned EI-24845567110086010; later passes do not establish root cause."
  ]
}

