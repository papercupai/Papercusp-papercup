---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire97-construction-coverage-amendment-proposal-424d5.json"
updated_at: 1792139510086
_body: "content"
---

{
  "schemaVersion": "parked-construction-amendment-v1",
  "status": "proposed-not-applied",
  "workItem": "WI-6554700010008887",
  "sourceArtifact": "audits/parked-agent-resumption-2026-10-09/fire96-inverse23-failure-surfaces-and-exact14-adequacy-424d5-v2.json",
  "originalRevision": 7,
  "originalBarSetHash": "60f6e836d2e49f265a69481eaa16add244ed9031cd7bd0f63cd50e6f04594d69",
  "changedKeys": [
    "r-4",
    "r-5",
    "r-6",
    "r-7",
    "r-8",
    "r-9",
    "r-11",
    "r-12",
    "r-13",
    "r-14"
  ],
  "unresolved": [
    "R13 frozen original eligibility/continuity scope",
    "P013 frozen near-zero interpretation and binding baseline if absent",
    "current runtime proofs remain failed or unknown; no recall reruns"
  ],
  "args": {
    "rubricRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
    "criteria": [
      {
        "key": "r-1",
        "title": "Complete census",
        "intent": {
          "request": "Complete census",
          "sourceRefs": [
            "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:10",
            "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:15",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0"
          ]
        },
        "model": "Every start-population parked agent carries one evidence-based disposition, and unknown dispositions are labelled explicitly.",
        "bar": "Every start-population parked agent carries one evidence-based disposition, and unknown dispositions are labelled explicitly.",
        "barKey": "R-1",
        "barHash": "ab28108c84ec07a84271980d8af11bc910e31a9a5ffba0748590357ba59b13b2",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "coord:presence parked population of 2026-10-09"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Load the PG-canonical artifacts with artifacts:load {slug:papercusp}: audits/parked-agent-resumption-2026-10-09/census.json, dispositions.json and review-data.json. Freeze asOf=2026-10-10T01:09:46.552Z and the 273 ownerIds from census.records[].presence.ownerId. Independently require exact set equality, one disposition per owner, reviewed=true, nonempty reason/evidence, and explicit known/unknown labels for every reviewed work field. Run the maintained parked-agent-audit.e2e.test.ts live partition test against the same artifacts; bind its measured e2e run and counterexample controls. Current presence is context only and must never replace frozen membership.",
        "driftMarkers": "A start-population parked agent has no recorded disposition.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        }
      },
      {
        "key": "r-2",
        "title": "Conditional resumption",
        "intent": {
          "request": "Conditional resumption",
          "sourceRefs": [
            "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:15",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-002"
          ]
        },
        "model": "Every parked agent with reachable unfinished work and no justified stop receives a wake whose pickup outcome is recorded.",
        "bar": "Every parked agent with reachable unfinished work and no justified stop receives a wake whose pickup outcome is recorded.",
        "barKey": "R-2",
        "barHash": "7257ac94dc1b0e42a2a73ef1fbbb1418aea3efa74b863a211cd56750c8bdc25d",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "coord:wake deliveries from the census"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use the SAME original census asOf and dispositions.json to derive reachable unfinished-work candidates with no justified stop. Load audits/parked-agent-resumption-2026-10-09/wake-outcomes-2026-10-11-verified.json and join ownerId plus exact request/message and delivery ids; retain every request, failure and unconfirmed outcome. The frozen wake archive has 113 targets, 114 message parts and 113 actual wake receipts; require complete per-owner coverage, never substitute the R-1 binding37787/test21111403 for wake receipts. Confirm pickup only from host-attested/observed turn proof or real agent-origin activity after the request inside the declared 600s window; queued/delivered alone is unconfirmed. Apply D-002 legitimate owner/budget/dependency/wall holds as explicitly recorded justified-stop dispositions, never as successful pickup. Missing receipt joins, unclassified outcomes or unexplained omissions fail. Validate non-waking chunks against the original wakes/ce4-capacity.json send.chunked manifest (msgIds/askMsgId): only its final askMsgId carries the wake receipt. Retain the earlier non-waking part as message content, with no fabricated delivery or pickup. Exact delivery joins are required for actual wake receipts; non-wake content parts are separately accounted for.",
        "driftMarkers": "A parked agent with reachable work and no justified stop has no recorded wake outcome.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        }
      },
      {
        "key": "r-3",
        "title": "Durable diagnosis report",
        "intent": {
          "request": "Durable diagnosis report",
          "sourceRefs": [
            "session_turn:codex:01a12344-bee8-73d1-9ff7-8a27ed86b011:15",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0"
          ]
        },
        "model": "The owner audit report naming the measured parking causes is published and reads back complete.",
        "bar": "The owner audit report naming the measured parking causes is published and reads back complete.",
        "barKey": "R-3",
        "barHash": "1688fc6807faf9119877dae44b2ab8de8bc30e1e1175f2d1349d02e1cf2cbb06",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "reports:publish owner audit report"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Run the committed packages/operator-core/lib/agent-tools/coordination/parked-agent-report.e2e.test.ts with its explicit live profile, authenticated session principal, report rpt_18581993-b959-48ca-88dc-28e1f0176296 and SHA256 3762b8eec60dee0575349369560a45eeecb3123cc873edc30915c32f8149e38e. reports:get must return the exact complete owner Markdown and all 273 frozen census rows, owner visibility and /reports?sel=rpt_18581993-b959-48ca-88dc-28e1f0176296. Its nine fixture controls must pass and an isolated digest-check removal must be caught by the truncated-report control. Publish receipt alone does not pass. Preserve the original outcome and actual post-fix 24-hour bar.",
        "driftMarkers": "reports:get on the published report returns missing or truncated content.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/agent-tools/coordination/parked-agent-report.e2e.test.ts"
          ]
        }
      },
      {
        "key": "r-4",
        "title": "Codex stale-auth recovery",
        "intent": {
          "request": "Codex stale-auth recovery",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "model": "An auth-blocked headless codex session receives a bounded identity-preserving auth recovery instead of a wake injection.",
        "bar": "An auth-blocked headless codex session receives a bounded identity-preserving auth recovery instead of a wake injection.",
        "barKey": "R-4",
        "barHash": "991efb4cedd9e5ccc5a45ce7fdfcf724cebcbc2b8399c8bf91c59d34baf4d7f4",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs",
          "packages/operator-core/lib/events/await/wake-executor.ts"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Require eligible auth-blocked recovery, post-recovery turn/pickup or an explicit bounded recovery-exhaustion outcome, preservation of owner/native identity/model/account/carry, and controls for ineligible hosts. A no-op recovery callback is a failing counterexample.\n\nConstruction coverage supplement (plan decisions; no observed PASS): P-004 root-cause leg: inspect Codex's maintained auth reload implementation or official current documentation and cite exact source/version showing whether a rotated on-disk refresh token is reloaded by an already-running child. Connect the measured rotation failure to the durable hazard-removal change. Bounded respawn is a mitigation until that causal leg is resolved or an explicitly assigned durable follow-up exists; do not infer reload support from successful restart. Preserve same owner/model/account/carry and ineligible-host controls.",
        "driftMarkers": "An eligible auth-blocked headless Codex host receives wake injection instead of bounded auth recovery; recovery does nothing or never yields either real pickup or a measured bounded exhaustion outcome; the recovery changes owner identity/model/account/carry; or recovery exceeds its configured window budget.",
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host.test.ts",
            "packages/operator-core/lib/events/await/wake-executor.test.ts"
          ]
        }
      },
      {
        "key": "r-5",
        "title": "Failed respawn binding recovers",
        "intent": {
          "request": "Failed respawn binding recovers",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "model": "A carry-respawn whose successor native id is missing is rebound or relaunched within a bounded window.",
        "bar": "A carry-respawn whose successor native id is missing is rebound or relaunched within a bounded window.",
        "barKey": "R-5",
        "barHash": "f354011ed5e0d4274ca443b844cecb5bcad7765ba6057675090e48be6a377f69",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "apps/operator/scripts/psu-pty-host.mjs"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Exercise successor-native-id-missing, successful rebinding, refusal after the configured bound, current-generation identity checks and duplicate pending-delivery ordering. Record configured window and actual event timestamps; an unresolved successor after that window fails.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-003/D-007 controls: the identity oracle is the writer lock held by the exact native child PID, never the newest rollout. Anchor the missing-native-ID window to the child's spawn (default 120000ms), not to each polling attempt; default at most 2 identity-preserving relaunches, with configured values recorded. Owner-typed input suppresses relaunch. Exercise lazy rollout creation, predecessor-newest rollout, stale host generations, native-id-missing versus reanchor-unconfirmed/superseded reasons, later successful turn, recovery success and exhausted admission refusal before duplicate-pending ACK. Existing terminal R5 proof stays historical; no replay solely for recall.",
        "driftMarkers": "A session with respawn-binding-unconfirmed stays unbound past the bounded window.",
        "check": {
          "kind": "tests",
          "files": [
            "apps/operator/lib/psu-pty-host.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-6",
        "title": "Channel delivery and confirmed pickup are distinct",
        "intent": {
          "request": "Delivered means a turn started",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-004",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-005"
          ]
        },
        "model": "A wake pickup is confirmed only by real-time host-attested or observed turn proof.",
        "bar": "A wake pickup is confirmed only by real-time host-attested or observed turn proof.",
        "barKey": "R-6",
        "barHash": "e0f1fafba3b913a0834e9726204e42ae8fe6ac126a2b6c99720e553cb944d221",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/agent-tools/coordination/tools/wake.ts",
          "packages/operator-core/lib/events/await/pickup-sweep.ts",
          "packages/operator-core/lib/events/await/turn-proof.ts",
          "packages/operator-core/lib/events/await/wake-executor.ts"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Run every named test through testing:run. Controls must distinguish queued/channel-delivered/awaiting from host-attested/observed pickup; keep enqueue pickupConfirmed false, expose failure key/window, and inspect later delivery proof. At a 600s default expiry with no native/tool signal require not-picked-up and at most one eligible recovery requeue. Transcript ingestion and duplicate pending ACKs are not proof. Bind current ledger-backed source/test fingerprints on both early and later seams.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-007 shared tail-judge controls: both pickup and stalled-loop callers must use one current-host-process judge. A pre-host event, carry-dropped, superseded/reanchor-only event or later turn is not a native-ID wedge. pending-turn-stuck needs at least two pending duplicate events, oldest older than the configured pickup window (600s default), no later turn and no current running progress within that window. A needs-relaunch verdict is reported without recovery requeue into the same stuck pipeline. Test the below-count, below-age, later-turn and active-progress negatives.",
        "driftMarkers": "Enqueue reports pickupConfirmed:true; a channel-delivered row is treated as native pickup without host/tool proof; the failure handle or later proof read is missing; expiry without proof remains confirmed/awaiting; or duplicate pending ACK/transcript ingestion is counted as real-time turn proof.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/events/await/wake-executor.test.ts",
            "packages/operator-core/lib/events/await/turn-proof.test.ts",
            "packages/operator-core/lib/events/await/pickup-sweep.test.ts",
            "packages/operator-core/lib/agent-tools/coordination/tools/wake.test.ts"
          ]
        }
      },
      {
        "key": "r-7",
        "title": "Stalled-loop guard repairs",
        "intent": {
          "request": "Stalled-loop guard repairs",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-007",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "model": "A turns-stalled unhealthy host routes to actionable identity-preserving recovery without dropping its continuation obligation; silent-halt uses the governing shared host, wake and blocker predicates and pages unhealthy hosts with deduped leader notification.",
        "bar": "A turns-stalled unhealthy host routes to actionable identity-preserving recovery without dropping its continuation obligation; silent-halt uses the governing shared host, wake and blocker predicates and pages unhealthy hosts with deduped leader notification.",
        "barKey": "R-7",
        "barHash": "6c5a04e2df5aa15093e49d2acc7e41bc96d9ee36249ef3db3f7ce4e7e87ceac8",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/harness/routines/stalled-loops-guard.ts",
          "packages/operator-core/lib/harness/routines/silent-halt-reconcile.ts",
          "packages/operator-core/lib/events/await/turn-proof.ts",
          "packages/operator-core/lib/events/await/wake-source-predicate.ts",
          "apps/operator/scripts/psu-pty-host.mjs"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Cover auth-blocked, quota-blocked, unbound-successor, pending-turn-stuck and exhausted/ineligible recovery. A wake is not the remedy for D-007 needs-relaunch classes: require actual identity-preserving recovery or a durable owned recovery disposition that retains the continuation obligation. Original owner-dialog turn20 approved repair instead of disarm. Historical revision-4 finding: stalled-loops-guard.test.ts:2474 then expected unbound disarm with a textual remedy, tracked as EI-25714601102285131. Read current source and original repair proof before assessing present behavior; this historical annotation is neither a current FAIL nor PASS. Do not rewrite the model/bar to bless that test.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-006/D-007/D-013/D-014/D-023 additional surfaces: evaluate silent-halt with its own-inbox watcher excluded and a genuine non-inbox await retained. Healthy/recoverable/no-host/read-failure paths retain the specified wake fallback; needs-relaunch paths page with an actionable owned recovery, not a futile wake. A fleet leader receives exactly one new-page alert per disarm epoch; page caps count newly created pages so deduped old pages cannot starve new halts. Do not arm an at-disarm await that re-exempts the halt. Use the shared host-tail judge and the caller-specific any-live predicate. Quota latch controls parse and publish quotaResetAtMs, expire at the stated reset, permit a bounded backed-off same-route early-top-up probe and re-latch with the new reset if still walled. D-014 withdraws D-013's blanket same-account prohibition. For stranded-work counting reuse the active typed-blocker parser: exclude blocked/needs-human blocker-only holds, keep wip/plain-blocked/cleared/link-only holds and any mixed actionable hold, and publish the exact excluded IDs. Assert these branches in maintained tests; a source inspection is not runtime acceptance.",
        "driftMarkers": "A turns-stalled unhealthy host is disarmed rather than routed to actionable recovery; any auth/quota/unbound-successor/pending-turn-stuck/exhausted-recovery branch only prints relaunch advice and drops its continuation obligation; or a recovery changes the owner/model/account/carry or runs beyond its configured bound. Any additional required outcome in the model or construction-coverage supplement is absent, fails or is incorrectly reported as verified.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/stalled-loops-guard.test.ts",
            "packages/operator-core/lib/harness/routines/silent-halt-reconcile.test.ts",
            "packages/operator-core/lib/events/await/turn-proof.test.ts",
            "packages/operator-core/lib/events/await/wake-source-predicate.test.ts",
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ]
        }
      },
      {
        "key": "r-8",
        "title": "Instructions stop teaching premature stops",
        "intent": {
          "request": "Instructions stop teaching premature stops",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "model": "Rendered guidance on loop wake, loop:end, agent launch and scheduler fleet-scope-admission does not teach an externally blocked agent to end its loop; the maintained su LLM check covers the same instruction.",
        "bar": "Rendered guidance on loop wake, loop:end, agent launch and scheduler fleet-scope-admission does not teach an externally blocked agent to end its loop; the maintained su LLM check covers the same instruction.",
        "barKey": "R-8",
        "barHash": "fbfc6bf3a27c9f1b0475b5b1c94a27ba0af978fa41a34e93d1b43213d9259916",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/agent-launch-core.ts",
          "packages/operator-core/lib/agent-tools/loop/end.ts",
          "packages/operator-core/lib/harness/routines/loop.ts",
          "packages/operator-core/lib/scheduler/fleet-scope-admission.ts"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Exercise externally blocked AUTO claim-holding and legitimate finished/owner-paused controls on EACH named producer surface, with assertions on the rendered guidance. This claim is scoped to those enumerated producers, not a repository-wide absence assertion.\n\nConstruction coverage supplement (plan decisions; no observed PASS): P-008 fourth producer is packages/operator-core/lib/scheduler/fleet-scope-admission.ts, with maintained fleet-scope-admission guidance controls. Assert rendered externally-blocked and finished/owner-paused text independently for all four producers. Preserve independent-work-first, a typed blocker and one bounded exact unblocking await with on_timeout:wake once all remaining work depends on it; no bare acknowledge flag may grant a wake-less stop. Resolve the original maintained su llm-test receipt and exact rendered version; missing LLM evidence remains a gap rather than being inferred from unit tests. Follow the persona render/edit runbook if actual prompt source is changed.",
        "driftMarkers": "A rendered loop wake prompt tells a blocked agent to end its loop. Any additional required outcome in the model or construction-coverage supplement is absent, fails or is incorrectly reported as verified.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/harness/routines/loop.test.ts",
            "packages/operator-core/lib/agent-tools/loop/end.test.ts",
            "packages/operator-core/lib/agent-launch-core.test.ts",
            "packages/operator-core/lib/scheduler/fleet-scope-admission.test.ts"
          ]
        }
      },
      {
        "key": "r-9",
        "title": "Wake-less guard is real",
        "intent": {
          "request": "Wake-less guard is real",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "model": "loop:end refuses an AUTO claim-holding session that has no non-inbox wake source.",
        "bar": "loop:end refuses an AUTO claim-holding session that has no non-inbox wake source.",
        "barKey": "R-9",
        "barHash": "5c45260f216ecf9a454dea8849e68eeecc8dd855fe936f6704412c488deeee37",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/agent-tools/loop/end.ts",
          "packages/operator-core/lib/events/await/wake-source-predicate.ts"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Cover AUTO with held claims and no non-inbox wake source, both acknowledgement knobs and explicit finished/owner pause controls; inbox-wake alone must not discharge the continuation obligation.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-008/D-009: use the one shared wake-source parser and explicitly test own inbox, done-on-self-held work, missing/terminal target, untimed live work-item-claimable/conversation/system await, timed await and a timed-out wake. silent-halt counts any live non-inbox source; a claim-holding AUTO loop:end requires a guaranteed timed wake. Its bounded recovery template comes from the actual held item's typed dependency/event, never an invented work-item:unblocked key from state alone, and must not select a self-held done/claim-release target. Exercise both acknowledgement knobs and explicit stop/finished/released controls.",
        "driftMarkers": "loop:end with acknowledgeWakeLessAutonomy ends an AUTO claim-holding session with no wake source.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/agent-tools/loop/end.test.ts",
            "packages/operator-core/lib/events/await/wake-source-predicate.test.ts"
          ]
        }
      },
      {
        "key": "r-10",
        "title": "Blocked claims leave the claim cap",
        "intent": {
          "request": "Blocked claims leave the claim cap",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-010"
          ]
        },
        "model": "A held claim counts against the scheduler concurrency cap unless its state is blocked or needs-human and it carries an active typed external blocker.",
        "bar": "A held claim counts against the scheduler concurrency cap unless its state is blocked or needs-human and it carries an active typed external blocker.",
        "barKey": "R-10",
        "barHash": "f83a2de796488bd2870bebcd82142a2e7b4f6b29ae9d30a04475fbf72894f566",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/external-blockers.ts",
          "packages/operator-core/lib/scheduler/claim-spec-store.ts"
        ],
        "evidencePlane": "tree",
        "requiredTestLayers": [
          "integration"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run on claim-spec-store.integration.test.ts against its isolated real-PG test harness. Exercise both single and batched concurrency oracles. Positive controls: blocked and needs-human held rows WITH an active typed external blocker release the slot while remaining held. Negative controls: wip plus active blocker, plain blocked/no typed blocker, cleared typed blocker and work-item-link-only blocker consume the slot. Assert heldIds, blockerParkedIds, activeClaims and exact cap verdict. A typecheck is not proof.",
        "driftMarkers": "A blocked/needs-human held claim with an active typed external blocker consumes the cap; a wip claim, plain blocked park, cleared blocker or link-only blocker is incorrectly excluded; or single and batch oracle verdicts disagree.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
          ]
        }
      },
      {
        "key": "r-11",
        "title": "Honest liveness for wedged sessions",
        "intent": {
          "request": "Honest liveness for wedged sessions",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-015",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-016"
          ]
        },
        "model": "The presence oracle reports a session that cannot take a turn as wedged instead of parked.",
        "bar": "The presence oracle reports a session that cannot take a turn as wedged instead of parked.",
        "barKey": "R-11",
        "barHash": "88562dcb16fa2a2a9976dfa61a189d7e4f0a421efa8ef4601b2d06fb9fabff96",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/agent-tools/coordination/liveness-oracle.ts",
          "packages/operator-core/lib/agent-tools/coordination/presence-snapshot.ts",
          "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
          "packages/operator-core/lib/fleet/fleet-roster.ts"
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
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Use testing:run for every file in this criterion check.files on the current source build; require passing ledger-backed runs with source/test fingerprints and the declared layer. Inspect the positive and negative action controls against the criterion outcome; a green test that asserts behavior forbidden by the outcome does not establish acceptance. Exercise all four named liveness surfaces with current host-generation auth/quota/unbound/pending-turn-stuck positives and healthy/later-turn controls. Use the one judgeHostCondition/applyHostConditionLeg judge per D-015/D-016; assert both classification and counts, not only one oracle helper.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-011/D-016 eligibility controls on every named surface: parked/draining/recorded hosts are inspected; live/ended are not relabeled by stale wedge evidence. Distinguish wedged absent because unchecked from a measured healthy host. Exercise current-process reason ordering, prior-generation/superseded/reanchor/later-turn negatives, pending count/age and active-progress exemptions. Assert suspect+wedged versus parked plus the census counts, retaining one shared host-condition judge.",
        "driftMarkers": "coord:presence reports a dead-auth session as sessionState parked.",
        "check": {
          "kind": "tests",
          "files": [
            "packages/operator-core/lib/agent-tools/coordination/liveness-oracle-host-condition.test.ts",
            "packages/operator-core/lib/agent-tools/coordination/presence-snapshot-targeted.test.ts",
            "packages/operator-core/lib/agent-tools/coordination/host-condition-coverage.test.ts",
            "packages/operator-core/lib/agent-tools/fleet/assignments.test.ts",
            "packages/operator-core/lib/fleet/fleet-roster.test.ts"
          ]
        }
      },
      {
        "key": "r-12",
        "title": "Wedged-session alarm",
        "intent": {
          "request": "Wedged-session alarm",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:0",
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-012",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-017"
          ]
        },
        "model": "Standing alarms fire when wedged-session count reaches 10 or stranded-session count reaches 5, retain unknown census legs, and report one coordinated count warning without a duplicate generic critical alarm.",
        "bar": "Standing alarms fire when wedged-session count reaches 10 or stranded-session count reaches 5, retain unknown census legs, and report one coordinated count warning without a duplicate generic critical alarm.",
        "barKey": "R-12",
        "barHash": "0258a4863333f11e33965334f86e32fc598ca9535692f4da29b85917a9b0426a",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "packages/operator-core/lib/system-health/liveness-alarm.ts"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Alarm ledger readback with dev:pg_query: harness_shared.coord_event_log rows with surface 'escalations', body from 'system:infra-liveness-alarm' and 'Signal: agents-wedged', raised while the census wedged count was at or above the threshold of 10. A wedged count at or above 10 on coord:presence (sessionState suspect with a wedged class) with no such escalation inside the alarm's dedupe window falsifies the bar. Bind the actual request-path standing alarm on the chosen acceptance runtime to the exact loaded source fingerprints. Keep tree alarm/census tests separate from this live escalation-ledger proof. A missing loaded blob or missing threshold/dedupe control remains unverified.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-012 standing-signal coverage includes agents-wedged at >=10 and agents-stranded at >=5. On an isolated current-build acceptance runtime, capture threshold-1/threshold, dedupe and recovery for both signals; missing or unreadable census legs are unknown and must not emit recovery. Verify the coordination panel WARN/count presentation and that the generic critical catch-all does not duplicate these standing alarms. Preserve the real request-path escalation ledger, exact serving source, fixture membership and cleanup receipts; maintained tree tests alone do not discharge this e2e/live obligation. Do not retry the original failed R12 runtime proof until the independently owned retention/admission prerequisite has clean runtime evidence.",
        "driftMarkers": "The wedged-session count exceeds the threshold with no alarm raised. Any additional required outcome in the model or construction-coverage supplement is absent, fails or is incorrectly reported as verified.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "agents-wedged"
        }
      },
      {
        "key": "r-13",
        "title": "Current population remediated",
        "intent": {
          "request": "Current population remediated",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-002",
            "parked-agent-census-resumption-and-root-cause-2026-10-09#D-014"
          ]
        },
        "model": "Every wedged session in the 2026-10-10 census is respawned with its model, account and carry preserved.",
        "bar": "Every wedged session in the 2026-10-10 census is respawned with its model, account and carry preserved.",
        "barKey": "R-13",
        "barHash": "b23355a84a62bcbb8898472b692268decf1af8796265fd9d46516232c4fb7c94",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "2026-10-10 census wedged population"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Read WI-10008163 stored terminal completion/evidence and follow its frozen remediation population and launch receipt references. Explicitly enumerate original eligible ownerIds and justified owner/budget/dependency exclusions BEFORE outcome joins; never shrink membership after seeing failures. Compare each original owner/model/account/carry profile with the same-identity relaunch receipt and later real agent-origin activity. D-014 authorizes relaunch on the SAME recovered account route; it does not authorize account switching. Missing profiles, receipt joins, verified pickup or unexplained omissions fail. This one-time identity-preserving remediation proof is separate from R-14 delayed health census.\n\nConstruction coverage supplement (plan decisions; no observed PASS): D-013/D-014 control mapping: same-account remediation is permitted after the provider route recovered. A future reset timestamp is not proof the route remains walled; source-controlled latch expiry and bounded backed-off early-top-up/re-latch controls belong to R-7. Preserve the original frozen-population scope question and STOP on missing owner eligibility/continuity evidence; do not resume historical source searches or manufacture a population from outcomes.",
        "driftMarkers": "A frozen remediation-eligible wedged session has no verified same-identity respawn/pickup; its model/account/carry changes; legitimate owner/budget/dependency waits are resumed; or eligibility exclusions are added after outcome measurement.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        }
      },
      {
        "key": "r-14",
        "title": "Re-measured outcome",
        "intent": {
          "request": "Re-measured outcome",
          "sourceRefs": [
            "session_turn:claude:91df4c82-c30f-41ec-b88a-bf7f87511858:20"
          ]
        },
        "model": "At least 24 hours after every scoped durable fix is actually contained in the measured runtime, the rerun census measures zero cannot-think, binding-stranded no greater than the frozen live baseline, and AUTO+claims+no-wake near zero under an interpretation frozen before outcome measurement.",
        "bar": "At least 24 hours after every scoped durable fix is actually contained in the measured runtime, the rerun census measures zero cannot-think, binding-stranded no greater than the frozen live baseline, and AUTO+claims+no-wake near zero under an interpretation frozen before outcome measurement.",
        "barKey": "R-14",
        "barHash": "24424a228575f39ed34758fd682e13b9a29cbcf8f016c5b53c74566ad4fb0e77",
        "role": "outcome",
        "mandatory": true,
        "requiredScope": [
          "parked-agent census rerun"
        ],
        "evidencePlane": "live",
        "requiredTestLayers": [
          "e2e"
        ],
        "passRatings": [
          "healthy"
        ],
        "barProvenance": {
          "lifecycle": "pre-implementation",
          "declaredAt": "2026-10-10T16:59:52.854Z",
          "declaredBy": "su-92de4154-4d25-4c00-b14f-2fee51639247"
        },
        "method": "Read WI-10008164 to resolve the frozen baseline and the measured final-fix anchor: exact source SHA, runtime/build identity and time when ALL scoped durable fixes including P-011 and any confirmed R-7 repair are actually contained. If the anchor is absent or any fix is unverified, return not-yet-eligible. At measuredAt >= anchor+24h, rerun the maintained census/liveness/silent-halt queries and archive exact population, scope, time, configured predicates and complete per-owner verdicts; require zero cannot-think sessions. Unknown/missing measurements do not count as zero. Bind the maintained e2e layer proof and compare the timestamp numerically. The 24h delay cannot be waived or replaced by immediate tests.\n\nConstruction coverage supplement (plan decisions; no observed PASS): P-013/D-023: at the same eligible >=24h measurement, also compare binding-stranded against the exact frozen live baseline and report AUTO+claims+no-wake against the plan's pre-outcome interpretation of near 0. If that baseline or interpretation was never frozen, mark that outcome unknown and obtain the outstanding owner decision; do not silently choose a threshold or call unknown zero. The silent-halt population must enumerate blocker-only exclusions, mixed actionable holds and excluded IDs using the shared typed-blocker parser. Include complete per-owner partitions for each metric and the predeclared scope; no final report or closure until every required outcome is measured and passes.",
        "driftMarkers": "The rerun census counts at least one cannot-think session. Any additional required outcome in the model or construction-coverage supplement is absent, fails or is incorrectly reported as verified.",
        "check": {
          "kind": "instrument",
          "instrumentKey": "parked-agent-census"
        }
      }
    ],
    "reason": "Fire96 explicit construction repair for governing D003/006/007/008/009/011/012/013/014/023 and P004/P008/P013. Tighten omitted coverage without weakening recovery, identity, frozen-population or actual24h obligations. Rubric7 and failed cards stay immutable. No runtime pass is asserted; R13 scope and P013 near-zero interpretation remain owner-gated.",
    "expectedRubricRevision": 7,
    "expectedSubjectPlanRevision": 65,
    "idempotencyKey": "parked-fire97-construction-coverage-424d5-v1"
  }
}
